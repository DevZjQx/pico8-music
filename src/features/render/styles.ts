import type { Instrument } from '../score/feature.ts';
import type { PostStep, StyleName } from './types.ts';

/**
 * Style presets fill the post chain and, for the non-chip styles, role-based
 * instrument defaults. The score, `mode`, and the output format stay untouched.
 * `chip` is the PICO-8-constrained default (no processing at all); `hitech`
 * adds the glue and loudness the dense chip style needs; `ambient` is the
 * slowed, reverbed variant. `studio` and `lofi` select non-chip instruments, so
 * they are the switch that leaves the eight-waveform palette without changing
 * the score syntax. An explicit `track.instrument` always wins, and explicit
 * `post` steps override the chain.
 */
export interface StyleDefinition {
  readonly post: readonly PostStep[];
  /** Lower-case role name to instrument; `default` covers unnamed roles. */
  readonly instruments?: Readonly<Record<string, Instrument>>;
}

/** Style defaults are plain harmonic series; a score can add phases itself. */
const additive = (
  amplitudes: readonly number[],
  options: Partial<Instrument> = {},
): Instrument => ({
  type: 'additive',
  waveform: 4,
  partials: amplitudes.map((amplitude) => ({ amplitude, phase: 0 })),
  unison: 1,
  detuneCents: 0,
  drive: 0,
  ...options,
});

const fm = (options: Partial<Instrument> = {}): Instrument => ({
  type: 'fm',
  waveform: 4,
  ratio: 2,
  index: 2.5,
  indexDecay: 0.4,
  unison: 1,
  detuneCents: 0,
  drive: 0,
  ...options,
});

const SAW_PARTIALS = [1, 0.5, 1 / 3, 0.25, 0.2, 1 / 6, 1 / 7, 0.125, 1 / 9, 0.1, 1 / 11, 1 / 12];
const STRING_PARTIALS = [1, 0.62, 0.44, 0.3, 0.22, 0.16, 0.12, 0.09, 0.07, 0.055, 0.045, 0.035];

const STUDIO_KEYS = fm({
  ratio: 3,
  index: 1.6,
  indexDecay: 0.5,
  filter: {
    cutoffHz: 5000,
    resonance: 0.7,
    envAmount: 0.8,
    attack: 0.004,
    decay: 0.6,
    sustain: 0.2,
    release: 0.3,
  },
});

export const STYLES: Record<StyleName, StyleDefinition> = {
  chip: {
    post: [],
  },
  hitech: {
    post: [
      { type: 'saturate', drive: 0.35, mix: 0.6 },
      { type: 'compress', thresholdDb: -16, ratio: 2.5, attack: 0.01, release: 0.12, makeupDb: 1 },
      { type: 'loudness', targetLufs: -14 },
      { type: 'limiter', ceilingDb: -1, release: 0.08 },
    ],
  },
  ambient: {
    post: [
      { type: 'slow', speed: 0.8 },
      { type: 'lowpass', cutoffHz: 7000 },
      { type: 'reverb', wet: 0.45, room: 0.9, damp: 0.5 },
      { type: 'limiter', ceilingDb: -1, release: 0.15 },
    ],
  },
  studio: {
    post: [
      { type: 'tilt', tiltDb: 0.8 },
      { type: 'saturate', drive: 0.2, mix: 0.35 },
      { type: 'compress', thresholdDb: -18, ratio: 2.2, attack: 0.012, release: 0.16, makeupDb: 1 },
      { type: 'loudness', targetLufs: -14 },
      { type: 'limiter', ceilingDb: -1, release: 0.1 },
    ],
    instruments: {
      bass: additive(SAW_PARTIALS, {
        filter: {
          cutoffHz: 420,
          resonance: 1.4,
          envAmount: 2.4,
          attack: 0.002,
          decay: 0.22,
          sustain: 0.18,
          release: 0.12,
        },
        drive: 0.12,
      }),
      lead: fm({
        ratio: 2,
        index: 2.6,
        indexDecay: 0.45,
        unison: 2,
        detuneCents: 6,
        filter: {
          cutoffHz: 4200,
          resonance: 1,
          envAmount: 1.2,
          attack: 0.005,
          decay: 0.25,
          sustain: 0.35,
          release: 0.18,
        },
      }),
      pad: additive(STRING_PARTIALS, {
        unison: 3,
        detuneCents: 9,
        filter: {
          cutoffHz: 2400,
          resonance: 0.8,
          envAmount: 1.4,
          attack: 0.5,
          decay: 1.2,
          sustain: 0.65,
          release: 0.4,
        },
        drive: 0.05,
      }),
      keys: STUDIO_KEYS,
      default: STUDIO_KEYS,
    },
  },
  lofi: {
    post: [
      { type: 'tape', speed: 0.96 },
      { type: 'lowpass', cutoffHz: 5200 },
      { type: 'saturate', drive: 0.3, mix: 0.5 },
      { type: 'compress', thresholdDb: -20, ratio: 2, attack: 0.015, release: 0.18, makeupDb: 1 },
      { type: 'limiter', ceilingDb: -1, release: 0.12 },
    ],
    instruments: {
      bass: additive([1, 0.6, 0.35, 0.2], {
        detuneCents: 3,
        filter: {
          cutoffHz: 320,
          resonance: 1.1,
          envAmount: 1.2,
          attack: 0.004,
          decay: 0.25,
          sustain: 0.2,
          release: 0.12,
        },
        drive: 0.18,
      }),
      lead: additive([1, 0.4, 0.2, 0.1], {
        unison: 2,
        detuneCents: 8,
        filter: {
          cutoffHz: 2600,
          resonance: 0.9,
          envAmount: 0.8,
          attack: 0.01,
          decay: 0.3,
          sustain: 0.4,
          release: 0.2,
        },
        drive: 0.25,
      }),
      pad: additive([1, 0.5, 0.3, 0.2, 0.12, 0.08], {
        unison: 2,
        detuneCents: 12,
        filter: {
          cutoffHz: 1200,
          resonance: 0.8,
          envAmount: 0.6,
          attack: 0.3,
          decay: 0.8,
          sustain: 0.6,
          release: 0.35,
        },
        drive: 0.15,
      }),
      default: additive([1, 0.35, 0.18, 0.09, 0.05], {
        filter: {
          cutoffHz: 3000,
          resonance: 0.8,
          envAmount: 0.6,
          attack: 0.006,
          decay: 0.3,
          sustain: 0.35,
          release: 0.2,
        },
        drive: 0.2,
      }),
    },
  },
};

export function isStyleName(value: string): value is StyleName {
  return Object.hasOwn(STYLES, value);
}
