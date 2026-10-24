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
 * Built-in temperaments. Each one is normalised so A stays at the score's
 * `a4` reference; the other eleven pitch classes move around it. `equal` is
 * the twelve-tone default, the rest are historical or just-intonation tables.
 * A per-note cents offset can still move A4 itself on top of that.
 */
export type TemperamentName =
  | 'equal'
  | 'just'
  | 'pythagorean'
  | 'meantone'
  | 'werckmeister3'
  | 'kirnberger3'
  | 'young';

/**
 * Absolute pitch reference for the whole score. Every note is derived from
 * `a4`, the temperament's pitch-class offset, and an optional per-note cents
 * correction, so a score can be tuned like an instrument (A=442, a stretched
 * piano, a historical temperament) instead of being locked to 12-TET at 440.
 */
export interface Tuning {
  /** A4 reference frequency in Hz, 400-480; default 440. */
  readonly a4: number;
  /** Built-in pitch-class table; default `equal`. */
  readonly temperament: TemperamentName;
  /** Per-MIDI-note cent offsets, -100..100, applied on top of the temperament. */
  readonly cents: ReadonlyMap<number, number>;
}

/**
 * Amplitude shape shared by every note in a track, in seconds except
 * `sustain`, which is a 0..1 level. Release is measured backwards from the
 * end of the authored gate, so a staccato note fades before its slot ends and
 * a legato gate (`C4:4g6`) keeps sounding into the next slot.
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

/**
 * A reusable performance shape, referenced from a token as `~name`. It is
 * expanded during parsing into the existing NoteEvent fields (gate, volume,
 * envelope, effect), so the renderer needs no articulation branch. Token
 * values always win over the articulation's defaults.
 */
export interface Articulation {
  /** Multiply the slot length; 0.05..8. A shorter gate is staccato. */
  readonly gateScale?: number;
  /** Per-note volume 0..7, one decimal allowed; `@volume` still wins. */
  readonly volume?: number;
  /** ADSR supplied to every note using this articulation. */
  readonly envelope?: Envelope;
  /** One pitched effect; a token's own `~effect` still wins. */
  readonly effect?: Effect;
  readonly effectParams?: EffectParams;
}

/**
 * Drum-only articulations. `ghost` is a quiet, shorter, darker hit; `flam`
 * doubles a hit a few milliseconds later; `roll` subdivides the slot into
 * evenly spaced hits with a deterministic velocity decay.
 */
export type DrumEffect =
  | { readonly kind: 'ghost' }
  | { readonly kind: 'flam'; readonly offsetMs: number }
  | { readonly kind: 'roll'; readonly hits: number };

/**
 * How an instrument turns a pitch into a waveform. `chip` is the historical
 * PICO-8 path; `additive` builds a band-limited harmonic table; `fm` is a
 * two-operator phase-modulation voice; `sample` plays a persisted WAV from the
 * score's `samples` table. The first three share unison, drive, and the
 * optional per-note filter envelope; `sample` keeps only the table reference.
 */
export type InstrumentType = 'chip' | 'fm' | 'additive' | 'sample';

/**
 * A persisted audio asset in the workspace. The file is read by the app layer
 * on every render (with a content cache), never by the score parser, so the
 * composition remains pure JSON.
 */
export interface SampleSpec {
  /** Workspace-relative `.wav` path; only 16-bit PCM mono/stereo is supported. */
  readonly file: string;
  /** MIDI note the file plays at its original speed; default C4 (60). */
  readonly rootMidi: number;
  /** Repeat the sample for the whole gate instead of stopping at its end. */
  readonly loop: boolean;
  /** Linear gain applied before the track mix; default 1. */
  readonly gain: number;
}

