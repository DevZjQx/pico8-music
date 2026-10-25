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
  /**
   * Mono PCM in -1..1. This is already the selected region (and reversed when
   * the score asked for it), so all offsets below are relative to `audio`.
   */
  readonly audio: Float32Array;
  /** Native sample rate of `audio`; playback rate-converts on the fly. */
  readonly rate: number;
  /** MIDI note at which `audio` plays at its native speed. */
  readonly rootMidi: number;
  /** Repeat for the whole gate; false stops at the region's end. */
  readonly loop: boolean;
  /** Linear gain applied before the track mix. */
  readonly gain: number;
  /** Loop-region start frame inside `audio`; absent means 0. */
  readonly loopStart?: number;
  /** Loop-region end frame inside `audio`; absent means `audio.length`. */
  readonly loopEnd?: number;
  /** Seconds of linear fade-in at playback start; 0 or absent means none. */
  readonly fadeIn?: number;
}

/** One key/velocity region of a multi-sampled entry. */
export interface SampleZone {
  readonly source: SampleSource;
  readonly loMidi: number;
  readonly hiMidi: number;
  readonly loVelocity: number;
  readonly hiVelocity: number;
}

/** A multi-sampled entry: one zone is chosen per note. */
export interface SampleZoneSet {
  readonly name: string;
  readonly zones: readonly SampleZone[];
}

/**
 * The render bank maps a score sample name to either one source or a zone set.
 * A bare `SampleSource` is still accepted, which keeps hand-built banks in
 * tests and the probe path working without wrapping.
 */
export type SampleBankEntry = SampleSource | SampleZoneSet;
export type SampleBank = ReadonlyMap<string, SampleBankEntry>;

export function isZoneSet(entry: SampleBankEntry): entry is SampleZoneSet {
  return (entry as SampleZoneSet).zones !== undefined;
}

/**
 * Pick the zone whose key range is closest to `midi`, then the velocity range
 * closest to `velocity`. Exact coverage wins; a note outside every range falls
 * back to the nearest zone instead of going silent. Ties keep the earlier zone,
 * so the choice is deterministic.
 */
export function selectSampleSource(
  entry: SampleBankEntry,
  midi: number,
  velocity: number,
): SampleSource {
  if (!isZoneSet(entry)) return entry;
  const zones = entry.zones;
  if (zones.length === 0) {
    throw new Error(`sample ${JSON.stringify(entry.name)} has an empty zone set`);
  }

  let best = zones[0];
  let bestMidi = Infinity;
  let bestVelocity = Infinity;
  for (const zone of zones) {
    const midiDistance =
      midi < zone.loMidi ? zone.loMidi - midi : midi > zone.hiMidi ? midi - zone.hiMidi : 0;
    const velocityDistance =
      velocity < zone.loVelocity
        ? zone.loVelocity - velocity
        : velocity > zone.hiVelocity
          ? velocity - zone.hiVelocity
          : 0;
    if (midiDistance < bestMidi || (midiDistance === bestMidi && velocityDistance < bestVelocity)) {
      best = zone;
      bestMidi = midiDistance;
      bestVelocity = velocityDistance;
    }
  }
  return (best ?? zones[0]).source;
}

function rootFrequencyOf(source: SampleSource): number {
  return 440 * 2 ** ((source.rootMidi - 69) / 12);
}

/** Loop bounds in frames, defaulting to the whole selected region. */
function loopBounds(source: SampleSource): readonly [number, number] {
  return [source.loopStart ?? 0, source.loopEnd ?? source.audio.length];
}

function wrapPosition(position: number, start: number, end: number): number {
  const span = end - start;
  if (span <= 0) return Math.max(0, Math.min(position, end - 1));
  let wrapped = position;
  if (wrapped >= end) wrapped = start + ((wrapped - start) % span);
  if (wrapped < start) wrapped += span;
  return wrapped;
}

