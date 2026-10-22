# score

**Purpose.** Define the short piece the model composes, in a form that is cheap
to author and cheap to reject.

**Owns.** The JSON wire format, note-name and drum-token parsing, waveform and
effect names, per-note volume (`@volume`), track and named ADSR envelopes,
slot vs gate (`C4:4g2`), explicit and named chords (`[C4,E4,G4]`, `Cmaj7`,
`Fm/E`, `{C7}`), parameterised effect suffixes (`~vib(0.4,6)`, `~slide(0.5)`),
score-level `swing` and `seed`, the grid (`stepsPerBeat`, `beatsPerBar`, and
whole-bar patterns), deterministic `humanize` timing/velocity
depths, motif definitions and transforms
(`@A.transpose(2).retrograde`), drum articulations (`~ghost`, `~flam(ms)`,
`~roll(hits)`) and per-hit drum parameters (`~pitch`, `~decay`, `~tone`), the
top-level `instruments` table and per-track `instrument` references, the
top-level `samples` table (workspace WAV paths with root/loop/gain) and
`drumSamples` replacements, loop vs song mode, named patterns, arrangement
resolution (sections, mute, gain, filter and filter sweeps, `energy`, `fill`
pattern replacement, and `riser` bars), the song-end `tail`, the mix-stage
fields a track exposes (`pan`, `send`, `duck`, `filter`, `delay`), the
model-facing DSL reference (`help.ts`), and the normalised `Score` the renderer
consumes.

**Does not own.** Reading sample WAV files: `score` validates the reference,
path shape, and playback metadata, while `app` resolves and decodes files and
`render` plays the decoded PCM. How anything sounds. Tempo becomes seconds here, but the
waveform, instrument, and drum generators, envelope *interpretation*, section
filtering, and effect curves belong to `render`; this feature only decides that an envelope
or filter exists, its fields, and their legal ranges. The DSL reference is text,
not enforcement: `parse.ts` stays the only authority, and `help.ts` must be kept
in sync with it. Reading `.p8` cartridges is out of scope: the composition is
authored by the model, not extracted from an existing cart.

**Depends on.** Nothing — this is the bottom of the import graph.

**Public surface.** `feature.ts` only; the export list is not repeated here.

**Owner.** Unassigned.

**Rejected.** A `.p8`/`__sfx__` input path: it would drag in cartridge parsing,
loop-flag semantics, and single-pattern export limitations for a project whose
input is generated JSON. A structured per-note array was rejected for the same
reason: the token pattern (`C3:4 E3:4 -:2`) is shorter for the model to emit
and validates better than 64 note objects. A full DAW-style timeline was also
rejected for M1: `arrangement` only references patterns, so the model does not
have to repeat every track's tokens for every section.

**Exceptions.** Drum tokens intentionally share letters with note names (`C`
is clap on a drum track, but `C4` is a note elsewhere). Uppercase `R` is rim;
lowercase `r` remains a rest for backwards compatibility. Named chords expand
to the same MIDI notes as the explicit form, capped at four voices. A digit
quality that is also an octave (`C7`, `C5`, `C6`, `C9`) is shadowed by the
note parser, so the brace form (`{C7}`) forces the chord reading; `G7/B` is
safe because the slash rules out a note. Envelope names may not collide with
effect or drum-articulation names, which is what keeps `~name` unambiguous. Motif pitch transforms
(`transpose`/`invert`) reject chord tokens; time/order transforms still work.
`key`/`scale`, voice leading, and tuplets remain deferred: tuplets
would turn the integer step grid into a fractional one across parse,
arrangement, and loop seams. Non-4/4 meters are expressible with
`beatsPerBar` (for example 3 for 3/4, or 6 with `stepsPerBeat: 2` for 6/8);
fractional meters and tuplets are not. Track count is a render-budget cap (1-32), not a
musical rule; `score` validates that cap together with the 256-section and
15-minute budgets, and leaves the musical shape to the model. `humanize` is carried as two depths and resolved by the renderer
against the score seed, so `score` never has to know the timing grid's sample
rate. Drum articulations are parsed into a `DrumEffect`
on the event instead of DSP parameters, so a motif transform can carry them
without knowing how they sound; per-hit pitch/decay/tone travel separately as
`DrumParams`, so they compose with `~ghost`/`~flam`/`~roll` instead of competing
for the one articulation slot. `instrument` accepts a name, an inline object,
and the built-in `chip`/`fm`/`additive`/`drums` shorthands, which keeps old
`{type: "chip", waveform}` scores valid. An additive harmonic is a bare
amplitude, a negative amplitude (the same wave mirrored),
`[amplitude, phaseDegrees]`, or `[amplitude, phaseDegrees, decaySeconds]`; the
parser folds signs into phases, so the render side only ever sees magnitudes and
phases and a score can design a shape (25% pulse, stepped harmonics) that no
real-valued amplitude series reaches. Additive voices also accept `stretch`
(0-1, inharmonic ratio) and `tilt` (0-4, spectral rolloff); these stay pure
numbers here, and the render feature owns the table-vs-per-sample decision.
Signs are kept rather than clamped because `0` and `-0.3` are different shapes,
not a range error. Sample paths are validated as workspace-relative `.wav`
strings (no absolute paths, no `..` segments) but never opened here, so the
score feature stays the bottom of the import graph and a missing file is an
app-layer I/O error. A sample instrument accepts only `type` and `sample`;
voice fields such as `unison` or `filter` are rejected instead of silently
ignored. `samples` is capped at 16 entries in the parser and 30 s/32 MB per file in
the app layer because those are render-budget limits, not composition rules.

**Boundary evidence.** Deleting this folder breaks `render/feature.ts`,
`app/render-service.ts`, and therefore both host adapters; the syntax rules
live in one parser, so a second authoring format would be an additive change
here, not a change to synth or DSP code.
