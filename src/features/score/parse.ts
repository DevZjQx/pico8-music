import { isChordName, parseChordName } from './chords.ts';
import {
  EFFECT_NAMES,
  drumMidiOf,
  formatNoteName,
  frequencyOf,
  parseDrumName,
  parseEffect,
  parseNoteName,
  parseWaveform,
} from './notes.ts';
import type {
  DrumEffect,
  DrumName,
  DrumParams,
  Effect,
  EffectParams,
  Envelope,
  Humanize,
  Instrument,
  InstrumentFilter,
  InstrumentType,
  NoteEvent,
  Partial,
  SampleSpec,
  Score,
  ScoreMode,
  ScoreSection,
  ScoreTrack,
  TrackDelay,
  TrackFilter,
  TrackPattern,
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

const MAX_STEPS_PER_NOTE = 64;
const MAX_GATE_STEPS = 256;
const MAX_CHORD_NOTES = 4;
/**
 * A render-budget cap, not a musical rule: every track gets its own full-length
 * buffer and one mix pass, so the LLM can decide the arrangement size but a
 * pathological score cannot exhaust memory.
 */
const MAX_TRACKS = 32;
const MAX_INSTRUMENTS = 32;
const MAX_PARTIALS = 16;
const MAX_PARTIAL_DECAY = 8;
const INSTRUMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_INSTRUMENT_NAMES = new Set(['chip', 'fm', 'additive', 'drums']);
/** Song sections are cheap individually but each one can be 64 bars long. */
const MAX_SECTIONS = 256;
/** Hard ceiling for the complete arrangement, before any loop repeats. */
const MAX_SONG_SECONDS = 15 * 60;
/** Sample banks are deliberately small: an LLM should reuse a handful of assets. */
const MAX_SAMPLES = 16;
const SAMPLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

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

function parseEnvelope(value: unknown, path: string): Envelope {
  if (value === undefined) return DEFAULT_ENVELOPE;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with attack, decay, sustain, and release`);
  }
  rejectUnknownKeys(value, ['attack', 'decay', 'sustain', 'release'], path);
  return {
    attack: readNumber(value.attack, `${path}.attack`, DEFAULT_ENVELOPE.attack, 0, 5),
    decay: readNumber(value.decay, `${path}.decay`, DEFAULT_ENVELOPE.decay, 0, 5),
    sustain: readNumber(value.sustain, `${path}.sustain`, DEFAULT_ENVELOPE.sustain, 0, 1),
    release: readNumber(value.release, `${path}.release`, DEFAULT_ENVELOPE.release, 0, 5),
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
    resonance: readNumber(value.resonance ?? value.q, `${path}.resonance`, 0.707, 0.5, 20),
    envAmount: readNumber(value.envAmount, `${path}.envAmount`, 0, 0, 6),
    attack: readNumber(value.attack, `${path}.attack`, 0.002, 0, 2),
    decay: readNumber(value.decay, `${path}.decay`, 0.15, 0, 4),
    sustain: readNumber(value.sustain, `${path}.sustain`, 0.3, 0, 1),
    release: readNumber(value.release, `${path}.release`, 0.15, 0, 4),
  };
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
      'unison',
      'detune',
      'detuneCents',
      'drive',
      'filter',
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
      'unison',
      'detune',
      'detuneCents',
      'drive',
      'filter',
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

  if (type !== 'chip' && value.waveform !== undefined) {
    throw new ScoreError(`${path}.waveform only applies to chip instruments`);
  }
  if (type !== 'additive' && (partials !== undefined || stretch !== undefined || tilt !== undefined)) {
    throw new ScoreError(`${path}.partials, .stretch, and .tilt only apply to additive instruments`);
  }
  if (type !== 'fm' && (ratio !== undefined || fmIndex !== undefined || indexDecay !== undefined)) {
    throw new ScoreError(`${path}.ratio, .index, and .indexDecay only apply to fm instruments`);
  }

  const filter = parseInstrumentFilter(value.filter, `${path}.filter`);
  return {
    type,
    waveform,
    ...(partials === undefined ? {} : { partials }),
    ...(stretch === undefined ? {} : { stretch }),
    ...(tilt === undefined ? {} : { tilt }),
    ...(ratio === undefined ? {} : { ratio }),
    ...(fmIndex === undefined ? {} : { index: fmIndex }),
    ...(indexDecay === undefined ? {} : { indexDecay }),
    unison: readNumber(value.unison, `${path}.unison`, 1, 1, 4, true),
    detuneCents: readNumber(value.detune ?? value.detuneCents, `${path}.detune`, 0, 0, 50),
    drive: readNumber(value.drive, `${path}.drive`, 0, 0, 1),
    ...(filter === undefined ? {} : { filter }),
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

function parseSampleSpec(value: unknown, path: string): SampleSpec {
  if (typeof value === 'string') {
    return { file: parseSampleFile(value, path), rootMidi: 60, loop: false, gain: 1 };
  }
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be a .wav path or an object with file, root, loop, and gain`);
  }
  rejectUnknownKeys(value, ['file', 'root', 'loop', 'gain'], path);
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

  return {
    file,
    rootMidi,
    loop: value.loop === true,
    gain: readNumber(value.gain, `${path}.gain`, 1, 0, 4),
  };
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
  readonly envelopeName?: string;
}

