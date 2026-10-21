/**
 * Plays persisted WAV assets. The app layer decodes files and pairs them with
 * the score's `SampleSpec`; this module only owns pitch, looping, and gain, so
 * the score feature never touches audio and the renderer never touches disk.
 *
 * Playback uses linear interpolation. That is intentionally simple: samples are
 * material, not oscillators, and a band-limited resampler would be a larger
 * dependency than the feature earns today.
 */

/** One decoded sample, already downmixed to mono, plus its playback rules. */
export interface SampleSource {
  readonly name: string;
  /** Mono PCM in -1..1. Stereo files are averaged by the app layer. */
  readonly audio: Float32Array;
  /** Native sample rate of `audio`; playback rate-converts on the fly. */
  readonly rate: number;
  /** MIDI note at which `audio` plays at its native speed. */
  readonly rootMidi: number;
  /** Repeat for the whole gate; false stops at the file's end. */
  readonly loop: boolean;
  /** Linear gain applied before the track mix. */
  readonly gain: number;
}

function rootFrequencyOf(source: SampleSource): number {
  return 440 * 2 ** ((source.rootMidi - 69) / 12);
}

function sampleAt(source: SampleSource, position: number, loop: boolean): number {
  const audio = source.audio;
  const length = audio.length;
  if (length === 0) return 0;
  if (!loop && position >= length) return 0;

  const index = Math.floor(position);
  if (index < 0) return 0;
  const next = loop ? (index + 1) % length : Math.min(index + 1, length - 1);
  const first = audio[index % length] ?? 0;
  const second = audio[next] ?? first;
  const fraction = position - index;
  return (first + (second - first) * fraction) * source.gain;
}

/**
 * A melodic sample voice. Position advances per rendered sample, so slide,
 * vibrato, and arp effects work exactly as they do for the oscillator voices:
 * the renderer passes the current frequency, this class converts it to a
 * playback increment relative to the sample's root note.
 */
export class SampleVoice {
  private readonly source: SampleSource;
  private readonly stepPerHertz: number;
  private position = 0;

  constructor(source: SampleSource, rate: number) {
    this.source = source;
    // A frequency equal to the root note consumes one source frame per output frame.
    this.stepPerHertz = (source.rate / rate) / rootFrequencyOf(source);
  }

  sample(frequency: number): number {
    const value = sampleAt(this.source, this.position, this.source.loop);
    this.position += frequency * this.stepPerHertz;
    if (this.source.loop && this.source.audio.length > 0 && this.position >= this.source.audio.length) {
      this.position %= this.source.audio.length;
    }
    return value;
  }
}

/**
 * A drum one-shot. It never loops even when the source is marked `loop: true`:
 * a looping kick would never decay. `pitchSemitones` follows the drum `~pitch`
 * suffix and `toneHz` follows `~tone`; `~decay` has no sample equivalent and is
 * ignored rather than silently changing the sample's shape.
 */
export function renderSampleOneShot(
  source: SampleSource,
  rate: number,
  velocity: number,
  pitchSemitones = 0,
  toneHz?: number,
): Float32Array {
  const step = (source.rate / rate) * 2 ** (pitchSemitones / 12);
  const length = Math.max(1, Math.ceil(source.audio.length / Math.max(step, 1e-9)));
  const output = new Float32Array(length);
  const level = Math.max(0, velocity);
  const coefficient =
    toneHz === undefined ? 1 : 1 - Math.exp((-2 * Math.PI * Math.max(20, toneHz)) / rate);
  let lowpassed = 0;

  for (let i = 0; i < length; i += 1) {
    let value = sampleAt(source, i * step, false);
    if (toneHz !== undefined) {
      lowpassed += coefficient * (value - lowpassed);
      value = lowpassed;
    }
    output[i] = value * level;
  }

  // A one-shot that ends on a non-zero sample would click when it stops. The
  // same 6 ms fade the synthetic drums use keeps the sample path consistent.
  const fadeSamples = Math.min(length, Math.max(1, Math.round(0.006 * rate)));
  for (let i = 0; i < fadeSamples; i += 1) {
    const index = length - 1 - i;
    output[index] = (output[index] ?? 0) * (i / fadeSamples);
  }
  return output;
}
