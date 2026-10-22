import type { Score } from '../score/feature.ts';
import { throwIfAborted } from './abort.ts';
import { analyseAudio, sectionEnergies } from './analyze.ts';
import { copyWindow, dcBlock, limitPeak, lowpass, repeat, resample, reverb } from './dsp.ts';
import {
  applyCompressor,
  applyLimiter,
  applyLoudness,
  applySaturation,
  applyTilt,
  gainToDb,
} from './master.ts';
import { PRESETS, isPresetName } from './presets.ts';
import { STYLES, isStyleName } from './styles.ts';
import { renderScore, type SongAudio } from './synth.ts';
import type { PostStep, RenderOptions, RenderOutput, StyleName } from './types.ts';
import { encodeWav } from './wav.ts';

const RATE = 44100;
const RENDER_LOOPS = 3;
/** Hard output ceiling shared with the score parser's 15-minute arrangement budget. */
const MAX_OUTPUT_SECONDS = 15 * 60;
const MAX_OUTPUT_SAMPLES = MAX_OUTPUT_SECONDS * RATE;
/** -1 dBFS: leaves the 16-bit conversion headroom so the WAV never hard-clips. */
const PEAK_CEILING = 0.89;
const DEFAULT_TONE_HZ = 9000;
const DEFAULT_ROOM = 0.82;
const DEFAULT_DAMP = 0.35;
const DEFAULT_WET = 0.3;
const DEFAULT_COMPRESS_THRESHOLD_DB = -18;
const DEFAULT_COMPRESS_RATIO = 2;
const DEFAULT_COMPRESS_ATTACK = 0.01;
const DEFAULT_COMPRESS_RELEASE = 0.15;
const DEFAULT_TARGET_LUFS = -14;
const DEFAULT_CEILING_DB = -1;
const DEFAULT_LIMITER_RELEASE = 0.1;
const SEND_ROOM = 0.86;
const SEND_DAMP = 0.4;
/** The send bus is wet-only, so it needs gain to sit next to the dry mix. */
const SEND_GAIN = 3;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return clamp(value, min, max);
}

function normalisePostStep(value: unknown, index: number): PostStep {
  const path = `post[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object with a type`);
  }

  switch (value.type) {
    case 'tape':
    case 'slow':
      return {
        type: value.type,
        speed: numberField(value.speed, `${path}.speed`, 1, 0.5, 1.5),
      };
    case 'lowpass': {
      const cutoff = value.cutoffHz ?? value.toneHz;
      return {
        type: 'lowpass',
        cutoffHz: numberField(cutoff, `${path}.cutoffHz`, DEFAULT_TONE_HZ, 100, RATE / 2),
      };
    }
    case 'reverb':
      return {
        type: 'reverb',
        wet: numberField(value.wet, `${path}.wet`, DEFAULT_WET, 0, 1),
        room: numberField(value.room, `${path}.room`, DEFAULT_ROOM, 0, 0.98),
        damp: numberField(value.damp, `${path}.damp`, DEFAULT_DAMP, 0, 1),
      };
    case 'tilt':
      return {
        type: 'tilt',
        tiltDb: numberField(value.tiltDb, `${path}.tiltDb`, 0, -12, 12),
      };
    case 'saturate':
      return {
        type: 'saturate',
        drive: numberField(value.drive, `${path}.drive`, 0.3, 0, 1),
        mix: numberField(value.mix, `${path}.mix`, 0.5, 0, 1),
      };
    case 'compress':
      return {
        type: 'compress',
        thresholdDb: numberField(value.thresholdDb, `${path}.thresholdDb`, DEFAULT_COMPRESS_THRESHOLD_DB, -60, 0),
        ratio: numberField(value.ratio, `${path}.ratio`, DEFAULT_COMPRESS_RATIO, 1, 40),
        attack: numberField(value.attack, `${path}.attack`, DEFAULT_COMPRESS_ATTACK, 0.0005, 1),
        release: numberField(value.release, `${path}.release`, DEFAULT_COMPRESS_RELEASE, 0.01, 2),
        makeupDb: numberField(value.makeupDb, `${path}.makeupDb`, 0, -12, 24),
      };
    case 'loudness':
      return {
        type: 'loudness',
        targetLufs: numberField(value.targetLufs, `${path}.targetLufs`, DEFAULT_TARGET_LUFS, -40, -5),
      };
    case 'limiter':
      return {
        type: 'limiter',
        ceilingDb: numberField(value.ceilingDb, `${path}.ceilingDb`, DEFAULT_CEILING_DB, -12, 0),
        release: numberField(value.release, `${path}.release`, DEFAULT_LIMITER_RELEASE, 0.01, 1),
      };
    default:
      throw new Error(
        `${path}.type must be tape, slow, lowpass, reverb, tilt, saturate, compress, loudness, or limiter, got ${JSON.stringify(value.type)}`,
      );
  }
}

