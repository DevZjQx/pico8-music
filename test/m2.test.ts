import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAnalyze, executeRender } from '../src/app/render-service.ts';
import {
  TARGETS,
  analyseAudio,
  formatReport,
  renderLoop,
  resolveTarget,
} from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const RATE = 44100;

function sine(frequency: number): Float32Array {
  return Float32Array.from(
    { length: RATE },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * frequency * i) / RATE),
  );
}

/** Windowed single-bin DFT; enough to compare one folded harmonic. */
function magnitudeAt(samples: Float32Array, rate: number, frequency: number): number {
  let real = 0;
  let imaginary = 0;
  const length = samples.length;
  for (let i = 0; i < length; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, length - 1));
    const phase = (2 * Math.PI * frequency * i) / rate;
    const sample = (samples[i] ?? 0) * window;
    real += sample * Math.cos(phase);
    imaginary += sample * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / Math.max(1, length);
}

/** Fold a harmonic above Nyquist back into the 0..Nyquist range. */
function foldedFrequency(harmonic: number, fundamental: number, rate: number): number {
  let frequency = (harmonic * fundamental) % rate;
  if (frequency > rate / 2) frequency = rate - frequency;
  return frequency;
}

function aliasRatio(waveform: 'saw' | 'pulse', quality: 'pico' | 'clean'): number {
  const score = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [{ waveform, pattern: 'C7:16' }],
  });
  const fundamental = score.tracks[0]?.events[0]?.frequency ?? 0;
  const output = renderLoop(score, { post: [], quality, minutes: 0.05, withWav: false });
  const harmonic = waveform === 'saw' ? 11 : 11;
  const folded = foldedFrequency(harmonic, fundamental, RATE);
  const alias = magnitudeAt(output.left, output.rate, folded);
  const base = magnitudeAt(output.left, output.rate, fundamental);
  return base === 0 ? 0 : alias / base;
}

test('clean quality lowers the folded harmonic of a high saw and pulse', () => {
  for (const waveform of ['saw', 'pulse'] as const) {
    const pico = aliasRatio(waveform, 'pico');
    const clean = aliasRatio(waveform, 'clean');
    assert.ok(clean < pico * 0.6, `${waveform}: clean ${clean} vs pico ${pico}`);
  }
});

test('omitting quality keeps the historical chip render sample for sample', () => {
  const score = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [
      { waveform: 'saw', pattern: 'C4:4 E4:4 G4:4 C5:4' },
      { waveform: 'pulse', pattern: 'C3:8 G3:8' },
    ],
  });
  const implicit = renderLoop(score, { post: [], minutes: 0.05 });
  const explicit = renderLoop(score, { post: [], quality: 'pico', minutes: 0.05 });
  const clean = renderLoop(score, { post: [], quality: 'clean', minutes: 0.05 });
  assert.deepEqual(Array.from(implicit.left), Array.from(explicit.left));
  assert.notDeepEqual(Array.from(implicit.left), Array.from(clean.left));
});

test('clean quality clears the alias-risk heuristic for saw and pulse only', () => {
  const score = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [
      { name: 'saw', waveform: 'saw', pattern: 'C7:8' },
      { name: 'organ', waveform: 'organ', pattern: 'C7:8' },
    ],
  });
  const clean = renderLoop(score, { post: [], quality: 'clean', minutes: 0.05, withWav: false });
  const stems = clean.report.stems ?? [];
  assert.equal(stems.find((stem) => stem.name === 'saw')?.aliasRisk, false);
  assert.equal(stems.find((stem) => stem.name === 'organ')?.aliasRisk, true);
});

