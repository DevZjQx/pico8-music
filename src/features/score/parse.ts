import { isChordName, parseChordName } from './chords.ts';
import {
  EFFECT_NAMES,
  drumMidiOf,
  formatNoteName,
  parseDrumName,
  parseEffect,
  parseNoteName,
  parseWaveform,
} from './notes.ts';
import { DEFAULT_TUNING, TEMPERAMENT_NAMES, frequencyOf } from './tuning.ts';
import type {
  Articulation,
  DelayFollow,
  DrumEffect,
  DrumName,
  DrumParams,
  Effect,
  EffectParams,
  Envelope,
  FmOperator,
  GroupCompressor,
  GroupSaturation,
  Humanize,
  Instrument,
  InstrumentFilter,
  InstrumentType,
  NoteEvent,
  Partial,
  SampleSpec,
  SampleZone,
  Score,
  ScoreGroup,
  ScoreKey,
  ScoreMode,
  ScoreSection,
  SendReverb,
  ScoreTrack,
  SectionFilter,
  SectionTrackState,
  SoundPreset,
  TemperamentName,
  TrackDelay,
  TrackFilter,
  TrackPattern,
  TrackHumanize,
  TrackShelf,
  Tuning,
  VelocityMapping,
  Waveform,
} from './types.ts';

export class ScoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreError';
  }
}

const DEFAULTS = {
  bpm: 90,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  bars: 4,
  volume: 5,
  waveform: 4 as Waveform,
} as const;

/** Declick edges; the same shape the synth used before envelopes were authorable. */
export const DEFAULT_ENVELOPE: Envelope = {
  attack: 0.004,
  decay: 0,
  sustain: 1,
  release: 0.008,
};

const MAX_STEPS_PER_NOTE = 2048;
const MAX_GATE_STEPS = 4096;
/**
 * Explicit voicings can fill a two-hand pad chord. Named chord qualities stay
 * capped at four notes in chords.ts so their expansions, including the slash
 * bass voicing rules, keep rendering exactly as they did before.
 */
const MAX_CHORD_NOTES = 8;
/**
 * The state-variable filter divides by Q, so Q=0 has no finite damping
 * coefficient. 0.05 is heavily over-damped but still a real filter; 0.3, the
 * value that used to be rejected, is now accepted.
 */
const MIN_RESONANCE = 0.05;
/**
 * A render-budget cap, not a musical rule: every track gets its own full-length
 * buffer and one mix pass, so the LLM can decide the arrangement size but a
 * pathological score cannot exhaust memory.
 */
const MAX_TRACKS = 32;
const MAX_GROUPS = 32;
const MAX_INSTRUMENTS = 32;
const MAX_PRESETS = 32;
const MAX_ARTICULATIONS = 64;
const MAX_PARTIALS = 16;
const MAX_PARTIAL_DECAY = 8;
/** Carrier plus three modulators is the whole multi-operator palette. */
const MAX_FM_OPERATORS = 3;
/** A zone set can layer key ranges and velocity layers without becoming a library. */
const MAX_ZONES = 16;
/** Matches the app layer's 30 s sample budget; offsets past it cannot point at audio. */
const MAX_SAMPLE_OFFSET_SECONDS = 30;
const INSTRUMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_INSTRUMENT_NAMES = new Set(['chip', 'fm', 'additive', 'drums']);
/** Song sections are cheap individually but each one can be 64 bars long. */
const MAX_SECTIONS = 256;
/** Hard ceiling for the complete arrangement, before any loop repeats. */
const MAX_SONG_SECONDS = 15 * 60;
/** Sample banks are deliberately small: an LLM should reuse a handful of assets. */
const MAX_SAMPLES = 16;
const SAMPLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A per-key tuning map only needs the keys the piece actually plays. */
const MAX_TUNING_NOTES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * p8_music arguments, not score fields. Models tend to nest these beside bpm
 * and tracks, so the top-level error names the argument boundary explicitly.
 */
const TOOL_ARGUMENT_NAMES = new Set([
  'post',
  'preset',
  'style',
  'speed',
  'wet',
  'toneHz',
  'minutes',
  'out',
]);

/**
 * A plain field-by-field parser silently drops anything it does not read, so a
 * typo or a nested `"mix": {"pan": -1}` used to render as a centred, dry track.
 * Reject unknown keys instead: the caller gets a fixable error rather than an
 * unchanged mix that looks like an engine bug.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !known.has(key))
    .sort();
  if (unknown.length === 0) return;
  const fields = unknown.map((key) => JSON.stringify(key)).join(', ');
  const hints: string[] = [];
  const toolArguments = path === '' ? unknown.filter((key) => TOOL_ARGUMENT_NAMES.has(key)) : [];
  if (toolArguments.length > 0) {
    const names = toolArguments.map((key) => JSON.stringify(key)).join(', ');
    const plural = toolArguments.length > 1;
    hints.push(
      `${names} ${plural ? 'are' : 'is a'} p8_music tool parameter${plural ? 's' : ''}, ` +
        `not ${plural ? 'top-level score fields' : 'a top-level score field'}; ` +
        `pass ${plural ? 'them' : 'it'} alongside "score", outside the score JSON`,
    );
  }
  if (unknown.includes('mix')) {
    hints.push('mix-stage fields are flat: pan, send, duck, filter, delay (never nested under "mix")');
  }
  const hint = hints.length > 0 ? `; ${hints.join('; ')}` : '';
  const subject = path === '' ? 'score' : path;
  throw new ScoreError(
    `${subject}: unknown field${unknown.length > 1 ? 's' : ''} ${fields}${hint}`,
  );
}

function readNumber(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScoreError(`${path} must be a number, got ${JSON.stringify(value)}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ScoreError(`${path} must be an integer, got ${value}`);
  }
  if (value < min || value > max) {
    throw new ScoreError(`${path} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function readRequiredNumber(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (value === undefined) throw new ScoreError(`${path} is required`);
  return readNumber(value, path, min, min, max, integer);
}

function readString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScoreError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function readBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new ScoreError(`${path} must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Track volume matches the `@volume` grammar: 0-7 with at most one decimal. */
function readVolume(value: unknown, path: string, fallback: number): number {
  const volume = readNumber(value, path, fallback, 0, 7);
  if (Math.abs(volume * 10 - Math.round(volume * 10)) > 1e-9) {
    throw new ScoreError(`${path} must have at most one decimal place, got ${volume}`);
  }
  return volume;
}

function parseEnvelope(value: unknown, path: string): Envelope {
  if (value === undefined) return DEFAULT_ENVELOPE;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with attack, decay, sustain, and release`);
  }
  rejectUnknownKeys(value, ['attack', 'decay', 'sustain', 'release'], path);
  return {
    attack: readNumber(value.attack, `${path}.attack`, DEFAULT_ENVELOPE.attack, 0, 30),
    decay: readNumber(value.decay, `${path}.decay`, DEFAULT_ENVELOPE.decay, 0, 30),
    sustain: readNumber(value.sustain, `${path}.sustain`, DEFAULT_ENVELOPE.sustain, 0, 1),
    release: readNumber(value.release, `${path}.release`, DEFAULT_ENVELOPE.release, 0, 30),
  };
}

function parseInstrumentFilter(value: unknown, path: string): InstrumentFilter | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return {
      cutoffHz: readRequiredNumber(value, path, 80, 18000),
      resonance: 0.707,
      envAmount: 0,
      attack: 0.002,
      decay: 0.15,
      sustain: 0.3,
      release: 0.15,
    };
  }
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be a cutoff number or an object with cutoffHz, resonance, envAmount, attack, decay, sustain, release`);
  }
  rejectUnknownKeys(
    value,
    ['cutoffHz', 'cutoff', 'resonance', 'q', 'envAmount', 'attack', 'decay', 'sustain', 'release'],
    path,
  );
  return {
    cutoffHz: readRequiredNumber(value.cutoffHz ?? value.cutoff, `${path}.cutoffHz`, 80, 18000),
    resonance: readNumber(value.resonance ?? value.q, `${path}.resonance`, 0.707, MIN_RESONANCE, 20),
    envAmount: readNumber(value.envAmount, `${path}.envAmount`, 0, 0, 6),
    attack: readNumber(value.attack, `${path}.attack`, 0.002, 0, 2),
    decay: readNumber(value.decay, `${path}.decay`, 0.15, 0, 4),
    sustain: readNumber(value.sustain, `${path}.sustain`, 0.3, 0, 1),
    release: readNumber(value.release, `${path}.release`, 0.15, 0, 4),
  };
}

/**
 * Velocity offsets are opt-in so old instrument definitions keep their fixed
 * response. `cutoffOctaves` is expressed as a full-velocity opening, so a
 * quiet note sits at the authored cutoff and a loud one opens above it.
 * `indexScale` only means something on an FM voice, so other types reject it
 * instead of accepting a field the renderer would silently ignore.
 */
function parseVelocityMapping(
  value: unknown,
  path: string,
  type: InstrumentType,
): VelocityMapping | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with cutoffOctaves, drive, and indexScale`);
  }
  rejectUnknownKeys(value, ['cutoffOctaves', 'drive', 'indexScale'], path);
  const indexScale = readNumber(value.indexScale, `${path}.indexScale`, 0, 0, 1);
  if (indexScale > 0 && type !== 'fm') {
    throw new ScoreError(`${path}.indexScale only applies to fm instruments`);
  }
  return {
    cutoffOctaves: readNumber(value.cutoffOctaves, `${path}.cutoffOctaves`, 0, 0, 6),
    drive: readNumber(value.drive, `${path}.drive`, 0, 0, 1),
    indexScale,
  };
}

/**
 * Fixed-routing FM operators. `target` must point at a lower operator index so
 * evaluation needs no cycle check and no graph bookkeeping at render time.
 */
function parseFmOperators(value: unknown, path: string): readonly FmOperator[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FM_OPERATORS) {
    throw new ScoreError(
      `${path} must be an array of 1-${MAX_FM_OPERATORS} modulators with ratio, index, indexDecay, and target`,
    );
  }
  return value.map((entry, index) => {
    const operatorPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      throw new ScoreError(`${operatorPath} must be an object with ratio, index, indexDecay, and target`);
    }
    rejectUnknownKeys(entry, ['ratio', 'index', 'indexDecay', 'target'], operatorPath);
    const target = readRequiredNumber(entry.target, `${operatorPath}.target`, 0, MAX_FM_OPERATORS, true);
    if (target >= index + 1) {
      throw new ScoreError(
        `${operatorPath}.target must be 0 (the carrier) or a lower modulator index, got ${target}`,
      );
    }
    return {
      ratio: readRequiredNumber(entry.ratio, `${operatorPath}.ratio`, 0.25, 8),
      index: readRequiredNumber(entry.index, `${operatorPath}.index`, 0, 12),
      indexDecay: readNumber(entry.indexDecay, `${operatorPath}.indexDecay`, 0.3, 0.01, 4),
      target,
    };
  });
}

/**
 * `chip` keeps the eight PICO-8 formulas; `additive` sums band-limited
 * harmonics; `fm` is a two-operator phase-modulation voice. Unison, drive, and
 * the filter envelope are shared, which is what lets one definition leave the
 * chip palette without adding a second score syntax.
 */
function parseInstrumentSpec(
  value: unknown,
  path: string,
  samples: ReadonlyMap<string, SampleSpec>,
): Instrument {
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with a type (chip, fm, additive, or sample)`);
  }
  rejectUnknownKeys(
    value,
    [
      'type',
      'sample',
      'waveform',
      'partials',
      'stretch',
      'tilt',
      'ratio',
      'index',
      'indexDecay',
      'operators',
      'unison',
      'detune',
      'detuneCents',
      'drive',
      'filter',
      'velocity',
    ],
    path,
  );

  const typeText = readString(value.type, `${path}.type`, 'chip').toLowerCase();
  if (typeText !== 'chip' && typeText !== 'fm' && typeText !== 'additive' && typeText !== 'sample') {
    throw new ScoreError(
      `${path}.type must be chip, fm, or additive (or sample), got ${JSON.stringify(value.type)}`,
    );
  }
  const type = typeText as InstrumentType;

  if (type === 'sample') {
    const sample = readString(value.sample, `${path}.sample`, '');
    if (sample === '') {
      throw new ScoreError(`${path}.sample must name an entry in the top-level samples table`);
    }
    if (!samples.has(sample)) {
      const available = [...samples.keys()];
      throw new ScoreError(
        `${path}.sample: unknown sample ${JSON.stringify(sample)}; define it in the top-level samples table` +
          `${available.length > 0 ? ` (${available.join(', ')})` : ''}`,
      );
    }
    const ignored = [
      'waveform',
      'partials',
      'stretch',
      'tilt',
      'ratio',
      'index',
      'indexDecay',
      'operators',
      'unison',
      'detune',
      'detuneCents',
      'drive',
      'filter',
      'velocity',
    ].filter((key) => value[key] !== undefined);
    if (ignored.length > 0) {
      throw new ScoreError(
        `${path}: sample instruments do not accept ${ignored.join(', ')}; the sample table owns the voice`,
      );
    }
    return {
      type,
      waveform: DEFAULTS.waveform,
      sample,
      unison: 1,
      detuneCents: 0,
      drive: 0,
    };
  }

  if (value.sample !== undefined) {
    throw new ScoreError(`${path}.sample only applies to sample instruments`);
  }

  const waveform = value.waveform === undefined ? DEFAULTS.waveform : parseWaveform(value.waveform);
  if (waveform === undefined) {
    throw new ScoreError(
      `${path}.waveform: use 0-7 or one of triangle, tilted_saw, saw, square, pulse, organ, noise, phaser`,
    );
  }

  const partials =
    value.partials === undefined ? undefined : parsePartials(value.partials, `${path}.partials`);
  const stretch =
    value.stretch === undefined ? undefined : readNumber(value.stretch, `${path}.stretch`, 0, 0, 1);
  const tilt = value.tilt === undefined ? undefined : readNumber(value.tilt, `${path}.tilt`, 0, 0, 4);

  const ratio = value.ratio === undefined ? undefined : readNumber(value.ratio, `${path}.ratio`, 2, 0.25, 8);
  const fmIndex = value.index === undefined ? undefined : readNumber(value.index, `${path}.index`, 3, 0, 12);
  const indexDecay =
    value.indexDecay === undefined ? undefined : readNumber(value.indexDecay, `${path}.indexDecay`, 0.3, 0.01, 4);
  const operators =
    value.operators === undefined ? undefined : parseFmOperators(value.operators, `${path}.operators`);

  if (type !== 'chip' && value.waveform !== undefined) {
    throw new ScoreError(`${path}.waveform only applies to chip instruments`);
  }
  if (type !== 'additive' && (partials !== undefined || stretch !== undefined || tilt !== undefined)) {
    throw new ScoreError(`${path}.partials, .stretch, and .tilt only apply to additive instruments`);
  }
  if (
    type !== 'fm' &&
    (ratio !== undefined || fmIndex !== undefined || indexDecay !== undefined || operators !== undefined)
  ) {
    throw new ScoreError(
      `${path}.ratio, .index, .indexDecay, and .operators only apply to fm instruments`,
    );
  }
  if (operators !== undefined && (ratio !== undefined || fmIndex !== undefined || indexDecay !== undefined)) {
    throw new ScoreError(
      `${path}.operators replaces ${path}.ratio, .index, and .indexDecay; define the voice once`,
    );
  }

  const filter = parseInstrumentFilter(value.filter, `${path}.filter`);
  const velocity = parseVelocityMapping(value.velocity, `${path}.velocity`, type);
  if (velocity !== undefined && velocity.cutoffOctaves > 0 && filter === undefined) {
    throw new ScoreError(
      `${path}.velocity.cutoffOctaves needs ${path}.filter; without a filter there is no cutoff to open`,
    );
  }
  return {
    type,
    waveform,
    ...(partials === undefined ? {} : { partials }),
    ...(stretch === undefined ? {} : { stretch }),
    ...(tilt === undefined ? {} : { tilt }),
    ...(ratio === undefined ? {} : { ratio }),
    ...(fmIndex === undefined ? {} : { index: fmIndex }),
    ...(indexDecay === undefined ? {} : { indexDecay }),
    ...(operators === undefined ? {} : { operators }),
    unison: readNumber(value.unison, `${path}.unison`, 1, 1, 4, true),
    detuneCents: readNumber(value.detune ?? value.detuneCents, `${path}.detune`, 0, 0, 50),
    drive: readNumber(value.drive, `${path}.drive`, 0, 0, 1),
    ...(filter === undefined ? {} : { filter }),
    ...(velocity === undefined ? {} : { velocity }),
  };
}

