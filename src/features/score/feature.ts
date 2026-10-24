// Owns: the model-authored score format and its validation.
// Errors: throws ScoreError with the failing field path and the received value.
// Does not own: synthesis, scheduling, or audio output — it resolves tempo and
// bars to seconds, while the render feature consumes the normalised Score.
export { parseScore, ScoreError } from './parse.ts';
export { secondsAtStep, sectionAtStep, stepSecondsAt } from './timing.ts';
export { SCORE_BRIEF, SCORE_HELP } from './help.ts';
export { EFFECT_NAMES, WAVEFORM_NAMES } from './notes.ts';
export { DEFAULT_TUNING, TEMPERAMENT_NAMES, frequencyOf, tuningCentsOf } from './tuning.ts';
export type {
  DelayFollow,
  DrumName,
  DrumParams,
  Effect,
  EffectParams,
  Envelope,
  Humanize,
  Instrument,
  InstrumentFilter,
  InstrumentType,
  NoteEvent,
  Partial,
  SampleSpec,
  Score,
  ScoreGroup,
  ScoreMode,
  ScoreSection,
  SendReverb,
  SectionFilter,
  SectionTrackState,
  ScoreTrack,
  TemperamentName,
  TrackDelay,
  TrackFilter,
  TrackPattern,
  TrackShelf,
  Tuning,
  VelocityMapping,
  Waveform,
} from './types.ts';