function normalisePost(value: unknown): PostStep[] {
  if (!Array.isArray(value)) {
    throw new Error('post must be an array of post steps; use [] for a dry render');
  }
  return value.map((step, index) => normalisePostStep(step, index));
}

function presetPost(preset: (typeof PRESETS)[keyof typeof PRESETS]): PostStep[] {
  return [
    { type: 'tape', speed: preset.speed },
    { type: 'lowpass', cutoffHz: preset.toneHz },
    { type: 'reverb', wet: preset.wet, room: preset.room, damp: preset.damp },
  ];
}

/** Style chains are templates: every render gets its own copy. */
function stylePost(style: StyleName): PostStep[] {
  return STYLES[style].post.map((step) => ({ ...step }));
}

function setTapeSpeed(chain: PostStep[], speed: number): void {
  let found = false;
  chain.forEach((step, index) => {
    if (step.type !== 'tape' && step.type !== 'slow') return;
    chain[index] = { ...step, speed: found ? 1 : speed };
    found = true;
  });
  if (!found) chain.unshift({ type: 'tape', speed });
}

function setLowpassCutoff(chain: PostStep[], cutoffHz: number): void {
  const index = chain.findIndex((step) => step.type === 'lowpass');
  const step = chain[index];
  if (step && step.type === 'lowpass') {
    chain[index] = { ...step, cutoffHz };
  } else {
    chain.push({ type: 'lowpass', cutoffHz });
  }
}

function setReverbWet(
  chain: PostStep[],
  wet: number,
  room: number | undefined,
  damp: number | undefined,
): void {
  const index = chain.findIndex((step) => step.type === 'reverb');
  const step = chain[index];
  if (step && step.type === 'reverb') {
    chain[index] = {
      ...step,
      wet,
      room: room ?? step.room ?? DEFAULT_ROOM,
      damp: damp ?? step.damp ?? DEFAULT_DAMP,
    };
  } else {
    chain.push({
      type: 'reverb',
      wet,
      room: room ?? DEFAULT_ROOM,
      damp: damp ?? DEFAULT_DAMP,
    });
  }
}

function optionNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

/**
 * Resolves the preset/shorthand/`post` inputs into one ordered chain. An
 * explicit `post` (including `[]`) wins over the preset, which is what makes a
 * dry render possible without special-casing `renderLoop`.
 */
