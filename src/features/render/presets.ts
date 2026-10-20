export type PresetName = 'classic' | 'dreamy' | 'tape';

export interface Preset {
  readonly speed: number;
  readonly wet: number;
  readonly room: number;
  readonly damp: number;
  readonly toneHz: number;
}

/**
 * Presets describe the finished sound, not the composition. `speed` < 1 lowers
 * pitch and tempo together, which is the point of the slowed edit.
 */
export const PRESETS: Record<PresetName, Preset> = {
  classic: { speed: 0.85, wet: 0.3, room: 0.82, damp: 0.35, toneHz: 9000 },
  dreamy: { speed: 0.8, wet: 0.45, room: 0.9, damp: 0.5, toneHz: 7000 },
  tape: { speed: 0.9, wet: 0.25, room: 0.7, damp: 0.6, toneHz: 6500 },
};

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(PRESETS, value);
}