/**
 * A partial is either a bare amplitude, `[amplitude, phaseDegrees]`, or
 * `[amplitude, phaseDegrees, decaySeconds]`. A negative amplitude is the same
 * shape mirrored, so it becomes a π phase and the renderer only ever sees
 * magnitudes and phases. A decay of 0 is the same as omitting it.
 */
function parsePartial(value: unknown, path: string): Partial {
  if (Array.isArray(value)) {
    if (value.length !== 2 && value.length !== 3) {
      throw new ScoreError(
        `${path} must be [amplitude, phaseDegrees] or [amplitude, phaseDegrees, decaySeconds], got ${value.length} items`,
      );
    }
    const amplitude = readRequiredNumber(value[0], `${path}[0]`, 0, 1);
    const degrees = readRequiredNumber(value[1], `${path}[1]`, -3600, 3600);
    const decay =
      value.length === 3 ? readRequiredNumber(value[2], `${path}[2]`, 0, MAX_PARTIAL_DECAY) : 0;
    return {
      amplitude,
      phase: ((degrees % 360) * Math.PI) / 180,
      ...(decay > 0 ? { decay } : {}),
    };
  }
  const amplitude = readRequiredNumber(value, path, -1, 1);
  return { amplitude: Math.abs(amplitude), phase: amplitude < 0 ? Math.PI : 0 };
}

function parsePartials(value: unknown, path: string): readonly Partial[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTIALS) {
    throw new ScoreError(
      `${path} must be an array of 1-${MAX_PARTIALS} harmonics: amplitude, [amplitude, phaseDegrees], or [amplitude, phaseDegrees, decaySeconds]`,
    );
  }
  return value.map((partial, index) => parsePartial(partial, `${path}[${index}]`));
}

/**
 * Sample paths are workspace-relative and always `.wav`; the app resolves and
 * reads them. Validation lives here so a mistyped path is a score error, not a
 * late I/O error after a long render. Only 16-bit PCM WAV is accepted because
 * that is what `decodeWav` can read without adding a codec dependency.
 */
function parseSampleFile(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScoreError(`${path} must be a workspace-relative .wav path`);
  }
  const file = value.trim();
  if (file.includes('\0')) {
    throw new ScoreError(`${path} contains a NUL byte`);
  }
  if (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file)) {
    throw new ScoreError(`${path} must be workspace-relative, got ${JSON.stringify(file)}`);
  }
  if (file.split(/[\\/]+/).includes('..')) {
    throw new ScoreError(`${path} must stay inside the workspace, got ${JSON.stringify(file)}`);
  }
  if (!file.toLowerCase().endsWith('.wav')) {
    throw new ScoreError(`${path} must end in .wav, got ${JSON.stringify(file)}`);
  }
  return file;
}

/**
 * Zone bounds accept a note name or a MIDI integer, so a model can write
 * `C#3` for the musical intent or 49 when it already has numbers.
 */
function readMidiBound(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 127) {
      throw new ScoreError(`${path} must be a MIDI note 0-127 or a note name such as C3`);
    }
    return value;
  }
  const text = readString(value, path, '');
  const parsed = parseNoteName(text);
  if (parsed === undefined || parsed < 0 || parsed > 127) {
    throw new ScoreError(`${path} must be a note name between C-1 and G9, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseSampleZones(value: unknown, path: string): readonly SampleZone[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ZONES) {
    throw new ScoreError(
      `${path} must be an array of 1-${MAX_ZONES} zones with sample, lo, hi, velLo, and velHi`,
    );
  }
  return value.map((entry, index) => {
    const zonePath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      throw new ScoreError(`${zonePath} must be an object with sample, lo, hi, velLo, and velHi`);
    }
    rejectUnknownKeys(entry, ['sample', 'lo', 'hi', 'velLo', 'velHi'], zonePath);
    const sample = readString(entry.sample, `${zonePath}.sample`, '');
    if (sample === '') {
      throw new ScoreError(`${zonePath}.sample must name a plain sample entry in the same table`);
    }
    const loMidi = readMidiBound(entry.lo, `${zonePath}.lo`, 0);
    const hiMidi = readMidiBound(entry.hi, `${zonePath}.hi`, 127);
    if (loMidi > hiMidi) {
      throw new ScoreError(`${zonePath}.lo (${loMidi}) must not be above .hi (${hiMidi})`);
    }
    const loVelocity = readNumber(entry.velLo, `${zonePath}.velLo`, 0, 0, 1);
    const hiVelocity = readNumber(entry.velHi, `${zonePath}.velHi`, 1, 0, 1);
    if (loVelocity > hiVelocity) {
      throw new ScoreError(
        `${zonePath}.velLo (${loVelocity}) must not be above .velHi (${hiVelocity})`,
      );
    }
    return { sample, loMidi, hiMidi, loVelocity, hiVelocity };
  });
}

/**
 * Slicing is expressed as named regions over one file: a model defines
 * `break_1` and `break_2` with different `start`/`end` offsets, and the decoded
 * PCM is still read and cached once per file. Loop points are relative to the
 * selected region, never to the raw file.
 */
function parseSampleSpec(value: unknown, path: string): SampleSpec {
  if (typeof value === 'string') {
    return { kind: 'file', file: parseSampleFile(value, path), rootMidi: 60, loop: false, gain: 1 };
  }
  if (!isRecord(value)) {
    throw new ScoreError(
      `${path} must be a .wav path, a file object with file, root, loop, and gain, or a zones object`,
    );
  }
  if (value.zones !== undefined) {
    rejectUnknownKeys(value, ['zones'], path);
    return { kind: 'zones', zones: parseSampleZones(value.zones, `${path}.zones`) };
  }
  rejectUnknownKeys(
    value,
    ['file', 'root', 'loop', 'gain', 'start', 'end', 'reverse', 'loopStart', 'loopEnd'],
    path,
  );
  const file = parseSampleFile(value.file, `${path}.file`);

  let rootMidi = 60;
  if (value.root !== undefined) {
    const rootText = readString(value.root, `${path}.root`, 'C4');
    const parsed = parseNoteName(rootText);
    if (parsed === undefined || parsed < 0 || parsed > 127) {
      throw new ScoreError(
        `${path}.root must be a note name between C-1 and G9, got ${JSON.stringify(value.root)}`,
      );
    }
    rootMidi = parsed;
  }

  if (value.loop !== undefined && typeof value.loop !== 'boolean') {
    throw new ScoreError(`${path}.loop must be true or false`);
  }
  const loop = value.loop === true;
  const startSeconds = readNumber(value.start, `${path}.start`, 0, 0, MAX_SAMPLE_OFFSET_SECONDS);
  const endSeconds =
    value.end === undefined
      ? undefined
      : readNumber(value.end, `${path}.end`, 0, 0, MAX_SAMPLE_OFFSET_SECONDS);
  if (endSeconds !== undefined && endSeconds <= startSeconds) {
    throw new ScoreError(`${path}.end (${endSeconds}s) must be after .start (${startSeconds}s)`);
  }
  const loopStartSeconds =
    value.loopStart === undefined
      ? undefined
      : readNumber(value.loopStart, `${path}.loopStart`, 0, 0, MAX_SAMPLE_OFFSET_SECONDS);
  const loopEndSeconds =
    value.loopEnd === undefined
      ? undefined
      : readNumber(value.loopEnd, `${path}.loopEnd`, 0, 0, MAX_SAMPLE_OFFSET_SECONDS);
  if ((loopStartSeconds !== undefined || loopEndSeconds !== undefined) && !loop) {
    throw new ScoreError(`${path}.loopStart and .loopEnd need ${path}.loop true`);
  }
  if (loopStartSeconds !== undefined && loopStartSeconds < startSeconds) {
    throw new ScoreError(`${path}.loopStart must not be before ${path}.start`);
  }
  if (loopStartSeconds !== undefined && endSeconds !== undefined && loopStartSeconds >= endSeconds) {
    throw new ScoreError(`${path}.loopStart must be before ${path}.end`);
  }
  if (loopEndSeconds !== undefined && loopStartSeconds !== undefined && loopEndSeconds <= loopStartSeconds) {
    throw new ScoreError(`${path}.loopEnd must be after ${path}.loopStart`);
  }
  if (loopEndSeconds !== undefined && endSeconds !== undefined && loopEndSeconds > endSeconds) {
    throw new ScoreError(`${path}.loopEnd must not be past ${path}.end`);
  }

  return {
    kind: 'file',
    file,
    rootMidi,
    loop,
    gain: readNumber(value.gain, `${path}.gain`, 1, 0, 4),
    ...(startSeconds === 0 ? {} : { startSeconds }),
    ...(endSeconds === undefined ? {} : { endSeconds }),
    ...(value.reverse === undefined ? {} : { reverse: readBoolean(value.reverse, `${path}.reverse`, false) }),
    ...(loopStartSeconds === undefined ? {} : { loopStartSeconds }),
    ...(loopEndSeconds === undefined ? {} : { loopEndSeconds }),
  };
}

/**
 * Zone sets are one level deep: a zone must point at a plain file entry. That
 * keeps selection a single lookup and avoids recursive sample graphs.
 */
function validateSampleZones(samples: ReadonlyMap<string, SampleSpec>): void {
  for (const [name, spec] of samples) {
    if (spec.kind !== 'zones') continue;
    for (const [index, zone] of spec.zones.entries()) {
      const target = samples.get(zone.sample);
      if (target === undefined) {
        throw new ScoreError(
          `samples.${name}.zones[${index}]: unknown sample ${JSON.stringify(zone.sample)}; define it in the same samples table`,
        );
      }
      if (target.kind !== 'file') {
        throw new ScoreError(
          `samples.${name}.zones[${index}]: ${JSON.stringify(zone.sample)} is itself a zone set; zones must point at plain files`,
        );
      }
    }
  }
}

function parseSamples(value: unknown): ReadonlyMap<string, SampleSpec> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError('samples must be an object mapping names to .wav paths or sample definitions');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SAMPLES) {
    throw new ScoreError(`samples has ${entries.length} entries; use at most ${MAX_SAMPLES}`);
  }
  const output = new Map<string, SampleSpec>();
  for (const [name, entry] of entries) {
    if (!SAMPLE_NAME_RE.test(name)) {
      throw new ScoreError(
        `samples.${name}: names must start with a letter or underscore and contain only letters, digits, _ or -`,
      );
    }
    output.set(name, parseSampleSpec(entry, `samples.${name}`));
  }
  return output;
}

/** Optional per-voice drum replacements; unmapped voices keep the synth path. */
function parseDrumSamples(
  value: unknown,
  samples: ReadonlyMap<string, SampleSpec>,
): ReadonlyMap<DrumName, string> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError('drumSamples must be an object mapping drum names to sample names');
  }
  const output = new Map<DrumName, string>();
  for (const [rawName, rawSample] of Object.entries(value)) {
    const drum = parseDrumName(rawName);
    if (drum === undefined) {
      throw new ScoreError(
        `drumSamples.${rawName}: unknown drum voice; use kick, snare, hat, openhat, clap, tom, rim, or crash`,
      );
    }
    if (output.has(drum)) {
      throw new ScoreError(`drumSamples.${rawName}: ${drum} is mapped more than once`);
    }
    const name = readString(rawSample, `drumSamples.${rawName}`, '');
    if (name === '') {
      throw new ScoreError(`drumSamples.${rawName} must name an entry in the top-level samples table`);
    }
    if (!samples.has(name)) {
      const available = [...samples.keys()];
      throw new ScoreError(
        `drumSamples.${rawName}: unknown sample ${JSON.stringify(name)}; define it in the top-level samples table` +
          `${available.length > 0 ? ` (${available.join(', ')})` : ''}`,
      );
    }
    output.set(drum, name);
  }
  return output;
}

/**
 * Optional drum choke map: a trigger voice fades still-ringing target voices.
 * The map is empty by default, so old scores keep every overlapping tail.
 */
function parseDrumChoke(value: unknown): ReadonlyMap<DrumName, readonly DrumName[]> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError(
      'drumChoke must be an object mapping a trigger drum voice to an array of choked voices',
    );
  }
  const output = new Map<DrumName, readonly DrumName[]>();
  for (const [rawName, rawTargets] of Object.entries(value)) {
    const trigger = parseDrumName(rawName);
    if (trigger === undefined) {
      throw new ScoreError(
        `drumChoke.${rawName}: unknown trigger voice; use kick, snare, hat, openhat, clap, tom, rim, or crash`,
      );
    }
    if (output.has(trigger)) {
      throw new ScoreError(`drumChoke.${rawName}: ${trigger} is mapped more than once`);
    }
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw new ScoreError(
        `drumChoke.${rawName} must be a non-empty array of drum voices`,
      );
    }
    const targets: DrumName[] = [];
    for (const rawTarget of rawTargets) {
      if (typeof rawTarget !== 'string') {
        throw new ScoreError(`drumChoke.${rawName}: targets must be drum voice names`);
      }
      const target = parseDrumName(rawTarget.trim());
      if (target === undefined) {
        throw new ScoreError(
          `drumChoke.${rawName}: unknown target voice ${JSON.stringify(rawTarget)}; use kick, snare, hat, openhat, clap, tom, rim, or crash`,
        );
      }
      if (!targets.includes(target)) targets.push(target);
    }
    output.set(trigger, targets);
  }
  return output;
}

function parseInstruments(
  value: unknown,
  samples: ReadonlyMap<string, SampleSpec>,
): ReadonlyMap<string, Instrument> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError('instruments must be an object mapping names to instrument definitions');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_INSTRUMENTS) {
    throw new ScoreError(`instruments has ${entries.length} entries; use at most ${MAX_INSTRUMENTS}`);
  }
  const output = new Map<string, Instrument>();
  for (const [name, entry] of entries) {
    if (!INSTRUMENT_NAME_RE.test(name)) {
      throw new ScoreError(
        `instruments.${name}: names must start with a letter or underscore and contain only letters, digits, _ or -`,
      );
    }
    if (RESERVED_INSTRUMENT_NAMES.has(name.toLowerCase())) {
      throw new ScoreError(`instruments.${name}: ${name} is a built-in instrument type; choose another name`);
    }
    output.set(name, parseInstrumentSpec(entry, `instruments.${name}`, samples));
  }
  return output;
}

interface ResolvedInstrument {
  readonly isDrums: boolean;
  readonly instrument?: Instrument;
}

/** A track names an instrument, inlines one, or keeps the legacy waveform. */
function resolveTrackInstrument(
  value: unknown,
  path: string,
  instruments: ReadonlyMap<string, Instrument>,
  samples: ReadonlyMap<string, SampleSpec>,
): ResolvedInstrument {
  if (value === undefined) return { isDrums: false };

  if (typeof value === 'string') {
    const name = value.trim();
    const lower = name.toLowerCase();
    if (lower === 'drums') return { isDrums: true };
    const named = instruments.get(name) ?? instruments.get(lower);
    if (named !== undefined) return { isDrums: false, instrument: named };
    if (lower === 'chip' || lower === 'fm' || lower === 'additive') {
      return { isDrums: false, instrument: parseInstrumentSpec({ type: lower }, path, samples) };
    }
    const available = [...instruments.keys()];
    throw new ScoreError(
      `${path}: unknown instrument ${JSON.stringify(name)}; define it in the top-level instruments table` +
        `${available.length > 0 ? ` (${available.join(', ')})` : ''}, or use chip, fm, additive, or drums`,
    );
  }

  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an instrument name or an object with a type`);
  }
  const typeText = typeof value.type === 'string' ? value.type.toLowerCase() : undefined;
  if (typeText === 'drums') {
    rejectUnknownKeys(value, ['type', 'waveform'], path);
    return { isDrums: true };
  }
  return { isDrums: false, instrument: parseInstrumentSpec(value, path, samples) };
}

function parseNoteVolume(text: string, where: string): number {
  if (!/^\d+(?:\.\d)?$/.test(text)) {
    throw new ScoreError(`${where}: volume must be a number between 0 and 7`);
  }
  const volume = Number.parseFloat(text);
  if (volume < 0 || volume > 7) {
    throw new ScoreError(`${where}: volume must be between 0 and 7, got ${text}`);
  }
  return volume;
}

interface ParsedPattern {
  readonly events: readonly NoteEvent[];
  readonly patternSteps: number;
}

interface PatternToken {
  readonly noteText: string;
  readonly steps: number;
  readonly gateSteps?: number;
  readonly volume?: number;
  readonly effect: Effect;
  readonly effectParams?: EffectParams;
  readonly drumEffect?: DrumEffect;
  readonly drumParams?: DrumParams;
  /** Authored token offset in milliseconds; positive is late. */
  readonly offsetMs?: number;
  /** Per-note spatial overrides; absent keeps the track value. */
  readonly pan?: number;
  readonly send?: number;
  /** Resolved later against the envelopes and articulations tables. */
  readonly namedSuffix?: string;
}

