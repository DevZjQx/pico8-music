import type { NoteEvent, Score, ScoreSection, ScoreTrack } from './types.ts';

/**
 * A section-level excerpt of a song. The renderer already speaks absolute
 * steps, so selecting whole sections and rebasing them to zero is enough: no
 * DSP path needs a time offset, and the report's section readings, filters,
 * space/width multipliers, and tempo map all follow the same derived score.
 *
 * Only song mode has sections. Loop excerpts would need a different contract
 * (there is no arrangement boundary and the seamless seam is the point), so
 * this helper rejects them instead of quietly returning a non-looping slice.
 */
export interface ScoreExcerpt {
  readonly score: Score;
  /** `drop` or `drop+break`, for the report header. */
  readonly label: string;
  readonly startStep: number;
  readonly endStep: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

function sectionBounds(index: number, section: ScoreSection): string {
  return `${index}:${section.name}`;
}

export function excerptOf(score: Score, names: readonly string[]): ScoreExcerpt {
  if (!Array.isArray(names)) {
    throw new Error('sections must be an array of section names');
  }
  if (score.mode !== 'song' || score.sections.length === 0) {
    throw new Error('sections selection needs song mode; a loop has no arrangement sections');
  }
  if (names.some((name) => typeof name !== 'string')) {
    throw new Error('sections must contain only section names');
  }
  const wanted = names.map((name) => name.trim());
  if (wanted.length === 0) throw new Error('sections must name at least one section');
  if (wanted.some((name) => name === '')) throw new Error('sections cannot contain an empty name');
  if (new Set(wanted).size !== wanted.length) {
    throw new Error(`sections contains a duplicate name: ${wanted.join(', ')}`);
  }

  const indexes = wanted.map((name) => {
    const index = score.sections.findIndex((section) => section.name === name);
    if (index < 0) {
      throw new Error(
        `unknown section ${JSON.stringify(name)}; available: ${score.sections
          .map((section, position) => sectionBounds(position, section))
          .join(', ')}`,
      );
    }
    return index;
  });

  // A non-contiguous pick would either jump backwards in time or need a new
  // transition. Both are arrangements, not excerpts, so reject them.
  for (let i = 1; i < indexes.length; i += 1) {
    if ((indexes[i] ?? 0) !== (indexes[i - 1] ?? 0) + 1) {
      throw new Error(
        `sections must be contiguous in arrangement order; got ${wanted
          .map((name, i) => `${name} (${indexes[i]})`)
          .join(' -> ')}`,
      );
    }
  }

  const firstIndex = indexes[0] ?? 0;
  const lastIndex = indexes[indexes.length - 1] ?? firstIndex;
  const first = score.sections[firstIndex];
  const last = score.sections[lastIndex];
  if (first === undefined || last === undefined) {
    throw new Error('sections resolved to an empty range');
  }

  const startStep = first.startStep;
  const endStep = last.startStep + last.steps;
  const startSeconds = first.startSeconds;
  const endSeconds = last.startSeconds + last.durationSeconds;
  const totalSteps = endStep - startStep;
  const durationSeconds = endSeconds - startSeconds;
  const stepsPerBar = Math.max(1, score.stepsPerBeat * score.beatsPerBar);
  const bars = totalSteps / stepsPerBar;
  if (!Number.isInteger(bars)) {
    // Section sizes are whole bars today; a future fractional or
    // per-section-meter arrangement must revisit this rather than round.
    throw new Error(
      `excerpt is ${totalSteps} steps, not a whole number of ${stepsPerBar}-step bars`,
    );
  }

  const selected = score.sections.slice(firstIndex, lastIndex + 1);
  const sections = selected.map((section) => ({
    ...section,
    startStep: section.startStep - startStep,
    startSeconds: section.startSeconds - startSeconds,
    ...(section.trackStates === undefined ? {} : { trackStates: section.trackStates }),
  }));

  const tracks = score.tracks.map((track) => excerptTrack(track, startStep, endStep, totalSteps));

  const excerpt: Score = {
    ...score,
    bars,
    totalSteps,
    durationSeconds,
    sections,
    tracks,
    // Warnings from sections outside the excerpt would send the model after
    // bars it is not auditioning. Keep only warnings that name a selected
    // section; global warnings have no arrangement prefix and survive.
    warnings: score.warnings.filter((warning) => {
      if (!warning.startsWith('pattern-misaligned:') && !warning.startsWith('fill-misaligned:')) {
        return true;
      }
      return selected.some((section) => warning.includes(`(${section.name})`));
    }),
  };

  return {
    score: excerpt,
    label: selected.map((section) => section.name).join('+'),
    startStep,
    endStep,
    startSeconds,
    endSeconds,
  };
}

function excerptTrack(
  track: ScoreTrack,
  startStep: number,
  endStep: number,
  totalSteps: number,
): ScoreTrack {
  if (track.timeline === undefined) return track;
  const timeline: NoteEvent[] = [];
  for (const [sourceIndex, event] of track.timeline.entries()) {
    if (event.step < startStep || event.step >= endStep) continue;
    const step = event.step - startStep;
    const remaining = totalSteps - step;
    if (remaining <= 0) continue;
    const steps = Math.min(event.steps, remaining);
    const gateSteps = Math.min(event.gateSteps ?? event.steps, totalSteps);
    if (steps <= 0 || gateSteps <= 0) continue;
    timeline.push({
      ...event,
      step,
      steps,
      ...(event.gateSteps === undefined ? {} : { gateSteps }),
      sourceIndex,
    });
  }
  return { ...track, timeline };
}
