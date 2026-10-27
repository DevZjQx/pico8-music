import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { excerptOf, parseScore, type SampleFileSpec, type Score, type ScoreExcerpt } from '../features/score/feature.ts';
import {
  MAX_SAFE_LUFS,
  PRESETS,
  analyseAudio,
  compareAnalyses,
  createDitherState,
  decodeWav,
  encodeWavFrames,
  encodeWavHeader,
  formatAssertionCheck,
  formatComparison,
  formatProbe,
  formatReport,
  probeTrack,
  renderLoop,
  resolveAssertions,
  resolveSectionBounds,
  type Analysis,
  type PostStep,
  type PresetName,
  type ProbeReading,
  type Quality,
  type RenderOutput,
  type SampleBank,
  type SampleBankEntry,
  type SampleSource,
  type SampleZone,
  type StyleName,
  type TargetInput,
} from '../features/render/feature.ts';

export interface RenderArgs {
  /** Inline score JSON. Mutually exclusive with `scoreFile`. */
  readonly score?: string;
  /** Workspace-relative path to a JSON score file. Mutually exclusive with `score`. */
  readonly scoreFile?: string;
  readonly preset?: string;
  /** Style defaults for the post chain; cannot be combined with `preset`. */
  readonly style?: string;
  /** `pico` (default) or `clean`; a style may choose its own default. */
  readonly quality?: string;
  /** Master side gain, 0-2; omitted leaves the image untouched. */
  readonly width?: number;
  /** Fold sub-bass to mono below this frequency; omitted means no fold. */
  readonly monoBelowHz?: number;
  /** Target profile name or inline ranges; validated by the render feature. */
  readonly target?: unknown;
  /** Optional hard ranges; a miss aborts the call before the WAV is written. */
  readonly assert?: unknown;
  /** Explicit post chain; `[]` renders dry. Omit to use the style or preset chain. */
  readonly post?: readonly PostStep[];
  readonly speed?: number;
  readonly wet?: number;
  readonly toneHz?: number;
  readonly minutes?: number;
  /** Section names to render as a contiguous excerpt; song mode only. */
  readonly sections?: readonly string[];
  /** Track names or roles to keep audible; absent keeps every track. */
  readonly solo?: readonly string[];
  /** Track names or roles to silence; applied after solo. */
  readonly mute?: readonly string[];
  readonly out?: string;
  /** `summary` (default) or `raw`: write the complete render report beside the WAV. */
  readonly detail?: string;
  /** Compare this render with the previous cached render and return a delta table. */
  readonly compare?: boolean;
}

export interface ProbeArgs {
  /** Inline score JSON. Mutually exclusive with `scoreFile`. */
  readonly score?: string;
  /** Workspace-relative path to a JSON score file. Mutually exclusive with `score`. */
  readonly scoreFile?: string;
  /** Melodic track name; omitted uses the first non-drum track. */
  readonly track?: string;
  /** Fixed note name, default A4. */
  readonly note?: string;
  /** Fixed velocity 0-7, default 5. */
  readonly volume?: number;
  /** Gate length in seconds, 0.25-4, default 1.5. */
  readonly seconds?: number;
  readonly quality?: string;
  /** Style role defaults, matching the p8_music render; explicit track.instrument wins. */
  readonly style?: string;
  /** Remove the instrument filter to measure the source alone. */
  readonly bypassFilter?: boolean;
  /** Render parameter variants and report measured deltas; default true. */
  readonly sensitivity?: boolean;
  /** `summary` (default) or `raw`: write the full probe reading to a `.json` artifact. */
  readonly detail?: string;
  /** Workspace-relative `.json` artifact path for `detail: raw`. */
  readonly out?: string;
}

