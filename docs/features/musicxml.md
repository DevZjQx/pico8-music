# musicxml

**Purpose.** Turn a normalised score into an uncompressed MusicXML 4.0 partwise
document (`.musicxml`) so the composition can be opened in notation software.

**Owns.** The symbolic notation mapping: one `<part>` per track, one `<measure>`
per bar on the score's step grid, `<divisions>` = `stepsPerBeat`, a 4/4-style
`<time>` from `beatsPerBar` (with `beat-type` 4 because the grid's beat is the
quarter-note reference), the declared key as `<fifths>`/`<mode>`, section
rehearsal names and `<sound tempo>` changes, chords as `<chord/>`, notes that
cross a bar line as tied segments, rests for silent slots, drum tracks as
`<unpitched>` percussion with a `<score-instrument>` per used drum voice, and
score tuning as a fractional `<alter>`.

**Does not own.** Score parsing or validation (`score`), audio synthesis or the
post chain (`render`), and file paths, extension checks, or writes (`app`). It
also does not decide the key spelling rule beyond the score's declared `key`, and
it does not invent tuplets, dynamics, slurs, lyrics, or a second voice: the score
format does not carry those semantics.

**Depends on.** `score` through its single public entry, for the normalised
`Score`, `NoteEvent`, `ScoreTrack`, `ScoreSection`, `ScoreKey`, and `timelineOf`
(the same absolute expansion the renderer and structure reading use).

**Public surface.** `feature.ts` only; it exports `musicXmlOf` and
`MusicXmlOptions`.

**Owner.** Unassigned.

**Exceptions.** "Uncompressed MusicXML" means the plain XML document, never the
zipped `.mxl` container; the app layer only accepts an `out` path ending in
`.musicxml`. A loop is written once (`totalSteps`), not once per render repeat,
because the XML is notation, not the WAV's repetition count. `timelineOf` makes
song sections, muted tracks, pattern fills, and loop seams agree with the audio
timeline. The notated duration is the sounding gate capped at the authored slot:
`C4:4g2` leaves a rest inside its four-step slot, while a legato gate longer than
its slot is written as the slot so it cannot overlap the next note in the same
MusicXML voice. The score's gate is therefore a rhythmic hint, not a separate
performance lane. Chords share one MusicXML voice and `<chord/>`; the score has
no independent polyphonic voice per track, so one voice is the honest mapping.
Drum voices use fixed display positions and `x` noteheads for cymbals/hats; the
nominal MIDI key becomes `<midi-unpitched>` on channel 10. Section tempo
directions are emitted only in the first part, because tempo is a global
direction and repeating it per part makes some importers show duplicate marks.
The score's `bpm` remains the quarter-note reference: `stepsPerBeat` becomes
`divisions`, and `beatsPerBar` becomes the number of quarter beats. Non-4/4
meters still use `beat-type` 4, matching the score's grid rather than inferring
6/8 from `stepsPerBeat: 2`; tuplets without a matching `time-modification` are
emitted as duration-only notes. Tuning is preserved as a fractional `<alter>`
relative to 12-TET (A4=442 becomes +0.0785 on every written pitch), which keeps
temperament and per-note cents visible without pretending they are a second key
signature. Written pitch spelling prefers sharps unless the declared key has a
negative `<fifths>`, so a flat key exports flats and an undeclared key exports
the chromatic sharp spelling.

**Boundary evidence.** Deleting this folder breaks `app/render-service.ts` and
therefore both host adapters; the serializer is the only place that knows
MusicXML element order, ties, and percussion display positions.
