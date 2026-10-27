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
7. For a long song, audition with `sections: ["drop","break"]` and isolate a
   part with `solo`/`mute` (track name or role). Those are auditions, not a
   final mix: an excerpt is mastered on its own, and muting a kick removes its
   ducking trigger. Re-render the whole song before judging levels.

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
- `swing` for a lilt (`swingUnit` 12 at `stepsPerBeat` 24 is eighth-note swing),
  `humanize` for small timing/velocity drift.
- For triplets, set `stepsPerBeat: 24`: 16th is `:6`, 8th-triplet `:8`,
  16th-triplet `:4`, 32nd `:3`. Keep writing named patterns; 24 PPQN makes
  every token longer, so do not spell out every 32nd by hand.
- Feeling: a track `offsetMs` sets a part's baseline, and `~drag(ms)` /
  `~push(ms)` accents one note. Stay within about 20 ms and use it on the
  snare, bass, or one lead phrase, not on every token. Both are clamped to
  half a step and the render warns when the clamp bites.
- 3/4 is `beatsPerBar: 3`; 6/8 is `beatsPerBar: 6` with `stepsPerBeat: 2`.

## Track layout

One track per part. A chord lives inside one track (`[C4,E4,G4]:4`), never
one track per voice. When several parts should share a fader, filter, or
reverb return, put them in a named `group` instead of duplicating the settings.

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
- Use `drumChoke` when an open hat should stop under a closed hat:
  `{"drumChoke":{"hat":["openhat"]}}`. Leave it out when overlapping tails are
  the sound; the default is empty.

## Harmony and variation

- Named chords (`Am7`, `Fmaj7`, `G7/B`) for progressions; `[C4,E4,G4]:4` for a
  specific voicing or more than four notes.
- An arp is a held note plus a shape: `~arpfast(0,4,7,11;0.25)` cycles the
  authored semitones and period. Use it for broken chords instead of writing
  every 16th as a separate token; keep the shape to 3-5 notes.
- Slash bass moves the low line without adding a track.
- One or two chords per bar; change faster only at a section edge.
- Write a phrase once in `motifs`, then transform it per section:
  `@name.transpose(2)`, `.retrograde`, `.invert`, `.augment(2)`.
- Declare `"key":"Am"` when the piece has one. The report then says what share
  of the notes sit inside that scale and which accidentals you used. The key is
  never inferred from the notes: an undeclared key is not guessed, so a score
  without it gets the key-independent readings only.
- `report harmony` gives the bass note of each bar (the lowest sounding pitch
  class), how often it moves, and whether moves are fourths/fifths or steps. It
  measures the bottom of the texture, not chord symbols: an arpeggio reads as its
  bottom note, and a bass line reads as the notes it plays.

## Emotion targets

Three knobs carry most of the perceived emotion. Set them before choosing any
sound, and set them one at a time: listener ratings mostly add up rather than
interact, so they can be dialled independently.

| Target | Mode | Tempo | Register |
| --- | --- | --- | --- |
| happy | major | fast | high |
| sad | minor | slow | low |
| tense | minor | — | low and close |
| calm | major | slow | high |

- Mode decides valence and tempo decides arousal; those two do most of the work.
  Dynamics, articulation, and timbre are the trim. Textures follow the same
  logic: a fast, high, detached line reads bright, a slow low legato line reads
  heavy, before any instrument is chosen.
- The ordering (mode > tempo > register > dynamics > articulation > timbre) is a
  prior over average listener ratings, not a recipe for one good track. It comes
  from measured synthesized performances, and chip timbres are nothing like the
  sampled instruments in that study, so treat the timbre column as the weakest.
- Average is the operative word. Listeners differ in training and culture — the
  same study line found musicians and non-musicians weighting different cues —
  so the table predicts the mean, not your listener. Breaking it on purpose is a
  choice, not a bug; a finding is an observation, never a pass condition. On a
  non-Western palette the whole table needs re-tuning rather than reuse.
- Tension exists without functional harmony: register crowding, how far the
  outer voices move, and two takes detuned against each other all read as
  tension. On a chip palette those are often stronger than a chord choice.
- The report does not score tension or surprise. Both are easy to optimise
  directly and stop meaning anything once you do — the same reason there is no
  density score. Read the numbers as observations; the judgement is yours.

## Arrangement

Each section should differ in at least two of: density, low end, brightness,
register.