function resolvePost(
  options: RenderOptions,
  preset: (typeof PRESETS)[keyof typeof PRESETS],
): PostStep[] {
  const chain =
    options.post !== undefined
      ? normalisePost(options.post)
      : options.style !== undefined
        ? stylePost(options.style)
        : presetPost(preset);
  const speed = optionNumber(options.speed, 'speed');
  const toneHz = optionNumber(options.toneHz, 'toneHz');
  const wet = optionNumber(options.wet, 'wet');
  const room = optionNumber(options.room, 'room');
  const damp = optionNumber(options.damp, 'damp');

  if (speed !== undefined) {
    setTapeSpeed(chain, clamp(speed, 0.5, 1.5));
  }
  if (toneHz !== undefined) {
    setLowpassCutoff(chain, clamp(toneHz, 100, RATE / 2));
  }
  if (wet !== undefined) {
    setReverbWet(
      chain,
      clamp(wet, 0, 1),
      room === undefined ? undefined : clamp(room, 0, 0.98),
      damp === undefined ? undefined : clamp(damp, 0, 1),
    );
  } else if (room !== undefined || damp !== undefined) {
    const index = chain.findIndex((step) => step.type === 'reverb');
    const step = chain[index];
    if (step && step.type === 'reverb') {
      chain[index] = {
        ...step,
        room: clamp(room ?? step.room ?? DEFAULT_ROOM, 0, 0.98),
        damp: clamp(damp ?? step.damp ?? DEFAULT_DAMP, 0, 1),
      };
    }
  }

  return chain;
}

function chainSpeed(chain: readonly PostStep[]): number {
  let speed = 1;
  for (const step of chain) {
    if (step.type === 'tape' || step.type === 'slow') speed *= step.speed ?? 1;
  }
  return speed;
}

/**
 * A song tail ends wherever the requested extra time ends, which can cut a
 * reverb or one-shot mid-cycle. A short linear fade turns that cut into
 * silence without touching scores that do not ask for a tail.
 */
function fadeTail(left: Float32Array, right: Float32Array, seconds: number): void {
  const samples = Math.min(left.length, right.length, Math.max(1, Math.round(seconds * RATE)));
  for (let i = 0; i < samples; i += 1) {
    const gain = 1 - i / samples;
    const index = left.length - samples + i;
    left[index] = (left[index] ?? 0) * gain;
    right[index] = (right[index] ?? 0) * gain;
  }
}

/**
 * Applies the post steps in the order the caller wrote them. Tape/slow and
 * low-pass run on both channels; reverb feeds its send from the mono sum while
 * the dry path stays stereo. The DC block is an internal safety step: it runs
 * just before the first reverb or master step (or at the end when the chain has
 * neither) so the
 * reverb comb bank never sees a constant offset and the limiter sees the final
 * signal rather than a high-pass overshoot of it.
 */
function applyPost(
  sourceLeft: Float32Array,
  sourceRight: Float32Array,
  chain: readonly PostStep[],
  sourceLoopSamples: number,
  signal?: AbortSignal,
): { left: Float32Array; right: Float32Array; loopSamples: number } {
  let left: Float32Array = sourceLeft;
  let right: Float32Array = sourceRight;
  let loopSamples = sourceLoopSamples;
  let dcBlocked = false;

  const ensureDcBlock = (): void => {
    if (dcBlocked) return;
    left = dcBlock(left, 25, RATE);
    right = dcBlock(right, 25, RATE);
    dcBlocked = true;
  };

  for (const step of chain) {
    throwIfAborted(signal);
    switch (step.type) {
      case 'tape':
      case 'slow': {
        const speed = step.speed ?? 1;
        if (speed === 1) break;
        left = resample(left, speed);
        right = resample(right, speed);
        loopSamples = Math.max(1, Math.round(loopSamples / speed));
        break;
      }
      case 'lowpass': {
        const cutoff = step.cutoffHz ?? step.toneHz ?? DEFAULT_TONE_HZ;
        left = lowpass(left, cutoff, RATE);
        right = lowpass(right, cutoff, RATE);
        break;
      }
      case 'reverb': {
        const wet = step.wet ?? DEFAULT_WET;
        // A zero-wet reverb is a bypass: skip the comb bank entirely instead
        // of paying for a reverb that only returns its input.
        if (wet <= 0) break;
        ensureDcBlock();
        const reverbed = reverb(
          { left, right },
          {
            wet,
            room: step.room ?? DEFAULT_ROOM,
            damp: step.damp ?? DEFAULT_DAMP,
          },
          RATE,
        );
        left = reverbed.left;
        right = reverbed.right;
        break;
      }
      case 'tilt': {
        ensureDcBlock();
        applyTilt(left, right, step.tiltDb ?? 0, RATE);
        break;
      }
      case 'saturate': {
        ensureDcBlock();
        applySaturation(left, right, step.drive ?? 0.3, step.mix ?? 0.5);
        break;
      }
      case 'compress': {
        ensureDcBlock();
        applyCompressor(
          left,
          right,
          {
            thresholdDb: step.thresholdDb ?? DEFAULT_COMPRESS_THRESHOLD_DB,
            ratio: step.ratio ?? DEFAULT_COMPRESS_RATIO,
            attackSeconds: step.attack ?? DEFAULT_COMPRESS_ATTACK,
            releaseSeconds: step.release ?? DEFAULT_COMPRESS_RELEASE,
            makeupDb: step.makeupDb ?? 0,
          },
          RATE,
        );
        break;
      }
      case 'loudness': {
        ensureDcBlock();
        applyLoudness(left, right, step.targetLufs ?? DEFAULT_TARGET_LUFS, RATE);
        break;
      }
      case 'limiter': {
        ensureDcBlock();
        applyLimiter(
          left,
          right,
          step.ceilingDb ?? DEFAULT_CEILING_DB,
          step.release ?? DEFAULT_LIMITER_RELEASE,
          RATE,
        );
        break;
      }
    }
  }

  ensureDcBlock();
  return { left, right, loopSamples };
}

