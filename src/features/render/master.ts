/**
 * Master-stage building blocks used by the mix/master post steps: tilt EQ,
 * saturation, bus compression, loudness normalisation, and peak limiting.
 *
 * Every function edits the two channel buffers in place and is deterministic.
 * `limitPeak` in dsp.ts stays the last safety net; the limiter here is a real
 * gain-envelope limiter with a ceiling the report can verify.
 */

import { integratedLufs } from './loudness.ts';

const TILT_HZ = 700;
const MAX_LOUDNESS_GAIN_DB = 24;

export interface CompressorSettings {
  readonly thresholdDb: number;
  readonly ratio: number;
  /** Ballistic time constant in seconds, not a lookahead. */
  readonly attackSeconds: number;
  readonly releaseSeconds: number;
  readonly makeupDb: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

function timeCoefficient(seconds: number, rate: number): number {
  return 1 - Math.exp(-1 / Math.max(1e-6, seconds) / rate);
}

/**
 * Tilt EQ: one-pole split at 700 Hz and opposite gains either side, so
 * `tiltDb` is the full high-versus-low difference. Positive values brighten.
 */
export function applyTilt(
  left: Float32Array,
  right: Float32Array,
  tiltDb: number,
  rate: number,
): void {
  if (tiltDb === 0) return;
  const coefficient = 1 - Math.exp((-2 * Math.PI * TILT_HZ) / Math.min(rate, 44100));
  const lowGain = dbToGain(-tiltDb / 2);
  const highGain = dbToGain(tiltDb / 2);

  for (const channel of [left, right]) {
    let low = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const input = channel[i] ?? 0;
      low += coefficient * (input - low);
      channel[i] = low * lowGain + (input - low) * highGain;
    }
  }
}

/**
 * Soft saturation: tanh with a drive-dependent pre-gain, normalised so a full
 * scale sample still maps to full scale. `mix` blends the shaped signal back
 * with the dry one, which keeps the level jump of a hot drive manageable.
 */
export function applySaturation(
  left: Float32Array,
  right: Float32Array,
  drive: number,
  mix: number,
): void {
  const amount = 1 + clamp(drive, 0, 1) * 9;
  const normalise = Math.tanh(amount);
  const wet = clamp(mix, 0, 1);
  if (wet === 0) return;

  const shape = (value: number): number => Math.tanh(value * amount) / normalise;
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i += 1) {
      const dry = channel[i] ?? 0;
      channel[i] = dry + (shape(dry) - dry) * wet;
    }
  }
}

/**
 * Stereo-linked feed-forward compressor. The detector follows the louder
 * channel, so the stereo image never shifts while the bus is compressed.
 */
export function applyCompressor(
  left: Float32Array,
  right: Float32Array,
  settings: CompressorSettings,
  rate: number,
  passes = 1,
): void {
  const threshold = dbToGain(settings.thresholdDb);
  const makeup = dbToGain(settings.makeupDb);
  const ratio = clamp(settings.ratio, 1, 40);
  const attack = timeCoefficient(settings.attackSeconds, rate);
  const release = timeCoefficient(settings.releaseSeconds, rate);
  let envelope = 0;

  // `passes` > 1 lets a loop bus reach a steady detector state without
  // allocating a repeated buffer: earlier passes read the same input and carry
  // the envelope forward, and only the last pass writes the samples.
  for (let pass = 0; pass < passes; pass += 1) {
    const write = pass === passes - 1;
    for (let i = 0; i < left.length; i += 1) {
      const peak = Math.max(Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
      envelope += (peak > envelope ? attack : release) * (peak - envelope);

      let gain = 1;
      if (envelope > threshold) gain = (envelope / threshold) ** (1 / ratio - 1);
      if (!write) continue;
      const applied = gain * makeup;
      left[i] = (left[i] ?? 0) * applied;
      right[i] = (right[i] ?? 0) * applied;
    }
  }
}

/**
 * Applies one gain to both channels so the measured integrated loudness hits
 * `targetLufs`. Returns the applied gain in dB (0 for silence or no change).
 */
export function applyLoudness(
  left: Float32Array,
  right: Float32Array,
  targetLufs: number,
  rate: number,
): number {
  const measured = integratedLufs([left, right], rate);
  if (!Number.isFinite(measured)) return 0;
  const gainDb = clamp(targetLufs - measured, -MAX_LOUDNESS_GAIN_DB, MAX_LOUDNESS_GAIN_DB);
  if (Math.abs(gainDb) < 0.01) return 0;
  const gain = dbToGain(gainDb);
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i += 1) channel[i] = (channel[i] ?? 0) * gain;
  }
  return gainDb;
}

/**
 * Peak limiter with an instant attack and an exponential release. It turns the
 * gain down on the sample that needs it and recovers over `releaseSeconds`;
 * the final clamp guarantees that no sample exceeds the ceiling even if the
 * envelope lags by one sample.
 */
export function applyLimiter(
  left: Float32Array,
  right: Float32Array,
  ceilingDb: number,
  releaseSeconds: number,
  rate: number,
): void {
  const ceiling = dbToGain(Math.min(0, ceilingDb));
  const release = timeCoefficient(releaseSeconds, rate);
  let gain = 1;

  for (let i = 0; i < left.length; i += 1) {
    const peak = Math.max(Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
    const required = peak > ceiling ? ceiling / peak : 1;
    gain = required < gain ? required : Math.min(1, gain + (1 - gain) * release);

    const limitedLeft = (left[i] ?? 0) * gain;
    const limitedRight = (right[i] ?? 0) * gain;
    left[i] = clamp(limitedLeft, -ceiling, ceiling);
    right[i] = clamp(limitedRight, -ceiling, ceiling);
  }
}

/**
 * Master side gain, expressed as the final side/mid ratio multiplier. 0 folds
 * the mix to mono, 1 is a bypass, and 2 doubles the side signal. It runs after
 * the ordered post chain, so a reverb's width can be tamed without touching
 * the arrangement's pan.
 */
export function applyWidth(left: Float32Array, right: Float32Array, width: number): void {
  const gain = clamp(width, 0, 2);
  if (gain === 1) return;
  for (let i = 0; i < left.length; i += 1) {
    const mid = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
    const side = ((left[i] ?? 0) - (right[i] ?? 0)) * 0.5 * gain;
    left[i] = mid + side;
    right[i] = mid - side;
  }
}

/**
 * Folds the band below `hz` to mono by removing it from the side channel and
 * leaving the mid untouched. Bass and kick then share one stable centre
 * without collapsing the rest of the stereo image.
 */
export function applyMonoBelow(
  left: Float32Array,
  right: Float32Array,
  hz: number,
  rate: number,
): void {
  const length = Math.min(left.length, right.length);
  if (length === 0) return;
  const side = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    side[i] = ((left[i] ?? 0) - (right[i] ?? 0)) * 0.5;
  }
  const coefficient = 1 - Math.exp((-2 * Math.PI * hz) / rate);
  let low = 0;
  for (let i = 0; i < length; i += 1) {
    const input = side[i] ?? 0;
    low += coefficient * (input - low);
    const high = input - low;
    const mid = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
    left[i] = mid + high;
    right[i] = mid - high;
  }
}
