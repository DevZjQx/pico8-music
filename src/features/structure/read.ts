import {
  sectionAtStep,
  timelineOf,
  type NoteEvent,
  type Score,
  type ScoreKey,
  type ScoreSection,
} from '../score/feature.ts';
import type {
  BarReading,
  DeclaredKeyReading,
  HarmonyReading,
  RegisterOverlap,
  SectionDensity,
  SectionHarmony,
  StructureReading,
  TrackStructure,
} from './types.ts';

/** Keep the raw register list bounded on a long song. */
const MIN_OVERLAP_OCTAVES = 1;
const MAX_REGISTER_PAIRS_PER_SECTION = 4;
/** A 64-bar section of one-bar chords needs 64 roots; keep the artifact smaller. */
const MAX_HARMONY_ROOTS_PER_SECTION = 12;
/** A key has five accidentals at most, so this cap never truncates a real list. */
const MAX_CHROMATIC_CLASSES = 5;

const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

/** Diatonic major and natural minor; melodic/harmonic minor stay chromatic. */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] as const;

function scaleOf(key: ScoreKey): Set<number> {
  const degrees = key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  return new Set(degrees.map((degree) => (degree + key.tonic) % 12));
}

function nameOfPitchClass(pitchClass: number): string {
  return PITCH_CLASS_NAMES[((pitchClass % 12) + 12) % 12] ?? 'C';
}

/**
 * A drum articulation can be more than one attack: a `~roll` subdivides its
 * slot and a `~flam` adds a grace note. Counting them keeps a bar with rolls
 * from reading as sparser than a bar with plain hits.
 */
function drumAttacks(event: NoteEvent): number {
  const effect = event.drumEffect;
  if (effect === undefined) return 1;
  if (effect.kind === 'roll') return Math.max(1, effect.hits);
  if (effect.kind === 'flam') return 2;
  return 1;
}

interface BarCounter {
  attacks: number;
  drumHits: number;
  notes: number;
  steps: Set<number>;
}

interface BarEntry {
  attacks: number;
  signature: string[];
}

interface SectionRange {
  low: number;
  high: number;
  classes: Set<number>;
}

function shareOf(intervals: readonly number[], test: (interval: number) => boolean): number {
  if (intervals.length === 0) return 0;
  let count = 0;
  for (const interval of intervals) if (test(interval)) count += 1;
  return count / intervals.length;
}

/**
 * Reads a normalised score without touching audio. The timeline comes from
 * `score`'s own expansion, so a loop is measured once (not once per output
 * repeat) and a song is measured on its absolute arrangement.
 */
