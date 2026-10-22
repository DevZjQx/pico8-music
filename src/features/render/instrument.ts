import type { Instrument, InstrumentFilter, Partial } from '../score/feature.ts';
import { createWaveState, sampleWaveform, type WaveState } from './waveform.ts';

// Owns: turning one Instrument definition into per-note samples. The chip path
// deliberately reuses waveform.ts unchanged, so an explicit chip instrument is
// sample-identical to the legacy `track.waveform` render.
// Does not own: scheduling, envelopes, or mixing — synth.ts places each note.

/** Additive cycles are short tables; 1024 points keeps 16 harmonics smooth. */
const TABLE_SIZE = 1024;
const TABLE_MASK = TABLE_SIZE - 1;
/** Filter coefficients refresh every N samples, matching the track filter. */
const FILTER_BLOCK = 32;
const MIN_CUTOFF_HZ = 40;
/**
 * Additive tables peak here, like pulse/square chip waves and FM (~0.25).
 * Triangle and tilted-saw chip waves peak nearer 0.5, so the chip palette
 * itself spans roughly 0.25-0.5.
 */
const TABLE_PEAK = 0.25;
/** Two-operator FM peak, chosen to sit next to the chip waves. */
const FM_PEAK = 0.25;
/** One turn of the phase, shared by the table builder and the per-partial path. */
const TAU = Math.PI * 2;
const DEFAULT_PARTIALS: readonly Partial[] = [
  1, 0.5, 1 / 3, 0.25, 0.2, 1 / 6, 1 / 7, 0.125,
].map((amplitude) => ({ amplitude, phase: 0 }));

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

interface ResolvedPartial {
  readonly amplitude: number;
  readonly phase: number;
  /** Frequency multiplier over the note's fundamental. */
  readonly ratio: number;
  /** Seconds; 0 means the harmonic is static. */
  readonly decay: number;
}

/**
 * Inharmonic stretch. The fundamental (n = 1) stays exactly in tune, and upper
 * harmonics sharpen as if the string had stiffness: `stretch` 0 is the plain
 * harmonic series, 0.2-0.5 gives bell/metal partials.
 */
function partialRatio(harmonic: number, stretch: number): number {
  return harmonic * Math.sqrt(1 + stretch * (harmonic * harmonic - 1));
}

/**
 * Turn score harmonics into the shape the renderer needs: apply tilt, drop
 * inaudible and above-Nyquist partials, and resolve stretch into a frequency
 * multiplier. Amplitudes are left unscaled; the cycle measurement owns level.
 */
function resolvePartials(
  partials: readonly Partial[],
  frequency: number,
  rate: number,
  stretch: number,
  tilt: number,
): readonly ResolvedPartial[] {
  const resolved: ResolvedPartial[] = [];
  const limit = rate * 0.45;

  for (let harmonic = 1; harmonic <= partials.length; harmonic += 1) {
    const partial = partials[harmonic - 1];
    if (partial === undefined) continue;
    const amplitude = partial.amplitude * (tilt === 0 ? 1 : harmonic ** -tilt);
    if (amplitude <= 0) continue;
    const ratio = stretch === 0 ? harmonic : partialRatio(harmonic, stretch);
    if (frequency * ratio >= limit) continue;
    resolved.push({ amplitude, phase: partial.phase, ratio, decay: partial.decay ?? 0 });
  }
  return resolved;
}

/**
 * One fundamental-cycle table plus the measured peak scale.
 *
 * Phase is per harmonic, so one table covers mirrored and duty-cycle shapes,
 * not just the amplitudes a real-valued harmonic series can reach. Scaling by
 * the measured peak rather than the amplitude sum means a model-authored shape
 * keeps the same level when only its phases or tilt change. With `stretch` the
 * waveform is no longer periodic at the fundamental; the table is then only a
 * level reference and synthesis runs per partial.
 */
function buildCycle(resolved: readonly ResolvedPartial[]): { table: Float32Array; scale: number } {
  const table = new Float32Array(TABLE_SIZE);

  for (const { amplitude, phase, ratio } of resolved) {
    for (let i = 0; i < TABLE_SIZE; i += 1) {
      table[i] = (table[i] ?? 0) + amplitude * Math.sin((TAU * ratio * i) / TABLE_SIZE + phase);
    }
  }

  let peak = 0;
  for (let i = 0; i < TABLE_SIZE; i += 1) peak = Math.max(peak, Math.abs(table[i] ?? 0));
  return { table, scale: peak > 0 ? TABLE_PEAK / peak : 0 };
}

