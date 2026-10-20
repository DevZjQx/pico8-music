import type { TrackDelay } from '../score/feature.ts';
import { throwIfAborted } from './abort.ts';

const DUCK_ATTACK_SECONDS = 0.005;
const DUCK_RELEASE_SECONDS = 0.11;
const DELAY_PASSES = 3;

/** Equal-power pan with unity gain at centre, so old centred scores keep their level. */
export function panGains(pan: number): readonly [number, number] {
  const clamped = Math.max(-1, Math.min(1, pan));
  const angle = ((clamped + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

/**
 * Sidechain-style ducking: every kick opens a short dip on the track. The gain
 * floor is applied to the track as a whole, including any delay tail.
 */
export function applyDuck(
  samples: Float32Array,
  kicks: readonly number[],
  depth: number,
  rate: number,
  loopSamples: number,
  wrap: boolean,
  signal?: AbortSignal,
): void {
  if (depth <= 0 || kicks.length === 0) return;
  const attackSamples = Math.max(1, Math.round(DUCK_ATTACK_SECONDS * rate));
  const releaseSamples = Math.max(1, Math.round(DUCK_RELEASE_SECONDS * rate));
  const tail = attackSamples + releaseSamples * 5;
  const gain = new Float32Array(samples.length).fill(1);

  for (const offset of kicks) {
    throwIfAborted(signal);
    for (let i = 0; i < tail; i += 1) {
      const shape =
        i < attackSamples
          ? 1 - depth * (i / attackSamples)
          : 1 - depth * Math.exp(-(i - attackSamples) / releaseSamples);
      let index = offset + i;
      if (index >= loopSamples) {
        if (!wrap) break;
        index %= loopSamples;
      }
      gain[index] = Math.min(gain[index] ?? 1, shape);
    }
  }

  for (let i = 0; i < samples.length; i += 1) {
    if ((i & 16383) === 0) throwIfAborted(signal);
    samples[i] = (samples[i] ?? 0) * (gain[i] ?? 1);
  }
}

/**
 * Feedback delay timed in steps. Loop mode runs three passes so the line is
 * already primed with the loop's tail; only the last pass is written back.
 */
export function applyDelay(
  samples: Float32Array,
  delay: TrackDelay,
  stepSeconds: number,
  rate: number,
  loopSamples: number,
  wrap: boolean,
  signal?: AbortSignal,
): void {
  const delaySamples = Math.max(1, Math.round(delay.steps * stepSeconds * rate));
  const lineLength = wrap ? loopSamples : samples.length;
  const line = new Float32Array(lineLength);
  const dry = samples.slice();
  const passes = wrap ? DELAY_PASSES : 1;
  let output = new Float32Array(samples.length);

  for (let pass = 0; pass < passes; pass += 1) {
    throwIfAborted(signal);
    output = new Float32Array(samples.length);
    for (let i = 0; i < dry.length; i += 1) {
      if ((i & 16383) === 0) throwIfAborted(signal);
      // In loop mode the delay line is the loop itself, so a delay longer than
      // the loop must fold through modulo instead of reading before index 0.
      // For a one-shot song, a delay that has not arrived yet is silence.
      const readIndex = i - delaySamples;
      const delayed =
        readIndex >= 0
          ? line[readIndex % lineLength] ?? 0
          : wrap
            ? line[((readIndex % lineLength) + lineLength) % lineLength] ?? 0
            : 0;
      const input = dry[i] ?? 0;
      line[i % lineLength] = input + delay.feedback * delayed;
      output[i] = input + delay.mix * delayed;
    }
  }

  samples.set(output);
}
