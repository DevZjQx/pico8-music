import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { parseScore } from '../features/score/feature.ts';
import {
  PRESETS,
  analyseAudio,
  decodeWav,
  encodeWavFrames,
  encodeWavHeader,
  formatReport,
  renderLoop,
  type PostStep,
  type PresetName,
  type RenderOutput,
  type StyleName,
} from '../features/render/feature.ts';

export interface RenderArgs {
  /** Inline score JSON. Mutually exclusive with `scoreFile`. */
  readonly score?: string;
  /** Workspace-relative path to a JSON score file. Mutually exclusive with `score`. */
  readonly scoreFile?: string;
  readonly preset?: string;
  /** Style defaults for the post chain; cannot be combined with `preset`. */
  readonly style?: string;
  /** Explicit post chain; `[]` renders dry. Omit to use the style or preset chain. */
  readonly post?: readonly PostStep[];
  readonly speed?: number;
  readonly wet?: number;
  readonly toneHz?: number;
  readonly minutes?: number;
  readonly out?: string;
}

export interface AnalyzeArgs {
  readonly path: string;
}

export interface ToolExecution {
  readonly signal?: AbortSignal;
  /** Workspace root supplied by the host; Pi exposes it as `ctx.cwd`. */
  readonly cwd?: string;
  /** DSH hands the calling agent to tool bodies; its session header owns the workspace root. */
  readonly agent?: {
    readonly session?: {
      readonly header?: { readonly cwd?: string };
    };
  };
}

/** Resolve paths against the session workspace, never the host process cwd. */
function workspaceDirectory(exec: ToolExecution): string {
  const cwd = exec.cwd ?? exec.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd();
}

/** Labels with a fixed extension; `path` is left to the caller's format check. */
const PATH_EXTENSIONS = { out: '.wav', scoreFile: '.json' } as const;
type PathLabel = 'out' | 'path' | 'scoreFile';

/**
 * The manifest grants workspace-scoped read/write, so the service enforces the
 * same boundary even on hosts that do not check the manifest themselves. Only
 * `.wav` output and `.json` score files are accepted: a RIFF payload in a
 * `.mp3` file helps nobody.
 */
function workspacePath(requested: string, label: PathLabel, cwd: string): string {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error(`${label} must be a non-empty path`);
  }
  if (requested.includes('\0')) throw new Error(`${label} contains a NUL byte`);
  const root = resolve(cwd);
  const extension = extname(requested);
  const requiredExtension = label === 'path' ? undefined : PATH_EXTENSIONS[label];
  if (
    requiredExtension !== undefined &&
    extension !== '' &&
    extension.toLowerCase() !== requiredExtension
  ) {
    throw new Error(`${label} must end in ${requiredExtension}, got ${JSON.stringify(requested)}`);
  }
  const candidate = resolve(
    root,
    extension === '' && requiredExtension !== undefined ? `${requested}${requiredExtension}` : requested,
  );
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside the workspace (${root}), got ${candidate}`);
  }
  return candidate;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function presetOf(value: string | undefined): PresetName | undefined {
  if (value === undefined) return undefined;
  if (!Object.hasOwn(PRESETS, value)) {
    throw new Error(`unknown preset ${JSON.stringify(value)}; use classic, dreamy, or tape`);
  }
  return value as PresetName;
}

const STYLE_NAMES: readonly StyleName[] = ['chip', 'hitech', 'ambient', 'studio', 'lofi'];

function styleOf(value: string | undefined): StyleName | undefined {
  if (value === undefined) return undefined;
  const match = STYLE_NAMES.find((name) => name === value);
  if (match === undefined) {
    throw new Error(`unknown style ${JSON.stringify(value)}; use ${STYLE_NAMES.join(', ')}`);
  }
  return match;
}

function chainLabel(args: RenderArgs, style: StyleName | undefined, preset: PresetName | undefined): {
  mode: string;
  post: string;
} {
  if (args.post !== undefined) {
    return { mode: 'custom post', post: args.post.length === 0 ? 'dry' : args.post.map((step) => step.type).join(' -> ') };
  }
  if (style !== undefined) return { mode: `style ${style}`, post: 'style chain' };
  return { mode: `preset ${preset ?? 'classic'}`, post: 'preset chain' };
}

const WRITE_CHUNK_FRAMES = 16384;

/**
 * Streams the header and one loop pass at a time. Rendering still keeps the
 * loop (or song) in memory, but a 15-minute loop no longer needs a second,
 * equally large encoded copy.
 */
async function writeWaveFile(
  path: string,
  output: RenderOutput,
  signal: AbortSignal | undefined,
): Promise<void> {
  const file = await open(path, 'w');
  let failed = false;
  try {
    const header = encodeWavHeader(output.frames, output.rate);
    await file.write(header, 0, header.length, null);
    for (let repeat = 0; repeat < output.repeats; repeat += 1) {
      for (let start = 0; start < output.left.length; start += WRITE_CHUNK_FRAMES) {
        if (signal?.aborted) throw new Error('render aborted');
        const frames = Math.min(WRITE_CHUNK_FRAMES, output.left.length - start);
        const chunk = encodeWavFrames(output.left, output.right, start, frames);
        await file.write(chunk, 0, chunk.length, null);
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await file.close().catch(() => undefined);
    if (failed) await rm(path, { force: true }).catch(() => undefined);
  }
}

/** Accept either inline score JSON or a workspace-relative `.json` file, never both. */
async function scoreJsonOf(args: RenderArgs, cwd: string): Promise<string> {
  const inline = typeof args.score === 'string' && args.score.trim() !== '' ? args.score : undefined;
  const file = typeof args.scoreFile === 'string' && args.scoreFile.trim() !== '' ? args.scoreFile : undefined;
  if (inline !== undefined) {
    if (file !== undefined) throw new Error('provide either score or scoreFile, not both');
    return inline;
  }
  if (file === undefined) {
    throw new Error('provide score JSON or a workspace-relative scoreFile path');
  }

  const path = workspacePath(file, 'scoreFile', cwd);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read scoreFile ${path}: ${reason}`);
  }
  // A BOM is legal in files but not in JSON.parse.
  const json = text.replace(/^\uFEFF/, '');
  if (json.trim() === '') throw new Error(`scoreFile ${path} is empty`);
  return json;
}