/** Same piecewise ADSR shape as the amplitude envelope, but for the cutoff. */
function filterEnvelopeAt(filter: InstrumentFilter, seconds: number, duration: number): number {
  const { attack, decay, sustain, release } = filter;
  let level: number;
  if (attack > 0 && seconds < attack) {
    level = seconds / attack;
  } else if (decay > 0 && seconds < attack + decay) {
    level = 1 - (1 - sustain) * ((seconds - attack) / decay);
  } else {
    level = sustain;
  }

  const releaseTime = Math.min(release, duration);
  const remaining = duration - seconds;
  if (releaseTime > 0 && remaining < releaseTime) level *= remaining / releaseTime;
  return clamp(level, 0, 1);
}

/** TPT state-variable low-pass, per note, so chords keep independent state. */
class NoteFilter {
  private ic1eq = 0;
  private ic2eq = 0;
  private countdown = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private readonly filter: InstrumentFilter;
  private readonly rate: number;

  constructor(filter: InstrumentFilter, rate: number) {
    this.filter = filter;
    this.rate = rate;
  }

  process(input: number, cutoffHz: number): number {
    if (this.countdown <= 0) {
      this.countdown = FILTER_BLOCK;
      const cutoff = clamp(cutoffHz, MIN_CUTOFF_HZ, this.rate * 0.45);
      const g = Math.tan((Math.PI * cutoff) / this.rate);
      const k = 1 / this.filter.resonance;
      const a1 = 1 / (1 + g * (g + k));
      this.a1 = a1;
      this.a2 = g * a1;
      this.a3 = g * this.a2;
    }
    this.countdown -= 1;

    const v3 = input - this.ic2eq;
    const v1 = this.a1 * this.ic1eq + this.a2 * v3;
    const v2 = this.ic2eq + this.a2 * this.ic1eq + this.a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    return v2;
  }
}

interface UnisonVoice {
  phase: number;
  readonly detuneRatio: number;
  readonly wave: WaveState;
  /** Per-partial phase in turns, only allocated by the dynamic additive path. */
  readonly partialPhases?: Float64Array;
  /** Per-partial decay gain, 1 at note start and multiplied every sample. */
  readonly partialGains?: Float32Array;
}

/**
 * One scheduled note's oscillator stack. Phase and filter state are per note,
 * so overlapping chord voices and legato gates never share state.
 */
export class InstrumentVoice {
  private readonly instrument: Instrument;
  private readonly rate: number;
  private readonly key: number;
  private readonly voices: readonly UnisonVoice[];
  private readonly table?: Float32Array;
  /** Present when stretch or a per-partial decay needs per-sample synthesis. */
  private readonly dynamic?: readonly ResolvedPartial[];
  /** Per-partial one-sample decay multipliers, indexed like `dynamic`. */
  private readonly decayFactors?: Float64Array;
  private readonly filter?: NoteFilter;

  constructor(instrument: Instrument, midi: number, rate: number, seed: number) {
    this.instrument = instrument;
    this.rate = rate;
    this.key = clamp(midi - 36, 0, 63);

    let table: Float32Array | undefined;
    let dynamic: readonly ResolvedPartial[] | undefined;
    let decayFactors: Float64Array | undefined;
    if (instrument.type === 'additive') {
      const partials = instrument.partials ?? DEFAULT_PARTIALS;
      const stretch = instrument.stretch ?? 0;
      const tilt = instrument.tilt ?? 0;
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const resolved = resolvePartials(partials, frequency, rate, stretch, tilt);
      const cycle = buildCycle(resolved);

      if (stretch > 0 || partials.some((partial) => (partial.decay ?? 0) > 0)) {
        dynamic = resolved.map((partial) => ({ ...partial, amplitude: partial.amplitude * cycle.scale }));
        decayFactors = new Float64Array(resolved.length);
        for (let index = 0; index < resolved.length; index += 1) {
          const decay = resolved[index]?.decay ?? 0;
          decayFactors[index] = decay > 0 ? Math.exp(-1 / (decay * rate)) : 1;
        }
      } else {
        // Static path: the table is the whole voice, exactly as before the
        // stretch/decay fields existed (tilt 0 multiplies by 1).
        for (let index = 0; index < TABLE_SIZE; index += 1) {
          cycle.table[index] = (cycle.table[index] ?? 0) * cycle.scale;
        }
        table = cycle.table;
      }
    }
    this.table = table;
    this.dynamic = dynamic;
    this.decayFactors = decayFactors;

    const count = instrument.unison;
    const voices: UnisonVoice[] = [];
    for (let index = 0; index < count; index += 1) {
      // Centre the stack: ±detuneCents around the true pitch.
      const cents = (index - (count - 1) / 2) * instrument.detuneCents;
      const initialPhase = count > 1 ? index / count : 0;
      let partialPhases: Float64Array | undefined;
      let partialGains: Float32Array | undefined;
      if (dynamic !== undefined) {
        partialPhases = new Float64Array(dynamic.length);
        partialGains = new Float32Array(dynamic.length).fill(1);
        for (let partial = 0; partial < dynamic.length; partial += 1) {
          const resolved = dynamic[partial];
          if (resolved === undefined) continue;
          partialPhases[partial] = initialPhase * resolved.ratio + resolved.phase / TAU;
        }
      }
      voices.push({
        phase: initialPhase,
        detuneRatio: 2 ** (cents / 1200),
        // A distinct noise seed per unison voice keeps `noise` from summing
        // into one louder copy of the same stream.
        wave: createWaveState((seed + Math.imul(index, 0x9e3779b1)) >>> 0),
        partialPhases,
        partialGains,
      });
    }
    this.voices = voices;
    this.filter = instrument.filter === undefined ? undefined : new NoteFilter(instrument.filter, rate);
  }

