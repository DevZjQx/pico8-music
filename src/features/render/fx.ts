/**
 * Arrangement-level transition effects. A riser is synthesized from a noise
 * source through a rising band-pass plus a quiet sine sweep, so it needs no
 * samples and stays reproducible from the score seed.
 */

import type { Score } from '../score/feature.ts';
import { throwIfAborted } from './abort.ts';

const BLOCK = 64;
const START_HZ = 280;
const END_HZ = 9000;
const LEVEL = 0.18;
const RESONANCE = 2.2;

function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x80000000 - 1;
  };
}

/**
 * Adds one noise sweep per section that sets `riserBars`. The sweep ends
 * exactly on the section boundary, so it points at the next section instead of
 * overlapping it. Its gain starts at silence and fades to zero at the edge,
 * which keeps the transition from clicking even without an impact.
 */
export function addSectionRisers(
  left: Float32Array,
  right: Float32Array,
  score: Score,
  rate: number,
  signal?: AbortSignal,
): void {
  if (score.sections.length === 0) return;
  const barSamples = 4 * score.stepSeconds * rate;
  const maxCutoff = rate * 0.45;

  score.sections.forEach((section, sectionIndex) => {
    if (section.riserBars === undefined) return;
    throwIfAborted(signal);

    const end = Math.min(
      left.length,
      right.length,
      Math.round((section.startStep + section.steps) * score.stepSeconds * rate),
    );
    const length = Math.min(end, Math.round(section.riserBars * barSamples));
    const start = Math.max(0, end - length);
    if (start >= end) return;

    const seed = (Math.imul(score.seed + sectionIndex + 1, 0x9e3779b1) ^ 0x51ed270b) >>> 0;
    const noise = noiseSource(seed);
    const energyGain = 0.5 + 0.5 * (section.energy ?? 1);
    const total = end - start;
    let ic1eq = 0;
    let ic2eq = 0;
    let phase = 0;

    for (let block = start; block < end; block += BLOCK) {
      throwIfAborted(signal);
      const blockEnd = Math.min(end, block + BLOCK);
      const progress = (block - start) / total;
      const cutoff = Math.min(maxCutoff, START_HZ * (END_HZ / START_HZ) ** progress);
      const g = Math.tan((Math.PI * cutoff) / rate);
      const k = 1 / RESONANCE;
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;

      for (let i = block; i < blockEnd; i += 1) {
        const local = (i - start) / total;
        const fadeIn = Math.min(1, local / 0.06);
        const fadeOut = Math.min(1, Math.max(0, (1 - local) / 0.02));
        const amplitude = LEVEL * local ** 1.6 * fadeIn * fadeOut * energyGain;

        const input = noise();
        const v3 = input - ic2eq;
        const v1 = a1 * ic1eq + a2 * v3;
        const v2 = ic2eq + a2 * ic1eq + a3 * v3;
        ic1eq = 2 * v1 - ic1eq;
        ic2eq = 2 * v2 - ic2eq;

        phase += (START_HZ * 0.6 * (END_HZ / START_HZ) ** local) / rate;
        if (phase > 1) phase -= Math.floor(phase);
        const value = v1 * amplitude + Math.sin(2 * Math.PI * phase) * amplitude * 0.22;

        left[i] = (left[i] ?? 0) + value;
        right[i] = (right[i] ?? 0) + value;
      }
    }
  });
}
