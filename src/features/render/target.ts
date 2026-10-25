/**
 * Optional target profiles. A profile is a set of ranges, not a score: the
 * report still lists every measurement, and findings name the dimensions that
 * sit outside the declared intent. A score without a target is judged only by
 * the neutral observations in `findingsFor`.
 *
 * Ranges use the report's own units: band shares are 0-1 fractions, `crest`
 * is peak minus RMS in dB, `width` is side/mid RMS, `lufs` is integrated
 * loudness, and `centroidHz` is the magnitude-spectrum centroid.
 */

export type TargetName =
  | 'soft'
  | 'clear'
  | 'punchy'
  | 'bright'
  | 'dark'
  | 'lofi'
  | 'hitech';

export interface TargetProfile {
  /** Maximum 150-500 Hz share, 0-1. */
  readonly lowMidMax?: number;
  /** Maximum 2-5 kHz share, 0-1. */
  readonly harshMax?: number;
  /** Minimum peak-minus-RMS crest, dB. */
  readonly crestMin?: number;
  /** Maximum 4x-oversampled true peak, dBTP. */
  readonly truePeakMax?: number;
  /** Minimum side/mid RMS ratio. */
  readonly width?: readonly [number, number];
  /** Allowed L/R waveform correlation, -1..1. */
  readonly correlation?: readonly [number, number];
  /** Maximum absolute L/R RMS difference, dB. */
  readonly balanceMax?: number;
  /** Integrated loudness range, LUFS. */
  readonly lufs?: readonly [number, number];
  /** Spectrum centroid range, Hz. */
  readonly centroidHz?: readonly [number, number];
}

export type TargetInput = TargetName | TargetProfile;

export interface ResolvedTarget {
  /** Built-in name, or `custom` for an inline object. */
  readonly name: string;
  readonly profile: TargetProfile;
}

const TARGET_FIELDS = new Set([
  'lowMidMax',
  'harshMax',
  'crestMin',
  'truePeakMax',
  'width',
  'correlation',
  'balanceMax',
  'lufs',
  'centroidHz',
]);

/**
 * Built-in intents. They are deliberately loose: a target says "this should
 * feel soft/clear/punchy", not "hit these five numbers". The numbers are the
 * dimensions the report already publishes, so a deviation is explainable.
 */
export const TARGETS: Record<TargetName, TargetProfile> = {
  soft: { lowMidMax: 0.22, harshMax: 0.18, crestMin: 11, width: [0.15, 0.5], lufs: [-18, -12] },
  clear: { lowMidMax: 0.2, harshMax: 0.18, crestMin: 10, width: [0.15, 0.45], lufs: [-16, -11] },
  punchy: { lowMidMax: 0.24, harshMax: 0.22, crestMin: 10, centroidHz: [700, 4500], lufs: [-14, -9] },
  bright: { lowMidMax: 0.2, harshMax: 0.3, centroidHz: [1800, 5000], lufs: [-16, -10] },
  dark: { lowMidMax: 0.3, harshMax: 0.12, centroidHz: [200, 2000], lufs: [-20, -11] },
  lofi: { lowMidMax: 0.3, harshMax: 0.14, width: [0.05, 0.45], lufs: [-20, -12] },
  hitech: { lowMidMax: 0.22, harshMax: 0.25, crestMin: 8, lufs: [-14, -8] },
};

export function isTargetName(value: string): value is TargetName {
  return Object.hasOwn(TARGETS, value);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function fraction(value: unknown, path: string): number {
  const number = finite(value, path);
  if (number < 0 || number > 1) throw new Error(`${path} must be between 0 and 1`);
  return number;
}

function range(value: unknown, path: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${path} must be a [min, max] pair`);
  }
  const min = finite(value[0], `${path}[0]`);
  const max = finite(value[1], `${path}[1]`);
  if (min > max) throw new Error(`${path} min must not exceed max`);
  return [min, max];
}

function rangeIn(
  value: unknown,
  path: string,
  lower: number,
  upper: number,
): readonly [number, number] {
  const pair = range(value, path);
  if (pair[0] < lower || pair[1] > upper) {
    throw new Error(`${path} must stay inside ${lower}..${upper}`);
  }
  return pair;
}

/**
 * Resolves a profile name or an inline object. Unknown fields are rejected so a
 * typo cannot silently produce a target that never checks anything.
 */
export function resolveTarget(input: TargetInput | undefined): ResolvedTarget | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    if (!isTargetName(input)) {
      throw new Error(
        `unknown target ${JSON.stringify(input)}; use ${Object.keys(TARGETS).join(', ')} or an inline object`,
      );
    }
    return { name: input, profile: TARGETS[input] };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('target must be a profile name or an object of ranges');
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TARGET_FIELDS.has(key)) {
      throw new Error(`target.${key} is not a known range; use ${[...TARGET_FIELDS].join(', ')}`);
    }
  }

  const profile: TargetProfile = {
    ...(record.lowMidMax === undefined
      ? {}
      : { lowMidMax: fraction(record.lowMidMax, 'target.lowMidMax') }),
    ...(record.harshMax === undefined
      ? {}
      : { harshMax: fraction(record.harshMax, 'target.harshMax') }),
    ...(record.crestMin === undefined
      ? {}
      : { crestMin: finite(record.crestMin, 'target.crestMin') }),
    ...(record.truePeakMax === undefined
      ? {}
      : { truePeakMax: finite(record.truePeakMax, 'target.truePeakMax') }),
    ...(record.width === undefined ? {} : { width: range(record.width, 'target.width') }),
    ...(record.correlation === undefined
      ? {}
      : { correlation: rangeIn(record.correlation, 'target.correlation', -1, 1) }),
    ...(record.balanceMax === undefined
      ? {}
      : (() => {
          const value = finite(record.balanceMax, 'target.balanceMax');
          if (value < 0) throw new Error('target.balanceMax must be >= 0');
          return { balanceMax: value };
        })()),
    ...(record.lufs === undefined ? {} : { lufs: range(record.lufs, 'target.lufs') }),
    ...(record.centroidHz === undefined
      ? {}
      : { centroidHz: range(record.centroidHz, 'target.centroidHz') }),
  };

  if (Object.keys(profile).length === 0) {
    throw new Error('target must constrain at least one of lowMidMax, harshMax, crestMin, truePeakMax, width, correlation, balanceMax, lufs, centroidHz');
  }
  return { name: 'custom', profile };
}
