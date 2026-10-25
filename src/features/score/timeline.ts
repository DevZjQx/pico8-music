import type { NoteEvent, Score, ScoreTrack } from './types.ts';

/**
 * Expands one track into absolute steps: the arrangement's timeline in song
 * mode, or the authored pattern repeated across the loop in loop mode.
 *
 * This is the single scheduling rule. The renderer and the symbolic structure
 * reading both call it, so a per-bar report can never describe a bar the synth
 * did not play. A slot is truncated at the end of the loop or section; the gate
 * is capped at the score length but may still sustain past its slot (legato).
 * A muted song track has an empty timeline, which stays distinguishable from a
 * loop track that has no timeline at all.
 */
export function timelineOf(score: Score, track: ScoreTrack): readonly NoteEvent[] {
  if (track.timeline !== undefined) return track.timeline;
  if (track.patternSteps <= 0) return [];

  const events: NoteEvent[] = [];
  for (let repeat = 0; repeat * track.patternSteps < score.totalSteps; repeat += 1) {
    for (const event of track.events) {
      const step = event.step + repeat * track.patternSteps;
      if (step >= score.totalSteps) continue;
      const steps = Math.min(event.steps, score.totalSteps - step);
      if (steps <= 0) continue;
      events.push({
        ...event,
        step,
        steps,
        gateSteps: Math.min(event.gateSteps ?? event.steps, score.totalSteps),
      });
    }
  }
  return events;
}
