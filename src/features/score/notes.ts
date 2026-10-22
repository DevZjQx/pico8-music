import type { DrumName, Effect, Waveform } from './types.ts';

export const WAVEFORM_NAMES = [
  'triangle',
  'tilted_saw',
  'saw',
  'square',
  'pulse',
  'organ',
  'noise',
  'phaser',
] as const;

export const EFFECT_NAMES = [
  'none',
  'slide',
  'vibrato',
  'drop',
  'fadein',
  'fadeout',
  'arpfast',
  'arpslow',
] as const;

/** Accepts `tilted-saw`, `Tilted Saw`, and `tiltedsaw` alike. */
export function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function parseWaveform(value: unknown): Waveform | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7) {
    return value as Waveform;
  }
  if (typeof value !== 'string') return undefined;
  const name = normaliseName(value);
  const index = WAVEFORM_NAMES.indexOf(name as (typeof WAVEFORM_NAMES)[number]);
  return index === -1 ? undefined : (index as Waveform);
}

export function parseEffect(value: string): Effect | undefined {
  const name = normaliseName(value);
  if (name === 'fade_in') return 4;
  if (name === 'fade_out') return 5;
  if (name === 'arp_fast') return 6;
  if (name === 'arp_slow') return 7;
  if (name === 'vib') return 2;
  const index = EFFECT_NAMES.indexOf(name as (typeof EFFECT_NAMES)[number]);
  return index === -1 ? undefined : (index as Effect);
}

const NOTE_RE = /^([a-g])([#b]?)(-?\d{1,2})$/i;
const SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** `C4` → 60, `F#3` → 54, `Bb2` → 46. Returns undefined for anything else. */
export function parseNoteName(name: string): number | undefined {
  const match = NOTE_RE.exec(name.trim());
  if (!match) return undefined;
  const letter = (match[1] ?? '').toLowerCase();
  const accidental = match[2] ?? '';
  const octave = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isFinite(octave)) return undefined;
  const semitone = SEMITONES[letter];
  if (semitone === undefined) return undefined;
  const midi = (octave + 1) * 12 + semitone + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  return Number.isFinite(midi) ? midi : undefined;
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** `60` → `C4`, `66` → `F#4`. Used when a motif transform rewrites pitches. */
export function formatNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const octave = Math.floor(rounded / 12) - 1;
  const name = SHARP_NAMES[((rounded % 12) + 12) % 12];
  return `${name}${octave}`;
}

const DRUM_ALIASES: Record<string, DrumName> = {
  k: 'kick',
  kick: 'kick',
  bd: 'kick',
  bassdrum: 'kick',
  s: 'snare',
  snare: 'snare',
  sd: 'snare',
  h: 'hat',
  hat: 'hat',
  hh: 'hat',
  closedhat: 'hat',
  o: 'openhat',
  openhat: 'openhat',
  oh: 'openhat',
  c: 'clap',
  clap: 'clap',
  cp: 'clap',
  t: 'tom',
  tom: 'tom',
  r: 'rim',
  rim: 'rim',
  x: 'crash',
  crash: 'crash',
  cymbal: 'crash',
};

const DRUM_MIDI: Record<DrumName, number> = {
  kick: 36,
  snare: 38,
  clap: 39,
  rim: 37,
  hat: 42,
  openhat: 46,
  tom: 45,
  crash: 49,
};

/** `K`, `kick`, `Open-Hat` → canonical drum name. */
export function parseDrumName(value: string): DrumName | undefined {
  return DRUM_ALIASES[normaliseName(value).replace(/_/g, '')];
}

/** Nominal MIDI key used for drum events and deterministic noise seeds. */
export function drumMidiOf(name: DrumName): number {
  return DRUM_MIDI[name];
}

/** PICO-8 pitch key for the noise timbre's brightness curve. */
export function picoKeyOf(midi: number): number {
  return Math.min(63, Math.max(0, midi - 36));
}
