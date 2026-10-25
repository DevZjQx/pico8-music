import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAnalyze, executeRender } from '../src/app/render-service.ts';
import {
  analyseAudio,
  formatReport,
  loudnessRange,
  renderLoop,
  resolveAssertions,
} from '../src/features/render/feature.ts';
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

test('section readings carry their own low-mid and 2-5k shares', () => {
  const low = sine(200);
  const high = sine(3000);
  const left = new Float32Array(low.length + high.length);
  left.set(low, 0);
  left.set(high, low.length);

  const analysis = analyseAudio(left, left, RATE, {
    sectionBounds: [
      { name: 'low', startSeconds: 0, durationSeconds: 1 },
      { name: 'high', startSeconds: 1, durationSeconds: 1 },
    ],
  });
  const [lowSection, highSection] = analysis.sections;
  assert.ok(lowSection !== undefined && highSection !== undefined);
  assert.equal(lowSection.name, 'low');
  assert.ok(lowSection.lowMid > 0.9, `low-mid ${lowSection.lowMid}`);
  assert.ok(lowSection.harsh < 0.1, `2-5k ${lowSection.harsh}`);
  assert.ok(highSection.lowMid < 0.1, `low-mid ${highSection.lowMid}`);
  assert.ok(highSection.harsh > 0.9, `2-5k ${highSection.harsh}`);
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

test('analysis flags sub-bass that small speakers cannot reproduce', () => {
  const output = renderLoop(
    parseScore({
      bpm: 120,
      bars: 1,
      tracks: [{ waveform: 'triangle', volume: 6, pattern: 'C1:16' }],
    }),
    { post: [], minutes: 0.05, withWav: false },
  );
  assert.ok(output.report.bands.sub >= 0.06, `sub ${output.report.bands.sub}`);
  const finding = output.report.findings.find((entry) => entry.kind === 'sub-heavy');
  assert.ok(finding !== undefined, 'expected a sub-heavy finding');
  assert.match(finding.next ?? '', /high-pass|monoBelowHz/);
});

test('loudness range measures how far the short-term level travels', () => {
  const steady = Float32Array.from(
    { length: RATE * 12 },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE),
  );
  assert.ok(loudnessRange([steady, steady], RATE) < 1, 'a steady tone has no range');

  // A 14 dB step stays inside the -20 LU relative gate; a deeper drop would be
  // gated out entirely, which is why the finding also checks section spread.
  const stepped = Float32Array.from({ length: RATE * 12 }, (_, i) => {
    const amplitude = i < RATE * 6 ? 0.1 : 0.5;
    return amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE);
  });
  const range = loudnessRange([stepped, stepped], RATE);
  assert.ok(range > 8, `a 14 dB step should open the range, got ${range}`);
});

test('a song that holds one loudness raises the loudness-flat finding', () => {
  const steady = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
    arrangement: [
      { name: 'a', bars: 8 },
      { name: 'b', bars: 8 },
    ],
  });
  const output = renderLoop(steady, { post: [{ type: 'loudness', targetLufs: -14 }] });
  assert.ok(output.report.seconds >= 10, `seconds ${output.report.seconds}`);
  assert.ok(output.report.lra < 4, `LRA ${output.report.lra}`);
  const flat = output.report.findings.find((finding) => finding.kind === 'loudness-flat');
  assert.ok(flat !== undefined, 'expected a loudness-flat finding');
  assert.match(flat.next ?? '', /section|bar/);
  assert.match(formatReport(output.report), /· LRA \d+\.\d LU/);

  // A silent intro is a real rest even though LRA's absolute gate drops it.
  const withRest = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ name: 'lead', waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
    arrangement: [
      { name: 'rest', bars: 8, mute: ['lead'] },
      { name: 'drop', bars: 8 },
    ],
  });
  const contrasted = renderLoop(withRest, { post: [{ type: 'loudness', targetLufs: -14 }] });
  assert.ok(
    !contrasted.report.findings.some((finding) => finding.kind === 'loudness-flat'),
    `LRA ${contrasted.report.lra}, spread ${contrasted.report.sections.map((s) => s.rmsDb).join(',')}`,
  );
});

test('an already-unsafe file is reported by analysis, not rejected', () => {
  const hot = Float32Array.from(
    { length: RATE * 4 },
    (_, i) => 0.95 * Math.sin((2 * Math.PI * 1000 * i) / RATE),
  );
  const analysis = analyseAudio(hot, hot, RATE);
  assert.ok(analysis.lufs > -9, `LUFS ${analysis.lufs}`);
  assert.match(analysis.warnings.join(' | '), /unsafe: .*hearing-safety/);
});



test('true peak catches inter-sample peaks that sample peak misses', () => {
  // At fs/4, samples land at 45/135/225/315 degrees, so the waveform's crest is
  // between samples. The 0.8-amplitude sine should read -1.94 dBTP while the
  // sample peak is about 3 dB lower.
  const signal = Float32Array.from(
    { length: RATE },
    (_, i) => 0.8 * Math.sin((2 * Math.PI * (RATE / 4) * i) / RATE + Math.PI / 4),
  );
  const analysis = analyseAudio(signal, signal, RATE);
  assert.ok(analysis.peakDb < -4.5, `sample peak ${analysis.peakDb}`);
  assert.ok(
    analysis.truePeakDb > analysis.peakDb + 1.5,
    `true peak ${analysis.truePeakDb} vs sample peak ${analysis.peakDb}`,
  );
  assert.ok(
    Math.abs(analysis.truePeakDb - 20 * Math.log10(0.8)) < 0.3,
    `true peak ${analysis.truePeakDb}`,
  );
});

