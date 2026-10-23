// Model-facing reference for the score DSL. It lives here, next to the parser that
// owns these rules, and is kept out of every tool declaration so it only costs
// context when someone asks for it (/p8m in Pi, the p8_help tool, or the DSH
// description). Keep it in sync with parse.ts and the field tables in README.md;
// docs/features/score.md records the ownership boundary, not the field ranges.

export const SCORE_BRIEF =
  'PICO-8 score JSON: bpm, stepsPerBeat, bars and tracks of NOTE:STEPS tokens, ' +
  'with an optional song arrangement, patterns and motifs. post/preset/style are p8_music ' +
  'arguments outside the score JSON.';

export const SCORE_HELP = `PICO-8 score reference

Pass \`score\` as a JSON string, not a nested object, or pass \`scoreFile\` with a workspace-relative path to a JSON score file (.json is appended when omitted). Provide exactly one of them; a scoreFile is read on every render, so editing the file changes the next output.
The score JSON holds composition only. post, preset, style, speed, wet, toneHz, minutes and out are p8_music arguments passed next to score/scoreFile; putting any of them inside the score JSON is an error.

## Contents
1. Minimal scores
2. Render budgets
3. Score fields (tuning, envelopes, motifs)
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
| tail | 0-30 seconds after the last step so reverb and one-shots ring out; song mode only | 0 |
| tracks | 1-32, one independent bus each; see Render budgets | required |
| patterns | top-level name -> token string, referenced by track.pattern or a section pattern | empty |
| motifs | top-level name -> token string, played as @name; see Motifs | empty |
| envelopes | top-level name -> {attack, decay, sustain, release}; see Envelopes | empty |
| instruments | top-level name -> voice; see Instruments | empty |
| samples | top-level name -> WAV spec; see Samples | empty |
| drumSamples | drum voice -> sample name, e.g. {"kick":"hit"}; unmapped voices stay synthetic | empty |
| arrangement | array of sections; see Arrangement | none |

A chord lives inside one track; use separate tracks for separate parts (drums, bass, pad, lead, FX), not for chord voices.

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
| pattern | inline tokens, or a pattern name: track-local first, then top-level | first track-local pattern |
| patterns | track-local name -> token string; a name here outranks a top-level one | empty |
| motifs | track-local name -> token string; overrides a top-level name on collision | empty |
| waveform | triangle, tilted_saw, saw, square, pulse, organ, noise, phaser, or 0-7; valid without an instrument or on a chip instrument (invalid on fm/additive/sample); wins over a chip instrument's waveform | pulse |
| instrument | a top-level name, an inline definition, or chip/fm/additive/drums; sample voices are named or inline {"type":"sample","sample":"name"}; an explicit instrument outranks a style's role default; without one the legacy waveform path renders | none |
| volume | 0-7, one decimal allowed; notes without @volume use it | 5 |
| envelope | inline ADSR {attack, decay, sustain, release}; attack/decay/release 0-30 s, sustain 0-1 | 0.004, 0, 1, 0.008 |
| pan | -1 left .. 1 right; equal power, centred leaves the level unchanged | 0 |
| send | 0..1 reverb send | 0 |
| duck | 0..1 kick sidechain depth | 0 |
| filter | a cutoff number (100-20000 Hz) or {cutoffHz (alias cutoff), resonance (alias q) 0.05-20, lfoHz 0-20, lfoDepth 0-4 octaves} | none |
| highpassHz | 20-4000 Hz, 12 dB/oct; cuts this stem only, so one part can lose its mud without darkening the mix | none |
| lowShelf | a gain in dB (-24..24) at 250 Hz, or {hz 20-20000, gainDb}; 0 is a no-op | none |
| highShelf | a gain in dB (-24..24) at 4000 Hz, or {hz 20-20000, gainDb}; 0 is a no-op | none |
| delay | {steps 1-64, feedback 0-0.95, mix 0-1}; timed against the top-level bpm even when sections change tempo; a delay at least one loop long folds through the loop seam; in song mode a delay longer than the song is silent | none |

- mix-stage fields are flat track fields, never nested under "mix".
- drum tracks ignore waveform, envelope and instrument; each hit is its own transient.
- unknown fields are rejected, not silently ignored.

## Pattern tokens
Space-separated tokens: NOTE:STEPS[gGATE] on melodic tracks, DRUM:STEPS on drum tracks.
- notes are C4, F#3, Bb2 within C1-C8.
- STEPS is 1-64 for a sounding token and 1-256 for a rest; GATE is 1-256 and defaults to the slot.
- a gate shorter than the slot is staccato; longer is legato and sounds into the next slot.
- each pattern should fill whole bars (stepsPerBeat * beatsPerBar steps per bar) so sections stay in phase; when a section length is not a multiple of the pattern length the parser warns and truncates the last repetition.

| Suffix | Meaning |
| --- | --- |
| - | rest: no @volume, effect, envelope or drum suffix, and up to 1-256 steps |
| @volume | 0-7, one decimal allowed, overrides the track volume; order with ~ is free ("@6~slide" or "~slide@6") |
| ~effect | one pitched effect; see Effects |
| ~name | one named envelope from the top-level envelopes table |
| drum suffix | articulations and per-hit parameters; see Drums |

At most one @volume, one ~effect, one named envelope and one drum articulation per token; each drum parameter also appears at most once.

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
| fm | ratio 0.25-8, index 0-12, indexDecay 0.01-4 s | two-operator phase modulation |
| sample | sample: "name" | plays an entry from the score's samples table |

chip/additive/fm share unison 1-4, detune 0-50 cents, drive 0-1, filter {cutoffHz 80-18000, resonance 0.05-20, envAmount 0-6 octaves, attack, decay, sustain, release}, and optional velocity {cutoffOctaves 0-6, drive 0-1}.
- velocity: @volume then also opens the instrument filter by cutoffOctaves and adds soft-clip drive, so accents get brighter; cutoffOctaves needs a filter; absent or all zeros is neutral; sample voices reject velocity.
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

- \`{"hit":"assets/hit.wav"}\` is shorthand for \`{"file":"assets/hit.wav"}\`; stereo is averaged to mono before pan, send and filter.
- the app reads every declared sample before rendering, including unused ones, and caches decoded PCM until the file's size or mtime changes. A bad path fails before the render, not at the first note.
- a sample instrument starts at the file head for every note, plays at native speed when the note equals root, and stops at the file end unless loop is true; the score's tuning still retunes playback speed.
- ~slide, ~vibrato, ~arpfast and ~arpslow change playback speed; ~fadein, ~fadeout, the track envelope and a named envelope still shape gain. ~decay and per-note filter fields are not available on sample instruments.
- drums: ~pitch retunes and ~tone low-passes the sample; ~decay (including ~ghost's decay shortening) has no sample equivalent and is ignored, while ~ghost's velocity and tone reduction still applies. A drum replacement never loops, so a looping sample used as a kick still decays.
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
| filter | cutoff Hz 100-20000, or {"from":500,"to":12000} for a sweep | none |
| energy | 0-1 macro; 0 halves gain and takes the filter cutoff to 0.35x, 1 changes nothing | 1 |
| riser | 1-64 bars of noise plus sine sweep ending at the section boundary; cannot exceed the section | none |
| fill | {"bars":1,"patterns":{"drums":"fill.pattern"}}: replaces the last 1-2 bars for those tracks | none |

- with an arrangement, mode defaults to song; an arrangement without song mode is an error.
- per-section bpm changes tempo only at section boundaries: the arrangement still writes bars and steps, but the section's duration is bars * beatsPerBar * 60 / bpm. Loop mode keeps one bpm, and there are no gradual ramps or arbitrary tempo automation.
- sections should be a whole multiple of every pattern they use; otherwise the parser warns (pattern-misaligned) and truncates the last repetition.
- filter and energy stack: the sweep runs first, then energy multiplies the cutoff; gain and gains apply after energy.
- a fill whose pattern does not divide the fill window warns (fill-misaligned).
- the song renders once and ignores minutes; use post: [] plus send: 0 for a tight ending, or tail for ring-out.

## Post chain, styles, presets (p8_music arguments, outside the score JSON)
post: [] skips the post chain (track send still applies; also set send: 0 for a fully dry mix). Otherwise steps run in array order, usually tape/slow -> lowpass -> reverb -> tilt -> saturate -> compress -> loudness -> limiter.

| Step | Parameters | Notes |
| --- | --- | --- |
| tape / slow | speed 0.5-1.5 | speed sets the whole tape/slow chain's total speed |
| lowpass | cutoffHz 100-22050 | |
| reverb | wet 0-1, room 0-0.98, damp 0-1, predelayMs 0-200, lowCutHz 20-1000, highCutHz 1000-20000, modDepth 0-1, modRateHz 0.05-5 | wet is a dry/wet mix ratio, not a wet gain; the wet path sits about 5 dB under the dry, so 0.3 is a light reverb. predelay and modulation delay only the send; the wet filters remove low cloud and metallic highs |
| tilt | tiltDb -12..12 | |
| saturate | drive 0-1, mix 0-1 | |
| compress | thresholdDb -60..0, ratio 1-40, attack 0.0005-1, release 0.01-2, makeupDb -12..24 | |
| loudness | targetLufs -40..-5 | |
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

Every render returns a report: peak, RMS, LUFS, spectrum, width, onsets, warnings, stems, and findings. Width is side/mid RMS (0 mono, 1 hard-panned); it can exceed 1 when the reverb is mostly wet, meaning out-of-phase or comb stereo, not a wider image. A render with a post chain also adds dry (the same facts before the post chain) and a post-delta line.

The spectrum also reports diagnostic low-mid (150-500 Hz) and 2-5k shares. Stems are per-track RMS, centroid, low-mid, and pan before pan/sum.

Finding kinds: mud, harsh, masking, alias-risk, dynamics, post-mud, post-harsh, post-dynamics, target. Each has an optional attribution and a next suggestion; they are observations, not pass/fail gates. A target adds a report target line with passed/total range checks and one target finding per missed dimension.

Both tools accept detail: "raw". p8_music writes the full render report (including stems and dry) as <out>.analysis.json (the .wav suffix is replaced); p8_analyze appends, so loop.wav becomes loop.wav.analysis.json. A WAV has no stems or dry snapshot, because attribution has to happen during the render.

## Rules that fail or warn
| Mistake | Result |
| --- | --- |
| post, preset, style, quality, width, monoBelowHz, target, speed, wet, toneHz, minutes or out inside the score JSON | unknown-field error; pass them next to score |
| pan, send, duck, filter, highpassHz, lowShelf, highShelf or delay nested under "mix" | unknown-field error; they are flat track fields |
| mode "song" without an arrangement, or an arrangement without song mode | error |
| tail in loop mode | error; a loop must repeat seamlessly |
| a note or chord voice outside C1-C8 | error |
| a pitched effect or drum suffix on a rest | error |
| a pitched effect on a drum track, or a drum suffix on a melodic track | error |
| a chord on a drum track | error; use one hit per step |
| an envelope name that collides with an effect, a drum articulation or a drum parameter | error |
| an absolute or escaping sample path, or a non-.wav sample | error before rendering |
| a pattern that does not divide the loop or section length | warning (pattern-misaligned) and a truncated last repetition |`;