type EffectSuffix =
  | { readonly kind: 'effect'; readonly effect: Effect; readonly params?: EffectParams }
  | { readonly kind: 'drum'; readonly drum: DrumEffect }
  | { readonly kind: 'drumParam'; readonly drumParams: DrumParams }
  | { readonly kind: 'timing'; readonly offsetMs: number }
  | { readonly kind: 'spatial'; readonly pan?: number; readonly send?: number }
  | { readonly kind: 'name'; readonly name: string };

const SUFFIX_RE = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/;

function isRestNote(noteText: string, isDrums: boolean): boolean {
  const lower = noteText.toLowerCase();
  return lower === '-' || lower === 'rest' || (lower === 'r' && !(isDrums && noteText === 'R'));
}

function parseNumberArguments(text: string, where: string, count: number): number[] {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== count) {
    throw new ScoreError(`${where}: expected ${count} numeric parameter(s), got ${parts.length}`);
  }
  return parts.map((part) => {
    if (!/^-?\d+(?:\.\d+)?$/.test(part)) {
      throw new ScoreError(`${where}: ${JSON.stringify(part)} is not a number`);
    }
    return Number.parseFloat(part);
  });
}

function parseArpParams(
  argsText: string | undefined,
  where: string,
): EffectParams | undefined {
  if (argsText === undefined) return undefined;
  if (argsText.trim() === '') {
    throw new ScoreError(`${where}: arp takes at least one semitone offset`);
  }
  const parts = argsText.split(';');
  if (parts.length > 2) {
    throw new ScoreError(
      `${where}: arp takes a semitone list and an optional period, e.g. ~arpfast(0,4,7,11;0.25)`,
    );
  }
  const semitonesText = (parts[0] ?? '').trim();
  const periodText = parts[1]?.trim() ?? '';

  if (semitonesText === '') {
    throw new ScoreError(`${where}: arp takes at least one semitone offset`);
  }
  const items = semitonesText.split(',').map((item) => item.trim());
  if (items.length < 1 || items.length > 8) {
    throw new ScoreError(`${where}: arp takes 1-8 semitone offsets, got ${items.length}`);
  }
  const arpSemitones = items.map((item) => {
    if (!/^-?\d+$/.test(item)) {
      throw new ScoreError(`${where}: ${JSON.stringify(item)} is not an integer semitone offset`);
    }
    const value = Number.parseInt(item, 10);
    if (value < -24 || value > 24) {
      throw new ScoreError(`${where}: arp semitones must be between -24 and 24, got ${value}`);
    }
    return value;
  });

  let arpSteps: number | undefined;
  if (periodText !== '') {
    if (!/^\d+(?:\.\d+)?$/.test(periodText)) {
      throw new ScoreError(`${where}: ${JSON.stringify(periodText)} is not an arp period`);
    }
    arpSteps = Number.parseFloat(periodText);
    if (arpSteps < 0.05 || arpSteps > 8) {
      throw new ScoreError(`${where}: arp period must be between 0.05 and 8 steps, got ${arpSteps}`);
    }
  }

  return {
    arpSemitones,
    ...(arpSteps === undefined ? {} : { arpSteps }),
  };
}

function parseEffectParams(
  effect: Effect,
  argsText: string | undefined,
  where: string,
): EffectParams | undefined {
  if (argsText === undefined) return undefined;

  if (effect === 6 || effect === 7) {
    return parseArpParams(argsText, where);
  }

  if (effect === 2) {
    const parts = argsText.split(',').map((part) => part.trim());
    if (parts.length < 1 || parts.length > 2) {
      throw new ScoreError(`${where}: vibrato takes (depth[,rateHz])`);
    }
    const depth = parseNumberArguments(parts[0] ?? '', where, 1)[0] ?? 0;
    const rate = parts[1] === undefined ? 7.5 : parseNumberArguments(parts[1], where, 1)[0] ?? 7.5;
    if (depth < 0 || depth > 2) {
      throw new ScoreError(`${where}: vibrato depth must be between 0 and 2 semitones, got ${depth}`);
    }
    if (rate < 0.1 || rate > 20) {
      throw new ScoreError(`${where}: vibrato rate must be between 0.1 and 20 Hz, got ${rate}`);
    }
    return { vibratoDepth: depth, vibratoRate: rate };
  }

  if (effect === 1) {
    const steps = parseNumberArguments(argsText, where, 1)[0] ?? 1;
    if (steps < 0.05 || steps > 8) {
      throw new ScoreError(`${where}: slide time must be between 0.05 and 8 steps, got ${steps}`);
    }
    return { slideSteps: steps };
  }

  throw new ScoreError(`${where}: ${EFFECT_NAMES[effect]} takes no parameters`);
}

const DRUM_EFFECT_RE = /^(ghost|flam|roll)(\d*)$/;

/** True for names that belong to the drum vocabulary, including `roll4`. */
function isDrumEffectName(name: string): boolean {
  return DRUM_EFFECT_RE.test(name.trim().toLowerCase().replace(/[_-]/g, ''));
}

function parseDrumEffectSuffix(
  rawName: string,
  argsText: string | undefined,
  where: string,
): DrumEffect | undefined {
  const name = rawName.trim().toLowerCase().replace(/[_-]/g, '');
  const match = DRUM_EFFECT_RE.exec(name);
  if (!match) return undefined;

  const kind = match[1];
  const trailing = match[2] ?? '';

  if (kind === 'ghost') {
    if (argsText !== undefined || trailing !== '') {
      throw new ScoreError(`${where}: ghost takes no parameters`);
    }
    return { kind: 'ghost' };
  }

  if (kind === 'flam') {
    if (trailing !== '') {
      throw new ScoreError(`${where}: flam takes an offset in milliseconds, e.g. ~flam(18)`);
    }
    const offsetMs = argsText === undefined ? 16 : parseNumberArguments(argsText, where, 1)[0] ?? 16;
    if (offsetMs < 5 || offsetMs > 40) {
      throw new ScoreError(`${where}: flam offset must be between 5 and 40 ms, got ${offsetMs}`);
    }
    return { kind: 'flam', offsetMs };
  }

  if (argsText !== undefined && trailing !== '') {
    throw new ScoreError(`${where}: roll takes one hit count, not both "roll${trailing}" and "roll(...)"`);
  }
  const rawHits = argsText ?? trailing;
  const hits = rawHits === '' ? 4 : parseNumberArguments(rawHits, where, 1)[0] ?? 4;
  if (!Number.isInteger(hits) || hits < 2 || hits > 8) {
    throw new ScoreError(`${where}: roll hits must be an integer between 2 and 8, got ${hits}`);
  }
  return { kind: 'roll', hits };
}

const DRUM_PARAM_RE = /^(pitch|decay|tone)(\d*)$/;

/** `~pitch(-3)`, `~decay(1.4)`, `~tone(2400)`; one field per suffix. */
function parseDrumParamSuffix(
  rawName: string,
  argsText: string | undefined,
  where: string,
): DrumParams | undefined {
  const name = rawName.trim().toLowerCase().replace(/[_-]/g, '');
  const match = DRUM_PARAM_RE.exec(name);
  if (!match) return undefined;
  const kind = match[1];
  if ((match[2] ?? '') !== '' || argsText === undefined) {
    throw new ScoreError(
      `${where}: ${kind} takes a parenthesised value, e.g. ~${kind}(${kind === 'pitch' ? '-2' : kind === 'decay' ? '1.4' : '2400'})`,
    );
  }
  const value = parseNumberArguments(argsText, where, 1)[0] ?? 0;

  if (kind === 'pitch') {
    if (value < -12 || value > 12) {
      throw new ScoreError(`${where}: pitch must be between -12 and 12 semitones, got ${value}`);
    }
    return { pitchSemitones: value };
  }
  if (kind === 'decay') {
    if (value < 0.25 || value > 4) {
      throw new ScoreError(`${where}: decay must be a scale between 0.25 and 4, got ${value}`);
    }
    return { decayScale: value };
  }
  if (value < 200 || value > 16000) {
    throw new ScoreError(`${where}: tone must be between 200 and 16000 Hz, got ${value}`);
  }
  return { toneHz: value };
}

/** `~drag` is late and `~push` is early; both values are unsigned milliseconds. */
function isTimingSuffixName(name: string): boolean {
  const normalised = name.trim().toLowerCase();
  return normalised === 'drag' || normalised === 'push';
}

/** `~pan`/`~send` are reserved spatial suffixes, not envelope names. */
function isSpatialSuffixName(name: string): boolean {
  const normalised = name.trim().toLowerCase();
  return normalised === 'pan' || normalised === 'send';
}

function parseTimingSuffix(
  rawName: string,
  argsText: string | undefined,
  where: string,
): EffectSuffix | undefined {
  const name = rawName.trim().toLowerCase();
  if (name !== 'drag' && name !== 'push') return undefined;
  if (argsText === undefined) {
    throw new ScoreError(`${where}: ~${name} needs a value in milliseconds, e.g. ~${name}(15)`);
  }
  const value = parseNumberArguments(argsText, where, 1)[0] ?? 0;
  if (value < 0) {
    const opposite = name === 'drag' ? 'push' : 'drag';
    throw new ScoreError(
      `${where}: ~${name} takes an unsigned value; write ~${opposite}(${-value}) for the other direction`,
    );
  }
  if (value > 200) {
    throw new ScoreError(`${where}: ~${name} must be between 0 and 200 ms, got ${value}`);
  }
  return { kind: 'timing', offsetMs: name === 'drag' ? value : -value };
}

/** `~pan(-1)` and `~send(0.5)` override only this note's spatial placement. */
function parseSpatialSuffix(
  rawName: string,
  argsText: string | undefined,
  where: string,
): EffectSuffix | undefined {
  const name = rawName.trim().toLowerCase();
  if (name !== 'pan' && name !== 'send') return undefined;
  if (argsText === undefined) {
    throw new ScoreError(
      `${where}: ~${name} needs a value, e.g. ~${name}(${name === 'pan' ? '-0.5' : '0.4'})`,
    );
  }
  const value = parseNumberArguments(argsText, where, 1)[0] ?? 0;
  if (name === 'pan') {
    if (value < -1 || value > 1) {
      throw new ScoreError(`${where}: ~pan must be between -1 and 1, got ${value}`);
    }
    return { kind: 'spatial', pan: value };
  }
  if (value < 0 || value > 1) {
    throw new ScoreError(`${where}: ~send must be between 0 and 1, got ${value}`);
  }
  return { kind: 'spatial', send: value };
}

function parseEffectSuffix(text: string, where: string): EffectSuffix {
  const raw = text.trim();
  if (raw === '') {
    throw new ScoreError(`${where}: empty "~" suffix`);
  }
  const match = SUFFIX_RE.exec(raw);
  if (!match) {
    throw new ScoreError(
      `${where}: invalid "~" suffix ${JSON.stringify(raw)}; use ~effect or ~effect(params), or a named envelope`,
    );
  }
  const name = match[1] ?? '';
  const argsText = match[2];
  const effect = parseEffect(name);
  if (effect === undefined) {
    const timing = parseTimingSuffix(name, argsText, where);
    if (timing !== undefined) return timing;
    const spatial = parseSpatialSuffix(name, argsText, where);
    if (spatial !== undefined) return spatial;
    const drum = parseDrumEffectSuffix(name, argsText, where);
    if (drum !== undefined) return { kind: 'drum', drum };
    const drumParams = parseDrumParamSuffix(name, argsText, where);
    if (drumParams !== undefined) return { kind: 'drumParam', drumParams };
    if (argsText !== undefined) {
      throw new ScoreError(
        `${where}: named envelope or articulation ${JSON.stringify(name)} takes no parameters`,
      );
    }
    return { kind: 'name', name };
  }
  return { kind: 'effect', effect, params: parseEffectParams(effect, argsText, where) };
}

/** Parses one pattern token without interpreting its note/drum name. */
function parsePatternToken(token: string, where: string): PatternToken {
  // `@volume` may appear anywhere: "C4:4@6~slide" and "C4:4~slide@6" both work.
  const volumeParts = token.split('@');
  if (volumeParts.length > 2) {
    throw new ScoreError(`${where}: use at most one "@volume" suffix`);
  }
  const body = volumeParts[0] ?? '';
  let volumeText = volumeParts[1];
  let trailingSuffix = '';
  // When @ comes before ~ ("C4:4@6~slide"), the suffix rides along after the
  // volume digits; move it back onto the token body before splitting effects.
  const suffixStart = volumeText?.indexOf('~') ?? -1;
  if (volumeText !== undefined && suffixStart !== -1) {
    trailingSuffix = volumeText.slice(suffixStart);
    volumeText = volumeText.slice(0, suffixStart);
  }

  const suffixParts = `${body}${trailingSuffix}`.split('~');
  let effect: Effect = 0;
  let effectParams: EffectParams | undefined;
  let drumEffect: DrumEffect | undefined;
  let drumParams: DrumParams | undefined;
  let offsetMs: number | undefined;
  let pan: number | undefined;
  let send: number | undefined;
  let namedSuffix: string | undefined;
  let sawEffect = false;
  let sawTiming = false;
  for (const part of suffixParts.slice(1)) {
    const suffix = parseEffectSuffix(part, where);
    if (suffix.kind === 'effect') {
      if (sawEffect) {
        throw new ScoreError(`${where}: use at most one "~effect" suffix`);
      }
      effect = suffix.effect;
      effectParams = suffix.params;
      sawEffect = true;
      continue;
    }
    if (suffix.kind === 'drum') {
      if (drumEffect !== undefined) {
        throw new ScoreError(`${where}: use at most one drum effect (~ghost, ~flam, or ~roll)`);
      }
      drumEffect = suffix.drum;
      continue;
    }
    if (suffix.kind === 'drumParam') {
      const repeated = Object.keys(suffix.drumParams).find(
        (key) => drumParams?.[key as keyof DrumParams] !== undefined,
      );
      if (repeated !== undefined) {
        const name =
          repeated === 'toneHz' ? 'tone' : repeated === 'decayScale' ? 'decay' : 'pitch';
        throw new ScoreError(`${where}: use at most one ~${name} suffix`);
      }
      drumParams = { ...drumParams, ...suffix.drumParams };
      continue;
    }
    if (suffix.kind === 'timing') {
      if (sawTiming) {
        throw new ScoreError(`${where}: use at most one timing suffix (~drag or ~push)`);
      }
      offsetMs = suffix.offsetMs;
      sawTiming = true;
      continue;
    }
    if (suffix.kind === 'spatial') {
      if (suffix.pan !== undefined) {
        if (pan !== undefined) {
          throw new ScoreError(`${where}: use at most one ~pan suffix`);
        }
        pan = suffix.pan;
      }
      if (suffix.send !== undefined) {
        if (send !== undefined) {
          throw new ScoreError(`${where}: use at most one ~send suffix`);
        }
        send = suffix.send;
      }
      continue;
    }
    if (namedSuffix !== undefined) {
      throw new ScoreError(`${where}: use at most one named suffix (~name)`);
    }
    namedSuffix = suffix.name;
  }

  const bodyParts = (suffixParts[0] ?? '').split(':');
  if (bodyParts.length > 2) {
    throw new ScoreError(`${where}: expected "note:steps", e.g. "C4:4"`);
  }

  let steps = 1;
  let gateSteps: number | undefined;
  const stepsText = bodyParts[1];
  if (stepsText !== undefined) {
    const match = /^(\d+)(?:g(\d+))?$/i.exec(stepsText);
    if (!match) {
      throw new ScoreError(`${where}: duration must look like "4" or "4g2" (slot and gate steps)`);
    }
    steps = Number.parseInt(match[1] ?? '', 10);
    if (steps < 1) {
      throw new ScoreError(`${where}: duration must be between 1 and ${MAX_STEPS_PER_NOTE} steps`);
    }
    if (steps > MAX_GATE_STEPS) {
      throw new ScoreError(`${where}: duration must be between 1 and ${MAX_GATE_STEPS} steps`);
    }
    const gateText = match[2];
    if (gateText !== undefined) {
      gateSteps = Number.parseInt(gateText, 10);
      if (gateSteps < 1 || gateSteps > MAX_GATE_STEPS) {
        throw new ScoreError(`${where}: gate must be between 1 and ${MAX_GATE_STEPS} steps`);
      }
    }
  }

  const noteText = (bodyParts[0] ?? '').trim();
  if (noteText === '') {
    throw new ScoreError(`${where}: missing note before ":"`);
  }

  return {
    noteText,
    steps,
    ...(gateSteps === undefined ? {} : { gateSteps }),
    ...(volumeText === undefined ? {} : { volume: parseNoteVolume(volumeText.trim(), where) }),
    effect,
    ...(effectParams === undefined ? {} : { effectParams }),
    ...(drumEffect === undefined ? {} : { drumEffect }),
    ...(drumParams === undefined ? {} : { drumParams }),
    ...(offsetMs === undefined ? {} : { offsetMs }),
    ...(pan === undefined ? {} : { pan }),
    ...(send === undefined ? {} : { send }),
    ...(namedSuffix === undefined ? {} : { namedSuffix }),
  };
}