| Section | Typical move |
| --- | --- |
| intro | mute drums, `energy` 0.3–0.5 plus a low `filter`, `space` 1.3–1.8, `width` 0.6–0.9 |
| build | add hats or a `riser`, raise `energy`, bring `space` back to 1, keep the bass |
| drop | full drums, bass back, `space` 0.5–0.8, `width` 1.1–1.4, `bpm` up a few |
| break | mute drums or bass, `energy` 0.4, `space` 1.2+, let reverb carry |
| outro | drop parts one at a time, `space` back out, add `tail` |

- `fill` replaces the last 1–2 bars of named tracks: the cheapest transition.
- `riser` takes no track and ends at the section boundary.
- `energy` alone only changes level; add a `filter` when the section should also get darker.
- `space` is a multiplier on every stereo send bus (needs at least one track or group send); `width` is a multiplier on the finished side signal. Both default to 1, so they are opt-in.
- A group can glue its members with `saturate: {drive, mix}` then `compress: {thresholdDb, ratio, attack, release, makeupDb}`; the fader still has the final say, and both run once on the summed group, not per track.
- Use `sections` to render one contiguous run of song sections, and `solo`/`mute` to hear one part. An excerpt is not the whole-song master, so do not compare its LUFS with the full render.
- A section `tracks` entry moves one part without moving the rest: `{"bass":{"filter":{"from":300,"to":3000},"gain":0.9},"lead":{"mute":true}}`. It accepts `gain`, `pan`, `send`, `mute`, and `filter`; the filter is track-local, not the section-wide filter.
- `inheritSections: true` (or `"inherit": true` on one section) makes an omitted field reuse the previous section. Write `tracks:{}` to clear inherited track state; `fill`, `riser`, `bars`, and `name` never inherit.
- Tempo changes only at boundaries; loop mode keeps one tempo, and song mode
  ignores `minutes`.

## Mix and space

| Goal | Knob |
| --- | --- |
| separate two parts | `pan` ±0.3–0.6 |
| depth without a wash | `send` 0.1–0.3 (stereo: a panned part keeps its side) |
| one note placed away from its track | token `~pan(-0.6)` / `~send(0.5)`; unmarked notes keep the track value |
| one fader/filter/return for several parts | a named `group` with `gain`, `pan`, `filter`, and `reverb` |
| move distance between sections | section `space` 0.5–1.8 |
| open or close the image between sections | section `width` 0.6–1.4 |
| kick cutting through | `duck` 0.3–0.6 on bass and pads |
| glue a drum or keys bus | group `saturate` then `compress` |
| mud in one part | `highpassHz` on that part |
| darker or brighter part | `filter`, or a shelf |
| filter only one part in one section | section `tracks.<name>.filter` |
| echo as rhythm | `delay` with `steps` on the grid |

Then the post chain, in this order unless you have a reason: tape/slow →
lowpass → highShelf → reverb → tilt → saturate → compress → loudness → limiter.
`post: []` runs no chain, though a track's `send` still applies. A `lowpass`
`order` of 1 is 6 dB/oct; use 2 or 4 when near-Nyquist fizz is the problem. If
2–5 kHz is harsh, a master `highShelf` around 3 kHz is more targeted than
lowering the lowpass cutoff, because it leaves the air above the corner alone.

For laptop/phone translation, put a `{"type":"highpass","highpassHz":35}`
step early in the chain (30–40 Hz is enough; 60–80 only when the bass itself is
the problem), use `monoBelowHz` around 100–140, and keep the loudness target
around -16 to -18 LUFS. The report's `sub-heavy` finding means 20–60 Hz is more
than a small driver can play; fix that with a high-pass or a higher bass note,
not by adding noise. Broadband white noise raises the floor and makes laptop
speakers hiss; it does not remove harshness or rumble.

Listening comfort is part of the brief, not a finishing touch:

| Signal | Meaning | Move |
| --- | --- | --- |
| `loud: -12.4 LUFS` | hotter than streaming normalisation | loudness target -14..-16 |
| `unsafe: -8.9 LUFS` | above the -9 LUFS hearing-safety ceiling | **the render fails**; lower track volumes or the loudness target |
| `loudness-flat` | song holds one level (LRA < 4 LU) and every section is within 6 dB | leave one section quieter, or mute a part for a bar |
| `dynamics` | crest < 9 dB, transients are gone | less saturation/compression |
| `harsh` | 2–5 kHz builds up | softer waveform, master `highShelf` at ~3 kHz, tilt down, less drive |
| `phase` | L/R correlation below -0.2; mono fold-down cancels | shorten or filter the reverb/delay return, check the send |
| `imbalanced` | one channel is more than 6 dB louder | recentre a pan or a one-sided send |
| `true-peak` | dBTP is close to 0 | lower master gain or the limiter ceiling |

