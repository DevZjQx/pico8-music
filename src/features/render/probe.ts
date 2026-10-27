import {
  WAVEFORM_NAMES,
  frequencyOf,
  parseNoteName,
  type Envelope,
  type FmOperator,
  type Instrument,
  type InstrumentType,
  type Score,
  type ScoreTrack,
} from '../score/feature.ts';
import { fft } from './analyze.ts';
import { STYLES } from './styles.ts';
import { renderScore } from './synth.ts';
import type { SampleBank } from './sample.ts';
import type { Quality, StyleName } from './types.ts';

// Owns: measuring one instrument as a controlled source, not a mix. A probe
// renders a single note with no post chain, no track EQ/delay/send, fixed
// velocity and a known gate, then reports the descriptors a synth can act on:
// odd/even harmonics, spectral slope, attack/decay, high-frequency decay, FM
// sidebands, and measured parameter sensitivity.
// Does not own: the score DSL or the render report. The probe is deliberately
// separate from `p8_music`: those metrics are only meaningful when the source is
// isolated and the note/gate are known.

const RATE = 44100;
const DEFAULT_NOTE = 'A4';
const DEFAULT_SECONDS = 1.5;
const DEFAULT_VOLUME = 5;
const MIN_SECONDS = 0.25;
const MAX_SECONDS = 4;
const MAX_HARMONIC = 64;
const SPECTRUM_MAX_SIZE = 8192;
const HF_FRAME = 1024;
const HF_HOP = 512;
/** The probe timeline is only a carrier for one gate; 32 steps is plenty. */
const PROBE_STEPS = 32;

export interface ProbeOptions {
  /** Note name such as `A4`; default A4. */
  readonly note?: string;
  /** Fixed velocity 0-7; default 5. */
  readonly volume?: number;
  /** Gate length in seconds, 0.25-4; default 1.5. */
  readonly seconds?: number;
  readonly quality?: Quality;
  /** Style role defaults, matching what p8_music rendered; explicit track.instrument wins. */
  readonly style?: StyleName;
  /** Measure the source without the instrument's filter. */
  readonly bypassFilter?: boolean;
  /** Render parameter variants and report measured deltas; default true. */
  readonly sensitivity?: boolean;
  readonly samples?: SampleBank;
  readonly signal?: AbortSignal;
}

export interface FmProbeReading {
  /** Ratio of the dominant carrier modulator. */
  readonly ratio: number;
  /** Peak index of the dominant carrier modulator. */
  readonly index: number;
  readonly indexDecay: number;
  /** Operators including the carrier; 2 for the classic two-operator voice. */
  readonly operators: number;
  /** Carrier power divided by carrier plus sideband power; 1 is no sidebands. */
  readonly carrierShare: number | null;
  /** Significant sidebands within 30 dB of the carrier. */
  readonly sidebandCount: number;
  readonly highestSidebandHz: number | null;
  /** Carson's rule estimate against Nyquist; the clean path may cap the index. */
  readonly aliasRisk: boolean;
}

export interface ProbeMetrics {
  /** False for FM, samples, noise/phaser chip waves, and stretched additive. */
  readonly oddEvenApplicable: boolean;
  /** Upper-harmonic energy ratio (n >= 2); the fundamental is excluded. */
  readonly oddEvenRatio: number | null;
  /** Odd share of the same upper harmonics, 0..1. */
  readonly oddShare: number | null;
  readonly harmonicsMeasured: number;
  /** Harmonic-band power over total power; useful when odd/even does not apply. */
  readonly harmonicShare: number | null;
  readonly spectralSlopeDbPerOctave: number | null;
  readonly centroidHz: number;
  readonly rolloff85Hz: number | null;
  readonly highShare: number;
  readonly airShare: number;
  readonly attackSeconds: number | null;
  readonly decaySeconds: number | null;
  readonly hfDecaySeconds: number | null;
  readonly hfDecayDbPerSecond: number | null;
  readonly earlyCentroidHz: number | null;
  readonly lateCentroidHz: number | null;
  readonly fm?: FmProbeReading;
}

export interface ProbeSensitivity {
  readonly parameter: string;
  readonly from: number;
  readonly to: number;
  /** Measured change, variant minus base, in the metric's native unit. */
  readonly effects: Readonly<Record<string, number>>;
}

export interface ProbeReading {
  readonly track: string;
  readonly instrumentType: InstrumentType;
  readonly waveform: string | null;
  readonly note: string;
  readonly midi: number;
  readonly frequencyHz: number;
  readonly volume: number;
  readonly seconds: number;
  readonly quality: Quality;
  readonly filterActive: boolean;
  readonly envelope: Envelope;
  readonly metrics: ProbeMetrics;
  readonly sensitivity: readonly ProbeSensitivity[];
  readonly notes: readonly string[];
}

interface ResolvedOptions {
  readonly midi: number;
  readonly frequencyHz: number;
  readonly note: string;
  readonly volume: number;
  readonly seconds: number;
  readonly quality: Quality;
  readonly sensitivity: boolean;
  readonly samples?: SampleBank;
  readonly signal?: AbortSignal;
}

interface MetricGetter {
  (metrics: ProbeMetrics): number | null;
}

const METRIC_GETTERS: Readonly<Record<string, MetricGetter>> = {
  oddEvenRatio: (m) => m.oddEvenRatio,
  oddShare: (m) => m.oddShare,
  harmonicShare: (m) => m.harmonicShare,
  spectralSlopeDbPerOctave: (m) => m.spectralSlopeDbPerOctave,
  centroidHz: (m) => m.centroidHz,
  rolloff85Hz: (m) => m.rolloff85Hz,
  highShare: (m) => m.highShare,
  airShare: (m) => m.airShare,
  attackSeconds: (m) => m.attackSeconds,
  decaySeconds: (m) => m.decaySeconds,
  hfDecaySeconds: (m) => m.hfDecaySeconds,
  hfDecayDbPerSecond: (m) => m.hfDecayDbPerSecond,
  sidebandCount: (m) => m.fm?.sidebandCount ?? null,
  carrierShare: (m) => m.fm?.carrierShare ?? null,
  highestSidebandHz: (m) => m.fm?.highestSidebandHz ?? null,
};

