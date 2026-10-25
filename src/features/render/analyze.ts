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

import type { StructureReading } from '../structure/feature.ts';
import {
  checkAssertions,
  formatAssertionLine,
  type AssertionProfile,
  type AssertionReading,
} from './assert.ts';
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
  /** L/R waveform correlation inside the section; -1 is anti-phase. */
  readonly correlation: number;
  /** Left-minus-right RMS inside the section, dB; positive means left is louder. */
  readonly balanceDb: number;
  /** Spectral centroid inside the section; the brightness proxy for distance. */
  readonly centroidHz: number;
  /** 150-500 Hz share of the section's spectrum; same definition as the mix. */
  readonly lowMid: number;
  /** 2-5 kHz share of the section's spectrum; same definition as the mix. */
  readonly harsh: number;
  /** Transient density inside the section; the density proxy for energy. */
  readonly onsetPerSecond: number;
}

/** A section boundary expressed in output-file seconds (after tape/slow). */
export interface SectionBound {
  readonly name: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

/** Measurements shared by the final mix and the pre-post snapshot. */
export interface AnalysisFacts {
  readonly seconds: number;
  readonly peakDb: number;
  /** 4x-oversampled true peak, dBTP; equal to sample peak for silence. */
  readonly truePeakDb: number;
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
  /** Pearson correlation of L and R over every sample; 0 for silence. */
  readonly correlation: number;
  /** Left-minus-right RMS, dB; 0 for silence or a balanced image. */
  readonly balanceDb: number;
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
  | 'density-spike'
  | 'density-flat'
  | 'melody-static'
  | 'melody-leapy'
  | 'register-collision'
  | 'key-mismatch'
  | 'harmony-static'
  | 'target';

/** One dimension against the declared target; `ok` is a range check, not a score. */
export interface TargetCheck {
  readonly field:
    | 'lowMid'
    | 'harsh'
    | 'crest'
    | 'truePeak'
    | 'width'
    | 'correlation'
    | 'balance'
    | 'lufs'
    | 'centroidHz';
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
  /**
   * Symbolic score reading (per-bar density, melodic motion/repetition,
   * register overlaps). Present on renders, absent when re-reading a WAV: a
   * finished file cannot tell which bar a note was written on.
   */
  readonly structure?: StructureReading;
  readonly findings: readonly Finding[];
  readonly warnings: readonly string[];
  /** Present only when the caller supplied a target profile. */
  readonly target?: TargetReading;
  /** Present only when the caller supplied hard assertion ranges. */
  readonly assertions?: AssertionReading;
}

export interface AnalysisOptions {
  readonly sections?: readonly SectionReading[];
  /** Extra warnings from the render stage, e.g. a safety-net trim. */
  readonly extraWarnings?: readonly string[];
  readonly stems?: readonly StemReading[];
  /** Pre-post facts, used to separate arrangement from post processing. */
  readonly dry?: AnalysisFacts;
  /** Symbolic score reading; drives density and melody findings. */
  readonly structure?: StructureReading;
  /** Optional target name or inline ranges. */
  readonly target?: TargetInput;
  /** Section boundaries for a WAV that has no score (used by p8_analyze). */
  readonly sectionBounds?: readonly SectionBound[];
  /** Musical content length; excludes a tail when shorter than the buffer. */
  readonly contentSeconds?: number;
  /** Optional hard ranges; the service turns a miss into a tool error. */
  readonly assertions?: AssertionProfile;
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

/**
 * True peak is measured on a 4x grid with a short windowed-sinc interpolator.
 * Only local maxima of the 1x signal are evaluated: raising a signal by 4x can
 * create a new maximum only inside a lobe that already contains a local sample
 * maximum, so this is the same grid maximum at a fraction of a full resample.
 *
 * Candidates are pruned with the interpolator's L1 gain: a local maximum that
 * cannot lift itself above the best value found so far is skipped. A louder
 * neighbouring lobe is itself a local maximum, so the global 4x peak is still
 * visited without paying for a full resample.
 */
const TRUE_PEAK_HALF_TAPS = 5;
const TRUE_PEAK_PHASES = [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75] as const;
/** Kaiser beta; the standard true-peak filter is a 4x/48-tap lowpass. */
const TRUE_PEAK_KAISER_BETA = 8;

function sinc(value: number): number {
  if (Math.abs(value) < 1e-9) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

/** Modified Bessel I0, enough terms for the window's beta and double precision. */
function besselI0(value: number): number {
  let sum = 1;
  let term = 1;
  for (let index = 1; index < 50; index += 1) {
    term *= (value * value) / (4 * index * index);
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

function truePeakWeights(): readonly (readonly number[])[] {
  return TRUE_PEAK_PHASES.map((fraction) => {
    const weights: number[] = [];
    let sum = 0;
    for (let tap = -TRUE_PEAK_HALF_TAPS; tap <= TRUE_PEAK_HALF_TAPS; tap += 1) {
      // Kaiser window over the tap span; normalising the DC gain keeps a steady
      // tone at its authored level instead of shrinking it between samples.
      const radius = (tap - fraction) / (TRUE_PEAK_HALF_TAPS + 1);
      const window =
        besselI0(TRUE_PEAK_KAISER_BETA * Math.sqrt(Math.max(0, 1 - radius * radius))) /
        besselI0(TRUE_PEAK_KAISER_BETA);
      const weight = sinc(tap - fraction) * window;
      weights.push(weight);
      sum += weight;
    }
    return weights.map((weight) => weight / sum);
  });
}

const TRUE_PEAK_WEIGHTS = truePeakWeights();
const TRUE_PEAK_MAX_GAIN = Math.max(
  ...TRUE_PEAK_WEIGHTS.map((weights) => weights.reduce((sum, weight) => sum + Math.abs(weight), 0)),
);

function truePeakOfChannel(channel: Float32Array): number {
  const length = channel.length;
  if (length === 0) return 0;

  let samplePeak = 0;
  for (let i = 0; i < length; i += 1) {
    const magnitude = Math.abs(channel[i] ?? 0);
    if (magnitude > samplePeak) samplePeak = magnitude;
  }
  if (samplePeak === 0) return 0;

  let best = samplePeak;
  for (let i = 0; i < length; i += 1) {
    const magnitude = Math.abs(channel[i] ?? 0);
    const previous = i > 0 ? Math.abs(channel[i - 1] ?? 0) : -1;
    const next = i + 1 < length ? Math.abs(channel[i + 1] ?? 0) : -1;
    if (magnitude < previous || magnitude < next) continue;

    if (magnitude * TRUE_PEAK_MAX_GAIN <= best) continue;

    for (const weights of TRUE_PEAK_WEIGHTS) {
      let value = 0;
      for (let tap = 0; tap < weights.length; tap += 1) {
        const sample = channel[i + tap - TRUE_PEAK_HALF_TAPS];
        if (sample !== undefined) value += sample * (weights[tap] ?? 0);
      }
      const magnitudeAtPhase = Math.abs(value);
      if (magnitudeAtPhase > best) best = magnitudeAtPhase;
    }
  }
  return best;
}

function truePeakOf(left: Float32Array, right: Float32Array): number {
  return Math.max(truePeakOfChannel(left), truePeakOfChannel(right));
}

/** In-place iterative radix-2 FFT; `n` must be a power of two. */
export function fft(real: Float64Array, imaginary: Float64Array): void {
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

interface StereoStats {
  readonly width: number;
  readonly correlation: number;
  readonly balanceDb: number;
}

function correlationFromSquares(
  leftSquares: number,
  rightSquares: number,
  cross: number,
): number {
  const denominator = Math.sqrt(leftSquares * rightSquares);
  if (denominator <= 1e-20) return 0;
  return clamp(cross / denominator, -1, 1);
}

function balanceFromSquares(leftSquares: number, rightSquares: number): number {
  if (leftSquares <= 1e-20 && rightSquares <= 1e-20) return 0;
  const ratio = (leftSquares + 1e-20) / (rightSquares + 1e-20);
  return clamp(10 * Math.log10(ratio), -120, 120);
}

function stereoStatsFromSquares(
  leftSquares: number,
  rightSquares: number,
  midSquares: number,
  sideSquares: number,
  cross: number,
): StereoStats {
  return {
    width: widthFromSquares(midSquares, sideSquares),
    correlation: correlationFromSquares(leftSquares, rightSquares, cross),
    balanceDb: balanceFromSquares(leftSquares, rightSquares),
  };
}

function stereoStatsOf(left: Float32Array, right: Float32Array): StereoStats {
  const length = Math.min(left.length, right.length);
  let leftSquares = 0;
  let rightSquares = 0;
  let midSquares = 0;
  let sideSquares = 0;
  let cross = 0;
  for (let i = 0; i < length; i += 1) {
    const leftValue = left[i] ?? 0;
    const rightValue = right[i] ?? 0;
    const mid = (leftValue + rightValue) * 0.5;
    const side = (leftValue - rightValue) * 0.5;
    leftSquares += leftValue * leftValue;
    rightSquares += rightValue * rightValue;
    midSquares += mid * mid;
    sideSquares += side * side;
    cross += leftValue * rightValue;
  }
  return stereoStatsFromSquares(leftSquares, rightSquares, midSquares, sideSquares, cross);
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
  sections: readonly SectionBound[],
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

  return sections.map((section) => {
    const startFraction = section.startSeconds / totalSeconds;
    const endFraction = Math.min(
      1,
      (section.startSeconds + section.durationSeconds) / totalSeconds,
    );
    const start = clamp(Math.round(startFraction * length), 0, length);
    const end = clamp(Math.round(endFraction * length), start, length);
    const slice = Math.max(1, end - start);
    const mono = new Float32Array(slice);
    let leftSquares = 0;
    let rightSquares = 0;
    let midSquares = 0;
    let sideSquares = 0;
    let cross = 0;
    for (let i = start; i < end; i += 1) {
      const leftValue = left[i] ?? 0;
      const rightValue = right[i] ?? 0;
      const mid = (leftValue + rightValue) * 0.5;
      const side = (leftValue - rightValue) * 0.5;
      leftSquares += leftValue * leftValue;
      rightSquares += rightValue * rightValue;
      midSquares += mid * mid;
      sideSquares += side * side;
      cross += leftValue * rightValue;
      mono[i - start] = mid;
    }
    const spectrum = readSpectrum(mono, rate, SECTION_SPECTRUM_FRAMES);
    const seconds = slice / rate;
    const stereo = stereoStatsFromSquares(
      leftSquares,
      rightSquares,
      midSquares,
      sideSquares,
      cross,
    );
    return {
      name: section.name,
      rmsDb: dbOf(Math.sqrt((leftSquares + rightSquares) / (slice * 2))),
      width: stereo.width,
      correlation: stereo.correlation,
      balanceDb: stereo.balanceDb,
      centroidHz: spectrum.centroidHz,
      lowMid: spectrum.lowMid,
      harsh: spectrum.harsh,
      onsetPerSecond: seconds > 0 ? countOnsets(mono) / seconds : 0,
    };
  });
}

/**
 * Validates section boundaries supplied to `p8_analyze`. Unlike a score's
 * sections, these are already in output-file seconds (after tape/slow). A
 * missing duration runs to the next boundary; the last one runs to the content
 * length. Keeping the parser here means the tool schema, the renderer, and the
 * tests agree on one set of units.
 */
export function resolveSectionBounds(input: unknown, totalSeconds: number): SectionBound[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('sections must be an array');
  if (input.length === 0) return [];
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new Error('sections need a positive content duration');
  }

  const parsed = input.map((entry, index) => {
    const path = `sections[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${path} must be an object with a name and startSeconds`);
    }
    const record = entry as Record<string, unknown>;
    const allowed = new Set(['name', 'startSeconds', 'durationSeconds']);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) throw new Error(`${path}.${key} is not a known section field`);
    }
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error(`${path}.name must be a non-empty string`);
    }
    if (
      typeof record.startSeconds !== 'number' ||
      !Number.isFinite(record.startSeconds) ||
      record.startSeconds < 0
    ) {
      throw new Error(`${path}.startSeconds must be a finite number >= 0`);
    }
    const duration =
      record.durationSeconds === undefined
        ? undefined
        : record.durationSeconds;
    if (
      duration !== undefined &&
      (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)
    ) {
      throw new Error(`${path}.durationSeconds must be a finite number > 0`);
    }
    return {
      name: record.name.trim(),
      startSeconds: record.startSeconds,
      ...(duration === undefined ? {} : { durationSeconds: duration }),
    };
  });

