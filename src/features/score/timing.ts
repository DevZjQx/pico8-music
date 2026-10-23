import type { Score, ScoreSection } from './types.ts';

/**
 * Resolves the section that owns a grid position. A boundary belongs to the
 * section that starts there, so a note written on the downbeat is timed by the
 * new tempo. Loop mode has no sections and uses the score-level `bpm`.
 */
export function sectionAtStep(score: Score, step: number): ScoreSection | undefined {
  const sections = score.sections;
  if (sections.length === 0) return undefined;

  let low = 0;
  let high = sections.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const section = sections[middle];
    if (section !== undefined && step >= section.startStep) low = middle;
    else high = middle - 1;
  }
  return sections[low];
}

/** Seconds per grid step at a point on the timeline. */
export function stepSecondsAt(score: Score, step: number): number {
  return sectionAtStep(score, step)?.stepSeconds ?? score.stepSeconds;
}

/**
 * Converts an absolute step to absolute seconds using the arrangement's tempo
 * map. In loop mode this is simply `step * stepSeconds`.
 */
export function secondsAtStep(score: Score, step: number): number {
  const section = sectionAtStep(score, step);
  if (section === undefined) return step * score.stepSeconds;
  return section.startSeconds + (step - section.startStep) * section.stepSeconds;
}
