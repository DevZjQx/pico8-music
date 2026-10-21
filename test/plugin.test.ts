import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { apply, name } from '../src/app/dsh-plugin.ts';
import { executeRender } from '../src/app/render-service.ts';
import { renderLoop } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const score = JSON.stringify({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [{ waveform: 'pulse', volume: 5, pattern: 'C4:4 E4:4 G4:8' }],
});

interface Definition {
  name?: string;
  description?: string;
  parameters?: any;
  output?: any;
  execute?: (...args: any[]) => Promise<unknown>;
}

interface Command {
  name?: string;
  description?: string;
  handler?: (...args: any[]) => unknown;
}

interface Host {
  tools: Map<string, Definition>;
  commands: Map<string, Command>;
}

function host(): { ctx: Record<string, unknown>; captured: Host } {
  const captured: Host = { tools: new Map(), commands: new Map() };
  const tools = {
    register: (definition: Definition) => {
      if (definition.name) captured.tools.set(definition.name, definition);
    },
  };
  const commands = {
    register: (command: Command) => {
      if (command.name) captured.commands.set(command.name, command);
    },
  };
  const ctx = {
    tools,
    commands,
    inject: (deps: string[], callback: (child: unknown) => void) => {
      assert.deepEqual(deps, ['commands']);
      callback({ commands });
    },
  };
  return { ctx, captured };
}

test('registers p8_music and p8_help as DSH tools', () => {
  const { ctx, captured } = host();
  apply(ctx);
  assert.equal(name, 'pico8-music');

  const music = captured.tools.get('p8_music');
  assert.equal(music?.parameters?.required, undefined);
  assert.ok(music?.parameters?.properties?.score);
  assert.ok(music?.parameters?.properties?.scoreFile);
  assert.ok(music?.parameters?.properties?.post);
  assert.ok(music?.parameters?.properties?.toneHz);
  assert.ok(music?.parameters?.properties?.style);

  const analyze = captured.tools.get('p8_analyze');
  assert.deepEqual(analyze?.parameters?.required, ['path']);
  assert.match(analyze?.description ?? '', /LUFS/);

  const help = captured.tools.get('p8_help');
  assert.deepEqual(help?.parameters?.properties, {});
  assert.equal(help?.output?.schema?.type, 'string');
  assert.match(help?.description ?? '', /\/p8m/);

  // The PTC/native schema readers snapshot parameters as lossless JSON and reject
  // TypeBox's non-enumerable tags and its `anyOf` spelling of literal unions.
  for (const tool of captured.tools.values()) {
    assertSupportedJsonSchema(tool.parameters);
  }
});

test('the p8_music declaration stays small and points at p8_help', () => {
  const { ctx, captured } = host();
  apply(ctx);
  const music = captured.tools.get('p8_music');
  assert.match(music?.description ?? '', /p8_help/);
  assert.ok((music?.description ?? '').length < 250, 'DSL text must not live in the tool description');
});

test('p8_help returns the full score reference', async () => {
  const { ctx, captured } = host();
  apply(ctx);
  const text = await captured.tools.get('p8_help')?.execute?.({});
  assert.match(String(text), /PICO-8 score reference/);
  assert.match(String(text), /~effect/);
  assert.match(String(text), /arrangement/);
});

test('/p8m is registered and returns the reference as a command result', () => {
  const { ctx, captured } = host();
  apply(ctx);
  const command = captured.commands.get('p8m');
  assert.ok(command);
  assert.match(command.description ?? '', /score/);
  const result = command.handler?.({}) as { kind?: string; text?: string };
  assert.equal(result.kind, 'success');
  assert.match(result.text ?? '', /PICO-8 score reference/);
});

test('a host without a command surface still gets the tools', () => {
  const captured: Host = { tools: new Map(), commands: new Map() };
  apply({
    tools: {
      register: (definition: Definition) => {
        if (definition.name) captured.tools.set(definition.name, definition);
      },
    },
  });
  assert.deepEqual([...captured.tools.keys()], ['p8_help', 'p8_music', 'p8_analyze']);
});

test('a bad score points the model at p8_help', async () => {
  const { ctx, captured } = host();
  apply(ctx);
  await assert.rejects(async () => {
    await captured.tools.get('p8_music')?.execute?.({ score: '{}' });
  }, /p8_help/);
});

test('a tool argument nested in the score is reported as an argument', async () => {
  const { ctx, captured } = host();
  apply(ctx);
  const misplaced = JSON.stringify({ post: [], tracks: [{ pattern: 'C4:4' }] });
  await assert.rejects(
    async () => {
      await captured.tools.get('p8_music')?.execute?.({ score: misplaced });
    },
    (error: unknown) =>
      error instanceof Error &&
      /"post" is a p8_music tool parameter, not a top-level score field/.test(error.message) &&
      /p8_help/.test(error.message),
  );
});

