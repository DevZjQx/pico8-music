# render

**Purpose.** Turn a normalised score into a seamless or arranged stereo WAV,
with an explicit, ordered post chain, and report what the finished audio
measures.

**Owns.** PICO-8-flavoured synthesis (eight timbres, per-note volume, track or
named ADSR envelopes, note effects and their parameters), the instrument layer
(`chip` / band-limited `additive` / two-operator `fm` / persisted `sample`,
unison detune, drive, per-note filter envelopes, sample pitch/loop/gain, and
drum sample replacement), polyphonic event scheduling (chords and legato
gates overlap without voice stealing), swing offsets, deterministic
`humanize` timing/velocity, synthetic drum voices and their articulations
(`ghost`, `flam`, `roll`) and per-hit `pitch` / `decay` / `tone`, arrangement
`riser` sweeps, song-end `tail` extension, song timelines, section `energy`
gain/filter scaling, per-track
buffers and the mix stage (state-variable low-pass with LFO and resonance, step-timed feedback
delay, kick-triggered ducking, equal-power pan, reverb send), section filtering
and filter sweeps, resampling for the slowed pitch drop, tone shaping,
Freeverb-style reverb, steady-state loop extraction, a shared peak ceiling
instead of per-sample clipping, repetition to the requested length, and WAV
encoding. It also owns the post-chain contract: `tape`/`slow`, `lowpass`,
`reverb`, the master steps `tilt` / `saturate` / `compress` / `loudness` /
`limiter`, the `[]` dry path, the `chip` / `hitech` / `ambient` / `studio` /
`lofi` style templates (including role-based instrument defaults), BS.1770
integrated loudness, the render report (peak, RMS, spectrum,
width, onsets, section energies, warnings), cooperative abort checks, and WAV
decoding for `p8_analyze`.

**Does not own.** Score validation, note/drum naming, or arrangement
resolution — that is `score`'s contract. Reading or decoding sample files is
`app`'s job: the renderer receives a decoded `samples` map on `RenderOptions`
and never touches disk. Writing files, choosing an output path, and formatting
the report as tool text belong to `app/render-service.ts` /
`app/dsh-plugin.ts`. Playback is not part of the loop; loudness
normalisation is, as an explicit `loudness` post step.

**Depends on.** `score` through its single public entry, for the `Score` type
only.

**Public surface.** `feature.ts` only; the export list is not repeated here.

**Owner.** Unassigned.

**Exceptions.** The reverb tunings are a port of the Freeverb comb/allpass
table; there is no runtime dependency on Freeverb itself. Drum synthesis uses
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
palette. `stretch` (0-1) sharpens upper harmonics
without detuning the fundamental, and a third partial item is an exponential
decay time constant. Either one switches the note to per-partial synthesis with
per-unison-voice phase and gain state; that path is still band-limited and still
uses the cycle table only as its level reference, but a decayed gain is one
multiply per partial per sample instead of an `exp()` call. The cost is a deliberate level shift for scores written before
this: a peak-normalised additive voice sits about 2.6 dB above the old
sum-normalised one.  a `roll` subdivides the event's slot, and a `flam` offsets the
second hit by milliseconds, so both wrap at the loop seam with the same
sample-exact rule as a normal one-shot. Each track renders into its own buffer
before filters, delay, ducking, pan, and send, so those parameters never leak
across tracks. Humanize is a stateless hash of `(seed, track, event, voice)`:
the offset wraps on the loop seam and the depth-zero case skips the multiply
altogether, which keeps old scores sample-identical. A section riser is a
noise-driven band-pass sweep plus a quiet sine sweep, deterministic from the
seed and faded to zero at the boundary. The synth renders one sample-exact loop;
the post stage may repeat it for reverb steady state, the delay runs three
passes in loop mode so its line is primed with the loop's tail, and the send bus
takes the same three-pass steady state before it is added to the dry mix. A
song `tail` extends the synth and post buffers by N seconds so send/post reverb
and one-shots can finish; a 20 ms final fade prevents a cut. The master stage is
step-based, not a fixed bus: `loudness` and the report share one BS.1770
implementation so a target can be verified, and `limiter` is a real gain
envelope rather than the shared `limitPeak` trim, which stays last as a
16-bit safety net. Spectrum analysis uses the magnitude spectrum, not power:
power weighting lets one loud kick hide the hats that decide whether a loop is
actually dark. The DC block runs before the first master step so the limiter
sees the final signal rather than a high-pass overshoot of it.

A sample voice advances a read position by `frequency / rootFrequency`, so the
existing slide/vibrato/arp paths work unchanged; a one-shot stops at the file
end and a loop wraps at the sample's length. Drum samples force one-shot
playback (a looping kick must still decay), honor `~pitch`/`~tone`, and ignore
`~decay`, which has no sample equivalent; `~ghost` still lowers velocity and
tone, but its shortened decay is synthetic-only. Linear interpolation is deliberate:
the feature is asset playback, not a resampling library. Sample playback is
deterministic from the file bytes and score, like every other voice.

**Boundary evidence.** Deleting this folder breaks `app/render-service.ts`, `app/dsh-plugin.ts`, and `app/pi-extension.ts`; the app adapters reach it through `render-service.ts`.
A second output format (FLAC, MP3) belongs here, next to `wav.ts`, not in the
app layer.
