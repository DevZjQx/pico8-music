// Model-facing reference for the score DSL. It lives here, next to the parser that
// owns these rules, and is kept out of every tool declaration so it only costs
// context when someone asks for it (/p8m in Pi, the p8_help tool, or the DSH
// description). Keep it in sync with parse.ts and docs/features/score.md.

export const SCORE_BRIEF =
  'PICO-8 score JSON: bpm, stepsPerBeat, bars and tracks of NOTE:STEPS tokens, ' +
  'with an optional song arrangement, patterns and motifs. post/preset/style are p8_music ' +
  'arguments outside the score JSON.';

export const SCORE_HELP = `PICO-8 score reference (also printed by /p8m in Pi)

Pass \`score\` as a JSON string, not a nested object, or pass \`scoreFile\` with a workspace-relative path to a JSON score file (.json is appended when omitted). Provide exactly one of them; a scoreFile is read on every render, so editing the file changes the next output.
The score JSON holds composition only. post, preset, style, speed, wet, toneHz, minutes and out are p8_music arguments passed next to score/scoreFile; putting any of them inside the score JSON is an error.

Loop mode:
{"bpm":90,"stepsPerBeat":4,"bars":4,"tracks":[{"role":"bass","waveform":"pulse","volume":5,"pattern":"C3:4 E3:4 G3:4 A3:4"}]}

Song mode adds patterns and an arrangement:
{"mode":"song","tracks":[{"name":"drums","role":"drums","pattern":"K:1 -:1 H:1 -:1"}],"patterns":{"drums.B":"K:1 H:1 S:1 H:1"},"arrangement":[{"name":"intro","bars":4,"mute":["drums"]},{"name":"drop","bars":8,"patterns":{"drums":"drums.B"}}]}

## Score fields
- bpm 30-300 (default 90), stepsPerBeat 1-8 (default 4), beatsPerBar 1-16 (default 4; 3 for 3/4), loop bars 1-64 (default 4); song sections use bars 1-64 and the optional total bars 1-256
- swing -0.5..0.5 shifts odd steps (positive delays, negative pushes); seed varies noise timbres, drum transients, humanize, and section risers
- humanize {timingMs 0-150, velocity 0-1} adds deterministic timing and gain variation; 0 is neutral
- tail 0-30 seconds renders extra song time after the last step so reverb and one-shots ring out; song mode only
- tracks: 1-32, one independent bus each; use as many as the arrangement needs (the cap is a render budget, not a musical rule)
- a chord lives inside one track; use separate tracks for separate parts (drums, bass, pad, lead, FX), not for chord voices
- motifs: {"A":"C4:1 E4:1"}, played as "@A.transpose(2).retrograde"; transforms are transpose(n), invert, retrograde, augment(n), diminish(n)
- envelopes: {"pluck":{"attack":0.002,"decay":0.07,"sustain":0.08,"release":0.03}}, used as "C4:4~pluck"; attack/decay/release are seconds 0-30, sustain is a 0-1 level
- samples: persisted workspace WAV assets: {"hit":"assets/hit.wav"} or {"vox":{"file":"assets/vox.wav","root":"C4","loop":false,"gain":1}}. Only 16-bit PCM WAV; root defaults C4, gain 0-4, at most 16 samples, 30 s each
- drumSamples: optional replacements by drum voice, e.g. {"kick":"hit","snare":"hit2"}; unmapped voices stay synthetic
- instruments: named voice definitions, used as "instrument":"name" on a track. type chip keeps the eight PICO-8 waveforms; additive sums band-limited harmonic partials; fm is two-operator phase modulation; sample plays an entry from the score's samples table. chip/additive/fm accept unison 1-4, detune 0-50 cents, drive 0-1, and filter {cutoffHz, resonance 0.05-20, envAmount, attack, decay, sustain, release}. chip adds waveform; additive adds partials (1-16 harmonics, harmonic 1 first; a harmonic is an amplitude 0-1, a negative amplitude for the mirrored wave, [amplitude, phaseDegrees], or [amplitude, phaseDegrees, decaySeconds 0-8]): {"type":"additive","partials":[1,-0.5,[0.25,90,1.5]]} designs a shape, partials are band-limited and peak-normalised; fm adds ratio 0.25-8, index 0-12, indexDecay 0.01-4 s; sample adds sample: "name" and no other voice fields
- additive extras: stretch 0-1 runs harmonic n at n*f0*sqrt(1+stretch*(n^2-1)) (fundamental stays in tune, highs sharpen for bells); tilt 0-4 scales harmonic n by n^-tilt (higher is darker); a third partial item is its decay time constant in seconds (0 keeps it static). Static partials still use the fast band-limited table; stretch or any nonzero decay renders each partial per sample, still band-limited and peak-normalised

## Track fields
- pattern: inline tokens, or the name of a pattern in the track's patterns or in top-level patterns; without it the first track-local pattern is used
- name (sections target it), role (drums, bass, lead, pad, ...), volume 0-7 (one decimal allowed), waveform: triangle, tilted_saw, saw, square, pulse, organ, noise, phaser
- instrument: a name from the top-level instruments table, an inline definition, or chip/fm/additive/drums; sample voices are named instruments or inline {"type":"sample","sample":"name"}. An explicit instrument outranks a style's role default; without one the legacy waveform path renders
- mix-stage fields are flat track fields, never nested under "mix": pan -1..1, send 0..1 (reverb send), duck 0..1 (kick sidechain), filter ({cutoffHz, resonance 0.05-20, lfoHz, lfoDepth} or a cutoff number), delay ({steps,feedback,mix}); a delay at least one loop long folds through the loop seam

## Pattern tokens
NOTE:STEPS[gGATE] or DRUM:STEPS; STEPS is 1-64 for a sounding token and 1-256 for a rest; GATE is 1-256 and defaults to the slot, shorter is staccato, longer is legato.
- "-" is a rest (no @volume, effects, envelope, or drum suffixes); "@volume" 0-7 (one decimal allowed) overrides the track volume
- "~effect": slide, vibrato, drop, fadein, fadeout, arpfast, arpslow; slide(steps 0.05-8) and vib(depth 0-2 semitones[, rateHz 0.1-20]) take parameters
- Drum tracks use drum articulations instead of pitched effects: ~ghost (quieter, shorter, darker), ~flam[(offsetMs 5-40)] (second hit 16 ms later by default), ~roll[(hits 2-8)] or ~roll4 (subdivide the slot; 4 hits by default)
- Drum hits also take ~pitch(semitones -12..12), ~decay(scale 0.25..4), and ~tone(cutoffHz 200..16000), on their own or after an articulation: "K:1~ghost~pitch(-2)~decay(1.4)"
- Chords: [C4,E4,G4]:4 (explicit voicings up to 8 voices) or names like Cmaj7, Fm, Fm/E, {C7} (named qualities expand to at most 4 voices)
- Each pattern should fill whole bars (stepsPerBeat * beatsPerBar steps per bar) so sections stay in phase; the parser warns when the section length is not a multiple of the pattern length

## Samples
Samples are files, not inline data: put a 16-bit PCM WAV in the workspace and reference it from the top-level samples table. Paths are workspace-relative (not relative to scoreFile), must end in .wav, and cannot escape the workspace. The app reads every declared sample before rendering and caches decoded PCM until the file's size or mtime changes. A sample instrument starts at the file head for every note, plays at the file's native speed when the note equals root, and stops at the file end unless loop is true. ~slide/~vibrato/~arp change playback speed; ~decay and per-note filter fields are not available on sample instruments. For drums, ~pitch retunes and ~tone low-passes the sample; ~decay (including ~ghost's decay shortening) has no sample equivalent and is ignored, while ~ghost's velocity/tone reduction still applies. A drum replacement never loops, so a looping sample used as a kick still decays.
{"samples":{"hit":"assets/hit.wav","vox":{"file":"assets/vox.wav","root":"A3","loop":true}},"instruments":{"choir":{"type":"sample","sample":"vox"}},"drumSamples":{"kick":"hit"},"tracks":[{"instrument":"choir","pattern":"A3:8"},{"role":"drums","pattern":"K:1 -:1 S:1 -:1"}]}

## Drums
A track with role "drums" uses K kick, S snare, H closed hat, O open hat, C clap, T tom, R rim, X crash. Single-letter tokens are case-insensitive except r, which is a rest; R is the rim. Add ~ghost, ~flam, or ~roll to a hit, plus optional ~pitch, ~decay, and ~tone; a rest and pitched effects reject them.

## Arrangement (song mode)
Sections take bars, patterns (keyed by track name or role), mute, gain/gains, filter (Hz, or {"from":500,"to":12000} for a sweep), energy (0-1: scales section gain and filter cutoff), riser (1-64 bars of noise sweep ending at the section boundary), and fill ({"bars":1,"patterns":{"drums":"fill.pattern"}}: replaces the last 1-2 bars for those tracks). Rendering a song ignores minutes.

## Post chain and presets (p8_music arguments, outside the score JSON)
post: [] skips the post chain (track send still applies; also set send: 0 for a fully dry mix); otherwise steps run in array order: tape/slow, lowpass, reverb (wet 0-1 is a dry/wet mix ratio, not a wet gain; the wet path sits about 5 dB under the dry, so wet 0.3 is a light reverb), then the master steps tilt (tiltDb), saturate (drive, mix), compress (thresholdDb, ratio, attack, release, makeupDb), loudness (targetLufs), and limiter (ceilingDb, release), for example [{"type":"tape","speed":0.8},{"type":"reverb","wet":0.4},{"type":"loudness","targetLufs":-14},{"type":"limiter"}]. Omit post to use style chip, hitech, ambient, studio, or lofi (style fills the chain; do not also pass preset), or a preset classic, dreamy, or tape. studio and lofi also supply role-based instrument defaults (bass, lead, pad, keys, default), which is how a score leaves the chip palette without changing its tokens; an explicit track.instrument wins. speed/wet/toneHz override the matching step or add one; speed sets the whole tape/slow chain's total speed. Output paths are workspace-relative and must end in .wav. Every render returns a report with peak, RMS, LUFS, spectrum, width, onsets, and warnings; width is side/mid RMS (0 mono, 1 hard-panned) and can exceed 1 when the reverb is mostly wet, which means out-of-phase/comb stereo rather than a wider image. p8_analyze re-reads an existing WAV.`;
