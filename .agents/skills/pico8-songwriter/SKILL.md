---
name: pico8-songwriter
description: Author pico8-music scores — pick loop or song form, lay out tracks, write patterns, arrange sections, choose a post chain, and revise from the render report. Use when composing or editing a score for the p8_music tool, writing a scoreFile, or fixing a score that renders wrong.
---

# PICO-8 songwriting

This file is **how to compose**: form, grid, track layout, arrangement, mix
decisions, and the revise loop. `p8_help` is the **wire format**: fields, tokens,
ranges, defaults, and every error. Read `p8_help` before writing a field this
file does not name; where they disagree, `p8_help` wins. `p8_analyze` measures a
WAV that already exists.

## Workflow

1. Pick the form: one repeating pattern set is a loop; an intro, break, or
   tempo change means a song.
2. Set the grid: bar length in steps = `stepsPerBeat * beatsPerBar` (16 at the
   defaults).
3. Write patterns in whole bars, or the parser warns `pattern-misaligned` and
   truncates the last repetition.
4. Lay out one track per part; fill the low end and the groove first.
5. Arrange: a section's `bars` should be a whole multiple of every pattern it
   uses.
6. Render, read `warnings`, then `findings`, then revise. Keep the score in a
   workspace `.json` file and pass `scoreFile`.

## Pick the form

| Form | Use when |
| --- | --- |
| loop | a groove, texture, or bed; it must survive an endless repeat |
| song | anything that develops, drops, or rests; sections restate patterns |

Loop — no `arrangement`, so `mode` defaults to `loop`:

```json
{"bpm":96,"bars":4,"tracks":[
 {"name":"bass","role":"bass","waveform":"tilted_saw","volume":6,
  "pattern":"A1:2 A1:2 C2:2 E2:2 A1:2 -:2 G1:2 -:2"},
 {"name":"lead","role":"lead","waveform":"pulse","pattern":"A3:4 C4:4 E4:4 D4:4"},
 {"name":"drums","role":"drums","pattern":"K:4 H:2 S:2 H:2 H:2 K:2 S:2"}]}
```

Song — an `arrangement` implies `"mode":"song"`:

```json
{"mode":"song","bpm":150,"patterns":{
  "drums.A":"K:4 H:2 S:2 H:2 H:2 K:2 S:2",
  "drums.B":"K:2 K:2 S:2 K:2 H:2 S:2 K:2 H:2",
  "bass.A":"A1:2 A1:2 C2:2 E2:2 A1:2 A1:2 G1:2 E1:2",
  "lead.A":"A3:4 C4:4 E4:8"},
 "tracks":[
  {"name":"drums","role":"drums","pattern":"drums.A"},
  {"name":"bass","role":"bass","waveform":"tilted_saw","pattern":"bass.A"},
  {"name":"lead","role":"lead","pattern":"lead.A"}],
 "arrangement":[
  {"name":"intro","bars":4,"mute":["drums"],"energy":0.4,"patterns":{"lead":"lead.A"}},
  {"name":"drop","bars":4,"bpm":160,"patterns":{"drums":"drums.B","bass":"bass.A","lead":"lead.A"}}]}
```

Song patterns live in the top-level `patterns` table; a section `patterns` entry
takes a name or inline tokens.

## Grid

| Token | Duration at `stepsPerBeat: 4` |
| --- | --- |
| `:1` | sixteenth |
| `:2` | eighth |
| `:4` | quarter |
| `:8` | half |
| `:16` | whole 4/4 bar |

`STEPS` is the slot; `GATE` (`g2`) is how long it sounds, so a short gate is
staccato and a long one is legato into the next slot. A rest only advances the
cursor.

- Kick on 1 and 3, snare on 2 and 4, hats on the subdivision you want felt.
- Write bass as chord roots in `:2`/`:4`, not one `:16`, or the rhythm vanishes.
- `swing` for a lilt, `humanize` for small timing/velocity drift.
- 3/4 is `beatsPerBar: 3`; 6/8 is `beatsPerBar: 6` with `stepsPerBeat: 2`.

## Track layout

One track per part or bus. A chord lives inside one track (`[C4,E4,G4]:4`),
never one track per voice.

- `role` labels the part for styles (`drums`, `bass`, `lead`, `pad`, `keys`);
  `role: "drums"` switches the track to the drum alphabet.
- Levels that mix without work: kick/snare 6, bass 6, chords 4, lead 5, colour 3.
- No `instrument` means the legacy 8-waveform chip path, the PICO-8 default.

