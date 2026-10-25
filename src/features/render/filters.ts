import type { TrackFilter } from '../score/feature.ts';
import type { LowpassOrder } from './types.ts';

const MIN_HZ = 20;
const MAX_HZ = 20000;
/** Butterworth pole Qs; odd orders (1) use the one-pole path instead. */
const BUTTERWORTH_Q: Record<Exclude<LowpassOrder, 1>, readonly number[]> = {
  2: [Math.SQRT1_2],
  4: [0.5411961001461969, 1.3065629648763766],
};
/** Coefficient refresh interval; 32 samples is under a millisecond at 44.1 kHz. */
const LFO_BLOCK = 32;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * One-pole low-pass used by the arrangement's section filter. The cutoff is
 * constant inside a block, which is enough for both static sections and
 * exponential sweeps (a riser) without a `pow` per sample.
 */
export function applyAutomatedLowpass(
  samples: Float32Array,
  cutoffAt: (sampleIndex: number) => number,
  rate: number,
  block = 64,
): void {
  let state = 0;
  const limit = Math.min(MAX_HZ, rate * 0.45);
  for (let start = 0; start < samples.length; start += block) {
    const end = Math.min(samples.length, start + block);
    const cutoff = clamp(cutoffAt(start), MIN_HZ, limit);
    const coefficient = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
    for (let i = start; i < end; i += 1) {
      state += coefficient * ((samples[i] ?? 0) - state);
      samples[i] = state;
    }
  }
}

/**
 * Per-track TPT state-variable low-pass. `resonance` is Q: 0.707 is flat,
 * higher values give the acid peak. The LFO modulates the cutoff in octaves,
 * so `lfoDepth: 2` sweeps two octaves up and down.
 */
export function filterTrack(samples: Float32Array, filter: TrackFilter, rate: number): void {
  const limit = Math.min(MAX_HZ, rate * 0.45);
  const base = clamp(filter.cutoffHz, MIN_HZ, limit);
  const lfoOn = filter.lfoHz > 0 && filter.lfoDepth > 0;
  const q = filter.resonance;

  let ic1eq = 0;
  let ic2eq = 0;
  const block = lfoOn ? LFO_BLOCK : samples.length;

  for (let start = 0; start < samples.length; start += block) {
    const end = Math.min(samples.length, start + block);
    const time = (start + (end - start) * 0.5) / rate;
    const cutoff = lfoOn
      ? clamp(base * 2 ** (filter.lfoDepth * Math.sin(2 * Math.PI * filter.lfoHz * time)), MIN_HZ, limit)
      : base;

    const g = Math.tan((Math.PI * cutoff) / rate);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;

    for (let i = start; i < end; i += 1) {
      const input = samples[i] ?? 0;
      const v3 = input - ic2eq;
      const v1 = a1 * ic1eq + a2 * v3;
      const v2 = ic2eq + a2 * ic1eq + a3 * v3;
      ic1eq = 2 * v1 - ic1eq;
      ic2eq = 2 * v2 - ic2eq;
      samples[i] = v2;
    }
  }
}

interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** RBJ high-pass with Q = 0.707 (12 dB/oct). */
function highpassCoefficients(cutoffHz: number, rate: number): Biquad {
  const w0 = (2 * Math.PI * cutoffHz) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ low-pass with the given Q (0.707 is 12 dB/oct Butterworth). */
function lowpassCoefficients(cutoffHz: number, q: number, rate: number): Biquad {
  const w0 = (2 * Math.PI * cutoffHz) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ shelving filter with slope S = 1. `gainDb` > 0 boosts. */
function shelfCoefficients(
  type: 'low' | 'high',
  frequency: number,
  gainDb: number,
  rate: number,
): Biquad {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / rate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.SQRT2;
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const lowA0 = (A + 1) + (A - 1) * cos + twoSqrtAAlpha;
  const highA0 = (A + 1) - (A - 1) * cos + twoSqrtAAlpha;

  if (type === 'low') {
    const a0 = lowA0;
    return {
      b0: (A * ((A + 1) - (A - 1) * cos + twoSqrtAAlpha)) / a0,
      b1: (2 * A * ((A - 1) - (A + 1) * cos)) / a0,
      b2: (A * ((A + 1) - (A - 1) * cos - twoSqrtAAlpha)) / a0,
      a1: (-2 * ((A - 1) + (A + 1) * cos)) / a0,
      a2: ((A + 1) + (A - 1) * cos - twoSqrtAAlpha) / a0,
    };
  }

  const a0 = highA0;
  return {
    b0: (A * ((A + 1) + (A - 1) * cos + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cos)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cos - twoSqrtAAlpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cos)) / a0,
    a2: ((A + 1) - (A - 1) * cos - twoSqrtAAlpha) / a0,
  };
}

function applyBiquad(samples: Float32Array, coefficients: Biquad): void {
  const { b0, b1, b2, a1, a2 } = coefficients;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    samples[i] = y;
  }
}

/**
 * Post-chain low-pass. Order 1 keeps the historical one-pole 6 dB/oct path
 * sample-identical; orders 2 and 4 are Butterworth biquad cascades at
 * 12 and 24 dB/oct.
 */
export function applyLowpass(
  samples: Float32Array,
  cutoffHz: number,
  order: LowpassOrder,
  rate: number,
): void {
  if (order === 1) {
    const coefficient = 1 - Math.exp((-2 * Math.PI * cutoffHz) / rate);
    let value = 0;
    for (let i = 0; i < samples.length; i += 1) {
      value += coefficient * ((samples[i] ?? 0) - value);
      samples[i] = value;
    }
    return;
  }

  const cutoff = clamp(cutoffHz, MIN_HZ, Math.min(MAX_HZ, rate * 0.45));
  for (const q of BUTTERWORTH_Q[order]) {
    applyBiquad(samples, lowpassCoefficients(cutoff, q, rate));
  }
}

export interface TrackEqSettings {
  readonly highpassHz?: number;
  readonly lowShelf?: { readonly hz: number; readonly gainDb: number };
  readonly highShelf?: { readonly hz: number; readonly gainDb: number };
}

/**
 * Per-track tone shaping before delay and ducking. The high-pass removes the
 * muddy 150-500 Hz overlap from one part without darkening the whole mix, and
 * the shelves let a part keep its body while tucking presence. A zero-gain
 * shelf is skipped so an authored no-op stays sample-identical.
 */
export function applyTrackEq(samples: Float32Array, eq: TrackEqSettings, rate: number): void {
  const limit = Math.min(MAX_HZ, rate * 0.45);
  if (eq.highpassHz !== undefined && eq.highpassHz > MIN_HZ) {
    applyBiquad(samples, highpassCoefficients(clamp(eq.highpassHz, MIN_HZ, limit), rate));
  }
  if (eq.lowShelf !== undefined && eq.lowShelf.gainDb !== 0) {
    applyBiquad(
      samples,
      shelfCoefficients('low', clamp(eq.lowShelf.hz, MIN_HZ, limit), eq.lowShelf.gainDb, rate),
    );
  }
  if (eq.highShelf !== undefined && eq.highShelf.gainDb !== 0) {
    applyBiquad(
      samples,
      shelfCoefficients('high', clamp(eq.highShelf.hz, MIN_HZ, limit), eq.highShelf.gainDb, rate),
    );
  }
}