test('a track high-pass and shelves reshape only that stem', () => {
  const build = (extra: Record<string, unknown>) =>
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [
        { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'C3:16 C3:16', ...extra },
        { name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C5:16 E5:16' },
      ],
    });

  const plain = renderLoop(build({}), { post: [], minutes: 0.05, withWav: false });
  const cut = renderLoop(build({ highpassHz: 700 }), {
    post: [],
    minutes: 0.05,
    withWav: false,
  });
  const bassPlain = plain.report.stems?.find((stem) => stem.name === 'bass');
  const bassCut = cut.report.stems?.find((stem) => stem.name === 'bass');
  assert.ok(
    (bassCut?.bands.low ?? 1) < (bassPlain?.bands.low ?? 0),
    'high-pass must lower the bass low band',
  );
  assert.deepEqual(
    plain.report.stems?.find((stem) => stem.name === 'lead'),
    cut.report.stems?.find((stem) => stem.name === 'lead'),
    'a track EQ must not leak into another stem',
  );

  const dark = renderLoop(build({ highShelf: { hz: 3000, gainDb: -18 } }), {
    post: [],
    minutes: 0.05,
    withWav: false,
  });
  const bright = renderLoop(build({ highShelf: { hz: 3000, gainDb: 18 } }), {
    post: [],
    minutes: 0.05,
    withWav: false,
  });
  assert.ok(
    (dark.report.stems?.find((stem) => stem.name === 'bass')?.centroidHz ?? 0) <
      (bright.report.stems?.find((stem) => stem.name === 'bass')?.centroidHz ?? 0),
  );

  const noop = renderLoop(build({ lowShelf: 0, highShelf: 0 }), {
    post: [],
    minutes: 0.05,
  });
  assert.deepEqual(Array.from(noop.left), Array.from(plain.left));
});

test('master width and monoBelowHz are opt-in and deterministic', () => {
  const score = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 2,
    tracks: [
      { name: 'low', waveform: 'triangle', pan: -1, pattern: 'C2:16 C2:16' },
      { name: 'high', waveform: 'triangle', pan: 1, pattern: 'C5:16 E5:16' },
    ],
  });
  const plain = renderLoop(score, { post: [], minutes: 0.05 });
  const same = renderLoop(score, { post: [], width: 1, minutes: 0.05 });
  const mono = renderLoop(score, { post: [], width: 0, minutes: 0.05 });
  const wide = renderLoop(score, { post: [], width: 2, minutes: 0.05 });
  const centred = renderLoop(score, { post: [], monoBelowHz: 300, minutes: 0.05 });

  assert.deepEqual(Array.from(plain.left), Array.from(same.left));
  assert.deepEqual(Array.from(mono.left), Array.from(mono.right));
  assert.ok(wide.report.width > plain.report.width);
  assert.ok(centred.report.width < plain.report.width);
  assert.ok(centred.report.width > 0, 'only the low band folds to mono');

  const wideMono = renderLoop(score, { post: [], monoBelowHz: 300, width: 2, minutes: 0.05 });
  const again = renderLoop(score, { post: [], monoBelowHz: 300, width: 2, minutes: 0.05 });
  assert.deepEqual(Array.from(wideMono.left), Array.from(again.left));
});

