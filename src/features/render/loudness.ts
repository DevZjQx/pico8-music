/**
 * ITU-R BS.1770-4 K-weighted integrated loudness.
 *
 * The `loudness` post step normalises against this measurement, and the render
 * report prints it, so both use the same function: a target that the report
 * confirms is a target the chain actually hit.
 */

/** Absolute gate: blocks quieter than this never contribute. */
const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate: blocks more than 10 LU below the ungated mean are dropped. */
const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
/** EBU Tech 3342 short-term window and step, used only by the LRA. */
const LRA_WINDOW_SECONDS = 3;
const LRA_HOP_SECONDS = 1;
/** LRA gates: absolute -70 LUFS, then -20 LU below the gated mean. */
const LRA_ABSOLUTE_GATE_LUFS = -70;
const LRA_RELATIVE_GATE_LU = -20;
/** LRA prints in LU; anything above this is a mis-measurement, not music. */
const LRA_MAX_LU = 40;
/** Power floor so log10 stays finite for digital silence. */
const SILENCE_POWER = 1e-20;

/**
 * Hard ceiling for the finished mix's integrated loudness, in LUFS.
 *
 * A file is not an SPL — the listener's playback gain decides that — but a
 * K-system calibrated room gives a bridge: the -20 dBFS reference mark sits at
 * 83 dB SPL, so a stereo master plays roughly 100 dB above its LUFS figure at
 * reference gain. NIOSH allows 8 h at 85 dBA and halves the time every 3 dB,
 * which puts -9 LUFS near the one-hour mark. Past it, a normal session at
 * reference gain is no longer safe and the mix has no headroom left anyway, so
 * the renderer refuses instead of warning.
 */
export const MAX_SAFE_LUFS = -9;

interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Stage 1: the high-shelf "pre-filter" from the standard, derived at any rate. */
function shelfCoefficients(rate: number): BiquadCoefficients {
  const f0 = 1681.9744509555319;
  const gainDb = 3.99984385397;
  const q = 0.7071752369554193;
  const k = Math.tan((Math.PI * f0) / rate);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Stage 2: the RLB high-pass from the standard, derived at any rate. */
function highpassCoefficients(rate: number): BiquadCoefficients {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / rate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

function biquad(input: Float32Array, coefficients: BiquadCoefficients): Float32Array {
  const { b0, b1, b2, a1, a2 } = coefficients;
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i] ?? 0;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    output[i] = y0;
  }
  return output;
}

/** K-weights one channel; the order is shelf then high-pass, as in the standard. */
function kWeight(samples: Float32Array, rate: number): Float32Array {
  const safeRate = Math.max(8000, rate);
  return biquad(biquad(samples, shelfCoefficients(safeRate)), highpassCoefficients(safeRate));
}

function loudnessOf(power: number): number {
  return -0.691 + 10 * Math.log10(Math.max(power, SILENCE_POWER));
}

/**
 * Mean power per block for an already K-weighted signal. A block shorter than
 * `block` is only kept when it is the first one, so a buffer shorter than a
 * single window still yields one measurement.
 */
function blockPowers(
  filtered: readonly Float32Array[],
  length: number,
  block: number,
  hop: number,
): number[] {
  const powers: number[] = [];
  for (let start = 0; start < length; start += hop) {
    const end = Math.min(length, start + block);
    if (end - start < block && start > 0) break;
    let sum = 0;
    for (const channel of filtered) {
      let squares = 0;
      for (let i = start; i < end; i += 1) squares += (channel[i] ?? 0) ** 2;
      sum += squares / Math.max(1, end - start);
    }
    powers.push(sum);
  }
  return powers;
}