const METRIC_LABELS: Readonly<Record<string, string>> = {
  oddEvenRatio: 'upper odd/even',
  oddShare: 'odd share',
  harmonicShare: 'harmonic share',
  spectralSlopeDbPerOctave: 'slope',
  centroidHz: 'centroid',
  rolloff85Hz: 'rolloff85',
  highShare: 'high',
  airShare: 'air',
  attackSeconds: 'attack',
  decaySeconds: 'decay',
  hfDecaySeconds: 'HF decay',
  hfDecayDbPerSecond: 'HF decay rate',
  sidebandCount: 'sidebands',
  carrierShare: 'carrier',
  highestSidebandHz: 'highest sideband',
};

const METRIC_UNITS: Readonly<Record<string, string>> = {
  oddEvenRatio: ':1',
  oddShare: '%',
  harmonicShare: '%',
  spectralSlopeDbPerOctave: ' dB/oct',
  centroidHz: ' Hz',
  rolloff85Hz: ' Hz',
  highShare: '%',
  airShare: '%',
  attackSeconds: ' ms',
  decaySeconds: ' ms',
  hfDecaySeconds: ' ms',
  hfDecayDbPerSecond: ' dB/s',
  sidebandCount: '',
  carrierShare: '%',
  highestSidebandHz: ' Hz',
};

interface EnvelopeReading {
  readonly attackSeconds: number | null;
  readonly decaySeconds: number | null;
}

interface SpectrumReading {
  readonly centroidHz: number;
  readonly rolloff85Hz: number | null;
  readonly slopeDbPerOctave: number | null;
  readonly highShare: number;
  readonly airShare: number;
  readonly oddEvenApplicable: boolean;
  /** Upper-harmonic energy ratio (n >= 2); the fundamental is excluded. */
  readonly oddEvenRatio: number | null;
  /** Odd share of the same upper harmonics, 0..1. */
  readonly oddShare: number | null;
  readonly harmonicsMeasured: number;
  readonly harmonicShare: number | null;
  readonly fm?: FmProbeReading;
}