The `report bars`, `density`, `structure`, and `register` lines describe the
score, not the mix: changing `post` or `style` does not move them. Read them
before the mix, because arrangement comes first.

| Signal | Meaning | Move |
| --- | --- | --- |
| `density-spike` | one bar has about twice the attacks of its section | keep it only if it is the fill; otherwise thin that bar |
| `density-flat` | a long section repeats one attack count | add a fill, ghost notes, or rest one part |
| `melody-static` | the whole arrangement uses 2–3 pitch classes | add a chord tone, transpose one repeat, or change harmony under the same line |
| `melody-leapy` | a non-bass single line never moves by step (chord parts are skipped) | connect leaps with scale steps |
| `register-collision` | two tracks share 2+ octaves in a section | move one up or down an octave |
| `key-mismatch` | most notes are outside the key the score declares | fix `key` if the notes are the piece, fix the notes if the key is the intent |
| `harmony-static` | a section of 8+ bars never moves its bass | move the bass root once or twice, or keep the pedal deliberately |
| `report harmony … bass A F C G` | the bass note of each bar, in order | read it as the harmony arc: repeats, or one note for eight bars |
| `report structure … r0.9` | most bars restate an earlier bar | fine for a hook; vary the last bar of a long section |

A chord counts as one attack and `~roll`/`~flam` expand to their real hits, so
a rolled bar is not "sparser". In loop mode the bars are the authored loop, not
the rendered repeats. `n` is notes, `pc` pitch classes, `e` entropy in bits,
`s` stepwise (1–2 semitones), `l` leaps (5+), `r` the repeat rate.

`peak` is the sample peak in dBFS; `true-peak` is the 4× oversampled dBTP. Both
sit in the first report line. `LRA` is the loudness range: 0 means one level,
8-15 is a healthy arrangement arc. It ignores silence (the absolute gate drops
it), so use the per-section `dBFS` alongside it. `correlation` (1 same, 0
unrelated, -1 anti-phase) and `balance` (positive means left is louder) sit on
the `report space` line. Above -9 LUFS the renderer refuses to
write the file; that is a safety limit, not an aesthetic one, so do not try to
route around it.

- A group is a submix, not a preset: `groups.drums = {gain, pan, send, reverb}` plus `"group":"drums"` on its tracks. Each group has its own return, so drums and keys can use different room/damp. `buses` and `bus` are synonyms.
- `style` is the fast path to a chain plus role instruments (`chip`, `hitech`,
  `ambient`, `studio`, `lofi`, `soft`); `preset` is a shorter shortcut. One, not
  both.
- `width` above ~1 is mostly reverb, not size; check `correlation` first (near 0 or negative means phase width, not a stable image).
- Harshness usually comes from static chip harmonics and 2–5 kHz buildup, not
  from a missing layer: use `quality: "clean"`, a darker waveform or `tilt`,
  `highShelf`, and a reverb `highCutHz` before considering any noise.

## Sound design

- Keep the chip path for PICO-8 character; reach for `instrument` only for a
  specific timbre.
- `additive` designs a waveform from harmonic amplitudes (and phases, optional
  per-harmonic decay); `stretch` is bells and metal, `tilt` darkens, per-harmonic
  decay is plucks. `fm` gets bells, e-bass, metallic leads.
- `sample` plays a workspace WAV: a real voice, a field recording, a drum
  replacement. Paths are workspace-relative, never relative to the score file.
  `start`/`end`/`reverse`/`loopStart`/`loopEnd` cut a region; a named entry per
  region is how you slice one file. `zones` maps key ranges and velocity layers
  to those entries, so one sample instrument can cover the keyboard.
- `fm.operators` (1–3 entries, each `{ratio, index, indexDecay, target}`) is a
  fixed routing tree: `target: 0` modulates the carrier, `target: 1` modulates
  the first modulator. It replaces `ratio`/`index`/`indexDecay`; one operator
  is sample-identical to the classic voice.