type EffectSuffix =
  | { readonly kind: 'effect'; readonly effect: Effect; readonly params?: EffectParams }
  | { readonly kind: 'drum'; readonly drum: DrumEffect }
  | { readonly kind: 'drumParam'; readonly drumParams: DrumParams }
  | { readonly kind: 'envelope'; readonly name: string };

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

function parseEffectParams(
  effect: Effect,
  argsText: string | undefined,
  where: string,
): EffectParams | undefined {
  if (argsText === undefined) return undefined;

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
    const drum = parseDrumEffectSuffix(name, argsText, where);
    if (drum !== undefined) return { kind: 'drum', drum };
    const drumParams = parseDrumParamSuffix(name, argsText, where);
    if (drumParams !== undefined) return { kind: 'drumParam', drumParams };
    if (argsText !== undefined) {
      throw new ScoreError(`${where}: envelope ${JSON.stringify(name)} takes no parameters`);
    }
    return { kind: 'envelope', name };
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
  let envelopeName: string | undefined;
  let sawEffect = false;
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
    if (envelopeName !== undefined) {
      throw new ScoreError(`${where}: use at most one named envelope suffix`);
    }
    envelopeName = suffix.name;
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
    if (steps < 1 || steps > MAX_STEPS_PER_NOTE) {
      throw new ScoreError(`${where}: duration must be between 1 and ${MAX_STEPS_PER_NOTE} steps`);
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
    ...(envelopeName === undefined ? {} : { envelopeName }),
  };
}

