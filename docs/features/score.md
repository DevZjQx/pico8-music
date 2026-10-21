# score

**Purpose.** Define the short piece the model composes, in a form that is cheap
to author and cheap to reject.

**Owns.** The JSON wire format, note-name and drum-token parsing, waveform and
effect names, per-note volume (`@volume`), track and named ADSR envelopes,
slot vs gate (`C4:4g2`), explicit and named chords (`[C4,E4,G4]`, `Cmaj7`,
`Fm/E`, `{C7}`), parameterised effect suffixes (`~vib(0.4,6)`, `~slide(0.5)`),
score-level `swing` and `seed`, motif definitions and transforms
(`@A.transpose(2).retrograde`), drum articulations (`~ghost`, `~flam(ms)`,
`~roll(hits)`) and per-hit drum parameters (`~pitch`, `~decay`, `~tone`), the
top-level `instruments` table and per-track `instrument` references, loop vs
song mode, named patterns, arrangement
resolution (sections, mute, gain, filter and filter sweeps, `energy`, and
`fill` pattern replacement), the mix-stage
fields a track exposes (`pan`, `send`, `duck`, `filter`, `delay`), the
model-facing DSL reference (`help.ts`), and the normalised `Score` the renderer
consumes.

**Does not own.** How anything sounds. Tempo becomes seconds here, but the
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
`key`/`scale`, voice leading, humanise, and tuplets remain deferred: tuplets
would turn the integer step grid into a fractional one across parse,
arrangement, and loop seams. Drum articulations are parsed into a `DrumEffect`
on the event instead of DSP parameters, so a motif transform can carry them
without knowing how they sound; per-hit pitch/decay/tone travel separately as
`DrumParams`, so they compose with `~ghost`/`~flam`/`~roll` instead of competing
for the one articulation slot. `instrument` accepts a name, an inline object,
and the built-in `chip`/`fm`/`additive`/`drums` shorthands, which keeps old
`{type: "chip", waveform}` scores valid. An additive harmonic is a bare
amplitude, a negative amplitude (the same wave mirrored), or
`[amplitude, phaseDegrees]`; the parser folds signs into phases, so the render
side only ever sees magnitudes and phases and a score can design a shape
(25% pulse, stepped harmonics) that no real-valued amplitude series reaches.
Signs are kept rather than clamped because `0` and `-0.3` are different shapes,
not a range error.

**Boundary evidence.** Deleting this folder breaks `render/feature.ts`,
`app/render-service.ts`, and therefore both host adapters; the syntax rules
live in one parser, so a second authoring format would be an additive change
here, not a change to synth or DSP code.
