import type { Analysis } from './analyze.ts';
import type { PresetName } from './presets.ts';

/** One step in the post chain. An empty chain means a dry render. */
export type PostStep =
  | { readonly type: 'tape'; readonly speed?: number }
  | { readonly type: 'slow'; readonly speed?: number }
  | { readonly type: 'lowpass'; readonly cutoffHz?: number; readonly toneHz?: number }
  | { readonly type: 'reverb'; readonly wet?: number; readonly room?: number; readonly damp?: number }
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
 * A style fills the post-chain defaults; it never changes `mode` or the score.
 * `chip` is the dry PICO-8-constrained default, `hitech` glues and normalises a
 * busy mix, `ambient` is the slowed-and-reverbed variant.
 */
export type StyleName = 'chip' | 'hitech' | 'ambient';

export interface RenderOptions {
  readonly preset?: PresetName;
  /** Style defaults; ignored when `post` is present, invalid together with `preset`. */
  readonly style?: StyleName;
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