test('reverb predelay, wet filters, and modulation are opt-in and deterministic', () => {
  const score = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 2,
    tracks: [{ waveform: 'saw', pattern: 'C2:4 -:12 C3:4 -:12' }],
  });
  const basePost = [{ type: 'reverb' as const, wet: 0.6, room: 0.8, damp: 0.4 }];
  const base = renderLoop(score, { post: basePost, minutes: 0.05, withWav: false });
  const explicitBase = renderLoop(score, {
    post: [{ ...basePost[0], predelayMs: 0, modDepth: 0 }],
    minutes: 0.05,
    withWav: false,
  });
  assert.deepEqual(Array.from(base.left), Array.from(explicitBase.left));

  const predelayed = renderLoop(score, {
    post: [{ ...basePost[0], predelayMs: 80 }],
    minutes: 0.05,
    withWav: false,
  });
  const lowCut = renderLoop(score, {
    post: [{ ...basePost[0], lowCutHz: 500 }],
    minutes: 0.05,
    withWav: false,
  });
  const highCut = renderLoop(score, {
    post: [{ ...basePost[0], highCutHz: 1200 }],
    minutes: 0.05,
    withWav: false,
  });
  const modulated = renderLoop(score, {
    post: [{ ...basePost[0], modDepth: 0.6, modRateHz: 0.8 }],
    minutes: 0.05,
    withWav: false,
  });

  assert.notDeepEqual(Array.from(base.left), Array.from(predelayed.left));
  assert.ok(lowCut.report.lowMid < base.report.lowMid, 'low-cut must remove wet low-mid');
  assert.ok(highCut.report.centroidHz < base.report.centroidHz, 'high-cut must darken the wet return');
  assert.notDeepEqual(Array.from(base.left), Array.from(modulated.left));
  const again = renderLoop(score, {
    post: [{ ...basePost[0], modDepth: 0.6, modRateHz: 0.8 }],
    minutes: 0.05,
    withWav: false,
  });
  assert.deepEqual(Array.from(modulated.left), Array.from(again.left));
});

test('targets report deviations without inventing a total score', () => {
  const low = analyseAudio(sine(200), sine(200), RATE, {
    target: { lowMidMax: 0.2, crestMin: 20 },
  });
  assert.deepEqual(
    low.target?.checks.map((check) => check.field),
    ['lowMid', 'crest'],
  );
  assert.equal(low.target?.passed, 0);
  assert.ok(low.findings.some((finding) => finding.kind === 'target'));
  assert.match(formatReport(low), /report target custom: 0\/2 checks in range/);

  const clean = analyseAudio(sine(1000), sine(1000), RATE, {
    target: { lowMidMax: 0.2, harshMax: 0.2, crestMin: 3 },
  });
  assert.equal(clean.target?.passed, 3);
  assert.ok(!clean.findings.some((finding) => finding.kind === 'target'));

  const named = analyseAudio(sine(1000), sine(1000), RATE, { target: 'soft' });
  assert.equal(named.target?.name, 'soft');
  assert.equal(named.target?.checks.length, 5);

  assert.ok(resolveTarget('bright') !== undefined);
  assert.throws(() => resolveTarget('warm' as never), /unknown target/);
  assert.throws(() => resolveTarget({ lowMidMax: 2 } as never), /between 0 and 1/);
  assert.throws(() => resolveTarget({ width: [0.5, 0.2] } as never), /min must not exceed max/);
  assert.throws(() => resolveTarget({ bass: 1 } as never), /not a known range/);
  assert.throws(() => resolveTarget({} as never), /at least one/);
});

test('the soft style lands inside its own target profile', async () => {
  const raw = await readFile(new URL('../examples/m12-soft.json', import.meta.url), 'utf8');
  const output = renderLoop(parseScore(raw), {
    style: 'soft',
    target: 'soft',
    minutes: 0.05,
    withWav: false,
  });
  const report = output.report;
  assert.equal(report.target?.name, 'soft');
  assert.equal(report.target?.passed, report.target?.total, formatReport(report));
  assert.ok(!report.findings.some((finding) => finding.kind === 'target'));
  const profile = TARGETS.soft;
  const crest = report.peakDb - report.rmsDb;
  assert.ok(report.lowMid <= (profile.lowMidMax ?? 1));
  assert.ok(report.harsh <= (profile.harshMax ?? 1));
  assert.ok(crest >= (profile.crestMin ?? 0));
});

test('the soft style meets the profile on a score with no per-track EQ', () => {
  const score = parseScore({
    bpm: 80,
    stepsPerBeat: 4,
    bars: 4,
    tracks: [
      { name: 'bass', role: 'bass', pattern: 'C2:8 G2:8 C2:8 A2:8' },
      { name: 'pad', role: 'pad', pattern: '[C4,E4,G4]:16 [F4,A4,C5]:16' },
      { name: 'lead', role: 'lead', pattern: 'C5:4 E5:4 G5:4 E5:4' },
      { name: 'drums', role: 'drums', pattern: 'K:2 H:2 S:2 H:2' },
    ],
  });
  const output = renderLoop(score, {
    style: 'soft',
    target: 'soft',
    minutes: 0.05,
    withWav: false,
  });
  assert.equal(
    output.report.target?.passed,
    output.report.target?.total,
    formatReport(output.report),
  );
});

