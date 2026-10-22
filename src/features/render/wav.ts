export interface DecodedWav {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly rate: number;
  readonly channels: 1 | 2;
}

/**
 * Generator state for the 16-bit conversion dither. One instance per file, so a
 * streamed render and a one-shot encode of the same audio produce the same
 * bytes even though they are quantised in different chunk sizes.
 */
export interface DitherState {
  seed: number;
}

export const DEFAULT_DITHER_SEED = 0x5eed1a7e;

export function createDitherState(seed: number = DEFAULT_DITHER_SEED): DitherState {
  return { seed: seed >>> 0 };
}

/** mulberry32: tiny, deterministic, and good enough for a noise floor. */
function nextRandom(state: DitherState): number {
  state.seed = (state.seed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(state.seed ^ (state.seed >>> 15), state.seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Triangular PDF noise in (-1, 1) LSB: the difference of two uniforms. */
function tpdf(state: DitherState): number {
  return nextRandom(state) - nextRandom(state);
}

/**
 * Float to int16 with 2 LSB peak-to-peak TPDF dither. Dither decorrelates the
 * quantisation error from the signal, which trades a flat -96 dBFS hiss for the
 * distortion harmonics plain rounding leaves on quiet tails and fades.
 * Rounding is symmetric (half away from zero); `Math.round` is not.
 */
function quantize(value: number, dither: DitherState): number {
  const jittered = value * 32767 + tpdf(dither);
  const rounded = jittered < 0 ? -Math.floor(-jittered + 0.5) : Math.floor(jittered + 0.5);
  return rounded < -32768 ? -32768 : rounded > 32767 ? 32767 : rounded;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i] ?? 0);
  return text;
}

/**
 * Decodes the PCM WAV this module writes (16-bit, mono or stereo). The analyze
 * tool uses it on files that were rendered earlier, so it validates the header
 * and reports a readable reason instead of returning noise.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 44) throw new Error('not a WAV file: header is shorter than 44 bytes');
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('not a WAV file: missing RIFF/WAVE header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) {
        throw new Error('not a WAV file: fmt chunk is shorter than 16 bytes');
      }
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (dataStart < 0) {
        dataStart = body;
        dataBytes = Math.min(size, bytes.length - body);
      }
    }
    offset = body + size + (size % 2);
  }

  if (dataStart < 0 || dataBytes <= 0) throw new Error('not a WAV file: no data chunk');
  if (format !== 1) throw new Error(`unsupported WAV encoding ${format}; only PCM is supported`);
  if (bits !== 16) throw new Error(`unsupported WAV bit depth ${bits}; only 16-bit PCM is supported`);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('not a WAV file: missing or invalid sample rate');
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(`unsupported WAV channel count ${channels}; only mono and stereo are supported`);
  }

  const frames = Math.floor(dataBytes / (channels * 2));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const frame = dataStart + i * channels * 2;
    left[i] = view.getInt16(frame, true) / 32768;
    right[i] = channels === 2 ? view.getInt16(frame + 2, true) / 32768 : (left[i] ?? 0);
  }

  return { left, right, rate, channels };
}

/** The 44-byte stereo 16-bit PCM header for a streamed render. */
export function encodeWavHeader(frames: number, rate: number): Uint8Array {
  const dataBytes = frames * 4;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}

/**
 * Interleaves one frame range; callers append these chunks after {@link encodeWavHeader}.
 * Pass the same `dither` state across chunks (in increasing `start` order) to keep
 * the noise continuous and the output identical to a single-call encode.
 */
export function encodeWavFrames(
  left: Float32Array,
  right: Float32Array,
  start: number,
  frames: number,
  dither: DitherState = createDitherState(),
): Uint8Array {
  const buffer = new ArrayBuffer(frames * 4);
  const view = new DataView(buffer);
  const end = Math.min(frames, left.length - start, right.length - start);
  for (let i = 0; i < end; i += 1) {
    const index = start + i;
    const l = Math.max(-1, Math.min(1, left[index] ?? 0));
    const r = Math.max(-1, Math.min(1, right[index] ?? 0));
    view.setInt16(i * 4, quantize(l, dither), true);
    view.setInt16(i * 4 + 2, quantize(r, dither), true);
  }
  return new Uint8Array(buffer);
}

export function encodeWav(left: Float32Array, right: Float32Array, rate: number): Uint8Array {
  const frames = Math.min(left.length, right.length);
  const header = encodeWavHeader(frames, rate);
  const body = encodeWavFrames(left, right, 0, frames, createDitherState());
  const output = new Uint8Array(header.length + body.length);
  output.set(header, 0);
  output.set(body, header.length);
  return output;
}
