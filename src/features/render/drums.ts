import type { DrumName } from '../score/feature.ts';

/**
 * Synthetic drum voices. PICO-8 has no sample playback, so each voice is a
 * short transient built from a pitched body plus filtered noise. The shapes are
 * deliberately simple but spectral: kick is sub-heavy, snare is mid/noise,
 * hats and crashes are high-passed noise.
 */

const DURATION: Record<DrumName, number> = {
  kick: 0.32,
  snare: 0.28,
  hat: 0.07,
  openhat: 0.38,
  clap: 0.24,
  tom: 0.3,
  rim: 0.12,
  crash: 1.0,
};

function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0x100000000) * 2 - 1;
  };
}

function highpassCoefficient(cutoffHz: number, rate: number): number {
  return Math.exp((-2 * Math.PI * cutoffHz) / rate);
}

export function renderDrumHit(name: DrumName, rate: number, velocity: number, seed: number): Float32Array {
  const length = Math.max(1, Math.round(DURATION[name] * rate));
  const output = new Float32Array(length);
  const noise = noiseSource(seed);
  const level = Math.max(0, velocity);

  let phase = 0;
  let highpassIn = 0;
  let highpassOut = 0;
  let lowpassA = 0;
  let lowpassB = 0;
  const highpass = (input: number, coefficient: number): number => {
    const value = input - highpassIn + coefficient * highpassOut;
    highpassIn = input;
    highpassOut = value;
    return value;
  };
  const lowpass2 = (input: number, cutoffHz: number): number => {
    const coefficient = 1 - Math.exp((-2 * Math.PI * cutoffHz) / rate);
    lowpassA += coefficient * (input - lowpassA);
    lowpassB += coefficient * (lowpassA - lowpassB);
    return lowpassB;
  };

  const snareHighpass = highpassCoefficient(1200, rate);
  const hatHighpass = highpassCoefficient(7000, rate);
  const clapHighpass = highpassCoefficient(1500, rate);
  const crashHighpass = highpassCoefficient(4000, rate);

  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    let sample = 0;

    switch (name) {
      case 'kick': {
        const frequency = 45 + 105 * Math.exp(-t * 22);
        phase += (2 * Math.PI * frequency) / rate;
        const body = Math.sin(phase) * Math.exp(-t * 7.5);
        const click = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 120) * 0.16;
        sample = body * 0.95 + click;
        break;
      }
      case 'snare': {
        const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 18) * 0.38;
        const overtone = Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t * 28) * 0.14;
        const rattle = lowpass2(highpass(noise(), snareHighpass), 900) * Math.exp(-t * 13) * 0.55;
        sample = body + overtone + rattle;
        break;
      }
      case 'hat': {
        sample = highpass(noise(), hatHighpass) * Math.exp(-t * 90) * 0.5;
        break;
      }
      case 'openhat': {
        sample = highpass(noise(), hatHighpass) * Math.exp(-t * 14) * 0.42;
        break;
      }
      case 'clap': {
        const offsets = [0, 0.009, 0.018] as const;
        let bursts = 0;
        for (const offset of offsets) {
          if (t >= offset) bursts += Math.exp(-(t - offset) * 120);
        }
        sample = lowpass2(highpass(noise(), clapHighpass), 600) * bursts * 4;
        break;
      }
      case 'tom': {
        const frequency = 170 - 75 * Math.min(1, t / 0.16);
        phase += (2 * Math.PI * frequency) / rate;
        sample = Math.sin(phase) * Math.exp(-t * 11) * 0.6;
        break;
      }
      case 'rim': {
        const body = Math.sin(2 * Math.PI * 1750 * t) * Math.exp(-t * 90) * 0.34;
        const click = Math.exp(-t * 200) * 0.2;
        sample = body + click;
        break;
      }
      case 'crash': {
        const noisePart = highpass(noise(), crashHighpass) * Math.exp(-t * 3.2) * 0.34;
        const shimmer = Math.sin(2 * Math.PI * 6100 * t) * Math.exp(-t * 5) * 0.05;
        sample = noisePart + shimmer;
        break;
      }
    }

    output[i] = sample * level;
  }

  // A one-shot that ends at a non-zero sample would click and spray broadband
  // energy into the spectrum. Fade the last few milliseconds to silence.
  const fadeSamples = Math.min(length, Math.max(1, Math.round(0.006 * rate)));
  for (let i = 0; i < fadeSamples; i += 1) {
    output[length - 1 - i] = (output[length - 1 - i] ?? 0) * (i / fadeSamples);
  }

  return output;
}