function formatEffectParams(effect: Effect, params: EffectParams): string {
  if (effect === 2) {
    return `(${String(params.vibratoDepth ?? 0.5)},${String(params.vibratoRate ?? 7.5)})`;
  }
  if (effect === 1) {
    return `(${String(params.slideSteps ?? 1)})`;
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

function formatPatternToken(token: PatternToken): string {
  const gate = token.gateSteps === undefined ? '' : `g${token.gateSteps}`;
  const volume = token.volume === undefined ? '' : `@${token.volume}`;
  const params = token.effectParams === undefined ? '' : formatEffectParams(token.effect, token.effectParams);
  const effect = token.effect === 0 ? '' : `~${EFFECT_NAMES[token.effect]}${params}`;
  const drumEffect = formatDrumEffect(token.drumEffect);
  const drumParams = formatDrumParams(token.drumParams);
  const envelope = token.envelopeName === undefined ? '' : `~${token.envelopeName}`;
  return `${token.noteText}:${token.steps}${gate}${volume}${effect}${drumEffect}${drumParams}${envelope}`;
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
  motifs: ReadonlyMap<string, string> = new Map(),
  envelopes: ReadonlyMap<string, Envelope> = new Map(),
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
      if (parsed.drumEffect !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry a drum effect`);
      }
      if (parsed.drumParams !== undefined) {
        throw new ScoreError(`${where}: a rest cannot carry ~pitch, ~decay, or ~tone`);
      }
      cursor += steps;
      return;
    }

    const volume = parsed.volume ?? defaultVolume;
    const gateSteps = parsed.gateSteps ?? steps;
    let envelope: Envelope | undefined;
    if (parsed.envelopeName !== undefined) {
      envelope = envelopes.get(parsed.envelopeName);
      if (envelope === undefined) {
        throw new ScoreError(
          `${where}: unknown envelope ${JSON.stringify(parsed.envelopeName)}; define it in the top-level envelopes table`,
        );
      }
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
    const effectFields = {
      effect: parsed.effect,
      ...(parsed.effectParams === undefined ? {} : { effectParams: parsed.effectParams }),
      ...(parsed.drumEffect === undefined ? {} : { drumEffect: parsed.drumEffect }),
      ...(parsed.drumParams === undefined ? {} : { drumParams: parsed.drumParams }),
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
        frequency: frequencyOf(midi),
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
        frequency: frequencyOf(midi),
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
    output[key] = entry;
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
    resonance: readNumber(value.resonance ?? value.q, `${path}.resonance`, 0.707, 0.5, 20),
    lfoHz: readNumber(value.lfoHz, `${path}.lfoHz`, 0, 0, 20),
    lfoDepth: readNumber(value.lfoDepth, `${path}.lfoDepth`, 0, 0, 4),
  };
}

function parseTrackDelay(value: unknown, path: string): TrackDelay | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with steps, feedback, and mix`);
  }
  rejectUnknownKeys(value, ['steps', 'feedback', 'mix'], path);
  return {
    steps: readRequiredNumber(value.steps, `${path}.steps`, 1, 64, true),
    feedback: readNumber(value.feedback, `${path}.feedback`, 0.35, 0, 0.95),
    mix: readNumber(value.mix, `${path}.mix`, 0.4, 0, 1),
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
      'instrument',
      'waveform',
      'volume',
      'envelope',
      'pan',
      'send',
      'duck',
      'filter',
      'delay',
      'motifs',
      'patterns',
      'pattern',
    ],
    path,
  );
  const role = readString(value.role, `${path}.role`, 'melodic');
  const resolved = resolveTrackInstrument(value.instrument, `${path}.instrument`, instruments, samples);
  const isDrums = role.toLowerCase() === 'drums' || resolved.isDrums;
  const name = readString(value.name, `${path}.name`, `track${index}`);

  // The legacy `waveform` field stays meaningful for chip instruments and is
  // mirrored from an inline `instrument.waveform`, which is what old scores
  // and sections rely on. Non-chip instruments ignore it.
  const waveformValue =
    value.waveform ?? (resolved.instrument?.type === 'chip' ? resolved.instrument.waveform : undefined);
  const waveform = waveformValue === undefined ? DEFAULTS.waveform : parseWaveform(waveformValue);
  if (waveform === undefined) {
    throw new ScoreError(
      `${path}.waveform: use 0-7 or one of triangle, tilted_saw, saw, square, pulse, organ, noise, phaser`,
    );
  }

  const volume = readNumber(value.volume, `${path}.volume`, DEFAULTS.volume, 0, 7);
  const envelope = parseEnvelope(value.envelope, `${path}.envelope`);
  const pan = readNumber(value.pan, `${path}.pan`, 0, -1, 1);
  const send = readNumber(value.send, `${path}.send`, 0, 0, 1);
  const duck = readNumber(value.duck, `${path}.duck`, 0, 0, 1);
  const filter = parseTrackFilter(value.filter, `${path}.filter`);
  const delay = parseTrackDelay(value.delay, `${path}.delay`);

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
      motifs,
      envelopes,
    );
  }

  let defaultPattern: TrackPattern;
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string') {
      throw new ScoreError(`${path}.pattern must be a string such as "C4:4 E4:4 G4:8"`);
    }
    defaultPattern = resolveTrackPattern(
      value.pattern,
      `${path}.pattern`,
      patterns,
      globalPatterns,
      volume,
      isDrums,
      motifs,
      envelopes,
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
      ...(resolved.instrument === undefined ? {} : { instrument: resolved.instrument }),
      volume,
      envelope,
      patternSteps: defaultPattern.patternSteps,
      events: defaultPattern.events,
      patterns,
      pan,
      send,
      duck,
      ...(filter === undefined ? {} : { filter }),
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
  motifs: ReadonlyMap<string, string>,
  envelopes: ReadonlyMap<string, Envelope>,
): TrackPattern {
  const local = localPatterns[reference];
  if (local !== undefined) return local;

  const globalSource = globalPatterns.get(reference);
  if (globalSource !== undefined) {
    return parsePattern(globalSource, `patterns.${reference}`, volume, isDrums, motifs, envelopes);
  }

  try {
    return parsePattern(reference, where, volume, isDrums, motifs, envelopes);
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
}

interface SectionFilter {
  readonly fromHz: number;
  readonly toHz?: number;
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
      motifs,
      envelopes,
    );
    cache.set(reference, pattern);
    return pattern;
  }

  const looksInline = /[:\s~@\[\]/]/.test(reference);
  try {
    const pattern = parsePattern(reference, `${where} (inline)`, track.volume, track.isDrums, motifs, envelopes);
    cache.set(reference, pattern);
    return pattern;
  } catch (error) {
    if (looksInline) throw error;
    throw new ScoreError(
      `${where}: unknown pattern ${JSON.stringify(reference)} for track ${track.name}; define it in tracks[].patterns or top-level patterns`,
    );
  }
}

