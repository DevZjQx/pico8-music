/**
 * Optional hard assertions for a finished render or an existing WAV.
 *
 * `target` names an aesthetic intent and never fails a tool call. An assertion
 * is the opposite: the caller declares ranges that must hold, and the service
 * turns any miss into a tool error before writing a render. Keep this module
 * free of DSP and of the report formatter so both `p8_music` and `p8_analyze`
 * can share one definition and one failure message.
 */

import type { AnalysisFacts } from './analyze.ts';

export type AssertField =
  | 'peak'
  | 'truePeak'
  | 'rms'
  | 'lufs'
  | 'lra'
  | 'crest'
  | 'width'
  | 'correlation'
  | 'balance'
  | 'sectionSpread'
  | 'sectionRms';

export interface AssertionProfile {
  /** Maximum sample peak, dBFS. */
  readonly peakMaxDb?: number;
  /** Maximum 4x-oversampled true peak, dBTP. */
  readonly truePeakMaxDb?: number;
  /** Allowed integrated RMS, dBFS. */
  readonly rmsDb?: readonly [number, number];
  /** Allowed integrated loudness, LUFS. */
  readonly lufs?: readonly [number, number];
  /** Allowed loudness range, LU. */
  readonly lra?: readonly [number, number];
  /** Allowed peak-minus-RMS crest, dB. */
  readonly crest?: readonly [number, number];
  /** Allowed side/mid RMS ratio. */
  readonly width?: readonly [number, number];
  /** Allowed L/R waveform correlation, -1..1. */
  readonly correlation?: readonly [number, number];
  /** Maximum absolute L/R RMS difference, dB. */
  readonly balanceMaxDb?: number;
  /** Allowed max-minus-min section RMS, dB; requires at least two sections. */
  readonly sectionLevelSpreadDb?: readonly [number, number];
  /** Allowed RMS for every measured section, dBFS. */
  readonly sectionRmsDb?: readonly [number, number];
}

export interface AssertionCheck {
  readonly field: AssertField;
  readonly subject?: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly ok: boolean;
  /** Set when the requested measurement is unavailable, e.g. no sections. */
  readonly reason?: string;
}

export interface AssertionReading {
  readonly passed: number;
  readonly total: number;
  readonly checks: readonly AssertionCheck[];
}

const ASSERT_FIELDS = new Set([
  'peakMaxDb',
  'truePeakMaxDb',
  'rmsDb',
  'lufs',
  'lra',
  'crest',
  'width',
  'correlation',
  'balanceMaxDb',
  'sectionLevelSpreadDb',
  'sectionRmsDb',
]);

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
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

/** Reject typos instead of silently accepting an assertion that checks nothing. */
export function resolveAssertions(input: unknown): AssertionProfile | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('assert must be an object of ranges');
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ASSERT_FIELDS.has(key)) {
      throw new Error(`assert.${key} is not a known check; use ${[...ASSERT_FIELDS].join(', ')}`);
    }
  }

  const profile: AssertionProfile = {
    ...(record.peakMaxDb === undefined
      ? {}
      : { peakMaxDb: finite(record.peakMaxDb, 'assert.peakMaxDb') }),
    ...(record.truePeakMaxDb === undefined
      ? {}
      : { truePeakMaxDb: finite(record.truePeakMaxDb, 'assert.truePeakMaxDb') }),
    ...(record.rmsDb === undefined ? {} : { rmsDb: range(record.rmsDb, 'assert.rmsDb') }),
    ...(record.lufs === undefined ? {} : { lufs: range(record.lufs, 'assert.lufs') }),
    ...(record.lra === undefined ? {} : { lra: rangeIn(record.lra, 'assert.lra', 0, 40) }),
    ...(record.crest === undefined ? {} : { crest: range(record.crest, 'assert.crest') }),
    ...(record.width === undefined ? {} : { width: rangeIn(record.width, 'assert.width', 0, 40) }),
    ...(record.correlation === undefined
      ? {}
      : { correlation: rangeIn(record.correlation, 'assert.correlation', -1, 1) }),
    ...(record.balanceMaxDb === undefined
      ? {}
      : (() => {
          const value = finite(record.balanceMaxDb, 'assert.balanceMaxDb');
          if (value < 0) throw new Error('assert.balanceMaxDb must be >= 0');
          return { balanceMaxDb: value };
        })()),
    ...(record.sectionLevelSpreadDb === undefined
      ? {}
      : {
          sectionLevelSpreadDb: range(
            record.sectionLevelSpreadDb,
            'assert.sectionLevelSpreadDb',
          ),
        }),
    ...(record.sectionRmsDb === undefined
      ? {}
      : { sectionRmsDb: range(record.sectionRmsDb, 'assert.sectionRmsDb') }),
  };

  if (Object.keys(profile).length === 0) {
    throw new Error('assert must constrain at least one of the documented checks');
  }
  return profile;
}

