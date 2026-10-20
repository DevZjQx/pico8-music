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
  DrumName,
  Effect,
  EffectParams,
  Envelope,
  NoteEvent,
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
const MAX_TRACKS = 4;
/** Song sections are cheap individually but each one can be 64 bars long. */
const MAX_SECTIONS = 256;
/** Hard ceiling for the complete arrangement, before any loop repeats. */
const MAX_SONG_SECONDS = 15 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return {
    attack: readNumber(value.attack, `${path}.attack`, DEFAULT_ENVELOPE.attack, 0, 5),
    decay: readNumber(value.decay, `${path}.decay`, DEFAULT_ENVELOPE.decay, 0, 5),
    sustain: readNumber(value.sustain, `${path}.sustain`, DEFAULT_ENVELOPE.sustain, 0, 1),
    release: readNumber(value.release, `${path}.release`, DEFAULT_ENVELOPE.release, 0, 5),
  };
}

function parseNoteVolume(text: string, where: string): number {
  if (!/^\d+$/.test(text)) {
    throw new ScoreError(`${where}: volume must be an integer between 0 and 7`);
  }
  const volume = Number.parseInt(text, 10);
  if (volume < 0 || volume > 7) {
    throw new ScoreError(`${where}: volume must be between 0 and 7, got ${volume}`);
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
  readonly envelopeName?: string;
}

type EffectSuffix =
  | { readonly kind: 'effect'; readonly effect: Effect; readonly params?: EffectParams }
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

function formatPatternToken(token: PatternToken): string {
  const gate = token.gateSteps === undefined ? '' : `g${token.gateSteps}`;
  const volume = token.volume === undefined ? '' : `@${token.volume}`;
  const params = token.effectParams === undefined ? '' : formatEffectParams(token.effect, token.effectParams);
  const effect = token.effect === 0 ? '' : `~${EFFECT_NAMES[token.effect]}${params}`;
  const envelope = token.envelopeName === undefined ? '' : `~${token.envelopeName}`;
  return `${token.noteText}:${token.steps}${gate}${volume}${effect}${envelope}`;
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
    const effectFields = {
      effect: parsed.effect,
      ...(parsed.effectParams === undefined ? {} : { effectParams: parsed.effectParams }),
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
): ParsedTrack {
  const path = `tracks[${index}]`;
  if (!isRecord(value)) {
    throw new ScoreError(`${path} must be an object with role, waveform, volume, and pattern`);
  }

  const role = readString(value.role, `${path}.role`, 'melodic');
  const instrument = value.instrument;
  const instrumentType =
    typeof instrument === 'string'
      ? instrument
      : isRecord(instrument) && typeof instrument.type === 'string'
        ? instrument.type
        : undefined;
  const isDrums =
    role.toLowerCase() === 'drums' ||
    (instrumentType !== undefined && instrumentType.toLowerCase() === 'drums');
  const name = readString(value.name, `${path}.name`, `track${index}`);

  const waveformValue =
    value.waveform ?? (isRecord(instrument) ? instrument.waveform : undefined);
  const waveform = waveformValue === undefined ? DEFAULTS.waveform : parseWaveform(waveformValue);
  if (waveform === undefined) {
    throw new ScoreError(
      `${path}.waveform: use 0-7 or one of triangle, tilted_saw, saw, square, pulse, organ, noise, phaser`,
    );
  }

  const volume = readNumber(value.volume, `${path}.volume`, DEFAULTS.volume, 0, 7, true);
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
  const from = value.from ?? value.fromHz;
  const to = value.to ?? value.toHz;
  return {
    fromHz: readRequiredNumber(from, `${path}.from`, 100, 20000),
    ...(to === undefined ? {} : { toHz: readRequiredNumber(to, `${path}.to`, 100, 20000) }),
  };
}

function parseArrangement(
  value: unknown,
  tracks: readonly ScoreTrack[],
  motifMaps: readonly ReadonlyMap<string, string>[],
  stepsPerBeat: number,
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
      throw new ScoreError(`${path} must be an object with bars, patterns, mute, gain, or filter`);
    }

    const name = readString(raw.name, `${path}.name`, `section${index}`);
    const bars = readRequiredNumber(raw.bars, `${path}.bars`, 1, 64, true);
    const sectionSteps = bars * 4 * stepsPerBeat;
    const sectionEnd = cursor + sectionSteps;

    const mute = parseStringArray(raw.mute, `${path}.mute`);
    const gain = readNumber(raw.gain, `${path}.gain`, 1, 0, 4);
    const gains = parseNumberRecord(raw.gains, `${path}.gains`, 0, 4);
    const filter = parseSectionFilter(raw.filter, `${path}.filter`);
    const patternOverrides = parseStringRecord(raw.patterns, `${path}.patterns`);

    tracks.forEach((track, trackIndex) => {
      const muted = mute.some((entry) => entry === track.name || entry === track.role);
      if (muted) return;

      const reference = patternOverrides[track.name] ?? patternOverrides[track.role];
      const cache = patternCaches[trackIndex];
      if (!cache) throw new Error(`missing pattern cache for track ${trackIndex}`);

      let pattern: TrackPattern;
      if (reference === undefined) {
        pattern = { patternSteps: track.patternSteps, events: track.events };
      } else {
        const local = track.patterns[reference];
        if (local) {
          pattern = local;
        } else {
          const cached = cache.get(reference);
          if (cached) {
            pattern = cached;
          } else {
            const source = globalPatterns.get(reference);
            if (source !== undefined) {
              pattern = parsePattern(
                source,
                `patterns.${reference}`,
                track.volume,
                track.isDrums,
                motifMaps[trackIndex],
                envelopes,
              );
              cache.set(reference, pattern);
            } else {
              const looksInline = /[:\s~@\[\]/]/.test(reference);
              try {
                pattern = parsePattern(
                  reference,
                  `${path}.patterns (inline)`,
                  track.volume,
                  track.isDrums,
                  motifMaps[trackIndex],
                  envelopes,
                );
                cache.set(reference, pattern);
              } catch (error) {
                if (looksInline) throw error;
                throw new ScoreError(
                  `${path}.patterns: unknown pattern ${JSON.stringify(reference)} for track ${track.name}; define it in tracks[].patterns or top-level patterns`,
                );
              }
            }
          }
        }
      }

      if (sectionSteps % pattern.patternSteps !== 0) {
        warnings.push(
          `pattern-misaligned: ${path} (${name}) uses a ${pattern.patternSteps}-step pattern for track ${track.name}, but the section is ${sectionSteps} steps; its last repetition is truncated and the next section restarts at step 0`,
        );
      }
      const trackGain = gain * (gains[track.name] ?? gains[track.role] ?? 1);
      for (let repeat = 0; repeat * pattern.patternSteps < sectionSteps; repeat += 1) {
        for (const event of pattern.events) {
          const localStep = event.step + repeat * pattern.patternSteps;
          if (localStep >= sectionSteps) continue;
          const slot = Math.min(event.steps, sectionSteps - localStep);
          const gateSteps = Math.min(event.gateSteps ?? event.steps, sectionSteps - localStep);
          if (slot <= 0 || gateSteps <= 0) continue;
          timelines[trackIndex]?.push({
            ...event,
            step: cursor + localStep,
            steps: slot,
            gateSteps,
            gain: (event.gain ?? 1) * trackGain,
          });
        }
      }
    });

    sections.push({
      name,
      startStep: cursor,
      steps: sectionSteps,
      ...(filter === undefined ? {} : { filterHz: filter.fromHz }),
      ...(filter?.toHz === undefined ? {} : { filterEndHz: filter.toHz }),
    });
    cursor = sectionEnd;
  });

  if (expectedBars !== undefined && cursor !== expectedBars * 4 * stepsPerBeat) {
    throw new ScoreError(
      `bars is ${expectedBars} but arrangement totals ${cursor / (4 * stepsPerBeat)} bars; remove bars or make them match`,
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
    if (parseEffect(name) !== undefined) {
      throw new ScoreError(
        `envelopes.${name}: name collides with the ${name} effect; choose another envelope name`,
      );
    }
    output.set(name, parseEnvelope(entry, `envelopes.${name}`));
  }
  return output;
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

  const bpm = readNumber(raw.bpm, 'bpm', DEFAULTS.bpm, 30, 300);
  const stepsPerBeat = readNumber(raw.stepsPerBeat, 'stepsPerBeat', DEFAULTS.stepsPerBeat, 1, 8, true);
  const swing = readNumber(raw.swing, 'swing', 0, 0, 0.5);
  const seed = readNumber(raw.seed, 'seed', 0, 0, 2147483647, true);
  const envelopes = parseEnvelopes(raw.envelopes);
  const hasArrangement = raw.arrangement !== undefined;
  const mode = parseMode(raw.mode, hasArrangement);

  if (mode === 'song' && !hasArrangement) {
    throw new ScoreError('mode "song" requires an arrangement array');
  }
  if (mode === 'loop' && hasArrangement) {
    throw new ScoreError('arrangement requires mode "song" (or omit mode and bars)');
  }

  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    throw new ScoreError('tracks must be a non-empty array (1-4 tracks)');
  }
  if (raw.tracks.length > MAX_TRACKS) {
    throw new ScoreError(`tracks has ${raw.tracks.length} entries; PICO-8 has 4 channels, use at most 4`);
  }

  const globalMotifs = new Map(Object.entries(parseStringRecord(raw.motifs, 'motifs')));
  const globalPatterns = parseGlobalPatterns(raw.patterns);
  const parsedTracks = raw.tracks.map((track, index) =>
    parseTrack(track, index, globalMotifs, globalPatterns, envelopes),
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
      stepsPerBeat,
      globalPatterns,
      expectedBars,
      envelopes,
      warnings,
    );
    totalSteps = arrangement.totalSteps;
    bars = totalSteps / (4 * stepsPerBeat);
    sections = arrangement.sections;
    tracks = baseTracks.map((track, index) => ({
      ...track,
      timeline: arrangement.timelines[index] ?? [],
    }));
  } else {
    bars = readNumber(raw.bars, 'bars', DEFAULTS.bars, 1, 64, true);
    totalSteps = bars * 4 * stepsPerBeat;
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
  if (durationSeconds > MAX_SONG_SECONDS) {
    throw new ScoreError(
      `score is ${durationSeconds.toFixed(0)} s long; the render budget is ${MAX_SONG_SECONDS} s (15 minutes)`,
    );
  }

  return {
    mode,
    bpm,
    stepsPerBeat,
    bars,
    totalSteps,
    stepSeconds,
    durationSeconds,
    swing,
    seed,
    tracks,
    sections,
    warnings,
  };
}
