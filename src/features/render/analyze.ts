/**
 * Render report: the measurements the model needs to judge its own output.
 *
 * The final mix is computed from the finished stereo buffer (after the post and
 * master chain), so those numbers describe what the WAV actually sounds like.
 * Stem summaries and the pre-post snapshot reuse the same primitives on their
 * own buffers, which is what makes attribution possible. Spectrum and onset
 * figures use fixed windows; peak, RMS, width, and loudness use every sample.
 * See docs/evaluation.md and docs/analysis-roadmap.md for the dimensions.
 */

import { MAX_SAFE_LUFS, loudnessSummary } from './loudness.ts';
import { resolveTarget, type ResolvedTarget, type TargetInput, type TargetProfile } from './target.ts';

export interface BandEnergy {
  /** 20-60 Hz, as a fraction of the measured spectrum. */
  readonly sub: number;
  /** 60-250 Hz. */
  readonly low: number;
  /** 250 Hz-2 kHz. */
  readonly mid: number;
  /** 2-8 kHz. */
  readonly high: number;
  /** 8-16 kHz. */
  readonly air: number;
}

export interface SectionReading {
  readonly name: string;
  readonly rmsDb: number;
  /** Side/mid RMS ratio inside the section; 0 is mono, matching the mix width. */
  readonly width: number;
  /** Spectral centroid inside the section; the brightness proxy for distance. */
  readonly centroidHz: number;
  /** Transient density inside the section; the density proxy for energy. */
  readonly onsetPerSecond: number;
}

/** Measurements shared by the final mix and the pre-post snapshot. */
export interface AnalysisFacts {
  readonly seconds: number;
  readonly peakDb: number;
  readonly rmsDb: number;
  /** Integrated loudness in LUFS; -Infinity for silence. */
  readonly lufs: number;
  /**
   * Loudness range in LU (EBU Tech 3342): how far the short-term loudness
   * travels between the quiet 10% and the loud 95% of the song. 0 for a steady
   * loop, silence, or a buffer too short to measure.
   */
  readonly lra: number;
  readonly centroidHz: number;
  readonly bands: BandEnergy;
  /** 150-500 Hz share of the same spectrum; overlaps `low` and `mid`. */
  readonly lowMid: number;
  /** 2-5 kHz share of the same spectrum; a diagnostic subset of `high`. */
  readonly harsh: number;
  /** Side/mid RMS ratio: 0 is mono, 1 is a hard-panned source. */
  readonly width: number;
  readonly onsetPerSecond: number;
  readonly sections: readonly SectionReading[];
}

/** One track measured before pan/sum; only the summary is retained. */
export interface StemReading {
  readonly name: string;
  readonly role: string;
  readonly rmsDb: number;
  readonly peakDb: number;
  readonly centroidHz: number;
  readonly bands: BandEnergy;
  readonly lowMid: number;
  readonly harsh: number;
  readonly onsetPerSecond: number;
  readonly pan: number;
  readonly send: number;
  /** Chip pulse/saw/organ whose highest note is at or above C6. */
  readonly aliasRisk: boolean;
}

export type FindingKind =
  | 'alias-risk'
  | 'sub-heavy'
  | 'mud'
  | 'masking'
  | 'harsh'
  | 'dynamics'
  | 'loudness-flat'
  | 'post-mud'
  | 'post-harsh'
  | 'post-dynamics'
  | 'target';

/** One dimension against the declared target; `ok` is a range check, not a score. */
export interface TargetCheck {
  readonly field: 'lowMid' | 'harsh' | 'crest' | 'width' | 'lufs' | 'centroidHz';
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly ok: boolean;
}

export interface TargetReading {
  readonly name: string;
  readonly passed: number;
  readonly total: number;
  readonly checks: readonly TargetCheck[];
}

/**
 * One diagnostic observation. Findings are not pass/fail gates: they name a
 * symptom, attribute it when stems/dry data are available, and suggest a knob.
 */
export interface Finding {
  readonly kind: FindingKind;
  readonly message: string;
  readonly attribution?: string;
  readonly next?: string;
}

export interface Analysis extends AnalysisFacts {
  /** Per-track summaries; present on renders, absent when re-reading a WAV. */
  readonly stems?: readonly StemReading[];
  /** Pre-post-chain facts; present on renders, absent when re-reading a WAV. */
  readonly dry?: AnalysisFacts;
  readonly findings: readonly Finding[];
  readonly warnings: readonly string[];
  /** Present only when the caller supplied a target profile. */
  readonly target?: TargetReading;
}

