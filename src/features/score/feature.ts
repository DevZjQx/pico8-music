// Owns: the model-authored score format and its validation.
// Errors: throws ScoreError with the failing field path and the received value.
// Does not own: synthesis, tempo decisions, or audio output — the render feature
// consumes the normalised Score produced here.
export { parseScore, ScoreError } from './parse.ts';
export { SCORE_BRIEF, SCORE_HELP } from './help.ts';
export { EFFECT_NAMES, WAVEFORM_NAMES } from './notes.ts';
export type {
  DrumName,
  Effect,
  EffectParams,
  Envelope,
  NoteEvent,
  Score,
  ScoreMode,
  ScoreSection,
  ScoreTrack,
  TrackDelay,
  TrackFilter,
  TrackPattern,
  Waveform,
} from './types.ts';