function inRange(value: number, min: number | undefined, max: number | undefined): boolean {
  if (!Number.isFinite(value)) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function levelSpread(sections: AnalysisFacts['sections']): number {
  if (sections.length < 2) return Number.NaN;
  const levels = sections.map((section) => section.rmsDb);
  return Math.max(...levels) - Math.min(...levels);
}

/**
 * Applies every declared range to one analysis. The result is also stored in
 * the report, so a passing call documents what it checked and a failing call
 * can name the exact missed dimension.
 */
export function checkAssertions(
  analysis: AnalysisFacts,
  profile: AssertionProfile,
): AssertionReading {
  const checks: AssertionCheck[] = [];
  const add = (
    field: AssertField,
    value: number,
    min: number | undefined,
    max: number | undefined,
    options: { readonly subject?: string; readonly reason?: string } = {},
  ): void => {
    checks.push({
      field,
      value,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ok: options.reason === undefined && inRange(value, min, max),
    });
  };

  if (profile.peakMaxDb !== undefined) {
    add('peak', analysis.peakDb, undefined, profile.peakMaxDb);
  }
  if (profile.truePeakMaxDb !== undefined) {
    add('truePeak', analysis.truePeakDb, undefined, profile.truePeakMaxDb);
  }
  if (profile.rmsDb !== undefined) {
    add('rms', analysis.rmsDb, profile.rmsDb[0], profile.rmsDb[1]);
  }
  if (profile.lufs !== undefined) {
    add('lufs', analysis.lufs, profile.lufs[0], profile.lufs[1]);
  }
  if (profile.lra !== undefined) {
    add('lra', analysis.lra, profile.lra[0], profile.lra[1]);
  }
  if (profile.crest !== undefined) {
    add('crest', analysis.peakDb - analysis.rmsDb, profile.crest[0], profile.crest[1]);
  }
  if (profile.width !== undefined) {
    add('width', analysis.width, profile.width[0], profile.width[1]);
  }
  if (profile.correlation !== undefined) {
    add('correlation', analysis.correlation, profile.correlation[0], profile.correlation[1]);
  }
  if (profile.balanceMaxDb !== undefined) {
    add('balance', Math.abs(analysis.balanceDb), undefined, profile.balanceMaxDb);
  }
  if (profile.sectionLevelSpreadDb !== undefined) {
    add(
      'sectionSpread',
      levelSpread(analysis.sections),
      profile.sectionLevelSpreadDb[0],
      profile.sectionLevelSpreadDb[1],
      analysis.sections.length < 2
        ? { reason: 'requires at least two measured sections' }
        : {},
    );
  }
  if (profile.sectionRmsDb !== undefined) {
    if (analysis.sections.length === 0) {
      add('sectionRms', Number.NaN, profile.sectionRmsDb[0], profile.sectionRmsDb[1], {
        reason: 'no sections were measured; pass sections or render a song with an arrangement',
      });
    } else {
      for (const section of analysis.sections) {
        add(
          'sectionRms',
          section.rmsDb,
          profile.sectionRmsDb[0],
          profile.sectionRmsDb[1],
          { subject: section.name },
        );
      }
    }
  }

  return {
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
    checks,
  };
}

const FIELD_UNITS: Record<AssertField, string> = {
  peak: 'dBFS',
  truePeak: 'dBTP',
  rms: 'dBFS',
  lufs: 'LUFS',
  lra: 'LU',
  crest: 'dB',
  width: '',
  correlation: '',
  balance: 'dB',
  sectionSpread: 'dB',
  sectionRms: 'dBFS',
};

const FIELD_DIGITS: Record<AssertField, number> = {
  peak: 1,
  truePeak: 1,
  rms: 1,
  lufs: 1,
  lra: 1,
  crest: 1,
  width: 2,
  correlation: 2,
  balance: 1,
  sectionSpread: 1,
  sectionRms: 1,
};

function formatValue(value: number, field: AssertField): string {
  if (!Number.isFinite(value)) return 'unavailable';
  return `${value.toFixed(FIELD_DIGITS[field])}${FIELD_UNITS[field] === '' ? '' : ` ${FIELD_UNITS[field]}`}`;
}

function formatBound(value: number | undefined, field: AssertField): string {
  if (value === undefined) return '';
  return `${value.toFixed(FIELD_DIGITS[field])}${FIELD_UNITS[field] === '' ? '' : ` ${FIELD_UNITS[field]}`}`;
}

/** One-line explanation used by both the report and the thrown error. */
export function formatAssertionCheck(check: AssertionCheck): string {
  const subject = check.subject === undefined ? '' : ` ${check.subject}`;
  if (check.reason !== undefined) return `${check.field}${subject}: ${check.reason}`;
  const bounds =
    check.min !== undefined && check.max !== undefined
      ? `${formatBound(check.min, check.field)}..${formatBound(check.max, check.field)}`
      : check.max !== undefined
        ? `max ${formatBound(check.max, check.field)}`
        : `min ${formatBound(check.min, check.field)}`;
  return `${check.field}${subject} ${formatValue(check.value, check.field)} is outside ${bounds}`;
}

/** `report assert` summary; the service appends the failing checks when any. */
export function formatAssertionLine(reading: AssertionReading): string {
  const failures = reading.checks.filter((check) => !check.ok).map(formatAssertionCheck);
  if (failures.length === 0) return `report assert ${reading.passed}/${reading.total} checks passed`;
  return `report assert ${reading.passed}/${reading.total} checks passed · failed: ${failures.join('; ')}`;
}