  parsed.sort((a, b) => a.startSeconds - b.startSeconds);
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1];
    const current = parsed[index];
    if (previous !== undefined && current !== undefined && current.startSeconds <= previous.startSeconds) {
      throw new Error(
        `sections[${index}].startSeconds must be greater than the previous section start`,
      );
    }
  }

  return parsed.map((section, index) => {
    if (section.startSeconds >= totalSeconds) {
      throw new Error(
        `section ${JSON.stringify(section.name)} starts at ${section.startSeconds}s, at or after the content length ${totalSeconds.toFixed(2)}s`,
      );
    }
    const nextStart = parsed[index + 1]?.startSeconds;
    const end =
      section.durationSeconds !== undefined
        ? section.startSeconds + section.durationSeconds
        : (nextStart ?? totalSeconds);
    if (nextStart !== undefined && end > nextStart + 1e-6) {
      throw new Error(
        `section ${JSON.stringify(section.name)} overlaps the next section at ${nextStart.toFixed(2)}s`,
      );
    }
    if (end > totalSeconds + 1e-6) {
      throw new Error(
        `section ${JSON.stringify(section.name)} ends at ${end.toFixed(2)}s, past the content length ${totalSeconds.toFixed(2)}s`,
      );
    }
    return {
      name: section.name,
      startSeconds: section.startSeconds,
      durationSeconds: end - section.startSeconds,
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
  const stereo = stereoStatsOf(left, right);
  return {
    seconds,
    peakDb: dbOf(peakOf(left, right)),
    truePeakDb: dbOf(truePeakOf(left, right)),
    rmsDb: dbOf(rmsOf(left, right)),
    lufs: loudness.integrated,
    lra: loudness.range,
    centroidHz: spectrum.centroidHz,
    bands: spectrum.bands,
    lowMid: spectrum.lowMid,
    harsh: spectrum.harsh,
    width: stereo.width,
    correlation: stereo.correlation,
    balanceDb: stereo.balanceDb,
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
/** A deliberate pan can be wider than this; only a lopsided mix is surprising. */
const IMBALANCE_DB = 6;
/**
 * Symbolic structure thresholds. The reading itself is neutral; these only
 * decide when an outlier is worth naming. A fill bar is a legitimate spike, so
 * the finding states the numbers and leaves the intent to the model.
 */
const SPIKE_RATIO = 2;
const SPIKE_MIN_ATTACKS = 4;
const SPIKE_MIN_DELTA = 4;
const FLAT_DENSITY_BARS = 8;
const FLAT_DENSITY_SPREAD = 1;
const FLAT_DENSITY_ATTACKS = 4;
const STATIC_MELODY_BITS = 1.1;
const STATIC_MELODY_NOTES = 32;
const LEAP_STEPWISE = 0.3;
const LEAP_SHARE = 0.4;
const LEAP_INTERVALS = 12;
const REGISTER_COLLISION_OCTAVES = 2;
/** Below this share of diatonic notes, a declared key and the notes disagree. */
const KEY_MATCH_SHARE = 0.75;
const KEY_MATCH_NOTES = 32;
/** A section this long with at most one root change is a pedal or a drone. */
const STATIC_HARMONY_BARS = 8;
const STATIC_HARMONY_CHANGES = 1;
const MAX_STRUCTURE_FINDINGS = 2;

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
    const digits =
      field === 'crest' || field === 'truePeak' || field === 'balance'
        ? 1
        : field === 'width' || field === 'correlation'
          ? 2
          : 0;
    const shown = field === 'lufs'
      ? (Number.isFinite(value) ? value.toFixed(1) : 'silent')
      : value.toFixed(digits);
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
    add('harsh', analysis.harsh, undefined, profile.harshMax, '2-5 kHz', '', 'soften the waveform, add a highShelf around 3 kHz, lower presence with tilt, or reduce drive');
  }
  if (profile.crestMin !== undefined) {
    add('crest', crest, profile.crestMin, undefined, 'crest', ' dB', 'lower the loudness target or compression, and leave more rests');
  }
  if (profile.truePeakMax !== undefined) {
    add('truePeak', analysis.truePeakDb, undefined, profile.truePeakMax, 'true peak', ' dBTP', 'lower the limiter ceiling, master gain, or saturation mix');
  }
  if (profile.width !== undefined) {
    add('width', analysis.width, profile.width[0], profile.width[1], 'width', '', 'widen or narrow the send/pan; width is side/mid RMS');
  }
  if (profile.correlation !== undefined) {
    add('correlation', analysis.correlation, profile.correlation[0], profile.correlation[1], 'L/R correlation', '', 'check for anti-phase reverb or delay returns; correlation is -1..1');
  }
  if (profile.balanceMax !== undefined) {
    add('balance', Math.abs(analysis.balanceDb), undefined, profile.balanceMax, 'L/R balance', ' dB', 'move a pan back toward centre or check a one-sided send');
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
 * Turns the symbolic reading into observations. These are score facts, so they
 * hold whether the render is dry or drenched: a bar with twice the attacks of
 * its neighbours is still that bar after the reverb. Judgement stays minimal —
 * a spike can be a fill, and an ostinato can be the hook.
 */
function structureFindings(structure: StructureReading): Finding[] {
  const findings: Finding[] = [];

  let spikes = 0;
  for (const section of structure.sections) {
    if (spikes >= MAX_STRUCTURE_FINDINGS) break;
    if (section.bars < 2) continue;
    const mean = section.attacksPerBar;
    if (section.busiest < SPIKE_MIN_ATTACKS) continue;
    if (section.busiest < mean * SPIKE_RATIO) continue;
    if (section.busiest - mean < SPIKE_MIN_DELTA) continue;
    findings.push({
      kind: 'density-spike',
      message: `bar ${section.busiestBar} has ${section.busiest} attacks vs ${mean.toFixed(1)} per bar in ${section.name}`,
      next: 'thin that bar: drop the fill, mute one part for it, or lengthen some slots; keep the spike only if the section needs a fill there',
    });
    spikes += 1;
  }

  let flats = 0;
  for (const section of structure.sections) {
    if (flats >= MAX_STRUCTURE_FINDINGS) break;
    if (section.bars < FLAT_DENSITY_BARS) continue;
    if (section.attacksPerBar < FLAT_DENSITY_ATTACKS) continue;
    if (section.busiest - section.quietest > FLAT_DENSITY_SPREAD) continue;
    findings.push({
      kind: 'density-flat',
      message: `${section.name} holds ${section.attacksPerBar.toFixed(1)} attacks in every one of its ${section.bars} bars`,
      next: 'vary the groove: add a fill in the last bar, ghost notes, or rest one part for a bar',
    });
    flats += 1;
  }

  // Harmony is measured across every melodic part together. A two-note bass
  // ostinato is idiomatic, so a per-track rule would fire on good scores; a
  // whole arrangement that never leaves two pitch classes is the real symptom.
  if (structure.notes >= STATIC_MELODY_NOTES && structure.entropyBits <= STATIC_MELODY_BITS) {
    findings.push({
      kind: 'melody-static',
      message: `melodic material uses ${structure.pitchClasses} ${structure.pitchClasses === 1 ? 'pitch class' : 'pitch classes'} across ${structure.notes} notes (entropy ${structure.entropyBits.toFixed(1)} bits)`,
      next: 'add a third or fourth pitch class, transpose one repeat, or let a chord change under the same melody',
    });
  }

  let leapyMelodies = 0;
  for (const track of structure.tracks) {
    if (track.drums || track.bars === 0) continue;
    // A bass line that jumps octaves and fifths is normal; the symptom is a
    // melodic part that never moves by step.
    if (/bass/i.test(track.role) || /bass/i.test(track.name)) continue;
    // A chord part has no melodic line: its per-voice intervals are the root
    // motion of the harmony, so "leaps" there is a measurement of the wrong
    // thing rather than a symptom.
    if (track.voicesPerAttack >= 1.5) continue;
    if (leapyMelodies >= MAX_STRUCTURE_FINDINGS) break;
    if (track.intervals < LEAP_INTERVALS) continue;
    if (track.stepwise >= LEAP_STEPWISE) continue;
    if (track.leaps < LEAP_SHARE) continue;
    findings.push({
      kind: 'melody-leapy',
      message: `${track.name} leaps on ${Math.round(track.leaps * 100)}% of ${track.intervals} intervals (largest ${track.largestLeap} st, ${Math.round(track.stepwise * 100)}% stepwise)`,
      next: 'connect the leaps with scale steps, or repeat the shape so the jumps read as a hook instead of a wander',
    });
    leapyMelodies += 1;
  }

  let collisions = 0;
  for (const entry of structure.register) {
    if (collisions >= MAX_STRUCTURE_FINDINGS) break;
    if (entry.overlapOctaves < REGISTER_COLLISION_OCTAVES) continue;
    findings.push({
      kind: 'register-collision',
      message: `${entry.a} and ${entry.b} share ${entry.overlapOctaves.toFixed(1)} octaves in ${entry.section} (${entry.sharedPitchClasses} shared ${entry.sharedPitchClasses === 1 ? 'pitch class' : 'pitch classes'})`,
      next: 'move one part up or down an octave, or narrow its range for that section',
    });
    collisions += 1;
  }

  // A declared key is an intention, so the finding is about the mismatch, not
  // about chromaticism being wrong: the score says one thing and plays another.
  const declared = structure.harmony?.key;
  if (
    declared !== undefined &&
    declared.notes >= KEY_MATCH_NOTES &&
    declared.inKey < KEY_MATCH_SHARE
  ) {
    const worst = [...structure.tracks]
      .filter((track) => !track.drums && track.outside !== undefined && track.notes >= 4)
      .sort((a, b) => (b.outside ?? 0) - (a.outside ?? 0))[0];
    const where =
      worst !== undefined && (worst.outside ?? 0) >= 0.5
        ? ` (${worst.name} ${Math.round((worst.outside ?? 0) * 100)}%)`
        : '';
    const accidental = declared.chromatic.length > 0 ? `: ${declared.chromatic.join(' ')}` : '';
    findings.push({
      kind: 'key-mismatch',
      message: `${Math.round((1 - declared.inKey) * 100)}% of ${declared.notes} melodic notes are outside ${declared.label}${where}${accidental}`,
      next: 'either fix key (the notes are the piece) or fix the notes (the key is the intent); the reading only says the two disagree',
    });
  }

  let staticHarmony = 0;
  for (const section of structure.harmony?.sections ?? []) {
    if (staticHarmony >= MAX_STRUCTURE_FINDINGS) break;
    if (section.bars < STATIC_HARMONY_BARS) continue;
    if (section.changes > STATIC_HARMONY_CHANGES) continue;
    const held = section.bass.length === 0 ? 'no bass note' : section.bass.join(' then ');
    findings.push({
      kind: 'harmony-static',
      message: `${section.section} keeps the bass on ${held} for ${section.bars} bars`,
      next: 'move the root once or twice in that section, or keep the pedal on purpose and let another part carry the harmony',
    });
    staticHarmony += 1;
  }

  return findings;
}

/**
 * Turns measured symptoms into attributed, actionable observations. When stems
 * are present the finding names the likely tracks; `dry` separates arrangement
 * from post processing, and `structure` adds the symbolic score facts. No
 * finding is a hard gate.
 */
function findingsFor(
  analysis: AnalysisFacts,
  stems: readonly StemReading[] | undefined,
  dry: AnalysisFacts | undefined,
  target: ResolvedTarget | undefined,
  structure: StructureReading | undefined,
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
      next: 'use a softer waveform or additive partials, lower 2-5 kHz with highShelf or tilt, or reduce instrument drive',
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

  if (structure !== undefined) {
    findings.push(...structureFindings(structure));
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
        next: 'reduce saturation drive/mix, or use a darker tilt/highShelf',
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
  const contentSeconds =
    options.contentSeconds ?? Math.min(left.length, right.length) / rate;
  const sections =
    options.sections ??
    (options.sectionBounds === undefined
      ? []
      : sectionReadings(
          left,
          right,
          options.sectionBounds,
          contentSeconds,
          rate,
          options.contentSeconds === undefined
            ? undefined
            : Math.round(options.contentSeconds * rate),
        ));
  const facts = measureAudio(left, right, rate, sections);
  const target = resolveTarget(options.target);
  const findings = findingsFor(facts, options.stems, options.dry, target, options.structure);
  const targetReading = target === undefined ? undefined : targetFindings(facts, target).reading;
  const assertions =
    options.assertions === undefined ? undefined : checkAssertions(facts, options.assertions);
  return {
    ...facts,
    ...(options.stems === undefined ? {} : { stems: options.stems }),
    ...(options.dry === undefined ? {} : { dry: options.dry }),
    ...(options.structure === undefined ? {} : { structure: options.structure }),
    ...(targetReading === undefined ? {} : { target: targetReading }),
    ...(assertions === undefined ? {} : { assertions }),
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
  // An anti-phase image has almost no mid signal, so width alone reads as
  // "narrow". Correlation explains that case; do not report both as the same
  // symptom.
  if (analysis.correlation >= -0.2 && analysis.width < 0.08) {
    warnings.push(`narrow: width ${analysis.width.toFixed(2)}`);
  }
  if (analysis.correlation < -0.2) {
    warnings.push(`phase: L/R correlation ${analysis.correlation.toFixed(2)} (mono fold-down cancels)`);
  }
  if (Math.abs(analysis.balanceDb) > IMBALANCE_DB) {
    const side = analysis.balanceDb > 0 ? 'left' : 'right';
    warnings.push(`imbalanced: ${side} is ${Math.abs(analysis.balanceDb).toFixed(1)} dB louder`);
  }
  if (analysis.truePeakDb > -0.1) {
    warnings.push(`true-peak: ${analysis.truePeakDb.toFixed(1)} dBTP is close to 0; lower master gain or the limiter ceiling`);
  }
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

function formatDbtp(db: number): string {
  return db <= SILENCE_DB ? '-inf dBTP' : `${db.toFixed(1)} dBTP`;
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

/**
 * The symbolic half of the report: bar density, melodic motion, and register.
 * It is compact because the per-bar grid lives in the raw artifact; the summary
 * only names the shape and leaves specific bars to the findings.
 */
function formatStructure(structure: StructureReading): string[] {
  const lines: string[] = [];
  const attacksPerBar = structure.bars > 0 ? structure.attacks / structure.bars : 0;
  const notesPerBar = structure.bars > 0 ? structure.notes / structure.bars : 0;
  lines.push(
    `report bars ${structure.bars} · ${attacksPerBar.toFixed(2)} attacks/bar · ${notesPerBar.toFixed(2)} notes/bar · ${structure.activeBars} active · ${structure.drumBars} with drums · ${structure.pitchClasses} ${structure.pitchClasses === 1 ? 'pitch class' : 'pitch classes'} (entropy ${structure.entropyBits.toFixed(2)})`,
  );

  if (structure.sections.length > 0) {
    // A 256-section arrangement must not turn the summary into a second score.
    const shown = structure.sections.slice(0, 8);
    const sections = shown
      .map(
        (section) =>
          `${section.name} ${section.attacksPerBar.toFixed(2)}/bar d${section.drumHitsPerBar.toFixed(2)} n${section.notesPerBar.toFixed(2)} ${section.quietest}-${section.busiest}`,
      )
      .join(' · ');
    const more = structure.sections.length - shown.length;
    lines.push(`report density ${sections}${more > 0 ? ` · +${more} more` : ''}`);
  }

  const melodic = structure.tracks.filter((track) => !track.drums && track.notes > 0);
  if (melodic.length > 0) {
    const ranked = [...melodic].sort((a, b) => b.notes - a.notes).slice(0, 4);
    const text = ranked
      .map(
        (track) =>
          `${track.name} n${track.notes} pc${track.pitchClasses} e${track.entropyBits.toFixed(2)} s${track.stepwise.toFixed(2)} l${track.leaps.toFixed(2)} r${track.repeatRate.toFixed(2)}`,
      )
      .join(' · ');
    const more = melodic.length - ranked.length;
    lines.push(`report structure ${text}${more > 0 ? ` · +${more} more` : ''}`);
  }

  if (structure.register.length > 0) {
    const register = structure.register
      .slice(0, 3)
      .map((entry) => `${entry.section} ${entry.a}+${entry.b} ${entry.overlapOctaves.toFixed(1)} oct`)
      .join(' · ');
    lines.push(`report register ${register}`);
  }

  const harmony = structure.harmony;
  if (harmony !== undefined) {
    const parts: string[] = [];
    const declared = harmony.key;
    if (declared !== undefined) {
      const accidental =
        declared.chromatic.length > 0 ? ` (outside ${declared.chromatic.join(' ')})` : '';
      parts.push(
        `key ${declared.label} ${Math.round(declared.inKey * 100)}% in key${accidental}`,
      );
    }
    parts.push(`${harmony.changesPerBar.toFixed(2)} bass changes/bar`);
    if (harmony.largest > 0) {
      parts.push(
        `fifths ${Math.round(harmony.fifths * 100)}% · steps ${Math.round(harmony.seconds * 100)}%`,
      );
    }
    const roots = harmony.sections
      .slice(0, 4)
      .map((section) => {
        const list = section.bass.join(' ');
        return `${section.section} ${section.truncated ? `${list} …` : list || 'none'}`;
      })
      .join(' · ');
    const more = harmony.sections.length - 4;
    lines.push(
      `report harmony ${parts.join(' · ')} · bass ${roots}${more > 0 ? ` · +${more} more` : ''}`,
    );
  }

  return lines;
}

/** Compact multi-line text shared by the render and analyze tool results. */
export function formatReport(analysis: Analysis): string {
  const lufs = Number.isFinite(analysis.lufs) ? analysis.lufs.toFixed(1) : 'silent';
  const { bands } = analysis;
  const lines = [
    `report peak ${formatDb(analysis.peakDb)} · true-peak ${formatDbtp(analysis.truePeakDb)} · RMS ${formatDb(analysis.rmsDb)} · LUFS ${lufs} · LRA ${analysis.lra.toFixed(1)} LU`,
    `report spectrum centroid ${Math.round(analysis.centroidHz)} Hz · sub ${formatPercent(bands.sub)} low ${formatPercent(bands.low)} mid ${formatPercent(bands.mid)} high ${formatPercent(bands.high)} air ${formatPercent(bands.air)} · low-mid ${formatPercent(analysis.lowMid)} · 2-5k ${formatPercent(analysis.harsh)}`,
    `report space width ${analysis.width.toFixed(2)} · correlation ${analysis.correlation.toFixed(2)} · balance ${formatSigned(analysis.balanceDb, 1)} dB · onsets ${analysis.onsetPerSecond.toFixed(1)}/s`,
  ];
  if (analysis.sections.length > 0) {
    const sections = analysis.sections
      .map(
        (section) =>
          `${section.name} ${formatDb(section.rmsDb)} w${section.width.toFixed(2)} c${section.correlation.toFixed(2)} b${formatSigned(section.balanceDb, 1)} dB ${Math.round(section.centroidHz)}Hz low-mid ${formatPercent(section.lowMid)} 2-5k ${formatPercent(section.harsh)} ${section.onsetPerSecond.toFixed(1)}/s`,
      )
      .join(' · ');
    lines.push(`report sections ${sections}`);
  }
  if (analysis.stems !== undefined) {
    const stems = formatStems(analysis.stems);
    if (stems !== undefined) lines.push(`report stems ${stems}`);
  }
  if (analysis.structure !== undefined) {
    lines.push(...formatStructure(analysis.structure));
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
  if (analysis.assertions !== undefined) {
    lines.push(formatAssertionLine(analysis.assertions));
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