interface HfReading {
  readonly hfDecaySeconds: number | null;
  readonly hfDecayDbPerSecond: number | null;
  readonly earlyCentroidHz: number | null;
  readonly lateCentroidHz: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function dbOfPower(power: number): number {
  return power <= 0 ? -Infinity : 10 * Math.log10(power);
}

/**
 * The carrier-shaping modulator: the loudest one that targets operator 0. The
 * probe reports sideband spacing from this operator, which is what a listener
 * hears as the FM timbre. Ties keep the first entry.
 */
function primaryOperatorIndex(operators: readonly FmOperator[]): number {
  let best = 0;
  for (let index = 0; index < operators.length; index += 1) {
    const candidate = operators[index];
    const current = operators[best];
    if (candidate === undefined) continue;
    if (current === undefined) {
      best = index;
      continue;
    }
    const candidateToCarrier = candidate.target === 0;
    const currentToCarrier = current.target === 0;
    if (candidateToCarrier !== currentToCarrier) {
      if (candidateToCarrier) best = index;
      continue;
    }
    if (candidate.index > current.index) best = index;
  }
  return best;
}

interface FmSummary {
  readonly ratio: number;
  readonly index: number;
  readonly indexDecay: number;
  /** Operators including the carrier; 2 for the classic two-operator voice. */
  readonly operators: number;
}

function fmSummary(instrument: Instrument): FmSummary {
  const operators = instrument.operators;
  if (operators !== undefined && operators.length > 0) {
    const primary = operators[primaryOperatorIndex(operators)];
    if (primary !== undefined) {
      return {
        ratio: primary.ratio,
        index: primary.index,
        indexDecay: primary.indexDecay,
        operators: operators.length + 1,
      };
    }
  }
  return {
    ratio: instrument.ratio ?? 2,
    index: instrument.index ?? 3,
    indexDecay: instrument.indexDecay ?? 0.3,
    operators: 2,
  };
}

function resolveMidiForProbe(note: string): number {
  const midi = parseNoteName(note);
  if (midi === undefined) {
    throw new Error(`probe note must be a note name such as A4, C3, or F#2, got ${JSON.stringify(note)}`);
  }
  if (midi < 24 || midi > 108) {
    throw new Error(`probe note must stay between C1 and C8, got ${JSON.stringify(note)}`);
  }
  return midi;
}

/** Choose the track to probe; drum tracks have no pitched source to measure. */
export function findProbeTrack(score: Score, name?: string): ScoreTrack {
  const melodic = score.tracks.filter((track) => !track.isDrums);
  if (melodic.length === 0) {
    throw new Error('probe needs at least one melodic track; drum tracks have no pitched source to measure');
  }
  if (name === undefined || name.trim() === '') return melodic[0] as ScoreTrack;
  const track = score.tracks.find((candidate) => candidate.name === name);
  if (track === undefined) {
    throw new Error(
      `unknown track ${JSON.stringify(name)}; melodic tracks: ${melodic.map((candidate) => candidate.name).join(', ')}`,
    );
  }
  if (track.isDrums) {
    throw new Error(`track ${JSON.stringify(name)} is a drum track; probe needs a melodic instrument`);
  }
  return track;
}

function withoutFilter(instrument: Instrument | undefined, bypass: boolean): Instrument | undefined {
  if (instrument === undefined || !bypass || instrument.filter === undefined) return instrument;
  const { filter: _filter, ...rest } = instrument;
  return rest;
}

function probeScore(
  score: Score,
  track: ScoreTrack,
  options: ResolvedOptions,
  instrument: Instrument | undefined,
  envelope: Envelope,
): Score {
  const event = {
    step: 0,
    steps: PROBE_STEPS,
    gateSteps: PROBE_STEPS,
    voice: 0,
    midi: options.midi,
    frequency: options.frequencyHz,
    effect: 0 as const,
    volume: options.volume,
  };
  const probeTrack: ScoreTrack = {
    ...track,
    name: 'probe',
    role: 'probe',
    isDrums: false,
    group: undefined,
    instrument,
    volume: options.volume,
    envelope,
    articulation: undefined,
    patternSteps: PROBE_STEPS,
    events: [event],
    patterns: {},
    timeline: undefined,
    pan: 0,
    send: 0,
    sendBus: undefined,
    sendStereo: undefined,
    duck: 0,
    filter: undefined,
    highpassHz: undefined,
    lowShelf: undefined,
    highShelf: undefined,
    delay: undefined,
  };
  return {
    mode: 'loop',
    bpm: score.bpm,
    stepsPerBeat: 4,
    beatsPerBar: 4,
    bars: 1,
    totalSteps: PROBE_STEPS,
    stepSeconds: options.seconds / PROBE_STEPS,
    durationSeconds: options.seconds,
    swing: 0,
    swingUnit: 1,
    seed: score.seed,
    humanize: { timingMs: 0, velocity: 0 },
    tuning: score.tuning,
    tracks: [probeTrack],
    groups: new Map(),
    sections: [],
    tailSeconds: 0,
    samples: score.samples,
    drumSamples: new Map(),
    drumChoke: new Map(),
    warnings: [],
  };
}

function renderProbe(score: Score, options: ResolvedOptions): Float32Array {
  // The probe needs dry synth audio only: no post chain, no master trim, no
  // render report. Going through renderLoop would measure a report that the
  // probe then throws away.
  const output = renderScore(
    score,
    RATE,
    options.signal,
    undefined,
    options.samples,
    options.quality,
  );
  const mono = new Float32Array(output.left.length);
  for (let i = 0; i < mono.length; i += 1) {
    mono[i] = ((output.left[i] ?? 0) + (output.right[i] ?? 0)) * 0.5;
  }
  return mono;
}

/**
 * RMS envelope with a frame long enough to cover at least one low-note period.
 * Attack is the 10%-to-90% rise before the first peak; decay is peak-to-20 dB
 * before the release region. Flat envelopes therefore report a short attack and
 * no decay, instead of inventing a slope from tiny numerical ripples.
 */
function measureEnvelope(
  mono: Float32Array,
  rate: number,
  frequencyHz: number,
  envelope: Envelope,
  duration: number,
): EnvelopeReading {
  const frame = Math.max(
    128,
    Math.min(Math.round(rate * 0.03), Math.round(rate * Math.max(0.005, 1.5 / Math.max(1, frequencyHz)))),
  );
  const hop = Math.max(1, Math.floor(frame / 2));
  const levels: number[] = [];
  for (let start = 0; start + frame <= mono.length; start += hop) {
    let squares = 0;
    for (let i = start; i < start + frame; i += 1) squares += (mono[i] ?? 0) ** 2;
    levels.push(Math.sqrt(squares / frame));
  }
  if (levels.length === 0) return { attackSeconds: null, decaySeconds: null };

  let peakIndex = 0;
  for (let i = 1; i < levels.length; i += 1) {
    if ((levels[i] ?? 0) > (levels[peakIndex] ?? 0)) peakIndex = i;
  }
  const peak = levels[peakIndex] ?? 0;
  if (peak <= 1e-9) return { attackSeconds: null, decaySeconds: null };

  let lowIndex = 0;
  while (lowIndex < peakIndex && (levels[lowIndex] ?? 0) < peak * 0.1) lowIndex += 1;
  let highIndex = lowIndex;
  while (highIndex < peakIndex && (levels[highIndex] ?? 0) < peak * 0.9) highIndex += 1;

  const attackSeconds = Math.max(0, ((highIndex - lowIndex) * hop) / rate);
  const releaseStart = Math.max(0, duration - Math.min(envelope.release, duration));
  let decaySeconds: number | null = null;
  for (let i = peakIndex + 1; i < levels.length; i += 1) {
    const seconds = (i * hop) / rate;
    if (seconds > releaseStart) break;
    if ((levels[i] ?? 0) <= peak * 0.1) {
      decaySeconds = (seconds - (peakIndex * hop) / rate);
      break;
    }
  }
  return { attackSeconds, decaySeconds };
}

function windowedSpectrum(
  mono: Float32Array,
  start: number,
  size: number,
): { magnitude: Float64Array; binHz: number } {
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    real[i] = (mono[start + i] ?? 0) * window;
  }
  fft(real, imaginary);
  const bins = size / 2;
  const magnitude = new Float64Array(bins);
  for (let bin = 1; bin < bins; bin += 1) {
    const re = real[bin] ?? 0;
    const im = imaginary[bin] ?? 0;
    magnitude[bin] = Math.sqrt(re * re + im * im);
  }
  return { magnitude, binHz: RATE / size };
}