export interface AnalyzeArgs {
  readonly path: string;
  /**
   * `summary` (default), `raw`, or `compare`. Compare needs `against` and returns
   * a delta table instead of a second summary.
   */
  readonly detail?: string;
  /** Workspace-relative WAV to compare against; required for `detail: compare`. */
  readonly against?: string;
  /** Optional target profile name or inline ranges; validated by the render feature. */
  readonly target?: unknown;
  /** Optional hard ranges; a miss aborts the call after measurement. */
  readonly assert?: unknown;
  /** Section boundaries in output-file seconds, for a WAV with no score metadata. */
  readonly sections?: unknown;
  /** Musical content length; excludes a render tail from section mapping. */
  readonly contentSeconds?: number;
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

/** Workspace-local slot for the previous render's analysis. */
const COMPARE_CACHE = '.p8-compare.json';

interface CompareCache {
  readonly path?: string;
  readonly analysis: Analysis;
}

function isAnalysis(value: unknown): value is Analysis {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { seconds?: unknown }).seconds === 'number' &&
    typeof (value as { lufs?: unknown }).lufs === 'number'
  );
}

async function readCompareCache(path: string): Promise<CompareCache | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    // The artifact replacer writes non-finite measurements as null. A silent
    // render's LUFS is -Infinity, so restore that before comparing facts.
    const parsed: unknown = JSON.parse(text, (_key, value) => (value === null ? -Infinity : value));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as { path?: unknown; analysis?: unknown };
    if (!isAnalysis(record.analysis)) return undefined;
    return {
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      analysis: record.analysis,
    };
  } catch {
    return undefined;
  }
}

/** Labels with a fixed extension; `path` is left to the caller's format check. */
const PATH_EXTENSIONS = {
  out: '.wav',
  scoreFile: '.json',
  sample: '.wav',
  probe: '.json',
} as const;
type PathLabel = 'out' | 'path' | 'scoreFile' | 'sample' | 'probe';

/** One sample asset cap; a huge file is a budget error, not a silent memory spike. */
const MAX_SAMPLE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SAMPLE_SECONDS = 30;
const DECODED_SAMPLE_CACHE_ENTRIES = 32;

interface DecodedSample {
  readonly key: string;
  readonly audio: Float32Array;
  readonly rate: number;
}

/**
 * Decoded PCM is process-local state, revalidated by path + size + mtime. It
 * makes repeated renders that share a sample bank cheap without pretending the
 * cache is durable: the WAV files and the score remain the persisted material.
 */
const decodedSampleCache = new Map<string, DecodedSample>();

/**
 * The manifest grants workspace-scoped read/write, so the service enforces the
 * same boundary even on hosts that do not check the manifest themselves. Each
 * output kind has a fixed extension: a RIFF payload in a `.mp3` file, or XML in
 * a `.wav` file, helps nobody.
 */
