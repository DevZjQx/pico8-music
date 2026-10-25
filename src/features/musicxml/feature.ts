// Owns: turning a normalised Score into uncompressed MusicXML (partwise XML).
// Errors: none; the input is already a validated Score.
// Does not own: parsing the score, rendering audio, or writing files. The app
// layer chooses the path and persists the returned string.
export { musicXmlOf } from './musicxml.ts';
export type { MusicXmlOptions } from './musicxml.ts';