function regressionSlope(points: readonly { x: number; y: number }[]): number | null {
  if (points.length < 4) return null;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function effectiveWaveform(track: ScoreTrack, instrument: Instrument | undefined) {
  if (instrument === undefined) return track.waveform;
  return instrument.type === 'chip' ? instrument.waveform : undefined;
}

function harmonicApplicability(instrument: Instrument | undefined, track: ScoreTrack): boolean {
  const waveform = effectiveWaveform(track, instrument);
  if (waveform !== undefined) {
    // Noise and phaser are not a stable harmonic series at the note frequency.
    return waveform !== 6 && waveform !== 7;
  }
  if (instrument?.type === 'additive') return (instrument.stretch ?? 0) === 0;
  return false;
}

function powerAt(
  magnitude: Float64Array,
  binHz: number,
  frequencyHz: number,
  toleranceCents: number,
): number {
  const halfWidth = frequencyHz * (2 ** (toleranceCents / 1200) - 1);
  const first = Math.max(1, Math.ceil((frequencyHz - halfWidth) / binHz));
  const last = Math.min(magnitude.length - 1, Math.floor((frequencyHz + halfWidth) / binHz));
  let power = 0;
  for (let bin = first; bin <= last; bin += 1) {
    const value = magnitude[bin] ?? 0;
    power += value * value;
  }
  return power;
}

function measureSpectrum(
  mono: Float32Array,
  track: ScoreTrack,
  instrument: Instrument | undefined,
  envelope: Envelope,
  frequencyHz: number,
  duration: number,
): SpectrumReading {
  const attackDecay = Math.min(envelope.attack + envelope.decay, duration * 0.5);
  const releaseStart = Math.max(0, duration - Math.min(envelope.release, duration));
  const start = Math.min(mono.length, Math.round(Math.min(attackDecay, releaseStart) * RATE));
  const end = Math.min(mono.length, Math.max(start + 1, Math.round(releaseStart * RATE)));
  let size = 2 ** Math.floor(Math.log2(Math.max(64, end - start)));
  size = Math.min(SPECTRUM_MAX_SIZE, size);
  if (size < 256) {
    size = Math.min(2048, 2 ** Math.floor(Math.log2(Math.max(64, mono.length))));
  }
  if (size < 64 || mono.length === 0) {
    return {
      centroidHz: 0,
      rolloff85Hz: null,
      slopeDbPerOctave: null,
      highShare: 0,
      airShare: 0,
      oddEvenApplicable: false,
      oddEvenRatio: null,
      oddShare: null,
      harmonicsMeasured: 0,
      harmonicShare: null,
    };
  }

  const { magnitude, binHz } = windowedSpectrum(mono, Math.min(start, Math.max(0, mono.length - size)), size);
  const nyquist = RATE / 2;
  let total = 0;
  let high = 0;
  let air = 0;
  let weighted = 0;
  let cumulative = 0;
  let rolloff85Hz: number | null = null;
  const powers = new Float64Array(magnitude.length);
  for (let bin = 1; bin < magnitude.length; bin += 1) {
    const frequency = bin * binHz;
    const value = magnitude[bin] ?? 0;
    const power = value * value;
    powers[bin] = power;
    if (frequency >= 20 && frequency < Math.min(16000, nyquist)) {
      total += power;
      weighted += frequency * power;
      if (frequency >= 2000 && frequency < 8000) high += power;
      if (frequency >= 8000 && frequency < 16000) air += power;
    }
  }
  if (total <= 1e-18) {
    return {
      centroidHz: 0,
      rolloff85Hz: null,
      slopeDbPerOctave: null,
      highShare: 0,
      airShare: 0,
      oddEvenApplicable: false,
      oddEvenRatio: null,
      oddShare: null,
      harmonicsMeasured: 0,
      harmonicShare: null,
    };
  }
  const top = Math.min(16000, nyquist);
  for (let bin = 1; bin < magnitude.length; bin += 1) {
    const frequency = bin * binHz;
    if (frequency < 20 || frequency >= top) continue;
    cumulative += powers[bin] ?? 0;
    if (rolloff85Hz === null && cumulative >= total * 0.85) rolloff85Hz = frequency;
  }

  // One-third-octave levels keep the slope from being dominated by individual
  // harmonic peaks; a pure sine therefore reports no slope instead of a fake one.
  const points: Array<{ x: number; y: number }> = [];
  for (let center = 100; center < top; center *= 2 ** (1 / 3)) {
    const low = center / 2 ** (1 / 6);
    const upper = center * 2 ** (1 / 6);
    const first = Math.max(1, Math.ceil(low / binHz));
    const last = Math.min(magnitude.length - 1, Math.floor(upper / binHz));
    let power = 0;
    for (let bin = first; bin <= last; bin += 1) power += powers[bin] ?? 0;
    if (power > total * 1e-7) points.push({ x: Math.log2(center), y: dbOfPower(power) });
  }
  const bandSlopeDbPerOctave = regressionSlope(points);

  const applicable = harmonicApplicability(instrument, track);
  const toleranceCents = Math.max(
    25,
    (instrument?.detuneCents ?? 0) * Math.max(0, (instrument?.unison ?? 1) - 1) * 0.5 + 25,
  );
  const maxHarmonic = Math.min(MAX_HARMONIC, Math.floor((Math.min(16000, nyquist * 0.9)) / frequencyHz));
  let harmonicPower = 0;
  let oddPower = 0;
  let evenPower = 0;
  const harmonicPowers: number[] = [];
  if (applicable && maxHarmonic >= 1) {
    for (let harmonic = 1; harmonic <= maxHarmonic; harmonic += 1) {
      const power = powerAt(magnitude, binHz, frequencyHz * harmonic, toleranceCents);
      harmonicPowers.push(power);
      harmonicPower += power;
      if (harmonic >= 2) {
        if (harmonic % 2 === 1) oddPower += power;
        else evenPower += power;
      }
    }
  }
  const peakHarmonicPower = harmonicPowers.reduce((max, power) => Math.max(max, power), 0);
  // A square wave's even harmonics are around -45 dB from the fundamental.
  // Including those numerical leftovers in a log regression tilts the slope;
  // keep only harmonics within 40 dB of the strongest one.
  const harmonicPoints: Array<{ x: number; y: number }> = [];
  let harmonicsMeasured = 0;
  if (peakHarmonicPower > 0) {
    for (let index = 0; index < harmonicPowers.length; index += 1) {
      const power = harmonicPowers[index] ?? 0;
      if (power < peakHarmonicPower * 1e-4) continue;
      harmonicsMeasured += 1;
      const harmonic = index + 1;
      if (frequencyHz * harmonic <= 8000) {
        harmonicPoints.push({ x: Math.log2(frequencyHz * harmonic), y: dbOfPower(power) });
      }
    }
  }
  // A line spectrum needs a harmonic regression: integrating power in widening
  // one-third-octave bands makes a 1/n series look like it gets brighter with
  // frequency, because each band contains more harmonics. Dense/noisy spectra
  // keep the band slope, where width-integration is the right operation.
  const slopeDbPerOctave = applicable
    ? harmonicPoints.length >= 4
      ? regressionSlope(harmonicPoints)
      : null
    : bandSlopeDbPerOctave;
  const oddEvenApplicable = applicable && maxHarmonic >= 3 && oddPower + evenPower > 1e-18;
  const oddEvenRatio = !oddEvenApplicable
    ? null
    : evenPower <= Math.max(1e-18, oddPower * 1e-6)
      ? oddPower > 1e-18
        ? 999
        : null
      : oddPower <= evenPower * 1e-6
        ? 0
        : Math.min(999, oddPower / evenPower);
  const oddShare =
    oddEvenApplicable && oddPower + evenPower > 1e-18 ? oddPower / (oddPower + evenPower) : null;
  const harmonicShare = applicable && harmonicPower > 0 ? harmonicPower / total : null;

  let fm: FmProbeReading | undefined;
  if (instrument?.type === 'fm') {
    const summary = fmSummary(instrument);
    const { ratio, index, indexDecay } = summary;
    const carrierPower = powerAt(magnitude, binHz, frequencyHz, toleranceCents);
    const spacing = frequencyHz * ratio;
    let sidebandPower = 0;
    let sidebandCount = 0;
    let highestSidebandHz: number | null = null;
    for (let harmonic = 1; harmonic <= 24; harmonic += 1) {
      for (const frequency of [frequencyHz + harmonic * spacing, frequencyHz - harmonic * spacing]) {
        if (frequency <= 20 || frequency >= Math.min(16000, nyquist)) continue;
        const power = powerAt(magnitude, binHz, frequency, toleranceCents);
        sidebandPower += power;
        if (power >= carrierPower * 10 ** (-30 / 10) && power > total * 1e-8) {
          sidebandCount += 1;
          if (highestSidebandHz === null || frequency > highestSidebandHz) highestSidebandHz = frequency;
        }
      }
    }
    const sum = carrierPower + sidebandPower;
    fm = {
      ratio,
      index,
      indexDecay,
      operators: summary.operators,
      carrierShare: sum > 0 ? carrierPower / sum : null,
      sidebandCount,
      highestSidebandHz,
      aliasRisk: frequencyHz * (1 + ratio * (index + 1)) > nyquist,
    };
  }

  return {
    centroidHz: weighted / total,
    rolloff85Hz,
    slopeDbPerOctave,
    highShare: high / total,
    airShare: air / total,
    oddEvenApplicable,
    oddEvenRatio,
    oddShare,
    harmonicsMeasured,
    harmonicShare,
    ...(fm === undefined ? {} : { fm }),
  };
}

/**
 * High-band energy over time gives the dynamic half of timbre: `indexDecay`,
 * filter envelopes, and per-partial decays all shorten this tail even when the
 * steady spectrum looks unchanged.
 */
function measureHf(
  mono: Float32Array,
  rate: number,
  duration: number,
  envelope: Envelope,
): HfReading {
  const powers: number[] = [];
  const centroids: number[] = [];
  const times: number[] = [];
  for (let start = 0; start + HF_FRAME <= mono.length; start += HF_HOP) {
    const real = new Float64Array(HF_FRAME);
    const imaginary = new Float64Array(HF_FRAME);
    for (let i = 0; i < HF_FRAME; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / HF_FRAME);
      real[i] = (mono[start + i] ?? 0) * window;
    }
    fft(real, imaginary);
    let high = 0;
    let total = 0;
    let weighted = 0;
    const binHz = rate / HF_FRAME;
    for (let bin = 1; bin < HF_FRAME / 2; bin += 1) {
      const frequency = bin * binHz;
      const re = real[bin] ?? 0;
      const im = imaginary[bin] ?? 0;
      const power = re * re + im * im;
      if (frequency >= 100 && frequency < 16000) {
        total += power;
        weighted += frequency * power;
        if (frequency >= 2000 && frequency < 8000) high += power;
      }
    }
    powers.push(high);
    centroids.push(total > 0 ? weighted / total : 0);
    times.push((start + HF_FRAME / 2) / rate);
  }
  if (powers.length === 0) {
    return { hfDecaySeconds: null, hfDecayDbPerSecond: null, earlyCentroidHz: null, lateCentroidHz: null };
  }

  let peakIndex = 0;
  for (let i = 1; i < powers.length; i += 1) {
    if ((powers[i] ?? 0) > (powers[peakIndex] ?? 0)) peakIndex = i;
  }
  const peak = powers[peakIndex] ?? 0;
  if (peak <= 1e-18) {
    return { hfDecaySeconds: null, hfDecayDbPerSecond: null, earlyCentroidHz: null, lateCentroidHz: null };
  }

  const releaseStart = Math.max(0, duration - Math.min(envelope.release, duration));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = peakIndex; i < powers.length; i += 1) {
    const power = powers[i] ?? 0;
    if ((times[i] ?? 0) > releaseStart) break;
    if (power <= 0 || power < peak * 10 ** (-30 / 10)) continue;
    xs.push(times[i] ?? 0);
    ys.push(Math.log(power));
  }
  let hfDecaySeconds: number | null = null;
  let hfDecayDbPerSecond: number | null = null;
  if (xs.length >= 3) {
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < xs.length; i += 1) {
      numerator += ((xs[i] ?? 0) - meanX) * ((ys[i] ?? 0) - meanY);
      denominator += ((xs[i] ?? 0) - meanX) ** 2;
    }
    if (denominator > 0) {
      const slope = numerator / denominator;
      const dropDb = 4.343 * ((ys[0] ?? 0) - (ys[ys.length - 1] ?? 0));
      // Ignore a flat or rising HF band; that is sustain, not decay.
      if (slope < -0.2 && dropDb > 3) {
        hfDecaySeconds = -1 / slope;
        hfDecayDbPerSecond = -4.343 * slope;
      }
    }
  }

  const early: number[] = [];
  const late: number[] = [];
  for (let i = 0; i < centroids.length; i += 1) {
    const time = times[i] ?? 0;
    const centroid = centroids[i] ?? 0;
    if (centroid <= 0) continue;
    if (time <= duration * 0.25) early.push(centroid);
    else if (time >= duration * 0.6 && time <= releaseStart) late.push(centroid);
  }
  const average = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    hfDecaySeconds,
    hfDecayDbPerSecond,
    earlyCentroidHz: average(early),
    lateCentroidHz: average(late),
  };
}