export interface AnalysisOptions {
  readonly sections?: readonly SectionReading[];
  /** Extra warnings from the render stage, e.g. a safety-net trim. */
  readonly extraWarnings?: readonly string[];
  readonly stems?: readonly StemReading[];
  /** Pre-post facts, used to separate arrangement from post processing. */
  readonly dry?: AnalysisFacts;
  /** Optional target name or inline ranges. */
  readonly target?: TargetInput;
}

const SILENCE_DB = -120;
const SPECTRUM_FRAME = 2048;
const MAX_SPECTRUM_FRAMES = 48;
/** Sections are short; eight frames keep a 256-section report cheap. */
const SECTION_SPECTRUM_FRAMES = 8;
const ONSET_HOP = 512;
/** A frame must rise by this much (linear RMS) to count as an onset. */
const ONSET_RISE = 0.015;
const ONSET_FLOOR = 0.02;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function dbOf(value: number): number {
  return value <= 0 ? SILENCE_DB : Math.max(SILENCE_DB, 20 * Math.log10(value));
}

/** In-place iterative radix-2 FFT; `n` must be a power of two. */
function fft(real: Float64Array, imaginary: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const realSwap = real[i] ?? 0;
      real[i] = real[j] ?? 0;
      real[j] = realSwap;
      const imaginarySwap = imaginary[i] ?? 0;
      imaginary[i] = imaginary[j] ?? 0;
      imaginary[j] = imaginarySwap;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const evenReal = real[start + offset] ?? 0;
        const evenImaginary = imaginary[start + offset] ?? 0;
        const oddIndex = start + offset + length / 2;
        const oddReal = real[oddIndex] ?? 0;
        const oddImaginary = imaginary[oddIndex] ?? 0;
        const rotatedReal = oddReal * twiddleReal - oddImaginary * twiddleImaginary;
        const rotatedImaginary = oddReal * twiddleImaginary + oddImaginary * twiddleReal;
        real[start + offset] = evenReal + rotatedReal;
        imaginary[start + offset] = evenImaginary + rotatedImaginary;
        real[oddIndex] = evenReal - rotatedReal;
        imaginary[oddIndex] = evenImaginary - rotatedImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

interface SpectrumReading {
  readonly centroidHz: number;
  readonly bands: BandEnergy;
  readonly lowMid: number;
  readonly harsh: number;
}

/**
 * Averages the magnitude spectrum of evenly spaced frames. Magnitude, not
 * power, is the right weighting here: a drum loop's hats carry little energy
 * but they are exactly the content the "dark" warning is about, and power
 * weighting lets a loud kick hide them. The frame size adapts to short loops;
 * the frame count is capped so a long song does not turn the report into a
 * second render.
 */
function readSpectrum(
  mono: Float32Array,
  rate: number,
  maxFrames = MAX_SPECTRUM_FRAMES,
): SpectrumReading {
  const length = mono.length;
  if (length < 64) {
    return {
      centroidHz: 0,
      bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 },
      lowMid: 0,
      harsh: 0,
    };
  }

  const size = Math.min(SPECTRUM_FRAME, 2 ** Math.floor(Math.log2(length)));
  const hop = Math.max(1, size >> 1);
  const frames = Math.max(1, Math.floor((length - size) / hop) + 1);
  const stride = Math.max(1, Math.ceil(frames / maxFrames));
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);

  const magnitude = new Float64Array(size / 2);
  let frameCount = 0;

  for (let frame = 0; frame < frames; frame += stride) {
    const start = frame * hop;
    const real = new Float64Array(size);
    const imaginary = new Float64Array(size);
    for (let i = 0; i < size; i += 1) real[i] = (mono[start + i] ?? 0) * (window[i] ?? 0);
    fft(real, imaginary);
    for (let bin = 1; bin < size / 2; bin += 1) {
      const re = real[bin] ?? 0;
      const im = imaginary[bin] ?? 0;
      magnitude[bin] = (magnitude[bin] ?? 0) + Math.sqrt(re * re + im * im);
    }
    frameCount += 1;
  }

  const binHz = rate / size;
  const edges = {
    sub: [20, 60],
    low: [60, 250],
    mid: [250, 2000],
    high: [2000, 8000],
    air: [8000, 16000],
  } as const;

  const sums = { sub: 0, low: 0, mid: 0, high: 0, air: 0 };
  let lowMidSum = 0;
  let harshSum = 0;
  let weighted = 0;
  let total = 0;

  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = bin * binHz;
    if (frequency < 20 || frequency >= 16000) continue;
    const binMagnitude = magnitude[bin] ?? 0;
    total += binMagnitude;
    weighted += frequency * binMagnitude;
    // These two are diagnostic shares, not additional disjoint bands: low-mid
    // overlaps low/mid, and presence is a subset of high. Keeping them out of
    // `bands` means the five published shares still sum to one.
    if (frequency >= 150 && frequency < 500) lowMidSum += binMagnitude;
    if (frequency >= 2000 && frequency < 5000) harshSum += binMagnitude;
    for (const [band, [from, to]] of Object.entries(edges) as [keyof typeof sums, readonly [number, number]][]) {
      if (frequency >= from && frequency < to) {
        sums[band] += binMagnitude;
        break;
      }
    }
  }

  if (total <= 0 || frameCount === 0) {
    return {
      centroidHz: 0,
      bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 },
      lowMid: 0,
      harsh: 0,
    };
  }

  return {
    centroidHz: weighted / total,
    bands: {
      sub: sums.sub / total,
      low: sums.low / total,
      mid: sums.mid / total,
      high: sums.high / total,
      air: sums.air / total,
    },
    lowMid: lowMidSum / total,
    harsh: harshSum / total,
  };
}

