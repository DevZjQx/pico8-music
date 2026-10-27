import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAnalyze, executeRender } from '../src/app/render-service.ts';
import { renderLoop } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const RATE = 44100;

function channelsOf(wav: Uint8Array): { left: Float32Array; right: Float32Array } {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const frames = (wav.length - 44) / 4;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = view.getInt16(44 + i * 4, true) / 32768;
    right[i] = view.getInt16(46 + i * 4, true) / 32768;
  }
  return { left, right };
}

function rms(samples: Float32Array, start: number, end: number): number {
  const first = Math.max(0, Math.floor(start * RATE));
  const last = Math.min(samples.length, Math.floor(end * RATE));
  let squares = 0;
  for (let i = first; i < last; i += 1) squares += (samples[i] ?? 0) ** 2;
  return last > first ? Math.sqrt(squares / (last - first)) : 0;
}

test('per-note pan overrides the track image, and the track pan still applies elsewhere', () => {
  const output = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: [
        {
          waveform: 'triangle',
          pan: 1,
          pattern: 'C4:8~pan(-1) E4:8',
        },
      ],
    }),
    { post: [], minutes: 0.05 },
  );
  const { left, right } = channelsOf(output.wav);
  const firstLeft = rms(left, 0.1, 0.8);
  const firstRight = rms(right, 0.1, 0.8);
  const secondLeft = rms(left, 1.1, 1.8);
  const secondRight = rms(right, 1.1, 1.8);
  assert.ok(firstLeft > firstRight * 10, `pan(-1) left ${firstLeft}, right ${firstRight}`);
  assert.ok(firstRight < 0.001, `pan(-1) should not reach the right channel: ${firstRight}`);
  assert.ok(secondRight > secondLeft * 10, `track pan right ${secondRight}, left ${secondLeft}`);
});

test('per-note send overrides the track send, and unmarked notes keep it', () => {
  const output = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      beatsPerBar: 4,
      tracks: [
        {
          waveform: 'triangle',
          send: 1,
          pattern: 'C4:1~send(0) -:15 E4:1 -:15',
        },
      ],
      arrangement: [{ name: 'one', bars: 2 }],
    }),
    { post: [] },
  );
  const { left } = channelsOf(output.wav);
  const firstTail = rms(left, 0.5, 1.5);
  const secondTail = rms(left, 2.5, 3.5);
  assert.ok(secondTail > 0.005, `the plain note should still reach the track send: ${secondTail}`);
  assert.ok(firstTail < secondTail * 0.1, `send(0) tail ${firstTail}, track tail ${secondTail}`);

  const wet = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: [{ waveform: 'triangle', send: 0, pattern: 'C4:1~send(1) -:15' }],
    }),
    { post: [], minutes: 0.05 },
  );
  const dry = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: [{ waveform: 'triangle', send: 0, pattern: 'C4:1~send(0) -:15' }],
    }),
    { post: [], minutes: 0.05 },
  );
  const wetTail = rms(channelsOf(wet.wav).left, 0.5, 1.0);
  const dryTail = rms(channelsOf(dry.wav).left, 0.5, 1.0);
  assert.ok(wetTail > dryTail * 5, `send(1) tail ${wetTail}, send(0) tail ${dryTail}`);
});

test('a drum choke fades the open hat under the next closed hat', () => {
  const score = (drumChoke: unknown) =>
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      ...(drumChoke === undefined ? {} : { drumChoke }),
      tracks: [{ name: 'drums', role: 'drums', pattern: 'O:1 H:1 -:14' }],
    });
  const open = renderLoop(score(undefined), { post: [], minutes: 0.05 });
  const choked = renderLoop(score({ hat: ['openhat'] }), { post: [], minutes: 0.05 });
  const openTail = rms(channelsOf(open.wav).left, 0.22, 0.35);
  const chokedTail = rms(channelsOf(choked.wav).left, 0.22, 0.35);
  assert.ok(openTail > chokedTail * 4, `open tail ${openTail}, choked tail ${chokedTail}`);

  // An empty table must be a true no-op, sample for sample.
  const explicitEmpty = renderLoop(score({}), { post: [], minutes: 0.05 });
  assert.deepEqual(Array.from(explicitEmpty.left), Array.from(open.left));
  assert.deepEqual(Array.from(explicitEmpty.right), Array.from(open.right));
});