function notesFor(
  track: ScoreTrack,
  instrument: Instrument | undefined,
  options: ResolvedOptions,
  metrics: ProbeMetrics,
): string[] {
  const notes: string[] = [];
  if (!metrics.oddEvenApplicable) {
    if (instrument?.type === 'fm') {
      notes.push('upper odd/even is not reported for FM; use the sideband spacing and carrier share');
    } else if (instrument?.type === 'sample') {
      notes.push('upper odd/even is not reported for samples; the source WAV owns the spectrum');
    } else if (instrument?.type === 'additive' && (instrument.stretch ?? 0) > 0) {
      notes.push('upper odd/even is not reported because stretch makes the partials inharmonic');
    } else if (effectiveWaveform(track, instrument) === 6) {
      notes.push('upper odd/even is not reported for the noise waveform');
    } else if (effectiveWaveform(track, instrument) === 7) {
      notes.push('upper odd/even is not reported for the phaser waveform because it is not a pure harmonic series');
    } else {
      notes.push('upper odd/even needs at least two harmonics below Nyquist; try a lower note');
    }
  }
  if (metrics.hfDecaySeconds !== null && metrics.hfDecaySeconds > options.seconds * 0.8) {
    notes.push('HF decay extends beyond the probe; raise seconds to measure the full tail');
  }
  if (
    instrument?.type === 'additive' &&
    instrument.partials?.some((partial) => (partial.decay ?? 0) > 0) === true
  ) {
    notes.push('per-partial decay changes upper odd/even and slope over time; the values come from the steady window');
  }
  if (metrics.fm?.aliasRisk === true) {
    notes.push(
      options.quality === 'clean'
        ? 'authored FM index exceeds the Nyquist estimate; clean quality caps it, pico may fold sidebands'
        : 'authored FM index may fold sidebands; try quality clean or a lower index',
    );
  }
  if (instrument?.filter !== undefined) {
    notes.push('the instrument filter is included; pass bypassFilter true to see the source alone');
  }
  return notes;
}