function workspacePath(
  requested: string,
  label: PathLabel,
  cwd: string,
  field: string = label,
): string {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error(`${field} must be a non-empty path`);
  }
  if (requested.includes('\0')) throw new Error(`${field} contains a NUL byte`);
  const root = resolve(cwd);
  const extension = extname(requested);
  const requiredExtension = label === 'path' ? undefined : PATH_EXTENSIONS[label];
  if (
    requiredExtension !== undefined &&
    extension !== '' &&
    extension.toLowerCase() !== requiredExtension
  ) {
    throw new Error(`${field} must end in ${requiredExtension}, got ${JSON.stringify(requested)}`);
  }
  const candidate = resolve(
    root,
    extension === '' && requiredExtension !== undefined ? `${requested}${requiredExtension}` : requested,
  );
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${field} must stay inside the workspace (${root}), got ${candidate}`);
  }
  return candidate;
}

async function decodeSampleAsset(path: string): Promise<DecodedSample> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot stat ${path}: ${reason}`);
  }
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_SAMPLE_FILE_BYTES) {
    throw new Error(
      `${path} is ${(info.size / (1024 * 1024)).toFixed(1)} MB; samples are limited to ${MAX_SAMPLE_FILE_BYTES / (1024 * 1024)} MB`,
    );
  }

  const key = `${path}\0${info.size}\0${info.mtimeMs}`;
  const cached = decodedSampleCache.get(key);
  if (cached !== undefined) return cached;

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${path}: ${reason}`);
  }

  const decoded = decodeWav(bytes);
  if (!Number.isFinite(decoded.rate) || decoded.rate < 8000 || decoded.rate > 192000) {
    throw new Error(`unsupported sample rate ${decoded.rate} Hz; use 8000-192000 Hz`);
  }
  const frames = Math.min(decoded.left.length, decoded.right.length);
  if (frames / decoded.rate > MAX_SAMPLE_SECONDS) {
    throw new Error(
      `${path} is ${(frames / decoded.rate).toFixed(1)} s long; samples are limited to ${MAX_SAMPLE_SECONDS} s`,
    );
  }

  const audio = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    audio[i] = ((decoded.left[i] ?? 0) + (decoded.right[i] ?? 0)) * 0.5;
  }

  const asset: DecodedSample = { key, audio, rate: decoded.rate };
  decodedSampleCache.set(key, asset);
  while (decodedSampleCache.size > DECODED_SAMPLE_CACHE_ENTRIES) {
    const oldest = decodedSampleCache.keys().next().value;
    if (oldest === undefined) break;
    decodedSampleCache.delete(oldest);
  }
  return asset;
}

/** Reads every declared sample before rendering; unused declarations are still validated. */
async function loadSampleBank(score: Score, cwd: string): Promise<SampleBank> {
  // Plain file entries first: a zone set only references them, never the reverse.
  const sources = new Map<string, SampleSource>();
  for (const [name, spec] of score.samples) {
    if (spec.kind !== 'file') continue;
    const path = workspacePath(spec.file, 'sample', cwd);
    try {
      const asset = await decodeSampleAsset(path);
      sources.set(name, sourceOf(name, spec, asset));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`sample ${JSON.stringify(name)} (${spec.file}): ${reason}`);
    }
  }

  const bank = new Map<string, SampleBankEntry>();
  for (const [name, spec] of score.samples) {
    if (spec.kind === 'file') {
      const source = sources.get(name);
      if (source !== undefined) bank.set(name, source);
      continue;
    }
    const zones: SampleZone[] = [];
    for (const zone of spec.zones) {
      const source = sources.get(zone.sample);
      if (source === undefined) {
        throw new Error(
          `sample ${JSON.stringify(name)}: zone references unloaded sample ${JSON.stringify(zone.sample)}`,
        );
      }
      zones.push({
        source,
        loMidi: zone.loMidi,
        hiMidi: zone.hiMidi,
        loVelocity: zone.loVelocity,
        hiVelocity: zone.hiVelocity,
      });
    }
    bank.set(name, { name, zones });
  }
  return bank;
}

interface SampleSlice {
  readonly audio: Float32Array;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly fadeIn: number;
}

/**
 * Cuts the selected region out of the decoded file and maps loop points into
 * it. Region offsets are seconds in forward time; a reversed source reverses
 * the audio and mirrors the loop window so the score still describes musical
 * positions, not buffer positions.
 */
function sliceOf(spec: SampleFileSpec, asset: DecodedSample): SampleSlice {
  const rate = asset.rate;
  const totalFrames = asset.audio.length;
  const duration = totalFrames / rate;
  const startSeconds = spec.startSeconds ?? 0;
  if (startSeconds >= duration) {
    throw new Error(
      `start ${startSeconds.toFixed(2)}s is past the end of the file (${duration.toFixed(2)}s)`,
    );
  }
  const startFrame = Math.min(totalFrames - 1, Math.max(0, Math.round(startSeconds * rate)));
  const endFrame = Math.min(
    totalFrames,
    Math.max(
      startFrame + 1,
      Math.round((spec.endSeconds ?? duration) * rate),
    ),
  );
  const regionFrames = endFrame - startFrame;
  const forward = asset.audio.subarray(startFrame, endFrame);
  const reversed = spec.reverse === true;
  // `Float32Array.from` copies, so reversing never mutates the cached decode.
  const audio = reversed ? Float32Array.from(forward).reverse() : forward;

  const clampFrame = (frame: number): number => Math.max(0, Math.min(regionFrames, frame));
  const forwardStart = clampFrame(
    Math.round((spec.loopStartSeconds ?? startSeconds) * rate) - startFrame,
  );
  const forwardEnd = clampFrame(
    Math.round((spec.loopEndSeconds ?? spec.endSeconds ?? duration) * rate) - startFrame,
  );
  if (spec.loop && forwardEnd <= forwardStart) {
    throw new Error(
      `loop region is empty after slicing; loopStart ${((spec.loopStartSeconds ?? startSeconds)).toFixed(2)}s must be before loopEnd ${((spec.loopEndSeconds ?? spec.endSeconds ?? duration)).toFixed(2)}s`,
    );
  }
  const loopStart = reversed ? regionFrames - forwardEnd : forwardStart;
  const loopEnd = reversed ? regionFrames - forwardStart : forwardEnd;

  // A mid-file start (or a reversed region, which begins at the file's end)
  // usually begins on a non-zero sample. 2 ms removes that click; an unedited
  // source keeps fade 0 so its render stays sample-identical.
  const fadeIn = startFrame > 0 || reversed ? 0.002 : 0;
  return { audio, loopStart, loopEnd, fadeIn };
}

function sourceOf(name: string, spec: SampleFileSpec, asset: DecodedSample): SampleSource {
  const slice = sliceOf(spec, asset);
  return {
    name,
    audio: slice.audio,
    rate: asset.rate,
    rootMidi: spec.rootMidi,
    loop: spec.loop,
    gain: spec.gain,
    loopStart: slice.loopStart,
    loopEnd: slice.loopEnd,
    ...(slice.fadeIn > 0 ? { fadeIn: slice.fadeIn } : {}),
  };
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be true or false`);
  return value;
}