function formatEffectParams(effect: Effect, params: EffectParams): string {
  if (effect === 2) {
    return `(${String(params.vibratoDepth ?? 0.5)},${String(params.vibratoRate ?? 7.5)})`;
  }
  if (effect === 1) {
    return `(${String(params.slideSteps ?? 1)})`;
  }
  if (effect === 6 || effect === 7) {
    const semitones = params.arpSemitones?.join(',') ?? '';
    const period = params.arpSteps === undefined ? '' : `;${String(params.arpSteps)}`;
    if (semitones === '' && period === '') return '';
    return semitones === '' ? `(;${String(params.arpSteps)})` : `(${semitones}${period})`;
  }
  return '';
}

function formatDrumEffect(effect: DrumEffect | undefined): string {
  if (effect === undefined) return '';
  if (effect.kind === 'ghost') return '~ghost';
  if (effect.kind === 'flam') return `~flam(${String(effect.offsetMs)})`;
  return `~roll(${String(effect.hits)})`;
}

function formatDrumParams(params: DrumParams | undefined): string {
  if (params === undefined) return '';
  const pitch = params.pitchSemitones === undefined ? '' : `~pitch(${String(params.pitchSemitones)})`;
  const decay = params.decayScale === undefined ? '' : `~decay(${String(params.decayScale)})`;
  const tone = params.toneHz === undefined ? '' : `~tone(${String(params.toneHz)})`;
  return `${pitch}${decay}${tone}`;
}

function formatTimingSuffix(offsetMs: number | undefined): string {
  if (offsetMs === undefined) return '';
  return offsetMs < 0 ? `~push(${String(-offsetMs)})` : `~drag(${String(offsetMs)})`;
}

function formatPatternToken(token: PatternToken): string {
  const gate = token.gateSteps === undefined ? '' : `g${token.gateSteps}`;
  const volume = token.volume === undefined ? '' : `@${token.volume}`;
  const params = token.effectParams === undefined ? '' : formatEffectParams(token.effect, token.effectParams);
  const effect = token.effect === 0 ? '' : `~${EFFECT_NAMES[token.effect]}${params}`;
  const drumEffect = formatDrumEffect(token.drumEffect);
  const drumParams = formatDrumParams(token.drumParams);
  const timing = formatTimingSuffix(token.offsetMs);
  const spatial = `${token.pan === undefined ? '' : `~pan(${String(token.pan)})`}${token.send === undefined ? '' : `~send(${String(token.send)})`}`;
  const named = token.namedSuffix === undefined ? '' : `~${token.namedSuffix}`;
  return `${token.noteText}:${token.steps}${gate}${volume}${effect}${drumEffect}${drumParams}${timing}${spatial}${named}`;
}

type MotifTransformName = 'transpose' | 'invert' | 'retrograde' | 'augment' | 'diminish';

interface MotifTransform {
  readonly name: MotifTransformName;
  readonly amount?: number;
}

interface MotifReference {
  readonly name: string;
  readonly transforms: readonly MotifTransform[];
}

function parseMotifReference(token: string, where: string): MotifReference {
  const body = token.slice(1);
  if (body === '') throw new ScoreError(`${where}: empty motif reference`);

  const parts = body.split('.');
  const name = parts.shift() ?? '';
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new ScoreError(
      `${where}: invalid motif name ${JSON.stringify(name)}; use letters, digits, "_" or "-"`,
    );
  }

  const transforms = parts.map((part): MotifTransform => {
    const match = /^([a-z]+)(?:\((-?\d+)\))?$/i.exec(part);
    if (!match) {
      throw new ScoreError(
        `${where}: invalid motif transform ${JSON.stringify(part)}; use transpose(n), invert, retrograde, augment(n), or diminish(n)`,
      );
    }
    const transformName = (match[1] ?? '').toLowerCase();
    const rawAmount = match[2];
    if (!['transpose', 'invert', 'retrograde', 'augment', 'diminish'].includes(transformName)) {
      throw new ScoreError(
        `${where}: invalid motif transform ${JSON.stringify(part)}; use transpose(n), invert, retrograde, augment(n), or diminish(n)`,
      );
    }
    if (transformName === 'invert' || transformName === 'retrograde') {
      if (rawAmount !== undefined) {
        throw new ScoreError(`${where}: ${transformName} takes no argument`);
      }
      return { name: transformName };
    }
    if (rawAmount === undefined) {
      throw new ScoreError(`${where}: ${transformName} requires an integer argument`);
    }
    const amount = Number.parseInt(rawAmount, 10);
    if (transformName === 'transpose') {
      if (amount < -24 || amount > 24) {
        throw new ScoreError(`${where}: transpose must be between -24 and 24 semitones, got ${amount}`);
      }
      return { name: 'transpose', amount };
    }
    if (amount < 2 || amount > 8) {
      throw new ScoreError(`${where}: ${transformName} must be between 2 and 8, got ${amount}`);
    }
    return { name: transformName as 'augment' | 'diminish', amount };
  });

  return { name, transforms };
}

function motifMidi(
  token: PatternToken,
  where: string,
  transform: string,
  isDrums: boolean,
): number | undefined {
  if (isRestNote(token.noteText, isDrums)) return undefined;
  const midi = parseNoteName(token.noteText);
  if (midi === undefined) {
    if (parseDrumName(token.noteText) !== undefined) {
      throw new ScoreError(
        `${where}: ${transform} cannot transform drum token ${JSON.stringify(token.noteText)}; use retrograde, augment, or diminish`,
      );
    }
    if (isChordName(token.noteText)) {
      throw new ScoreError(
        `${where}: ${transform} cannot transform chord ${JSON.stringify(token.noteText)}; use retrograde, augment, or diminish`,
      );
    }
    throw new ScoreError(`${where}: unknown note ${JSON.stringify(token.noteText)} in motif`);
  }
  return midi;
}

function checkMidiRange(midi: number, where: string, noteText: string): number {
  if (midi < 24 || midi > 108) {
    throw new ScoreError(`${where}: transformed note ${noteText} is outside C1..C8`);
  }
  return midi;
}

function applyMotifTransforms(
  tokens: readonly PatternToken[],
  transforms: readonly MotifTransform[],
  where: string,
  isDrums: boolean,
): PatternToken[] {
  let result = tokens.slice();
  for (const transform of transforms) {
    switch (transform.name) {
      case 'transpose': {
        const amount = transform.amount ?? 0;
        result = result.map((token) => {
          const midi = motifMidi(token, where, 'transpose', isDrums);
          if (midi === undefined) return token;
          const next = checkMidiRange(midi + amount, where, token.noteText);
          return { ...token, noteText: formatNoteName(next) };
        });
        break;
      }
      case 'invert': {
        const pivotIndex = result.findIndex(
          (token) => motifMidi(token, where, 'invert', isDrums) !== undefined,
        );
        const pivotToken = result[pivotIndex];
        if (pivotToken === undefined) break;
        const pivot = motifMidi(pivotToken, where, 'invert', isDrums);
        if (pivot === undefined) break;
        result = result.map((token) => {
          const midi = motifMidi(token, where, 'invert', isDrums);
          if (midi === undefined) return token;
          const next = checkMidiRange(2 * pivot - midi, where, token.noteText);
          return { ...token, noteText: formatNoteName(next) };
        });
        break;
      }
      case 'retrograde':
        result = result.reverse();
        break;
      case 'augment': {
        const amount = transform.amount ?? 1;
        result = result.map((token) => {
          const steps = token.steps * amount;
          const gateSteps = token.gateSteps === undefined ? undefined : token.gateSteps * amount;
          if (steps > MAX_STEPS_PER_NOTE || (gateSteps ?? 0) > MAX_GATE_STEPS) {
            throw new ScoreError(
              `${where}: augment(${amount}) makes ${token.noteText} longer than the allowed step range`,
            );
          }
          return { ...token, steps, ...(gateSteps === undefined ? {} : { gateSteps }) };
        });
        break;
      }
      case 'diminish': {
        const amount = transform.amount ?? 1;
        result = result.map((token) => {
          if (token.steps % amount !== 0 || ((token.gateSteps ?? 0) > 0 && (token.gateSteps ?? 0) % amount !== 0)) {
            throw new ScoreError(
              `${where}: diminish(${amount}) needs every slot and gate duration divisible by ${amount}; ${token.noteText} does not fit`,
            );
          }
          const gateSteps = token.gateSteps === undefined ? undefined : token.gateSteps / amount;
          return { ...token, steps: token.steps / amount, ...(gateSteps === undefined ? {} : { gateSteps }) };
        });
        break;
      }
    }
  }
  return result;
}

function expandMotif(
  reference: MotifReference,
  motifs: ReadonlyMap<string, string>,
  isDrums: boolean,
  stack: readonly string[],
  where: string,
): PatternToken[] {
  if (stack.includes(reference.name)) {
    throw new ScoreError(`${where}: motif cycle ${[...stack, reference.name].join(' -> ')}`);
  }
  if (stack.length >= 8) {
    throw new ScoreError(`${where}: motif nesting is deeper than 8 levels`);
  }

  const source = motifs.get(reference.name);
  if (source === undefined) {
    throw new ScoreError(
      `${where}: unknown motif ${JSON.stringify(reference.name)}; define it in motifs or tracks[].motifs`,
    );
  }
  const sourceTokens = source.trim().split(/\s+/).filter(Boolean);
  if (sourceTokens.length === 0) {
    throw new ScoreError(`${where}: motif ${JSON.stringify(reference.name)} is empty`);
  }

  const nextStack = [...stack, reference.name];
  const tokens: PatternToken[] = [];
  sourceTokens.forEach((token, index) => {
    const tokenWhere = `${where} → motif ${reference.name} token ${index + 1}`;
    if (token.startsWith('@')) {
      const nested = parseMotifReference(token, tokenWhere);
      tokens.push(...expandMotif(nested, motifs, isDrums, nextStack, tokenWhere));
    } else {
      tokens.push(parsePatternToken(token, tokenWhere));
    }
  });

  return applyMotifTransforms(tokens, reference.transforms, where, isDrums);
}

function expandMotifs(
  pattern: string,
  path: string,
  motifs: ReadonlyMap<string, string>,
  isDrums: boolean,
): string {
  const tokens = pattern.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.some((token) => token.startsWith('@'))) {
    return pattern;
  }

  const expanded: string[] = [];
  tokens.forEach((token, index) => {
    if (!token.startsWith('@')) {
      expanded.push(token);
      return;
    }
    const where = `${path} token ${index + 1} (${JSON.stringify(token)})`;
    const reference = parseMotifReference(token, where);
    const motifTokens = expandMotif(reference, motifs, isDrums, [], where);
    expanded.push(...motifTokens.map(formatPatternToken));
  });
  return expanded.join(' ');
}

function parseChordMidis(noteText: string, where: string): number[] {
  const looksLikeChord = noteText.includes('[') || noteText.includes(']');
  if (looksLikeChord) {
    if (!noteText.startsWith('[') || !noteText.endsWith(']')) {
      throw new ScoreError(`${where}: chord must be written as "[C4,E4,G4]"`);
    }
    const inner = noteText.slice(1, -1).trim();
    if (inner === '') {
      throw new ScoreError(`${where}: chord is empty`);
    }
    const parts = inner.split(',').map((part) => part.trim());
    if (parts.some((part) => part === '')) {
      throw new ScoreError(`${where}: chord notes must be separated by commas, e.g. "[C4,E4,G4]"`);
    }
    if (parts.length > MAX_CHORD_NOTES) {
      throw new ScoreError(
        `${where}: chord has ${parts.length} notes; use at most ${MAX_CHORD_NOTES}`,
      );
    }
    return parts.map((part) => {
      const midi = parseNoteName(part);
      if (midi === undefined || midi < 24 || midi > 108) {
        throw new ScoreError(`${where}: chord note ${JSON.stringify(part)} is outside C1..C8`);
      }
      return midi;
    });
  }

  const midi = parseNoteName(noteText);
  if (midi !== undefined) {
    if (midi < 24 || midi > 108) {
      throw new ScoreError(`${where}: note ${noteText} is outside C1..C8`);
    }
    return [midi];
  }

  const chord = parseChordName(noteText);
  if (chord !== undefined) {
    if (chord.length > MAX_CHORD_NOTES) {
      throw new ScoreError(`${where}: chord ${noteText} has ${chord.length} notes; use at most ${MAX_CHORD_NOTES}`);
    }
    chord.forEach((chordMidi) => {
      if (chordMidi < 24 || chordMidi > 108) {
        throw new ScoreError(`${where}: chord ${noteText} is outside C1..C8`);
      }
    });
    return chord;
  }

  throw new ScoreError(
    `${where}: unknown note ${JSON.stringify(noteText)}; use C4, F#3, Bb2, Cmaj7, Fm/E, [C4,E4,G4], or "-" for a rest`,
  );
}

function parsePattern(
  pattern: string,
  path: string,
  defaultVolume: number,
  isDrums: boolean,
  tuning: Tuning,
  motifs: ReadonlyMap<string, string> = new Map(),
  envelopes: ReadonlyMap<string, Envelope> = new Map(),
  articulations: ReadonlyMap<string, Articulation> = new Map(),
  defaultArticulation?: string,
): ParsedPattern {
  const expanded = expandMotifs(pattern, path, motifs, isDrums);
  const tokens = expanded.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new ScoreError(`${path} is empty; use tokens such as "C4:4 E4:4 -:4"`);
  }

  const events: NoteEvent[] = [];
  let cursor = 0;

  tokens.forEach((token, index) => {
    const where = `${path} token ${index + 1} (${JSON.stringify(token)})`;
    const parsed = parsePatternToken(token, where);
    const { noteText, steps } = parsed;

    if (isRestNote(noteText, isDrums)) {
      if (parsed.volume !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry "@volume"`);
      }
      if (parsed.effect !== 0 || parsed.namedSuffix !== undefined) {
        throw new ScoreError(
          `${where}: a rest cannot carry an effect, articulation, or named envelope`,
        );
      }
      if (parsed.drumEffect !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry a drum effect`);
      }
      if (parsed.drumParams !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry ~pitch, ~decay, or ~tone`);
      }
      if (parsed.offsetMs !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry ~drag or ~push`);
      }
      if (parsed.pan !== undefined || parsed.send !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry ~pan or ~send`);
      }
      cursor += steps;
      return;
    }

    // Rests only advance the cursor, so they can pad a pattern up to the gate
    // ceiling; sounding notes keep the tighter per-note cap.
    if (steps > MAX_STEPS_PER_NOTE) {
      throw new ScoreError(`${where}: duration must be between 1 and ${MAX_STEPS_PER_NOTE} steps`);
    }

    const named = parsed.namedSuffix;
    const articulation =
      named === undefined
        ? defaultArticulation === undefined
          ? undefined
          : articulations.get(defaultArticulation)
        : articulations.get(named);
    const namedEnvelope = named === undefined ? undefined : envelopes.get(named);
    if (named !== undefined && articulation === undefined && namedEnvelope === undefined) {
      throw new ScoreError(
        `${where}: unknown envelope or articulation ${JSON.stringify(named)}; define it in the top-level envelopes or articulations table`,
      );
    }
    if (isDrums && articulation !== undefined) {
      throw new ScoreError(
        `${where}: named articulations are only for melodic tracks; use ~ghost, ~flam, or ~roll for drums`,
      );
    }
    if (isDrums && parsed.effect !== 0) {
      throw new ScoreError(
        `${where}: drum tokens use ~ghost, ~flam, or ~roll, not ~${EFFECT_NAMES[parsed.effect]}`,
      );
    }
    if (!isDrums && parsed.drumEffect !== undefined) {
      throw new ScoreError(`${where}: ~ghost, ~flam, and ~roll are only for drum tracks`);
    }
    if (!isDrums && parsed.drumParams !== undefined) {
      throw new ScoreError(`${where}: ~pitch, ~decay, and ~tone are only for drum tracks`);
    }
    const volume = parsed.volume ?? articulation?.volume ?? defaultVolume;
    const articulatedGate =
      articulation?.gateScale === undefined
        ? undefined
        : Math.min(MAX_GATE_STEPS, Math.max(1, Math.round(steps * articulation.gateScale)));
    const gateSteps = parsed.gateSteps ?? articulatedGate ?? steps;
    const envelope = articulation?.envelope ?? namedEnvelope;
    const effect = parsed.effect !== 0 ? parsed.effect : (articulation?.effect ?? 0);
    const effectParams =
      parsed.effect !== 0 ? parsed.effectParams : articulation?.effectParams;
    const effectFields = {
      effect,
      ...(effectParams === undefined ? {} : { effectParams }),
      ...(parsed.drumEffect === undefined ? {} : { drumEffect: parsed.drumEffect }),
      ...(parsed.drumParams === undefined ? {} : { drumParams: parsed.drumParams }),
      ...(parsed.offsetMs === undefined ? {} : { offsetMs: parsed.offsetMs }),
      ...(parsed.pan === undefined ? {} : { pan: parsed.pan }),
      ...(parsed.send === undefined ? {} : { send: parsed.send }),
      ...(envelope === undefined ? {} : { envelope }),
    };

    if (isDrums) {
      if (noteText.startsWith('[')) {
        throw new ScoreError(
          `${where}: drum chords are not supported; use one hit per step or separate drum tracks`,
        );
      }
      const drum: DrumName | undefined = parseDrumName(noteText);
      if (drum === undefined) {
        const pitched = parseNoteName(noteText);
        throw new ScoreError(
          pitched === undefined
            ? `${where}: unknown drum ${JSON.stringify(noteText)}; use K, S, H, O, C, T, R, or X`
            : `${where}: drum tracks use drum tokens K/S/H/O/C/T/R/X, not pitched notes`,
        );
      }
      const midi = drumMidiOf(drum);
      events.push({
        step: cursor,
        steps,
        midi,
        frequency: frequencyOf(midi, tuning),
        ...effectFields,
        volume,
        drum,
      });
      cursor += steps;
      return;
    }

    const midis = parseChordMidis(noteText, where);
    midis.forEach((midi, voice) => {
      events.push({
        step: cursor,
        steps,
        gateSteps,
        voice,
        midi,
        frequency: frequencyOf(midi, tuning),
        ...effectFields,
        volume,
      });
    });
    cursor += steps;
  });

  if (cursor === 0) {
    throw new ScoreError(`${path} only contains rests; the loop would be silent`);
  }
  return { events, patternSteps: cursor };
}

function parseStringRecord(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object mapping names to strings`);
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ScoreError(`${path}.${key} must be a non-empty string`);
    }
    output[key] = entry.trim();
  }
  return output;
}

