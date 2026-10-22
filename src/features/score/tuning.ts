import type { TemperamentName, Tuning } from './types.ts';

// Owns: turning a MIDI note into a frequency under the score's tuning, and the
// built-in temperament tables. The parse step carries the tuning on the Score;
// the renderer only ever sees the resolved frequency on each NoteEvent.
// Does not own: score validation — parse.ts decides which tunings are legal.

/**
 * Historical temperaments are defined as absolute cents above C, often with
 * awkward decimals. Just intonation is cleaner as ratios, so both are reduced
 * to the same shape here: a twelve-entry cents table anchored at A.
 */
const EQUAL_OFFSETS: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** 5-limit just intonation, ratios to C. */
const JUST_RATIOS: readonly number[] = [
  1,
  16 / 15,
  9 / 8,
  6 / 5,
  5 / 4,
  4 / 3,
  45 / 32,
  3 / 2,
  8 / 5,
  5 / 3,
  9 / 5,
  15 / 8,
];

/** Pythagorean chromatic scale, ratios to C. */
const PYTHAGOREAN_RATIOS: readonly number[] = [
  1,
  2187 / 2048,
  9 / 8,
  32 / 27,
  81 / 64,
  4 / 3,
  729 / 512,
  3 / 2,
  6561 / 4096,
  27 / 16,
  16 / 9,
  243 / 128,
];

/** Quarter-comma meantone, cents above C. */
const MEANTONE_CENTS: readonly number[] = [
  0, 76.049, 193.157, 310.265, 386.314, 503.422, 579.471, 696.578, 772.627, 889.735, 1006.843,
  1082.892,
];

/** Werckmeister III, cents above C. */
const WERCKMEISTER3_CENTS: readonly number[] = [
  0, 90.225, 192.18, 294.135, 390.225, 498.045, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18,
];

/** Kirnberger III, cents above C. */
const KIRNBERGER3_CENTS: readonly number[] = [
  0, 90.225, 193.157, 294.135, 386.314, 498.045, 590.224, 696.578, 792.18, 889.735, 996.09,
  1088.269,
];

/** Young's 1799 well-temperament, cents above C. */
const YOUNG_CENTS: readonly number[] = [
  0, 93.9, 195.8, 297.8, 391.7, 499.9, 593.9, 697.9, 795.8, 895.8, 997.8, 1099.8,
];

/**
 * Convert an absolute pitch-class table (cents above C) into equal-temperament
 * offsets anchored at A. Anchoring at A keeps `a4` meaningful: A4 is always
 * exactly the score's reference, and the temperament moves the other classes.
 */
function offsetsFromCents(cents: readonly number[]): readonly number[] {
  const aOffset = (cents[9] ?? 900) - 900;
  return cents.map((value, pitchClass) => value - 100 * pitchClass - aOffset);
}

function offsetsFromRatios(ratios: readonly number[]): readonly number[] {
  return offsetsFromCents(ratios.map((ratio) => 1200 * Math.log2(ratio)));
}

const TEMPERAMENT_OFFSETS: Readonly<Record<TemperamentName, readonly number[]>> = {
  equal: EQUAL_OFFSETS,
  just: offsetsFromRatios(JUST_RATIOS),
  pythagorean: offsetsFromRatios(PYTHAGOREAN_RATIOS),
  meantone: offsetsFromCents(MEANTONE_CENTS),
  werckmeister3: offsetsFromCents(WERCKMEISTER3_CENTS),
  kirnberger3: offsetsFromCents(KIRNBERGER3_CENTS),
  young: offsetsFromCents(YOUNG_CENTS),
};

/** Canonical names in the order the help text and errors list them. */
export const TEMPERAMENT_NAMES: readonly TemperamentName[] = [
  'equal',
  'just',
  'pythagorean',
  'meantone',
  'werckmeister3',
  'kirnberger3',
  'young',
];

export const DEFAULT_TUNING: Tuning = {
  a4: 440,
  temperament: 'equal',
  cents: new Map(),
};

/** Equal-temperament pitch class for a MIDI note, 0 = C. */
function pitchClassOf(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/**
 * Total detune in cents from the score's equal-tempered A4 grid: the
 * temperament's pitch-class offset plus an optional per-note correction.
 */
export function tuningCentsOf(midi: number, tuning: Tuning = DEFAULT_TUNING): number {
  const temperament = TEMPERAMENT_OFFSETS[tuning.temperament];
  return (temperament[pitchClassOf(midi)] ?? 0) + (tuning.cents.get(Math.round(midi)) ?? 0);
}

/**
 * `C4` → 261.63 Hz at A4=440 equal temperament. The tuning shifts the result
 * by its temperament table and the per-note cents map, both relative to A4.
 */
export function frequencyOf(midi: number, tuning: Tuning = DEFAULT_TUNING): number {
  const cents = tuningCentsOf(midi, tuning);
  return tuning.a4 * 2 ** ((midi - 69) / 12 + cents / 1200);
}