function presetOf(value: string | undefined): PresetName | undefined {
  if (value === undefined) return undefined;
  if (!Object.hasOwn(PRESETS, value)) {
    throw new Error(`unknown preset ${JSON.stringify(value)}; use classic, dreamy, or tape`);
  }
  return value as PresetName;
}

const STYLE_NAMES: readonly StyleName[] = ['chip', 'hitech', 'ambient', 'studio', 'lofi', 'soft'];

function styleOf(value: string | undefined): StyleName | undefined {
  if (value === undefined) return undefined;
  const match = STYLE_NAMES.find((name) => name === value);
  if (match === undefined) {
    throw new Error(`unknown style ${JSON.stringify(value)}; use ${STYLE_NAMES.join(', ')}`);
  }
  return match;
}

/** The feature's `resolveTarget` is the authority; the app only forwards. */
function targetOf(value: unknown): TargetInput | undefined {
  return value === undefined ? undefined : (value as TargetInput);
}

/**
 * A failed assertion is a tool error, not a warning. Both tools call this at
 * the same point so a CI script sees one message shape whether it rendered a
 * new file or re-measured an old one.
 */
function assertionFailure(report: Analysis): void {
  const reading = report.assertions;
  if (reading === undefined) return;
  const failures = reading.checks.filter((check) => !check.ok);
  if (failures.length === 0) return;
  throw new Error(
    `assert failed (${reading.passed}/${reading.total} checks passed): ${failures
      .map(formatAssertionCheck)
      .join('; ')}`,
  );
}