function parseNumberRecord(value: unknown, path: string, min: number, max: number): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object mapping names to numbers`);
  }
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = readRequiredNumber(entry, `${path}.${key}`, min, max);
  }
  return output;
}

function parseStringArray(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ScoreError(`${path} must be an array of track names or roles`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ScoreError(`${path}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

/** A section target is either a track's name or its role. */
function validateTrackTargets(
  targets: readonly string[],
  path: string,
  tracks: readonly ScoreTrack[],
): void {
  for (const target of targets) {
    if (!tracks.some((track) => track.name === target || track.role === target)) {
      throw new ScoreError(`${path}: unknown track or role ${JSON.stringify(target)}`);
    }
  }
}

interface ParsedTrack {
  readonly track: ScoreTrack;
  readonly motifs: ReadonlyMap<string, string>;
}

function parseTrackFilter(value: unknown, path: string): TrackFilter | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return {
      cutoffHz: readRequiredNumber(value, path, 100, 20000),
      resonance: 0.707,
      lfoHz: 0,
      lfoDepth: 0,
    };
  }
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be a cutoff number or an object with cutoffHz, resonance, lfoHz, lfoDepth`);
  }
  rejectUnknownKeys(value, ['cutoffHz', 'cutoff', 'resonance', 'q', 'lfoHz', 'lfoDepth'], path);
  return {
    cutoffHz: readRequiredNumber(value.cutoffHz ?? value.cutoff, `${path}.cutoffHz`, 100, 20000),
    resonance: readNumber(value.resonance ?? value.q, `${path}.resonance`, 0.707, MIN_RESONANCE, 20),
    lfoHz: readNumber(value.lfoHz, `${path}.lfoHz`, 0, 0, 20),
    lfoDepth: readNumber(value.lfoDepth, `${path}.lfoDepth`, 0, 0, 4),
  };
}

/**
 * A shelf is `{hz, gainDb}` or a bare gain for the conventional corner
 * (250 Hz low, 4 kHz high). A zero gain is kept as authored; the renderer
 * skips it, so it stays a true no-op.
 */
function parseTrackShelf(value: unknown, path: string, defaultHz: number): TrackShelf | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return { hz: defaultHz, gainDb: readRequiredNumber(value, path, -24, 24) };
  }
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be a gain in dB or an object with hz and gainDb`);
  }
  rejectUnknownKeys(value, ['hz', 'frequency', 'gainDb', 'gain'], path);
  return {
    hz: readNumber(value.hz ?? value.frequency, `${path}.hz`, defaultHz, 20, 20000),
    gainDb: readRequiredNumber(value.gainDb ?? value.gain, `${path}.gainDb`, -24, 24),
  };
}

function parseDelayFollow(value: unknown, path: string): DelayFollow {
  if (value === undefined) return 'base';
  if (value === 'base' || value === 'section') return value;
  throw new ScoreError(`${path} must be "base" or "section", got ${JSON.stringify(value)}`);
}

function parseTrackDelay(value: unknown, path: string): TrackDelay | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with steps, feedback, mix, and follow`);
  }
  rejectUnknownKeys(value, ['steps', 'feedback', 'mix', 'follow'], path);
  return {
    steps: readRequiredNumber(value.steps, `${path}.steps`, 1, 64, true),
    feedback: readNumber(value.feedback, `${path}.feedback`, 0.35, 0, 0.95),
    mix: readNumber(value.mix, `${path}.mix`, 0.4, 0, 1),
    follow: parseDelayFollow(value.follow, `${path}.follow`),
  };
}

interface ParsedTrackSend {
  readonly amount: number;
  readonly bus?: string;
  readonly stereo?: boolean;
}

/**
 * A send is either the legacy numeric amount or `{amount, bus}` when a track
 * should reach a return other than its own group. `stereo: false` keeps the old
 * pre-pan mono feed for callers that need the previous image.
 */
function parseTrackSend(
  value: unknown,
  path: string,
  groups: ReadonlyMap<string, ScoreGroup>,
): ParsedTrackSend {
  if (typeof value === 'number') {
    return { amount: readNumber(value, path, 0, 0, 1) };
  }
  if (!isRecord(value)) {
    throw new ScoreError(
      `${path} must be a number 0-1 or an object with amount, bus, or stereo`,
    );
  }
  rejectUnknownKeys(value, ['amount', 'level', 'bus', 'group', 'to', 'stereo'], path);
  const rawAmount = value.amount ?? value.level;
  if (rawAmount === undefined) {
    throw new ScoreError(`${path}.amount must be a number 0-1`);
  }
  const amount = readNumber(rawAmount, `${path}.amount`, 0, 0, 1);
  const rawBus = value.bus ?? value.group ?? value.to;
  let bus: string | undefined;
  if (rawBus !== undefined) {
    if (typeof rawBus !== 'string' || rawBus.trim() === '') {
      throw new ScoreError(`${path}.bus must name an entry in the top-level groups table`);
    }
    bus = rawBus.trim();
    if (!groups.has(bus)) {
      const available = [...groups.keys()];
      throw new ScoreError(
        `${path}.bus: unknown return ${JSON.stringify(bus)}; define it in the top-level groups table` +
          `${available.length > 0 ? ` (${available.join(', ')})` : ''}`,
      );
    }
  }
  return {
    amount,
    ...(bus === undefined ? {} : { bus }),
    ...(value.stereo === undefined
      ? {}
      : { stereo: readBoolean(value.stereo, `${path}.stereo`, true) }),
  };
}

function parseTrack(
  value: unknown,
  index: number,
  globalMotifs: ReadonlyMap<string, string>,
  globalPatterns: ReadonlyMap<string, string>,
  envelopes: ReadonlyMap<string, Envelope>,
  instruments: ReadonlyMap<string, Instrument>,
  samples: ReadonlyMap<string, SampleSpec>,
  presets: ReadonlyMap<string, SoundPreset>,
  groups: ReadonlyMap<string, ScoreGroup>,
  articulations: ReadonlyMap<string, Articulation>,
  tuning: Tuning,
): ParsedTrack {
  const path = `tracks[${index}]`;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with role, waveform, volume, and pattern`);
  }

  rejectUnknownKeys(
    value,
    [
      'name',
      'role',
      'preset',
      'group',
      'bus',
      'instrument',
      'waveform',
      'volume',
      'envelope',
      'articulation',
      'pan',
      'send',
      'duck',
      'offsetMs',
      'swing',
      'humanize',
      'filter',
      'highpassHz',
      'lowShelf',
      'highShelf',
      'delay',
      'motifs',
      'patterns',
      'pattern',
    ],
    path,
  );
  const role = readString(value.role, `${path}.role`, 'melodic');

  let preset: SoundPreset | undefined;
  if (value.preset !== undefined) {
    if (typeof value.preset !== 'string' || value.preset.trim() === '') {
      throw new ScoreError(`${path}.preset must name an entry in the top-level presets table`);
    }
    const presetName = value.preset.trim();
    preset = presets.get(presetName);
    if (preset === undefined) {
      const available = [...presets.keys()];
      throw new ScoreError(
        `${path}.preset: unknown preset ${JSON.stringify(presetName)}; define it in the top-level presets table` +
          `${available.length > 0 ? ` (${available.join(', ')})` : ''}`,
      );
    }
  }

  const resolved =
    value.instrument !== undefined
      ? resolveTrackInstrument(value.instrument, `${path}.instrument`, instruments, samples)
      : preset?.instrument !== undefined
        ? { isDrums: false, instrument: preset.instrument }
        : { isDrums: false };
  const isDrums = role.toLowerCase() === 'drums' || resolved.isDrums;
  if (preset !== undefined && isDrums) {
    throw new ScoreError(
      `${path}.preset: sound presets are for melodic tracks; use role "drums" and drumSamples for drum voices`,
    );
  }
  const name = readString(value.name, `${path}.name`, `track${index}`);

  if (value.group !== undefined && value.bus !== undefined && value.group !== value.bus) {
    throw new ScoreError(`${path}: group and bus are synonyms; use only one value`);
  }
  const groupValue = value.group ?? value.bus;
  let group: string | undefined;
  if (groupValue !== undefined) {
    if (typeof groupValue !== 'string' || groupValue.trim() === '') {
      throw new ScoreError(`${path}.group must name an entry in the top-level groups table`);
    }
    group = groupValue.trim();
    if (!groups.has(group)) {
      const available = [...groups.keys()];
      throw new ScoreError(
        `${path}.group: unknown group ${JSON.stringify(group)}; define it in the top-level groups table` +
          `${available.length > 0 ? ` (${available.join(', ')})` : ''}`,
      );
    }
  }

  // The legacy `waveform` field stays meaningful for chip instruments and is
  // mirrored from an inline `instrument.waveform`, which is what old scores
  // and sections rely on. Non-chip instruments ignore it.
  // An explicit track.instrument owns its chip waveform; the preset's
  // waveform only fills in when the track names no instrument of its own.
  const presetWaveform = value.waveform ?? (value.instrument === undefined ? preset?.waveform : undefined);
  const waveformValue =
    presetWaveform ?? (resolved.instrument?.type === 'chip' ? resolved.instrument.waveform : undefined);
  const waveform = waveformValue === undefined ? DEFAULTS.waveform : parseWaveform(waveformValue);
  if (waveform === undefined) {
    throw new ScoreError(
      `${path}.waveform: use 0-7 or one of triangle, tilted_saw, saw, square, pulse, organ, noise, phaser`,
    );
  }
  // An explicit track.waveform (or a preset's waveform default) wins over a
  // chip instrument's own waveform, so the legacy field keeps its meaning.
  const instrument =
    resolved.instrument?.type === 'chip' && presetWaveform !== undefined
      ? { ...resolved.instrument, waveform }
      : resolved.instrument;

  const volume =
    value.volume === undefined
      ? (preset?.volume ?? DEFAULTS.volume)
      : readVolume(value.volume, `${path}.volume`, DEFAULTS.volume);
  const envelope =
    value.envelope === undefined
      ? (preset?.envelope ?? DEFAULT_ENVELOPE)
      : parseEnvelope(value.envelope, `${path}.envelope`);
  const pan =
    value.pan === undefined ? (preset?.pan ?? 0) : readNumber(value.pan, `${path}.pan`, 0, -1, 1);
  const parsedSend =
    value.send === undefined
      ? { amount: preset?.send ?? 0 }
      : parseTrackSend(value.send, `${path}.send`, groups);
  const send = parsedSend.amount;
  const duck =
    value.duck === undefined ? (preset?.duck ?? 0) : readNumber(value.duck, `${path}.duck`, 0, 0, 1);
  const offsetMs =
    value.offsetMs === undefined ? undefined : readNumber(value.offsetMs, `${path}.offsetMs`, 0, -200, 200);
  const swing =
    value.swing === undefined ? undefined : readNumber(value.swing, `${path}.swing`, 0, -0.5, 0.5);
  const trackHumanize = parseTrackHumanize(value.humanize, `${path}.humanize`);
  const filter =
    value.filter === undefined ? preset?.filter : parseTrackFilter(value.filter, `${path}.filter`);
  const highpassHz =
    value.highpassHz === undefined
      ? preset?.highpassHz
      : readNumber(value.highpassHz, `${path}.highpassHz`, 20, 20, 4000);
  const lowShelf =
    value.lowShelf === undefined
      ? preset?.lowShelf
      : parseTrackShelf(value.lowShelf, `${path}.lowShelf`, 250);
  const highShelf =
    value.highShelf === undefined
      ? preset?.highShelf
      : parseTrackShelf(value.highShelf, `${path}.highShelf`, 4000);
  const delay =
    value.delay === undefined ? preset?.delay : parseTrackDelay(value.delay, `${path}.delay`);

  let articulationName: string | undefined;
  if (value.articulation !== undefined) {
    if (typeof value.articulation !== 'string' || value.articulation.trim() === '') {
      throw new ScoreError(
        `${path}.articulation must name an entry in the top-level articulations table`,
      );
    }
    articulationName = value.articulation.trim();
  } else {
    articulationName = preset?.articulation;
  }
  if (articulationName !== undefined && !articulations.has(articulationName)) {
    throw new ScoreError(
      `${path}.articulation: unknown articulation ${JSON.stringify(articulationName)}; define it in the top-level articulations table`,
    );
  }
  if (isDrums && articulationName !== undefined) {
    throw new ScoreError(`${path}.articulation: only melodic tracks can use named articulations`);
  }

  const localMotifs = parseStringRecord(value.motifs, `${path}.motifs`);
  const motifs = new Map(globalMotifs);
  for (const [motifName, source] of Object.entries(localMotifs)) {
    motifs.set(motifName, source);
  }

  const patternSources = parseStringRecord(value.patterns, `${path}.patterns`);
  const patterns: Record<string, TrackPattern> = {};
  for (const [patternName, source] of Object.entries(patternSources)) {
    patterns[patternName] = parsePattern(
      source,
      `${path}.patterns.${patternName}`,
      volume,
      isDrums,
      tuning,
      motifs,
      envelopes,
      articulations,
      articulationName,
    );
  }

  let defaultPattern: TrackPattern;
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string') {
      throw new ScoreError(`${path}.pattern must be a string such as "C4:4 E4:4 G4:8"`);
    }
    defaultPattern = resolveTrackPattern(
      value.pattern.trim(),
      `${path}.pattern`,
      patterns,
      globalPatterns,
      volume,
      isDrums,
      tuning,
      motifs,
      envelopes,
      articulations,
      articulationName,
    );
  } else {
    const first = Object.values(patterns)[0];
    if (!first) {
      throw new ScoreError(
        `${path}.pattern must be inline tokens such as "C4:4 E4:4 G4:8" or the name of a pattern defined in tracks[].patterns / top-level patterns`,
      );
    }
    defaultPattern = first;
  }

  return {
    track: {
      name,
      role,
      isDrums,
      waveform,
      ...(group === undefined ? {} : { group }),
      ...(instrument === undefined ? {} : { instrument }),
      volume,
      envelope,
      ...(articulationName === undefined ? {} : { articulation: articulationName }),
      patternSteps: defaultPattern.patternSteps,
      events: defaultPattern.events,
      patterns,
      pan,
      send,
      ...(parsedSend.bus === undefined ? {} : { sendBus: parsedSend.bus }),
      ...(parsedSend.stereo === undefined ? {} : { sendStereo: parsedSend.stereo }),
      duck,
      ...(offsetMs === undefined ? {} : { offsetMs }),
      ...(swing === undefined ? {} : { swing }),
      ...(trackHumanize === undefined ? {} : { humanize: trackHumanize }),
      ...(filter === undefined ? {} : { filter }),
      ...(highpassHz === undefined ? {} : { highpassHz }),
      ...(lowShelf === undefined ? {} : { lowShelf }),
      ...(highShelf === undefined ? {} : { highShelf }),
      ...(delay === undefined ? {} : { delay }),
    },
    motifs,
  };
}

