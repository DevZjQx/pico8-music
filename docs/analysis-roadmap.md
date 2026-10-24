# Analysis feedback roadmap: letting the model hear what it wrote

This document is the M1-M3 plan for the `p8_music` / `p8_analyze` reporting capability. The goal is not to turn the plug-in into a DAW, nor to give the model a "score"; it is to let the model answer three questions after composing:

1. **Which part, section, or effect step caused this impression?** (attribution)
2. **How far is it from my previous version, or from the target I declared?** (delta)
3. **If I want to change it, which knob should I turn?** (actionable next)

M1 and M2 are implemented; M3 is still a plan.

## Principles

- **Separate facts, intent, and advice.** A report gives measurements (facts) first, then "deviation from the declared target", and only then advice. Without a declared target it does not judge good or bad, it only describes.
- **Attribution before numbers.** "Low-mid at 34%" is less useful than "low-mid at 34%, mostly from pad + bass overlapping at 150-500 Hz".
- **Everything queryable, presented in layers.** The always-on report carries only a summary and the 3-5 items most worth reading; full data is fetched on demand or written as a workspace artifact so it does not occupy context.
- **No single score.** A total score gets optimised into Goodhart's law. Stay multi-dimensional, let the model ignore advice, and let the model declare its own aesthetic target.
- **Do not change existing renders.** Every new capability leaves existing audio output unchanged by default; band-limiting, EQ, width, and so on are opt-in.

## M1: attributable summaries (landed in this iteration)

Status: **implemented**.

### 1. Per-track stem summaries

`renderScore` measures each track's buffer once, before pan/sum, and keeps only the summary, not the audio:

- `name`, `role`, `pan`, `send`, `aliasRisk`
- `rmsDb`, `peakDb`, `centroidHz`, five bands, `lowMid`, `harsh`, `onsetPerSecond`

These summaries go into `report.stems`. `renderScore` memory stays O(one track); a 32-track score does not keep 32 full audio buffers.

### 2. pre-post vs post delta

`renderLoop` measures once before the post chain (`report.dry`; no measurement when the chain is empty) and once after mastering. The report gives:

- centroid change
- low-mid change
- crest change
- width change

This separates "the arrangement was already muddy" from "reverb/saturation made the mix muddy".

### 3. findings: translating symptoms into causes

`analyseAudio` adds `report.findings`, each with `kind`, `message`, optional `attribution`, and `next`. M1 covers:

| kind | trigger | typical next |
| --- | --- | --- |
| `alias-risk` | highest note of a chip pulse/saw/organ >= C6 | use additive/triangle, drop an octave, or accept the chip grit |
| `sub-heavy` | 20-60 Hz share >= 6% | high-pass the bass/pad or add a post high-pass around 30-40 Hz; use monoBelowHz 100-140 |
| `mud` | 150-500 Hz share >= 25% | high-pass or EQ the bass/pad, move a part up an octave, shorten overlapping gates |
| `masking` | two or more stems occupy 150-500 Hz or 250 Hz-2 kHz at once | spread the panning, change octaves, shorten one of them |
| `harsh` | 2-5 kHz share >= 22% | use a softer waveform, tilt down 2-5 kHz, reduce drive |
| `dynamics` | crest < 9 dB | lower the loudness target, reduce saturation/compression, leave more rests |
| `loudness-flat` | song with LRA < 4 LU, section level spread < 6 dB, and LUFS > -16 | leave one section quieter or drop a part for a bar; a constant level is what makes a long listen feel loud |
| `post-mud` | post raises low-mid by >= 5% and the result is still >= 25% | check reverb wet/room, lowpass, and saturation; try a reverb low-cut or less wet |
| `post-harsh` | post raises 2-5 kHz by >= 5% and the result is still >= 22% | reduce saturation drive/mix, change the tilt |
| `post-dynamics` | post lowers crest by >= 3 dB | lower the loudness target/compression ratio, or reduce saturation mix |

These are **observations**, not hard pass conditions. `warnings` keeps its existing semantics unchanged; findings are appended to the report.

Listening comfort is the one place where the report states a limit that is not just advice. `warnings` carries `loud` above -12 LUFS and `unsafe` above the -9 LUFS hearing-safety ceiling, and the renderer turns that ceiling into a hard error (`MAX_SAFE_LUFS` in `loudness.ts`); `p8_analyze` still only reports it for an existing file. `loudness-flat` is the soft counterpart: it names the sustained-level case that makes a long listen feel loud even when every individual section is fine.

### 4. `detail` on both tools

- `detail: "summary"` (default): the same report as before.
- `detail: "raw"`: writes the full report to a sibling `.analysis.json` and returns the path plus a summary. `p8_music` uses `<out>.analysis.json` (replacing `.wav`) and includes `stems`, `dry`, findings, warnings, and sections; `p8_analyze` uses `<input>.analysis.json` (appended, e.g. `loop.wav.analysis.json`) and includes only what a WAV can measure. The two paths do not collide. The artifact does not occupy model context and can be read when needed. It is not a per-frame spectrum; per-frame indexing is left to M3.

`p8_analyze` can only read a finished WAV, so its raw artifact has no `stems` / `dry` -- those exist only in the `p8_music` render report. This is a deliberate boundary: attribution has to happen at render time.

### M1 acceptance