function qualityOf(value: string | undefined): Quality | undefined {
  if (value === undefined) return undefined;
  if (value !== 'pico' && value !== 'clean') {
    throw new Error(`unknown quality ${JSON.stringify(value)}; use pico or clean`);
  }
  return value;
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
    // One dither state for the whole file: chunk boundaries must not restart
    // the noise sequence, or it would repeat every 16384 frames.
    const dither = createDitherState();
    for (let repeat = 0; repeat < output.repeats; repeat += 1) {
      for (let start = 0; start < output.left.length; start += WRITE_CHUNK_FRAMES) {
        if (signal?.aborted) throw new Error('render aborted');
        const frames = Math.min(WRITE_CHUNK_FRAMES, output.left.length - start);
        const chunk = encodeWavFrames(output.left, output.right, start, frames, dither);
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
async function scoreJsonOf(
  args: { readonly score?: string; readonly scoreFile?: string },
  cwd: string,
): Promise<string> {
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

/**
 * Resolve a solo/mute list against track names first and roles second, matching
 * how section `mute` already resolves targets. A role can name several tracks;
 * the renderer receives the resolved names so it never has to re-resolve roles.
 */
function resolveTrackSet(
  score: Score,
  values: readonly string[] | undefined,
  field: 'solo' | 'mute',
): ReadonlySet<string> | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error(`${field} must be an array of track names or roles`);
  const names = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`${field} entries must be non-empty track names or roles`);
    }
    const value = raw.trim();
    const byName = score.tracks.filter((track) => track.name === value);
    const matches =
      byName.length > 0
        ? byName
        : score.tracks.filter((track) => track.role.toLowerCase() === value.toLowerCase());
    if (matches.length === 0) {
      const tracks = score.tracks.map((track) => track.name).join(', ');
      const roles = [...new Set(score.tracks.map((track) => track.role))].join(', ');
      throw new Error(
        `${field}: unknown track or role ${JSON.stringify(value)}; tracks: ${tracks}; roles: ${roles}`,
      );
    }
    for (const track of matches) names.add(track.name);
  }
  return names;
}

function isAudibleTrack(
  trackName: string,
  solo: ReadonlySet<string> | undefined,
  mute: ReadonlySet<string> | undefined,
): boolean {
  return (
    (solo === undefined || solo.size === 0 || solo.has(trackName)) &&
    (mute === undefined || !mute.has(trackName))
  );
}

/** Turn a section selection into a derived score and the report header facts. */
function selectExcerpt(score: Score, sections: readonly string[] | undefined): ScoreExcerpt | undefined {
  if (sections === undefined) return undefined;
  return excerptOf(score, sections);
}