test('both tools accept quality, master options, and a target', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-m2-'));
  try {
    const target = join(directory, 'loop');
    const rendered = await executeRender({
      score: JSON.stringify({
        bpm: 120,
        bars: 1,
        tracks: [{ waveform: 'saw', pattern: 'C7:8' }],
      }),
      quality: 'clean',
      width: 0.8,
      monoBelowHz: 120,
      target: 'soft',
      minutes: 0.05,
      out: target,
      detail: 'raw',
    });
    assert.match(rendered, /report target soft:/);
    assert.match(rendered, /report stems/);
    const artifact = JSON.parse(await readFile(join(directory, 'loop.analysis.json'), 'utf8'));
    assert.equal(artifact.analysis.target.name, 'soft');
    assert.ok(artifact.analysis.stems[0].aliasRisk === false);

    const analyzed = await executeAnalyze({
      path: `${target}.wav`,
      target: { lowMidMax: 0.3, lufs: [-30, 0] },
      detail: 'raw',
    });
    assert.match(analyzed, /report target custom:/);
    const wavArtifact = JSON.parse(
      await readFile(join(directory, 'loop.wav.analysis.json'), 'utf8'),
    );
    assert.equal(wavArtifact.analysis.target.name, 'custom');

    await assert.rejects(
      () => executeAnalyze({ path: `${target}.wav`, target: 'warm' }),
      /unknown target/,
    );
    await assert.rejects(
      () => executeRender({ score: JSON.stringify({ tracks: [{ pattern: 'C4:4' }] }), quality: 'hifi' }),
      /unknown quality/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the score parser accepts per-track high-pass and shelves with clear bounds', () => {
  const parsed = parseScore({
    bpm: 120,
    bars: 1,
    tracks: [
      {
        name: 'pad',
        highpassHz: 300,
        lowShelf: -4,
        highShelf: { hz: 5000, gainDb: -3 },
        pattern: 'C4:4',
      },
    ],
  });
  const track = parsed.tracks[0];
  assert.equal(track?.highpassHz, 300);
  assert.deepEqual(track?.lowShelf, { hz: 250, gainDb: -4 });
  assert.deepEqual(track?.highShelf, { hz: 5000, gainDb: -3 });

  assert.throws(
    () =>
      parseScore({
        tracks: [{ highpassHz: 5000, pattern: 'C4:4' }],
      }),
    /highpassHz must be between/,
  );
  assert.throws(
    () =>
      parseScore({
        tracks: [{ lowShelf: 30, pattern: 'C4:4' }],
      }),
    /lowShelf must be between/,
  );
  assert.throws(
    () =>
      parseScore({
        tracks: [{ highShelf: { hz: 4000, gainDb: 0, q: 1 }, pattern: 'C4:4' }],
      }),
    /unknown field "q"/,
  );
});

test('the soft style selects clean for an explicit chip voice', () => {
  const score = parseScore({
    bpm: 120,
    bars: 1,
    tracks: [{ name: 'lead', instrument: { type: 'chip', waveform: 'saw' }, pattern: 'C7:8' }],
  });
  const soft = renderLoop(score, { style: 'soft', minutes: 0.05, withWav: false });
  const pico = renderLoop(score, {
    style: 'soft',
    quality: 'pico',
    minutes: 0.05,
    withWav: false,
  });
  assert.equal(soft.report.stems?.[0]?.aliasRisk, false);
  assert.equal(pico.report.stems?.[0]?.aliasRisk, true);
});
