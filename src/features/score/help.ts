// Model-facing reference for the score DSL. It lives here, next to the parser that
// owns these rules, and is kept out of every tool declaration so it only costs
// context when someone asks for it (/p8m in Pi, the p8_help tool, or the DSH
// description). Keep it in sync with parse.ts and docs/features/score.md.

export const SCORE_BRIEF =
  'PICO-8 score JSON: bpm, stepsPerBeat, bars and up to 4 tracks of NOTE:STEPS tokens, ' +
  'with an optional song arrangement, patterns, motifs and post chain.';

export const SCORE_HELP = `PICO-8 score reference (also printed by /p8m in Pi)

Pass \`score\` as a JSON string, not a nested object.

Loop mode:
{"bpm":90,"stepsPerBeat":4,"bars":4,"tracks":[{"role":"bass","waveform":"pulse","volume":5,"pattern":"C3:4 E3:4 G3:4 A3:4"}]}

Song mode adds patterns and an arrangement:
{"mode":"song","tracks":[{"name":"drums","role":"drums","pattern":"K:1 -:1 H:1 -:1"}],"patterns":{"drums.B":"K:1 H:1 S:1 H:1"},"arrangement":[{"name":"intro","bars":4,"mute":["drums"]},{"name":"drop","bars":8,"patterns":{"drums":"drums.B"}}]}

## Score fields
- bpm 30-300 (default 90), stepsPerBeat 1-8 (default 4), loop bars 1-64 (default 4); song sections use bars 1-64 and the optional total bars 1-256
- swing 0-0.5 delays odd steps; seed varies noise timbres and drum transients
- tracks: 1-4, a hard limit
- motifs: {"A":"C4:1 E4:1"}, played as "@A.transpose(2).retrograde"; transforms are transpose(n), invert, retrograde, augment(n), diminish(n)
- envelopes: {"pluck":{"attack":0.002,"decay":0.07,"sustain":0.08,"release":0.03}}, used as "C4:4~pluck"

## Track fields
- pattern: inline tokens, or the name of a pattern in the track's patterns or in top-level patterns; without it the first track-local pattern is used
- name (sections target it), role (drums, bass, lead, pad, ...), volume 0-7, waveform: triangle, tilted_saw, saw, square, pulse, organ, noise, phaser
- mix-stage fields are flat track fields, never nested under "mix": pan -1..1, send 0..1 (reverb send), duck 0..1 (kick sidechain), filter ({cutoffHz,resonance,lfoHz,lfoDepth} or a cutoff number), delay ({steps,feedback,mix}); a delay at least one loop long folds through the loop seam

## Pattern tokens
NOTE:STEPS[gGATE] or DRUM:STEPS; gate defaults to the slot, shorter is staccato, longer is legato.
- "-" is a rest; "@volume" 0-7 overrides the track volume
- "~effect": slide, vibrato, drop, fadein, fadeout, arpfast, arpslow; slide(steps 0.05-8) and vib(depth 0-2 semitones[, rateHz 0.1-20]) take parameters
- Drum tracks use drum articulations instead of pitched effects: ~ghost (quieter, shorter, darker), ~flam[(offsetMs 5-40)] (second hit 16 ms later by default), ~roll[(hits 2-8)] or ~roll4 (subdivide the slot; 4 hits by default)
- Chords: [C4,E4,G4]:4 (up to 4 voices) or names like Cmaj7, Fm, Fm/E, {C7}
- Each pattern should fill whole bars (stepsPerBeat * 4 steps per bar) so sections stay in phase; the parser warns when the section length is not a multiple of the pattern length

## Drums
A track with role "drums" uses K kick, S snare, H closed hat, O open hat, C clap, T tom, R rim, X crash. Single-letter tokens are case-insensitive except r, which is a rest; R is the rim. Add ~ghost, ~flam, or ~roll to a hit; a rest and pitched effects reject them.

## Arrangement (song mode)
Sections take bars, patterns (keyed by track name or role), mute, gain/gains, filter (Hz, or {"from":500,"to":12000} for a sweep), energy (0-1: scales section gain and filter cutoff), and fill ({"bars":1,"patterns":{"drums":"fill.pattern"}}: replaces the last 1-2 bars for those tracks). Rendering a song ignores minutes.

## Post chain and presets
post: [] renders dry; otherwise steps run in array order: tape/slow, lowpass, reverb, then the master steps tilt (tiltDb), saturate (drive, mix), compress (thresholdDb, ratio, attack, release, makeupDb), loudness (targetLufs), and limiter (ceilingDb, release), for example [{"type":"tape","speed":0.8},{"type":"reverb","wet":0.4},{"type":"loudness","targetLufs":-14},{"type":"limiter"}]. Omit post to use style chip, hitech, or ambient (style fills the chain; do not also pass preset), or a preset classic, dreamy, or tape. speed/wet/toneHz override the matching step or add one; speed sets the whole tape/slow chain's total speed. Output paths are workspace-relative and must end in .wav. Every render returns a report with peak, RMS, LUFS, spectrum, width, onsets, and warnings; p8_analyze re-reads an existing WAV.`;
