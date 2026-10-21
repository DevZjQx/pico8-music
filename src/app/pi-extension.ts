import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { SCORE_BRIEF, SCORE_HELP } from '../features/score/feature.ts';
import { executeAnalyze, executeRender, type RenderArgs } from './render-service.ts';
import { analyzeParameters, helpParameters, musicParameters } from './tool-schemas.ts';

// Only the surface this extension uses. Picking the real SDK signatures keeps the
// compile-time check below meaningful without requiring the full host in tests.
type PiApi = Pick<ExtensionAPI, 'registerTool' | 'registerCommand'> & {
  sendMessage?: ExtensionAPI['sendMessage'];
};

interface PiToolResult {
  readonly content: [{ readonly type: 'text'; readonly text: string }];
  readonly details: { readonly text: string };
}

/** The execute context is optional for direct/headless calls; only cwd is used. */
type PiToolContext = Pick<ExtensionToolContext, 'cwd'>;

// Compile-time check against the installed Pi SDK: the structural adapter must
// accept the real ExtensionAPI. The import is type-only, so it adds no runtime
// dependency to the published plugin.
type PiApiAcceptsSdk = ExtensionAPI extends PiApi ? true : false;
const piApiAcceptsSdk: PiApiAcceptsSdk = true;
void piApiAcceptsSdk;

function helpResult(): PiToolResult {
  return { content: [{ type: 'text', text: SCORE_HELP }], details: { text: SCORE_HELP } };
}

export default function pico8Music(pi: PiApi): void {
  pi.registerTool({
    name: 'p8_help',
    label: 'PICO-8 score reference',
    // No promptSnippet on purpose: the tools section of the system prompt stays short,
    // and the p8_music description plus rules are what point the model here.
    description: `Show the PICO-8 score DSL reference (the text behind /p8m). ${SCORE_BRIEF}`,
    parameters: helpParameters,
    execute(): Promise<PiToolResult> {
      return Promise.resolve(helpResult());
    },
  });

  pi.registerTool({
    name: 'p8_music',
    label: 'PICO-8 music renderer',
    description:
      'Compose a PICO-8-flavoured loop or arranged song and render it as a WAV. Call p8_help first for the score DSL.',
    promptSnippet: 'Render a PICO-8-style loop or song to a WAV file',
    promptGuidelines: [
      'Call p8_help before composing a score; it holds the JSON DSL, drum tokens, chords, and post chain.',
      'Use at most 4 tracks; use post: [] for a dry render and add tape/reverb only when the style needs it.',
      'Read the report warnings and revise dark, narrow, or sparse mixes before finishing.',
    ],
    parameters: musicParameters,
    // Two calls targeting the same `out` path must not overlap.
    executionMode: 'sequential',
    async execute(
      _toolCallId: string,
      args: RenderArgs,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiToolContext,
    ): Promise<PiToolResult> {
      try {
        const text = await executeRender(args, { signal, cwd: ctx?.cwd });
        return { content: [{ type: 'text', text }], details: { text } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (call p8_help for the score DSL)`);
      }
    },
  });

  pi.registerTool({
    name: 'p8_analyze',
    label: 'PICO-8 render report',
    description:
      'Measure an existing 16-bit PCM WAV: peak, RMS, LUFS, spectrum, width, onsets, and warnings.',
    parameters: analyzeParameters,
    execute(
      _toolCallId: string,
      args: { path: string },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiToolContext,
    ): Promise<PiToolResult> {
      return executeAnalyze(args, { signal, cwd: ctx?.cwd }).then((text) => ({
        content: [{ type: 'text' as const, text }],
        details: { text },
      }));
    },
  });

  // Same text as p8_help, for the human. A custom message joins the session
  // transcript, so the model also sees the reference on the next turn.
  pi.registerCommand('p8m', {
    description: 'Show the PICO-8 score DSL reference',
    handler: async () => {
      await pi.sendMessage?.({ customType: 'p8m-help', content: SCORE_HELP, display: true });
    },
  });
}