/** Shared by both host adapters: validate, render, write, summarise, report. */
export async function executeRender(args: RenderArgs, exec: ToolExecution = {}): Promise<string> {
  if (exec.signal?.aborted) throw new Error('render aborted');

  const cwd = workspaceDirectory(exec);
  const score = parseScore(await scoreJsonOf(args, cwd));
  const preset = presetOf(args.preset);
  const style = styleOf(args.style);
  const outputPath = workspacePath(args.out ?? 'pico8-music.wav', 'out', cwd);
  const output = renderLoop(score, {
    preset,
    style,
    post: args.post,
    speed: optionalNumber(args.speed, 'speed'),
    wet: optionalNumber(args.wet, 'wet'),
    toneHz: optionalNumber(args.toneHz, 'toneHz'),
    minutes: optionalNumber(args.minutes, 'minutes'),
    signal: exec.signal,
    withWav: false,
  });

  if (exec.signal?.aborted) throw new Error('render aborted');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeWaveFile(outputPath, output, exec.signal);

  const repeats = output.repeats;
  const chain = chainLabel(args, style, preset);
  return [
    `Rendered ${outputPath}`,
    `duration ${output.durationSeconds.toFixed(1)} s · loop ${output.loopSeconds.toFixed(2)} s × ${repeats} · ${output.rate} Hz stereo`,
    `mode ${score.mode} · ${chain.mode} · speed ${output.speed.toFixed(2)} · score ${score.bpm} bpm, ${score.bars} bars, ${score.tracks.length} tracks`,
    `post ${chain.post}`,
    formatReport(output.report),
  ].join('\n');
}

/** Analyses an existing WAV so the model can re-check a render without redoing it. */
export async function executeAnalyze(args: AnalyzeArgs, exec: ToolExecution = {}): Promise<string> {
  if (exec.signal?.aborted) throw new Error('analyze aborted');
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    throw new Error('path must point at a 16-bit PCM WAV file');
  }

  const inputPath = workspacePath(args.path, 'path', workspaceDirectory(exec));
  const bytes = await readFile(inputPath);
  const decoded = decodeWav(bytes);
  const analysis = analyseAudio(decoded.left, decoded.right, decoded.rate);
  return [
    `Analyzed ${inputPath}`,
    `duration ${analysis.seconds.toFixed(1)} s · ${decoded.rate} Hz stereo`,
    formatReport(analysis),
  ].join('\n');
}
