import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAnalyze, executeRender } from '../src/app/render-service.ts';
import { analyseAudio, decodeWav, renderLoop } from '../src/features/render/feature.ts';
import { dbToGain } from '../src/features/render/master.ts';
import { parseScore } from '../src/features/score/feature.ts';

const RATE = 44100;

const rawScore = {
  bpm: 120,
  stepsPerBeat: 4,
  bars: 2,
  tracks: [
    { name: 'drums', role: 'drums', pattern: 'K:1 H:1 S:1 H:1 K:1 H:1 S:1 H:1' },
    { name: 'bass', waveform: 'saw', pattern: 'C2:4 C2:4 C2:4 C2:4', pan: -0.3 },
    { name: 'lead', waveform: 'pulse', pattern: 'C4:2 E4:2 G4:2 C5:2', pan: 0.4, send: 0.2 },
  ],
};
const mixed = parseScore(rawScore);

function decodedPeak(wav: Uint8Array): number {
  const { left, right } = decodeWav(wav);
  let peak = 0;
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i += 1) {
      peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }
  }
  return peak;
}

function crest(report: { peakDb: number; rmsDb: number }): number {
  return report.peakDb - report.rmsDb;
}

test('every render carries a report and the default chain is unchanged', () => {
  const implicit = renderLoop(mixed, { minutes: 0.05 });
  const classic = renderLoop(mixed, { preset: 'classic', minutes: 0.05 });
  assert.ok(Buffer.from(implicit.wav).equals(Buffer.from(classic.wav)));
  assert.equal(implicit.report.seconds, implicit.loopSeconds);
  assert.ok(Number.isFinite(implicit.report.peakDb));
  assert.ok(Number.isFinite(implicit.report.lufs));
  assert.ok(implicit.report.centroidHz > 0);
  assert.ok(Number.isFinite(implicit.report.width));
  assert.ok(implicit.report.onsetPerSecond > 0);
  assert.deepEqual(implicit.report.sections, []);
});

test('loudness normalisation hits the target and the limiter holds its ceiling', () => {
  const normalised = renderLoop(mixed, {
    post: [
      { type: 'loudness', targetLufs: -14 },
      { type: 'limiter', ceilingDb: -1 },
    ],
    minutes: 0.05,
  });
  assert.ok(
    Math.abs(normalised.report.lufs + 14) <= 1,
    `LUFS ${normalised.report.lufs.toFixed(2)} missed -14`,
  );
  assert.ok(normalised.report.peakDb <= -0.9, `peak ${normalised.report.peakDb}`);

  // A deliberately hot target must be caught by the limiter, not by clipping.
  const hot = renderLoop(mixed, {
    post: [
      { type: 'loudness', targetLufs: -6 },
      { type: 'limiter', ceilingDb: -3 },
    ],
    minutes: 0.05,
  });
  assert.ok(
    decodedPeak(hot.wav) <= dbToGain(-3) + 1e-3,
    `decoded peak ${decodedPeak(hot.wav)} exceeded -3 dBFS`,
  );
  assert.ok(hot.report.peakDb <= -2.9, `report peak ${hot.report.peakDb}`);
});

test('saturation lowers the crest factor and tilt moves the spectral centroid', () => {
  const dry = renderLoop(mixed, { post: [], minutes: 0.05 });
  const saturated = renderLoop(mixed, {
    post: [{ type: 'saturate', drive: 0.9, mix: 1 }],
    minutes: 0.05,
  });
  assert.ok(
    crest(saturated.report) < crest(dry.report) - 3,
    `crest dry ${crest(dry.report).toFixed(1)} saturated ${crest(saturated.report).toFixed(1)}`,
  );

  const bright = renderLoop(mixed, {
    post: [{ type: 'tilt', tiltDb: 12 }],
    minutes: 0.05,
  });
  const dark = renderLoop(mixed, {
    post: [{ type: 'tilt', tiltDb: -12 }],
    minutes: 0.05,
  });
  assert.ok(bright.report.centroidHz > dry.report.centroidHz, 'tilt +12 must brighten');
  assert.ok(dark.report.centroidHz < dry.report.centroidHz, 'tilt -12 must darken');
  assert.ok(bright.report.bands.air > dark.report.bands.air);
});

