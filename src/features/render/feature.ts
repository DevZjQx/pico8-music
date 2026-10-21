// Owns: turning a normalised Score into a WAV (seamless loop or arranged song),
// the post/master chain, and the measurements reported for the finished audio.
// Errors: throws Error for an unknown preset/style or an impossible render request.
// Does not own: score validation or note naming — the score feature decides
// what a score is; this feature only consumes it.
export { renderLoop } from './render.ts';
export { analyseAudio, formatReport, sectionEnergies } from './analyze.ts';
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
export type { PresetName } from './presets.ts';
export type { StyleName, PostStep, RenderOptions, RenderOutput } from './types.ts';
export type { Analysis, BandEnergy, SectionReading } from './analyze.ts';
