// Owns: the symbolic structure reading of a score — per-bar attack/note
// density, melodic range/entropy/motion/repetition, register overlaps, and the
// harmony reading (one bass note per bar, its change rate and bass motion).
// Errors: none; this is a measurement of an already-validated Score.
// Does not own: parsing or validation (score), judgement or report text
// (render), or anything about audio. Perceived density and register crowding
// remain the render report's onsets and stem spectra.
export { analyseScore } from './read.ts';
export type {
  BarReading,
  DeclaredKeyReading,
  HarmonyReading,
  RegisterOverlap,
  SectionDensity,
  SectionHarmony,
  StructureReading,
  TrackStructure,
} from './types.ts';