## Drums

`role: "drums"` gives `K` kick, `S` snare, `H` closed hat, `O` open hat, `C`
clap, `T` tom, `R` rim, `X` crash; lowercase `r` is a rest. Aliases are in
`p8_help`.

```text
K:2 -:2 S:2 -:2 H:1 H:1 H:2 K:2 H:2
```

16 steps: kick and snare on eighths, hats on sixteenths.

- Hats carry the subdivision (`H:1` or `H:2`), not `H:4`.
- `~ghost` on a hat, `~flam` in a fill, `~roll` at a section edge.
- One or two kicks per bar beat a wall of `K:1`.

## Harmony and variation

- Named chords (`Am7`, `Fmaj7`, `G7/B`) for progressions; `[C4,E4,G4]:4` for a
  specific voicing or more than four notes.
- Slash bass moves the low line without adding a track.
- One or two chords per bar; change faster only at a section edge.
- Write a phrase once in `motifs`, then transform it per section:
  `@name.transpose(2)`, `.retrograde`, `.invert`, `.augment(2)`.

## Arrangement

Each section should differ in at least two of: density, low end, brightness,
register.

| Section | Typical move |
| --- | --- |
| intro | mute drums, `energy` 0.3–0.5, low `filter` or no lead |
| build | add hats or a `riser`, raise `energy`, keep the bass |
| drop | full drums, bass back, `bpm` up a few |
| break | mute drums or bass, `energy` 0.4, let reverb carry |
| outro | drop parts one at a time, add `tail` |

- `fill` replaces the last 1–2 bars of named tracks: the cheapest transition.
- `riser` takes no track and ends at the section boundary.
- Tempo changes only at boundaries; loop mode keeps one tempo, and song mode
  ignores `minutes`.

## Mix and space

| Goal | Knob |
| --- | --- |
| separate two parts | `pan` ±0.3–0.6 |
| depth without a wash | `send` 0.1–0.3 |
| kick cutting through | `duck` 0.3–0.6 on bass and pads |
| mud in one part | `highpassHz` on that part |
| darker or brighter part | `filter`, or a shelf |
| echo as rhythm | `delay` with `steps` on the grid |

Then the post chain, in this order unless you have a reason: tape/slow →
lowpass → reverb → tilt → saturate → compress → loudness → limiter. `post: []`
runs no chain, though a track's `send` still applies.

- `style` is the fast path to a chain plus role instruments (`chip`, `hitech`,
  `ambient`, `studio`, `lofi`, `soft`); `preset` is a shorter shortcut. One, not
  both.
- `width` above ~1 is mostly reverb, not size; check the report first.

## Sound design

- Keep the chip path for PICO-8 character; reach for `instrument` only for a
  specific timbre.
- `additive` designs a waveform from harmonic amplitudes (and phases, optional
  per-harmonic decay); `stretch` is bells and metal, `tilt` darkens, per-harmonic
  decay is plucks. `fm` gets bells, e-bass, metallic leads.
- `sample` plays a workspace WAV: a real voice, a field recording, a drum
  replacement. Paths are workspace-relative, never relative to the score file.
- `velocity: {cutoffOctaves, drive}` makes accents brighter; it needs an
  instrument `filter` and is rejected on sample voices.

## Revise loop

1. Fix `warnings` first (`pattern-misaligned`, `fill-misaligned`,
   `delay-base-tempo`); they are arrangement bugs, not mix bugs.
2. Read `findings` as measurements: `mud` is 150–500 Hz buildup, `harsh` is
   2–5 kHz, `masking` is two stems in one band, `dynamics` is crest factor;
   `post-*` means the chain caused it.
3. `post-delta` shows what the chain did to the dry render; when a finding
   appears only there, fix the chain, not the score.
4. Fix in order: arrangement → levels and pan → filters → reverb/delay → master.
5. `target` adds profile range checks; it reports, it is never a score to
   maximise.

## Before you render

- [ ] `mode` matches whether `arrangement` is present.
- [ ] Every pattern sums to a whole bar or a multiple of one.
- [ ] Every section's `bars` is a whole multiple of its patterns.
- [ ] Every named reference exists (pattern, motif, envelope, instrument, sample).
- [ ] Melodic tracks hold notes/chords only; drum tracks, drum tokens only.
- [ ] No tool argument (`post`, `style`, `width`, `out`, …) inside the score, and
      no mix field nested under `mix`.
- [ ] Exactly one of `score` and `scoreFile`.

Every range, default, and error is in `p8_help`.