function resolveTrackPattern(
  reference: string,
  where: string,
  localPatterns: Readonly<Record<string, TrackPattern>>,
  globalPatterns: ReadonlyMap<string, string>,
  volume: number,
  isDrums: boolean,
  tuning: Tuning,
  motifs: ReadonlyMap<string, string>,
  envelopes: ReadonlyMap<string, Envelope>,
  articulations: ReadonlyMap<string, Articulation>,
  defaultArticulation?: string,
): TrackPattern {
  const local = localPatterns[reference];
  if (local !== undefined) return local;

  const globalSource = globalPatterns.get(reference);
  if (globalSource !== undefined) {
    return parsePattern(
      globalSource,
      `patterns.${reference}`,
      volume,
      isDrums,
      tuning,
      motifs,
      envelopes,
      articulations,
      defaultArticulation,
    );
  }

  try {
    return parsePattern(
      reference,
      where,
      volume,
      isDrums,
      tuning,
      motifs,
      envelopes,
      articulations,
      defaultArticulation,
    );
  } catch (error) {
    // A bare identifier that is not note-shaped is far more likely a mistyped
    // pattern name than an inline pattern, so report it as a lookup miss.
    const looksInline =
      /[:\s~@[\]/#]/.test(reference) || /^[A-Ga-g][#b]?\d*$/.test(reference);
    if (looksInline) throw error;
    throw new ScoreError(
      `${where}: unknown pattern ${JSON.stringify(reference)}; define it in tracks[].patterns or top-level patterns`,
    );
  }
}

interface ArrangementResult {
  readonly sections: readonly ScoreSection[];
  readonly timelines: readonly (readonly NoteEvent[])[];
  readonly totalSteps: number;
  readonly durationSeconds: number;
}

function parseSectionFilter(value: unknown, path: string): SectionFilter | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return { fromHz: readRequiredNumber(value, path, 100, 20000) };
  }
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be a cutoff number or {"from": 800, "to": 12000}`);
  }
  rejectUnknownKeys(value, ['from', 'fromHz', 'to', 'toHz'], path);
  const from = value.from ?? value.fromHz;
  const to = value.to ?? value.toHz;
  return {
    fromHz: readRequiredNumber(from, `${path}.from`, 100, 20000),
    ...(to === undefined ? {} : { toHz: readRequiredNumber(to, `${path}.to`, 100, 20000) }),
  };
}

const SECTION_TRACK_STATE_KEYS = ['gain', 'pan', 'send', 'mute', 'filter'] as const;

/**
 * Resolves a section's `tracks` table into one state per track name. A key
 * that matches a track name applies only to that track; otherwise it is a role
 * and applies to every track with that role. Track-name entries are applied
 * last, so an explicit name wins over a role entry for the same field.
 */
function parseSectionTrackStates(
  value: unknown,
  path: string,
  tracks: readonly ScoreTrack[],
): Readonly<Record<string, SectionTrackState>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object of track overrides`);
  }

  const entries = Object.entries(value);
  for (const [target] of entries) {
    if (!tracks.some((track) => track.name === target || track.role === target)) {
      throw new ScoreError(`${path}: unknown track or role ${JSON.stringify(target)}`);
    }
  }

  const resolved: Record<string, SectionTrackState> = {};
  const apply = (target: string, rawState: unknown): void => {
    const statePath = `${path}.${target}`;
    if (!isRecord(rawState)) {
      throw new ScoreError(`${statePath} must be an object with gain, pan, send, mute, or filter`);
    }
    rejectUnknownKeys(rawState, [...SECTION_TRACK_STATE_KEYS], statePath);
    const state: SectionTrackState = {
      ...(rawState.gain === undefined
        ? {}
        : { gain: readNumber(rawState.gain, `${statePath}.gain`, 1, 0, 4) }),
      ...(rawState.pan === undefined
        ? {}
        : { pan: readNumber(rawState.pan, `${statePath}.pan`, 0, -1, 1) }),
      ...(rawState.send === undefined
        ? {}
        : { send: readNumber(rawState.send, `${statePath}.send`, 0, 0, 1) }),
      ...(rawState.mute === undefined
        ? {}
        : { mute: readBoolean(rawState.mute, `${statePath}.mute`, false) }),
      ...(rawState.filter === undefined
        ? {}
        : { filter: parseSectionFilter(rawState.filter, `${statePath}.filter`) }),
    };
    const named = tracks.find((track) => track.name === target);
    const matches = named === undefined
      ? tracks.filter((track) => track.role === target)
      : [named];
    for (const track of matches) {
      const existing = resolved[track.name];
      resolved[track.name] = existing === undefined ? state : { ...existing, ...state };
    }
  };

  // Role entries first; explicit track names overwrite them for that track.
  for (const [target, rawState] of entries) {
    if (!tracks.some((track) => track.name === target)) apply(target, rawState);
  }
  for (const [target, rawState] of entries) {
    if (tracks.some((track) => track.name === target)) apply(target, rawState);
  }
  return resolved;
}

interface SectionFill {
  readonly bars: number;
  readonly patterns: Readonly<Record<string, string>>;
}

function parseSectionFill(value: unknown, path: string): SectionFill | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with bars and patterns`);
  }
  rejectUnknownKeys(value, ['bars', 'patterns'], path);
  const bars = readNumber(value.bars, `${path}.bars`, 1, 1, 2, true);
  const patterns = parseStringRecord(value.patterns, `${path}.patterns`);
  if (Object.keys(patterns).length === 0) {
    throw new ScoreError(`${path}.patterns must name at least one track or role`);
  }
  return { bars, patterns };
}

/** Resolves a section/fill pattern reference the same way a track default does. */
function resolvePatternForTrack(
  reference: string,
  where: string,
  track: ScoreTrack,
  cache: Map<string, TrackPattern>,
  globalPatterns: ReadonlyMap<string, string>,
  motifs: ReadonlyMap<string, string>,
  envelopes: ReadonlyMap<string, Envelope>,
  articulations: ReadonlyMap<string, Articulation>,
  tuning: Tuning,
): TrackPattern {
  const local = track.patterns[reference];
  if (local !== undefined) return local;

  const cached = cache.get(reference);
  if (cached !== undefined) return cached;

  const source = globalPatterns.get(reference);
  if (source !== undefined) {
    const pattern = parsePattern(
      source,
      `patterns.${reference}`,
      track.volume,
      track.isDrums,
      tuning,
      motifs,
      envelopes,
      articulations,
      track.articulation,
    );
    cache.set(reference, pattern);
    return pattern;
  }

  const looksInline = /[:\s~@\[\]/]/.test(reference);
  try {
    const pattern = parsePattern(
      reference,
      `${where} (inline)`,
      track.volume,
      track.isDrums,
      tuning,
      motifs,
      envelopes,
      articulations,
      track.articulation,
    );
    cache.set(reference, pattern);
    return pattern;
  } catch (error) {
    if (looksInline) throw error;
    throw new ScoreError(
      `${where}: unknown pattern ${JSON.stringify(reference)} for track ${track.name}; define it in tracks[].patterns or top-level patterns`,
    );
  }
}

interface ResolvedSectionDefaults {
  readonly bpm: number;
  readonly mute: readonly string[];
  readonly gain: number;
  readonly gains: Readonly<Record<string, number>>;
  readonly filter?: SectionFilter;
  readonly energy: number;
  readonly space: number;
  readonly width: number;
  readonly patterns: Readonly<Record<string, string>>;
  readonly trackStates: Readonly<Record<string, SectionTrackState>>;
}

function parseArrangement(
  value: unknown,
  tracks: readonly ScoreTrack[],
  motifMaps: readonly ReadonlyMap<string, string>[],
  stepsPerBar: number,
  stepsPerBeat: number,
  defaultBpm: number,
  inheritSections: boolean,
  globalPatterns: ReadonlyMap<string, string>,
  expectedBars: number | undefined,
  envelopes: ReadonlyMap<string, Envelope>,
  articulations: ReadonlyMap<string, Articulation>,
  warnings: string[],
  tuning: Tuning,
): ArrangementResult {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ScoreError('arrangement must be a non-empty array of sections');
  }
  if (value.length > MAX_SECTIONS) {
    throw new ScoreError(
      `arrangement has ${value.length} sections; use at most ${MAX_SECTIONS} to keep one render bounded`,
    );
  }

  const timelines: NoteEvent[][] = tracks.map(() => []);
  const patternCaches: Map<string, TrackPattern>[] = tracks.map(() => new Map());
  const sections: ScoreSection[] = [];
  let cursor = 0;
  let secondsCursor = 0;
  let previous: ResolvedSectionDefaults | undefined;

  value.forEach((raw, index) => {
    const path = `arrangement[${index}]`;
    if (!isRecord(raw)) {
      throw new ScoreError(
        `${path} must be an object with bars, bpm, patterns, mute, gain, gains, filter, energy, space, width, fill, riser, tracks, or inherit`,
      );
    }
    rejectUnknownKeys(
      raw,
      [
        'name',
        'bars',
        'bpm',
        'mute',
        'gain',
        'gains',
        'filter',
        'patterns',
        'fill',
        'energy',
        'space',
        'width',
        'riser',
        'tracks',
        'inherit',
      ],
      path,
    );

    const name = readString(raw.name, `${path}.name`, `section${index}`);
    const bars = readRequiredNumber(raw.bars, `${path}.bars`, 1, 64, true);
    // Inheritance is opt-in so old scores keep their global defaults. It copies
    // mix and pattern state from the previous section; `fill`, `riser`, `bars`
    // and `name` stay local to the section that declares them.
    const inherit = readBoolean(raw.inherit, `${path}.inherit`, inheritSections);
    const inherited = inherit ? previous : undefined;
    const sectionBpm =
      raw.bpm === undefined && inherited !== undefined
        ? inherited.bpm
        : readNumber(raw.bpm, `${path}.bpm`, defaultBpm, 30, 300);
    const sectionStepSeconds = 60 / sectionBpm / stepsPerBeat;
    const sectionSteps = bars * stepsPerBar;
    const sectionSeconds = sectionSteps * sectionStepSeconds;
    const sectionEnd = cursor + sectionSteps;

    const mute =
      raw.mute === undefined && inherited !== undefined
        ? inherited.mute
        : parseStringArray(raw.mute, `${path}.mute`);
    const gain =
      raw.gain === undefined && inherited !== undefined
        ? inherited.gain
        : readNumber(raw.gain, `${path}.gain`, 1, 0, 4);
    const gains =
      raw.gains === undefined && inherited !== undefined
        ? inherited.gains
        : parseNumberRecord(raw.gains, `${path}.gains`, 0, 4);
    const filter =
      raw.filter === undefined && inherited !== undefined
        ? inherited.filter
        : parseSectionFilter(raw.filter, `${path}.filter`);
    const energy =
      raw.energy === undefined && inherited !== undefined
        ? inherited.energy
        : readNumber(raw.energy, `${path}.energy`, 1, 0, 1);
    // space and width are neutral at 1, so a score without them renders and
    // measures exactly as before. space scales the send bus, not the dry mix.
    const space =
      raw.space === undefined && inherited !== undefined
        ? inherited.space
        : readNumber(raw.space, `${path}.space`, 1, 0, 2);
    const width =
      raw.width === undefined && inherited !== undefined
        ? inherited.width
        : readNumber(raw.width, `${path}.width`, 1, 0, 2);
    const riserBars =
      raw.riser === undefined
        ? undefined
        : readRequiredNumber(raw.riser, `${path}.riser`, 1, 64, true);
    if (riserBars !== undefined && riserBars > bars) {
      throw new ScoreError(
        `${path}.riser covers ${riserBars} bar(s), but the section is only ${bars} bar(s) long`,
      );
    }
    const patternOverrides =
      raw.patterns === undefined && inherited !== undefined
        ? inherited.patterns
        : parseStringRecord(raw.patterns, `${path}.patterns`);
    const trackStates =
      raw.tracks === undefined && inherited !== undefined
        ? inherited.trackStates
        : parseSectionTrackStates(raw.tracks, `${path}.tracks`, tracks);
    validateTrackTargets(Object.keys(patternOverrides), `${path}.patterns`, tracks);
    validateTrackTargets(mute, `${path}.mute`, tracks);
    validateTrackTargets(Object.keys(gains), `${path}.gains`, tracks);
    const fill = parseSectionFill(raw.fill, `${path}.fill`);
    const fillSteps = fill === undefined ? 0 : fill.bars * stepsPerBar;
    if (fill !== undefined && fillSteps > sectionSteps) {
      throw new ScoreError(
        `${path}.fill: ${fill.bars} fill bar(s) do not fit in a ${bars}-bar section`,
      );
    }
    if (fill !== undefined) {
      for (const target of Object.keys(fill.patterns)) {
        if (!tracks.some((track) => track.name === target || track.role === target)) {
          throw new ScoreError(`${path}.fill.patterns: unknown track or role ${JSON.stringify(target)}`);
        }
      }
    }
    const fillStartStep = sectionSteps - fillSteps;
    // energy is a macro: at 0 the section is 6 dB quieter and its filter is
    // about 1.5 octaves lower; at 1 it changes nothing.
    const energyGain = 0.5 + 0.5 * energy;

    tracks.forEach((track, trackIndex) => {
      const state = trackStates[track.name];
      const mutedByList = mute.some((entry) => entry === track.name || entry === track.role);
      // An explicit state wins: `mute: false` can bring one track back while a
      // role or name list mutes the rest of the section.
      const muted = state?.mute === undefined ? mutedByList : state.mute;
      if (muted) return;

      const reference = patternOverrides[track.name] ?? patternOverrides[track.role];
      const cache = patternCaches[trackIndex];
      if (!cache) throw new Error(`missing pattern cache for track ${trackIndex}`);

      const pattern =
        reference === undefined
          ? { patternSteps: track.patternSteps, events: track.events }
          : resolvePatternForTrack(
              reference,
              `${path}.patterns`,
              track,
              cache,
              globalPatterns,
              motifMaps[trackIndex] ?? new Map(),
              envelopes,
              articulations,
              tuning,
            );

      const fillReference = fill?.patterns[track.name] ?? fill?.patterns[track.role];
      const fillPattern =
        fillReference === undefined
          ? undefined
          : resolvePatternForTrack(
              fillReference,
              `${path}.fill.patterns`,
              track,
              cache,
              globalPatterns,
              motifMaps[trackIndex] ?? new Map(),
              envelopes,
              articulations,
              tuning,
            );

      if (sectionSteps % pattern.patternSteps !== 0) {
        warnings.push(
          `pattern-misaligned: ${path} (${name}) uses a ${pattern.patternSteps}-step pattern for track ${track.name}, but the section is ${sectionSteps} steps; its last repetition is truncated and the next section restarts at step 0`,
        );
      }
      if (fillPattern !== undefined && fillSteps % fillPattern.patternSteps !== 0) {
        warnings.push(
          `fill-misaligned: ${path} (${name}) fill uses a ${fillPattern.patternSteps}-step pattern for track ${track.name}, but the fill is ${fillSteps} steps; its last repetition is truncated`,
        );
      }

      // `tracks.<name>.gain` is the modern fader and overrides the legacy
      // `gains` entry for the same track without changing old scores.
      const trackGain =
        gain * (state?.gain ?? gains[track.name] ?? gains[track.role] ?? 1) * energyGain;
      const pushEvent = (event: NoteEvent, localStep: number): void => {
        const slot = Math.min(event.steps, sectionSteps - localStep);
        const gateSteps = Math.min(event.gateSteps ?? event.steps, sectionSteps - localStep);
        if (slot <= 0 || gateSteps <= 0) return;
        timelines[trackIndex]?.push({
          ...event,
          step: cursor + localStep,
          steps: slot,
          gateSteps,
          gain: (event.gain ?? 1) * trackGain,
        });
      };

      for (let repeat = 0; repeat * pattern.patternSteps < sectionSteps; repeat += 1) {
        for (const event of pattern.events) {
          const localStep = event.step + repeat * pattern.patternSteps;
          if (localStep >= sectionSteps) continue;
          // The fill owns its window; the normal pattern hands over completely
          // so the two do not double-hit the same step.
          if (fillPattern !== undefined && localStep >= fillStartStep) continue;
          pushEvent(event, localStep);
        }
      }

      if (fillPattern !== undefined) {
        for (let repeat = 0; repeat * fillPattern.patternSteps < fillSteps; repeat += 1) {
          for (const event of fillPattern.events) {
            const localStep = fillStartStep + event.step + repeat * fillPattern.patternSteps;
            if (localStep >= sectionSteps) continue;
            pushEvent(event, localStep);
          }
        }
      }
    });

    sections.push({
      name,
      startStep: cursor,
      steps: sectionSteps,
      bpm: sectionBpm,
      stepSeconds: sectionStepSeconds,
      startSeconds: secondsCursor,
      durationSeconds: sectionSeconds,
      energy,
      ...(space === 1 ? {} : { space }),
      ...(width === 1 ? {} : { width }),
      ...(filter === undefined ? {} : { filterHz: filter.fromHz }),
      ...(filter?.toHz === undefined ? {} : { filterEndHz: filter.toHz }),
      ...(riserBars === undefined ? {} : { riserBars }),
      ...(Object.keys(trackStates).length === 0 ? {} : { trackStates }),
    });
    previous = {
      bpm: sectionBpm,
      mute,
      gain,
      gains,
      filter,
      energy,
      space,
      width,
      patterns: patternOverrides,
      trackStates,
    };
    cursor = sectionEnd;
    secondsCursor += sectionSeconds;
  });

  if (expectedBars !== undefined && cursor !== expectedBars * stepsPerBar) {
    throw new ScoreError(
      `bars is ${expectedBars} but arrangement totals ${cursor / stepsPerBar} bars; remove bars or make them match`,
    );
  }

  return { sections, timelines, totalSteps: cursor, durationSeconds: secondsCursor };
}

function parseGlobalPatterns(value: unknown): ReadonlyMap<string, string> {
  return new Map(Object.entries(parseStringRecord(value, 'patterns')));
}

const ENVELOPE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function parseEnvelopes(value: unknown): ReadonlyMap<string, Envelope> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError('envelopes must be an object mapping names to ADSR objects');
  }
  const output = new Map<string, Envelope>();
  for (const [name, entry] of Object.entries(value)) {
    if (!ENVELOPE_NAME_RE.test(name)) {
      throw new ScoreError(`envelopes.${name}: names use letters, digits, "_" or "-"`);
    }
    if (
      parseEffect(name) !== undefined ||
      isDrumEffectName(name) ||
      DRUM_PARAM_RE.test(name) ||
      isTimingSuffixName(name) ||
      isSpatialSuffixName(name)
    ) {
      throw new ScoreError(
        `envelopes.${name}: name collides with the ${name} effect; choose another envelope name`,
      );
    }
    output.set(name, parseEnvelope(entry, `envelopes.${name}`));
  }
  return output;
}

/** A named reference is resolved eagerly, so a typo fails before rendering. */
function parseNamedEnvelope(
  value: unknown,
  path: string,
  envelopes: ReadonlyMap<string, Envelope>,
): Envelope | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const name = value.trim();
    const envelope = envelopes.get(name);
    if (envelope === undefined) {
      throw new ScoreError(
        `${path}: unknown envelope ${JSON.stringify(name)}; define it in the top-level envelopes table`,
      );
    }
    return envelope;
  }
  return parseEnvelope(value, path);
}

function parseArticulationEffectParams(
  effect: Effect,
  value: unknown,
  path: string,
): EffectParams | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with the effect's numeric parameters`);
  }
  if (effect === 2) {
    rejectUnknownKeys(value, ['vibratoDepth', 'vibratoRate'], path);
    const depth =
      value.vibratoDepth === undefined
        ? undefined
        : readNumber(value.vibratoDepth, `${path}.vibratoDepth`, 0.5, 0, 2);
    const rate =
      value.vibratoRate === undefined
        ? undefined
        : readNumber(value.vibratoRate, `${path}.vibratoRate`, 7.5, 0.1, 20);
    if (depth === undefined && rate === undefined) return undefined;
    return {
      ...(depth === undefined ? {} : { vibratoDepth: depth }),
      ...(rate === undefined ? {} : { vibratoRate: rate }),
    };
  }
  if (effect === 1) {
    rejectUnknownKeys(value, ['slideSteps'], path);
    if (value.slideSteps === undefined) return undefined;
    return { slideSteps: readNumber(value.slideSteps, `${path}.slideSteps`, 1, 0.05, 8) };
  }
  if (effect === 6 || effect === 7) {
    rejectUnknownKeys(value, ['arpSemitones', 'arpSteps'], path);
    let arpSemitones: readonly number[] | undefined;
    if (value.arpSemitones !== undefined) {
      if (!Array.isArray(value.arpSemitones) || value.arpSemitones.length < 1 || value.arpSemitones.length > 8) {
        throw new ScoreError(`${path}.arpSemitones must be an array of 1-8 integer semitone offsets`);
      }
      arpSemitones = value.arpSemitones.map((entry, index) => {
        const number = readRequiredNumber(entry, `${path}.arpSemitones[${index}]`, -24, 24, true);
        return number;
      });
    }
    const arpSteps =
      value.arpSteps === undefined
        ? undefined
        : readNumber(value.arpSteps, `${path}.arpSteps`, 1, 0.05, 8);
    if (arpSemitones === undefined && arpSteps === undefined) return undefined;
    return {
      ...(arpSemitones === undefined ? {} : { arpSemitones }),
      ...(arpSteps === undefined ? {} : { arpSteps }),
    };
  }
  throw new ScoreError(`${path}: ~${EFFECT_NAMES[effect]} takes no parameters`);
}