test('drum choke parsing rejects unknown voices and empty target lists', () => {
  assert.throws(
    () =>
      parseScore({
        drumChoke: { nope: ['openhat'] },
        tracks: [{ role: 'drums', pattern: 'K:4' }],
      }),
    /drumChoke\.nope: unknown trigger voice/,
  );
  assert.throws(
    () =>
      parseScore({
        drumChoke: { hat: [] },
        tracks: [{ role: 'drums', pattern: 'K:4' }],
      }),
    /must be a non-empty array/,
  );
  assert.throws(
    () =>
      parseScore({
        drumChoke: { hat: ['nope'] },
        tracks: [{ role: 'drums', pattern: 'K:4' }],
      }),
    /unknown target voice/,
  );
});

test('spatial suffixes parse, coexist with timing and effects, and reject bad ranges', () => {
  const parsed = parseScore({
    tracks: [
      { pattern: 'C4:4~pan(-0.5)~send(0.25)~drag(10)' },
      { role: 'drums', pattern: 'H:4~pan(0.8)~send(0)' },
    ],
  });
  assert.equal(parsed.tracks[0]?.events[0]?.pan, -0.5);
  assert.equal(parsed.tracks[0]?.events[0]?.send, 0.25);
  assert.equal(parsed.tracks[0]?.events[0]?.offsetMs, 10);
  assert.equal(parsed.tracks[1]?.events[0]?.pan, 0.8);
  assert.equal(parsed.tracks[1]?.events[0]?.send, 0);

  // Motif expansion formats and re-parses the spatial suffixes.
  const motif = parseScore({
    motifs: { A: 'C4:4~pan(-0.5)~send(0.25)~drag(12)' },
    tracks: [{ pattern: '@A.retrograde' }],
  });
  assert.equal(motif.tracks[0]?.events[0]?.pan, -0.5);
  assert.equal(motif.tracks[0]?.events[0]?.send, 0.25);
  assert.equal(motif.tracks[0]?.events[0]?.offsetMs, 12);

  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~pan(2)' }] }),
    /~pan must be between -1 and 1/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~send(-0.1)' }] }),
    /~send must be between 0 and 1/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~pan(0)~pan(1)' }] }),
    /at most one ~pan/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: '-:4~pan(0)' }] }),
    /a rest cannot carry ~pan or ~send/,
  );
});

test('p8_music compare caches the report and returns a delta from the previous render', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-compare-'));
  try {
    const before = {
      bpm: 120,
      bars: 1,
      tracks: [{ waveform: 'triangle', volume: 3, pattern: 'C4:8 E4:8' }],
    };
    const after = {
      bpm: 120,
      bars: 1,
      tracks: [{ waveform: 'triangle', volume: 6, pattern: 'C4:8 E4:8' }],
    };
    const first = await executeRender({
      score: JSON.stringify(before),
      minutes: 0.05,
      out: 'before.wav',
      compare: true,
    }, { cwd: directory });
    assert.match(first, /no previous render cached/);

    const cachePath = join(directory, '.p8-compare.json');
    const firstCache = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.ok(Number.isFinite(firstCache.analysis.rmsDb));

    const second = await executeRender({
      score: JSON.stringify(after),
      minutes: 0.05,
      out: 'after.wav',
      compare: true,
    }, { cwd: directory });
    assert.match(second, /compare \d+\.\d s -> \d+\.\d s/);
    assert.match(second, /compare rms /);

    const secondCache = JSON.parse(await readFile(cachePath, 'utf8'));
    const expected = secondCache.analysis.rmsDb - firstCache.analysis.rmsDb;
    const expectedText = `${expected > 0 ? '+' : ''}${expected.toFixed(1)}`;
    assert.match(second, new RegExp(`compare rms .*\\(${expectedText.replace('+', '\\+')}\\)`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('p8_analyze compare accepts two WAVs and returns the same delta shape', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-analyze-compare-'));
  try {
    const render = async (volume: number, out: string) =>
      executeRender({
        score: JSON.stringify({
          bpm: 120,
          bars: 1,
          tracks: [{ waveform: 'triangle', volume, pattern: 'C4:8 E4:8' }],
        }),
        minutes: 0.05,
        out,
      }, { cwd: directory });
    await render(3, 'before.wav');
    await render(6, 'after.wav');

    const compared = await executeAnalyze(
      { path: 'after.wav', detail: 'compare', against: 'before.wav' },
      { cwd: directory },
    );
    assert.match(compared, /Compared .*after\.wav against .*before\.wav/);
    assert.match(compared, /compare rms /);
    assert.match(compared, /compare width /);

    await assert.rejects(
      () => executeAnalyze({ path: 'after.wav', detail: 'compare' }, { cwd: directory }),
      /requires against/,
    );
    await assert.rejects(
      () => executeAnalyze({ path: 'after.wav', against: 'before.wav' }, { cwd: directory }),
      /only used with detail: compare/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
