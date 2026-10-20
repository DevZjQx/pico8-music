import type { ToolDefinition as DshToolDefinition } from '@deepseek-ai/dsh-tools';
import { SCORE_HELP } from '../features/score/feature.ts';
import { analyzeParameters, helpParameters, musicParameters } from './tool-schemas.ts';
import {
  executeAnalyze,
  executeRender,
  type AnalyzeArgs,
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

interface PluginContext {
  readonly tools?: ToolRuntime;
  /** Human slash commands; absent in UI-less hosts, so registration is optional. */
  readonly commands?: CommandRuntime;
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
    tools.register(definition as DshToolDefinition);
  };
  register({
    name: 'p8_help',
    description:
      'Show the PICO-8 score DSL reference: modes, pattern tokens, drums, chords, effects, mix, post chain. The same text as /p8m.',
    parameters: helpParameters,
    output,
    async execute(): Promise<string> {
      return SCORE_HELP;
    },
  });

  register({
    name: 'p8_music',
    description:
      'Compose a PICO-8-flavoured loop or arranged song and render it as a WAV. Call p8_help first for the score DSL.',
    parameters: musicParameters,
    output,
    // Two renders writing the same `out` path must not overlap.
    isConcurrencySafe: () => false,
    async execute(args: RenderArgs, exec: ToolExecution) {
      try {
        return await executeRender(args, exec);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (call p8_help for the score DSL)`);
      }
    },
  });

  register({
    name: 'p8_analyze',
    description:
      'Measure an existing 16-bit PCM WAV: peak, RMS, LUFS, spectrum, width, onsets, and warnings. Use it to re-check a p8_music output.',
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
    description: 'Show the PICO-8 score DSL reference',
    handler: () => ({ kind: 'success', text: SCORE_HELP }),
  });
}

export function apply(ctx: PluginContext): void {
  if (!ctx.tools) {
    ctx.logger?.warn?.('pico8-music: tools runtime unavailable; render tool not registered');
    return;
  }

  registerTools(ctx.tools);

  // `commands` is optional: headless hosts compose no command surface. Declaring it
  // with inject would keep the whole plugin (tools included) from starting there.
  if (ctx.inject) {
    ctx.inject(['commands'], (child) => {
      if (child.commands) registerCommand(child.commands);
    });
  } else if (ctx.commands) {
    registerCommand(ctx.commands);
  }
}