/**
 * Renders the per-track send bus through one reverb and adds it to the dry
 * mix. In loop mode the bus is run for three passes and the last pass is kept,
 * matching the steady-state treatment of the post reverb. Song mode gets a
 * single pass, so a send tail stops with the song unless a score-level `tail`
 * extends the rendered buffer.
 */
function addSendReverb(song: SongAudio, passes: number): void {
  const bus = song.sendBus;
  if (!bus) return;
  const input = passes > 1 ? repeat(bus, passes) : bus;
  const wet = reverb(
    { left: input, right: input },
    { wet: 1, room: SEND_ROOM, damp: SEND_DAMP },
    RATE,
  );
  const start = (passes - 1) * song.loopSamples;
  for (let i = 0; i < song.loopSamples; i += 1) {
    song.left[i] = (song.left[i] ?? 0) + (wet.left[start + i] ?? 0) * SEND_GAIN;
    song.right[i] = (song.right[i] ?? 0) + (wet.right[start + i] ?? 0) * SEND_GAIN;
  }
}

/**
 * Composes the full chain: synth -> post (in array order) -> steady-state loop
 * -> repeat. In loop mode with reverb, three passes are rendered and the last
 * one is kept, so the reverb tail of the previous pass is already part of the
 * loop's head; the boundary needs no fold and no crossfade. An empty post chain
 * keeps the dry synth and returns the loop exactly once.
 */
