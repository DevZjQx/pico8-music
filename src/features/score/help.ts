// Wire-format reference for the score DSL. It lives here, next to the parser that
// owns these rules, and is kept out of every tool declaration so it only costs
// context when someone asks for it (/p8m in Pi, the p8_help tool, or the DSH
// description). It owns field names, token grammar, ranges, defaults and the
// error table. How to compose, mix and revise is the pico8-songwriter skill, so
// no authoring guidance belongs here; docs/features/score.md records that split,
// and this text stays in sync with parse.ts.

export const SCORE_BRIEF =
  'PICO-8 score JSON: bpm, stepsPerBeat, bars and tracks of NOTE:STEPS tokens, ' +
  'with an optional song arrangement, patterns and motifs. post/preset/style are p8_music ' +
  'arguments outside the score JSON.';

export const SCORE_HELP = `PICO-8 score reference

Pass \`score\` as a JSON string, not a nested object, or pass \`scoreFile\` with a workspace-relative path to a JSON score file (.json is appended when omitted). Provide exactly one of them; a scoreFile is read on every render, so editing the file changes the next output.
The score JSON holds composition only. post, preset, style, speed, wet, toneHz, minutes and out are p8_music arguments passed next to score/scoreFile; p8_export also reads score/scoreFile and takes out.
track, note, volume, seconds, style, bypassFilter, sensitivity and detail are p8_probe arguments. Putting any tool argument inside the score JSON is an error.

Scope: this is the wire format — fields, tokens, ranges, defaults and what fails. The pico8-songwriter skill owns how to compose: form, track layout, arrangement, mix decisions, the revise loop. Read this reference before writing a field the skill does not name; it is authoritative on every range.

## Contents
1. Minimal scores
2. Render budgets
3. Score fields (tuning, envelopes, articulations, presets, motifs)
4. Track fields
5. Pattern tokens (volumes, effects)
6. Chords
7. Instruments
8. Samples
9. Drums
10. Arrangement
11. Post chain, styles, presets
12. Output, tool arguments, report
13. Rules that fail or warn

## Minimal scores
Loop mode:
{"bpm":90,"stepsPerBeat":4,"bars":4,"tracks":[{"role":"bass","waveform":"pulse","volume":5,"pattern":"C3:4 E3:4 G3:4 A3:4"}]}
Song mode adds patterns and an arrangement:
{"mode":"song","bpm":150,"tracks":[{"name":"drums","role":"drums","pattern":"K:1 -:1 H:1 -:1"}],"patterns":{"drums.B":"K:1 H:1 S:1 H:1"},"arrangement":[{"name":"intro","bars":4,"bpm":120,"mute":["drums"]},{"name":"drop","bars":8,"bpm":165,"patterns":{"drums":"drums.B"}}]}

## Render budgets
| Limit | Value |
| --- | --- |
| tracks | 1-32, one independent bus each; use as many as the arrangement needs (a render budget, not a musical rule) |
| arrangement sections | 1-256 |
| total song length | 15 minutes including tail; longer fails before rendering |
| samples | at most 16 entries |
| sample file | at most 32 MB |
| sample length | at most 30 s |
| sample rate | 8000-192000 Hz |
| notes | C1-C8 |
| loop minutes argument | 0.05-15, default 2; ignored in song mode |

## Score fields
| Field | Values | Default |
| --- | --- | --- |
| mode | loop or song; song requires an arrangement, and an arrangement requires song (or omit mode) | song when arrangement is present, else loop |
| bpm | 30-300; the default tempo for loop mode and for every arrangement section | 90 |
| stepsPerBeat | integer 1-8 | 4 |
| beatsPerBar | integer 1-16; 3 is 3/4, 6 with stepsPerBeat 2 is 6/8 | 4 |
| bars | loop 1-64; song sections are 1-64 each, and the optional total is 1-256 and must equal the sum | 4 in loop mode |
| swing | -0.5..0.5; positive delays odd steps, negative pushes them earlier | 0 |
| seed | integer 0-2147483647; varies noise timbres, drum transients, humanize and section risers | 0 |
| humanize | {timingMs 0-150, velocity 0-1}: deterministic timing and gain variation; 0 is neutral | 0 and 0 |
| tuning | {a4, temperament, cents}; see Tuning | A4=440 equal |
| key | declared tonic for the harmonic reading: a letter, an optional # or b, and an optional maj/major/min/minor, e.g. "C", "Am", "F# minor", "Bbm" | none; no key means no in-key share |
| tail | 0-30 seconds after the last step so reverb and one-shots ring out; song mode only | 0 |
| inheritSections | boolean; when true, a section that omits bpm, patterns, mute, gain, gains, filter, energy, space, width, or tracks inherits the previous section | false |
| tracks | 1-32, one independent bus each; see Render budgets | required |
| patterns | top-level name -> token string, referenced by track.pattern or a section pattern | empty |
| motifs | top-level name -> token string, played as @name; see Motifs | empty |
| envelopes | top-level name -> {attack, decay, sustain, release}; see Envelopes | empty |
| articulations | top-level name -> performance shape, played as ~name; see Articulations | empty |
| presets | top-level name -> reusable sound defaults for a track; see Presets | empty |
| groups | top-level name -> subgroup settings; a track joins with group; buses is a synonym; see Groups and stereo sends | empty |
| instruments | top-level name -> voice; see Instruments | empty |
| samples | top-level name -> WAV spec; see Samples | empty |
| drumSamples | drum voice -> sample name, e.g. {"kick":"hit"}; unmapped voices stay synthetic | empty |
| arrangement | array of sections; see Arrangement | none |

### Tuning
\`{"tuning":{"a4":442,"temperament":"equal","cents":{"C4":2.5,"A3":-3}}}\` retunes the whole score.
- a4 is the absolute A4 reference, 400-480 Hz (default 440).
- temperament is equal (default), just, pythagorean, meantone, werckmeister3, kirnberger3, or young. It moves the eleven other pitch classes and never shifts A4 itself.
- cents adds -100..100 per note on top of the temperament, including A4 if listed. Keys are note names; give each MIDI note one enharmonic spelling (C4 and B#3 together is an error).

### Envelopes
Named envelopes live in the top-level envelopes table and are referenced as "C4:4~pluck": \`{"envelopes":{"pluck":{"attack":0.002,"decay":0.07,"sustain":0.08,"release":0.03}}}\`.
- attack, decay and release are seconds 0-30; sustain is a 0-1 level.
- names use letters, digits, "_" or "-", start with a letter or "_", and may not collide with an effect, a drum articulation or a drum parameter name.
- a track's envelope is an inline ADSR of the same shape for the whole track; drum tracks ignore it. Without one the default is attack 0.004, decay 0, sustain 1, release 0.008.
- a token carries at most one named envelope (see Pattern tokens).

### Articulations
\`{"articulations":{"spiccato":{"gateScale":0.5,"volume":6,"envelope":"pluck","effect":"vibrato","effectParams":{"vibratoDepth":0.2}}}}\` defines a reusable performance shape, played as \`~spiccato\` on a melodic token.
- gateScale 0.05-8 multiplies the slot; the result is rounded to 1-256 steps. A token's own gGATE wins.
- volume 0-7 sets the default note volume; a token's @volume still wins.
- envelope is an inline ADSR or the name of a top-level envelope.
- effect is one pitched effect: slide, vibrato, drop, fadein, fadeout, arpfast, or arpslow. effectParams is {vibratoDepth, vibratoRate} for vibrato or {slideSteps} for slide. A token's own ~effect wins.
- a track's articulation is the default for its tokens that carry no ~name.
- names follow the envelope rules and may not collide with an envelope, an effect, or the drum vocabulary. Named articulations are melodic only; drums use ~ghost, ~flam, and ~roll.

### Presets
\`{"presets":{"violin-arco":{"instrument":"violin","envelope":{"attack":0.06,"sustain":0.8},"articulation":"legato","volume":5,"send":0.2}}}\` defines a reusable sound; a track uses \`{"preset":"violin-arco",...}\`.
- preset fields: instrument, waveform, envelope, articulation, volume, pan, send, duck, filter, highpassHz, lowShelf, highShelf, delay.
- an explicit track field wins over the preset, including track.instrument and track.envelope.
- presets hold no pattern, role, or post chain. They are score-level sound defaults, not the p8_music \`preset\` argument (classic/dreamy/tape), which is a post shortcut outside the score.
- presets are melodic only; drum tracks keep their voices and drumSamples.

### Groups and stereo sends
\`{"groups":{"drums":{"gain":0.9,"pan":0.1,"send":0.25,"reverb":{"room":0.8,"damp":0.4}}}}\` defines a named submix; a track joins it with \`"group":"drums"\`.
- group fields: gain 0-4, pan -1..1, send 0..1, duck 0..1, filter, highpassHz, lowShelf, highShelf, delay, and reverb {room 0-0.98, damp 0-1, predelayMs 0-200, lowCutHz 20-1000, highCutHz 1000-20000, modDepth 0-1, modRateHz 0.05-5}; the reverb fields may also be written directly on the group. Neutral defaults are gain 1, pan/send/duck 0, and no filter/delay/reverb.
- members render into one stereo subgroup before the group fader, pan, filter, delay, and duck; one group therefore shares one bus treatment and one send instead of every track owning its own. A member send follows its source group's fader and pan.
- sends are stereo: a track send keeps its pan (a hard-left part returns on the left) instead of feeding one mono sum. Member sends and group.send both feed that group's own return; ungrouped tracks use the default return. Each group's reverb settings apply only to its return, so groups do not share one reverb.
- write send: {amount, stereo:false} to restore the old pre-pan mono send; a pan+send score from before this change otherwise returns on its panned side.
- group and bus are synonyms: top-level groups/buses and track group/bus. Define one table and one track field, not both spellings in the same score.
- an unknown group name fails at parse time; a grouped track still keeps its own pan, filter, delay, duck, and send inside the subgroup.
- send may be an object: {amount, bus} targets another group's return without changing the track's dry group, and {stereo:false} feeds the pre-pan mono stem instead of the stereo image.

### Motifs
\`{"motifs":{"A":"C4:1 E4:1"}}\` defines a motif, played as "@A.transpose(2).retrograde". Motifs can sit at the top level or inside a track; a track-local name overrides a top-level one.
- transpose(n): -24..24 semitones.
- invert: mirrors around the first sounding note.
- retrograde: reverses the order.
- augment(n) / diminish(n): 2-8, multiply or divide every slot and gate; diminish needs every value divisible by n.
- transforms chain left to right; motifs may nest (cycles are detected).
- transpose and invert reject drum tokens and chords; retrograde, augment and diminish still work on drums.

## Track fields
| Field | Values | Default |
| --- | --- | --- |
| name | section target | track0, track1, ... |
| role | drums, bass, lead, pad, ...; drums selects drum mode | melodic |
| preset | a name from the top-level presets table; fills sound fields, never role or pattern | none |
| group | a name from the top-level groups table (alias bus); members share a subgroup fader, pan, filter, delay, duck, and stereo return | none |
| pattern | inline tokens, or a pattern name: track-local first, then top-level | first track-local pattern |
| patterns | track-local name -> token string; a name here outranks a top-level one | empty |
| motifs | track-local name -> token string; overrides a top-level name on collision | empty |
| waveform | triangle, tilted_saw, saw, square, pulse, organ, noise, phaser, or 0-7; valid without an instrument or on a chip instrument (invalid on fm/additive/sample); wins over a chip instrument's waveform | pulse |
| instrument | a top-level name, an inline definition, or chip/fm/additive/drums; sample voices are named or inline {"type":"sample","sample":"name"}; an explicit instrument outranks a style's role default; without one the legacy waveform path renders | none |
| volume | 0-7, one decimal allowed; notes without @volume use it | 5 |
| envelope | inline ADSR {attack, decay, sustain, release}; attack/decay/release 0-30 s, sustain 0-1 | 0.004, 0, 1, 0.008 |
| articulation | default named articulation for tokens without a ~name; melodic only | none |
| pan | -1 left .. 1 right; equal power, centred leaves the level unchanged | 0 |
| send | 0..1 stereo send into the track's return, or {amount 0..1, bus/group/to return name, stereo false for the old mono feed} | 0 |
| duck | 0..1 kick sidechain depth | 0 |
| filter | a cutoff number (100-20000 Hz) or {cutoffHz (alias cutoff), resonance (alias q) 0.05-20, lfoHz 0-20, lfoDepth 0-4 octaves} | none |
| highpassHz | 20-4000 Hz, 12 dB/oct high-pass on this track only | none |
| lowShelf | a gain in dB (-24..24) at 250 Hz, or {hz 20-20000, gainDb}; 0 is a no-op | none |
| highShelf | a gain in dB (-24..24) at 4000 Hz, or {hz 20-20000, gainDb}; 0 is a no-op | none |
| delay | {steps 1-64, feedback 0-0.95, mix 0-1, follow "base" or "section"}; follow defaults to "base" (top-level bpm); "section" times each echo on the grid of the section it lands in; a delay at least one loop long folds through the loop seam; in song mode a delay longer than the song is silent | none |

- mix-stage fields are flat track fields, never nested under "mix".
- drum tracks ignore waveform, envelope and instrument; each hit is its own transient.
- unknown fields are rejected, not silently ignored.

## Pattern tokens
Space-separated tokens: NOTE:STEPS[gGATE] on melodic tracks, DRUM:STEPS on drum tracks.
- notes are C4, F#3, Bb2 within C1-C8.
- STEPS is 1-64 for a sounding token and 1-256 for a rest; GATE is 1-256 and defaults to the slot.
- a gate shorter than the slot is staccato; longer is legato and sounds into the next slot.
- when a section length is not a multiple of the pattern length the parser warns (pattern-misaligned) and truncates the last repetition; the bar length in steps is stepsPerBeat * beatsPerBar.

| Suffix | Meaning |
| --- | --- |
| - | rest: no @volume, effect, envelope or drum suffix, and up to 1-256 steps |
| @volume | 0-7, one decimal allowed, overrides the track volume; order with ~ is free ("@6~slide" or "~slide@6") |
| ~effect | one pitched effect; see Effects |
| ~name | one named envelope or articulation from the top-level tables |
| drum suffix | articulations and per-hit parameters; see Drums |

At most one @volume, one ~effect, one named suffix and one drum articulation per token; each drum parameter also appears at most once.

### Effects
| Effect | Parameters | Default |
| --- | --- | --- |
| slide | steps 0.05-8, time to reach the target | 1 |
| vibrato or vib | depth 0-2 semitones, optional rateHz 0.1-20 | 0.5 and 7.5 |
| drop, fadein, fadeout, arpfast, arpslow | none | - |

Drum tracks use articulations instead of pitched effects, and pitched effects are invalid on drum tokens.

## Chords
- explicit voicing: [C4,E4,G4]:4, up to 8 voices.
- named: Cmaj7, Fm, Fm/E, {C7}. Qualities are maj, m/min, dim, aug, sus2, sus4, 5, 6, m6, 7, maj7, m7, m7b5, dim7, 7sus4, add9, 9, maj9, m9; maj is implied in C/E or {C}. A named quality expands to at most 4 voices.
- the octave defaults to 4 and may sit before or after the quality: F3m7, Fm3, Cmaj74.
- slash bass: Fm/E, G7/B. Without an octave the bass sits one octave under the root. A four-note quality drops the fifth first; a chord without a fifth (C9/E) drops the root but keeps third, seventh and extensions.
- C7, C5, C6 and C9 collide with note names, so write {C7} or {C9}; G7/B is safe because the slash rules out a note.
- a chord-level @volume or ~effect applies to every voice.

## Instruments
The top-level instruments table maps a name to a voice; a track uses it as "instrument":"name" or inlines the same object.

| type | Required | Sound |
| --- | --- | --- |
| chip | waveform | the eight PICO-8 waveforms |
| additive | partials 1-16, harmonic 1 first | band-limited harmonic sum, peak-normalised |
| fm | classic: ratio 0.25-8, index 0-12, indexDecay 0.01-4 s; or operators: 1-3 x {ratio, index, indexDecay, target} | phase modulation; operators is a fixed routing tree (target 0 = carrier, target < own index), and one operator matches the classic voice exactly |
| sample | sample: "name" | plays an entry from the score's samples table |

chip/additive/fm share unison 1-4, detune 0-50 cents, drive 0-1, filter {cutoffHz 80-18000, resonance 0.05-20, envAmount 0-6 octaves, attack, decay, sustain, release}, and optional velocity {cutoffOctaves 0-6, drive 0-1, indexScale 0-1}.
- velocity: @volume then also opens the instrument filter by cutoffOctaves and adds soft-clip drive, so accents get brighter; cutoffOctaves needs a filter; indexScale is FM-only and lowers the index as velocity falls. Absent or all zeros is neutral; sample voices reject velocity.
- operators replaces ratio/index/indexDecay when present. Each operator has exactly one target, so a chain (target 1) or parallel pair (two operators targeting 0) is expressible; feedback and arbitrary matrices are not.
- additive partial element: an amplitude 0-1, a negative amplitude for the mirrored wave (same as [magnitude,180]), [amplitude, phaseDegrees], or [amplitude, phaseDegrees, decaySeconds 0-8]: \`{"type":"additive","partials":[1,-0.5,[0.25,90,1.5]]}\` designs a shape.
- stretch 0-1 runs harmonic n at n*f0*sqrt(1+stretch*(n^2-1)): the fundamental stays in tune and highs sharpen for bells. tilt 0-4 scales harmonic n by n^-tilt, so higher is darker.
- a third partial item is its decay time constant in seconds (0 keeps it static). Static partials use the fast band-limited table; stretch or any nonzero decay renders each partial per sample, still band-limited and peak-normalised.
- sample voices accept only type and sample; waveform, partials, stretch, tilt, ratio, index, indexDecay, unison, detune, drive, filter and velocity are rejected. Use a track filter instead.

## Samples
Samples are files, not inline data: put a 16-bit PCM WAV in the workspace and reference it from the top-level samples table.

| Spec | Values | Default |
| --- | --- | --- |
| file | workspace-relative path ending in .wav; not relative to scoreFile; cannot escape the workspace | required |
| root | note the file plays at its native speed, read as A4=440 | C4 |
| loop | repeat for the whole gate instead of stopping at the file end | false |
| gain | linear gain 0-4 | 1 |
| start / end | seconds; play only this region, end exclusive | 0 / file end |
| reverse | play the selected region backwards | false |
| loopStart / loopEnd | seconds inside the region; needs loop true; playback enters from the region head and jumps back at loopEnd | region bounds |
| zones | [{sample, lo, hi, velLo, velHi}] key/velocity layers; references plain file entries; replaces file | none |

- \`{"hit":"assets/hit.wav"}\` is shorthand for \`{"file":"assets/hit.wav"}\`; stereo is averaged to mono before pan, send and filter.
- the app reads every declared sample before rendering, including unused ones, and caches decoded PCM until the file's size or mtime changes. A bad path fails before the render, not at the first note.
- a sample instrument starts at the selected region's head for every note, plays at native speed when the note equals root, and stops at the region end unless loop is true; the score's tuning still retunes playback speed.
- slicing is one file with several named regions: two entries can share the same .wav and differ only in start/end, and the decode cache still holds one copy. There is no automatic transient slicing and no separate wavetable type; a short looped region is the wavetable.
- zones picks the key range nearest the note, then the velocity layer nearest the hit; outside every range it falls back to the nearest zone rather than going silent. The same selection runs for drumSamples, so ~ghost/~flam/~roll velocity changes can switch layers.
- a nonzero start or reverse adds a 2 ms fade-in; an unedited source keeps the historical render sample for sample.
- ~slide, ~vibrato, ~arpfast and ~arpslow change playback speed; ~fadein, ~fadeout, the track envelope and a named envelope still shape gain. ~decay and per-note filter fields are not available on sample instruments.
- drums: ~pitch retunes and ~tone low-passes the sample; ~decay (including ~ghost's decay shortening) multiplies an exponential amplitude envelope onto the one-shot, while ~ghost's velocity and tone reduction still applies. A drum replacement never loops, so a looping sample used as a kick still decays.
{"samples":{"hit":"assets/hit.wav","vox":{"file":"assets/vox.wav","root":"A3","loop":true}},"instruments":{"choir":{"type":"sample","sample":"vox"}},"drumSamples":{"kick":"hit"},"tracks":[{"instrument":"choir","pattern":"A3:8"},{"role":"drums","pattern":"K:1 -:1 S:1 -:1"}]}

## Drums
A track with role "drums" writes drum tokens instead of notes.

| Token | Voice | Full names |
| --- | --- | --- |
| K | kick | kick, bd, bassdrum, bass-drum |
| S | snare | snare, sd |
| H | closed hat | hat, hh, closedhat, closed-hat |
| O | open hat | openhat, open-hat, oh |
| C | clap | clap, cp |
| T | tom | tom |
| R | rim | rim |
| X | crash | crash, cymbal |

Single-letter tokens are case-insensitive except r, which is a rest; R is the rim.
- drum tracks ignore waveform, envelope and instrument; each hit has its own transient envelope, and @volume changes the hit's amplitude.
- a token carries at most one articulation and at most one of each parameter.
- ~ghost is quieter, shorter and darker (4.5 kHz low-pass).
- ~flam[(offsetMs 5-40)] adds a second hit 16 ms later by default.
- ~roll[(hits 2-8)] or ~roll4 subdivides the slot, 4 hits by default, with decaying velocity.

| Parameter | Values | Meaning |
| --- | --- | --- |
| ~pitch | semitones -12..12 | retunes the pitched drum body; noise stays |
| ~decay | scale 0.25..4 | multiplies the decay rate; combines with ~ghost |
| ~tone | cutoffHz 200..16000 | low-pass after the hit; overrides ~ghost's 4.5 kHz |

- parameters work alone or after an articulation: "K:1~ghost~pitch(-2)~decay(1.4)".
- a rest rejects every drum suffix, and drum suffixes are invalid on melodic tracks.

## Arrangement (song mode)
| Field | Values | Default |
| --- | --- | --- |
| name | section label | section0, section1, ... |
| bars | integer 1-64; the total must match the optional top-level bars | required |
| bpm | 30-300; changes tempo at this section boundary and keeps the step grid | top-level bpm |
| patterns | track name or role -> pattern name or inline tokens; a defined name wins | none |
| mute | track names or roles | none |
| gain | 0-4 | 1 |
| gains | track name or role -> 0-4 | none |
| filter | cutoff Hz 100-20000, or {"from":500,"to":12000} for a sweep; applies to the summed mix | none |
| energy | 0-1 macro; 0 halves gain and takes the filter cutoff to 0.35x, 1 changes nothing | 1 |
| space | 0-2 multiplier on every stereo send bus inside the section; 0 dry/close, 1 unchanged, 2 twice the send (farther) | 1 |
| width | 0-2 multiplier on the side signal inside the section; 0 mono, 1 unchanged, 2 wider | 1 |
| riser | 1-64 bars of noise plus sine sweep ending at the section boundary; cannot exceed the section | none |
| fill | {"bars":1,"patterns":{"drums":"fill.pattern"}}: replaces the last 1-2 bars for those tracks | none |
| tracks | track name or role -> {gain 0-4, pan -1..1, send 0..1, mute true/false, filter cutoff or {"from","to"}}; track-local section state | none |
| inherit | boolean; overrides the top-level inheritSections for this section | inheritSections |

- with an arrangement, mode defaults to song; an arrangement without song mode is an error.
- per-section bpm changes tempo only at section boundaries: the arrangement still writes bars and steps, but the section's duration is bars * beatsPerBar * 60 / bpm. Loop mode keeps one bpm, and there are no gradual ramps or arbitrary tempo automation.
- a delay stays on the top-level bpm by default; set delay.follow to "section" to time echoes on each section's grid (a short tape-like pitch shift is possible at the boundary).
- sections should be a whole multiple of every pattern they use; otherwise the parser warns (pattern-misaligned) and truncates the last repetition.
- filter and energy stack: the sweep runs first, then energy multiplies the cutoff; gain and gains apply after energy. energy by itself only changes level: pair it with filter when the section should also get darker.
- tracks resolves keys by track name first, then by role. gain overrides gains for that track; mute overrides the section mute list; pan, send and filter run across the section. A track filter is local to that track, unlike the section-wide filter.
- inherit copies bpm, patterns, mute, gain, gains, filter, energy, space, width and tracks from the previous section; fill, riser, bars and name stay local. Write tracks:{} to clear inherited track state, or patterns:{} to fall back to each track's default pattern.
- inheritSections is strict opt-in. Without it, omitted fields keep their old defaults (top-level bpm, energy 1, space 1, width 1) so old scores render unchanged.
- space scales every stereo send before its reverb, so it moves the wet/dry balance without touching the dry level; it needs at least one send > 0, from track.send, a section tracks.send, or a group send, otherwise the parser warns (space-no-send).
- width is a section-side multiplier, applied to the finished song before the master width / monoBelowHz arguments; tape/slow keeps the section boundaries on the musical timeline.
- a fill whose pattern does not divide the fill window warns (fill-misaligned).
- the song renders once and ignores minutes; use post: [] plus send: 0 for a tight ending, or tail for ring-out.

## Post chain, styles, presets (p8_music arguments, outside the score JSON)
post: [] skips the post chain (track send still applies; also set send: 0 for a fully dry mix). Otherwise the steps run in array order, and that order is exactly what runs.

| Step | Parameters | Notes |
| --- | --- | --- |
| tape / slow | speed 0.5-1.5 | speed sets the whole tape/slow chain's total speed |
| lowpass | cutoffHz 100-22050, order 1/2/4 | order 1 is the default 6 dB/oct one-pole; 2/4 are 12/24 dB/oct Butterworth |
| highpass | highpassHz 20-500 | 12 dB/oct master high-pass; use 30-40 Hz for laptop/phone translation, higher if the mix rumbles |
| highShelf | hz 20-20000 (default 3000), gainDb -24..24 | master high shelf; 0 dB is a no-op; use -3..-6 dB around 2500-3500 Hz to tame 2-5 kHz presence |
| reverb | wet 0-1, room 0-0.98, damp 0-1, predelayMs 0-200, lowCutHz 20-1000, highCutHz 1000-20000, modDepth 0-1, modRateHz 0.05-5 | wet is a dry/wet mix ratio, not a wet gain; the wet path sits about 5 dB under the dry, so 0.3 is a light reverb. predelay and modulation delay only the send; the wet filters remove low cloud and metallic highs |
| tilt | tiltDb -12..12 | |
| saturate | drive 0-1, mix 0-1 | |
| compress | thresholdDb -60..0, ratio 1-40, attack 0.0005-1, release 0.01-2, makeupDb -12..24 | |
| loudness | targetLufs -40..-9 | values above -9 LUFS are refused: that is the hearing-safety ceiling, not a louder master |
| limiter | ceilingDb -12..0, release 0.01-2 | |

Example: \`[{"type":"tape","speed":0.8},{"type":"reverb","wet":0.4},{"type":"loudness","targetLufs":-14},{"type":"limiter"}]\`
- omit post to use a style: chip (dry), hitech, ambient, studio, or lofi, plus soft; do not also pass preset.
- or use a preset: classic, dreamy, or tape.
- studio, lofi and soft also supply role-based instrument defaults (bass, lead, pad, keys, default), which is how a score leaves the chip palette without changing its tokens; an explicit track.instrument wins. soft uses clean low-order partials, slow attacks, a 5.2 kHz lowpass, and a -16 LUFS target.
- speed, wet and toneHz override the matching step or add one.
- quality defaults to pico for chip and to clean for soft. clean uses PolyBLEP on saw/pulse and caps the FM sideband index; it changes the waveform, so omit it to keep an old render sample for sample.
- width 0-2 is a master side gain after the chain (0 mono, 1 unchanged, 2 wide); monoBelowHz 20-500 folds the low band to mono. Both are opt-in.
- target is a profile name (soft, clear, punchy, bright, dark, lofi, hitech) or inline ranges such as {"lowMidMax":0.22,"crestMin":12,"width":[0.2,0.5],"lufs":[-18,-12]}. It adds range checks and target findings; it is never a total score. The same target works on p8_analyze.

## Output, tool arguments, report
| Argument | Values | Default |
| --- | --- | --- |
| score / scoreFile | exactly one; score is a JSON string, scoreFile a workspace-relative .json path | required |
| post | array of steps; [] renders dry; omit for the style or preset chain | style or preset chain |
| preset | classic, dreamy, tape; not with style | classic |
| style | chip, hitech, ambient, studio, lofi, soft; not with preset | none |
| quality | pico (legacy direct-form) or clean (PolyBLEP/band-limited); not a score field | style default, else pico |
| width | 0-2 master side gain after the chain; 0 mono, 1 unchanged | none |
| monoBelowHz | 20-500 Hz low-band mono fold | none |
| target | profile name or range object; also accepted by p8_analyze | none |
| speed | 0.5-1.5 | preset or post |
| wet | 0-1 | preset or post |
| toneHz | 100-22050 | preset or post |
| minutes | 0.05-15; used in loop mode and ignored in song mode | 2 |
| out | workspace-relative path ending in .wav | pico8-music.wav |
| detail | summary or raw; raw writes a sibling .analysis.json and returns its path | summary |

### MusicXML export (p8_export arguments, outside the score JSON)
\`p8_export\` writes the same score as uncompressed MusicXML 4.0 partwise XML: one part per track, one measure grid per bar, chords as <chord/>, notes that cross a bar line as tied notes, rests for silent slots, section rehearsal names and tempo changes, and drum tracks as percussion with GM drum instruments.
It never renders audio, so post/preset/style/minutes do not apply. The written pitch uses sharps unless the declared key is flat; score tuning is kept as a fractional <alter> (for example A4=442 becomes +0.0785 semitones), so microtonal scores are not silently forced to 12-TET.
The exported file is plain XML (.musicxml), never the zipped .mxl container.

| Argument | Values | Default |
| --- | --- | --- |
| score / scoreFile | exactly one; same input contract as p8_music | required |
| out | workspace-relative path ending in .musicxml | pico8-music.musicxml |

### Timbre probe (p8_probe arguments, outside the score JSON)
\`p8_probe\` renders one melodic track as one fixed note, dry: no post chain, no track EQ/filter/delay/duck/send, and no WAV. Use it after a render when you need to change an envelope, filter, additive shape, or FM index. Pass the same \`style\` you rendered with when the track relies on role instruments; an explicit \`track.instrument\` still wins, and \`quality\` defaults to the style's choice.

| Argument | Values | Default |
| --- | --- | --- |
| score / scoreFile | exactly one; same input contract as p8_music | required |
| track | melodic track name; drum tracks are rejected | first non-drum track |
| note | note name C1-C8, e.g. A4, C3, F#2 | A4 |
| volume | fixed velocity 0-7 | 5 |
| seconds | gate length 0.25-4 s | 1.5 |
| quality | pico or clean | pico or the style default |
| style | chip, hitech, ambient, studio, lofi, soft; role instrument defaults, matching p8_music | none |
| bypassFilter | true removes the instrument filter so the source is measured alone | false |
| sensitivity | true renders a few parameter variants and reports measured deltas | true |
| detail | summary or raw; raw writes a .json artifact | summary |
| out | workspace-relative .json path for detail: raw | p8-probe.json |

The probe reports spectral slope (one-third-octave regression, dB/oct), centroid, 85% rolloff, high/air share, attack (10%-90% rise) and decay (peak to -20 dB), high-band decay (2-8 kHz time constant and dB/s), and the early-to-late centroid.

For periodic chip/additive sources it also reports upper odd/even harmonic energy (n >= 2; the fundamental is excluded) and harmonic share. Additive \`stretch\`, chip noise/phaser, FM, and samples do not have a stable harmonic series, so upper odd/even is omitted there; FM instead gets carrier share, significant sideband count, highest sideband, and a Carson/Nyquist alias estimate. \n\nEvery probe also echoes the authored envelope and the instrument filter state.

Use the measured sensitivity line to choose a knob: it renders the same note with one changed parameter and reports the metric delta. Parameters include \`envelope.attack\`, \`additive.tilt\`, \`fm.index\`, \`fm.indexDecay\`, \`fm.operators[n].index\`, and \`filter.cutoffHz\`.
A metric without a delta is not actionable; the probe deliberately measures the source instead of adding four global numbers to the mix report.

Every render returns a report: peak, RMS, LUFS, LRA, spectrum, width, onsets, warnings, stems, and findings. LRA is the EBU Tech 3342 loudness range: 0 on a steady loop, 8-15 when an arrangement drops down and comes back. It ignores silence, so read it next to the per-section levels.

Width is side/mid RMS (0 mono, 1 hard-panned); it can exceed 1 when the reverb is mostly wet, meaning out-of-phase or comb stereo, not a wider image. A render with a post chain also adds dry (the same facts before the post chain) and a post-delta line.

Song renders also report each section's level, width, spectral centroid, low-mid and 2-5k shares, and onset density, so an energy/space arc is visible without a second measurement pass. flat-space warns when neither the width nor the centroid moves between sections; flat-sections warns when the level range is under 2 dB. They are separate axes: a drop can open up without getting much louder.

The spectrum also reports diagnostic low-mid (150-500 Hz) and 2-5k shares. Stems are per-track RMS, centroid, low-mid, and pan before pan/sum.

The report bars line is the symbolic side of the report: bar count, attacks per bar (a chord counts once; a drum ~roll or ~flam counts its real hits), melodic notes per bar, and the whole score's pitch-class entropy. The report density line gives each section's attacks/drum hits/notes per bar and its quietest-busiest bar range.
The report structure line lists up to four melodic tracks as n notes, pc pitch classes, e pitch-class entropy in bits, s stepwise share (1-2 semitones), l leap share (5 or more), and r the share of bars that restate an earlier bar. The report register line names track pairs whose sounding ranges overlap by at least an octave inside a section.
The report harmony line reads the bottom of the texture: one bass note per bar (the lowest sounding pitch class, so an arpeggio reads as its bottom note and a sustaining note still counts), bass changes per bar, the share of bass moves by a fourth or a fifth and by a step, and each section's bass order.
It is not a chord analysis: no quality, inversion, or function is claimed.
With a key it also states the share of melodic notes inside that key's diatonic major or natural minor scale, and the accidentals used.
Without a key there is no in-key share: the key is a declaration, and an inferred tonic would be reported as a fact.
These are score facts, so the post chain cannot change them; the full per-bar grid is in the detail: "raw" artifact.

Finding kinds: sub-heavy, mud, harsh, masking, alias-risk, dynamics, loudness-flat, post-mud, post-harsh, post-dynamics, density-spike, density-flat, melody-static, melody-leapy, register-collision, key-mismatch, harmony-static, target. Each has an optional attribution and a next suggestion; they are observations, not pass/fail gates.
density-spike is one bar with far more attacks than its section; density-flat is a long section that repeats one attack count; melody-static is a whole arrangement held to two or three pitch classes; melody-leapy is a non-bass single line that never moves by step (a chord part is skipped, because its per-voice intervals are root motion).
register-collision is two tracks sharing two or more octaves in a section; key-mismatch is a declared key that most notes contradict; harmony-static is a section of eight or more bars that never moves its bass.

loudness-flat means a song sits on one level (LRA under 4 LU, sections within 6 dB) and is louder than -16 LUFS. A target adds a report target line with passed/range checks and one target finding per missed dimension.

Warnings loud (above -12 LUFS) and unsafe (above -9 LUFS) cover listening comfort; a render above -9 LUFS fails instead of writing the file.

Both tools accept detail: "raw". p8_music writes the full render report (including stems and dry) as <out>.analysis.json (the .wav suffix is replaced); p8_analyze appends, so loop.wav becomes loop.wav.analysis.json. A WAV has no stems or dry snapshot, because attribution has to happen during the render.

## Rules that fail or warn
| Mistake | Result |
| --- | --- |
| post, preset, style, quality, width, monoBelowHz, target, speed, wet, toneHz, minutes, out, p8_probe arguments (track, note, volume, seconds, style, bypassFilter, sensitivity), or p8_export out inside the score JSON | unknown-field error; pass them next to score |
| pan, send, duck, filter, highpassHz, lowShelf, highShelf or delay nested under "mix" | unknown-field error; they are flat track fields |
| mode "song" without an arrangement, or an arrangement without song mode | error |
| tail in loop mode | error; a loop must repeat seamlessly |
| a note or chord voice outside C1-C8 | error |
| a key that is not a tonic, e.g. "H", "Am7", "A dorian" | error; write the tonic and an optional maj/min |
| a pitched effect or drum suffix on a rest | error |
| a pitched effect on a drum track, or a drum suffix on a melodic track | error |
| a chord on a drum track | error; use one hit per step |
| an envelope name that collides with an effect, a drum articulation or a drum parameter | error |
| an absolute or escaping sample path, or a non-.wav sample | error before rendering |
| a pattern that does not divide the loop or section length | warning (pattern-misaligned) and a truncated last repetition |
| a step delay left on the base bpm while sections change tempo | warning (delay-base-tempo); set delay.follow to "section" or accept a constant echo time |
| section space set while every track and group has send 0 | warning (space-no-send); space scales the send buses and cannot be heard |
| an unknown group name, or both groups/buses or group/bus spellings | error; define one groups table and name a group that exists |
| a finished mix above -9 LUFS, or a loudness step hotter than -9 | error (hearing-safety ceiling); lower track volumes or use -14..-16 LUFS |`;