export function analyseScore(score: Score): StructureReading {
  const stepsPerBar = Math.max(1, score.stepsPerBeat * score.beatsPerBar);
  const barCount = Math.max(1, Math.round(score.totalSteps / stepsPerBar));
  const bars: BarCounter[] = Array.from({ length: barCount }, () => ({
    attacks: 0,
    drumHits: 0,
    notes: 0,
    steps: new Set<number>(),
  }));

  const sectionIndex = new Map<ScoreSection, number>();
  score.sections.forEach((section, index) => sectionIndex.set(section, index));
  const indexAtStep = (step: number): number => {
    const section = sectionAtStep(score, step);
    return section === undefined ? 0 : (sectionIndex.get(section) ?? 0);
  };
  const nameOfSection = (index: number): string => score.sections[index]?.name ?? 'loop';
  const sectionRanges = new Map<number, Map<string, SectionRange>>();
  const allPitchClasses = new Map<number, number>();
  const tracks: TrackStructure[] = [];
  // Harmony is read from the whole arrangement, so simultaneous notes from
  // different tracks meet here rather than inside one track's loop.
  const melodic: { step: number; gate: number; midi: number }[] = [];
  const declaredKey = score.key;
  const keyScale = declaredKey === undefined ? undefined : scaleOf(declaredKey);
  const chromatic = new Map<number, number>();
  let inKeyNotes = 0;
  let outsideNotes = 0;

  for (const track of score.tracks) {
    const events = [...timelineOf(score, track)].sort(
      (a, b) => a.step - b.step || a.midi - b.midi,
    );
    const trackBars = new Map<number, BarEntry>();
    const voiceMidis = new Map<number, number[]>();
    const pitchClasses = new Map<number, number>();
    let attacks = 0;
    let notes = 0;
    let outside = 0;
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    let lastAttackStep = -1;

    for (const event of events) {
      const barIndex = Math.floor(event.step / stepsPerBar);
      const bar = bars[barIndex];
      if (bar === undefined) continue;
      const offset = event.step - barIndex * stepsPerBar;
      const entry = trackBars.get(barIndex) ?? { attacks: 0, signature: [] };
      trackBars.set(barIndex, entry);
      bar.steps.add(offset);

      if (track.isDrums) {
        const hits = drumAttacks(event);
        bar.attacks += hits;
        bar.drumHits += hits;
        entry.attacks += hits;
        entry.signature.push(`${offset}:${event.drum ?? 'hit'}`);
        attacks += hits;
        continue;
      }

      // A chord is several events on one step but one rhythmic attack. The
      // timeline is sorted, so comparing with the previous step is enough.
      if (event.step !== lastAttackStep) {
        bar.attacks += 1;
        entry.attacks += 1;
        attacks += 1;
        lastAttackStep = event.step;
      }
      bar.notes += 1;
      notes += 1;
      entry.signature.push(`${offset}:${event.midi}`);

      const pitchClass = ((event.midi % 12) + 12) % 12;
      pitchClasses.set(pitchClass, (pitchClasses.get(pitchClass) ?? 0) + 1);
      allPitchClasses.set(pitchClass, (allPitchClasses.get(pitchClass) ?? 0) + 1);
      melodic.push({
        step: event.step,
        gate: Math.max(1, event.gateSteps ?? event.steps),
        midi: event.midi,
      });
      if (keyScale !== undefined) {
        if (keyScale.has(pitchClass)) {
          inKeyNotes += 1;
        } else {
          outsideNotes += 1;
          outside += 1;
          chromatic.set(pitchClass, (chromatic.get(pitchClass) ?? 0) + 1);
        }
      }
      if (event.midi < lowest) lowest = event.midi;
      if (event.midi > highest) highest = event.midi;

      const voice = event.voice ?? 0;
      const midis = voiceMidis.get(voice) ?? [];
      midis.push(event.midi);
      voiceMidis.set(voice, midis);

      const section = indexAtStep(event.step);
      const byTrack = sectionRanges.get(section) ?? new Map<string, SectionRange>();
      sectionRanges.set(section, byTrack);
      const range = byTrack.get(track.name) ?? {
        low: event.midi,
        high: event.midi,
        classes: new Set<number>(),
      };
      range.low = Math.min(range.low, event.midi);
      range.high = Math.max(range.high, event.midi);
      range.classes.add(pitchClass);
      byTrack.set(track.name, range);
    }

    const intervals: number[] = [];
    for (const midis of voiceMidis.values()) {
      for (let index = 1; index < midis.length; index += 1) {
        intervals.push((midis[index] ?? 0) - (midis[index - 1] ?? 0));
      }
    }

    const counts = [...pitchClasses.values()];
    const noteTotal = counts.reduce((sum, count) => sum + count, 0);
    let entropyBits = 0;
    if (noteTotal > 0) {
      for (const count of counts) {
        const probability = count / noteTotal;
        entropyBits -= probability * Math.log2(probability);
      }
    }

    const signatures = new Set(
      [...trackBars.values()].map((entry) => entry.signature.join(',')),
    );
    const playingBars = trackBars.size;

    tracks.push({
      name: track.name,
      role: track.role,
      drums: track.isDrums,
      bars: playingBars,
      attacks,
      notes,
      voicesPerAttack: attacks > 0 ? notes / attacks : 0,
      ...(track.isDrums || playingBars === 0
        ? {}
        : { lowestMidi: lowest, highestMidi: highest }),
      pitchClasses: pitchClasses.size,
      entropyBits,
      entropy: noteTotal > 0 ? entropyBits / Math.log2(12) : 0,
      stepwise: shareOf(intervals, (interval) => Math.abs(interval) <= 2),
      leaps: shareOf(intervals, (interval) => Math.abs(interval) >= 5),
      repeats: shareOf(intervals, (interval) => interval === 0),
      largestLeap: intervals.reduce(
        (largest, interval) => Math.max(largest, Math.abs(interval)),
        0,
      ),
      intervals: intervals.length,
      repeatRate: playingBars === 0 ? 0 : 1 - signatures.size / playingBars,
      ...(keyScale === undefined || noteTotal === 0 ? {} : { outside: outside / noteTotal }),
    });
  }

  const keyedNotes = inKeyNotes + outsideNotes;
  const keyReading: DeclaredKeyReading | undefined =
    declaredKey === undefined
      ? undefined
      : {
          label: declaredKey.label,
          tonic: declaredKey.tonic,
          mode: declaredKey.mode,
          inKey: keyedNotes === 0 ? 1 : inKeyNotes / keyedNotes,
          chromatic: [...chromatic.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, MAX_CHROMATIC_CLASSES)
            .map(([pitchClass]) => nameOfPitchClass(pitchClass)),
          notes: keyedNotes,
        };

  // One bass note per bar: the lowest sounding pitch class. That is a fact
  // about the texture rather than a chord guess, so an arpeggio reads as its
  // bottom note and a bass line reads as the notes it actually plays. A note
  // that sustains past the bar line still counts for the bar it rings in.
  const barBass: number[] = new Array<number>(barCount).fill(-1);
  for (const note of melodic) {
    const firstBar = Math.floor(note.step / stepsPerBar);
    const lastBar = Math.floor((note.step + note.gate - 1) / stepsPerBar);
    for (let bar = Math.max(0, firstBar); bar <= lastBar && bar < barCount; bar += 1) {
      const current = barBass[bar] ?? -1;
      if (current < 0 || note.midi < current) barBass[bar] = note.midi;
    }
  }
  const barBassClass = barBass.map((midi) =>
    midi < 0 ? -1 : (((midi % 12) + 12) % 12),
  );

  const grid: BarReading[] = bars.map((bar, index) => ({
    bar: index + 1,
    section: nameOfSection(indexAtStep(index * stepsPerBar)),
    attacks: bar.attacks,
    drumHits: bar.drumHits,
    notes: bar.notes,
    steps: bar.steps.size,
  }));

  const sectionBars = new Map<number, BarReading[]>();
  for (const row of grid) {
    const index = indexAtStep((row.bar - 1) * stepsPerBar);
    const rows = sectionBars.get(index) ?? [];
    rows.push(row);
    sectionBars.set(index, rows);
  }

  const sections: SectionDensity[] = [...sectionBars.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, rows]) => {
      const rowCount = rows.length;
      const sum = rows.reduce(
        (total, row) => ({
          attacks: total.attacks + row.attacks,
          drumHits: total.drumHits + row.drumHits,
          notes: total.notes + row.notes,
        }),
        { attacks: 0, drumHits: 0, notes: 0 },
      );
      let busiest = rows[0];
      let quietest = rows[0];
      for (const row of rows) {
        if (busiest !== undefined && row.attacks > busiest.attacks) busiest = row;
        if (quietest !== undefined && row.attacks < quietest.attacks) quietest = row;
      }
      return {
        name: nameOfSection(index),
        bars: rowCount,
        attacksPerBar: rowCount > 0 ? sum.attacks / rowCount : 0,
        drumHitsPerBar: rowCount > 0 ? sum.drumHits / rowCount : 0,
        notesPerBar: rowCount > 0 ? sum.notes / rowCount : 0,
        busiestBar: busiest?.bar ?? 1,
        busiest: busiest?.attacks ?? 0,
        quietestBar: quietest?.bar ?? 1,
        quietest: quietest?.attacks ?? 0,
      };
    });

  // Harmony moves are read bar to bar, so the rate counts changes, not spans.
  // A bar with no melodic sound is skipped rather than treated as a change.
  const bassMoves: number[] = [];
  let bassChanges = 0;
  let soundingBars = 0;
  let previousBass = -1;
  for (const bass of barBassClass) {
    if (bass < 0) continue;
    soundingBars += 1;
    if (previousBass >= 0 && bass !== previousBass) {
      bassChanges += 1;
      bassMoves.push((((bass - previousBass) % 12) + 12) % 12);
    }
    previousBass = bass;
  }

  const harmonySections: SectionHarmony[] = [...sectionBars.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, rows]) => {
      let previous = -1;
      let changes = 0;
      const bass: number[] = [];
      for (const row of rows) {
        const note = barBassClass[row.bar - 1] ?? -1;
        if (note < 0 || note === previous) continue;
        if (previous >= 0) changes += 1;
        bass.push(note);
        previous = note;
      }
      return {
        section: nameOfSection(index),
        bars: rows.length,
        changes,
        bass: bass
          .slice(0, MAX_HARMONY_ROOTS_PER_SECTION)
          .map((pitchClass) => nameOfPitchClass(pitchClass)),
        truncated: bass.length > MAX_HARMONY_ROOTS_PER_SECTION,
      };
    });

  const harmony: HarmonyReading | undefined =
    melodic.length === 0
      ? undefined
      : {
          classes: new Set(barBassClass.filter((note) => note >= 0)).size,
          soundingBars,
          changes: bassChanges,
          changesPerBar: soundingBars > 0 ? bassChanges / soundingBars : 0,
          fifths: shareOf(bassMoves, (move) => move === 5 || move === 7),
          seconds: shareOf(bassMoves, (move) => move === 1 || move === 2 || move === 10 || move === 11),
          largest: bassMoves.reduce((largest, move) => Math.max(largest, Math.min(move, 12 - move)), 0),
          sections: harmonySections,
          ...(keyReading === undefined ? {} : { key: keyReading }),
        };

  const register: RegisterOverlap[] = [];
  for (const [index, byTrack] of [...sectionRanges.entries()].sort(([a], [b]) => a - b)) {
    const ranges = [...byTrack.entries()];
    const pairs: RegisterOverlap[] = [];
    for (let a = 0; a < ranges.length; a += 1) {
      for (let b = a + 1; b < ranges.length; b += 1) {
        const first = ranges[a];
        const second = ranges[b];
        if (first === undefined || second === undefined) continue;
        const [firstTrack, firstRange] = first;
        const [secondTrack, secondRange] = second;
        const sharedSemitones =
          Math.min(firstRange.high, secondRange.high) -
          Math.max(firstRange.low, secondRange.low) +
          1;
        if (sharedSemitones <= 0) continue;
        const overlapOctaves = sharedSemitones / 12;
        if (overlapOctaves < MIN_OVERLAP_OCTAVES) continue;
        let sharedPitchClasses = 0;
        for (const pitchClass of firstRange.classes) {
          if (secondRange.classes.has(pitchClass)) sharedPitchClasses += 1;
        }
        pairs.push({
          section: nameOfSection(index),
          a: firstTrack,
          b: secondTrack,
          overlapOctaves,
          sharedPitchClasses,
        });
      }
    }
    pairs.sort((a, b) => b.overlapOctaves - a.overlapOctaves);
    register.push(...pairs.slice(0, MAX_REGISTER_PAIRS_PER_SECTION));
  }

  let attacks = 0;
  let notes = 0;
  let activeBars = 0;
  let drumBars = 0;
  for (const row of grid) {
    attacks += row.attacks;
    notes += row.notes;
    if (row.attacks > 0) activeBars += 1;
    if (row.drumHits > 0) drumBars += 1;
  }

  // Harmony is a property of the whole arrangement, not of one part: a bass
  // ostinato using two notes is normal, a score whose every part together uses
  // two notes is the case worth naming.
  const allCounts = [...allPitchClasses.values()];
  const allTotal = allCounts.reduce((sum, count) => sum + count, 0);
  let allEntropyBits = 0;
  if (allTotal > 0) {
    for (const count of allCounts) {
      const probability = count / allTotal;
      allEntropyBits -= probability * Math.log2(probability);
    }
  }

  return {
    stepsPerBar,
    bars: barCount,
    activeBars,
    drumBars,
    attacks,
    notes,
    pitchClasses: allPitchClasses.size,
    entropyBits: allEntropyBits,
    entropy: allTotal > 0 ? allEntropyBits / Math.log2(12) : 0,
    grid,
    tracks,
    sections,
    register,
    ...(harmony === undefined ? {} : { harmony }),
  };
}
