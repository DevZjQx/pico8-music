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
 * Additive tables peak here, like the chip waves (~0.25) and FM (`FM_PEAK`), so
 * changing a track's voice type does not jump its level.
 */
const TABLE_PEAK = 0.25;
/** Two-operator FM peak, chosen to sit next to the chip waves. */
const FM_PEAK = 0.25;
const DEFAULT_PARTIALS: readonly Partial[] = [
  1, 0.5, 1 / 3, 0.25, 0.2, 1 / 6, 1 / 7, 0.125,
].map((amplitude) => ({ amplitude, phase: 0 }));

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Band-limited additive table. Harmonics above Nyquist for this note are
 * dropped, which is what keeps high additive notes from aliasing like a naive
 * saw would. Phase is per harmonic, so one table covers mirrored and duty-cycle
 * shapes, not just the amplitudes a real-valued harmonic series can reach.
 *
 * The table is scaled by its measured peak rather than by the amplitude sum, so
 * a model-authored shape keeps the same level when only its phases change.
 */
function buildTable(partials: readonly Partial[], frequency: number, rate: number): Float32Array {
  const table = new Float32Array(TABLE_SIZE);
  const limit = rate * 0.45;

  for (let harmonic = 1; harmonic <= partials.length; harmonic += 1) {
    const partial = partials[harmonic - 1];
    if (partial === undefined || partial.amplitude <= 0 || harmonic * frequency >= limit) continue;
    const { amplitude, phase } = partial;
    for (let i = 0; i < TABLE_SIZE; i += 1) {
      table[i] = (table[i] ?? 0) + amplitude * Math.sin((2 * Math.PI * harmonic * i) / TABLE_SIZE + phase);
    }
  }

  let peak = 0;
  for (let i = 0; i < TABLE_SIZE; i += 1) peak = Math.max(peak, Math.abs(table[i] ?? 0));
  const scale = peak > 0 ? TABLE_PEAK / peak : 0;
  for (let i = 0; i < TABLE_SIZE; i += 1) table[i] = (table[i] ?? 0) * scale;
  return table;
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
  private readonly filter?: NoteFilter;

  constructor(instrument: Instrument, midi: number, rate: number, seed: number) {
    this.instrument = instrument;
    this.rate = rate;
    this.key = clamp(midi - 36, 0, 63);

    const count = instrument.unison;
    const voices: UnisonVoice[] = [];
    for (let index = 0; index < count; index += 1) {
      // Centre the stack: ±detuneCents around the true pitch.
      const cents = (index - (count - 1) / 2) * instrument.detuneCents;
      voices.push({
        phase: count > 1 ? index / count : 0,
        detuneRatio: 2 ** (cents / 1200),
        // A distinct noise seed per unison voice keeps `noise` from summing
        // into one louder copy of the same stream.
        wave: createWaveState((seed + Math.imul(index, 0x9e3779b1)) >>> 0),
      });
    }
    this.voices = voices;

    this.table =
      instrument.type === 'additive'
        ? buildTable(instrument.partials ?? DEFAULT_PARTIALS, 440 * 2 ** ((midi - 69) / 12), rate)
        : undefined;
    this.filter = instrument.filter === undefined ? undefined : new NoteFilter(instrument.filter, rate);
  }

  sample(frequency: number, seconds: number, duration: number): number {
    let sum = 0;
    for (const voice of this.voices) {
      voice.phase += (frequency * voice.detuneRatio) / this.rate;
      if (voice.phase > 1e6) voice.phase -= Math.floor(voice.phase);
      sum += this.oscillate(voice, seconds);
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

  private oscillate(voice: UnisonVoice, seconds: number): number {
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
    }
  }
}
