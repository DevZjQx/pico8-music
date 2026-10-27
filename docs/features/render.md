# render

**Purpose.** Turn a normalised score into a seamless or arranged stereo WAV,
with an explicit, ordered post chain, and report what the finished audio
measures.

**Owns.** PICO-8-flavoured synthesis (eight timbres, per-note volume, track or
named ADSR envelopes, note effects and their parameters), the instrument layer
(`chip` / band-limited `additive` / `fm` with the classic two-operator voice or
1-3 fixed-routing modulators / persisted `sample`, unison detune, drive,
per-note filter envelopes, opt-in velocity-to-timbre (filter opening, drive,
and FM index), sample pitch/region/loop/gain, key and velocity zone selection,
and drum sample replacement), polyphonic event scheduling (chords and legato
gates overlap without voice stealing), swing offsets (score or per-track, with
`swingUnit` groups), authored micro-timing (`offsetMs`, `~drag`/`~push`, summed
and clamped to 0.49 of the local step with a deduplicated `timing-clamped`
warning), deterministic `humanize` timing/velocity (score defaults with
track-level field overrides), parameterised arps (semitones and period), the
score's per-section tempo map (events, gates,
swing, slides, arps, section filters, and risers resolve through absolute
seconds), an opt-in `quality: "clean"` band-limited chip/FM
path, synthetic drum voices and their articulations
(`ghost`, `flam`, `roll`), per-hit `pitch` / `decay` / `tone`, and the opt-in
`drumChoke` fade that cuts a ringing voice from a later trigger, arrangement
`riser` sweeps, song-end `tail` extension, song timelines, section `energy`
gain/filter scaling, section `space` send scaling, section `width` automation,
per-section per-track gain/pan/send/filter state, per-note `~pan`/`~send`
layers (plain, pan-only, send-only, and both, processed through the same track
chain), per-track buffers and the mix stage (state-variable low-pass with LFO and resonance,
per-track high-pass and low/high shelves, step-timed feedback delay,
kick-triggered ducking, equal-power pan, stereo reverb sends), named
groups/submixes with their own fader, pan, filter, EQ, delay, duck, saturate,
compress, and stereo return, solo/mute audition filtering (track names resolved
before roles, with the kick sidechain following the audible drums), section filtering
and filter sweeps, resampling for the slowed pitch drop, tone shaping,
Freeverb-style reverb with optional send predelay, wet low/high cut, and slow
delay modulation, master width/low-band mono, steady-state loop extraction, a shared peak ceiling
instead of per-sample clipping, repetition to the requested length, and WAV
encoding. It also owns the post-chain contract: `tape`/`slow`, `lowpass`
(with an optional 12/24 dB/oct slope), `highpass`, `highShelf`, `reverb`, the
master steps `tilt` / `saturate` / `compress` / `loudness` / `limiter`, the
`[]` dry path, the `chip` / `hitech` / `ambient` / `studio` /
`lofi` / `soft` style templates (including role-based instrument defaults and
style-level quality/master defaults), optional target profiles and their
range checks, optional `assert` ranges, BS.1770 integrated loudness, the render
report (sample peak, 4x true peak, RMS, spectrum, width, L/R correlation and
balance, onsets, per-section level/width/correlation/balance/centroid/low-mid/2-5k/onsets,
warnings, per-stem summaries and per-section stem RMS (measurements, not audio stems; export is a proposed
app contract, see `docs/forms-and-exports.md`), a pre-post snapshot, the symbolic structure
reading, and attributed findings),
the delta table between two analyses (`compare.ts`, used by `p8_music`
`compare` and `p8_analyze detail: compare`), the dry single-note timbre probe (spectral slope, odd/even harmonics,
attack/decay, high-frequency decay, FM sidebands, and measured parameter
sensitivity), cooperative abort checks, and WAV decoding for `p8_analyze`.

**Does not own.** Score validation, note/drum naming, or arrangement
resolution — that is `score`'s contract. Reading or decoding sample files is
`app`'s job: the renderer receives a decoded `samples` map on `RenderOptions`
and never touches disk. Writing files, choosing an output path, and formatting
the report as tool text belong to `app/render-service.ts` /
`app/dsh-plugin.ts`. Playback is not part of the loop; loudness
normalisation is, as an explicit `loudness` post step.

**Depends on.** `score` through its single public entry, for the `Score` type
and the tempo-map helpers that resolve a step to seconds, and `structure` for
the symbolic reading that the report attaches. The audio path never reads the
structure result; only `analyseAudio` and `formatReport` do.

**Public surface.** `feature.ts` only; the export list is not repeated here.

**Owner.** Unassigned.

