/**
 * Normalised form of a model-authored score.
 *
 * The wire format is deliberately small: a handful of tracks, each a token
 * pattern such as `"C3:4 E3:4 G3:8 -:4"`. Everything here is the validated,
 * absolute-step form the renderer consumes.
 */

/** PICO-8 waveform index: 0 triangle … 7 phaser. */
export type Waveform = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** PICO-8-style note effect index: 0 none … 7 arp slow. */
export type Effect = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Loop repeats one pattern; song follows an arrangement of sections. */
export type ScoreMode = 'loop' | 'song';

/** Drum voices are synthesised from transients, not from the eight waveforms. */
export type DrumName =
  | 'kick'
  | 'snare'
  | 'hat'
  | 'openhat'
  | 'clap'
  | 'tom'
  | 'rim'
  | 'crash';

/**
 * Amplitude shape shared by every note in a track, in seconds except
 * `sustain`, which is a 0..1 level. Release is measured backwards from the
 * end of the note's authored steps, so a note never rings past its slot.
 */
export interface Envelope {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

/**
 * Parameters for the effects that accept them. Omitted fields use the
 * historical PICO-8-style defaults, so `~vibrato` sounds unchanged.
 */
export interface EffectParams {
  /** Vibrato peak deviation in semitones, 0..2. Default 0.5. */
  readonly vibratoDepth?: number;
  /** Vibrato LFO rate in Hz, 0.1..20. Default 7.5. */
  readonly vibratoRate?: number;
  /** Slide time in steps, 0.05..8. Default 1: reach the target in one step. */
  readonly slideSteps?: number;
}

/** Per-track low-pass with optional resonance and a cutoff LFO. */
export interface TrackFilter {
  /** Base cutoff in Hz. */
  readonly cutoffHz: number;
  /** Filter Q; 0.707 is flat, up to 20 for an acid peak. */
  readonly resonance: number;
  /** Cutoff LFO rate in Hz; 0 disables the LFO. */
  readonly lfoHz: number;
  /** Cutoff LFO depth in octaves around `cutoffHz`, 0..4. */
  readonly lfoDepth: number;
}

/** Per-track feedback delay, timed in score steps. */
export interface TrackDelay {
  readonly steps: number;
  readonly feedback: number;
  readonly mix: number;
}

export interface NoteEvent {
  /** Absolute step inside the loop or song. */
  readonly step: number;
  /** Slot length in steps; this is what advances the pattern cursor. */
  readonly steps: number;
  /** Sounding length in steps; defaults to `steps`. Longer than the slot means legato. */
  readonly gateSteps?: number;
  /** Voice index inside a chord; defaults to 0. Used to slide from the same voice. */
  readonly voice?: number;
  /** MIDI note number; C4 = 60. Drum voices use a nominal key. */
  readonly midi: number;
  /** Precomputed equal-tempered frequency in Hz. */
  readonly frequency: number;
  readonly effect: Effect;
  /** PICO-8-style per-note volume 0..7; `@volume` overrides the track default. */
  readonly volume: number;
  /** Present only when the token used a parameterised effect such as `~vib(0.4,6)`. */
  readonly effectParams?: EffectParams;
  /** Resolved from a `~name` suffix and the score-level `envelopes` table. */
  readonly envelope?: Envelope;
  /** Present only on drum tracks. */
  readonly drum?: DrumName;
  /** Section gain multiplier; defaults to 1 when absent. */
  readonly gain?: number;
}

/** One named pattern inside a track. */
export interface TrackPattern {
  /** Length of one repetition of this pattern, in steps. */
  readonly patternSteps: number;
  /** Pattern-local steps; the renderer places them at an absolute offset. */
  readonly events: readonly NoteEvent[];
}

export interface ScoreTrack {
  /** Stable identity for arrangement overrides; defaults to `track0`, `track1`, … */
  readonly name: string;
  /** Musical role, e.g. `drums`, `bass`, `lead`, `pad`; defaults to `melodic`. */
  readonly role: string;
  readonly isDrums: boolean;
  readonly waveform: Waveform;
  /** 0..7, the default per-note volume when a token has no `@volume` suffix. */
  readonly volume: number;
  /** ADSR applied to every note in the track. Drum hits ignore it. */
  readonly envelope: Envelope;
  /** Length of one repetition of the authored default pattern, in steps. */
  readonly patternSteps: number;
  /** Sorted by step; pattern repetitions are expanded by the renderer in loop mode. */
  readonly events: readonly NoteEvent[];
  /** Named patterns available to arrangement sections. */
  readonly patterns: Readonly<Record<string, TrackPattern>>;
  /** Absolute events for song mode; absent in loop mode. */
  readonly timeline?: readonly NoteEvent[];
  /** -1 (left) .. 1 (right); 0 keeps the track centred. */
  readonly pan: number;
  /** 0..1 send into the track-send reverb bus. */
  readonly send: number;
  /** 0..1 sidechain depth triggered by kick hits. */
  readonly duck: number;
  readonly filter?: TrackFilter;
  readonly delay?: TrackDelay;
}

/** A resolved arrangement section with absolute step bounds. */
export interface ScoreSection {
  readonly name: string;
  readonly startStep: number;
  readonly steps: number;
  /** Section-wide low-pass cutoff in Hz; absent means no section filter. */
  readonly filterHz?: number;
  /** Sweep target in Hz; when present the cutoff glides from `filterHz` to this. */
  readonly filterEndHz?: number;
}

export interface Score {
  readonly mode: ScoreMode;
  readonly bpm: number;
  readonly stepsPerBeat: number;
  readonly bars: number;
  readonly totalSteps: number;
  readonly stepSeconds: number;
  readonly durationSeconds: number;
  /** 0..0.5; odd steps are delayed by this fraction of a step. */
  readonly swing: number;
  /** Deterministic variation seed for noise timbres and drum transients. */
  readonly seed: number;
  readonly tracks: readonly ScoreTrack[];
  /** Empty in loop mode; contiguous and ordered in song mode. */
  readonly sections: readonly ScoreSection[];
  /** Parse-time advisories that are not fatal, e.g. a pattern that does not fill the section. */
  readonly warnings: readonly string[];
}