/** Per-note low-pass envelope; `envAmount` opens the cutoff in octaves. */
export interface InstrumentFilter {
  readonly cutoffHz: number;
  readonly resonance: number;
  readonly envAmount: number;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

/**
 * One harmonic of an additive table. Amplitude is a magnitude, so the sign of a
 * score-level number is folded into `phase` instead of being lost.
 */
export interface Partial {
  /** Harmonic magnitude, 0..1. */
  readonly amplitude: number;
  /** Radians; a negative score amplitude becomes π, mirroring the waveform. */
  readonly phase: number;
  /**
   * Exponential decay time constant in seconds. The harmonic starts at full
   * amplitude and fades with `exp(-seconds / decay)`; absent or 0 keeps it
   * static, which is the table path.
   */
  readonly decay?: number;
}

/**
 * Opt-in velocity-to-timbre response. Velocity already scales gain; these two
 * offsets make a harder note brighter as well. Absent or all-zero leaves the
 * historical render sample-identical.
 */
export interface VelocityMapping {
  /** Octaves the instrument filter opens at full velocity, 0-6. */
  readonly cutoffOctaves: number;
  /** Extra post-filter soft-clip drive at full velocity, 0-1. */
  readonly drive: number;
}

/**
 * A named or inline voice definition. `waveform` and `partials` apply to
 * `chip` and `additive` respectively; the FM fields only apply to `fm`.
 * Fields that do not match the type are rejected at parse time.
 */
export interface Instrument {
  readonly type: InstrumentType;
  /** Chip waveform; ignored by `fm`, `additive`, and `sample`. */
  readonly waveform: Waveform;
  /** Name in the score-level `samples` table; present only for `sample`. */
  readonly sample?: string;
  /** Additive harmonics, fundamental first; this is the model-designed shape. */
  readonly partials?: readonly Partial[];
  /**
   * Additive inharmonicity, 0..1. Harmonic n runs at
   * `n * f0 * sqrt(1 + stretch * (n^2 - 1))`, so the fundamental stays in tune
   * and upper harmonics sharpen (bell/metal). 0 is the harmonic series.
   */
  readonly stretch?: number;
  /** Additive spectral tilt, 0..4; harmonic n is scaled by `n^-tilt`. */
  readonly tilt?: number;
  readonly ratio?: number;
  readonly index?: number;
  readonly indexDecay?: number;
  /** Stacked detuned copies, 1-4. */
  readonly unison: number;
  /** Cent spacing between unison voices, 0-50. */
  readonly detuneCents: number;
  /** Post-filter soft clip, 0-1. */
  readonly drive: number;
  readonly filter?: InstrumentFilter;
  /** Velocity-to-timbre offsets; absent keeps the historical fixed response. */
  readonly velocity?: VelocityMapping;
}

/** Per-hit overrides accepted by drum tracks as `~pitch`, `~decay`, `~tone`. */
export interface DrumParams {
  /** Semitone offset applied to pitched drum components, -12..12. */
  readonly pitchSemitones?: number;
  /** Multiplies the hit's decay rate; 1 is the stock voice. */
  readonly decayScale?: number;
  /** Post-voice low-pass cutoff in Hz. */
  readonly toneHz?: number;
}

/** Per-track low-pass with optional resonance and a cutoff LFO. */
export interface TrackFilter {
  /** Base cutoff in Hz. */
  readonly cutoffHz: number;
  /** Filter Q, 0.05-20; 0.707 is flat, high values give an acid peak. */
  readonly resonance: number;
  /** Cutoff LFO rate in Hz; 0 disables the LFO. */
  readonly lfoHz: number;
  /** Cutoff LFO depth in octaves around `cutoffHz`, 0..4. */
  readonly lfoDepth: number;
}

/** A section filter: a static cutoff or an exponential `from` -> `to` sweep. */
export interface SectionFilter {
  readonly fromHz: number;
  readonly toHz?: number;
}

/**
 * Per-section mix state for one track. The parser resolves keys by track name
 * first and by role second, then stores the result under the track's name, so
 * the renderer never has to re-resolve roles.
 */
export interface SectionTrackState {
  /** Section fader, 0-4; overrides the legacy section `gains` entry. */
  readonly gain?: number;
  /** Equal-power pan, -1..1; absent keeps the track pan. */
  readonly pan?: number;
  /** Reverb send, 0..1; absent keeps the track send. */
  readonly send?: number;
  /** true mutes, false unmutes even when a section `mute` list names the track. */
  readonly mute?: boolean;
  /** Track-local low-pass, static or swept across this section. */
  readonly filter?: SectionFilter;
}

/** One RBJ shelf; `gainDb` is the shelf gain, not the band level. */
export interface TrackShelf {
  /** Corner frequency in Hz. */
  readonly hz: number;
  /** Gain in dB, -24..24; 0 is a no-op. */
  readonly gainDb: number;
}

/** Tempo reference for a step-timed delay. */
export type DelayFollow = 'base' | 'section';

/** Per-track feedback delay, timed in score steps. */
export interface TrackDelay {
  readonly steps: number;
  readonly feedback: number;
  readonly mix: number;
  /**
   * `base` keeps one echo time for the whole stem, measured at the top-level
   * bpm; `section` measures each echo on the grid of the section it lands in.
   */
  readonly follow: DelayFollow;
}

/**
 * Return settings for one named group's stereo send. The send is wet-only, so
 * there is no `wet` mix here; `room` and `damp` shape the return itself.
 */
export interface SendReverb {
  /** Room size, 0-0.98; larger is longer. */
  readonly room: number;
  /** High-frequency damping, 0-1. */
  readonly damp: number;
  /** Delay the stereo send before the comb bank, 0-200 ms. */
  readonly predelayMs?: number;
  /** High-pass the wet return, 20-1000 Hz. */
  readonly lowCutHz?: number;
  /** Low-pass the wet return, 1000-20000 Hz. */
  readonly highCutHz?: number;
  /** Slow delay modulation depth, 0-1. */
  readonly modDepth?: number;
  /** Modulation rate in Hz, 0.05-5. */
  readonly modRateHz?: number;
}

/**
 * A named subgroup. Tracks that name it are summed into one stereo buffer
 * before the group fader, pan, filter, delay, duck, and send. Each group owns
 * its own stereo send return, so groups do not share one reverb bus.
 */
export interface ScoreGroup {
  readonly name: string;
  /** Group fader, 0-4; 1 is neutral. */
  readonly gain: number;
  /** Equal-power group pan, -1..1; 0 is neutral. */
  readonly pan: number;
  /** 0..1 send from the finished group into this group's stereo return. */
  readonly send: number;
  /** 0..1 kick-triggered ducking on the summed group. */
  readonly duck: number;
  readonly filter?: TrackFilter;
  readonly highpassHz?: number;
  readonly lowShelf?: TrackShelf;
  readonly highShelf?: TrackShelf;
  readonly delay?: TrackDelay;
  /** Return reverb settings; absent uses the send defaults. */
  readonly reverb?: SendReverb;
}

/**
 * A reusable sound preset: the instrument plus the track-level sound defaults
 * a track would otherwise repeat. It deliberately holds no pattern, role, or
 * post-chain state; post remains a p8_music argument, outside the score.
 */
export interface SoundPreset {
  /** Resolved named or inline voice; absent keeps the legacy waveform path. */
  readonly instrument?: Instrument;
  /** Chip waveform default; only meaningful with chip/no instrument. */
  readonly waveform?: Waveform;
  /** Track ADSR default. */
  readonly envelope?: Envelope;
  /** Default articulation for tokens that carry no `~name`. */
  readonly articulation?: string;
  readonly volume?: number;
  readonly pan?: number;
  readonly send?: number;
  readonly duck?: number;
  readonly filter?: TrackFilter;
  readonly highpassHz?: number;
  readonly lowShelf?: TrackShelf;
  readonly highShelf?: TrackShelf;
  readonly delay?: TrackDelay;
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
  /** Precomputed frequency in Hz, already resolved through the score `tuning`. */
  readonly frequency: number;
  readonly effect: Effect;
  /** PICO-8-style per-note volume 0..7, one decimal allowed; `@volume` overrides the track default. */
  readonly volume: number;
  /** Present only when the token used a parameterised effect such as `~vib(0.4,6)`. */
  readonly effectParams?: EffectParams;
  /** Resolved from a `~name` suffix and the score-level `envelopes` table. */
  readonly envelope?: Envelope;
  /** Present only on drum tracks. */
  readonly drum?: DrumName;
  /** Present only when a drum token carries `~ghost`, `~flam`, or `~roll`. */
  readonly drumEffect?: DrumEffect;
  /** Present when a drum token carries `~pitch`, `~decay`, or `~tone`. */
  readonly drumParams?: DrumParams;
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
  /** Resolved instrument; absent keeps the historical waveform path. */
  readonly instrument?: Instrument;
  /** Named group this track is summed into; absent routes straight to the master. */
  readonly group?: string;
  /** 0..7 (one decimal allowed), the default per-note volume when a token has no `@volume` suffix. */
  readonly volume: number;
  /** ADSR applied to every note in the track. Drum hits ignore it. */
  readonly envelope: Envelope;
  /** Default articulation for tokens without a `~name`; melodic tracks only. */
  readonly articulation?: string;
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
  /** 0..1 send into this track's stereo return (its group's, or the default bus). */
  readonly send: number;
  /** Optional named return (a group) for this track's send, across groups. */
  readonly sendBus?: string;
  /** false feeds the pre-pan mono stem to the return; absent/true keeps the stereo image. */
  readonly sendStereo?: boolean;
  /** 0..1 sidechain depth triggered by kick hits. */
  readonly duck: number;
  readonly filter?: TrackFilter;
  /** 12 dB/oct high-pass, 20-4000 Hz; absent leaves the stem untouched. */
  readonly highpassHz?: number;
  /** Low shelf; absent or 0 dB leaves the stem untouched. */
  readonly lowShelf?: TrackShelf;
  /** High shelf; absent or 0 dB leaves the stem untouched. */
  readonly highShelf?: TrackShelf;
  readonly delay?: TrackDelay;
}

/** A resolved arrangement section with absolute step and time bounds. */
export interface ScoreSection {
  readonly name: string;
  readonly startStep: number;
  readonly steps: number;
  /** Tempo for this section; the top-level `bpm` is the default. */
  readonly bpm: number;
  /** Seconds per grid step at this section's tempo. */
  readonly stepSeconds: number;
  /** Absolute start time from the beginning of the song. */
  readonly startSeconds: number;
  /** Musical duration of the section in seconds. */
  readonly durationSeconds: number;
  /** Section-wide low-pass cutoff in Hz; absent means no section filter. */
  readonly filterHz?: number;
  /** Sweep target in Hz; when present the cutoff glides from `filterHz` to this. */
  readonly filterEndHz?: number;
  /** 0..1 macro that scales the section gain and filter cutoff; 1 is neutral. */
  readonly energy?: number;
  /** 0..2 multiplier on the track reverb send; 1 is neutral, 0 is dry/close. */
  readonly space?: number;
  /** 0..2 multiplier on the finished side signal; 1 is neutral, 0 collapses to mono. */
  readonly width?: number;
  /** Bars of synthesised noise sweep that end at this section's boundary. */
  readonly riserBars?: number;
  /** Per-track overrides for this section, keyed by resolved track name. */
  readonly trackStates?: Readonly<Record<string, SectionTrackState>>;
}

/**
 * Deterministic timing and velocity variation. Both depths default to 0, which
 * leaves old scores sample-identical; the variation is keyed by the score seed
 * and the event's position, so every loop pass stays identical.
 */
export interface Humanize {
  /** Maximum timing offset in milliseconds (0-150), applied in both directions. */
  readonly timingMs: number;
  /** 0..1 velocity depth; the gain varies by up to +/- 50% at 1. */
  readonly velocity: number;
}

export interface Score {
  readonly mode: ScoreMode;
  readonly bpm: number;
  readonly stepsPerBeat: number;
  /** Beats per bar; 4 is the PICO-8 default, 3 gives 3/4. */
  readonly beatsPerBar: number;
  readonly bars: number;
  readonly totalSteps: number;
  /** Seconds per step at the top-level `bpm`; also the timing of every loop-mode score. */
  readonly stepSeconds: number;
  /** Sum of the section durations in song mode, or `totalSteps * stepSeconds` in loop mode. */
  readonly durationSeconds: number;
  /** 0..0.5; odd steps are delayed by this fraction of a step. */
  readonly swing: number;
  /** Deterministic variation seed for noise timbres, drums, and humanize. */
  readonly seed: number;
  /** Deterministic timing/velocity variation; zero depths are neutral. */
  readonly humanize: Humanize;
  /** Pitch reference, temperament, and per-note corrections; 440 equal by default. */
  readonly tuning: Tuning;
  readonly tracks: readonly ScoreTrack[];
  /** Named subgroups, in declaration order; empty when no track uses one. */
  readonly groups: ReadonlyMap<string, ScoreGroup>;
  /** Empty in loop mode; contiguous and ordered in song mode. */
  readonly sections: readonly ScoreSection[];
  /** Extra seconds rendered after the last step so reverb and one-shots ring out. */
  readonly tailSeconds: number;
  /** Persisted WAV assets keyed by name; empty when the score uses none. */
  readonly samples: ReadonlyMap<string, SampleSpec>;
  /** Optional per-drum-voice sample replacements; unmapped voices stay synthetic. */
  readonly drumSamples: ReadonlyMap<DrumName, string>;
  /** Parse-time advisories that are not fatal, e.g. a pattern that does not fill the section. */
  readonly warnings: readonly string[];
}