test('correlation and channel balance make anti-phase and lopsided mixes visible', () => {
  const left = sine(440);
  const quieterRight = Float32Array.from(left, (value) => value * 0.5);
  const lopsided = analyseAudio(left, quieterRight, RATE);
  assert.ok(Math.abs(lopsided.correlation - 1) < 0.01, `correlation ${lopsided.correlation}`);
  assert.ok(Math.abs(lopsided.balanceDb - 6.02) < 0.1, `balance ${lopsided.balanceDb}`);
  assert.match(lopsided.warnings.join(' | '), /imbalanced: left is 6\.0 dB louder/);

  const antiPhase = Float32Array.from(left, (value) => -value);
  const anti = analyseAudio(left, antiPhase, RATE);
  assert.ok(anti.correlation < -0.99, `correlation ${anti.correlation}`);
  assert.ok(Math.abs(anti.balanceDb) < 0.01, `balance ${anti.balanceDb}`);
  assert.match(anti.warnings.join(' | '), /phase: L\/R correlation -1\.00/);
});

test('p8_analyze segments an existing WAV from explicit section boundaries', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-sections-'));
  try {
    const target = join(directory, 'song');
    const song = {
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'lead', waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
      arrangement: [
        { name: 'intro', bars: 1 },
        { name: 'drop', bars: 1, gain: 0.5 },
      ],
    };
    await executeRender({ score: JSON.stringify(song), out: target, detail: 'raw' });
    const analyzed = await executeAnalyze({
      path: `${target}.wav`,
      sections: [
        { name: 'intro', startSeconds: 0, durationSeconds: 2 },
        { name: 'drop', startSeconds: 2 },
      ],
      detail: 'raw',
    });
    assert.match(analyzed, /report sections intro .* · drop /);
    const raw = JSON.parse(await readFile(`${target}.wav.analysis.json`, 'utf8'));
    assert.deepEqual(raw.analysis.sections.map((section: { name: string }) => section.name), [
      'intro',
      'drop',
    ]);
    for (const section of raw.analysis.sections) {
      assert.ok(Number.isFinite(section.rmsDb));
      assert.ok(Number.isFinite(section.correlation));
      assert.ok(Number.isFinite(section.balanceDb));
      assert.ok(Number.isFinite(section.lowMid));
      assert.ok(Number.isFinite(section.harsh));
    }

    // A bad boundary is rejected before the report is assembled.
    await assert.rejects(
      () => executeAnalyze({ path: `${target}.wav`, sections: [{ name: 'x', startSeconds: 20 }] }),
      /at or after the content length/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('targets and assertions can constrain true peak and the stereo image', () => {
  const signal = sine(1000);
  const report = analyseAudio(signal, signal, RATE, {
    target: { truePeakMax: -1.5, correlation: [0.9, 1], balanceMax: 0.5 },
    assertions: { truePeakMaxDb: -1, correlation: [0.9, 1], balanceMaxDb: 0.5 },
  });
  assert.deepEqual(report.target?.checks.map((check) => check.field), [
    'truePeak',
    'correlation',
    'balance',
  ]);
  assert.equal(report.target?.passed, 3, formatReport(report));
  assert.equal(report.assertions?.passed, 3, formatReport(report));
  assert.ok(!report.findings.some((finding) => finding.kind === 'target'));
});

test('assert ranges pass into the report and fail a tool call before writing', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-assert-'));
  try {
    const passing = join(directory, 'passing');
    const summary = await executeRender({
      score: JSON.stringify(rawScore),
      minutes: 0.05,
      out: passing,
      assert: {
        peakMaxDb: -1,
        truePeakMaxDb: 3,
        lra: [0, 40],
        correlation: [-1, 1],
        balanceMaxDb: 20,
      },
    });
    assert.match(summary, /report assert \d+\/\d+ checks passed/);
    assert.doesNotMatch(summary, /failed:/);

    const failing = join(directory, 'failing');
    await assert.rejects(
      () =>
        executeRender({
          score: JSON.stringify(rawScore),
          minutes: 0.05,
          out: failing,
          assert: { peakMaxDb: -40 },
        }),
      /assert failed .*peak .*is outside max -40\.0 dBFS/,
    );
    await assert.rejects(() => stat(`${failing}.wav`), /ENOENT/);

    await assert.rejects(
      () =>
        executeAnalyze({
          path: `${passing}.wav`,
          assert: { lufs: [-4, -3] },
        }),
      /assert failed .*lufs /,
    );

    assert.throws(() => resolveAssertions({ bass: 1 }), /not a known check/);
    assert.throws(() => resolveAssertions({ correlation: [-2, 1] }), /must stay inside/);
    assert.throws(() => resolveAssertions({}), /at least one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the render tool refuses to write a file above the hearing-safety ceiling', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-safety-'));
  try {
    const out = join(directory, 'hot');
    const loud = {
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: Array.from({ length: 4 }, () => ({
        waveform: 'square',
        volume: 7,
        pattern: 'C4:4 D4:4 E4:4 F4:4',
      })),
    };
    await assert.rejects(
      () => executeRender({ score: JSON.stringify(loud), minutes: 0.05, out }),
      /hearing-safety ceiling/,
    );
    // The refusal happens before the write, so no partial file is left behind.
    await assert.rejects(() => stat(`${out}.wav`), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