function measureTrack(
  score: Score,
  track: ScoreTrack,
  options: ResolvedOptions,
  instrument: Instrument | undefined,
  envelope: Envelope,
): ProbeMetrics {
  const mono = renderProbe(probeScore(score, track, options, instrument, envelope), options);
  const envelopeReading = measureEnvelope(mono, RATE, options.frequencyHz, envelope, options.seconds);
  const spectrum = measureSpectrum(mono, track, instrument, envelope, options.frequencyHz, options.seconds);
  const hf = measureHf(mono, RATE, options.seconds, envelope);
  return {
    oddEvenApplicable: spectrum.oddEvenApplicable,
    oddEvenRatio: spectrum.oddEvenRatio,
    oddShare: spectrum.oddShare,
    harmonicsMeasured: spectrum.harmonicsMeasured,
    harmonicShare: spectrum.harmonicShare,
    spectralSlopeDbPerOctave: spectrum.slopeDbPerOctave,
    centroidHz: spectrum.centroidHz,
    rolloff85Hz: spectrum.rolloff85Hz,
    highShare: spectrum.highShare,
    airShare: spectrum.airShare,
    attackSeconds: envelopeReading.attackSeconds,
    decaySeconds: envelopeReading.decaySeconds,
    hfDecaySeconds: hf.hfDecaySeconds,
    hfDecayDbPerSecond: hf.hfDecayDbPerSecond,
    earlyCentroidHz: hf.earlyCentroidHz,
    lateCentroidHz: hf.lateCentroidHz,
    ...(spectrum.fm === undefined ? {} : { fm: spectrum.fm }),
  };
}

interface Variant {
  readonly parameter: string;
  readonly from: number;
  readonly to: number;
  readonly instrument: Instrument | undefined;
  readonly envelope: Envelope;
  readonly keys: readonly string[];
}

