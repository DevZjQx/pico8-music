/**
 * Named chord tokens.
 *
 * The wire format already accepts explicit voicings (`[C4,E4,G4]`). A chord
 * name is a compact front end for the same thing: the parser expands it to
 * MIDI notes, so the renderer never sees a chord name. Qualities are capped at
 * four voices to match the explicit chord limit.
 */

import { normaliseName } from './notes.ts';

const CHORD_INTERVALS: Record<string, readonly number[]> = {
  maj: [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  '9': [0, 4, 10, 14],
  maj9: [0, 4, 11, 14],
  m9: [0, 3, 10, 14],
};

/** Spelled-out aliases; lookups are case-insensitive via `normaliseName`. */
const QUALITY_ALIASES: Record<string, string> = {
  maj: 'maj',
  major: 'maj',
  m: 'm',
  min: 'm',
  minor: 'm',
  dim: 'dim',
  diminished: 'dim',
  o: 'dim',
  aug: 'aug',
  augmented: 'aug',
  '+': 'aug',
  sus: 'sus4',
  sus2: 'sus2',
  sus4: 'sus4',
  '5': '5',
  '6': '6',
  m6: 'm6',
  '7': '7',
  dom7: '7',
  maj7: 'maj7',
  m7: 'm7',
  min7: 'm7',
  m7b5: 'm7b5',
  halfdim: 'm7b5',
  dim7: 'dim7',
  '7sus4': '7sus4',
  add9: 'add9',
  '9': '9',
  maj9: 'maj9',
  m9: 'm9',
};

const SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const ROOT_RE = /^([A-Ga-g])([#b]?)(.*)$/;
const PITCH_RE = /^([A-Ga-g])([#b]?)(-?\d{1,2})?$/;
const MAX_CHORD_NOTES = 4;
const DEFAULT_ROOT_OCTAVE = 4;

function pitchClassOf(letter: string, accidental: string): number | undefined {
  const semitone = SEMITONES[letter.toLowerCase()];
  if (semitone === undefined) return undefined;
  return semitone + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
}

interface QualityAndOctave {
  readonly quality: string;
  readonly octave: number;
}

/**
 * A quality with an optional octave before or after it: `maj7`, `Fm2`,
 * `F3m7`, `Cmaj74`. A quality-less root is only a major triad when braces or
 * a slash force the chord reading. `C7` cannot be written bare because it is
 * already note C7, so `{C7}` exists for digit qualities.
 */
function parseQualityAndOctave(
  rest: string,
  allowBareMajor: boolean,
): QualityAndOctave | undefined {
  if (rest === '') {
    return allowBareMajor ? { quality: 'maj', octave: DEFAULT_ROOT_OCTAVE } : undefined;
  }

  const full = QUALITY_ALIASES[normaliseName(rest)];
  if (full !== undefined) return { quality: full, octave: DEFAULT_ROOT_OCTAVE };

  // Also accept an octave before the quality when the remainder is a known
  // quality: `C4maj7`. The full-quality match above wins first, so `7sus4` is
  // still a quality rather than octave 7 + sus4.
  const leading = /^(-?\d{1,2})(.+)$/.exec(rest);
  if (leading) {
    const octave = Number.parseInt(leading[1] ?? '', 10);
    const canonical = QUALITY_ALIASES[normaliseName(leading[2] ?? '')];
    if (canonical !== undefined && octave >= -1 && octave <= 8) {
      return { quality: canonical, octave };
    }
  }

  // Try a one- or two-digit octave suffix; the longer head wins because the
  // one-digit attempt is checked first (`maj74` → maj7 + octave 4).
  for (const digits of [1, 2]) {
    if (rest.length < digits) continue;
    const octaveText = rest.slice(-digits);
    if (!/^-?\d+$/.test(octaveText)) continue;
    const head = rest.slice(0, -digits);
    if (head === '-') continue;
    const canonical =
      head === ''
        ? allowBareMajor
          ? 'maj'
          : undefined
        : QUALITY_ALIASES[normaliseName(head)];
    const octave = Number.parseInt(octaveText, 10);
    if (canonical !== undefined && Number.isFinite(octave) && octave >= -1 && octave <= 8) {
      return { quality: canonical, octave };
    }
  }
  return undefined;
}

/**
 * `Cmaj7`, `Fm`, `Fm2`, `Cmaj74`, `{C7}`, `Fm/E` → ascending MIDI notes.
 *
 * Bare `C` is rejected: it is most likely a note with a missing octave. A
 * slash or braces force the chord reading (`C/E`, `{C}`, `{C7}`); `parseNoteName`
 * owns the octave-qualified form (`C4`) and returns first, which is why bare
 * `C7` is the note C in octave 7.
 */
export function parseChordName(text: string): number[] | undefined {
  let trimmed = text.trim();
  let forced = false;
  if (trimmed.startsWith('{') || trimmed.endsWith('}')) {
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return undefined;
    trimmed = trimmed.slice(1, -1).trim();
    forced = true;
  }
  if (trimmed === '') return undefined;

  const slash = trimmed.indexOf('/');
  if (slash !== -1) forced = true;
  if (slash !== -1 && trimmed.indexOf('/', slash + 1) !== -1) return undefined;
  const chordPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const bassPart = slash === -1 ? undefined : trimmed.slice(slash + 1).trim();
  if (bassPart === '') return undefined;

  const match = ROOT_RE.exec(chordPart);
  if (!match) return undefined;
  const rootPc = pitchClassOf(match[1] ?? '', match[2] ?? '');
  if (rootPc === undefined) return undefined;

  const parsed = parseQualityAndOctave((match[3] ?? '').trim(), forced);
  if (parsed === undefined) return undefined;
  const intervals = CHORD_INTERVALS[parsed.quality];
  if (intervals === undefined) return undefined;

  const rootMidi = (parsed.octave + 1) * 12 + rootPc;
  const chordTones = intervals.map((interval) => rootMidi + interval);

  if (bassPart === undefined) {
    return chordTones.slice(0, MAX_CHORD_NOTES);
  }

  const bassMatch = PITCH_RE.exec(bassPart);
  if (!bassMatch) return undefined;
  const bassPc = pitchClassOf(bassMatch[1] ?? '', bassMatch[2] ?? '');
  if (bassPc === undefined) return undefined;
  const bassOctave = bassMatch[3];
  // A slash bass without an octave sits an octave below the chord root, the
  // register a bass player would use, rather than one semitone under it.
  const bassMidi =
    bassOctave !== undefined
      ? (Number.parseInt(bassOctave, 10) + 1) * 12 + bassPc
      : parsed.octave * 12 + bassPc;

  // A four-note quality plus a slash bass would exceed the voice cap. Drop the
  // fifth first, then the root, so the third and the seventh/extension survive.
  if (chordTones.length >= MAX_CHORD_NOTES) {
    const pitchClass = (midi: number) => (((midi - rootMidi) % 12) + 12) % 12;
    let drop = chordTones.findIndex((midi) => pitchClass(midi) === 7);
    if (drop === -1) drop = chordTones.findIndex((midi) => pitchClass(midi) === 0);
    if (drop !== -1) chordTones.splice(drop, 1);
  }

  const notes = [bassMidi, ...chordTones];
  notes.sort((a, b) => a - b);
  const unique = notes.filter((midi, index) => index === 0 || midi !== notes[index - 1]);
  return unique.slice(0, MAX_CHORD_NOTES);
}

export function isChordName(text: string): boolean {
  return parseChordName(text) !== undefined;
}