function integratedFrom(powers: readonly number[]): number {
  if (powers.length === 0) return -Infinity;

  const audible = powers.filter((power) => loudnessOf(power) > ABSOLUTE_GATE_LUFS);
  if (audible.length === 0) return -Infinity;

  const ungatedMean = audible.reduce((sum, power) => sum + power, 0) / audible.length;
  const relativeGate = loudnessOf(ungatedMean) + RELATIVE_GATE_LU;
  const gated = audible.filter((power) => loudnessOf(power) > relativeGate);
  const kept = gated.length > 0 ? gated : audible;
  const mean = kept.reduce((sum, power) => sum + power, 0) / kept.length;
  return clamp(loudnessOf(mean), -120, 40);
}

/** Linear-interpolated percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.min(sorted.length - 1, low + 1);
  const weight = index - low;
  return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight;
}

/**
 * Loudness range in LU (EBU Tech 3342): the 10th-to-95th percentile spread of
 * short-term loudness after the absolute and relative gates. A loop that holds
 * one groove reports a small range; an arrangement that drops down and comes
 * back reports a large one. Silence and buffers too short to measure report 0
 * rather than a negative or non-finite number.
 */
function rangeFrom(filtered: readonly Float32Array[], length: number, rate: number): number {
  const window = Math.min(length, Math.max(1, Math.round(LRA_WINDOW_SECONDS * rate)));
  const hop = Math.max(1, Math.round(LRA_HOP_SECONDS * rate));
  const measured = blockPowers(filtered, length, window, hop).map((power) => ({
    power,
    loudness: loudnessOf(power),
  }));

  const audible = measured.filter((block) => block.loudness > LRA_ABSOLUTE_GATE_LUFS);
  if (audible.length === 0) return 0;

  const meanPower = audible.reduce((sum, block) => sum + block.power, 0) / audible.length;
  const relativeGate = loudnessOf(meanPower) + LRA_RELATIVE_GATE_LU;
  const kept = audible
    .filter((block) => block.loudness > relativeGate)
    .map((block) => block.loudness)
    .sort((a, b) => a - b);
  if (kept.length === 0) return 0;

  return clamp(percentile(kept, 0.95) - percentile(kept, 0.1), 0, LRA_MAX_LU);
}

export interface LoudnessSummary {
  /** Integrated loudness in LUFS; -Infinity for a silent buffer. */
  readonly integrated: number;
  /** Loudness range in LU; 0 when there is nothing measurable. */
  readonly range: number;
}

/**
 * Both loudness figures from one K-weighting pass. The report needs the pair,
 * and K-weighting a long song twice is pure waste.
 */
export function loudnessSummary(
  channels: readonly Float32Array[],
  rate: number,
): LoudnessSummary {
  const length = Math.min(...channels.map((channel) => channel.length));
  if (length === 0) return { integrated: -Infinity, range: 0 };

  const filtered = channels.map((channel) => kWeight(channel, rate));
  const block = Math.max(1, Math.round(BLOCK_SECONDS * rate));
  const hop = Math.max(1, Math.round(HOP_SECONDS * rate));
  return {
    integrated: integratedFrom(blockPowers(filtered, length, block, hop)),
    range: rangeFrom(filtered, length, rate),
  };
}

/**
 * Integrated loudness in LUFS. Returns -Infinity for a silent buffer. The
 * caller passes the samples it wants measured: the loop body for a loop, the
 * whole song for an arrangement.
 */
export function integratedLufs(channels: readonly Float32Array[], rate: number): number {
  const length = Math.min(...channels.map((channel) => channel.length));
  if (length === 0) return -Infinity;

  const filtered = channels.map((channel) => kWeight(channel, rate));
  const block = Math.max(1, Math.round(BLOCK_SECONDS * rate));
  const hop = Math.max(1, Math.round(HOP_SECONDS * rate));
  return integratedFrom(blockPowers(filtered, length, block, hop));
}

/** Loudness range in LU; see `rangeFrom` for the gating. */
export function loudnessRange(channels: readonly Float32Array[], rate: number): number {
  const length = Math.min(...channels.map((channel) => channel.length));
  if (length === 0) return 0;
  return rangeFrom(channels.map((channel) => kWeight(channel, rate)), length, rate);
}