  sample(frequency: number, seconds: number, duration: number): number {
    let sum = 0;
    for (const voice of this.voices) {
      const advance = (frequency * voice.detuneRatio) / this.rate;
      voice.phase += advance;
      if (voice.phase > 1e6) voice.phase -= Math.floor(voice.phase);
      sum += this.oscillate(voice, seconds, advance);
    }
    // Unison is loudness-neutral: one voice is multiplied by exactly 1.
    let value = sum / Math.sqrt(this.voices.length);

    const filter = this.filter;
    if (filter !== undefined && this.instrument.filter !== undefined) {
      const level = filterEnvelopeAt(this.instrument.filter, seconds, duration);
      const cutoff = this.instrument.filter.cutoffHz * 2 ** (this.instrument.filter.envAmount * level);
      value = filter.process(value, cutoff);
    }

    const drive = this.instrument.drive;
    if (drive > 0) {
      value = Math.tanh(value * (1 + drive * 8)) * (1 - drive * 0.4);
    }
    return value;
  }

  private oscillate(voice: UnisonVoice, seconds: number, advance: number): number {
    const dynamic = this.dynamic;
    if (dynamic !== undefined) {
      const phases = voice.partialPhases;
      const gains = voice.partialGains;
      if (phases === undefined || gains === undefined) return 0;

      let value = 0;
      for (let index = 0; index < dynamic.length; index += 1) {
        const partial = dynamic[index];
        if (partial === undefined) continue;
        let gain = gains[index] ?? 0;
        if (gain <= 0) continue;

        let phase = (phases[index] ?? 0) + advance * partial.ratio;
        if (phase > 1e6) phase -= Math.floor(phase);
        phases[index] = phase;
        value += Math.sin(TAU * phase) * partial.amplitude * gain;

        if (partial.decay > 0) {
          // Recursive exponential decay: one multiply per partial per sample,
          // instead of recomputing exp() from the elapsed time.
          gain *= this.decayFactors?.[index] ?? 1;
          gains[index] = gain < 1e-6 ? 0 : gain;
        }
      }
      return value;
    }

    const phase = voice.phase;
    const t = phase - Math.floor(phase);

    switch (this.instrument.type) {
      case 'chip': {
        voice.wave.phase = phase;
        return sampleWaveform(this.instrument.waveform, voice.wave, this.key);
      }
      case 'additive': {
        const table = this.table;
        if (table === undefined) return 0;
        const position = t * TABLE_SIZE;
        const index = Math.floor(position);
        const fraction = position - index;
        const first = table[index & TABLE_MASK] ?? 0;
        const second = table[(index + 1) & TABLE_MASK] ?? 0;
        return first + (second - first) * fraction;
      }
      case 'fm': {
        const ratio = this.instrument.ratio ?? 2;
        const decay = this.instrument.indexDecay ?? 0.3;
        const index = (this.instrument.index ?? 3) * Math.exp(-seconds / decay);
        return Math.sin(2 * Math.PI * phase + index * Math.sin(2 * Math.PI * ratio * phase)) * FM_PEAK;
      }
      case 'sample':
        // Sample voices use SampleVoice; constructing InstrumentVoice for one is
        // a bug, and silence is safer than pretending an oscillator exists.
        return 0;
    }
  }
}