/** Counts RMS rises: one sharp transient per onset, none for a sustained tone. */
function countOnsets(mono: Float32Array): number {
  let count = 0;
  let previous = 0;
  for (let start = 0; start < mono.length; start += ONSET_HOP) {
    const end = Math.min(mono.length, start + ONSET_HOP);
    let squares = 0;
    for (let i = start; i < end; i += 1) squares += (mono[i] ?? 0) ** 2;
    const rms = Math.sqrt(squares / Math.max(1, end - start));
    if (start > 0 && rms > ONSET_FLOOR && rms - previous > ONSET_RISE) count += 1;
    previous = rms;
  }
  return count;
}

export interface StemOptions {
  readonly name: string;
  readonly role: string;
  readonly pan: number;
  readonly send: number;
  readonly aliasRisk: boolean;
}

/**
 * Measures one track buffer before pan/sum. This is what makes attribution
 * possible: the final mix cannot say which track owns the low-mid energy. No
 * audio is returned or retained, so 32 tracks stay O(one track) in memory.
 */
export function analyseStem(
  mono: Float32Array,
  rate: number,
  options: StemOptions,
): StemReading {
  const seconds = mono.length / rate;
  const spectrum = readSpectrum(mono, rate);
  let peak = 0;
  let squares = 0;
  for (let i = 0; i < mono.length; i += 1) {
    const value = mono[i] ?? 0;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    squares += value * value;
  }
  return {
    name: options.name,
    role: options.role,
    rmsDb: dbOf(Math.sqrt(squares / Math.max(1, mono.length))),
    peakDb: dbOf(peak),
    centroidHz: spectrum.centroidHz,
    bands: spectrum.bands,
    lowMid: spectrum.lowMid,
    harsh: spectrum.harsh,
    onsetPerSecond: seconds > 0 ? countOnsets(mono) / seconds : 0,
    pan: options.pan,
    send: options.send,
    aliasRisk: options.aliasRisk,
  };
}

