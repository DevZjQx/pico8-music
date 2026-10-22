// Owns: turning a normalised Score into a WAV (seamless loop or arranged song),
// the post/master chain, and the measurements reported for the finished audio.
// Errors: throws Error for an unknown preset/style or an impossible render request.
// Does not own: score validation or note naming — the score feature decides
// what a score is; this feature only consumes it.
export { renderLoop } from './render.ts';
export { analyseAudio, analyseStem, formatReport, measureAudio, sectionEnergies } from './analyze.ts';
export { integratedLufs } from './loudness.ts';
export {
  createDitherState,
  decodeWav,
  encodeWav,
  encodeWavFrames,
  encodeWavHeader,
} from './wav.ts';
export type { DitherState } from './wav.ts';
export { SampleVoice, renderSampleOneShot } from './sample.ts';
export type { SampleSource } from './sample.ts';
export { PRESETS } from './presets.ts';
export { STYLES } from './styles.ts';
export { TARGETS, isTargetName, resolveTarget } from './target.ts';
export type { PresetName } from './presets.ts';
export type { Quality, StyleName, PostStep, RenderOptions, RenderOutput } from './types.ts';
export type { TargetInput, TargetName, TargetProfile, ResolvedTarget } from './target.ts';
export type {
  Analysis,
  AnalysisFacts,
  BandEnergy,
  Finding,
  FindingKind,
  SectionReading,
  StemReading,
  TargetCheck,
  TargetReading,
} from './analyze.ts';