function sensitivityVariants(
  instrument: Instrument | undefined,
  envelope: Envelope,
): readonly Variant[] {
  const variants: Variant[] = [];
  const attack = clamp(envelope.attack + 0.05, 0.001, 2);
  if (Math.abs(attack - envelope.attack) >= 0.001) {
    variants.push({
      parameter: 'envelope.attack',
      from: envelope.attack,
      to: attack,
      instrument,
      envelope: { ...envelope, attack },
      keys: ['attackSeconds'],
    });
  }

  if (instrument?.type === 'additive') {
    const current = instrument.tilt ?? 0;
    const next = current < 4 ? Math.min(4, current + 1) : Math.max(0, current - 1);
    variants.push({
      parameter: 'additive.tilt',
      from: current,
      to: next,
      instrument: { ...instrument, tilt: next },
      envelope,
      keys: ['spectralSlopeDbPerOctave', 'centroidHz', 'rolloff85Hz', 'highShare'],
    });
  } else if (instrument?.type === 'fm') {
    const operators = instrument.operators;
    const primary = operators === undefined ? -1 : primaryOperatorIndex(operators);
    const current =
      operators === undefined ? instrument.index ?? 3 : operators[primary]?.index ?? 3;
    const next = current < 12 ? Math.min(12, current + 2) : Math.max(0, current - 2);
    variants.push({
      parameter: operators === undefined ? 'fm.index' : `fm.operators[${primary}].index`,
      from: current,
      to: next,
      instrument:
        operators === undefined
          ? { ...instrument, index: next }
          : {
              ...instrument,
              operators: operators.map((entry, index) =>
                index === primary ? { ...entry, index: next } : entry,
              ),
            },
      envelope,
      keys: [
        'spectralSlopeDbPerOctave',
        'centroidHz',
        'rolloff85Hz',
        'highShare',
        'sidebandCount',
        'carrierShare',
      ],
    });
    const indexDecay =
      operators === undefined
        ? instrument.indexDecay ?? 0.3
        : operators[primary]?.indexDecay ?? 0.3;
    const nextDecay = indexDecay < 4 ? Math.min(4, indexDecay * 2) : Math.max(0.01, indexDecay / 2);
    if (Math.abs(nextDecay - indexDecay) >= 0.001) {
      variants.push({
        parameter:
          operators === undefined ? 'fm.indexDecay' : `fm.operators[${primary}].indexDecay`,
        from: indexDecay,
        to: nextDecay,
        instrument:
          operators === undefined
            ? { ...instrument, indexDecay: nextDecay }
            : {
                ...instrument,
                operators: operators.map((entry, index) =>
                  index === primary ? { ...entry, indexDecay: nextDecay } : entry,
                ),
              },
        envelope,
        keys: ['hfDecaySeconds', 'hfDecayDbPerSecond', 'earlyCentroidHz', 'lateCentroidHz'],
      });
    }
  }

  if (instrument?.filter !== undefined) {
    const current = instrument.filter.cutoffHz;
    const next = current < 20000 ? Math.min(20000, current * 2) : Math.max(40, current / 2);
    if (Math.abs(next - current) >= 1) {
      variants.push({
        parameter: 'filter.cutoffHz',
        from: current,
        to: next,
        instrument: { ...instrument, filter: { ...instrument.filter, cutoffHz: next } },
        envelope,
        keys: ['spectralSlopeDbPerOctave', 'centroidHz', 'rolloff85Hz', 'highShare'],
      });
    }
  }
  return variants;
}

function measureSensitivity(
  score: Score,
  track: ScoreTrack,
  options: ResolvedOptions,
  instrument: Instrument | undefined,
  envelope: Envelope,
  base: ProbeMetrics,
): ProbeSensitivity[] {
  const results: ProbeSensitivity[] = [];
  for (const variant of sensitivityVariants(instrument, envelope)) {
    const measured = measureTrack(score, track, options, variant.instrument, variant.envelope);
    const effects: Record<string, number> = {};
    for (const key of variant.keys) {
      const getter = METRIC_GETTERS[key];
      if (getter === undefined) continue;
      const before = getter(base);
      const after = getter(measured);
      if (before === null || after === null) continue;
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      effects[key] = after - before;
    }
    if (Object.keys(effects).length > 0) {
      results.push({
        parameter: variant.parameter,
        from: variant.from,
        to: variant.to,
        effects,
      });
    }
  }
  return results;
}

function effectiveEnvelope(track: ScoreTrack): Envelope {
  const events = track.timeline ?? track.events;
  return events.find((event) => event.envelope !== undefined)?.envelope ?? track.envelope;
}

