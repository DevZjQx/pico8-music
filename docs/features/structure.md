# structure

**Purpose.** Answer the composition questions that a finished mix cannot: how
busy is each bar, how does the melody move and repeat, and which parts share a
register. These are facts about the score, so they are exact, cheap, and
attributable to a bar and a track — the same reasons a per-frame audio heatmap
was rejected.

**Owns.** The symbolic reading attached to a render report: the bar grid
(`attacks`, `drumHits`, `notes`, distinct `steps` per bar, plus the section
name), the whole-score pitch-class count and entropy, per-track
notes/attacks/voices per attack, sounding range, pitch-class entropy, melodic
interval shares (stepwise, leap, repeated), largest interval, and the share of
bars that restate an earlier bar, per-section attack/drum/note density with the
busiest and quietest bar, and the list of track pairs whose sounding ranges
overlap by at least an octave inside a section. It also owns the decision to
keep only the four widest register pairs per section. The definitions:

- A **chord counts as one attack** but every chord voice is a note. `~roll` and
  `~flam` expand into their real attack counts, because a rolled bar is not
  sparser than a plain one.
- **Intervals are per voice**, so a chord cannot invent a leap between its own
  voices. Stepwise is 1-2 semitones, a leap is 5 or more; 3-4 semitones are
  neither, which is why the two shares need not add up.
- **Entropy is over pitch classes, weighted by note count**, in bits; the
  normalised value divides by log2(12). It is reported per track, but the
  `melody-static` judgement uses the whole arrangement's distribution: a
  two-note bass ostinato is idiomatic, a score whose every part together uses
  two notes is the symptom.
- **Repetition** is per track and exact: two bars match when the steps and
  pitches (or steps and drum voices) are identical. A loop is measured once, so
  the output's implicit repeats never inflate or deflate the rate.
- **Register overlap** compares the lowest and highest sounding note of two
  melodic tracks within one section. Pitch classes that both use are counted
  separately; the pair is kept at one octave of overlap so the raw artifact has
  the fact even when it is not a finding.
- **Harmony is a bass reading, not a chord analysis.** The bass of a bar is the
  lowest sounding pitch class in that bar, so an arpeggio reads as its bottom
  note and a note that sustains past the bar line still counts for the bar it
  rings in. `changes` counts bar-to-bar bass moves and skips silent bars; a
  section boundary is not a change. `fifths` is the share of moves by 5 or 7
  semitones, `seconds` the share by 1, 2, 10, or 11, and `largest` the widest
  move folded to 0-6. No chord quality, inversion, or function is claimed,
  because the score stores notes rather than symbols and one bar of voicing
  cannot distinguish, say, an Am7 from a C6.
- **The key is declared, never inferred.** `inKey` is the share of melodic notes
  whose pitch class sits in the declared key's diatonic major or natural minor
  scale; `chromatic` is the accidentals used, most frequent first. Harmonic and
  melodic minor count as chromatic. Without a `key` field there is no in-key
  share at all: a key-finding estimate would put a guess inside a report line
  that reads like a measurement.

**Does not own.** Parsing, validation, arrangement resolution, or the timeline
expansion — those are `score`'s. Judgement: thresholds, finding wording, and
report text live in `render/analyze.ts`, next to every other finding, so
"measurement" and "advice" stay in one place. Audio measurement is `render`'s;
perceived density and register crowding remain `onsets` and stem spectra.

**Depends on.** `score` through its public entry, for `Score`, `ScoreTrack`,
`timelineOf`, and `sectionAtStep`. Nothing else.

**Public surface.** `feature.ts` only: `analyseScore(score)` plus the reading
types. The render feature calls it and attaches the result to `Analysis`.

**Owner.** Unassigned.

**Rejected.** An audio heatmap (per-frame time × band matrix) or a rendered
image: the consumer is a model, the matrix cannot say which track or knob
caused a cell, every finding in this project must carry a `next` move, and the
numbers would be pushed into every report's token budget. A per-bar text grid in
the default summary was rejected for the same reason; it lives in the
`detail: "raw"` artifact instead. Audio-based density was rejected because the
score already knows the notes exactly: measuring them again from the mix is
lossy and cannot attribute a bar to a track. A single "density score" is
rejected on the same grounds as every other total score — it would be optimised
into Goodhart's law.
A chord recogniser (template matching per bar) is rejected for the same reason a
key estimator is: it reports an inference with the same formatting as a
measurement, and a wrong chord symbol is worse than an honest bass note. A
"tension" or "surprisal" curve is rejected as a total score for the reason above
and because the listener model that would produce it is the same model being
graded; `docs/expectation-theory.md` records that argument and the studies it
came from.

**Boundary evidence.** Deleting this folder leaves `render` with a report that
still measures audio, but `Analysis.structure`, the five `report` lines
(`bars`, `density`, `structure`, `register`, `harmony`), and the seven structure
finding kinds disappear. No DSP output changes: the feature never touches a
sample.