function parseArrangement(
  value: unknown,
  tracks: readonly ScoreTrack[],
  motifMaps: readonly ReadonlyMap<string, string>[],
  stepsPerBar: number,
  globalPatterns: ReadonlyMap<string, string>,
  expectedBars: number | undefined,
  envelopes: ReadonlyMap<string, Envelope>,
  warnings: string[],
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

  value.forEach((raw, index) => {
    const path = `arrangement[${index}]`;
    if (!isRecord(raw)) {
      throw new ScoreError(
        `${path} must be an object with bars, patterns, mute, gain, filter, energy, fill, or riser`,
      );
    }
    rejectUnknownKeys(
      raw,
      ['name', 'bars', 'mute', 'gain', 'gains', 'filter', 'patterns', 'fill', 'energy', 'riser'],
      path,
    );

    const name = readString(raw.name, `${path}.name`, `section${index}`);
    const bars = readRequiredNumber(raw.bars, `${path}.bars`, 1, 64, true);
    const sectionSteps = bars * stepsPerBar;
    const sectionEnd = cursor + sectionSteps;

    const mute = parseStringArray(raw.mute, `${path}.mute`);
    const gain = readNumber(raw.gain, `${path}.gain`, 1, 0, 4);
    const gains = parseNumberRecord(raw.gains, `${path}.gains`, 0, 4);
    const filter = parseSectionFilter(raw.filter, `${path}.filter`);
    const energy = readNumber(raw.energy, `${path}.energy`, 1, 0, 1);
    const riserBars =
      raw.riser === undefined
        ? undefined
        : readRequiredNumber(raw.riser, `${path}.riser`, 1, 64, true);
    if (riserBars !== undefined && riserBars > bars) {
      throw new ScoreError(
        `${path}.riser covers ${riserBars} bar(s), but the section is only ${bars} bar(s) long`,
      );
    }
    const patternOverrides = parseStringRecord(raw.patterns, `${path}.patterns`);
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
      const muted = mute.some((entry) => entry === track.name || entry === track.role);
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

      const trackGain = gain * (gains[track.name] ?? gains[track.role] ?? 1) * energyGain;
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
      energy,
      ...(filter === undefined ? {} : { filterHz: filter.fromHz }),
      ...(filter?.toHz === undefined ? {} : { filterEndHz: filter.toHz }),
      ...(riserBars === undefined ? {} : { riserBars }),
    });
    cursor = sectionEnd;
  });

  if (expectedBars !== undefined && cursor !== expectedBars * stepsPerBar) {
    throw new ScoreError(
      `bars is ${expectedBars} but arrangement totals ${cursor / stepsPerBar} bars; remove bars or make them match`,
    );
  }

  return { sections, timelines, totalSteps: cursor };
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
    if (parseEffect(name) !== undefined || isDrumEffectName(name) || DRUM_PARAM_RE.test(name)) {
      throw new ScoreError(
        `envelopes.${name}: name collides with the ${name} effect; choose another envelope name`,
      );
    }
    output.set(name, parseEnvelope(entry, `envelopes.${name}`));
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
    timingMs: readNumber(value.timingMs, 'humanize.timingMs', 0, 0, 50),
    velocity: readNumber(value.velocity, 'humanize.velocity', 0, 0, 1),
  };
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
      'seed',
      'envelopes',
      'instruments',
      'samples',
      'drumSamples',
      'mode',
      'arrangement',
      'tracks',
      'motifs',
      'patterns',
      'bars',
      'humanize',
      'tail',
    ],
    '',
  );

  const bpm = readNumber(raw.bpm, 'bpm', DEFAULTS.bpm, 30, 300);
  const stepsPerBeat = readNumber(raw.stepsPerBeat, 'stepsPerBeat', DEFAULTS.stepsPerBeat, 1, 8, true);
  const beatsPerBar = readNumber(raw.beatsPerBar, 'beatsPerBar', DEFAULTS.beatsPerBar, 1, 16, true);
  const stepsPerBar = stepsPerBeat * beatsPerBar;
  const swing = readNumber(raw.swing, 'swing', 0, 0, 0.5);
  const seed = readNumber(raw.seed, 'seed', 0, 0, 2147483647, true);
  const humanize = parseHumanize(raw.humanize);
  const tailSeconds = readNumber(raw.tail, 'tail', 0, 0, 15);
  const envelopes = parseEnvelopes(raw.envelopes);
  const samples = parseSamples(raw.samples);
  const instruments = parseInstruments(raw.instruments, samples);
  const drumSamples = parseDrumSamples(raw.drumSamples, samples);
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
    parseTrack(track, index, globalMotifs, globalPatterns, envelopes, instruments, samples),
  );
  const baseTracks = parsedTracks.map((entry) => entry.track);
  const motifMaps = parsedTracks.map((entry) => entry.motifs);

  let tracks: readonly ScoreTrack[] = baseTracks;
  let sections: readonly ScoreSection[] = [];
  let totalSteps: number;
  let bars: number;
  const warnings: string[] = [];

  if (mode === 'song') {
    const expectedBars =
      raw.bars === undefined ? undefined : readRequiredNumber(raw.bars, 'bars', 1, 256, true);
    const arrangement = parseArrangement(
      raw.arrangement,
      baseTracks,
      motifMaps,
      stepsPerBar,
      globalPatterns,
      expectedBars,
      envelopes,
      warnings,
    );
    totalSteps = arrangement.totalSteps;
    bars = totalSteps / stepsPerBar;
    sections = arrangement.sections;
    tracks = baseTracks.map((track, index) => ({
      ...track,
      timeline: arrangement.timelines[index] ?? [],
    }));
  } else {
    bars = readNumber(raw.bars, 'bars', DEFAULTS.bars, 1, 64, true);
    totalSteps = bars * stepsPerBar;
    baseTracks.forEach((track) => {
      if (track.patternSteps > 0 && totalSteps % track.patternSteps !== 0) {
        warnings.push(
          `pattern-misaligned: track ${track.name} uses a ${track.patternSteps}-step pattern for a ${totalSteps}-step loop; the last repetition is truncated`,
        );
      }
    });
  }

  const stepSeconds = 60 / bpm / stepsPerBeat;
  const durationSeconds = totalSteps * stepSeconds;
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
    seed,
    humanize,
    tracks,
    sections,
    tailSeconds,
    samples,
    drumSamples,
    warnings,
  };
}