/**
 * Named performance shapes. Each one resolves into existing NoteEvent fields,
 * so a score can define spiccato/legato/accent once and reuse it per token.
 */
function parseArticulation(
  value: unknown,
  path: string,
  envelopes: ReadonlyMap<string, Envelope>,
): Articulation {
  if (!isRecord(value)) {
    throw new ScoreError(
      `${path} must be an object with gateScale, volume, envelope, effect, or effectParams`,
    );
  }
  rejectUnknownKeys(value, ['gateScale', 'volume', 'envelope', 'effect', 'effectParams'], path);
  const gateScale =
    value.gateScale === undefined
      ? undefined
      : readNumber(value.gateScale, `${path}.gateScale`, 1, 0.05, 8);
  const volume =
    value.volume === undefined ? undefined : readVolume(value.volume, `${path}.volume`, 5);
  const envelope = parseNamedEnvelope(value.envelope, `${path}.envelope`, envelopes);

  let effect: Effect | undefined;
  let effectParams: EffectParams | undefined;
  if (value.effect !== undefined) {
    if (typeof value.effect !== 'string') {
      throw new ScoreError(`${path}.effect must be one of ${EFFECT_NAMES.slice(1).join(', ')}`);
    }
    effect = parseEffect(value.effect);
    if (effect === undefined || effect === 0) {
      throw new ScoreError(`${path}.effect must be one of ${EFFECT_NAMES.slice(1).join(', ')}`);
    }
    effectParams = parseArticulationEffectParams(effect, value.effectParams, `${path}.effectParams`);
  } else if (value.effectParams !== undefined) {
    throw new ScoreError(`${path}.effectParams requires ${path}.effect`);
  }

  if (
    gateScale === undefined &&
    volume === undefined &&
    envelope === undefined &&
    effect === undefined
  ) {
    throw new ScoreError(
      `${path}: define at least one of gateScale, volume, envelope, or effect`,
    );
  }
  return {
    ...(gateScale === undefined ? {} : { gateScale }),
    ...(volume === undefined ? {} : { volume }),
    ...(envelope === undefined ? {} : { envelope }),
    ...(effect === undefined ? {} : { effect }),
    ...(effectParams === undefined ? {} : { effectParams }),
  };
}

function parseArticulations(
  value: unknown,
  envelopes: ReadonlyMap<string, Envelope>,
): ReadonlyMap<string, Articulation> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError('articulations must be an object mapping names to performance shapes');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ARTICULATIONS) {
    throw new ScoreError(
      `articulations has ${entries.length} entries; use at most ${MAX_ARTICULATIONS}`,
    );
  }
  const output = new Map<string, Articulation>();
  for (const [name, entry] of entries) {
    if (!ENVELOPE_NAME_RE.test(name)) {
      throw new ScoreError(`articulations.${name}: names use letters, digits, "_" or "-"`);
    }
    if (
      parseEffect(name) !== undefined ||
      isDrumEffectName(name) ||
      DRUM_PARAM_RE.test(name) ||
      isTimingSuffixName(name) ||
      isSpatialSuffixName(name)
    ) {
      throw new ScoreError(
        `articulations.${name}: name collides with the ${name} effect; choose another articulation name`,
      );
    }
    if (envelopes.has(name)) {
      throw new ScoreError(
        `articulations.${name}: name collides with an envelope; a ~name can only mean one thing`,
      );
    }
    output.set(name, parseArticulation(entry, `articulations.${name}`, envelopes));
  }
  return output;
}

/**
 * Reusable sound presets: instrument, envelope, default articulation, and the
 * track-level sound fields. Patterns, roles, and post stay outside the preset.
 */
function parseSoundPreset(
  value: unknown,
  path: string,
  instruments: ReadonlyMap<string, Instrument>,
  samples: ReadonlyMap<string, SampleSpec>,
  envelopes: ReadonlyMap<string, Envelope>,
  articulations: ReadonlyMap<string, Articulation>,
): SoundPreset {
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with instrument, envelope, and sound fields`);
  }
  rejectUnknownKeys(
    value,
    [
      'instrument',
      'waveform',
      'envelope',
      'articulation',
      'volume',
      'pan',
      'send',
      'duck',
      'filter',
      'highpassHz',
      'lowShelf',
      'highShelf',
      'delay',
    ],
    path,
  );
  if (Object.keys(value).length === 0) {
    throw new ScoreError(`${path}: define at least one sound field`);
  }

  let instrument: Instrument | undefined;
  if (value.instrument !== undefined) {
    const resolved = resolveTrackInstrument(
      value.instrument,
      `${path}.instrument`,
      instruments,
      samples,
    );
    if (resolved.isDrums) {
      throw new ScoreError(
        `${path}.instrument: presets are melodic; use role "drums" and drumSamples for drum voices`,
      );
    }
    instrument = resolved.instrument;
  }

  let waveform: Waveform | undefined;
  if (value.waveform !== undefined) {
    waveform = parseWaveform(value.waveform);
    if (waveform === undefined) {
      throw new ScoreError(
        `${path}.waveform: use 0-7 or one of triangle, tilted_saw, saw, square, pulse, organ, noise, phaser`,
      );
    }
  }

  const envelope = parseNamedEnvelope(value.envelope, `${path}.envelope`, envelopes);

  let articulation: string | undefined;
  if (value.articulation !== undefined) {
    if (typeof value.articulation !== 'string' || value.articulation.trim() === '') {
      throw new ScoreError(`${path}.articulation must name an entry in the articulations table`);
    }
    articulation = value.articulation.trim();
    if (!articulations.has(articulation)) {
      throw new ScoreError(
        `${path}.articulation: unknown articulation ${JSON.stringify(articulation)}; define it in the top-level articulations table`,
      );
    }
  }

  return {
    ...(instrument === undefined ? {} : { instrument }),
    ...(waveform === undefined ? {} : { waveform }),
    ...(envelope === undefined ? {} : { envelope }),
    ...(articulation === undefined ? {} : { articulation }),
    ...(value.volume === undefined
      ? {}
      : { volume: readVolume(value.volume, `${path}.volume`, 5) }),
    ...(value.pan === undefined
      ? {}
      : { pan: readNumber(value.pan, `${path}.pan`, 0, -1, 1) }),
    ...(value.send === undefined
      ? {}
      : { send: readNumber(value.send, `${path}.send`, 0, 0, 1) }),
    ...(value.duck === undefined
      ? {}
      : { duck: readNumber(value.duck, `${path}.duck`, 0, 0, 1) }),
    ...(value.filter === undefined
      ? {}
      : { filter: parseTrackFilter(value.filter, `${path}.filter`) }),
    ...(value.highpassHz === undefined
      ? {}
      : { highpassHz: readNumber(value.highpassHz, `${path}.highpassHz`, 20, 20, 4000) }),
    ...(value.lowShelf === undefined
      ? {}
      : { lowShelf: parseTrackShelf(value.lowShelf, `${path}.lowShelf`, 250) }),
    ...(value.highShelf === undefined
      ? {}
      : { highShelf: parseTrackShelf(value.highShelf, `${path}.highShelf`, 4000) }),
    ...(value.delay === undefined
      ? {}
      : { delay: parseTrackDelay(value.delay, `${path}.delay`) }),
  };
}

function parsePresets(
  value: unknown,
  instruments: ReadonlyMap<string, Instrument>,
  samples: ReadonlyMap<string, SampleSpec>,
  envelopes: ReadonlyMap<string, Envelope>,
  articulations: ReadonlyMap<string, Articulation>,
): ReadonlyMap<string, SoundPreset> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError('presets must be an object mapping names to sound presets');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PRESETS) {
    throw new ScoreError(`presets has ${entries.length} entries; use at most ${MAX_PRESETS}`);
  }
  const output = new Map<string, SoundPreset>();
  for (const [name, entry] of entries) {
    if (!ENVELOPE_NAME_RE.test(name)) {
      throw new ScoreError(`presets.${name}: names use letters, digits, "_" or "-"`);
    }
    output.set(
      name,
      parseSoundPreset(entry, `presets.${name}`, instruments, samples, envelopes, articulations),
    );
  }
  return output;
}

const SEND_DEFAULT_ROOM = 0.86;
const SEND_DEFAULT_DAMP = 0.4;

function parseSendReverb(value: unknown, path: string): SendReverb {
  if (!isRecord(value)) {
    throw new ScoreError(
      `${path} must be an object with room, damp, predelayMs, lowCutHz, highCutHz, modDepth, or modRateHz`,
    );
  }
  rejectUnknownKeys(
    value,
    ['room', 'damp', 'predelayMs', 'lowCutHz', 'highCutHz', 'modDepth', 'modRateHz'],
    path,
  );
  return {
    room: readNumber(value.room, `${path}.room`, SEND_DEFAULT_ROOM, 0, 0.98),
    damp: readNumber(value.damp, `${path}.damp`, SEND_DEFAULT_DAMP, 0, 1),
    ...(value.predelayMs === undefined
      ? {}
      : { predelayMs: readNumber(value.predelayMs, `${path}.predelayMs`, 0, 0, 200) }),
    ...(value.lowCutHz === undefined
      ? {}
      : { lowCutHz: readNumber(value.lowCutHz, `${path}.lowCutHz`, 20, 20, 1000) }),
    ...(value.highCutHz === undefined
      ? {}
      : { highCutHz: readNumber(value.highCutHz, `${path}.highCutHz`, 20000, 1000, 20000) }),
    ...(value.modDepth === undefined
      ? {}
      : { modDepth: readNumber(value.modDepth, `${path}.modDepth`, 0, 0, 1) }),
    ...(value.modRateHz === undefined
      ? {}
      : { modRateHz: readNumber(value.modRateHz, `${path}.modRateHz`, 0.7, 0.05, 5) }),
  };
}

const GROUP_KEYS = [
  'gain',
  'pan',
  'send',
  'duck',
  'filter',
  'highpassHz',
  'lowShelf',
  'highShelf',
  'delay',
  'saturate',
  'compress',
  'reverb',
  'room',
  'damp',
  'predelayMs',
  'lowCutHz',
  'highCutHz',
  'modDepth',
  'modRateHz',
] as const;
const GROUP_REVERB_KEYS = [
  'room',
  'damp',
  'predelayMs',
  'lowCutHz',
  'highCutHz',
  'modDepth',
  'modRateHz',
] as const;

function parseGroupSaturation(value: unknown, path: string): GroupSaturation {
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with drive and mix; use {} for the defaults`);
  }
  rejectUnknownKeys(value, ['drive', 'mix'], path);
  return {
    drive: readNumber(value.drive, `${path}.drive`, 0.3, 0, 1),
    mix: readNumber(value.mix, `${path}.mix`, 0.5, 0, 1),
  };
}

function parseGroupCompressor(value: unknown, path: string): GroupCompressor {
  if (!isRecord(value)) {
    throw new ScoreError(
      `${path} must be an object with thresholdDb, ratio, attack, release, and makeupDb; use {} for the defaults`,
    );
  }
  rejectUnknownKeys(value, ['thresholdDb', 'ratio', 'attack', 'release', 'makeupDb'], path);
  return {
    thresholdDb: readNumber(value.thresholdDb, `${path}.thresholdDb`, -18, -60, 0),
    ratio: readNumber(value.ratio, `${path}.ratio`, 2, 1, 40),
    attackSeconds: readNumber(value.attack, `${path}.attack`, 0.01, 0.0005, 1),
    releaseSeconds: readNumber(value.release, `${path}.release`, 0.15, 0.01, 2),
    makeupDb: readNumber(value.makeupDb, `${path}.makeupDb`, 0, -12, 24),
  };
}