**Exceptions.** The reverb tunings are a port of the Freeverb comb/allpass
table; there is no runtime dependency on Freeverb itself. The post-chain reverb derives its send
from the mono sum but keeps the dry path stereo, so an insert cannot fold a
panned mix to mono. Track and group sends use `reverbStereo` instead: each
channel drives its own comb bank, so a hard-panned send returns on that side.
For a centred send the two paths are sample-identical, which is why old
centred scores keep their level while panned sends gain their image. Drum synthesis uses
deterministic LCG noise, so renders stay reproducible; the score `seed` is
folded into that seed and the noise waveform. A drum articulation only changes
the per-hit plan (extra hits, velocity, decay, tone, pitch) and never adds a
new render path; a `~pitch` suffix multiplies only the pitched components, so
noise-based hats keep their spectrum; and an explicit `chip` instrument reuses
`waveform.ts` so it stays sample-identical to the legacy `waveform` field. A
static additive voice rebuilds its table per note from the score's harmonics,
band-limited at that pitch, and scales it by a measured peak rather than by the
amplitude sum: phase and tilt then change the shape without moving the level,
and additive/FM anchor at ~0.25 peak, while the chip waveforms keep their own
0.25-0.5 peaks, so swapping voice types does not jump the mix beyond that
palette. A note's `velocity` mapping is opt-in: when absent, `InstrumentVoice` keeps the
historical fixed filter cutoff and drive, sample for sample. When present, the
normalised velocity (authored `@volume` times humanize gain, clamped to 0..1)
opens the instrument filter by up to `cutoffOctaves` and adds up to `drive` on
top of the base soft clip; on FM, `indexScale` additionally scales the index
down as velocity falls. Multipliers of exactly 1 are the identity, so a zero
mapping stays sample-identical. The parser rejects `cutoffOctaves` without a
filter and rejects the field on sample voices, where playback rate and the
sample table own the timbre. Velocity still scales amplitude as before, so the mapping only
adds the brightness half of the response. `stretch` (0-1) sharpens upper harmonics
without detuning the fundamental, and a third partial item is an exponential
decay time constant. Either one switches the note to per-partial synthesis with
per-unison-voice phase and gain state; that path is still band-limited and still
uses the cycle table only as its level reference, but a decayed gain is one
multiply per partial per sample instead of an `exp()` call. The additive voice
receives the event's already-tuned frequency, so its band limit follows the
score tuning; playback pitch comes from that same frequency, which keeps
per-note cents and temperament audible through additive, FM, chip, and sample
voices alike. The cost is a deliberate level shift for scores written before
this: a peak-normalised additive voice sits about 2.6 dB above the old
sum-normalised one.  a `roll` subdivides the event's slot, and a `flam` offsets the
second hit by milliseconds, so both wrap at the loop seam with the same
sample-exact rule as a normal one-shot. Each track renders into its own buffer
before filters, delay, ducking, pan, and send, so those parameters never leak
across tracks. Humanize is a stateless hash of `(seed, track, event, voice)`:
the offset wraps on the loop seam and the depth-zero case skips the multiply
altogether, which keeps old scores sample-identical. Authored timing is
separate and shared by melodic notes and drum hits: track offset plus token
offset, clamped to 0.49 of the step length at the event's section, rounded to
samples, then humanize added. The clamp only moves the onset; gate, pattern
cursor, and duck trigger stay tied to the event that moved. `structure` ignores
the offset and the probe zeroes it. A track's step delay is
timed against the top-level `bpm` by default, so its read offset is constant
for the whole stem. With `delay.follow: "section"` the read point is
`secondsAtStep(stepAtTime(t) - steps)`: it stays continuous and monotonic, so
there is no click, but its rate changes at a tempo boundary and gives a short
tape-like pitch shift. A uniform tempo map takes the integer constant-delay path
even with the option on, so the option only changes the reference when the
sections themselves differ. A section riser is a noise-driven band-pass sweep
plus a quiet sine sweep, deterministic from the seed and faded to zero at the
boundary. Section `space` scales every stereo send after the section filter and
before its reverb, so the dry level is untouched; a song with no track or group
send has no bus, and the parser warns (`space-no-send`). A section `tracks` entry can
supply a send that the base track did not have, and that also creates the bus.
Section `width` scales the finished side signal after the post chain and before
the master `monoBelowHz`/`width` stage, with section seconds divided by the
tape/slow speed; both multipliers default to 1, which keeps old songs
sample-identical. Per-section track state is applied at the track insert/mix
stage: `filter` is a track-local automated low-pass before pan/send, `pan` and
`send` are constant inside the section, and a song tail keeps the last
section's state. If no section sets pan/send/filter for a track, the renderer
keeps the old constant-pan fast path exactly. The synth renders one sample-exact loop;
the post stage may repeat it for reverb steady state, the delay runs three
passes in loop mode so its line is primed with the loop's tail, and each send
bus takes the same three-pass steady state before it is added to the dry mix.
Groups are summed into a subgroup buffer before their fader/pan/filter/delay/
duck, so group processing runs once on the sum rather than once per member;
member sends and `group.send` share that group's return, while ungrouped
tracks use the default return. A
song `tail` extends the synth and post buffers by N seconds so send/post reverb
and one-shots can finish; a 20 ms final fade prevents a cut. The master stage is
step-based, not a fixed bus: `loudness` and the report share one BS.1770
implementation so a target can be verified, and the same K-weighting pass also
yields the EBU Tech 3342 loudness range (LRA), so the report can say whether a
song holds one level without paying for a second filter pass. `limiter` is a
real gain envelope rather than the shared `limitPeak` trim, which stays last as
a 16-bit safety net. `MAX_SAFE_LUFS` (-9 LUFS) is the one hard limit the
report names: the app layer (`app/render-service.ts`) refuses to write a
finished mix above it rather than trimming it, because that is a
listening-safety boundary, not an aesthetic preference; `p8_analyze` only
warns about it, since an existing WAV cannot be made quieter by measuring it. Spectrum analysis uses the magnitude spectrum, not power:
power weighting lets one loud kick hide the hats that decide whether a loop is
actually dark. The report also keeps two diagnostic shares outside the five
published bands: low-mid (150-500 Hz) and presence (2-5 kHz). Stem summaries
are measured before pan/sum and never retain track audio, so attribution stays
O(one track) in memory; the pre-post snapshot uses the same measurement code as
the final report, which is what makes `post-delta` a like-for-like comparison.
Findings are observations, not gates: they name a symptom, attribute it when
stems/dry data exist, and suggest a knob. `alias-risk` is a score-level
heuristic (direct-form chip wave at or above C6), not a spectral measurement;
`sub-heavy` is the 20-60 Hz portability check, and `p8_analyze` deliberately
has no stems or dry snapshot because a finished
WAV cannot support attribution. The DC block runs before the first master step so the limiter
sees the final signal rather than a high-pass overshoot of it.