- Existing golden hashes are unchanged (analysis does not touch DSP).
- Every melodic / drum track has a stem summary; silent tracks do not enter the top list.
- `report.dry` appears in the `p8_music` report when the post chain is non-empty; `p8_analyze` never has it.
- `findings` covers positive and negative cases for at least sub-heavy / mud / harsh / masking / alias-risk / dynamics.
- The `p8_music` and `p8_analyze` raw artifacts each write parseable JSON, their paths do not collide, and `summary` output is unchanged.

## M2: raising the sonic ceiling (opt-in)

Status: **implemented**.

### 1. `quality: "clean"` band-limited oscillators

The chip path in `waveform.ts` is a direct implementation of the PICO-8 formulas, and pulse/saw/organ alias in the high register. New opt-in switch:

- `quality: "pico"` (default): preserves the old output sample for sample.
- `quality: "clean"`: PolyBLEP, or 2x oversample + anti-aliasing decimate.

The FM path can reuse the same switch. The `soft` style uses clean + low-order additive partials + slow attack by default.

### 2. Mixing primitives

- per-track `highpassHz` / `lowShelf` / `highShelf`: lets the model carve mud out of a single track instead of a global lowpass.
- master `monoBelowHz`: mono low end, stabilises bass/kick.
- master `width`: side gain, controls an over-wide reverb.
- reverb `predelayMs` / `lowCutHz` / `highCutHz` / light modulation: reduces metallic tails and low-frequency clouds.

All opt-in; default values do not change the old output.

### 3. target profiles

`p8_music` / `p8_analyze` accept an optional `target`:

```json
{"target": "soft"}
{"target": {"lowMidMax": 0.22, "crestMin": 12, "width": [0.2, 0.5], "lufs": [-18, -12]}}
```

- Without `target`: facts and findings only, no judgement.
- With `target`: findings add "deviation from the target", but still no total score.
- Built-in profiles: `soft` / `clear` / `punchy` / `bright` / `dark` / `lofi` / `hitech`.

### 4. The `soft` style

Instead of the default chip pulse, it uses:

- clean/additive low-order harmonics
- 20-80 ms attack with decay
- low saturation, no compression or light compression
- lowpass 4-6 kHz, light reverb
- loudness target -18...-14 LUFS, limiter for safety only

### M2 implementation notes

- `quality` is a `p8_music` parameter and can also be defaulted by a style; `pico` and omission preserve the old output sample for sample. Chip saw/pulse use PolyBLEP; continuous waveforms (triangle, tilted saw, organ, noise, phaser) have no discontinuities and keep the original formula. FM remains two-operator; `clean` limits the modulation index by Carson's rule so high-note sidebands do not fold back.
- Track `highpassHz` / `lowShelf` / `highShelf` are flat fields (not a nested `mix`); a shelf accepts a bare gain (250 Hz / 4 kHz default corners) or `{hz, gainDb}`. They run after the instrument/track filter and before delay/duck.
- Master `width` / `monoBelowHz` are `p8_music` parameters and run after the `post` chain and before the peak safety net; both are disabled by default.
- The `reverb` step adds `predelayMs` / `lowCutHz` / `highCutHz` / `modDepth` / `modRateHz`; predelay and modulation affect only the send, and the two wet filters affect only the wet signal.
- `target` works in both `p8_music` and `p8_analyze`, accepting a built-in profile or inline ranges; the report adds `target` readings and a `target` finding, and produces no total score.
- The `soft` style uses clean, low-order additive, 20-80 ms attack, 5.2 kHz lowpass, light reverb, and a -16 LUFS target; `examples/m12-soft.json` is the acceptance profile.

### M2 acceptance

- Under `quality: "clean"`, high-frequency folding for C6/C7 single notes drops substantially (verified with harmonic energy or a THD-like metric).
- Old scores that omit the new fields keep their golden hashes.
- The `soft` style's crest, low-mid, and 2-5 kHz land inside the profile ranges.
- The new EQ / mono / width / reverb fields all have deterministic tests.

## M3: comparison and degrees of freedom

Status: planned.

### 1. `compare`

- `p8_analyze detail: "compare"` accepts two WAV paths and returns a delta table.
- `p8_music compare: true` optional: caches the previous version's analysis in the workspace and returns a "vs previous version" delta.

### 2. A/B variants

Render 2-3 post/style variants of the same score in one call and return a comparison table (no multiple WAVs unless explicitly requested):

```json
{"variants": [{"label": "dry", "post": []}, {"label": "soft", "style": "soft"}]}
```

The model chooses, instead of the plug-in deciding for it.

### 3. raw artifact index

`analysis.json` gains a queryable index (per section, per track, per frame summaries) that the model reads on demand instead of pushing everything into context at once.

### 4. Numeric alias estimate

Estimate inharmonic energy from a single-note/single-track spectrum, replacing M1's "waveform + pitch" heuristic.

### M3 acceptance

- `compare` deltas match two separate summaries.
- Variants do not change the default single-render behaviour.
- The raw artifact can be re-read and formatted by `p8_analyze detail: "raw"`.
- The alias estimate gives distinguishable results for the clean/pico paths.

## Non-goals

- No automatic mixing/mastering: the plug-in gives measurements and advice, not aesthetic decisions on the model's behalf.
- No single score or leaderboard.
- No per-frame spectra or per-note objects pushed into tool results by default.
- No change to any existing DSP output for the sake of analysis.
