import type { Waveform } from '../score/feature.ts';

export interface WaveState {
  phase: number;
  lastAdvance: number;
  lastSample: number;
  seed: number;
}

export function createWaveState(seed: number): WaveState {
  return { phase: 0, lastAdvance: 0, lastSample: 0, seed: seed >>> 0 };
}

function random(state: WaveState): number {
  state.seed = (state.seed * 1664525 + 1013904223) >>> 0;
  return (state.seed / 0x100000000) * 2 - 1;
}

/**
 * PICO-8 timbres 0-7. Formulas follow the Zepto-8 measurements of PICO-8 WAV
 * exports; they are close, not bit-exact.
 */
export function sampleWaveform(waveform: Waveform, state: WaveState, key: number): number {
  const advance = state.phase;
  const t = advance - Math.floor(advance);

  switch (waveform) {
    case 0:
      return (1 - Math.abs(4 * t - 2)) * 0.5;
    case 1: {
      const a = 0.875;
      const tilted = t < a ? (2 * t) / a - 1 : (2 * (1 - t)) / (1 - a) - 1;
      return tilted * 0.5;
    }
    case 2:
      return (t < 0.5 ? t : t - 1) * 0.653;
    case 3:
      return t < 0.5 ? 0.25 : -0.25;
    case 4:
      return t < 0.316 ? 0.25 : -0.25;
    case 5: {
      const organ = t < 0.5 ? 3 - Math.abs(24 * t - 6) : 1 - Math.abs(16 * t - 12);
      return organ / 9;
    }
    case 6: {
      const delta = advance - state.lastAdvance;
      const scale = delta > 0 ? delta * 8.858923 : 0.0001;
      const smoothed = (state.lastSample + scale * random(state)) / (1 + scale);
      state.lastAdvance = advance;
      state.lastSample = smoothed;
      const brightness = 1 - key / 63;
      return smoothed * 1.5 * (1 + brightness * brightness);
    }
    case 7: {
      const triangle = 2 - Math.abs(8 * t - 4);
      const detuned = 1 - Math.abs(4 * (advance * (109 / 110) - Math.floor(advance * (109 / 110))) - 2);
      return (triangle + detuned) / 6;
    }
  }
}
