import type { Analysis } from './analyze.ts';
import type { AssertionProfile } from './assert.ts';
import type { PresetName } from './presets.ts';
import type { SampleBank } from './sample.ts';
import type { TargetInput } from './target.ts';

/** 1 = one-pole 6 dB/oct, 2/4 = Butterworth 12/24 dB/oct. */
export type LowpassOrder = 1 | 2 | 4;

/** One step in the post chain. An empty chain means a dry render. */
export type PostStep =
  | { readonly type: 'tape'; readonly speed?: number }
  | { readonly type: 'slow'; readonly speed?: number }
  | {
      readonly type: 'lowpass';
      readonly cutoffHz?: number;
      readonly toneHz?: number;
      /** Slope; defaults to 1 (6 dB/oct). */
      readonly order?: LowpassOrder;
    }
  | {
      readonly type: 'highpass';
      /** Master high-pass cutoff, 20-500 Hz; removes sub-bass a small speaker cannot play. */
      readonly highpassHz?: number;
    }
  | {
      readonly type: 'highShelf';
      /** Shelf corner in Hz, 20-20000; defaults to 3000. */
      readonly hz?: number;
      /** Shelf gain in dB, -24..24; 0 is a no-op. */
      readonly gainDb?: number;
    }
  | {
      readonly type: 'reverb';
      readonly wet?: number;
      readonly room?: number;
      readonly damp?: number;
      /** Delay the send before it enters the comb bank, 0-200 ms. */
      readonly predelayMs?: number;
      /** High-pass the wet return, 20-1000 Hz. */
      readonly lowCutHz?: number;
      /** Low-pass the wet return, 1000-20000 Hz. */
      readonly highCutHz?: number;
      /** Slow delay modulation depth, 0-1 (about 0-5 ms). */
      readonly modDepth?: number;
      /** Modulation rate in Hz, 0.05-5. */
      readonly modRateHz?: number;
    }
  | { readonly type: 'tilt'; readonly tiltDb?: number }
  | { readonly type: 'saturate'; readonly drive?: number; readonly mix?: number }
  | {
      readonly type: 'compress';
      readonly thresholdDb?: number;
      readonly ratio?: number;
      readonly attack?: number;
      readonly release?: number;
      readonly makeupDb?: number;
    }
  | { readonly type: 'loudness'; readonly targetLufs?: number }
  | { readonly type: 'limiter'; readonly ceilingDb?: number; readonly release?: number };

/**
 * A style fills the post-chain defaults, and for the non-chip styles the
 * role-based instrument defaults; it never changes `mode` or the score.
 * `chip` is the dry PICO-8-constrained default, `hitech` glues and normalises a
 * busy mix, `ambient` is the slowed-and-reverbed variant, `studio`/`lofi`
 * leave the chip palette, and `soft` is the low-order, clean, slow-attack
 * variant.
 */
export type StyleName = 'chip' | 'hitech' | 'ambient' | 'studio' | 'lofi' | 'soft';

/**
 * Oscillator precision. `pico` is the historical direct-form chip render;
 * `clean` band-limits saw and pulse edges and limits the FM sideband index so
 * high notes fold less. It is opt-in because it changes the waveform.
 */
export type Quality = 'pico' | 'clean';

export interface RenderOptions {
  readonly preset?: PresetName;
  /** Style defaults; ignored when `post` is present, invalid together with `preset`. */
  readonly style?: StyleName;
  /** Oscillator precision; defaults to the style's choice, else `pico`. */
  readonly quality?: Quality;
  /**
   * Master side gain: 0 folds to mono, 1 is unchanged, 2 doubles the side
   * signal. Omitted leaves the stereo image untouched.
   */
  readonly width?: number;
  /** Folds everything below this frequency to mono; omitted means no fold. */
  readonly monoBelowHz?: number;
  /** Optional target profile; findings then name deviations without scoring. */
  readonly target?: TargetInput;
  /** Optional hard ranges; direct renderLoop callers inspect the report, tools throw. */
  readonly assertions?: AssertionProfile;
  /** When present, replaces the preset/style chain entirely. `[]` renders dry. */
  readonly post?: readonly PostStep[];
  /** 0.5-1.5; shorthand for a tape/slow step. */
  readonly speed?: number;
  /** 0-1 reverb send; shorthand for a reverb step. */
  readonly wet?: number;
  /** 0-1 reverb room size. */
  readonly room?: number;
  /** 0-1 reverb damping. */
  readonly damp?: number;
  /** Low-pass cutoff; shorthand for a lowpass step. */
  readonly toneHz?: number;
  /** Requested output length in minutes for loop mode. */
  readonly minutes?: number;
  /** Decoded workspace WAVs keyed by the score's `samples` names. */
  readonly samples?: SampleBank;
  /** Cooperative cancellation checked between render stages and inner loops. */
  readonly signal?: AbortSignal;
  /**
   * Set false when the caller will stream `left`/`right` itself. The returned
   * `wav` is then empty, which avoids holding the encoded copy in memory.
   */
  readonly withWav?: boolean;
}

export interface RenderOutput {
  /** Complete WAV unless `withWav: false` was requested. */
  readonly wav: Uint8Array;
  /** One loop pass, or the complete song. */
  readonly left: Float32Array;
  readonly right: Float32Array;
  /** Number of loop passes represented by `frames`; 1 for songs. */
  readonly repeats: number;
  /** Output frames after repeating the loop (or the song length). */
  readonly frames: number;
  readonly rate: number;
  readonly loopSamples: number;
  readonly loopSeconds: number;
  readonly durationSeconds: number;
  readonly speed: number;
  /** Measurements of the finished audio; see docs/evaluation.md. */
  readonly report: Analysis;
}