/** Shared by both host adapters: validate, render, write, summarise, report. */
export async function executeRender(args: RenderArgs, exec: ToolExecution = {}): Promise<string> {
  if (exec.signal?.aborted) throw new Error('render aborted');
  const detail = args.detail ?? 'summary';
  if (detail !== 'summary' && detail !== 'raw') {
    throw new Error('detail must be summary or raw');
  }
  if (args.compare !== undefined && typeof args.compare !== 'boolean') {
    throw new Error('compare must be true or false');
  }

  const cwd = workspaceDirectory(exec);
  const parsed = parseScore(await scoreJsonOf(args, cwd));
  const excerpt = selectExcerpt(parsed, args.sections);
  let score = excerpt?.score ?? parsed;
  const solo = resolveTrackSet(score, args.solo, 'solo');
  const mute = resolveTrackSet(score, args.mute, 'mute');
  const audibleCount = score.tracks.filter((track) =>
    isAudibleTrack(track.name, solo, mute),
  ).length;
  if (audibleCount === 0) {
    throw new Error('solo/mute leaves no audible tracks; nothing to render');
  }
  const auditionNotes: string[] = [];
  let excerptHeader: string | undefined;
  if (excerpt !== undefined) {
    const stepsPerBar = Math.max(1, score.stepsPerBeat * score.beatsPerBar);
    const firstBar = Math.floor(excerpt.startStep / stepsPerBar) + 1;
    const lastBar = Math.ceil(excerpt.endStep / stepsPerBar);
    excerptHeader = `excerpt ${excerpt.label} · bars ${firstBar}-${lastBar} · ${score.bars} bars, ${score.durationSeconds.toFixed(1)} s of music`;
    auditionNotes.push(
      `excerpt: ${excerpt.label} (bars ${firstBar}-${lastBar}); the report describes only this excerpt, not the whole song`,
    );
  }
  if (solo !== undefined) {
    auditionNotes.push(
      `solo: ${[...solo].join(', ')} (${audibleCount}/${score.tracks.length} tracks audible); levels are an audition, not a mix judgement`,
    );
  }
  if (mute !== undefined) {
    auditionNotes.push(
      `mute: ${[...mute].join(', ')} (${audibleCount}/${score.tracks.length} tracks audible); levels are an audition, not a mix judgement`,
    );
  }
  if (auditionNotes.length > 0) {
    score = { ...score, warnings: [...score.warnings, ...auditionNotes] };
  }
  const sampleBank = await loadSampleBank(score, cwd);
  const preset = presetOf(args.preset);
  const style = styleOf(args.style);
  const quality = qualityOf(args.quality);
  const target = targetOf(args.target);
  const assertions = resolveAssertions(args.assert);
  const outputPath = workspacePath(args.out ?? 'pico8-music.wav', 'out', cwd);
  const output = renderLoop(score, {
    preset,
    style,
    ...(quality === undefined ? {} : { quality }),
    post: args.post,
    speed: optionalNumber(args.speed, 'speed'),
    wet: optionalNumber(args.wet, 'wet'),
    toneHz: optionalNumber(args.toneHz, 'toneHz'),
    width: optionalNumber(args.width, 'width'),
    monoBelowHz: optionalNumber(args.monoBelowHz, 'monoBelowHz'),
    ...(target === undefined ? {} : { target }),
    ...(assertions === undefined ? {} : { assertions }),
    minutes: optionalNumber(args.minutes, 'minutes'),
    ...(solo === undefined ? {} : { solo }),
    ...(mute === undefined ? {} : { mute }),
    signal: exec.signal,
    samples: sampleBank,
    withWav: false,
  });

  if (exec.signal?.aborted) throw new Error('render aborted');
  // Safety gate, not a mix opinion: the file is refused rather than written
  // when the finished mix sits above the hearing-safety ceiling. Analysis of an
  // existing WAV only warns, because measuring cannot make it quieter.
  if (Number.isFinite(output.report.lufs) && output.report.lufs > MAX_SAFE_LUFS) {
    throw new Error(
      `rendered mix is ${output.report.lufs.toFixed(1)} LUFS, above the ${MAX_SAFE_LUFS} LUFS hearing-safety ceiling; lower track volumes or add a loudness step around -14..-16 LUFS`,
    );
  }
  // Assertions run before the write: a failed CI render should not leave a
  // misleading artifact behind. `p8_analyze` does the same after measuring.
  assertionFailure(output.report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeWaveFile(outputPath, output, exec.signal);

  const compareLines: string[] = [];
  if (args.compare === true) {
    const cachePath = workspacePath(COMPARE_CACHE, 'scoreFile', cwd);
    const previous = await readCompareCache(cachePath);
    compareLines.push(
      ...(previous === undefined
        ? ['compare: no previous render cached; this render is now the baseline']
        : formatComparison(compareAnalyses(previous.analysis, output.report)).split('\n')),
    );
    await writeFile(
      cachePath,
      JSON.stringify(
        { path: outputPath, analysis: output.report },
        (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value),
        2,
      ),
      'utf8',
    );
  }

  const repeats = output.repeats;
  const chain = chainLabel(args, style, preset);
  const sectionBpms = [...new Set(score.sections.map((section) => section.bpm))];
  const tempo =
    sectionBpms.length === 0 || (sectionBpms.length === 1 && sectionBpms[0] === score.bpm)
      ? `${score.bpm} bpm`
      : `${score.bpm} bpm base, sections ${sectionBpms.join('/')}`;
  const soloHeader =
    solo === undefined ? undefined : `solo ${[...solo].join(', ')} · ${audibleCount}/${score.tracks.length} tracks audible`;
  const muteHeader =
    mute === undefined ? undefined : `mute ${[...mute].join(', ')} · ${audibleCount}/${score.tracks.length} tracks audible`;
  const lines = [
    `Rendered ${outputPath}`,
    `duration ${output.durationSeconds.toFixed(1)} s · loop ${output.loopSeconds.toFixed(2)} s × ${repeats} · ${output.rate} Hz stereo`,
    `mode ${score.mode} · ${chain.mode} · speed ${output.speed.toFixed(2)} · score ${tempo}, ${score.bars} bars, ${score.tracks.length} tracks`,
    ...(excerptHeader === undefined ? [] : [excerptHeader]),
    ...(soloHeader === undefined ? [] : [soloHeader]),
    ...(muteHeader === undefined ? [] : [muteHeader]),
    ...(score.samples.size === 0
      ? []
      : [`samples ${score.samples.size} · ${[...score.samples.keys()].join(', ')}`]),
    `post ${chain.post}`,
    formatReport(output.report),
    ...compareLines,
  ];
  if (detail === 'raw') {
    // Render-time data (stems, dry) cannot be reconstructed from a WAV, so the
    // complete report is persisted here rather than in the tool result.
    const rawPath = /\.wav$/i.test(outputPath)
      ? outputPath.replace(/\.wav$/i, '.analysis.json')
      : `${outputPath}.analysis.json`;
    await writeFile(
      rawPath,
      JSON.stringify(
        {
          path: outputPath,
          rate: output.rate,
          analysis: output.report,
          ...(excerpt === undefined
            ? {}
            : {
                excerpt: {
                  label: excerpt.label,
                  startStep: excerpt.startStep,
                  endStep: excerpt.endStep,
                  startSeconds: excerpt.startSeconds,
                  endSeconds: excerpt.endSeconds,
                },
              }),
          ...(solo === undefined && mute === undefined
            ? {}
            : {
                audition: {
                  ...(solo === undefined ? {} : { solo: [...solo] }),
                  ...(mute === undefined ? {} : { mute: [...mute] }),
                  audibleTracks: audibleCount,
                  totalTracks: score.tracks.length,
                },
              }),
        },
        (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value),
        2,
      ),
      'utf8',
    );
    lines.push(`raw analysis ${rawPath}`);
  }
  return lines.join('\n');
}

/** Analyses an existing WAV so the model can re-check a render without redoing it. */
export async function executeAnalyze(args: AnalyzeArgs, exec: ToolExecution = {}): Promise<string> {
  if (exec.signal?.aborted) throw new Error('analyze aborted');
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    throw new Error('path must point at a 16-bit PCM WAV file');
  }
  const detail = args.detail ?? 'summary';
  if (detail !== 'summary' && detail !== 'raw' && detail !== 'compare') {
    throw new Error('detail must be summary or raw, or compare');
  }
  if (detail === 'compare' && (typeof args.against !== 'string' || args.against.trim() === '')) {
    throw new Error('detail: compare requires against: a workspace-relative WAV path');
  }
  if (detail !== 'compare' && args.against !== undefined) {
    throw new Error('against is only used with detail: compare');
  }

  const cwd = workspaceDirectory(exec);
  const inputPath = workspacePath(args.path, 'path', cwd);
  const bytes = await readFile(inputPath);
  const decoded = decodeWav(bytes);
  const target = targetOf(args.target);
  const fileSeconds = Math.min(decoded.left.length, decoded.right.length) / decoded.rate;
  const contentSeconds = optionalNumber(args.contentSeconds, 'contentSeconds');
  if (
    contentSeconds !== undefined &&
    (contentSeconds <= 0 || contentSeconds > fileSeconds + 1e-6)
  ) {
    throw new Error(
      `contentSeconds must be between 0 and the file duration ${fileSeconds.toFixed(2)}`,
    );
  }
  const sectionBounds = resolveSectionBounds(args.sections, contentSeconds ?? fileSeconds);
  const assertions = resolveAssertions(args.assert);
  const analysis = analyseAudio(decoded.left, decoded.right, decoded.rate, {
    ...(target === undefined ? {} : { target }),
    ...(sectionBounds.length === 0 ? {} : { sectionBounds }),
    ...(contentSeconds === undefined ? {} : { contentSeconds }),
    ...(assertions === undefined ? {} : { assertions }),
  });
  assertionFailure(analysis);
  if (detail === 'compare') {
    const againstPath = workspacePath(args.against ?? '', 'path', cwd);
    const againstBytes = await readFile(againstPath);
    const againstDecoded = decodeWav(againstBytes);
    const againstAnalysis = analyseAudio(
      againstDecoded.left,
      againstDecoded.right,
      againstDecoded.rate,
    );
    const lines = [
      `Compared ${inputPath} against ${againstPath}`,
      `duration ${againstAnalysis.seconds.toFixed(1)} s -> ${analysis.seconds.toFixed(1)} s · ${againstDecoded.rate} Hz vs ${decoded.rate} Hz`,
      formatComparison(compareAnalyses(againstAnalysis, analysis)),
    ];
    return lines.join('\n');
  }
  const lines = [
    `Analyzed ${inputPath}`,
    `duration ${analysis.seconds.toFixed(1)} s · ${decoded.rate} Hz ${decoded.channels === 1 ? 'mono' : 'stereo'}`,
    formatReport(analysis),
  ];
  if (detail === 'raw') {
    // The artifact keeps the complete report out of the model's context until
    // it actually needs a field; `summary` stays the default for every call.
    // Append rather than replace: a render already owns `<out>.analysis.json`,
    // so the WAV-only report must not overwrite the richer render artifact.
    const rawPath = `${inputPath}.analysis.json`;
    await writeFile(
      rawPath,
      JSON.stringify(
        { path: inputPath, rate: decoded.rate, channels: decoded.channels, analysis },
        (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value),
        2,
      ),
      'utf8',
    );
    lines.push(`raw analysis ${rawPath}`);
  }
  return lines.join('\n');
}


