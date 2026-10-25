// Owns: turning a normalised Score into a WAV (seamless loop or arranged song),
// the post/master chain, and the measurements reported for the finished audio.
// Errors: throws Error for an unknown preset/style or an impossible render request.
// Does not own: score validation or note naming — the score feature decides
// what a score is; this feature only consumes it.
export { renderLoop } from './render.ts';
export {
  analyseAudio,
  analyseStem,
  formatReport,
  measureAudio,
  resolveSectionBounds,
  sectionReadings,
} from './analyze.ts';
export { checkAssertions, formatAssertionCheck, formatAssertionLine, resolveAssertions } from './assert.ts';
export { integratedLufs, loudnessRange, loudnessSummary, MAX_SAFE_LUFS } from './loudness.ts';
export {
  createDitherState,
  decodeWav,
  encodeWav,
  encodeWavFrames,
  encodeWavHeader,
} from './wav.ts';
export type { DitherState } from './wav.ts';
export { SampleVoice, isZoneSet, renderSampleOneShot, selectSampleSource } from './sample.ts';
export type {
  SampleBank,
  SampleBankEntry,
  SampleSource,
  SampleZone,
  SampleZoneSet,
} from './sample.ts';
export { findProbeTrack, formatProbe, probeTrack } from './probe.ts';
export { PRESETS } from './presets.ts';
export { STYLES } from './styles.ts';
export { TARGETS, isTargetName, resolveTarget } from './target.ts';
export type { PresetName } from './presets.ts';
export type { LowpassOrder, Quality, StyleName, PostStep, RenderOptions, RenderOutput } from './types.ts';
export type { TargetInput, TargetName, TargetProfile, ResolvedTarget } from './target.ts';
export type {
  FmProbeReading,
  ProbeMetrics,
  ProbeOptions,
  ProbeReading,
  ProbeSensitivity,
} from './probe.ts';
export type { AssertionCheck, AssertionProfile, AssertionReading, AssertField } from './assert.ts';
export type {
  Analysis,
  AnalysisFacts,
  BandEnergy,
  Finding,
  FindingKind,
  SectionBound,
  SectionReading,
  StemReading,
  TargetCheck,
  TargetReading,
} from './analyze.ts';
