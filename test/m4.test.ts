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

  // A target above the hearing-safety ceiling is an error, not a louder render.
  assert.throws(
    () => renderLoop(mixed, { post: [{ type: 'loudness', targetLufs: -6 }], minutes: 0.05 }),
    /hearing-safety ceiling/,
  );

  // Within the ceiling, the limiter still holds its own ceiling.
  const hot = renderLoop(mixed, {
    post: [
      { type: 'loudness', targetLufs: -9 },
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
  assert.throws(() => renderLoop(mixed, { style: 'orchestral' as never }), /unknown style/);
});

test('an explicit chip instrument renders exactly like the legacy waveform', () => {
  const legacy = parseScore({
    tracks: [{ role: 'lead', waveform: 'saw', pattern: 'C4:4 E4:4 G4:4' }],
  });
  const explicit = parseScore({
    tracks: [{ role: 'lead', instrument: { type: 'chip', waveform: 'saw' }, pattern: 'C4:4 E4:4 G4:4' }],
  });
  const a = renderLoop(legacy, { post: [], minutes: 0.05 });
  const b = renderLoop(explicit, { post: [], minutes: 0.05 });
  assert.ok(Buffer.from(a.wav).equals(Buffer.from(b.wav)), 'chip instruments must keep the old path');

  // The track-level legacy field wins when both it and a chip instrument name a waveform.
  const overridden = parseScore({
    tracks: [
      {
        role: 'lead',
        waveform: 'saw',
        instrument: { type: 'chip', waveform: 'pulse' },
        pattern: 'C4:4 E4:4 G4:4',
      },
    ],
  });
  assert.ok(Buffer.from(renderLoop(overridden, { post: [], minutes: 0.05 }).wav).equals(Buffer.from(a.wav)));
});

test('additive partials take a phase, so the model can design the shape', () => {
  const voice = (partials: unknown) =>
    renderLoop(
      parseScore({
        bpm: 120,
        bars: 1,
        tracks: [{ role: 'lead', instrument: { type: 'additive', partials }, pattern: 'C4:8 C4:8' }],
      }),
      { post: [], minutes: 0.05 },
    );

  // A square is odd harmonics with alternating signs; a 25% pulse keeps an even
  // harmonic (h=2), which no amplitude-only series of the same level reaches.
  const pulse = Array.from({ length: 8 }, (_, index) => Math.sin((Math.PI * (index + 1)) / 4) / (index + 1));
  const square = voice([1, 0, 1 / 3, 0, 0.2, 0, 1 / 7, 0]);
  const narrow = voice(pulse);
  assert.ok(
    narrow.report.centroidHz > square.report.centroidHz,
    `pulse centroid ${narrow.report.centroidHz} vs square ${square.report.centroidHz}`,
  );

  // A negative amplitude is the same wave mirrored, so it must equal the
  // explicit 180-degree form sample for sample.
  const signed = voice([1, -0.5, 1 / 3]);
  const spelled = voice([
    [1, 0],
    [0.5, 180],
    [1 / 3, 0],
  ]);
  assert.ok(Buffer.from(signed.wav).equals(Buffer.from(spelled.wav)), 'signed and tuple phases must agree');

  // Phase changes the shape, not the level: the table is peak-normalised.
  const inPhase = voice([1, 0.5]);
  const quarterTurn = voice([
    [1, 0],
    [0.5, 90],
  ]);
  assert.ok(!Buffer.from(inPhase.wav).equals(Buffer.from(quarterTurn.wav)), 'phase must reach the table');
  assert.ok(Math.abs(inPhase.report.peakDb - quarterTurn.report.peakDb) <= 0.5, 'phase must not move the peak');
});

test('studio and lofi change the voice while the score stays the same', () => {
  const plain = renderLoop(mixed, { post: [], minutes: 0.05 });
  const studio = renderLoop(mixed, { style: 'studio', minutes: 0.05 });
  const lofi = renderLoop(mixed, { style: 'lofi', minutes: 0.05 });
  assert.equal(studio.loopSamples, plain.loopSamples);
  assert.ok(!Buffer.from(studio.wav).equals(Buffer.from(plain.wav)), 'studio must change the timbre');
  assert.ok(studio.report.peakDb <= -0.9);
  assert.ok(lofi.report.peakDb <= -0.9);

  // An explicit track instrument outranks the style's role default.
  const studioDry = renderLoop(mixed, { style: 'studio', post: [], minutes: 0.05 });
  const pinned = parseScore({
    ...rawScore,
    tracks: rawScore.tracks.map((track) =>
      track.name === 'lead' ? { ...track, instrument: { type: 'chip', waveform: 'pulse' } } : track,
    ),
  });
  const pinnedDry = renderLoop(pinned, { style: 'studio', post: [], minutes: 0.05 });
  assert.ok(
    !Buffer.from(pinnedDry.wav).equals(Buffer.from(studioDry.wav)),
    'track.instrument must outrank the style default',
  );
});

test('drum pitch raises the kick spectrum and decay shortens the tail', () => {
  const kick = (pattern: string) =>
    renderLoop(
      parseScore({ bpm: 120, bars: 1, tracks: [{ role: 'drums', pattern }] }),
      { post: [], minutes: 0.05 },
    );
  const stock = kick('K:4 -:4');
  const pitched = kick('K:4~pitch(12) -:4');
  assert.ok(
    pitched.report.centroidHz > stock.report.centroidHz,
    `pitched ${pitched.report.centroidHz} vs ${stock.report.centroidHz}`,
  );

  const short = kick('K:4~decay(4) -:4');
  assert.ok(short.report.rmsDb < stock.report.rmsDb, 'faster decay must lower the tail energy');
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
  await assert.rejects(
    () => executeRender({ score: JSON.stringify(rawScore), style: 'orchestral' }),
    /unknown style/,
  );
  await assert.rejects(
    () => executeRender({ score: JSON.stringify(rawScore), post: [{ type: 'flanger' }] as never }),
    /must be tape, slow, lowpass, highpass, reverb/,
  );
});


test('fixed renders keep their golden hashes', () => {
  const hashes = {
    // Hashes moved when the 16-bit conversion gained TPDF dither, when the post
    // reverb stopped folding its dry path to mono, and when track sends became
    // stereo (the mixed fixture has a panned send).
    dry: '798d8716038234daf2ec17986db9ca9e460e2667fe5d5cc77c1d5deff4787bb1',
    classic: 'c6ecf45d709213ef08b6cdaa0614f8e397d5ead04c06185610aed1f63b931079',
    hitech: 'a7919483ad100d7a8d0facab18b5c3f2cf4be79d7f24db030d337ddf75aad86a',
  };
  const digest = (options: Parameters<typeof renderLoop>[1]) =>
    createHash('sha256').update(renderLoop(mixed, options).wav).digest('hex');
  assert.equal(digest({ post: [], minutes: 0.05 }), hashes.dry);
  assert.equal(digest({ minutes: 0.05 }), hashes.classic);
  assert.equal(digest({ style: 'hitech', minutes: 0.05 }), hashes.hitech);
});