test('DSH resolves relative paths against the session workspace', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-cwd-'));
  try {
    const { ctx, captured } = host();
    apply(ctx);
    const exec = { agent: { session: { header: { cwd: directory } } } };
    const summary = await captured.tools.get('p8_music')?.execute?.(
      { score, minutes: 0.05, out: 'loop' },
      exec,
    );
    assert.match(String(summary), /Rendered/);
    assert.equal((await readFile(join(directory, 'loop.wav'))).subarray(0, 4).toString('ascii'), 'RIFF');

    const analyzed = await captured.tools.get('p8_analyze')?.execute?.(
      { path: 'loop.wav' },
      exec,
    );
    assert.match(String(analyzed), /Analyzed/);
    assert.ok(String(analyzed).includes(join(directory, 'loop.wav')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renders to the requested path and appends the wav extension', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-music-'));
  try {
    const target = join(directory, 'loop');
    const summary = await executeRender({ score, minutes: 0.05, out: target });
    const written = await readFile(`${target}.wav`);
    assert.equal(written.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.match(summary, /loop .*44100 Hz stereo/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('streams the same WAV bytes as the in-memory encoder', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-stream-'));
  try {
    const target = join(directory, 'stream');
    await executeRender({ score, minutes: 0.05, post: [], out: target });
    const written = await readFile(`${target}.wav`);
    const expected = renderLoop(parseScore(score), { post: [], minutes: 0.05 }).wav;
    assert.deepEqual(new Uint8Array(written), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renders a dry song and reports the post chain', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-music-song-'));
  try {
    const song = JSON.stringify({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'drums', role: 'drums', pattern: 'K:1 -:1 H:1 -:1' }],
      arrangement: [
        { name: 'intro', bars: 1, mute: ['drums'] },
        { name: 'drop', bars: 1 },
      ],
    });
    const target = join(directory, 'song');
    const summary = await executeRender({ score: song, post: [], out: target });
    assert.match(summary, /mode song/);
    assert.match(summary, /post dry/);
    const written = await readFile(`${target}.wav`);
    assert.equal(written.subarray(0, 4).toString('ascii'), 'RIFF');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renders a scoreFile and reads it on every render', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-score-file-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const scorePath = join(directory, 'score.json');
    await writeFile(scorePath, score, 'utf8');
    const target = join(directory, 'from-file');
    const summary = await executeRender({ scoreFile: scorePath, minutes: 0.05, out: target });
    assert.match(summary, /Rendered/);
    assert.equal((await readFile(`${target}.wav`)).subarray(0, 4).toString('ascii'), 'RIFF');

    const changed = JSON.stringify({ ...JSON.parse(score), bpm: 140 });
    await writeFile(scorePath, changed, 'utf8');
    const second = await executeRender({ scoreFile: scorePath, minutes: 0.05, out: target });
    assert.match(second, /140 bpm/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unknown presets and malformed scores', async () => {
  await assert.rejects(() => executeRender({ score, preset: 'lofi' }), /unknown preset "lofi"/);
  await assert.rejects(() => executeRender({ score: '{}' }), /tracks/);
  await assert.rejects(
    () => executeRender({ score, post: [{ type: 'flanger' }] as never }),
    /must be tape, slow, lowpass, reverb/,
  );
});


test('score and scoreFile are mutually exclusive and workspace-scoped', async () => {
  await assert.rejects(
    () => executeRender({ score, scoreFile: 'examples/m1-16bar.json' }),
    /either score or scoreFile, not both/,
  );
  await assert.rejects(() => executeRender({}), /provide score JSON or a workspace-relative scoreFile/);
  await assert.rejects(
    () => executeRender({ scoreFile: '../score.json' }),
    /must stay inside the workspace/,
  );
  await assert.rejects(
    () => executeRender({ scoreFile: 'score.txt' }),
    /scoreFile must end in .json/,
  );
  await assert.rejects(
    () => executeRender({ scoreFile: 'missing-score.json' }),
    /cannot read scoreFile/,
  );
});

test('rejects non-wav output, path escapes, and renders before validating out', async () => {
  await assert.rejects(
    () => executeRender({ score, out: 'render.mp3' }),
    /out must end in .wav/,
  );
  await assert.rejects(
    () => executeRender({ score, out: '../escape.wav' }),
    /must stay inside the workspace/,
  );
  await assert.rejects(
    () => executeRender({ score, out: '/tmp/escape.wav' }),
    /must stay inside the workspace/,
  );
});