function mixed(left: Float32Array, right: Float32Array): Float32Array {
  const output = new Float32Array(Math.min(left.length, right.length));
  for (let i = 0; i < output.length; i += 1) {
    output[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
  }
  return output;
}

function rmsOf(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let squares = 0;
  for (let i = 0; i < length; i += 1) {
    squares += (left[i] ?? 0) ** 2 + (right[i] ?? 0) ** 2;
  }
  return Math.sqrt(squares / (length * 2));
}

function peakOf(left: Float32Array, right: Float32Array): number {
  let peak = 0;
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

function widthFromSquares(midSquares: number, sideSquares: number): number {
  if (midSquares <= 1e-12) return 0;
  return Math.sqrt(sideSquares / midSquares);
}

function widthOf(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let midSquares = 0;
  let sideSquares = 0;
  for (let i = 0; i < length; i += 1) {
    const mid = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
    const side = ((left[i] ?? 0) - (right[i] ?? 0)) * 0.5;
    midSquares += mid * mid;
    sideSquares += side * side;
  }
  return widthFromSquares(midSquares, sideSquares);
}

/**
 * Per-section readings from absolute time bounds. Sections are fractions of
 * the musical timeline, so they survive tape/slow resampling unchanged even
 * when earlier sections run at a different tempo. Level, width, brightness,
 * and onset density are measured separately: an energy arc can move any one of
 * them without moving the others, so a single RMS number cannot describe it.
 */
export function sectionReadings(
  left: Float32Array,
  right: Float32Array,
  sections: readonly {
    readonly name: string;
    readonly startSeconds: number;
    readonly durationSeconds: number;
  }[],
  totalSeconds: number,
  rate: number,
  /** Musical content length; excludes a song tail when it is shorter than the buffer. */
  contentSamples?: number,
): SectionReading[] {
  const available = Math.min(left.length, right.length);
  if (sections.length === 0 || totalSeconds <= 0 || available === 0) return [];
  const length =
    contentSamples === undefined
      ? available
      : Math.max(1, Math.min(available, Math.round(contentSamples)));

  return sections.map((section, index) => {
    const startFraction = section.startSeconds / totalSeconds;
    const endFraction =
      index === sections.length - 1
        ? 1
        : Math.min(1, (section.startSeconds + section.durationSeconds) / totalSeconds);
    const start = clamp(Math.round(startFraction * length), 0, length);
    const end = clamp(Math.round(endFraction * length), start, length);
    const slice = Math.max(1, end - start);
    const mono = new Float32Array(slice);
    let squares = 0;
    let midSquares = 0;
    let sideSquares = 0;
    for (let i = start; i < end; i += 1) {
      const leftValue = left[i] ?? 0;
      const rightValue = right[i] ?? 0;
      const mid = (leftValue + rightValue) * 0.5;
      const side = (leftValue - rightValue) * 0.5;
      squares += leftValue * leftValue + rightValue * rightValue;
      midSquares += mid * mid;
      sideSquares += side * side;
      mono[i - start] = mid;
    }
    const spectrum = readSpectrum(mono, rate, SECTION_SPECTRUM_FRAMES);
    const seconds = slice / rate;
    return {
      name: section.name,
      rmsDb: dbOf(Math.sqrt(squares / (slice * 2))),
      width: widthFromSquares(midSquares, sideSquares),
      centroidHz: spectrum.centroidHz,
      onsetPerSecond: seconds > 0 ? countOnsets(mono) / seconds : 0,
    };
  });
}

/**
 * Measures a finished buffer without judging it. Exported so the renderer can
 * snapshot the pre-post mix with exactly the same code as the final report.
 */
export function measureAudio(
  left: Float32Array,
  right: Float32Array,
  rate: number,
  sections: readonly SectionReading[] = [],
): AnalysisFacts {
  const seconds = Math.min(left.length, right.length) / rate;
  const mono = mixed(left, right);
  const spectrum = readSpectrum(mono, rate);
  const loudness = loudnessSummary([left, right], rate);
  return {
    seconds,
    peakDb: dbOf(peakOf(left, right)),
    rmsDb: dbOf(rmsOf(left, right)),
    lufs: loudness.integrated,
    lra: loudness.range,
    centroidHz: spectrum.centroidHz,
    bands: spectrum.bands,
    lowMid: spectrum.lowMid,
    harsh: spectrum.harsh,
    width: widthOf(left, right),
    onsetPerSecond: seconds > 0 ? countOnsets(mono) / seconds : 0,
    sections,
  };
}

/** Thresholds are observations, not pass/fail gates; calibrate with A/B renders. */
const SUB_HEAVY = 0.06;
const MUD_LOW_MID = 0.25;
const HARSH_PRESENCE = 0.22;
const MASK_LOW_MID = 0.2;
const MASK_MID = 0.45;
const LOW_CREST = 9;
/** Below this, a song holds one level and has no breathing room. */
const FLAT_LRA_LU = 4;
/** Section levels closer than this count as "no arrangement contrast" for LRA. */
const FLAT_LRA_SPREAD_DB = 6;
/** A song louder than this is loud enough that a flat level becomes tiring. */
const FLAT_LOUD_LUFS = -16;
/** Short windows make the LRA percentile meaningless, so short renders skip it. */
const MIN_LRA_SECONDS = 10;
/** Above the streaming reference (~-14 LUFS); the platform will turn it down anyway. */
const HOT_LUFS = -12;
const POST_DELTA = 0.05;
const POST_CREST_DELTA = 3;
const FLAT_SECTION_LEVEL_DB = 2;
const FLAT_SECTION_WIDTH = 0.08;
const FLAT_SECTION_CENTROID_HZ = 400;

function stemLabel(stem: StemReading): string {
  return stem.name === stem.role ? stem.name : `${stem.name}(${stem.role})`;
}

function linearRms(rmsDb: number): number {
  return 10 ** (rmsDb / 20);
}

/** Peak-to-peak RMS of the section readings; infinities when a section is silent. */
function levelSpreadDb(sections: readonly SectionReading[]): number {
  const levels = sections.map((section) => section.rmsDb);
  return Math.max(...levels) - Math.min(...levels);
}

interface RankedStem {
  readonly stem: StemReading;
  readonly rank: number;
}

/** Ranks stems by absolute contribution, not by their own spectral share alone. */
function rankStems(
  stems: readonly StemReading[],
  metric: (stem: StemReading) => number,
): RankedStem[] {
  return stems
    .filter((stem) => stem.rmsDb > SILENCE_DB + 1)
    .map((stem) => ({ stem, rank: linearRms(stem.rmsDb) * metric(stem) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank);
}

function inRange(value: number, min: number | undefined, max: number | undefined): boolean {
  if (!Number.isFinite(value)) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function formatRange(min: number | undefined, max: number | undefined, unit = ''): string {
  if (min !== undefined && max !== undefined) return `${min}${unit}..${max}${unit}`;
  if (max !== undefined) return `max ${max}${unit}`;
  return `min ${min}${unit}`;
}

function targetFindings(analysis: AnalysisFacts, target: ResolvedTarget): {
  reading: TargetReading;
  findings: Finding[];
} {
  const profile: TargetProfile = target.profile;
  const crest = analysis.peakDb - analysis.rmsDb;
  const checks: TargetCheck[] = [];
  const findings: Finding[] = [];

  const add = (
    field: TargetCheck['field'],
    value: number,
    min: number | undefined,
    max: number | undefined,
    subject: string,
    unit: string,
    next: string,
  ): void => {
    const ok = inRange(value, min, max);
    checks.push({ field, value, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ok });
    if (ok) return;
    const shown = field === 'lufs' ? (Number.isFinite(value) ? value.toFixed(1) : 'silent') : value.toFixed(field === 'crest' ? 1 : field === 'width' ? 2 : 0);
    const unitSuffix = field === 'lowMid' || field === 'harsh' ? '%' : unit;
    const valueText = field === 'lowMid' || field === 'harsh' ? `${Math.round(value * 100)}%` : `${shown}${unitSuffix}`;
    findings.push({
      kind: 'target',
      message: `${subject} ${valueText} is outside ${target.name} ${formatRange(
        min === undefined ? undefined : field === 'lowMid' || field === 'harsh' ? Math.round(min * 100) : min,
        max === undefined ? undefined : field === 'lowMid' || field === 'harsh' ? Math.round(max * 100) : max,
      )}${field === 'lowMid' || field === 'harsh' ? '%' : unit}`,
      next,
    });
  };

  if (profile.lowMidMax !== undefined) {
    add('lowMid', analysis.lowMid, undefined, profile.lowMidMax, '150-500 Hz', '', 'high-pass or shelve the bass/pad, or move one part up an octave');
  }
  if (profile.harshMax !== undefined) {
    add('harsh', analysis.harsh, undefined, profile.harshMax, '2-5 kHz', '', 'soften the waveform, lower presence with tilt, or reduce drive');
  }
  if (profile.crestMin !== undefined) {
    add('crest', crest, profile.crestMin, undefined, 'crest', ' dB', 'lower the loudness target or compression, and leave more rests');
  }
  if (profile.width !== undefined) {
    add('width', analysis.width, profile.width[0], profile.width[1], 'width', '', 'widen or narrow the send/pan; width is side/mid RMS');
  }
  if (profile.lufs !== undefined) {
    add('lufs', analysis.lufs, profile.lufs[0], profile.lufs[1], 'LUFS', '', 'adjust the loudness step or the arrangement density');
  }
  if (profile.centroidHz !== undefined) {
    add('centroidHz', analysis.centroidHz, profile.centroidHz[0], profile.centroidHz[1], 'centroid', ' Hz', 'tilt, lowpass, or change the register of the brightest part');
  }

  return {
    reading: {
      name: target.name,
      passed: checks.filter((check) => check.ok).length,
      total: checks.length,
      checks,
    },
    findings,
  };
}

/**
 * Turns measured symptoms into attributed, actionable observations. When stems
 * are present the finding names the likely tracks; `dry` separates arrangement
 * from post processing. No finding is a hard gate.
 */
function findingsFor(
  analysis: AnalysisFacts,
  stems: readonly StemReading[] | undefined,
  dry: AnalysisFacts | undefined,
  target: ResolvedTarget | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const crest = analysis.peakDb - analysis.rmsDb;

  const alias = (stems ?? []).filter((stem) => stem.aliasRisk);
  if (alias.length > 0) {
    findings.push({
      kind: 'alias-risk',
      message: `pulse/saw/organ above C6 in ${alias.map(stemLabel).join(', ')}`,
      next: 'switch to additive or triangle, drop the part an octave, or keep the grit deliberately',
    });
  }

  if (analysis.bands.sub >= SUB_HEAVY) {
    findings.push({
      kind: 'sub-heavy',
      message: `20-60 Hz is ${formatPercent(analysis.bands.sub)} of the spectrum`,
      next: 'high-pass the bass/pad or add a post highpass around 30-40 Hz; monoBelowHz 100-140 also keeps the lowest band centred on small speakers',
    });
  }

  if (analysis.lowMid >= MUD_LOW_MID) {
    const top = rankStems(stems ?? [], (stem) => stem.lowMid)
      .slice(0, 2)
      .map((entry) => stemLabel(entry.stem));
    findings.push({
      kind: 'mud',
      message: `150-500 Hz is ${formatPercent(analysis.lowMid)} of the spectrum`,
      ...(top.length > 0 ? { attribution: `mostly ${top.join(' + ')}` } : {}),
      next: 'high-pass or EQ 150-500 Hz on the bass/pad, move one part up an octave, or shorten overlapping gates',
    });
  }

  const lowMidMasking = rankStems(stems ?? [], (stem) =>
    stem.lowMid >= MASK_LOW_MID ? stem.lowMid : 0,
  );
  if (lowMidMasking.length >= 2 && analysis.lowMid < MUD_LOW_MID) {
    findings.push({
      kind: 'masking',
      message: `${lowMidMasking
        .slice(0, 2)
        .map((entry) => stemLabel(entry.stem))
        .join(' and ')} both carry 150-500 Hz`,
      next: 'separate their registers or carve one with a high-pass',
    });
  }

  const midMasking = rankStems(stems ?? [], (stem) =>
    stem.bands.mid >= MASK_MID ? stem.bands.mid : 0,
  );
  if (midMasking.length >= 2) {
    findings.push({
      kind: 'masking',
      message: `${midMasking
        .slice(0, 2)
        .map((entry) => stemLabel(entry.stem))
        .join(' and ')} both sit in 250 Hz-2 kHz`,
      next: 'pan them apart, change one octave, or shorten one part',
    });
  }

  if (analysis.harsh >= HARSH_PRESENCE) {
    const top = rankStems(stems ?? [], (stem) => stem.harsh)
      .slice(0, 2)
      .map((entry) => stemLabel(entry.stem));
    findings.push({
      kind: 'harsh',
      message: `2-5 kHz is ${formatPercent(analysis.harsh)} of the spectrum`,
      ...(top.length > 0 ? { attribution: `mostly ${top.join(' + ')}` } : {}),
      next: 'use a softer waveform or additive partials, lower 2-5 kHz with tilt, or reduce instrument drive',
    });
  }

  if (crest < LOW_CREST && Number.isFinite(analysis.lufs) && analysis.lufs > -12) {
    findings.push({
      kind: 'dynamics',
      message: `crest is ${crest.toFixed(1)} dB`,
      next: 'lower the loudness target, reduce saturation/compression, or leave more rests',
    });
  }

  // Listening comfort, not correctness: a song that never leaves one loudness
  // tires the ear and has nowhere to lift into, no matter how good the mix is.
  // Loops are excluded (they have no sections and are meant to sit still), as
  // are very short renders (the 3 s LRA window needs a few blocks to mean much).
  // The spread check keeps a song with a silent intro from counting as "flat":
  // the absolute gate drops silence, so LRA alone would not see the rest.
  if (
    analysis.sections.length >= 2 &&
    analysis.seconds >= MIN_LRA_SECONDS &&
    Number.isFinite(analysis.lufs) &&
    analysis.lufs > FLAT_LOUD_LUFS &&
    analysis.lra < FLAT_LRA_LU &&
    levelSpreadDb(analysis.sections) < FLAT_LRA_SPREAD_DB
  ) {
    findings.push({
      kind: 'loudness-flat',
      message: `loudness range is ${analysis.lra.toFixed(1)} LU (the song holds ${analysis.lufs.toFixed(1)} LUFS)`,
      next: 'leave one section quieter or drop a part for a bar; a constant level is what makes a long listen feel loud, and the drop has nowhere left to go',
    });
  }

  if (target !== undefined) {
    findings.push(...targetFindings(analysis, target).findings);
  }

  if (dry !== undefined) {
    const lowMidDelta = analysis.lowMid - dry.lowMid;
    if (lowMidDelta >= POST_DELTA && analysis.lowMid >= MUD_LOW_MID) {
      findings.push({
        kind: 'post-mud',
        message: `post added ${formatPercent(lowMidDelta)} low-mid (dry ${formatPercent(dry.lowMid)} → ${formatPercent(analysis.lowMid)})`,
        next: 'check reverb wet/room, lowpass and saturation; try a low-cut on the reverb or less wet',
      });
    }

    const harshDelta = analysis.harsh - dry.harsh;
    if (harshDelta >= POST_DELTA && analysis.harsh >= HARSH_PRESENCE) {
      findings.push({
        kind: 'post-harsh',
        message: `post added ${formatPercent(harshDelta)} 2-5 kHz (dry ${formatPercent(dry.harsh)} → ${formatPercent(analysis.harsh)})`,
        next: 'reduce saturation drive/mix, or use a darker tilt',
      });
    }

    const crestDelta = dry.peakDb - dry.rmsDb - crest;
    if (crestDelta >= POST_CREST_DELTA) {
      findings.push({
        kind: 'post-dynamics',
        message: `post reduced crest by ${crestDelta.toFixed(1)} dB`,
        next: 'lower the loudness target or compression ratio, or reduce saturation mix',
      });
    }
  }

  return findings;
}

/**
 * Builds the report from the finished buffer. `sections` is optional because a
 * loop has no arrangement; a song passes its per-section readings in.
 */
export function analyseAudio(
  left: Float32Array,
  right: Float32Array,
  rate: number,
  options: AnalysisOptions = {},
): Analysis {
  const facts = measureAudio(left, right, rate, options.sections ?? []);
  const target = resolveTarget(options.target);
  const findings = findingsFor(facts, options.stems, options.dry, target);
  const targetReading = target === undefined ? undefined : targetFindings(facts, target).reading;
  return {
    ...facts,
    ...(options.stems === undefined ? {} : { stems: options.stems }),
    ...(options.dry === undefined ? {} : { dry: options.dry }),
    ...(targetReading === undefined ? {} : { target: targetReading }),
    findings,
    warnings: warningsFor(facts, options.extraWarnings ?? []),
  };
}

function warningsFor(
  analysis: AnalysisFacts,
  extraWarnings: readonly string[],
): string[] {
  const warnings: string[] = [];
  const bright = analysis.bands.high + analysis.bands.air;
  const lowEnd = analysis.bands.sub + analysis.bands.low;

  if (bright < 0.03) warnings.push(`dark: ${Math.round(bright * 100)}% above 2 kHz`);
  if (analysis.width < 0.08) warnings.push(`narrow: width ${analysis.width.toFixed(2)}`);
  if (analysis.onsetPerSecond < 1.5) {
    warnings.push(`sparse: ${analysis.onsetPerSecond.toFixed(1)} onsets/s`);
  }
  if (lowEnd > 0.7) warnings.push(`low-heavy: ${Math.round(lowEnd * 100)}% below 250 Hz`);
  if (Number.isFinite(analysis.lufs) && analysis.lufs < -20) {
    warnings.push(`quiet: ${analysis.lufs.toFixed(1)} LUFS`);
  }
  if (Number.isFinite(analysis.lufs) && analysis.lufs > MAX_SAFE_LUFS) {
    warnings.push(`unsafe: ${analysis.lufs.toFixed(1)} LUFS is above the ${MAX_SAFE_LUFS} LUFS hearing-safety ceiling`);
  } else if (Number.isFinite(analysis.lufs) && analysis.lufs > HOT_LUFS) {
    warnings.push(`loud: ${analysis.lufs.toFixed(1)} LUFS`);
  }
  if (analysis.sections.length >= 2) {
    const levelSpread = levelSpreadDb(analysis.sections);
    if (levelSpread < FLAT_SECTION_LEVEL_DB) {
      warnings.push(`flat-sections: energy range ${levelSpread.toFixed(1)} dB`);
    }
    // Width and brightness are separate axes: either one moving is an arc.
    // Only when both are flat does the arrangement lack spatial contrast.
    const widths = analysis.sections.map((section) => section.width);
    const centroids = analysis.sections.map((section) => section.centroidHz);
    const widthSpread = Math.max(...widths) - Math.min(...widths);
    const centroidSpread = Math.max(...centroids) - Math.min(...centroids);
    if (widthSpread < FLAT_SECTION_WIDTH && centroidSpread < FLAT_SECTION_CENTROID_HZ) {
      warnings.push(
        `flat-space: width range ${widthSpread.toFixed(2)}, centroid range ${Math.round(centroidSpread)} Hz`,
      );
    }
  }
  warnings.push(...extraWarnings);
  return warnings;
}

function formatDb(db: number): string {
  return db <= SILENCE_DB ? '-inf dBFS' : `${db.toFixed(1)} dBFS`;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatSigned(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

function formatSignedPercent(value: number): string {
  const points = Math.round(value * 100);
  return points > 0 ? `+${points}%` : `${points}%`;
}

function formatStems(stems: readonly StemReading[]): string | undefined {
  const ranked = [...stems]
    .filter((stem) => stem.rmsDb > SILENCE_DB + 1)
    .sort((a, b) => b.rmsDb - a.rmsDb);
  if (ranked.length === 0) return undefined;
  const top = ranked.slice(0, 6);
  const text = top
    .map((stem) => {
      const alias = stem.aliasRisk ? ' !alias' : '';
      return `${stemLabel(stem)} ${stem.rmsDb.toFixed(1)}dBFS ${Math.round(stem.centroidHz)}Hz low-mid ${formatPercent(stem.lowMid)} pan ${stem.pan.toFixed(2)}${alias}`;
    })
    .join(' · ');
  return `${text}${ranked.length > top.length ? ` · +${ranked.length - top.length} more` : ''}`;
}

/** Compact multi-line text shared by the render and analyze tool results. */
export function formatReport(analysis: Analysis): string {
  const lufs = Number.isFinite(analysis.lufs) ? analysis.lufs.toFixed(1) : 'silent';
  const { bands } = analysis;
  const lines = [
    `report peak ${formatDb(analysis.peakDb)} · RMS ${formatDb(analysis.rmsDb)} · LUFS ${lufs} · LRA ${analysis.lra.toFixed(1)} LU`,
    `report spectrum centroid ${Math.round(analysis.centroidHz)} Hz · sub ${formatPercent(bands.sub)} low ${formatPercent(bands.low)} mid ${formatPercent(bands.mid)} high ${formatPercent(bands.high)} air ${formatPercent(bands.air)} · low-mid ${formatPercent(analysis.lowMid)} · 2-5k ${formatPercent(analysis.harsh)}`,
    `report space width ${analysis.width.toFixed(2)} · onsets ${analysis.onsetPerSecond.toFixed(1)}/s`,
  ];
  if (analysis.sections.length > 0) {
    const sections = analysis.sections
      .map(
        (section) =>
          `${section.name} ${formatDb(section.rmsDb)} w${section.width.toFixed(2)} ${Math.round(section.centroidHz)}Hz ${section.onsetPerSecond.toFixed(1)}/s`,
      )
      .join(' · ');
    lines.push(`report sections ${sections}`);
  }
  if (analysis.stems !== undefined) {
    const stems = formatStems(analysis.stems);
    if (stems !== undefined) lines.push(`report stems ${stems}`);
  }
  if (analysis.dry !== undefined) {
    const dry = analysis.dry;
    const centroidDelta = analysis.centroidHz - dry.centroidHz;
    const lowMidDelta = analysis.lowMid - dry.lowMid;
    const crest = analysis.peakDb - analysis.rmsDb;
    const crestDelta = dry.peakDb - dry.rmsDb - crest;
    const widthDelta = analysis.width - dry.width;
    if (
      Math.abs(centroidDelta) >= 20 ||
      Math.abs(lowMidDelta) >= 0.01 ||
      Math.abs(crestDelta) >= 0.2 ||
      Math.abs(widthDelta) >= 0.02
    ) {
      lines.push(
        `report post-delta centroid ${formatSigned(centroidDelta, 0)} Hz · low-mid ${formatSignedPercent(lowMidDelta)} · crest ${formatSigned(crestDelta, 1)} dB · width ${formatSigned(widthDelta, 2)}`,
      );
    }
  }
  if (analysis.target !== undefined) {
    lines.push(
      `report target ${analysis.target.name}: ${analysis.target.passed}/${analysis.target.total} checks in range`,
    );
  }
  if (analysis.findings.length === 0) {
    lines.push('report findings: none');
  } else {
    for (const finding of analysis.findings) {
      const attribution =
        finding.attribution === undefined ? '' : ` (${finding.attribution})`;
      lines.push(`report finding ${finding.kind}: ${finding.message}${attribution}`);
      if (finding.next !== undefined) lines.push(`report next: ${finding.next}`);
    }
  }
  lines.push(
    `report warnings: ${analysis.warnings.length > 0 ? analysis.warnings.join('; ') : 'none'}`,
  );
  return lines.join('\n');
}