/** Render one track as a single, dry, fixed-velocity note and measure it. */
export function probeTrack(
  score: Score,
  trackName?: string,
  input: ProbeOptions = {},
): ProbeReading {
  const track = findProbeTrack(score, trackName);
  const note = input.note ?? DEFAULT_NOTE;
  const midi = resolveMidiForProbe(note);
  const frequencyHz = frequencyOf(midi, score.tuning);
  const style = input.style === undefined ? undefined : STYLES[input.style];
  if (input.style !== undefined && style === undefined) {
    throw new Error(`unknown style ${JSON.stringify(input.style)}; use chip, hitech, ambient, studio, lofi, or soft`);
  }
  const options: ResolvedOptions = {
    midi,
    frequencyHz,
    note,
    volume: clamp(input.volume ?? DEFAULT_VOLUME, 0, 7),
    seconds: clamp(input.seconds ?? DEFAULT_SECONDS, MIN_SECONDS, MAX_SECONDS),
    quality: input.quality ?? style?.quality ?? 'pico',
    sensitivity: input.sensitivity ?? true,
    ...(input.samples === undefined ? {} : { samples: input.samples }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  const roleInstrument =
    style?.instruments?.[track.role.toLowerCase()] ?? style?.instruments?.default;
  const instrument = withoutFilter(
    track.instrument ?? roleInstrument,
    input.bypassFilter ?? false,
  );
  if (instrument?.type === 'sample') {
    const sample = instrument.sample;
    if (sample === undefined || input.samples?.has(sample) !== true) {
      throw new Error(
        `probe cannot render sample ${JSON.stringify(sample)}; the sample is missing from the score bank`,
      );
    }
  }
  const envelope = effectiveEnvelope(track);
  const metrics = measureTrack(score, track, options, instrument, envelope);
  return {
    track: track.name,
    instrumentType: instrument?.type ?? 'chip',
    waveform:
      effectiveWaveform(track, instrument) === undefined
        ? null
        : (WAVEFORM_NAMES[effectiveWaveform(track, instrument) ?? 0] ?? null),
    note,
    midi,
    frequencyHz,
    volume: options.volume,
    seconds: options.seconds,
    quality: options.quality,
    filterActive: instrument?.filter !== undefined,
    envelope,
    metrics,
    sensitivity: options.sensitivity
      ? measureSensitivity(score, track, options, instrument, envelope, metrics)
      : [],
    notes: notesFor(track, instrument, options, metrics),
  };
}

function formatHz(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kHz`;
  return `${Math.round(value)} Hz`;
}

function formatMilliseconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value < 0.001) return '<1 ms';
  return `${Math.round(value * 1000)} ms`;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value >= 999) return 'odd only';
  return `${value.toFixed(1)}:1`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)} s`;
}

function formatEnvelope(envelope: Envelope): string {
  return `attack ${formatMilliseconds(envelope.attack)} · decay ${formatMilliseconds(envelope.decay)} · sustain ${envelope.sustain.toFixed(2)} · release ${formatMilliseconds(envelope.release)}`;
}

function formatSensitivity(item: ProbeSensitivity): string {
  const parts = Object.entries(item.effects).map(([key, value]) => {
    const unit = METRIC_UNITS[key] ?? '';
    const sign = value >= 0 ? '+' : '';
    const number =
      unit === '%'
        ? (value * 100).toFixed(0)
        : unit === ':1'
          ? value.toFixed(2)
          : unit === ' ms'
            ? (value * 1000).toFixed(1)
            : value.toFixed(1);
    const label = METRIC_LABELS[key] ?? key;
    return `${label} ${sign}${number}${unit === '%' ? '%' : unit === ':1' ? ':1' : unit}`;
  });
  const from = item.from % 1 === 0 ? item.from.toFixed(0) : item.from.toFixed(2);
  const to = item.to % 1 === 0 ? item.to.toFixed(0) : item.to.toFixed(2);
  return `${item.parameter} ${from}->${to}: ${parts.join(', ')}`;
}

function hintsFor(reading: ProbeReading): string {
  if (reading.instrumentType === 'fm') {
    return 'if brighter: raise fm.index or filter cutoff; longer HF tail: raise indexDecay; different sideband spacing: change ratio; attack/release: envelope';
  }
  if (reading.instrumentType === 'additive') {
    return 'if darker: raise tilt or lower filter cutoff; odd/even shape: partial amplitudes; shorter HF tail: per-partial decay; attack/release: envelope';
  }
  if (reading.instrumentType === 'sample') {
    return 'the source spectrum is fixed; use the track filter/EQ or a different sample; attack/release: envelope';
  }
  return 'if darker: lower filter cutoff or use triangle; odd/even shape: choose square/pulse (odd-heavy) or saw (both); attack/release: envelope';
}

/** Compact, layered summary for the probe tool result. */
export function formatProbe(reading: ProbeReading): string {
  const m = reading.metrics;
  const source = [
    `slope ${m.spectralSlopeDbPerOctave === null ? 'n/a' : `${m.spectralSlopeDbPerOctave.toFixed(1)} dB/oct`}`,
    `centroid ${formatHz(m.centroidHz)}`,
    `rolloff85 ${formatHz(m.rolloff85Hz)}`,
    `attack ${formatMilliseconds(m.attackSeconds)}`,
    `decay ${formatMilliseconds(m.decaySeconds)}`,
    `HF decay ${formatMilliseconds(m.hfDecaySeconds)}`,
    ...(m.hfDecayDbPerSecond === null ? [] : [`${m.hfDecayDbPerSecond.toFixed(1)} dB/s`]),
  ];
  const lines: string[] = [
    `Probe ${reading.track} (${reading.instrumentType}${reading.waveform === null ? '' : ` ${reading.waveform}`}) ${reading.note} ${reading.frequencyHz.toFixed(2)} Hz · vol ${reading.volume} · ${formatSeconds(reading.seconds)} · ${reading.quality} · filter ${reading.filterActive ? 'on' : 'off'}`,
    `envelope ${formatEnvelope(reading.envelope)}`,
    `source ${source.join(' · ')} · high ${formatPercent(m.highShare)} · air ${formatPercent(m.airShare)}`,
  ];
  if (m.oddEvenApplicable) {
    lines.push(
      `harmonics upper odd/even ${formatRatio(m.oddEvenRatio)} (${formatPercent(m.oddShare)} odd) · ${m.harmonicsMeasured} measured · harmonic share ${formatPercent(m.harmonicShare)}`,
    );
  } else if (m.harmonicShare !== null) {
    lines.push(`harmonics not applicable · harmonic share ${formatPercent(m.harmonicShare)}`);
  }
  if (m.fm !== undefined) {
    const prefix = m.fm.operators > 2 ? `fm ${m.fm.operators} operators` : 'fm';
    lines.push(
      `${prefix} ratio ${m.fm.ratio.toFixed(2)} · index ${m.fm.index.toFixed(2)} · indexDecay ${formatMilliseconds(m.fm.indexDecay)} · sidebands ${m.fm.sidebandCount} · carrier ${formatPercent(m.fm.carrierShare)} · alias risk ${m.fm.aliasRisk ? 'yes' : 'no'}`,
    );
  }
  if (m.earlyCentroidHz !== null || m.lateCentroidHz !== null) {
    lines.push(
      `centroid trajectory early ${formatHz(m.earlyCentroidHz)} -> late ${formatHz(m.lateCentroidHz)}`,
    );
  }
  if (reading.sensitivity.length > 0) {
    lines.push(`sensitivity ${reading.sensitivity.map(formatSensitivity).join(' · ')}`);
  }
  if (reading.notes.length > 0) lines.push(`probe note: ${reading.notes.join(' · ')}`);
  lines.push(`next: ${hintsFor(reading)}`);
  return lines.join('\n');
}