export function renderLoop(score: Score, options: RenderOptions = {}): RenderOutput {
  const presetName = options.preset ?? 'classic';
  if (!isPresetName(presetName)) {
    throw new Error(`unknown preset ${JSON.stringify(presetName)}; use classic, dreamy, or tape`);
  }
  if (options.style !== undefined) {
    if (!isStyleName(options.style)) {
      throw new Error(
        `unknown style ${JSON.stringify(options.style)}; use chip, hitech, ambient, studio, or lofi`,
      );
    }
    if (options.preset !== undefined) {
      throw new Error('style and preset cannot be combined; style already fills the post chain');
    }
  }
  const preset = PRESETS[presetName];
  const chain = resolvePost(options, preset);
  const speed = chainSpeed(chain);
  const hasReverb = chain.some(
    (step) => step.type === 'reverb' && (step.wet ?? DEFAULT_WET) > 0,
  );
  const loops = score.mode === 'song' ? 1 : hasReverb ? RENDER_LOOPS : 1;

  const signal = options.signal;
  const roleInstruments = options.style === undefined ? undefined : STYLES[options.style].instruments;
  throwIfAborted(signal);
  const song = renderScore(score, RATE, signal, roleInstruments, options.samples);
  throwIfAborted(signal);
  if (song.sendBus) addSendReverb(song, score.mode === 'song' ? 1 : RENDER_LOOPS);
  const sourceLeft = loops > 1 ? repeat(song.left, loops) : song.left;
  const sourceRight = loops > 1 ? repeat(song.right, loops) : song.right;
  throwIfAborted(signal);
  const post = applyPost(sourceLeft, sourceRight, chain, song.loopSamples, signal);
  const left = post.left;
  const right = post.right;

  let loopSamples: number;
  let finalLeft: Float32Array;
  let finalRight: Float32Array;

  if (score.mode === 'song') {
    loopSamples = left.length;
    finalLeft = left;
    finalRight = right;
  } else {
    loopSamples = Math.max(1, post.loopSamples);
    // Keep the final pass by measuring from the end. Using 2 * loopSamples
    // would overrun the buffer whenever resampling rounds the loop length down,
    // leaving the last sample(s) zero-padded.
    const start = hasReverb ? Math.max(0, left.length - loopSamples) : 0;
    finalLeft = copyWindow(left, start, loopSamples);
    finalRight = copyWindow(right, start, loopSamples);
  }

  // Reverb can push the sum past full scale. Trim the finished loop with one
  // shared gain instead of clamping samples: attenuation is distortion-free and
  // does not disturb the seam between repeats.
  if (score.mode === 'song' && score.tailSeconds > 0) fadeTail(finalLeft, finalRight, 0.02);
  const safetyGain = limitPeak([finalLeft, finalRight], PEAK_CEILING);
  const contentSamples =
    score.mode === 'song' && score.tailSeconds > 0
      ? Math.round(
          (finalLeft.length * score.durationSeconds) /
            (score.durationSeconds + score.tailSeconds),
        )
      : undefined;
  const sections =
    score.mode === 'song'
      ? sectionEnergies(finalLeft, finalRight, score.sections, score.totalSteps, contentSamples)
      : [];
  const trimmed =
    safetyGain < 0.7
      ? [`trimmed: peak safety net pulled the mix down ${(-gainToDb(safetyGain)).toFixed(1)} dB`]
      : [];
  const report = analyseAudio(finalLeft, finalRight, RATE, {
    sections,
    extraWarnings: [...score.warnings, ...trimmed],
  });

  if (loopSamples > MAX_OUTPUT_SAMPLES) {
    throw new Error(
      `rendered loop is ${(loopSamples / RATE).toFixed(0)} s long; the render budget is ${MAX_OUTPUT_SECONDS} s`,
    );
  }

  const repeats =
    score.mode === 'song'
      ? 1
      : Math.max(
          1,
          Math.round(
            (clamp(optionNumber(options.minutes, 'minutes') ?? 2, 0.05, 15) * 60 * RATE) / loopSamples,
          ),
        );
  const frames = score.mode === 'song' ? finalLeft.length : loopSamples * repeats;
  if (frames > MAX_OUTPUT_SAMPLES) {
    throw new Error(
      `rendered output is ${(frames / RATE).toFixed(0)} s long; the render budget is ${MAX_OUTPUT_SECONDS} s`,
    );
  }

  throwIfAborted(signal);
  let wav: Uint8Array = new Uint8Array(0);
  if (options.withWav !== false) {
    if (score.mode === 'song') {
      wav = encodeWav(finalLeft, finalRight, RATE);
    } else {
      wav = encodeWav(repeat(finalLeft, repeats), repeat(finalRight, repeats), RATE);
    }
  }

  throwIfAborted(signal);
  return {
    wav,
    left: finalLeft,
    right: finalRight,
    repeats,
    frames,
    rate: RATE,
    loopSamples,
    loopSeconds: loopSamples / RATE,
    durationSeconds: frames / RATE,
    speed,
    report,
  };
}
