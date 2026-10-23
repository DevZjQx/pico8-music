import type { Score, TrackDelay } from '../score/feature.ts';
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

  for (const rawOffset of kicks) {
    throwIfAborted(signal);
    // Humanize can push a hit before step 0. In loop mode that hit belongs at
    // the end of the loop; in a one-shot song it starts at sample 0, which is
    // also where `addDrumHits` places it.
    const offset = wrap
      ? ((rawOffset % loopSamples) + loopSamples) % loopSamples
      : Math.max(0, rawOffset);
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
 * Feedback delay timed in steps. `follow: "base"` (the default) keeps one
 * echo time for the whole stem. `follow: "section"` measures the delay on the
 * step grid at the point the echo lands, so a section tempo change re-times
 * the echoes that cross it; loop mode has one tempo, where both modes agree.
 * Loop mode runs three passes so the line is already primed with the loop's
 * tail; only the last pass is written back.
 */
export function applyDelay(
  samples: Float32Array,
  delay: TrackDelay,
  score: Score,
  rate: number,
  loopSamples: number,
  wrap: boolean,
  signal?: AbortSignal,
): void {
  const firstSection = score.sections[0];
  if (delay.follow === 'section' && !wrap && firstSection !== undefined) {
    const uniform = score.sections.every(
      (section) => section.stepSeconds === firstSection.stepSeconds,
    );
    if (!uniform) {
      applySectionDelay(samples, delay, score, rate, signal);
      return;
    }
    // A uniform tempo map needs no interpolation; keep the integer read path
    // so `follow: "section"` is exactly a constant delay at that tempo.
    applyConstantDelay(samples, delay, firstSection.stepSeconds, rate, loopSamples, wrap, signal);
    return;
  }
  applyConstantDelay(samples, delay, score.stepSeconds, rate, loopSamples, wrap, signal);
}

function applyConstantDelay(
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

/**
 * Section-following delay: at output time `t`, read the signal from `steps`
 * grid steps earlier, i.e. `secondsAtStep(stepAtTime(t) - steps)`. Both the
 * write step and the read step advance with the arrangement's tempo map, so
 * the read position is continuous and monotonic; only its rate changes at a
 * boundary, which gives a short tape-like pitch shift instead of a click.
 * Song mode only: loop mode has no sections.
 */
function applySectionDelay(
  samples: Float32Array,
  delay: TrackDelay,
  score: Score,
  rate: number,
  signal?: AbortSignal,
): void {
  const sections = score.sections;
  const starts = sections.map((section) => Math.round(section.startSeconds * rate));
  const line = new Float32Array(samples.length);
  let writeIndex = 0;
  let readIndex = 0;

  for (let i = 0; i < samples.length; i += 1) {
    if ((i & 16383) === 0) throwIfAborted(signal);
    while (writeIndex + 1 < sections.length) {
      const next = starts[writeIndex + 1];
      if (next === undefined || i < next) break;
      writeIndex += 1;
    }
    const write = sections[writeIndex];
    if (write === undefined) break;

    const seconds = i / rate;
    const writeStep = write.startStep + (seconds - write.startSeconds) / write.stepSeconds;
    const readStep = writeStep - delay.steps;

    let delayed = 0;
    if (readStep >= 0) {
      while (readIndex + 1 < sections.length) {
        const next = sections[readIndex + 1];
        if (next === undefined || readStep < next.startStep) break;
        readIndex += 1;
      }
      const read = sections[readIndex];
      if (read !== undefined) {
        const readSeconds = read.startSeconds + (readStep - read.startStep) * read.stepSeconds;
        // The read point is always earlier than `i`, so clamping the upper
        // neighbour to `i - 1` never reads a sample the loop has not written.
        const position = Math.max(0, Math.min(readSeconds * rate, i - 1));
        const whole = Math.floor(position);
        const fraction = position - whole;
        const a = line[whole] ?? 0;
        const b = whole + 1 < i ? line[whole + 1] ?? 0 : a;
        delayed = a + (b - a) * fraction;
      }
    }

    const input = samples[i] ?? 0;
    line[i] = input + delay.feedback * delayed;
    samples[i] = input + delay.mix * delayed;
  }
}
