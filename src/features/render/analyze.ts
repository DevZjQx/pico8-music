/**
 * Render report: the measurements the model needs to judge its own output.
 *
 * Everything is computed from the finished stereo buffer (after the post and
 * master chain), so the numbers describe what the WAV actually sounds like.
 * Spectrum and onset figures use fixed windows; peak, RMS, width, and loudness
 * use every sample. See docs/evaluation.md for the dimensions.
 */

import { integratedLufs } from './loudness.ts';

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
}

export interface Analysis {
  readonly seconds: number;
  readonly peakDb: number;
  readonly rmsDb: number;
  /** Integrated loudness in LUFS; -Infinity for silence. */
  readonly lufs: number;
  readonly centroidHz: number;
  readonly bands: BandEnergy;
  /** Side/mid RMS ratio: 0 is mono, 1 is a hard-panned source. */
  readonly width: number;
  readonly onsetPerSecond: number;
  readonly sections: readonly SectionReading[];
  readonly warnings: readonly string[];
}

export interface AnalysisOptions {
  readonly sections?: readonly SectionReading[];
  /** Extra warnings from the render stage, e.g. a safety-net trim. */
  readonly extraWarnings?: readonly string[];
}

const SILENCE_DB = -120;
const SPECTRUM_FRAME = 2048;
const MAX_SPECTRUM_FRAMES = 48;
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
}

/**
 * Averages the magnitude spectrum of evenly spaced frames. Magnitude, not
 * power, is the right weighting here: a drum loop's hats carry little energy
 * but they are exactly the content the "dark" warning is about, and power
 * weighting lets a loud kick hide them. The frame size adapts to short loops;
 * the frame count is capped so a long song does not turn the report into a
 * second render.
 */
function readSpectrum(mono: Float32Array, rate: number): SpectrumReading {
  const length = mono.length;
  if (length < 64) {
    return {
      centroidHz: 0,
      bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 },
    };
  }

  const size = Math.min(SPECTRUM_FRAME, 2 ** Math.floor(Math.log2(length)));
  const hop = Math.max(1, size >> 1);
  const frames = Math.max(1, Math.floor((length - size) / hop) + 1);
  const stride = Math.max(1, Math.ceil(frames / MAX_SPECTRUM_FRAMES));
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
  let weighted = 0;
  let total = 0;

  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = bin * binHz;
    if (frequency < 20 || frequency >= 16000) continue;
    const binMagnitude = magnitude[bin] ?? 0;
    total += binMagnitude;
    weighted += frequency * binMagnitude;
    for (const [band, [from, to]] of Object.entries(edges) as [keyof typeof sums, readonly [number, number]][]) {
      if (frequency >= from && frequency < to) {
        sums[band] += binMagnitude;
        break;
      }
    }
  }

  if (total <= 0 || frameCount === 0) {
    return { centroidHz: 0, bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 } };
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
  if (midSquares <= 1e-12) return 0;
  return Math.sqrt(sideSquares / midSquares);
}

/**
 * Per-section RMS from absolute step bounds. Section boundaries are fractions
 * of the score timeline, so they survive tape/slow resampling unchanged.
 */
export function sectionEnergies(
  left: Float32Array,
  right: Float32Array,
  sections: readonly { readonly name: string; readonly startStep: number; readonly steps: number }[],
  totalSteps: number,
): SectionReading[] {
  const length = Math.min(left.length, right.length);
  if (sections.length === 0 || totalSteps <= 0 || length === 0) return [];

  return sections.map((section, index) => {
    const startFraction = section.startStep / totalSteps;
    const endFraction =
      index === sections.length - 1
        ? 1
        : Math.min(1, (section.startStep + section.steps) / totalSteps);
    const start = clamp(Math.round(startFraction * length), 0, length);
    const end = clamp(Math.round(endFraction * length), start, length);
    const slice = Math.max(1, end - start);
    let squares = 0;
    for (let i = start; i < end; i += 1) {
      squares += (left[i] ?? 0) ** 2 + (right[i] ?? 0) ** 2;
    }
    return {
      name: section.name,
      rmsDb: dbOf(Math.sqrt(squares / (slice * 2))),
    };
  });
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
  const seconds = Math.min(left.length, right.length) / rate;
  const mono = mixed(left, right);
  const spectrum = readSpectrum(mono, rate);
  const sections = options.sections ?? [];
  const lufs = integratedLufs([left, right], rate);
  const analysis: Omit<Analysis, 'warnings'> = {
    seconds,
    peakDb: dbOf(peakOf(left, right)),
    rmsDb: dbOf(rmsOf(left, right)),
    lufs,
    centroidHz: spectrum.centroidHz,
    bands: spectrum.bands,
    width: widthOf(left, right),
    onsetPerSecond: seconds > 0 ? countOnsets(mono) / seconds : 0,
    sections,
  };
  return { ...analysis, warnings: warningsFor(analysis, options.extraWarnings ?? []) };
}

function warningsFor(
  analysis: Omit<Analysis, 'warnings'>,
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
  if (Number.isFinite(analysis.lufs) && analysis.lufs > -8) {
    warnings.push(`loud: ${analysis.lufs.toFixed(1)} LUFS`);
  }
  if (analysis.sections.length >= 2) {
    const levels = analysis.sections.map((section) => section.rmsDb);
    const spread = Math.max(...levels) - Math.min(...levels);
    if (spread < 2) warnings.push(`flat-sections: energy range ${spread.toFixed(1)} dB`);
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

/** Compact multi-line text shared by the render and analyze tool results. */
export function formatReport(analysis: Analysis): string {
  const lufs = Number.isFinite(analysis.lufs) ? analysis.lufs.toFixed(1) : 'silent';
  const { bands } = analysis;
  const lines = [
    `report peak ${formatDb(analysis.peakDb)} · RMS ${formatDb(analysis.rmsDb)} · LUFS ${lufs}`,
    `report spectrum centroid ${Math.round(analysis.centroidHz)} Hz · sub ${formatPercent(bands.sub)} low ${formatPercent(bands.low)} mid ${formatPercent(bands.mid)} high ${formatPercent(bands.high)} air ${formatPercent(bands.air)}`,
    `report space width ${analysis.width.toFixed(2)} · onsets ${analysis.onsetPerSecond.toFixed(1)}/s`,
  ];
  if (analysis.sections.length > 0) {
    const sections = analysis.sections
      .map((section) => `${section.name} ${formatDb(section.rmsDb)}`)
      .join(' · ');
    lines.push(`report sections ${sections}`);
  }
  lines.push(
    `report warnings: ${analysis.warnings.length > 0 ? analysis.warnings.join('; ') : 'none'}`,
  );
  return lines.join('\n');
}