/**
 * Measures one instrument as a controlled source: one note, fixed velocity,
 * dry, no track EQ/delay/send. This is the feedback path for envelope and FM
 * parameters; the mix report cannot attribute timbre to a single voice.
 */
export async function executeProbe(args: ProbeArgs, exec: ToolExecution = {}): Promise<string> {
  if (exec.signal?.aborted) throw new Error('probe aborted');
  const detail = args.detail ?? 'summary';
  if (detail !== 'summary' && detail !== 'raw') {
    throw new Error('detail must be summary or raw');
  }
  const cwd = workspaceDirectory(exec);
  const score = parseScore(await scoreJsonOf(args, cwd));
  const sampleBank = await loadSampleBank(score, cwd);
  const quality = qualityOf(args.quality);
  const style = styleOf(args.style);
  const bypassFilter = optionalBoolean(args.bypassFilter, 'bypassFilter');
  const sensitivity = optionalBoolean(args.sensitivity, 'sensitivity');
  const reading = probeTrack(score, args.track, {
    ...(args.note === undefined ? {} : { note: args.note }),
    ...(args.volume === undefined ? {} : { volume: optionalNumber(args.volume, 'volume') }),
    ...(args.seconds === undefined ? {} : { seconds: optionalNumber(args.seconds, 'seconds') }),
    ...(quality === undefined ? {} : { quality }),
    ...(style === undefined ? {} : { style }),
    ...(bypassFilter === undefined ? {} : { bypassFilter }),
    ...(sensitivity === undefined ? {} : { sensitivity }),
    samples: sampleBank,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  });
  const source = args.scoreFile === undefined ? 'inline score' : args.scoreFile;
  const lines = [
    `Probed ${reading.track} from ${source} · dry source probe (no post, track EQ, delay, or send)`,
    formatProbe(reading),
  ];
  if (detail === 'raw') {
    const rawPath = workspacePath(args.out ?? 'p8-probe.json', 'probe', cwd);
    await mkdir(dirname(rawPath), { recursive: true });
    const artifact = { source, rate: 44100, reading } satisfies {
      source: string;
      rate: number;
      reading: ProbeReading;
    };
    await writeFile(
      rawPath,
      JSON.stringify(
        artifact,
        (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value),
        2,
      ),
      'utf8',
    );
    lines.push(`raw probe ${rawPath}`);
  }
  return lines.join('\n');
}
