import type { TrackFilter } from '../score/feature.ts';

const MIN_HZ = 20;
const MAX_HZ = 20000;
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
