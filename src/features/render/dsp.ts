export interface ReverbOptions {
  readonly wet: number;
  readonly room: number;
  readonly damp: number;
  /** Milliseconds before the send enters the comb bank, 0-200. */
  readonly predelayMs?: number;
  /** High-pass the wet return; absent leaves it untouched. */
  readonly lowCutHz?: number;
  /** Low-pass the wet return; absent leaves it untouched. */
  readonly highCutHz?: number;
  /** Slow delay modulation depth, 0-1 (about 0-5 ms). */
  readonly modDepth?: number;
  /** Modulation rate in Hz; ignored when `modDepth` is 0. */
  readonly modRateHz?: number;
}

export interface StereoAudio {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617] as const;
const ALLPASS_TUNINGS = [556, 441, 341, 225] as const;
const STEREO_SPREAD = 23;
const INPUT_GAIN = 0.015;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

class CombFilter {
  private readonly buffer: Float32Array;
  private readonly feedback: number;
  private readonly damp1: number;
  private readonly damp2: number;
  private index = 0;
  private store = 0;

  constructor(size: number, feedback: number, damp: number) {
    this.buffer = new Float32Array(Math.max(1, size));
    this.feedback = feedback;
    this.damp1 = damp;
    this.damp2 = 1 - damp;
  }

  process(input: number): number {
    const output = this.buffer[this.index] ?? 0;
    this.store = output * this.damp2 + this.store * this.damp1;
    this.buffer[this.index] = input + this.store * this.feedback;
    this.index = (this.index + 1) % this.buffer.length;
    return output;
  }
}

class AllPassFilter {
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(size: number) {
    this.buffer = new Float32Array(Math.max(1, size));
  }

  process(input: number): number {
    const buffered = this.buffer[this.index] ?? 0;
    const output = -input + buffered;
    this.buffer[this.index] = input + buffered * 0.5;
    this.index = (this.index + 1) % this.buffer.length;
    return output;
  }
}

function reverbChannel(
  input: Float32Array,
  tuningOffset: number,
  scale: number,
  feedback: number,
  damp: number,
): Float32Array {
  const combs = COMB_TUNINGS.map(
    (tuning) => new CombFilter(Math.round((tuning + tuningOffset) * scale), feedback, damp),
  );
  const allpasses = ALLPASS_TUNINGS.map(
    (tuning) => new AllPassFilter(Math.round((tuning + tuningOffset) * scale)),
  );
  const output = new Float32Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    let value = (input[i] ?? 0) * INPUT_GAIN;
    let summed = 0;
    for (const comb of combs) summed += comb.process(value);
    value = summed;
    for (const allpass of allpasses) value = allpass.process(value);
    output[i] = value;
  }
  return output;
}

function delaySend(
  input: Float32Array,
  predelayMs: number,
  modDepth: number,
  modRateHz: number,
  rate: number,
): Float32Array {
  const baseDelay = Math.max(0, predelayMs) * 0.001 * rate;
  const depth = clamp(modDepth, 0, 1) * 0.005 * rate;
  const maxDelay = baseDelay + depth;
  if (maxDelay < 0.5) return input;

  const size = Math.ceil(maxDelay) + 4;
  const line = new Float32Array(size);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    line[i % size] = input[i] ?? 0;
    // Unipolar so the read index never runs ahead of the write index when the
    // caller uses modulation without a predelay.
    const modulation =
      depth === 0 ? 0 : depth * 0.5 * (1 + Math.sin((2 * Math.PI * modRateHz * i) / rate));
    const read = i - (baseDelay + modulation);
    if (read < 0) continue;
    const index = Math.floor(read);
    const fraction = read - index;
    const first = line[((index % size) + size) % size] ?? 0;
    const second = line[(((index + 1) % size) + size) % size] ?? 0;
    output[i] = first + (second - first) * fraction;
  }
  return output;
}

/** One-pole wet-return filters; they stay off unless the caller asks. */
function filterWet(samples: Float32Array, lowCutHz: number | undefined, highCutHz: number | undefined, rate: number): void {
  if (lowCutHz !== undefined) {
    const pole = Math.exp((-2 * Math.PI * lowCutHz) / rate);
    let previousInput = 0;
    let previousOutput = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const input = samples[i] ?? 0;
      const output = input - previousInput + pole * previousOutput;
      previousInput = input;
      previousOutput = output;
      samples[i] = output;
    }
  }
  if (highCutHz !== undefined) {
    const coefficient = 1 - Math.exp((-2 * Math.PI * highCutHz) / rate);
    let value = 0;
    for (let i = 0; i < samples.length; i += 1) {
      value += coefficient * ((samples[i] ?? 0) - value);
      samples[i] = value;
    }
  }
}

function downmix(input: StereoAudio): Float32Array {
  const length = Math.min(input.left.length, input.right.length);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    output[i] = ((input.left[i] ?? 0) + (input.right[i] ?? 0)) * 0.5;
  }
  return output;
}

/**
 * Freeverb-style reverb. Only the send is a mono sum; the dry path stays
 * stereo, so a post-chain insert cannot fold a panned mix to mono.
 */
