import type { PostStep, StyleName } from './types.ts';

/**
 * Style presets fill the post chain and nothing else: the score, `mode`, and
 * the output format stay untouched. `chip` is the PICO-8-constrained default
 * (no processing at all); `hitech` adds the glue and loudness the dense style
 * needs; `ambient` is the slowed, reverbed variant. Explicit `post` steps or
 * shorthands override the chain, so a style is a starting point, not a switch.
 */
export const STYLES: Record<StyleName, { readonly post: readonly PostStep[] }> = {
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
};

export function isStyleName(value: string): value is StyleName {
  return Object.hasOwn(STYLES, value);
}