function sampleAt(source: SampleSource, position: number, loop: boolean): number {
  const audio = source.audio;
  const length = audio.length;
  if (length === 0) return 0;

  let index = position;
  if (loop) {
    const [start, end] = loopBounds(source);
    const span = end - start;
    if (span > 0) {
      // Playback starts at the region's beginning and only wraps once it
      // reaches loopEnd: frames before loopStart are the one-shot intro.
      if (index >= end) index = start + ((index - start) % span);
    } else {
      index = Math.max(0, Math.min(index, length - 1));
    }
  } else if (index >= length) {
    return 0;
  }
  if (index < 0) return 0;

  const base = Math.floor(index);
  let next: number;
  if (loop) {
    const [, end] = loopBounds(source);
    next = base + 1 >= end ? (source.loopStart ?? 0) : base + 1;
  } else {
    next = Math.min(base + 1, length - 1);
  }
  const first = audio[base] ?? 0;
  const second = audio[next] ?? first;
  const fraction = index - base;
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
  private readonly fadeSamples: number;
  private position = 0;
  private elapsed = 0;

  constructor(source: SampleSource, rate: number) {
    this.source = source;
    // A frequency equal to the root note consumes one source frame per output frame.
    this.stepPerHertz = (source.rate / rate) / rootFrequencyOf(source);
    this.fadeSamples = Math.max(0, Math.round((source.fadeIn ?? 0) * rate));
  }

  sample(frequency: number): number {
    const value = sampleAt(this.source, this.position, this.source.loop);
    this.position += frequency * this.stepPerHertz;
    if (this.source.loop) {
      const [start, end] = loopBounds(this.source);
      if (this.position >= end) this.position = wrapPosition(this.position, start, end);
    }
    if (this.fadeSamples === 0) return value;
    if (this.elapsed >= this.fadeSamples) return value;
    const gain = this.elapsed / this.fadeSamples;
    this.elapsed += 1;
    return value * gain;
  }
}

/**
 * A drum one-shot. It never loops even when the source is marked `loop: true`:
 * a looping kick would never decay. `pitchSemitones` follows the drum `~pitch`
 * suffix, `toneHz` follows `~tone`, and `decayScale` follows `~decay`: the last
 * one shortens the sample's own amplitude with an exponential envelope, which
 * is the closest honest equivalent for material that has no synth decay.
 */
export function renderSampleOneShot(
  source: SampleSource,
  rate: number,
  velocity: number,
  pitchSemitones = 0,
  toneHz?: number,
  decayScale?: number,
): Float32Array {
  const step = (source.rate / rate) * 2 ** (pitchSemitones / 12);
  const length = Math.max(1, Math.ceil(source.audio.length / Math.max(step, 1e-9)));
  const output = new Float32Array(length);
  const level = Math.max(0, velocity);
  const coefficient =
    toneHz === undefined ? 1 : 1 - Math.exp((-2 * Math.PI * Math.max(20, toneHz)) / rate);
  let lowpassed = 0;

  // `~decay` is a rate multiplier, so 2 halves the audible tail. Four time
  // constants across the sample puts the natural end about 2% down.
  const naturalSeconds = source.audio.length / source.rate;
  const decayFactor =
    decayScale === undefined || decayScale <= 0 || naturalSeconds <= 0
      ? 1
      : Math.exp((-4 * decayScale) / (naturalSeconds * rate));
  let decayGain = 1;
  const fadeSamples = Math.max(0, Math.round((source.fadeIn ?? 0) * rate));

  for (let i = 0; i < length; i += 1) {
    let value = sampleAt(source, i * step, false);
    if (toneHz !== undefined) {
      lowpassed += coefficient * (value - lowpassed);
      value = lowpassed;
    }
    if (fadeSamples > 0 && i < fadeSamples) value *= i / fadeSamples;
    if (decayFactor !== 1) {
      value *= decayGain;
      decayGain *= decayFactor;
    }
    output[i] = value * level;
  }

  // A one-shot that ends on a non-zero sample would click when it stops. The
  // same 6 ms fade the synthetic drums use keeps the sample path consistent.
  const outFade = Math.min(length, Math.max(1, Math.round(0.006 * rate)));
  for (let i = 0; i < outFade; i += 1) {
    const index = length - 1 - i;
    output[index] = (output[index] ?? 0) * (i / outFade);
  }
  return output;
}
