import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import piExtension from '../src/app/pi-extension.ts';

interface CapturedTool {
  name?: string;
  executionMode?: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: { type?: string; required?: string[]; properties?: Record<string, unknown> };
  execute?: (id: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: { cwd?: string }) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

interface CapturedCommand {
  description?: string;
  handler: (args: string) => Promise<void> | void;
}

interface Captured {
  tools: Map<string, CapturedTool>;
  commands: Map<string, CapturedCommand>;
  messages: Array<{ customType: string; content: string; display: boolean }>;
}

function load(): Captured {
  const captured: Captured = { tools: new Map(), commands: new Map(), messages: [] };
  const api = {
    registerTool: (definition: unknown) => {
      const tool = definition as CapturedTool;
      if (tool.name) captured.tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: CapturedCommand) => {
      captured.commands.set(name, options);
    },
    sendMessage: (message: { customType: string; content: string; display: boolean }) => {
      captured.messages.push(message);
    },
  };
  piExtension(api as unknown as Parameters<typeof piExtension>[0]);
  return captured;
}

const score = JSON.stringify({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [{ waveform: 'pulse', volume: 5, pattern: 'C4:4 E4:4 G4:8' }],
});

test('registers a TypeBox-validated p8_music tool', () => {
  const { tools } = load();
  const tool = tools.get('p8_music');
  assert.equal(tool?.label, 'PICO-8 music renderer');
  assert.equal(tool?.parameters?.type, 'object');
  assert.equal(tool?.parameters?.required, undefined);
  assert.ok(tool?.parameters?.properties?.score);
  assert.ok(tool?.parameters?.properties?.scoreFile);
  assert.ok(tool?.parameters?.properties?.post);
  assert.ok(tool?.parameters?.properties?.toneHz);
  assert.ok(tool?.parameters?.properties?.style);
  assert.equal(tool?.executionMode, 'sequential');

  const analyze = tools.get('p8_analyze');
  assert.deepEqual(analyze?.parameters?.required, ['path']);
  assert.match(analyze?.label ?? '', /report/i);

  const probe = tools.get('p8_probe');
  assert.equal(probe?.parameters?.required, undefined);
  assert.ok(probe?.parameters?.properties?.track);
  assert.ok(probe?.parameters?.properties?.note);
  assert.ok(probe?.parameters?.properties?.sensitivity);
  assert.equal(probe?.executionMode, 'sequential');
  assert.match(probe?.description ?? '', /odd\/even/);
});

test('the p8_music declaration stays small and points at p8_help', () => {
  const tool = load().tools.get('p8_music');
  assert.match(tool?.description ?? '', /p8_help/);
  assert.ok((tool?.description ?? '').length < 300, 'DSL text must not live in the tool description');
  assert.ok((tool?.promptSnippet ?? '').length < 100);
  assert.ok((tool?.promptGuidelines ?? []).join(' ').length < 300);
});

test('p8_help returns the full score reference', async () => {
  const tool = load().tools.get('p8_help');
  assert.ok(tool);
  const result = await tool.execute?.('call-help', {});
  const text = result?.content[0]?.text ?? '';
  assert.match(text, /PICO-8 score reference/);
  assert.match(text, /~effect/);
  assert.match(text, /arrangement/);
  assert.match(text, /post: \[\]/);
  // The help must draw the score/tool boundary, not just document both halves.
  assert.match(text, /p8_music arguments passed next to score/);
  assert.match(text, /inside the score JSON is an error/);
  // Instruments and the styles that select them must be discoverable here.
  assert.match(text, /## Instruments/);
  assert.match(text, /"instruments":/);
  assert.match(text, /additive/);
  assert.match(text, /studio, or lofi/);
  assert.match(text, /~pitch/);
});

test('/p8m prints the reference into the session', async () => {
  const { commands, messages } = load();
  const command = commands.get('p8m');
  assert.ok(command);
  assert.match(command.description ?? '', /score/);
  await command.handler('');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.customType, 'p8m-help');
  assert.equal(messages[0]?.display, true);
  assert.match(messages[0]?.content ?? '', /PICO-8 score reference/);
});

test('the Pi tool executes the shared render service', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-pi-'));
  try {
    const tool = load().tools.get('p8_music');
    const out = join(directory, 'pi-loop');
    const result = await tool?.execute?.('call-1', { score, minutes: 0.05, out });
    assert.match(result?.content[0]?.text ?? '', /Rendered/);
    assert.equal((await readFile(`${out}.wav`)).subarray(0, 4).toString('ascii'), 'RIFF');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Pi tool renders a scoreFile relative to ctx.cwd', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-pi-file-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'score.json'), score, 'utf8');
    const tool = load().tools.get('p8_music');
    const result = await tool?.execute?.(
      'call-file',
      { scoreFile: 'score', minutes: 0.05, out: 'pi-file' },
      undefined,
      undefined,
      { cwd: directory },
    );
    assert.match(result?.content[0]?.text ?? '', /Rendered/);
    assert.equal(
      (await readFile(join(directory, 'pi-file.wav'))).subarray(0, 4).toString('ascii'),
      'RIFF',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Pi tool resolves relative paths against ctx.cwd', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-pi-cwd-'));
  try {
    const tool = load().tools.get('p8_music');
    const result = await tool?.execute?.(
      'call-cwd',
      { score, minutes: 0.05, out: 'pi-cwd' },
      undefined,
      undefined,
      { cwd: directory },
    );
    assert.match(result?.content[0]?.text ?? '', /Rendered/);
    assert.equal(
      (await readFile(join(directory, 'pi-cwd.wav'))).subarray(0, 4).toString('ascii'),
      'RIFF',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bad score points the model at p8_help', async () => {
  const tool = load().tools.get('p8_music');
  await assert.rejects(
    () => tool?.execute?.('call-2', { score: '{}' }) ?? Promise.resolve(),
    /p8_help/,
  );
});
