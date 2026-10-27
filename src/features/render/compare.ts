import type { Analysis, AnalysisFacts } from './analyze.ts';

/** One measured value before and after a revision. */
export interface ComparisonRow {
  /** Stable field label, e.g. `peak`, `low-mid`, or `width`. */
  readonly field: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  /** Display unit; absent for ratios such as width and correlation. */
  readonly unit?: string;
  /** Digits after the decimal point in the formatted table. */
  readonly digits: number;
}

/**
 * A delta table, not a score. The measurements come from the same
 * `AnalysisFacts` the two independent summaries print, so comparing two reports
 * cannot disagree with them.
 */
export interface Comparison {
  readonly beforeSeconds: number;
  readonly afterSeconds: number;
  readonly rows: readonly ComparisonRow[];
}

function row(
  field: string,
  before: number,
  after: number,
  digits: number,
  unit?: string,
  scale = 1,
): ComparisonRow {
  const from = before * scale;
  const to = after * scale;
  return {
    field,
    before: from,
    after: to,
    delta: to - from,
    ...(unit === undefined ? {} : { unit }),
    digits,
  };
}

function factsOf(analysis: Analysis): AnalysisFacts {
  return analysis;
}

/**
 * Compares the shared facts of two analyses. Section-level rows are deliberately
 * absent: a revision may move section boundaries, so a matching name is not
 * evidence that the same musical span was measured.
 */
export function compareAnalyses(before: Analysis, after: Analysis): Comparison {
  const a = factsOf(before);
  const b = factsOf(after);
  return {
    beforeSeconds: a.seconds,
    afterSeconds: b.seconds,
    rows: [
      row('peak', a.peakDb, b.peakDb, 1, 'dBFS'),
      row('true-peak', a.truePeakDb, b.truePeakDb, 1, 'dBTP'),
      row('rms', a.rmsDb, b.rmsDb, 1, 'dBFS'),
      row('lufs', a.lufs, b.lufs, 1, 'LUFS'),
      row('lra', a.lra, b.lra, 1, 'LU'),
      row('centroid', a.centroidHz, b.centroidHz, 0, 'Hz'),
      row('low-mid', a.lowMid, b.lowMid, 0, '%', 100),
      row('harsh', a.harsh, b.harsh, 0, '%', 100),
      row('sub', a.bands.sub, b.bands.sub, 0, '%', 100),
      row('low', a.bands.low, b.bands.low, 0, '%', 100),
      row('mid', a.bands.mid, b.bands.mid, 0, '%', 100),
      row('high', a.bands.high, b.bands.high, 0, '%', 100),
      row('air', a.bands.air, b.bands.air, 0, '%', 100),
      row('width', a.width, b.width, 2),
      row('correlation', a.correlation, b.correlation, 2),
      row('balance', a.balanceDb, b.balanceDb, 1, 'dB'),
      row('onsets', a.onsetPerSecond, b.onsetPerSecond, 1, '/s'),
    ],
  };
}

function signed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

/** One line per row so a model can quote a delta without parsing a table. */
export function formatComparison(comparison: Comparison): string {
  const heading =
    `compare ${comparison.beforeSeconds.toFixed(1)} s -> ${comparison.afterSeconds.toFixed(1)} s`;
  const lines = comparison.rows.map((entry) => {
    const unit = entry.unit === undefined ? '' : ` ${entry.unit}`;
    return (
      `compare ${entry.field} ${entry.before.toFixed(entry.digits)} -> ` +
      `${entry.after.toFixed(entry.digits)}${unit} (${signed(entry.delta, entry.digits)})`
    );
  });
  return [heading, ...lines].join('\n');
}
