import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAnalyze, executeRender } from '../src/app/render-service.ts';
import { analyseAudio, formatReport, renderLoop } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const RATE = 44100;

const rawScore = {
  bpm: 120,
  bars: 2,
  tracks: [
    { name: 'drums', role: 'drums', pattern: 'K:1 H:1 S:1 H:1' },
    { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'C2:8 G2:8' },
    { name: 'lead', role: 'lead', waveform: 'pulse', pan: 0.4, pattern: 'C4:2 E4:2 G4:2 C5:2' },
  ],
};

function sine(frequency: number): Float32Array {
  return Float32Array.from(
    { length: RATE },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * frequency * i) / RATE),
  );
}

test('a render reports per-stem summaries and a pre-post snapshot', () => {
  const output = renderLoop(parseScore(rawScore), { minutes: 0.05, withWav: false });
  const stems = output.report.stems;
  assert.ok(stems !== undefined, 'a render must carry stem summaries');
  assert.deepEqual(stems.map((stem) => stem.name), ['drums', 'bass', 'lead']);
  for (const stem of stems) {
    assert.ok(Number.isFinite(stem.rmsDb), `${stem.name} rmsDb`);
    assert.ok(Number.isFinite(stem.peakDb), `${stem.name} peakDb`);
    assert.ok(stem.centroidHz > 0, `${stem.name} centroid`);
    assert.ok(Number.isFinite(stem.lowMid));
    assert.ok(Number.isFinite(stem.harsh));
    assert.equal(typeof stem.aliasRisk, 'boolean');
  }

  assert.ok(output.report.dry !== undefined, 'a post-chain render must carry dry facts');
  const text = formatReport(output.report);
  assert.match(text, /report stems /);
  assert.match(text, /report post-delta /);
});

test('findings attribute low-mid mud to the tracks that carry it', () => {
  const muddy = renderLoop(
    parseScore({
      bpm: 120,
      bars: 2,
      tracks: [
        { name: 'bass', role: 'bass', waveform: 'pulse', volume: 6, pattern: 'C2:16 C2:16' },
        { name: 'pad', role: 'pad', waveform: 'triangle', volume: 5, pattern: 'C3:16 E3:16' },
      ],
    }),
    { post: [], minutes: 0.05, withWav: false },
  );
  assert.ok(muddy.report.lowMid >= 0.25, `low-mid ${muddy.report.lowMid}`);
  const mud = muddy.report.findings.find((finding) => finding.kind === 'mud');
  assert.ok(mud !== undefined, 'expected a mud finding');
  assert.match(mud.attribution ?? '', /bass|pad/);
  assert.match(mud.next ?? '', /high-pass|octave|gate/);
});

test('a chip note above C6 is flagged as an alias risk', () => {
  const high = renderLoop(
    parseScore({
      bpm: 120,
      bars: 1,
      tracks: [{ name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'C7:8' }],
    }),
    { post: [], minutes: 0.05, withWav: false },
  );
  assert.equal(high.report.stems?.[0]?.aliasRisk, true);
  const alias = high.report.findings.find((finding) => finding.kind === 'alias-risk');
  assert.ok(alias !== undefined, 'expected an alias-risk finding');
  assert.match(formatReport(high.report), /report finding alias-risk: .*C6/);
});

test('post processing is separated from the pre-post mix', () => {
  const output = renderLoop(
    parseScore({
      bpm: 120,
      bars: 2,
      tracks: [{ name: 'pad', role: 'pad', waveform: 'triangle', pattern: 'C4:16 E4:16' }],
    }),
    { post: [{ type: 'lowpass', cutoffHz: 1200 }], minutes: 0.05, withWav: false },
  );
  assert.ok(output.report.dry !== undefined);
  assert.ok(output.report.lowMid > output.report.dry.lowMid);
  assert.ok(output.report.findings.some((finding) => finding.kind === 'post-mud'));
  assert.match(formatReport(output.report), /report post-delta .*low-mid \+/);
});

test('analysis findings work without stems or a dry snapshot', () => {
  const low = analyseAudio(sine(200), sine(200), RATE);
  assert.ok(low.lowMid > 0.9, `low-mid ${low.lowMid}`);
  assert.ok(low.findings.some((finding) => finding.kind === 'mud'));
  assert.equal(low.stems, undefined);
  assert.equal(low.dry, undefined);

  const presence = analyseAudio(sine(3000), sine(3000), RATE);
  assert.ok(presence.harsh > 0.9, `2-5k ${presence.harsh}`);
  assert.ok(presence.findings.some((finding) => finding.kind === 'harsh'));

  const clean = analyseAudio(sine(1000), sine(1000), RATE);
  assert.ok(!clean.findings.some((finding) => finding.kind === 'mud'));
  assert.ok(!clean.findings.some((finding) => finding.kind === 'harsh'));
  assert.ok(!clean.findings.some((finding) => finding.kind === 'alias-risk'));
});

test('both tools write raw artifacts without clobbering each other', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-raw-'));
  try {
    const target = join(directory, 'loop');
    const rendered = await executeRender({
      score: JSON.stringify(rawScore),
      minutes: 0.05,
      out: target,
      detail: 'raw',
    });
    assert.match(rendered, /raw analysis .*loop\.analysis\.json/);

    // A render owns the rich artifact: stems and dry facts cannot be recovered
    // from the WAV, so they live here rather than in the tool result.
    const renderRaw = JSON.parse(await readFile(join(directory, 'loop.analysis.json'), 'utf8'));
    assert.equal(renderRaw.rate, RATE);
    assert.ok(Array.isArray(renderRaw.analysis.stems));
    assert.ok(renderRaw.analysis.stems.length > 0);
    assert.ok(renderRaw.analysis.dry !== undefined);
    assert.ok(Array.isArray(renderRaw.analysis.findings));

    const analyzed = await executeAnalyze({ path: `${target}.wav`, detail: 'raw' });
    assert.match(analyzed, /Analyzed/);
    assert.match(analyzed, /raw analysis .*loop\.wav\.analysis\.json/);

    // The WAV-only artifact appends instead of overwriting the render artifact.
    const wavRaw = JSON.parse(await readFile(join(directory, 'loop.wav.analysis.json'), 'utf8'));
    assert.equal(wavRaw.rate, RATE);
    assert.ok(Array.isArray(wavRaw.analysis.findings));
    assert.equal(wavRaw.analysis.stems, undefined);
    assert.equal(wavRaw.analysis.dry, undefined);

    // The render artifact is still intact after the analyze call.
    const stillRich = JSON.parse(await readFile(join(directory, 'loop.analysis.json'), 'utf8'));
    assert.ok(Array.isArray(stillRich.analysis.stems));

    await assert.rejects(
      () => executeAnalyze({ path: `${target}.wav`, detail: 'deep' }),
      /detail must be summary or raw/,
    );
    await assert.rejects(
      () => executeRender({ score: JSON.stringify(rawScore), out: target, detail: 'deep' }),
      /detail must be summary or raw/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