function parseGroup(value: unknown, name: string, path: string): ScoreGroup {
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with gain, pan, send, filter, saturate, compress, or reverb`);
  }
  rejectUnknownKeys(value, [...GROUP_KEYS], path);
  const directReverbKeys = GROUP_REVERB_KEYS.filter((key) => value[key] !== undefined);
  if (value.reverb !== undefined && directReverbKeys.length > 0) {
    throw new ScoreError(
      `${path}: use either reverb or the direct ${directReverbKeys.join('/')} fields, not both`,
    );
  }
  const directReverb: Record<string, unknown> = {};
  for (const key of directReverbKeys) directReverb[key] = value[key];
  const reverb =
    value.reverb !== undefined
      ? parseSendReverb(value.reverb, `${path}.reverb`)
      : directReverbKeys.length > 0
        ? parseSendReverb(directReverb, path)
        : undefined;
  return {
    name,
    gain: readNumber(value.gain, `${path}.gain`, 1, 0, 4),
    pan: readNumber(value.pan, `${path}.pan`, 0, -1, 1),
    send: readNumber(value.send, `${path}.send`, 0, 0, 1),
    duck: readNumber(value.duck, `${path}.duck`, 0, 0, 1),
    ...(value.filter === undefined
      ? {}
      : { filter: parseTrackFilter(value.filter, `${path}.filter`) }),
    ...(value.highpassHz === undefined
      ? {}
      : { highpassHz: readNumber(value.highpassHz, `${path}.highpassHz`, 20, 20, 4000) }),
    ...(value.lowShelf === undefined
      ? {}
      : { lowShelf: parseTrackShelf(value.lowShelf, `${path}.lowShelf`, 250) }),
    ...(value.highShelf === undefined
      ? {}
      : { highShelf: parseTrackShelf(value.highShelf, `${path}.highShelf`, 4000) }),
    ...(value.delay === undefined
      ? {}
      : { delay: parseTrackDelay(value.delay, `${path}.delay`) }),
    ...(value.saturate === undefined
      ? {}
      : { saturate: parseGroupSaturation(value.saturate, `${path}.saturate`) }),
    ...(value.compress === undefined
      ? {}
      : { compress: parseGroupCompressor(value.compress, `${path}.compress`) }),
    ...(reverb === undefined ? {} : { reverb }),
  };
}

/**
 * Named subgroups. `groups` and `buses` are synonyms; both are object tables
 * keyed by the name tracks reference through `group` (or `bus`).
 */
function parseGroups(value: unknown, path: string): ReadonlyMap<string, ScoreGroup> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object mapping names to group settings`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_GROUPS) {
    throw new ScoreError(`${path} has ${entries.length} entries; use at most ${MAX_GROUPS}`);
  }
  const output = new Map<string, ScoreGroup>();
  for (const [name, entry] of entries) {
    if (!ENVELOPE_NAME_RE.test(name)) {
      throw new ScoreError(`${path}.${name}: names use letters, digits, "_" or "-"`);
    }
    output.set(name, parseGroup(entry, name, `${path}.${name}`));
  }
  return output;
}

function parseHumanize(value: unknown): Humanize {
  if (value === undefined) return { timingMs: 0, velocity: 0 };
  if (!isRecord(value)) {
    throw new ScoreError('humanize must be an object with timingMs and velocity');
  }
  rejectUnknownKeys(value, ['timingMs', 'velocity'], 'humanize');
  return {
    timingMs: readNumber(value.timingMs, 'humanize.timingMs', 0, 0, 150),
    velocity: readNumber(value.velocity, 'humanize.velocity', 0, 0, 1),
  };
}

/** Track overrides keep absent fields absent so the score depth still applies. */
function parseTrackHumanize(value: unknown, path: string): TrackHumanize | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with optional timingMs and velocity`);
  }
  rejectUnknownKeys(value, ['timingMs', 'velocity'], path);
  const timingMs =
    value.timingMs === undefined
      ? undefined
      : readNumber(value.timingMs, `${path}.timingMs`, 0, 0, 150);
  const velocity =
    value.velocity === undefined
      ? undefined
      : readNumber(value.velocity, `${path}.velocity`, 0, 0, 1);
  if (timingMs === undefined && velocity === undefined) return undefined;
  return {
    ...(timingMs === undefined ? {} : { timingMs }),
    ...(velocity === undefined ? {} : { velocity }),
  };
}

/** Temperament spellings a model is likely to emit, normalised to canonical names. */
const TEMPERAMENT_ALIASES: Readonly<Record<string, TemperamentName>> = {
  equal: 'equal',
  'equal-temperament': 'equal',
  '12-tet': 'equal',
  just: 'just',
  'just-intonation': 'just',
  pythagorean: 'pythagorean',
  pythagoras: 'pythagorean',
  meantone: 'meantone',
  'quarter-comma-meantone': 'meantone',
  werckmeister: 'werckmeister3',
  'werckmeister-iii': 'werckmeister3',
  werckmeister3: 'werckmeister3',
  kirnberger: 'kirnberger3',
  'kirnberger-iii': 'kirnberger3',
  kirnberger3: 'kirnberger3',
  young: 'young',
  'young-1799': 'young',
};

function parseTemperament(value: unknown): TemperamentName {
  if (value === undefined) return DEFAULT_TUNING.temperament;
  if (typeof value !== 'string') {
    throw new ScoreError(`tuning.temperament must be a string, got ${JSON.stringify(value)}`);
  }
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const temperament = TEMPERAMENT_ALIASES[key];
  if (temperament === undefined) {
    throw new ScoreError(
      `tuning.temperament must be one of ${TEMPERAMENT_NAMES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return temperament;
}

/**
 * Per-note cent offsets, keyed by note name in the wire format. The normalised
 * form keys by MIDI number so frequencyOf never has to parse a name again.
 */
function parseTuningCents(value: unknown): ReadonlyMap<number, number> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) {
    throw new ScoreError(
      'tuning.cents must be an object mapping note names to cent offsets, e.g. {"C4":2.5}',
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_TUNING_NOTES) {
    throw new ScoreError(
      `tuning.cents has ${entries.length} entries; use at most ${MAX_TUNING_NOTES} (one per MIDI note)`,
    );
  }
  const cents = new Map<number, number>();
  for (const [name, entry] of entries) {
    const midi = parseNoteName(name);
    if (midi === undefined) {
      throw new ScoreError(`tuning.cents.${name}: use a note name such as C4 or F#3`);
    }
    if (midi < 0 || midi > 127) {
      throw new ScoreError(`tuning.cents.${name}: MIDI note ${midi} is outside 0-127`);
    }
    if (cents.has(midi)) {
      throw new ScoreError(
        `tuning.cents.${name}: an enharmonic spelling already tunes MIDI note ${midi}; use one name per key`,
      );
    }
    cents.set(midi, readRequiredNumber(entry, `tuning.cents.${name}`, -100, 100));
  }
  return cents;
}

function parseTuning(value: unknown): Tuning {
  if (value === undefined) return DEFAULT_TUNING;
  if (!isRecord(value)) {
    throw new ScoreError('tuning must be an object with a4, temperament, and cents');
  }
  rejectUnknownKeys(value, ['a4', 'temperament', 'cents'], 'tuning');
  return {
    a4: readNumber(value.a4, 'tuning.a4', DEFAULT_TUNING.a4, 400, 480),
    temperament: parseTemperament(value.temperament),
    cents: parseTuningCents(value.cents),
  };
}

/**
 * Accepts `C`, `C major`, `C maj`, `Am`, `A minor`, `A min` (case-insensitive).
 * The key is a declaration, so a typo should fail loudly rather than be
 * silently dropped: an absent key changes what the report can measure.
 */
const KEY_RE = /^([A-Ga-g])([#b]?)\s*(major|minor|maj|min|m)?$/i;
const KEY_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseKey(value: unknown): ScoreKey | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ScoreError(`key must be a string such as "Am" or "C major", got ${JSON.stringify(value)}`);
  }
  const match = KEY_RE.exec(value.trim());
  if (match === null) {
    throw new ScoreError(
      `key must be a tonic with an optional mode, e.g. "C", "Am", "F# minor"; got ${JSON.stringify(value)}`,
    );
  }
  const letter = (match[1] ?? '').toUpperCase();
  const accidental = match[2] ?? '';
  const quality = (match[3] ?? '').toLowerCase();
  const base = KEY_SEMITONES[letter];
  if (base === undefined) {
    throw new ScoreError(`key ${JSON.stringify(value)}: use a note letter A-G`);
  }
  const shift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const tonic = (((base + shift) % 12) + 12) % 12;
  const mode = quality === 'm' || quality === 'min' || quality === 'minor' ? 'minor' : 'major';
  return { tonic, mode, label: `${letter}${accidental}${mode === 'minor' ? 'm' : ''}` };
}

function parseMode(value: unknown, hasArrangement: boolean): ScoreMode {
  if (value === undefined) return hasArrangement ? 'song' : 'loop';
  if (value === 'song' || value === 'loop') return value;
  throw new ScoreError(`mode must be "loop" or "song", got ${JSON.stringify(value)}`);
}

/**
 * Parses the model-authored JSON score. Accepts the raw string (what a tool
 * call carries) or an already-parsed object.
 */
export function parseScore(input: string | unknown): Score {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ScoreError(`score is not valid JSON: ${reason}`);
    }
  }

  if (!isRecord(raw)) {
    throw new ScoreError('score must be a JSON object');
  }
  rejectUnknownKeys(
    raw,
    [
      'bpm',
      'stepsPerBeat',
      'beatsPerBar',
      'swing',
      'swingUnit',
      'seed',
      'envelopes',
      'articulations',
      'presets',
      'groups',
      'buses',
      'instruments',
      'samples',
      'drumSamples',
      'drumChoke',
      'mode',
      'arrangement',
      'inheritSections',
      'tracks',
      'motifs',
      'patterns',
      'bars',
      'humanize',
      'tuning',
      'key',
      'tail',
    ],
    '',
  );

  const bpm = readNumber(raw.bpm, 'bpm', DEFAULTS.bpm, 30, 300);
  const stepsPerBeat = readNumber(raw.stepsPerBeat, 'stepsPerBeat', DEFAULTS.stepsPerBeat, 1, 24, true);
  const beatsPerBar = readNumber(raw.beatsPerBar, 'beatsPerBar', DEFAULTS.beatsPerBar, 1, 16, true);
  const stepsPerBar = stepsPerBeat * beatsPerBar;
  const swing = readNumber(raw.swing, 'swing', 0, -0.5, 0.5);
  const swingUnit = readNumber(raw.swingUnit, 'swingUnit', 1, 1, stepsPerBeat, true);
  if (stepsPerBeat % swingUnit !== 0) {
    throw new ScoreError(
      `swingUnit must divide stepsPerBeat (${stepsPerBeat}); got ${swingUnit}`,
    );
  }
  const seed = readNumber(raw.seed, 'seed', 0, 0, 2147483647, true);
  const humanize = parseHumanize(raw.humanize);
  const tuning = parseTuning(raw.tuning);
  const key = parseKey(raw.key);
  const tailSeconds = readNumber(raw.tail, 'tail', 0, 0, 30);
  const inheritSections = readBoolean(raw.inheritSections, 'inheritSections', false);
  const envelopes = parseEnvelopes(raw.envelopes);
  const articulations = parseArticulations(raw.articulations, envelopes);
  const samples = parseSamples(raw.samples);
  validateSampleZones(samples);
  const instruments = parseInstruments(raw.instruments, samples);
  const presets = parsePresets(raw.presets, instruments, samples, envelopes, articulations);
  if (raw.groups !== undefined && raw.buses !== undefined) {
    throw new ScoreError('groups and buses are synonyms; define the table once');
  }
  const groups = parseGroups(
    raw.groups ?? raw.buses,
    raw.groups !== undefined ? 'groups' : 'buses',
  );
  const drumSamples = parseDrumSamples(raw.drumSamples, samples);
  const drumChoke = parseDrumChoke(raw.drumChoke);
  const hasArrangement = raw.arrangement !== undefined;
  const mode = parseMode(raw.mode, hasArrangement);

  if (mode === 'song' && !hasArrangement) {
    throw new ScoreError('mode "song" requires an arrangement array');
  }
  if (mode === 'loop' && hasArrangement) {
    throw new ScoreError('arrangement requires mode "song" (or omit mode and bars)');
  }
  if (mode === 'loop' && tailSeconds > 0) {
    throw new ScoreError('tail requires mode "song"; a loop must repeat seamlessly without an end tail');
  }

  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    throw new ScoreError('tracks must be a non-empty array (1-32 tracks)');
  }
  if (raw.tracks.length > MAX_TRACKS) {
    throw new ScoreError(
      `tracks has ${raw.tracks.length} entries; use at most ${MAX_TRACKS} (the render-budget cap, not a musical limit)`,
    );
  }

  const globalMotifs = new Map(Object.entries(parseStringRecord(raw.motifs, 'motifs')));
  const globalPatterns = parseGlobalPatterns(raw.patterns);
  const parsedTracks = raw.tracks.map((track, index) =>
    parseTrack(
      track,
      index,
      globalMotifs,
      globalPatterns,
      envelopes,
      instruments,
      samples,
      presets,
      groups,
      articulations,
      tuning,
    ),
  );
  const baseTracks = parsedTracks.map((entry) => entry.track);
  const motifMaps = parsedTracks.map((entry) => entry.motifs);

  let tracks: readonly ScoreTrack[] = baseTracks;
  let sections: readonly ScoreSection[] = [];
  let totalSteps: number;
  let bars: number;
  let durationSeconds: number;
  const stepSeconds = 60 / bpm / stepsPerBeat;
  const warnings: string[] = [];

  if (mode === 'song') {
    const expectedBars =
      raw.bars === undefined ? undefined : readRequiredNumber(raw.bars, 'bars', 1, 256, true);
    const arrangement = parseArrangement(
      raw.arrangement,
      baseTracks,
      motifMaps,
      stepsPerBar,
      stepsPerBeat,
      bpm,
      inheritSections,
      globalPatterns,
      expectedBars,
      envelopes,
      articulations,
      warnings,
      tuning,
    );
    totalSteps = arrangement.totalSteps;
    bars = totalSteps / stepsPerBar;
    sections = arrangement.sections;
    durationSeconds = arrangement.durationSeconds;
    tracks = baseTracks.map((track, index) => ({
      ...track,
      timeline: arrangement.timelines[index] ?? [],
    }));
  } else {
    bars = readNumber(raw.bars, 'bars', DEFAULTS.bars, 1, 64, true);
    totalSteps = bars * stepsPerBar;
    durationSeconds = totalSteps * stepSeconds;
    baseTracks.forEach((track) => {
      if (track.patternSteps > 0 && totalSteps % track.patternSteps !== 0) {
        warnings.push(
          `pattern-misaligned: track ${track.name} uses a ${track.patternSteps}-step pattern for a ${totalSteps}-step loop; the last repetition is truncated`,
        );
      }
    });
  }

  if (mode === 'song' && sections.some((section) => section.bpm !== bpm)) {
    for (const track of tracks) {
      const delay = track.delay;
      if (delay === undefined || delay.mix <= 0 || delay.follow === 'section') continue;
      // A muted track still has an entry; its timeline is empty, so do not warn
      // about an echo that cannot be heard.
      if (track.timeline !== undefined && track.timeline.length === 0) continue;
      warnings.push(
        `delay-base-tempo: track ${track.name} measures echoes at the base bpm; use delay.follow: "section" to lock them to each section's grid`,
      );
    }
  }

  if (mode === 'song' && sections.some((section) => (section.space ?? 1) !== 1)) {
    // space only scales the send buses; with every send at 0 it cannot be
    // heard at all, which is more likely a mistake than a deliberate choice.
    const sectionSend = sections.some((section) =>
      Object.values(section.trackStates ?? {}).some((state) => (state.send ?? 0) > 0),
    );
    const groupSend = [...groups.values()].some((group) => group.send > 0);
    if (!tracks.some((track) => track.send > 0) && !sectionSend && !groupSend) {
      warnings.push(
        'space-no-send: sections set space but no track or group has a send; space scales the send buses before their reverbs',
      );
    }
  }

  if (durationSeconds + tailSeconds > MAX_SONG_SECONDS) {
    throw new ScoreError(
      `score is ${(durationSeconds + tailSeconds).toFixed(0)} s long including tail; the render budget is ${MAX_SONG_SECONDS} s (15 minutes)`,
    );
  }

  return {
    mode,
    bpm,
    stepsPerBeat,
    beatsPerBar,
    bars,
    totalSteps,
    stepSeconds,
    durationSeconds,
    swing,
    swingUnit,
    seed,
    humanize,
    tuning,
    ...(key === undefined ? {} : { key }),
    tracks,
    groups,
    sections,
    tailSeconds,
    samples,
    drumSamples,
    drumChoke,
    warnings,
  };
}
