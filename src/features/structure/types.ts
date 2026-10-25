/**
 * Symbolic structure of a score: what the notes add up to before anything is
 * rendered.
 *
 * These readings are facts about the composition — how many attacks a bar has,
 * how a melody moves, where two parts occupy the same register. They are
 * measured from the normalised score (the same absolute timeline the renderer
 * plays), so they are exact, cheap, and attributable to a bar, a track, or a
 * section. Nothing here looks at audio: perceived density and register
 * crowding are still the render report's `onsets` and `stems`.
 */

/** One bar of the loop or song, 1-based. */
export interface BarReading {
  readonly bar: number;
  /** Section name, or `loop` when the score has no arrangement. */
  readonly section: string;
  /**
   * Onset events in this bar. A chord counts once (one rhythmic attack); a
   * drum `~roll` counts each hit and a `~flam` counts its grace note.
   */
  readonly attacks: number;
  /** Drum hits in this bar, with rolls and flams expanded. */
  readonly drumHits: number;
  /** Melodic voices in this bar; chord voices are counted separately. */
  readonly notes: number;
  /** Distinct grid steps in this bar with at least one onset. */
  readonly steps: number;
}

/** Symbolic reading of one track. Pitch fields stay 0 for drum tracks. */
export interface TrackStructure {
  readonly name: string;
  readonly role: string;
  readonly drums: boolean;
  /** Bars in which the track sounds at all. */
  readonly bars: number;
  readonly attacks: number;
  readonly notes: number;
  /** Melodic voices per attack; 1 is a monophonic line, 3-4 is a chord part. */
  readonly voicesPerAttack: number;
  /** Lowest/highest MIDI note; absent on drum tracks. */
  readonly lowestMidi?: number;
  readonly highestMidi?: number;
  /** Distinct pitch classes, 0-12. */
  readonly pitchClasses: number;
  /** Shannon entropy of the pitch-class distribution, in bits (0..log2 12). */
  readonly entropyBits: number;
  /** `entropyBits` divided by log2(12), so 0 is one note and 1 is all twelve evenly. */
  readonly entropy: number;
  /** Share of consecutive intervals of 1-2 semitones. */
  readonly stepwise: number;
  /** Share of consecutive intervals of 5 or more semitones. */
  readonly leaps: number;
  /** Share of repeated notes (interval 0). */
  readonly repeats: number;
  /** Largest absolute interval in semitones. */
  readonly largestLeap: number;
  /** Number of consecutive intervals the shares above are computed from. */
  readonly intervals: number;
  /**
   * Share of the track's playing bars that restate an earlier bar exactly
   * (same steps and pitches, or same steps and drum voices).
   */
  readonly repeatRate: number;
  /**
   * Share of this track's notes outside the declared key's scale. Absent when
   * the score declares no key; 0 means every note is diatonic.
   */
  readonly outside?: number;
}

/** Aggregate rhythm of one section (or of the whole loop). */
export interface SectionDensity {
  readonly name: string;
  readonly bars: number;
  readonly attacksPerBar: number;
  readonly drumHitsPerBar: number;
  readonly notesPerBar: number;
  /** Busiest and quietest bar in the section, 1-based, first occurrence wins. */
  readonly busiestBar: number;
  readonly busiest: number;
  readonly quietestBar: number;
  readonly quietest: number;
}

/**
 * Two melodic tracks whose sounding ranges overlap inside one section. Only
 * overlaps of at least one octave are kept, and a section keeps its widest few
 * so the raw artifact stays bounded on a 256-section song.
 */
export interface RegisterOverlap {
  readonly section: string;
  readonly a: string;
  readonly b: string;
  /** Shared pitch span in octaves; 1.0 means both occupy the same twelve semitones. */
  readonly overlapOctaves: number;
  /** Pitch classes both tracks use in this section, 0-12. */
  readonly sharedPitchClasses: number;
}

/**
 * What a declared key says about the notes. Only present when the score sets
 * `key`; every other harmony field works without a tonal centre.
 */
export interface DeclaredKeyReading {
  /** The authored spelling in display form, e.g. `Am`, `F#`, `Bbm`. */
  readonly label: string;
  readonly tonic: number;
  readonly mode: 'major' | 'minor';
  /** Share of melodic notes whose pitch class is in the key's diatonic scale. */
  readonly inKey: number;
  /** Pitch classes outside that scale, most used first (at most five). */
  readonly chromatic: readonly string[];
  /** Melodic notes the share is computed from. */
  readonly notes: number;
}

/**
 * The bass a section sits on, in the order it moves. The bass of a bar is the
 * lowest sounding pitch class in that bar: a fact about the written texture, not
 * a chord analysis. An arpeggio therefore reads as its bottom note, and a bass
 * line that wanders below the root reads as the notes it actually plays. The
 * reading never claims a chord quality, an inversion, or a function, because the
 * score stores notes rather than symbols.
 */
export interface SectionHarmony {
  readonly section: string;
  readonly bars: number;
  /** Bar-to-bar bass changes inside this section; a section boundary is not one. */
  readonly changes: number;
  /** Consecutive distinct bass notes, e.g. `["A","F","C","G"]`; capped for the artifact. */
  readonly bass: readonly string[];
  /** True when `bass` was truncated to the per-section cap. */
  readonly truncated: boolean;
}

/**
 * Harmonic motion read from the score timeline: which pitch class each bar sits
 * on at the bottom of the texture, how often that changes, and how far it moves.
 */
export interface HarmonyReading {
  /** Distinct bass pitch classes across the whole score. */
  readonly classes: number;
  /** Bars with at least one sounding melodic note. */
  readonly soundingBars: number;
  /** Bar-to-bar bass changes across the score. */
  readonly changes: number;
  /** `changes` divided by `soundingBars`; 0.5 is a new bass every two bars. */
  readonly changesPerBar: number;
  /** Share of bass moves by a fourth or a fifth, the strongest tonal motion. */
  readonly fifths: number;
  /** Share of bass moves by one or two semitones. */
  readonly seconds: number;
  /** Largest bass move in semitones, 0-6; 6 is a tritone either way. */
  readonly largest: number;
  readonly sections: readonly SectionHarmony[];
  /** Present only when the score declares `key`. */
  readonly key?: DeclaredKeyReading;
}

/** The complete symbolic reading attached to a render report. */
export interface StructureReading {
  readonly stepsPerBar: number;
  readonly bars: number;
  /** Bars with at least one onset. */
  readonly activeBars: number;
  /** Bars with at least one drum hit. */
  readonly drumBars: number;
  readonly attacks: number;
  readonly notes: number;
  /** Distinct pitch classes across every melodic track, 0-12. */
  readonly pitchClasses: number;
  /** Shannon entropy of that shared distribution, in bits. */
  readonly entropyBits: number;
  /** `entropyBits` divided by log2(12); 1 is all twelve classes evenly. */
  readonly entropy: number;
  /** One entry per bar; loop mode covers the authored loop, not its repeats. */
  readonly grid: readonly BarReading[];
  readonly tracks: readonly TrackStructure[];
  readonly sections: readonly SectionDensity[];
  readonly register: readonly RegisterOverlap[];
  /** Absent only when the score has no melodic notes at all. */
  readonly harmony?: HarmonyReading;
}
