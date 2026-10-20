# render

**Purpose.** Turn a normalised score into a seamless or arranged stereo WAV,
with an explicit, ordered post chain, and report what the finished audio
measures.

**Owns.** PICO-8-flavoured synthesis (eight timbres, per-note volume, track or
named ADSR envelopes, note effects and their parameters), polyphonic event
scheduling (chords and legato gates overlap without voice stealing), swing
offsets, synthetic drum voices, song timelines, per-track buffers and the mix
stage (state-variable low-pass with LFO and resonance, step-timed feedback
delay, kick-triggered ducking, equal-power pan, reverb send), section filtering
and filter sweeps, resampling for the slowed pitch drop, tone shaping,
Freeverb-style reverb, steady-state loop extraction, a shared peak ceiling
instead of per-sample clipping, repetition to the requested length, and WAV
encoding. It also owns the post-chain contract: `tape`/`slow`, `lowpass`,
`reverb`, the master steps `tilt` / `saturate` / `compress` / `loudness` /
`limiter`, the `[]` dry path, the `chip` / `hitech` / `ambient` style
templates, BS.1770 integrated loudness, the render report (peak, RMS, spectrum,
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
and only exports one pattern at a time. Bit-exact PICO-8 sfx emulation: the
score carries musical effects (`slide`, `vibrato`, `arpfast`), not PICO-8's
32-note sfx memory layout, so the effects are musical approximations rather
than the original state machine. Sample-based drums were rejected for M1: they
would add assets and licensing, while short synthesized transients already give
the spectral separation the arrangement needs.

**Exceptions.** The reverb tunings are a port of the Freeverb comb/allpass
table; there is no runtime dependency on Freeverb itself. Drum synthesis uses
deterministic LCG noise, so renders stay reproducible; the score `seed` is
folded into that seed and the noise waveform. Each track renders into its own
buffer before filters, delay, ducking, pan, and send, so those parameters never
leak across tracks. The synth renders one sample-exact loop; the post stage may
repeat it for reverb steady state, the delay runs three passes in loop mode so
its line is primed with the loop's tail, and the send bus takes the same
three-pass steady state before it is added to the dry mix. Song mode still cuts
reverb tails at the end; a tail option belongs here later. The master stage is
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