export function reverb(input: StereoAudio, options: ReverbOptions, rate: number): StereoAudio {
  const scale = rate / 44100;
  const room = clamp(options.room, 0, 0.98);
  const feedback = 0.7 + room * 0.28;
  const damp = clamp(options.damp, 0, 1) * 0.4;
  const wet = clamp(options.wet, 0, 1);
  const dry = 1 - wet;

  const mono = downmix(input);
  // The delay/modulation stage is a send-side effect: the dry path keeps its
  // original alignment, which is why a predelay does not smear the direct
  // sound. With both fields absent it returns the send unchanged.
  const send = delaySend(
    mono,
    options.predelayMs ?? 0,
    options.modDepth ?? 0,
    options.modRateHz ?? 0.7,
    rate,
  );
  const leftReverb = reverbChannel(send, 0, scale, feedback, damp);
  const rightReverb = reverbChannel(send, STEREO_SPREAD, scale, feedback, damp);
  filterWet(leftReverb, options.lowCutHz, options.highCutHz, rate);
  filterWet(rightReverb, options.lowCutHz, options.highCutHz, rate);
  const left = new Float32Array(mono.length);
  const right = new Float32Array(mono.length);

  for (let i = 0; i < mono.length; i += 1) {
    left[i] = (input.left[i] ?? 0) * dry + (leftReverb[i] ?? 0) * wet;
    right[i] = (input.right[i] ?? 0) * dry + (rightReverb[i] ?? 0) * wet;
  }

  return { left, right };
}

/**
 * Stereo-input reverb. Each channel drives its own comb bank, so a hard-panned
 * send returns on that side instead of being folded through a mono sum. For a
 * centred send (left === right) this is sample-identical to `reverb`, which is
 * what keeps the old mono-send scores stable when their sources are centred.
 */
export function reverbStereo(input: StereoAudio, options: ReverbOptions, rate: number): StereoAudio {
  const scale = rate / 44100;
  const room = clamp(options.room, 0, 0.98);
  const feedback = 0.7 + room * 0.28;
  const damp = clamp(options.damp, 0, 1) * 0.4;
  const wet = clamp(options.wet, 0, 1);
  const dry = 1 - wet;

  const sendLeft = delaySend(
    input.left,
    options.predelayMs ?? 0,
    options.modDepth ?? 0,
    options.modRateHz ?? 0.7,
    rate,
  );
  const sendRight = delaySend(
    input.right,
    options.predelayMs ?? 0,
    options.modDepth ?? 0,
    options.modRateHz ?? 0.7,
    rate,
  );
  const leftReverb = reverbChannel(sendLeft, 0, scale, feedback, damp);
  const rightReverb = reverbChannel(sendRight, STEREO_SPREAD, scale, feedback, damp);
  filterWet(leftReverb, options.lowCutHz, options.highCutHz, rate);
  filterWet(rightReverb, options.lowCutHz, options.highCutHz, rate);
  const left = new Float32Array(input.left.length);
  const right = new Float32Array(input.right.length);

  for (let i = 0; i < left.length; i += 1) {
    left[i] = (input.left[i] ?? 0) * dry + (leftReverb[i] ?? 0) * wet;
    right[i] = (input.right[i] ?? 0) * dry + (rightReverb[i] ?? 0) * wet;
  }
  return { left, right };
}

/** Linear-interpolated resampling: speed < 1 is slower and lower. */
export function resample(input: Float32Array, speed: number): Float32Array {
  const length = Math.max(1, Math.round(input.length / speed));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * speed;
    const index = Math.floor(position);
    const fraction = position - index;
    const first = input[index] ?? 0;
    const second = input[index + 1] ?? first;
    output[i] = first + (second - first) * fraction;
  }
  return output;
}

/**
 * One-pole high-pass. Pulse-family timbres are not zero-mean, and the reverb
 * comb bank has a large DC gain, so any offset would otherwise survive as a
 * constant bias (and a click at the loop seam).
 */
export function dcBlock(input: Float32Array, cutoffHz: number, rate: number): Float32Array {
  const pole = Math.exp((-2 * Math.PI * cutoffHz) / rate);
  const output = new Float32Array(input.length);
  let previousInput = 0;
  let previousOutput = 0;
  for (let i = 0; i < input.length; i += 1) {
    const currentInput = input[i] ?? 0;
    const currentOutput = currentInput - previousInput + pole * previousOutput;
    previousInput = currentInput;
    previousOutput = currentOutput;
    output[i] = currentOutput;
  }
  return output;
}

export function copyWindow(input: Float32Array, start: number, length: number): Float32Array {
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) output[i] = input[start + i] ?? 0;
  return output;
}

/** Largest absolute sample across the given channels. */
export function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/**
 * Applies one shared gain so the loudest sample sits at `target`. A shared gain
 * keeps the stereo image and, because it is a scalar over the whole loop, the
 * loop period. It only attenuates: quiet scores keep their authored dynamics.
 */
export function limitPeak(channels: readonly Float32Array[], target: number): number {
  const peak = peakOf(channels);
  if (peak <= target || peak === 0) return 1;
  const gain = target / peak;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) channel[i] = (channel[i] ?? 0) * gain;
  }
  return gain;
}

export function repeat(input: Float32Array, times: number): Float32Array {
  const output = new Float32Array(input.length * times);
  for (let i = 0; i < times; i += 1) output.set(input, i * input.length);
  return output;
}
