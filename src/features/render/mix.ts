import type { Score, ScoreTrack, TrackDelay } from '../score/feature.ts';
import { throwIfAborted } from './abort.ts';
import { applyAutomatedLowpass } from './filters.ts';

const DUCK_ATTACK_SECONDS = 0.005;
const DUCK_RELEASE_SECONDS = 0.11;
const DELAY_PASSES = 3;
const OPEN_CUTOFF_HZ = 20000;

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

/** One constant-pan/send span for a track inside a section. */
export interface TrackSectionSegment {
  readonly start: number;
  readonly end: number;
  readonly pan: number;
  readonly send: number;
}

/** True when any section sets a send for this track, even if its base send is 0. */
export function hasSectionSend(score: Score): boolean {
  return score.sections.some((section) =>
    Object.values(section.trackStates ?? {}).some((state) => (state.send ?? 0) > 0),
  );
}

/** True when this track needs per-section pan, send, or filter automation. */
export function hasSectionTrackAutomation(score: Score, track: ScoreTrack): boolean {
  return score.sections.some((section) => {
    const state = section.trackStates?.[track.name];
    return (
      state !== undefined &&
      (state.pan !== undefined || state.send !== undefined || state.filter !== undefined)
    );
  });
}

/**
 * Splits one track's sample buffer into section spans with the pan/send that
 * apply there. A song tail keeps the last section's mix state; loop mode has no
 * sections, so it returns one span with the track defaults.
 */
export function sectionTrackSegments(
  score: Score,
  track: ScoreTrack,
  rate: number,
  totalSamples: number,
): readonly TrackSectionSegment[] {
  if (score.sections.length === 0) {
    return [{ start: 0, end: totalSamples, pan: track.pan, send: track.send }];
  }

  const segments: TrackSectionSegment[] = [];
  let cursor = 0;
  for (const section of score.sections) {
    const end = Math.min(
      totalSamples,
      Math.max(cursor, Math.round((section.startSeconds + section.durationSeconds) * rate)),
    );
    if (end > cursor) {
      const state = section.trackStates?.[track.name];
      segments.push({
        start: cursor,
        end,
        pan: state?.pan ?? track.pan,
        send: state?.send ?? track.send,
      });
    }
    cursor = end;
  }

  if (cursor < totalSamples) {
    const last = score.sections[score.sections.length - 1];
    const state = last?.trackStates?.[track.name];
    segments.push({
      start: cursor,
      end: totalSamples,
      pan: state?.pan ?? track.pan,
      send: state?.send ?? track.send,
    });
  }
  return segments;
}

/**
 * Applies the per-section track low-pass to one track buffer. This is a track
 * insert, not the section-wide filter on the summed mix: only this track is
 * affected, and a section without a track filter stays open. The filter state
 * crosses section boundaries, so a sweep into a drop does not click.
 */
export function applyTrackSectionFilter(
  samples: Float32Array,
  score: Score,
  track: ScoreTrack,
  rate: number,
): void {
  const sections = score.sections;
  if (
    !sections.some((section) => section.trackStates?.[track.name]?.filter !== undefined)
  ) {
    return;
  }

  let sectionIndex = 0;
  const cutoffAt = (index: number): number => {
    while (sectionIndex + 1 < sections.length) {
      const next = sections[sectionIndex + 1];
      if (next === undefined || index < Math.round(next.startSeconds * rate)) break;
      sectionIndex += 1;
    }
    const section = sections[sectionIndex];
    if (section === undefined) return OPEN_CUTOFF_HZ;
    const filter = section.trackStates?.[track.name]?.filter;
    if (filter === undefined) return OPEN_CUTOFF_HZ;
    const start = section.startSeconds * rate;
    const length = Math.max(1, section.durationSeconds * rate);
    const progress = Math.min(1, Math.max(0, (index - start) / length));
    const end = filter.toHz ?? filter.fromHz;
    const energyFactor = 0.35 + 0.65 * (section.energy ?? 1);
    return filter.fromHz * energyFactor * (end / filter.fromHz) ** progress;
  };

  applyAutomatedLowpass(samples, cutoffAt, rate);
}