- `velocity: {cutoffOctaves, drive, indexScale}` makes accents brighter, and
  `indexScale` (FM only) makes quiet notes darker. `cutoffOctaves` needs an
  instrument `filter`; the whole field is rejected on sample voices.
- Sampled drums accept `~decay`, which applies an exponential amplitude
  envelope instead of being ignored.
- Before changing an envelope, instrument filter, additive shape, or FM index,
  call `p8_probe` on that track. It renders one dry note (fixed note/velocity/
  gate) and reports spectral slope, odd/even harmonics, attack/decay, HF decay,
  FM sidebands, and measured deltas for `attack`, `tilt`, `index`, `indexDecay`,
  and `cutoffHz`. Odd/even is only meaningful for periodic chip/additive
  sources; use FM sidebands for FM and a different source for samples/noise.
  `bypassFilter: true` measures the source without the instrument filter.

### Reusable sounds

- Define an `articulations` entry when the same performance repeats: gate
  scale, volume, envelope, and one pitched effect. Play it as `~name`. A token's
  own `gGATE`, `@volume`, or `~effect` wins over the articulation.
- A track's `articulation` is the default for tokens without a `~name`; use it
  instead of repeating the suffix on every note. Named articulations are
  melodic only; drums keep `~ghost` / `~flam` / `~roll`.
- Define a `presets` entry when several tracks share a voice and mix defaults:
  instrument, waveform, envelope, articulation, volume, pan, send, filter, and
  delay. Explicit track fields override the preset. A score `preset` is not the
  `p8_music` `preset` argument, which only selects a post chain.
- Name sounds and articulations by role (`violin-arco`, `spiccato`), not by
  parameter values, so a later revision changes one table entry.

## Revise loop

1. Fix `warnings` first (`pattern-misaligned`, `fill-misaligned`,
   `delay-base-tempo`); they are arrangement bugs, not mix bugs.
2. Read the symbolic lines next: `report density` is the section shape,
   `report structure` the per-track motion, `report harmony` the bass arc, and
   `register` the crowded pairs.
   `density-spike` / `density-flat` / `melody-*` / `register-collision` /
   `key-mismatch` / `harmony-static` are composition findings; fix them in the
   score, not with EQ. `key-mismatch` is a disagreement, not a verdict: fix
   whichever of the two — the key field or the notes — you actually meant.
3. Read the audio `findings` as measurements: `mud` is 150–500 Hz buildup,
   `harsh` is 2–5 kHz, `masking` is two stems in one band, `dynamics` is crest
   factor, `loudness-flat` is "one level all the way through"; `post-*` means
   the chain caused it.
4. `post-delta` shows what the chain did to the dry render; when a finding
   appears only there, fix the chain, not the score.
5. When revising a previous render, add `compare: true` and read the delta
   rows instead of guessing whether a knob helped; it compares measurements,
   not a score. For two saved WAVs, use `p8_analyze` with
   `detail: "compare"` and `against`.
6. When the fix is a timbre parameter, run `p8_probe` on that track first: read
   the source metrics and the measured sensitivity, then change one knob and
   probe again. Do not tune FM or an envelope from the mix report alone.
7. For a song, read the per-section `w` (width), `c` (correlation), `b`
   (balance), `low-mid`, `2-5k`, and `Hz` in `report sections`: if
   `flat-space` fires, neither width nor brightness moves between sections.
8. Fix in order: arrangement → levels and pan → filters → reverb/delay → master.
9. `target` adds profile range checks; it reports, it is never a score to
   maximise. `assert` is stricter: a declared range miss fails the tool call,
   so use it only when the requirement is objective (peak/true-peak, LUFS,
   sections, correlation).

## Before you render

- [ ] `mode` matches whether `arrangement` is present.
- [ ] Every pattern sums to a whole bar or a multiple of one.
- [ ] Every section's `bars` is a whole multiple of its patterns.
- [ ] Every named reference exists (pattern, motif, envelope, articulation,
      instrument, preset, sample).
- [ ] Melodic tracks hold notes/chords only; drum tracks, drum tokens only.
- [ ] No tool argument (`post`, `style`, `width`, `out`, …) inside the score, and
      no mix field nested under `mix`.
- [ ] Exactly one of `score` and `scoreFile`.

Every range, default, and error is in `p8_help`.
