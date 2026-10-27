import type { ToolDefinition as DshToolDefinition } from '@deepseek-ai/dsh-tools';
import { SCORE_HELP } from '../features/score/feature.ts';
import { readSongwriterSkill } from './skill.ts';
import {
  analyzeParameters,
  dshParameters,
  helpParameters,
  musicParameters,
  probeParameters,
} from './tool-schemas.ts';
import {
  executeAnalyze,
  executeProbe,
  executeRender,
  type AnalyzeArgs,
  type ProbeArgs,
  type RenderArgs,
  type ToolExecution,
} from './render-service.ts';

export const name = 'pico8-music';
export const inject = ['tools'] as const;

interface ToolRuntime {
  register(definition: DshToolDefinition): unknown;
}

interface CommandRuntime {
  /** Mirrors @deepseek-ai/dsh-commands: a run is rendered by the UI and never becomes a model message. */
  register(definition: {
    name: string;
    description: string;
    handler: () => CommandOutcome;
  }): unknown;
}

type CommandOutcome =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string };

/** Mirrors @deepseek-ai/dsh-skill: an in-memory skill contribution. */
interface SkillRuntime {
  register(skill: {
    name: string;
    description: string;
    /** Discovery source; the registry requires it when the skill is loaded. */
    source: string;
    content: string;
    path?: string;
    resourceBase?: { readonly kind: 'directory'; readonly path: string };
  }): unknown;
}

interface PluginContext {
  readonly tools?: ToolRuntime;
  /** Human slash commands; absent in UI-less hosts, so registration is optional. */
  readonly commands?: CommandRuntime;
  /** Skill registry; absent when a composition mounts no skill provider. */
  readonly skills?: SkillRuntime;
  /** Cordis optional dependency: the child fiber waits for the named services. */
  inject?(deps: readonly string[], callback: (child: PluginContext) => void): unknown;
  readonly logger?: {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
}

const output: DshToolDefinition['output'] = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

/** The shared TypeBox schemas serialise to JSON Schema; they are just not index-signature typed. */
type ToolDefinitionInput = Omit<DshToolDefinition, 'parameters'> & { readonly parameters: unknown };

function registerTools(tools: ToolRuntime): void {
  const register = (definition: ToolDefinitionInput): void => {
    tools.register({
      ...definition,
      // TypeBox metadata is non-enumerable and its `anyOf` is outside DSH's schema
      // subset; project once here so both PTC and native schema reads are lossless.
      parameters: dshParameters(definition.parameters),
    } as DshToolDefinition);
  };
  register({
    name: 'p8_help',
    description:
      'Show the PICO-8 score wire-format reference: fields, tokens, drums, chords, mix, post chain, targets and errors. The same text as /p8m; compose with the pico8-songwriter skill.',
    parameters: helpParameters,
    output,
    async execute(): Promise<string> {
      return SCORE_HELP;
    },
  });

  register({
    name: 'p8_music',
    description:
      'Compose a PICO-8-flavoured loop or arranged song and render it as a WAV. The pico8-songwriter skill covers composing; p8_help covers every field and range.',
    parameters: musicParameters,
    output,
    // Two renders writing the same `out` path must not overlap.
    isConcurrencySafe: () => false,
    async execute(args: RenderArgs, exec: ToolExecution) {
      try {
        return await executeRender(args, exec);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (call p8_help for the wire format)`);
      }
    },
  });

  register({
    name: 'p8_probe',
    description:
      'Measure one melodic track as a dry single note: spectral slope, centroid, 85% rolloff, odd/even harmonics, attack/decay, high-frequency decay, FM sidebands, and measured sensitivity to tilt/index/cutoff/attack. Use it to tune envelopes and FM; it renders no WAV and applies no post chain.',
    parameters: probeParameters,
    output,
    isConcurrencySafe: () => false,
    async execute(args: ProbeArgs, exec: ToolExecution) {
      return executeProbe(args, exec);
    },
  });

  register({
    name: 'p8_analyze',
    description:
      'Measure an existing 16-bit PCM WAV: sample and true peak, RMS, LUFS/LRA, spectrum, width, L/R correlation and balance, onsets, findings, and warnings. Optional sections split the file; target ranges report deviations, assert ranges fail the call. detail:raw writes the full analysis to a sibling .analysis.json; detail:compare with against returns a delta table.',
    parameters: analyzeParameters,
    output,
    async execute(args: AnalyzeArgs, exec: ToolExecution) {
      return executeAnalyze(args, exec);
    },
  });
}

function registerCommand(commands: CommandRuntime): void {
  // A DSH command result is rendered by the dispatching UI and stays out of model
  // history by design; the model reads the same text through the p8_help tool.
  commands.register({
    name: 'p8m',
    description: 'Show the PICO-8 score wire-format reference',
    handler: () => ({ kind: 'success', text: SCORE_HELP }),
  });
}

export function apply(ctx: PluginContext): void {
  if (!ctx.tools) {
    ctx.logger?.warn?.('pico8-music: tools runtime unavailable; render tool not registered');
    return;
  }

  registerTools(ctx.tools);

  // `commands` and `skills` are optional: headless hosts compose neither, and
  // declaring them with inject would keep the whole plugin (tools included) from
  // starting there.
  if (ctx.inject) {
    ctx.inject(['commands'], (child) => {
      if (child.commands) registerCommand(child.commands);
    });
    ctx.inject(['skills'], (child) => registerSkill(child.skills, ctx.logger));
  } else {
    if (ctx.commands) registerCommand(ctx.commands);
    registerSkill(ctx.skills, ctx.logger);
  }
}

/**
 * Share the authoring guide with the model. DSH discovers skills from the
 * project, custom and user roots only, so an installed package's SKILL.md would
 * never surface; registering it here is what makes `install the plugin` and
 * `the skill is available` the same statement.
 */
function registerSkill(skills: SkillRuntime | undefined, logger?: PluginContext['logger']): void {
  if (!skills) return;

  const skill = readSongwriterSkill();
  if (!skill) {
    logger?.warn?.(
      'pico8-music: .agents/skills/pico8-songwriter/SKILL.md is missing or unreadable; skill not registered',
    );
    return;
  }

  skills.register({
    name: skill.name,
    description: skill.description,
    // The registry defaults provider and invocation, but not source; without it
    // `skills.get()` rejects the definition as soon as the model loads the skill.
    source: 'runtime',
    content: skill.content,
    path: skill.path,
    resourceBase: { kind: 'directory', path: skill.directory },
  });
}