Clean quality is an oscillator switch, not a master step. Chip saw and pulse
use PolyBLEP at their jump edges; triangle, tilted saw, organ, noise, and
phaser are continuous and keep the historical formula, so clean is
sample-identical there. FM evaluates the classic two-operator formula or the
multi-operator tree and caps each modulator index with Carson's rule so the
highest significant sideband stays under Nyquist at high pitches. The
multi-operator path accumulates modulation into one scratch slot per operator
and evaluates in descending index order, which is why a target only needs to be
lower than its own index. Its first sample-identical test is that a single
operator equals the classic voice, arithmetic included. `quality: "pico"` and an omitted `quality` are the same path, so
old scores remain sample-exact; a style may choose `clean` as its default and
an explicit `quality` always wins. The per-track high-pass and shelves are RBJ
biquads applied after the instrument/track filter and before delay/duck, so
one part can lose its 150-500 Hz overlap without a global lowpass; a zero-gain
shelf is skipped. The post lowpass keeps the historical one-pole 6 dB/oct path
for `order: 1`; `order: 2` and `4` cascade Butterworth biquads at 12/24 dB/oct.
`highShelf` is a master RBJ high shelf with a 3000 Hz default corner; a zero
gain returns before the DC block, so it stays sample-identical to omitting the
step. The shelf is the targeted control for 2-5 kHz presence: steepening a
lowpass whose corner is already at 7-9 kHz cannot remove content well below
that corner. Master `width` and `monoBelowHz` run after the ordered post
chain: width scales the side signal, and the mono fold removes only the
low-passed side band, leaving the mid and the rest of the image intact. Both
are absent by default and therefore do not change an old render. Reverb
`predelayMs` and modulation delay only the send, so the dry path keeps its
alignment; `lowCutHz` and `highCutHz` filter only the wet return. A target is a
set of ranges (`lowMidMax`, `harshMax`, `crestMin`, `width`, `lufs`,
`centroidHz`) that turns misses into `target` findings and a passed/total
summary line; it never collapses to a single score or changes the render.

A sample voice advances a read position by `frequency / rootFrequency`, so the
existing slide/vibrato/arp paths work unchanged; a one-shot stops at the
selected region's end and a loop wraps from `loopEnd` back to `loopStart`,
playing the region head as a one-shot intro first. Regions are cut in `app`,
which also reverses the PCM and mirrors the loop window, so `render` only ever
sees one forward buffer; the decoded-PCM cache is still keyed by file, so
several named slices of one WAV cost one decode. A zone set is resolved per
note by nearest key range, then nearest velocity layer, with a nearest-zone
fallback instead of silence; drums run the same selection per hit, so ghost,
flam, and roll velocities can cross a layer boundary. Drum samples force
one-shot playback (a looping kick must still decay), honor `~pitch`/`~tone`,
and multiply `~decay` into an exponential amplitude envelope; `~ghost` still
lowers velocity and tone. Linear interpolation is deliberate: the feature is
asset playback, not a resampling library. Sample playback is deterministic from
the file bytes and score, like every other voice.

**Boundary evidence.** Deleting this folder breaks `app/render-service.ts`, `app/dsh-plugin.ts`, and `app/pi-extension.ts`; the app adapters reach it through `render-service.ts`.
A second audio output format (FLAC, MP3) belongs here, next to `wav.ts`, not in
the app layer.
