// Owns: the model-authored score format and its validation.
// Errors: throws ScoreError with the failing field path and the received value.
// Does not own: synthesis or audio output — it owns the symbolic schedule
// (steps, tempo, bars, and the absolute timeline), while render turns that
// schedule into sound.
export { parseScore, ScoreError } from './parse.ts';
export { secondsAtStep, sectionAtStep, stepSecondsAt } from './timing.ts';
export { timelineOf } from './timeline.ts';
export { SCORE_BRIEF, SCORE_HELP } from './help.ts';
export { EFFECT_NAMES, WAVEFORM_NAMES, parseNoteName } from './notes.ts';
export { DEFAULT_TUNING, TEMPERAMENT_NAMES, frequencyOf, tuningCentsOf } from './tuning.ts';
export type {
  DelayFollow,
  DrumName,
  DrumParams,
  Effect,
  EffectParams,
  Envelope,
  FmOperator,
  Humanize,
  Instrument,
  InstrumentFilter,
  InstrumentType,
  NoteEvent,
  Partial,
  SampleFileSpec,
  SampleSpec,
  SampleZone,
  SampleZonesSpec,
  Score,
  ScoreGroup,
  ScoreKey,
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
