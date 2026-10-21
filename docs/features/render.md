# render

**Purpose.** Turn a normalised score into a seamless or arranged stereo WAV,
with an explicit, ordered post chain, and report what the finished audio
measures.

**Owns.** PICO-8-flavoured synthesis (eight timbres, per-note volume, track or
named ADSR envelopes, note effects and their parameters), the instrument layer
(`chip` / band-limited `additive` / two-operator `fm`, unison detune, drive, and
per-note filter envelopes), polyphonic event scheduling (chords and legato
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
resolution — that is `score`'s contract. Writing files, choosing an output
path, and formatting the report as tool text: `app/render-service.ts` /
`app/dsh-plugin.ts` do that. Playback is not part of the loop; loudness
normalisation is, as an explicit `loudness` post step.

**Depends on.** `score` through its single public entry, for the `Score` type
only.

**Public surface.** `feature.ts` only; the export list is not repeated here.

**Owner.** Unassigned.

**Rejected.** Shelling out to `ffmpeg`/`sox`: it would make installation depend
on binaries that are absent in some DSH profiles, and steady-state loop
extraction needs sample-accurate control that a filter graph makes awkward.
Official PICO-8 `export foo.wav`: it requires a licensed, interactive editor
and only exports one pattern at a time. Sample playback and user wavetables:
licensed or user-supplied assets would break the single-file plugin and
reproducible-render guarantees, so non-chip voices are synthesized instead.
This does not rule out a model-designed shape: an additive table is built from
numbers in the score (amplitudes plus per-harmonic phase), carries no asset, and
stays byte-reproducible, so `partials` is where wave design lives.
Bit-exact PICO-8 sfx emulation: the
score carries musical effects (`slide`, `vibrato`, `arpfast`), not PICO-8's
32-note sfx memory layout, so the effects are musical approximations rather
than the original state machine. Sample-based drums were rejected for M1: they
would add assets and licensing, while short synthesized transients already give
the spectral separation the arrangement needs.

**Exceptions.** The reverb tunings are a port of the Freeverb comb/allpass
table; there is no runtime dependency on Freeverb itself. Drum synthesis uses
deterministic LCG noise, so renders stay reproducible; the score `seed` is
folded into that seed and the noise waveform. A drum articulation only changes
the per-hit plan (extra hits, velocity, decay, tone, pitch) and never adds a
new render path; a `~pitch` suffix multiplies only the pitched components, so
noise-based hats keep their spectrum; and an explicit `chip` instrument reuses
`waveform.ts` so it stays sample-identical to the legacy `waveform` field. An
additive table is rebuilt per note from the score's harmonics, band-limited at
that pitch, and scaled by its measured peak rather than by the amplitude sum:
phase then changes the shape without moving the level, and every voice type
anchors at ~0.25 peak (chip, FM, additive), so swapping voice types does not
jump the mix. The cost is a deliberate level shift for scores written before
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

**Boundary evidence.** Deleting this folder breaks `app/render-service.ts`, `app/dsh-plugin.ts`, and `app/pi-extension.ts`; the app adapters reach it through `render-service.ts`.
A second output format (FLAC, MP3) belongs here, next to `wav.ts`, not in the
app layer.