test('bus compression shrinks the energy range between sections', () => {
  const dynamics = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ name: 'pad', waveform: 'saw', pattern: 'C3:8 C3:8' }],
    arrangement: [
      { name: 'quiet', bars: 2, gain: 0.15 },
      { name: 'loud', bars: 2, gain: 1 },
    ],
  });
  const spread = (sections: readonly { rmsDb: number }[]): number =>
    Math.max(...sections.map((section) => section.rmsDb)) -
    Math.min(...sections.map((section) => section.rmsDb));

  const dry = renderLoop(dynamics, { post: [] });
  const glued = renderLoop(dynamics, {
    post: [
      { type: 'compress', thresholdDb: -30, ratio: 8, attack: 0.005, release: 0.2 },
      { type: 'limiter', ceilingDb: -1 },
    ],
  });

  assert.deepEqual(dry.report.sections.map((section) => section.name), ['quiet', 'loud']);
  assert.ok(spread(dry.report.sections) > 12, `dry spread ${spread(dry.report.sections)}`);
  assert.ok(
    spread(glued.report.sections) < spread(dry.report.sections) / 3,
    `glued spread ${spread(glued.report.sections)} vs dry ${spread(dry.report.sections)}`,
  );
});

test('the report flags dark, narrow, and sparse material', () => {
  const dull = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [{ waveform: 'triangle', pattern: 'C4:16 C4:16' }],
    }),
    { post: [{ type: 'lowpass', cutoffHz: 300 }], minutes: 0.05 },
  );
  const text = dull.report.warnings.join(' | ');
  assert.match(text, /dark:/);
  assert.match(text, /narrow:/);
  assert.match(text, /sparse:/);

  const drums = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [{ role: 'drums', pattern: 'K:1 H:1 S:1 H:1 K:1 H:1 S:1 H:1', pan: -0.5 }],
    }),
    { post: [], minutes: 0.05 },
  );
  const drumWarnings = drums.report.warnings.join(' | ');
  assert.doesNotMatch(drumWarnings, /dark:/);
  assert.doesNotMatch(drumWarnings, /narrow:/);
  assert.ok(drums.report.centroidHz > 2000, `drum centroid ${drums.report.centroidHz}`);
});

test('sections that do not change energy raise the flat-sections warning', () => {
  const uniform = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
    arrangement: [
      { name: 'a', bars: 2 },
      { name: 'b', bars: 2 },
    ],
  });
  const output = renderLoop(uniform, { post: [] });
  assert.equal(output.report.sections.length, 2);
  assert.match(output.report.warnings.join(' | '), /flat-sections:/);

  const contrast = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ name: 'lead', waveform: 'pulse', pattern: 'C4:2 E4:2' }],
    arrangement: [
      { name: 'intro', bars: 2, mute: ['lead'] },
      { name: 'drop', bars: 2 },
    ],
  });
  const song = renderLoop(contrast, { post: [] });
  const [intro, drop] = song.report.sections;
  assert.ok(intro && drop);
  assert.ok(drop.rmsDb > intro.rmsDb + 8, `intro ${intro.rmsDb} drop ${drop.rmsDb}`);
  assert.doesNotMatch(song.report.warnings.join(' | '), /flat-sections:/);
});

function sine(frequency: number, amplitude = 0.5, seconds = 1): Float32Array {
  return Float32Array.from(
    { length: Math.round(RATE * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE),
  );
}

test('analysis reads frequency, width, and transients from known signals', () => {
  const left = sine(1000);
  const silent = new Float32Array(left.length);
  const hardLeft = analyseAudio(left, silent, RATE);
  assert.ok(Math.abs(hardLeft.centroidHz - 1000) < 30, `centroid ${hardLeft.centroidHz}`);
  assert.ok(hardLeft.bands.mid > 0.95, `mid ${hardLeft.bands.mid}`);
  assert.ok(hardLeft.width > 0.9, `width ${hardLeft.width}`);
  assert.ok(hardLeft.onsetPerSecond < 0.5, `onsets ${hardLeft.onsetPerSecond}`);

  const centred = analyseAudio(left, left, RATE);
  assert.ok(centred.width < 0.01, `centred width ${centred.width}`);
  assert.ok(Math.abs(centred.lufs - hardLeft.lufs) < 3.1, 'two channels is about 3 LU louder');

  const clicks = new Float32Array(RATE);
  for (let hit = 0; hit < 10; hit += 1) {
    const start = Math.round(hit * 0.1 * RATE);
    for (let i = 0; i < 300; i += 1) {
      clicks[start + i] = Math.exp(-i / 60) * Math.sin(i / 3);
    }
  }
  const transient = analyseAudio(clicks, clicks, RATE);
  assert.ok(
    transient.onsetPerSecond > 6 && transient.onsetPerSecond < 12,
    `onsets ${transient.onsetPerSecond}`,
  );
  assert.ok(transient.centroidHz > 1500, `click centroid ${transient.centroidHz}`);
});

test('styles fill the post chain without touching the mode', () => {
  const dry = renderLoop(mixed, { post: [], minutes: 0.05 });
  const chip = renderLoop(mixed, { style: 'chip', minutes: 0.05 });
  assert.ok(Buffer.from(chip.wav).equals(Buffer.from(dry.wav)), 'chip must be dry');
  assert.equal(chip.loopSamples, dry.loopSamples);

  const hitech = renderLoop(mixed, { style: 'hitech', minutes: 0.05 });
  assert.ok(Math.abs(hitech.report.lufs + 14) <= 1.5, `hitech LUFS ${hitech.report.lufs}`);
  assert.ok(hitech.report.peakDb <= -0.9);

  const ambient = renderLoop(mixed, { style: 'ambient', minutes: 0.05 });
  assert.ok(ambient.loopSamples > dry.loopSamples, 'ambient slows the loop');
  assert.ok(ambient.report.width > 0, 'ambient keeps a stereo image');

  assert.throws(
    () => renderLoop(mixed, { style: 'chip', preset: 'classic' }),
    /style and preset cannot be combined/,
  );
  assert.throws(() => renderLoop(mixed, { style: 'lofi' as never }), /unknown style/);
});

test('decodeWav round-trips a render and the analyze tool re-reads it', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-m4-'));
  try {
    const target = join(directory, 'render');
    const summary = await executeRender({ score: JSON.stringify(rawScore), minutes: 0.05, out: target });
    assert.match(summary, /Rendered/);
    assert.match(summary, /report peak .* · RMS .* · LUFS /);
    assert.match(summary, /report warnings:/);

    const decoded = decodeWav(await readFile(`${target}.wav`));
    assert.equal(decoded.rate, RATE);
    assert.equal(decoded.left.length, decoded.right.length);

    const analyzed = await executeAnalyze({ path: `${target}.wav` });
    assert.match(analyzed, /Analyzed/);
    assert.match(analyzed, /LUFS -?\d+\.\d/);
    assert.match(analyzed, /spectrum centroid \d+ Hz/);
    assert.match(analyzed, /space width \d+\.\d+/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the analyze tool rejects missing files and non-PCM input', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-m4-bad-'));
  try {
    await assert.rejects(() => executeAnalyze({ path: join(directory, 'missing.wav') }), /ENOENT/);
    const junk = join(directory, 'not-a-wav.wav');
    await writeFile(junk, 'definitely not audio');
    await assert.rejects(() => executeAnalyze({ path: junk }), /not a WAV file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the render service validates style names and post types', async () => {
  await assert.rejects(() => executeRender({ score: JSON.stringify(rawScore), style: 'lofi' }), /unknown style/);
  await assert.rejects(
    () => executeRender({ score: JSON.stringify(rawScore), post: [{ type: 'flanger' }] as never }),
    /must be tape, slow, lowpass, reverb/,
  );
});


test('fixed renders keep their golden hashes', () => {
  const hashes = {
    dry: '2e20c6aab672c83476543299d3625ba0e99fcf8368e8720cebbf0a5687e8ac58',
    classic: '79663abacb6006e93cd2edd25a0bc89c666184b4cfe9411421dd295d631332f4',
    hitech: '4175722226ad6c64df040b610e075cbb40e575f55c9e66c6f1f470c327a68ff6',
  };
  const digest = (options: Parameters<typeof renderLoop>[1]) =>
    createHash('sha256').update(renderLoop(mixed, options).wav).digest('hex');
  assert.equal(digest({ post: [], minutes: 0.05 }), hashes.dry);
  assert.equal(digest({ minutes: 0.05 }), hashes.classic);
  assert.equal(digest({ style: 'hitech', minutes: 0.05 }), hashes.hitech);
});
