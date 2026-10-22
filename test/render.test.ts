import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseScore } from '../src/features/score/feature.ts';
import { renderLoop, type SampleSource } from '../src/features/render/feature.ts';

const score = parseScore({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [
    { waveform: 'pulse', volume: 5, pattern: 'C3:4 E3:4 G3:4 C4:4' },
    { waveform: 'triangle', volume: 4, pattern: 'C2:8 G2:8' },
  ],
});

function wavInfo(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return {
    riff: String.fromCharCode(...wav.slice(0, 4)),
    wave: String.fromCharCode(...wav.slice(8, 12)),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}

function peak(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let max = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    max = Math.max(max, Math.abs(view.getInt16(offset, true)));
  }
  return max;
}

function fullScaleSamples(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let count = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    const magnitude = Math.abs(view.getInt16(offset, true));
    if (magnitude >= 32767) count += 1;
  }
  return count;
}

test('renders a stereo 44.1 kHz PCM WAV with audio in it', () => {
  const output = renderLoop(score, { preset: 'classic', speed: 1, minutes: 0.05 });
  const info = wavInfo(output.wav);
  assert.equal(info.riff, 'RIFF');
  assert.equal(info.wave, 'WAVE');
  assert.equal(info.channels, 2);
  assert.equal(info.rate, 44100);
  assert.equal(info.bits, 16);
  assert.equal(info.dataBytes, output.wav.length - 44);
  assert.ok(peak(output.wav) > 1000, 'expected audible samples');

  assert.equal(output.loopSamples, 44100 * 2);
  assert.ok(output.durationSeconds >= 4);
  assert.equal(output.durationSeconds, info.dataBytes / 4 / 44100);
});

test('slowing down lengthens the loop and keeps the render deterministic', () => {
  const normal = renderLoop(score, { speed: 1, minutes: 0.05 });
  const slow = renderLoop(score, { speed: 0.8, minutes: 0.05 });
  assert.ok(slow.loopSamples > normal.loopSamples);
  assert.ok(Math.abs(slow.loopSamples - Math.round(normal.loopSamples / 0.8)) <= 1);

  const again = renderLoop(score, { speed: 1, minutes: 0.05 });
  assert.ok(Buffer.from(normal.wav).equals(Buffer.from(again.wav)));
});

test('the default preset keeps a full final pass with no zero-padded seam', () => {
  const output = renderLoop(score, { preset: 'classic', minutes: 0.05 });
  const left = monoOf(output.wav);
  const n = output.loopSamples;
  assert.ok(n > 0 && n <= left.length);

  let maxJump = 0;
  for (let i = 1; i < n; i += 1) {
    maxJump = Math.max(maxJump, Math.abs((left[i] ?? 0) - (left[i - 1] ?? 0)));
  }
  const seam = Math.abs((left[0] ?? 0) - (left[n - 1] ?? 0));
  assert.notEqual(left[n - 1], 0, 'last sample must not be zero-padding');
  assert.ok(seam <= Math.max(0.02, maxJump * 2), `seam ${seam}, max jump ${maxJump}`);
});

test('a zero-wet reverb bypasses instead of collapsing the stereo image', () => {
  const panned = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [
      { waveform: 'triangle', pattern: 'C4:4', pan: -1 },
      { waveform: 'triangle', pattern: 'E4:4', pan: 1 },
    ],
  });
  const dry = renderLoop(panned, { post: [], minutes: 0.05 });
  const wetZero = renderLoop(panned, {
    post: [{ type: 'reverb', wet: 0 }],
    minutes: 0.05,
  });

  assert.deepEqual(Array.from(wetZero.left), Array.from(dry.left));
  assert.deepEqual(Array.from(wetZero.right), Array.from(dry.right));
  assert.notDeepEqual(Array.from(wetZero.left), Array.from(wetZero.right));
});

test('a post reverb keeps the dry stereo image instead of folding the bus to mono', () => {
  const panned = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 2,
    tracks: [
      { waveform: 'triangle', pattern: 'C4:2 E4:2 G4:2 C5:2', pan: -1 },
      { waveform: 'pulse', pattern: 'C3:2 E3:2 G3:2 C4:2', pan: 1 },
    ],
  });
  const dry = renderLoop(panned, { post: [], minutes: 0.05 });
  assert.ok(dry.report.width > 0.4, `dry width ${dry.report.width}`);

  for (const wet of [0.1, 0.3, 0.45]) {
    const out = renderLoop(panned, {
      post: [{ type: 'reverb', wet, room: 0.9, damp: 0.5 }],
      minutes: 0.05,
    });
    assert.ok(
      out.report.width > dry.report.width * 0.85,
      `wet ${wet}: width ${out.report.width.toFixed(3)} collapsed from dry ${dry.report.width.toFixed(3)}`,
    );
    assert.ok(
      !out.report.warnings.some((warning) => warning.startsWith('narrow')),
      `wet ${wet}: unexpected narrow warning ${JSON.stringify(out.report.warnings)}`,
    );
  }
});

test('post steps are applied in the order given', () => {
  const lowpassThenReverb = renderLoop(score, {
    post: [
      { type: 'lowpass', cutoffHz: 600 },
      { type: 'reverb', wet: 0.5, room: 0.5, damp: 0.5 },
    ],
    minutes: 0.05,
  });
  const reverbThenLowpass = renderLoop(score, {
    post: [
      { type: 'reverb', wet: 0.5, room: 0.5, damp: 0.5 },
      { type: 'lowpass', cutoffHz: 600 },
    ],
    minutes: 0.05,
  });
  assert.equal(lowpassThenReverb.loopSamples, reverbThenLowpass.loopSamples);
  assert.notEqual(
    Buffer.from(lowpassThenReverb.wav).toString('base64'),
    Buffer.from(reverbThenLowpass.wav).toString('base64'),
  );
});

test('toneHz is a low-pass shortcut and invalid presets fail clearly', () => {
  const bright = renderLoop(score, { post: [], minutes: 0.05 });
  const dark = renderLoop(score, { post: [], toneHz: 300, minutes: 0.05 });
  assert.notEqual(
    Buffer.from(bright.wav).toString('base64'),
    Buffer.from(dark.wav).toString('base64'),
  );
  assert.throws(() => renderLoop(score, { preset: 'lofi' as never }), /unknown preset/);
});

test('every preset produces a finite, non-silent loop', () => {
  for (const preset of ['classic', 'dreamy', 'tape'] as const) {
    const output = renderLoop(score, { preset, minutes: 0.05 });
    assert.ok(output.loopSamples > 0);
    assert.ok(peak(output.wav) > 500, preset);
    assert.ok(Number.isFinite(output.durationSeconds));
  }
});

function channelStats(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let sum = 0;
  let squares = 0;
  let crossings = 0;
  let previous = 0;
  let count = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 4) {
    const value = view.getInt16(offset, true);
    sum += value;
    squares += value * value;
    if (count > 0 && ((value < 0) !== (previous < 0))) crossings += 1;
    previous = value;
    count += 1;
  }
  return { mean: sum / count, rms: Math.sqrt(squares / count), crossings, count };
}

// A DC-only or constant signal passes a peak check, so assert the output actually
// oscillates: non-zero mean is a bias bug and no zero crossings means one flat line.
test('output is zero-mean and oscillating, not a DC plateau', () => {
  for (const preset of ['classic', 'dreamy', 'tape'] as const) {
    const stats = channelStats(renderLoop(score, { preset, minutes: 0.05 }).wav);
    assert.ok(Math.abs(stats.mean) < 300, `${preset}: mean ${stats.mean.toFixed(0)}`);
    assert.ok(stats.rms > 400, `${preset}: rms ${stats.rms.toFixed(0)}`);
    assert.ok(stats.rms < 30000, `${preset}: clipped rms ${stats.rms.toFixed(0)}`);
    assert.ok(stats.crossings > stats.count / 200, `${preset}: only ${stats.crossings} crossings`);
  }
});

const loudVelocity = parseScore({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [{ waveform: 'pulse', volume: 7, pattern: 'C4:4 E4:4 G4:4 A4:4' }],
});

const softVelocity = parseScore({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [{ waveform: 'pulse', volume: 7, pattern: 'C4:4@2 E4:4@2 G4:4@2 A4:4@2' }],
});

test('per-note @volume changes the rendered level', () => {
  const loud = peak(renderLoop(loudVelocity, { speed: 1, minutes: 0.05 }).wav);
  const soft = peak(renderLoop(softVelocity, { speed: 1, minutes: 0.05 }).wav);
  // 7/7 versus 2/7 is a 3.5x gain difference.
  assert.ok(loud > soft * 3, `loud ${loud} vs soft ${soft}`);
  assert.ok(soft > 0, 'a quiet note must still be audible');
});

const pad = parseScore({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [{ waveform: 'saw', volume: 7, pattern: 'C3:8 C3:8' }],
});

const pluck = parseScore({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [
    {
      waveform: 'saw',
      volume: 7,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0.05, release: 0.02 },
      pattern: 'C3:8 C3:8',
    },
  ],
});

test('a decay envelope shortens the note without touching the attack', () => {
  const padStats = channelStats(renderLoop(pad, { speed: 1, minutes: 0.05 }).wav);
  const pluckStats = channelStats(renderLoop(pluck, { speed: 1, minutes: 0.05 }).wav);
  assert.ok(pluckStats.rms < padStats.rms * 0.5, `pluck rms ${pluckStats.rms.toFixed(0)}`);
  assert.ok(pluckStats.crossings > pluckStats.count / 200, 'pluck must still oscillate');
});

const fourLoudTracks = parseScore({
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: Array.from({ length: 4 }, () => ({
    waveform: 'square',
    volume: 7,
    pattern: 'C4:4 D4:4 E4:4 F4:4',
  })),
});

test('four loud tracks are attenuated instead of hard-clipped', () => {
  for (const preset of ['classic', 'dreamy', 'tape'] as const) {
    const wav = renderLoop(fourLoudTracks, { preset, speed: 1, minutes: 0.05 }).wav;
    const level = peak(wav);
    assert.equal(fullScaleSamples(wav), 0, `${preset}: samples at full scale`);
    // The ceiling is -1 dBFS plus one LSB of 16-bit TPDF dither.
    assert.ok(level <= Math.ceil(0.89 * 32767) + 1, `${preset}: peak ${level}`);
    // The sum of four full-volume tracks needs the trim, so the ceiling should
    // actually be reached rather than the test passing on a quiet render.
    assert.ok(level > 25000, `${preset}: peak ${level} never needed limiting`);
  }
});

function monoOf(wav: Uint8Array): Float32Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples = new Float32Array((wav.length - 44) / 4);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(44 + i * 4, true) / 32768;
  }
  return samples;
}

function zeroCrossingRate(samples: Float32Array, seconds: number): number {
  const length = Math.min(samples.length, Math.round(44100 * seconds));
  let crossings = 0;
  let previous = samples[0] ?? 0;
  for (let i = 1; i < length; i += 1) {
    const current = samples[i] ?? 0;
    if ((current < 0) !== (previous < 0)) crossings += 1;
    previous = current;
  }
  return crossings / Math.max(1, length);
}

function dryDrum(pattern: string) {
  const drumScore = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [{ role: 'drums', pattern }],
  });
  return monoOf(renderLoop(drumScore, { post: [], minutes: 0.05 }).wav);
}

test('drum voices are spectrally distinct without a melodic waveform', () => {
  const kick = dryDrum('K:1 -:1 -:1 -:1 -:1 -:1 -:1 -:1');
  const snare = dryDrum('S:1 -:1 -:1 -:1 -:1 -:1 -:1 -:1');
  const hat = dryDrum('H:1 -:1 -:1 -:1 -:1 -:1 -:1 -:1');

  const kickZcr = zeroCrossingRate(kick, 0.2);
  const snareZcr = zeroCrossingRate(snare, 0.2);
  const hatZcr = zeroCrossingRate(hat, 0.2);

  assert.ok(kickZcr < 0.01, `kick zcr ${kickZcr.toFixed(4)}`);
  assert.ok(snareZcr > kickZcr * 2, `snare zcr ${snareZcr.toFixed(4)} vs kick ${kickZcr.toFixed(4)}`);
  assert.ok(hatZcr > snareZcr, `hat zcr ${hatZcr.toFixed(4)} vs snare ${snareZcr.toFixed(4)}`);
  assert.ok(Math.sqrt(kick.reduce((sum, value) => sum + value * value, 0) / kick.length) > 0.02);
});

function dryDrumLoop(pattern: string) {
  const drumScore = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [{ role: 'drums', pattern }],
  });
  return renderLoop(drumScore, { post: [], withWav: false });
}

test('ghost hits are quieter, shorter, and darker than a normal hit', () => {
  const normal = dryDrumLoop('H:16').left;
  const ghost = dryDrumLoop('H:16~ghost').left;

  const normalTail = rmsBetween(normal, 0, 0.05);
  const ghostTail = rmsBetween(ghost, 0, 0.05);
  assert.ok(ghostTail < normalTail * 0.7, `ghost ${ghostTail.toFixed(4)} vs normal ${normalTail.toFixed(4)}`);
  assert.ok(
    zeroCrossingRate(ghost, 0.2) < zeroCrossingRate(normal, 0.2),
    'ghost should be darker than the normal hat',
  );
});

test('flam adds a second, quieter hit a few milliseconds later', () => {
  const normal = dryDrumLoop('H:16').left;
  const flam = dryDrumLoop('H:16~flam(40)').left;

  const normalTail = rmsBetween(normal, 0.025, 0.06);
  const flamTail = rmsBetween(flam, 0.025, 0.06);
  assert.ok(flamTail > normalTail * 3, `flam ${flamTail.toFixed(4)} vs normal ${normalTail.toFixed(4)}`);
});

test('roll subdivides one slot into evenly spaced hits and stays deterministic', () => {
  const normal = dryDrumLoop('K:16').left;
  const rolled = dryDrumLoop('K:16~roll4');
  const again = dryDrumLoop('K:16~roll4');

  for (const start of [0.5, 1, 1.5]) {
    const hit = rmsBetween(rolled.left, start + 0.01, start + 0.06);
    const rest = rmsBetween(normal, start + 0.01, start + 0.06);
    assert.ok(hit > 0.01, `roll hit at ${start}s is audible`);
    assert.ok(hit > rest * 10, `roll hit ${hit.toFixed(4)} vs normal ${rest.toFixed(4)}`);
  }
  assert.ok(Buffer.from(rolled.left.buffer).equals(Buffer.from(again.left.buffer)));
});

test('section energy lowers gain and filter cutoff, and fill raises the last bar', () => {
  const makeEnergy = (energy: number) =>
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'lead', waveform: 'pulse', pattern: 'C4:1' }],
      arrangement: [{ name: 'only', bars: 1, filter: 8000, energy }],
    });
  const quiet = renderLoop(makeEnergy(0), { post: [], withWav: false });
  const loud = renderLoop(makeEnergy(1), { post: [], withWav: false });
  assert.ok(quiet.report.centroidHz < loud.report.centroidHz * 0.7, 'energy 0 should be darker');
  assert.ok(rmsBetween(quiet.left, 0, 1) < rmsBetween(loud.left, 0, 1) * 0.7, 'energy 0 should be quieter');

  const filled = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      patterns: { main: 'K:4', fill: 'K:1 K:1 K:1 K:1' },
      tracks: [{ name: 'drums', role: 'drums', pattern: 'main' }],
      arrangement: [
        { name: 'main', bars: 1 },
        { name: 'drop', bars: 2, fill: { bars: 1, patterns: { drums: 'fill' } } },
      ],
    }),
    { post: [], withWav: false },
  );
  // main is 0-2 s, drop's normal bar is 2-4 s, and the fill bar is 4-6 s.
  const normalBar = rmsBetween(filled.left, 2, 4);
  const fillBar = rmsBetween(filled.left, 4, 6);
  assert.ok(fillBar > normalBar * 1.2, `fill ${fillBar.toFixed(4)} vs normal ${normalBar.toFixed(4)}`);
});

const songWithDrums = parseScore({
  mode: 'song',
  bpm: 120,
  stepsPerBeat: 4,
  tracks: [
    { name: 'drums', role: 'drums', pattern: 'K:1 -:1 H:1 -:1 S:1 -:1 H:1 -:1' },
    { name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'C4:4 E4:4 G4:4' },
  ],
  arrangement: [
    { name: 'intro', bars: 1, mute: ['drums'], filter: 800 },
    { name: 'drop', bars: 1, gain: 1.2 },
  ],
});

test('song mode follows the arrangement and ignores minutes', () => {
  const output = renderLoop(songWithDrums, { post: [], minutes: 0.05 });
  assert.equal(output.loopSamples, Math.round(songWithDrums.durationSeconds * 44100));
  assert.equal(output.durationSeconds, output.loopSamples / 44100);
  assert.ok(output.durationSeconds > 3.9, `song duration ${output.durationSeconds}`);

  const samples = monoOf(output.wav);
  const midpoint = Math.floor(samples.length / 2);
  let introEnergy = 0;
  let dropEnergy = 0;
  for (let i = 0; i < midpoint; i += 1) introEnergy += (samples[i] ?? 0) ** 2;
  for (let i = midpoint; i < samples.length; i += 1) dropEnergy += (samples[i] ?? 0) ** 2;
  assert.ok(dropEnergy > introEnergy * 2, `drop ${dropEnergy.toFixed(0)} vs intro ${introEnergy.toFixed(0)}`);
});

test('post: [] renders dry and the post chain is validated', () => {
  const dry = renderLoop(score, { post: [], minutes: 0.05 });
  const preset = renderLoop(score, { preset: 'classic', speed: 1, minutes: 0.05 });
  assert.equal(dry.loopSamples, 44100 * 2);
  assert.notEqual(Buffer.from(dry.wav).toString('base64'), Buffer.from(preset.wav).toString('base64'));

  assert.throws(
    () => renderLoop(score, { post: [{ type: 'flanger' }] as never }),
    /must be tape, slow, lowpass, reverb, tilt/,
  );
  assert.throws(() => renderLoop(score, { post: 'dry' as never }), /post must be an array/);
});

test('renders the 16-bar M1 example with drums, bass, and lead', async () => {
  const raw = await readFile(new URL('../examples/m1-16bar.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.mode, 'song');
  assert.equal(example.bars, 16);
  assert.deepEqual(
    example.tracks.map((track) => track.role),
    ['drums', 'bass', 'lead'],
  );

  const output = renderLoop(example, { post: [] });
  assert.ok(output.durationSeconds > 20, `duration ${output.durationSeconds}`);
  assert.ok(peak(output.wav) > 1000, 'example must be audible');
});

test('renders the motif example with nested phrases and transforms', async () => {
  const raw = await readFile(new URL('../examples/motifs.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.bars, 2);
  assert.equal(example.tracks[2]?.patternSteps, 32);

  const output = renderLoop(example, { post: [], minutes: 0.05 });
  assert.equal(output.loopSamples, Math.round(example.durationSeconds * 44100));
  assert.ok(peak(output.wav) > 1000, 'motif example must be audible');
});

function magnitudeAt(samples: Float32Array, frequency: number, seconds = 0.25): number {
  const length = Math.min(samples.length, Math.round(44100 * seconds));
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < length; i += 1) {
    const phase = (2 * Math.PI * frequency * i) / 44100;
    const value = samples[i] ?? 0;
    real += value * Math.cos(phase);
    imaginary -= value * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / Math.max(1, length);
}

function firstAudibleSample(samples: Float32Array, threshold = 0.005): number {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i] ?? 0) >= threshold) return i;
  }
  return -1;
}

function rmsBetween(samples: Float32Array, startSeconds: number, endSeconds: number): number {
  const start = Math.round(startSeconds * 44100);
  const end = Math.min(samples.length, Math.round(endSeconds * 44100));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
}

test('renders a triad as three simultaneous fundamentals', () => {
  const chord = monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ waveform: 'triangle', pattern: '[C4,E4,G4]:8' }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );
  const single = monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ waveform: 'triangle', pattern: 'C4:8' }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );

  const chordC = magnitudeAt(chord, 261.6256);
  const chordE = magnitudeAt(chord, 329.6276);
  const chordG = magnitudeAt(chord, 391.9954);
  assert.ok(chordC > 0.005, `C4 ${chordC}`);
  assert.ok(chordE > magnitudeAt(single, 329.6276) * 5, `E4 ${chordE}`);
  assert.ok(chordG > magnitudeAt(single, 391.9954) * 5, `G4 ${chordG}`);
});

test('gate separation makes staccato notes stop while legato notes sustain', () => {
  const staccato = monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ waveform: 'triangle', pattern: 'C2:4g1' }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );
  const legato = monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ waveform: 'triangle', pattern: 'C2:4g4' }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );

  const staccatoTail = rmsBetween(staccato, 0.2, 0.45);
  const legatoTail = rmsBetween(legato, 0.2, 0.45);
  assert.ok(staccatoTail < legatoTail * 0.1, `staccato ${staccatoTail} vs legato ${legatoTail}`);
});

test('swing delays odd steps deterministically', () => {
  const make = (swing: number) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          swing,
          tracks: [{ waveform: 'triangle', pattern: '-:1 C4:1g1 -:1 -:1 -:1 -:1 -:1 -:1' }],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );

  const straightOnset = firstAudibleSample(make(0));
  const swungOnset = firstAudibleSample(make(0.5));
  const pushedOnset = firstAudibleSample(make(-0.5));
  assert.ok(straightOnset >= 0 && swungOnset >= 0 && pushedOnset >= 0);
  assert.ok(
    swungOnset - straightOnset > 2000,
    `straight ${straightOnset}, swung ${swungOnset}`,
  );
  assert.ok(
    straightOnset - pushedOnset > 2000,
    `straight ${straightOnset}, pushed ${pushedOnset}`,
  );
});

test('renders the M2 chord, gate, and swing example', async () => {
  const raw = await readFile(new URL('../examples/m2-chords-gate-swing.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.swing, 0.15);
  assert.equal(example.tracks[2]?.events.length, 6);
  assert.equal(example.tracks[2]?.patternSteps, 8);

  const output = renderLoop(example, { post: [], minutes: 0.05 });
  assert.ok(peak(output.wav) > 1000, 'M2 example must be audible');
  assert.equal(output.loopSamples, Math.round(example.durationSeconds * 44100));
});

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

function rmsAll(samples: Float32Array, startSeconds = 0, endSeconds?: number): number {
  const start = Math.max(0, Math.round(startSeconds * 44100));
  const end = Math.min(samples.length, Math.round((endSeconds ?? samples.length / 44100) * 44100));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
}

function magnitudeBetween(
  samples: Float32Array,
  frequency: number,
  startSeconds: number,
  endSeconds: number,
): number {
  const start = Math.max(0, Math.round(startSeconds * 44100));
  const end = Math.min(samples.length, Math.round(endSeconds * 44100));
  let real = 0;
  let imaginary = 0;
  for (let i = start; i < end; i += 1) {
    const phase = (2 * Math.PI * frequency * i) / 44100;
    const value = samples[i] ?? 0;
    real += value * Math.cos(phase);
    imaginary -= value * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / Math.max(1, end - start);
}

function highBandBetween(samples: Float32Array, startSeconds: number, endSeconds: number): number {
  return (
    magnitudeBetween(samples, 1200, startSeconds, endSeconds) +
    magnitudeBetween(samples, 2400, startSeconds, endSeconds) +
    magnitudeBetween(samples, 4800, startSeconds, endSeconds)
  );
}

function renderPattern(pattern: string, extra: Record<string, unknown> = {}) {
  return monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ waveform: 'triangle', pattern, ...extra }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );
}

test('a named chord renders exactly like its explicit voicing', () => {
  const named = renderPattern('Cmaj7:8');
  const explicit = renderPattern('[C4,E4,G4,B4]:8');
  assert.deepEqual(Array.from(named), Array.from(explicit));
});

test('a named per-note envelope shortens the note like a track envelope', () => {
  const namedScore = parseScore({
    envelopes: { pluck: { attack: 0.001, decay: 0.08, sustain: 0.05, release: 0.02 } },
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [{ waveform: 'saw', volume: 7, pattern: 'C3:8~pluck C3:8~pluck' }],
  });
  const named = renderLoop(namedScore, { speed: 1, minutes: 0.05 });
  const padStats = channelStats(renderLoop(pad, { speed: 1, minutes: 0.05 }).wav);
  const namedStats = channelStats(named.wav);
  assert.ok(namedStats.rms < padStats.rms * 0.5, `named ${namedStats.rms} vs pad ${padStats.rms}`);
  assert.ok(namedStats.crossings > namedStats.count / 200, 'named envelope must still oscillate');
});

test('parameterised slide reaches the target sooner than the default ramp', () => {
  const slide = (steps: number) =>
    renderPattern(`C4:1 C5:1~slide(${steps})`, { waveform: 'pulse' });
  const fast = magnitudeBetween(slide(0.2), 523.2511, 0.16, 0.24);
  const slow = magnitudeBetween(slide(2), 523.2511, 0.16, 0.24);
  assert.ok(fast > slow * 2, `fast ${fast.toFixed(4)} slow ${slow.toFixed(4)}`);
});

test('parameterised vibrato changes the timbre deterministically', () => {
  const plain = Buffer.from(renderLoop(parseScore({
    bpm: 120, stepsPerBeat: 4, bars: 1,
    tracks: [{ waveform: 'pulse', pattern: 'C4:8' }],
  }), { post: [], minutes: 0.05 }).wav).toString('base64');
  const wide = Buffer.from(renderLoop(parseScore({
    bpm: 120, stepsPerBeat: 4, bars: 1,
    tracks: [{ waveform: 'pulse', pattern: 'C4:8~vib(1.2,5)' }],
  }), { post: [], minutes: 0.05 }).wav).toString('base64');
  const again = Buffer.from(renderLoop(parseScore({
    bpm: 120, stepsPerBeat: 4, bars: 1,
    tracks: [{ waveform: 'pulse', pattern: 'C4:8~vib(1.2,5)' }],
  }), { post: [], minutes: 0.05 }).wav).toString('base64');
  assert.notEqual(plain, wide);
  assert.equal(wide, again);
});

test('the score seed varies noise timbres deterministically', () => {
  const noise = (seed: number) =>
    Buffer.from(
      renderLoop(
        parseScore({
          seed,
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          tracks: [{ waveform: 'noise', pattern: 'C4:4' }],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    ).toString('base64');
  assert.equal(noise(7), noise(7));
  assert.notEqual(noise(7), noise(8));
});

test('pan moves a track between the channels without changing its period', () => {
  const hardLeft = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: [{ waveform: 'pulse', pattern: 'C4:2', pan: -1 }],
    }),
    { post: [], minutes: 0.05 },
  );
  const { left, right } = channelsOf(hardLeft.wav);
  assert.ok(rmsAll(left) > rmsAll(right) * 10, `left ${rmsAll(left)} right ${rmsAll(right)}`);
  assert.ok(rmsAll(right) < 0.001);
  assert.equal(hardLeft.loopSamples, 44100 * 2);
});

const ducky = (duck: number) =>
  parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 2,
    tracks: [
      { name: 'drums', role: 'drums', volume: 0, pattern: 'K:1 -:1 -:1 -:1 K:1 -:1 -:1 -:1' },
      { name: 'bass', waveform: 'saw', pattern: 'C2:16 C2:16', duck },
    ],
  });

test('kick hits duck a track that opts in', () => {
  const ducked = monoOf(renderLoop(ducky(0.9), { post: [], minutes: 0.05 }).wav);
  const control = monoOf(renderLoop(ducky(0), { post: [], minutes: 0.05 }).wav);
  const duckedWindow = rmsAll(ducked, 0.012, 0.09);
  const controlWindow = rmsAll(control, 0.012, 0.09);
  assert.ok(
    duckedWindow < controlWindow * 0.6,
    `ducked ${duckedWindow.toFixed(4)} vs control ${controlWindow.toFixed(4)}`,
  );
});

const sawPattern = Array.from({ length: 32 }, () => 'C2:1').join(' ');

test('a per-track filter darkens the signal and its LFO moves the cutoff', () => {
  const render = (filter: unknown) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 2,
          tracks: [{ waveform: 'saw', pattern: sawPattern, filter }],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );

  const low = render(300);
  const high = render(5000);
  assert.ok(
    highBandBetween(high, 0.5, 3.5) > highBandBetween(low, 0.5, 3.5) * 5,
    `high ${highBandBetween(high, 0.5, 3.5)} vs low ${highBandBetween(low, 0.5, 3.5)}`,
  );

  const modulated = render({ cutoffHz: 300, lfoHz: 0.5, lfoDepth: 4 });
  const windows = Array.from({ length: 10 }, (_, index) =>
    highBandBetween(modulated, index * 0.4, index * 0.4 + 0.2),
  );
  const brightest = Math.max(...windows);
  const darkest = Math.min(...windows);
  assert.ok(brightest > highBandBetween(low, 0.5, 3.5) * 3, `brightest ${brightest}`);
  assert.ok(brightest > darkest * 2, `brightest ${brightest} darkest ${darkest}`);
});

test('a section filter sweep brightens the mix from start to end', () => {
  const sweeping = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ waveform: 'saw', pattern: sawPattern }],
    arrangement: [{ name: 'build', bars: 2, filter: { from: 300, to: 12000 } }],
  });
  const output = monoOf(renderLoop(sweeping, { post: [] }).wav);
  const start = highBandBetween(output, 0.1, 1.0);
  const end = highBandBetween(output, 3.0, 3.9);
  assert.ok(end > start * 2, `start ${start.toFixed(5)} end ${end.toFixed(5)}`);
});

test('track send adds a reverb tail that survives the note', () => {
  const render = (send: number) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 2,
          tracks: [
            {
              waveform: 'triangle',
              pattern: `C4:1 ${'-:1 '.repeat(15)}`.trim(),
              send,
            },
          ],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );
  const wet = render(1);
  const dry = render(0);
  const wetTail = rmsAll(wet, 0.5, 1.5);
  const dryTail = rmsAll(dry, 0.5, 1.5);
  assert.ok(wetTail > 0.01, `wet tail ${wetTail}`);
  assert.ok(dryTail < wetTail * 0.05, `dry tail ${dryTail}`);
});

test('a per-track delay repeats the note at the requested step offset', () => {
  const pattern = 'C4:1 -:1 -:1 -:1 -:1 -:1 -:1 -:1';
  const echo = monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ waveform: 'triangle', pattern, delay: { steps: 2, feedback: 0.5, mix: 0.8 } }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );
  const dry = renderPattern(pattern);
  const echoWindow = rmsAll(echo, 0.25, 0.35);
  const dryWindow = rmsAll(dry, 0.25, 0.35);
  assert.ok(echoWindow > 0.05, `echo ${echoWindow}`);
  assert.ok(dryWindow < echoWindow * 0.1, `dry ${dryWindow}`);
});

test('renders the M2.5 harmony and envelope example', async () => {
  const raw = await readFile(new URL('../examples/m2.5-harmony-envelope.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.seed, 11);
  assert.ok(example.tracks.some((track) => track.events.some((event) => event.envelope)));
  assert.ok(example.tracks.some((track) => track.events.some((event) => event.effectParams)));
  const output = renderLoop(example, { post: [], minutes: 0.05 });
  assert.ok(peak(output.wav) > 1000, 'M2.5 example must be audible');
});

test('renders the M3 space and motion example', async () => {
  const raw = await readFile(new URL('../examples/m3-space-motion.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.mode, 'song');
  assert.ok(example.tracks.some((track) => track.filter?.lfoHz));
  assert.ok(example.tracks.some((track) => track.send > 0));
  assert.ok(example.tracks.some((track) => track.delay));
  assert.ok(example.tracks.some((track) => track.duck > 0));
  assert.ok(example.tracks.some((track) => track.pan !== 0));
  assert.ok(example.sections.some((section) => section.filterEndHz !== undefined));
  const output = renderLoop(example, { post: [] });
  assert.ok(peak(output.wav) > 1000, 'M3 example must be audible');
  assert.ok(output.durationSeconds > 15);
});

test('renders the M5 drum articulation and fill example', async () => {
  const raw = await readFile(new URL('../examples/m5-drums-fill.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.mode, 'song');
  assert.ok(example.sections.every((section) => section.energy !== undefined));
  assert.ok(example.sections.some((section) => section.energy === 0.2));

  const drums = example.tracks.find((track) => track.name === 'drums');
  const effects = new Set(
    drums?.timeline?.flatMap((event) => (event.drumEffect ? [event.drumEffect.kind] : [])) ?? [],
  );
  assert.deepEqual([...effects].sort(), ['flam', 'ghost', 'roll']);

  const output = renderLoop(example, { post: [] });
  assert.ok(output.durationSeconds > 19, `duration ${output.durationSeconds}`);
  assert.ok(peak(output.wav) > 1000, 'M5 example must be audible');
  const readings = output.report.sections.map((section) => section.rmsDb);
  assert.ok(Math.max(...readings) - Math.min(...readings) > 2, 'energy macro should make sections contrast');
});

test('renders the M7 model-designed waveform example', async () => {
  const raw = await readFile(new URL('../examples/m7-wave-shapes.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  const partialsOf = (name: string) =>
    example.tracks.find((track) => track.name === name)?.instrument?.partials ?? [];

  // The three voices are one harmonic series each, told apart by sign and phase.
  assert.ok(partialsOf('bass').some((partial) => partial.amplitude > 0 && partial.phase === Math.PI));
  assert.deepEqual(partialsOf('lead').map((partial) => partial.phase), [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  assert.ok(partialsOf('pad').every((partial) => partial.phase === Math.PI));

  const output = renderLoop(example, { post: [] });
  assert.ok(output.durationSeconds > 4, `duration ${output.durationSeconds}`);
  assert.ok(peak(output.wav) > 1000, 'M7 example must be audible');
  assert.ok(output.report.peakDb <= -0.9);
});

test('renders the M9 inharmonic and decaying additive example', async () => {
  const raw = await readFile(new URL('../examples/m9-additive-textures.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  const instrumentOf = (name: string) =>
    example.tracks.find((track) => track.name === name)?.instrument;

  const bell = instrumentOf('lead');
  assert.equal(bell?.stretch, 0.35);
  assert.ok(bell?.partials?.every((partial) => (partial.decay ?? 0) > 0), 'bell highs decay first');
  const pluck = instrumentOf('bass');
  assert.ok(pluck?.partials?.some((partial) => (partial.decay ?? 0) > 0), 'pluck uses partial decay');
  const pad = instrumentOf('pad');
  assert.equal(pad?.tilt, 1.4);
  assert.equal(pad?.partials, undefined, 'tilt alone stays on the default series');

  const output = renderLoop(example, { post: [], minutes: 0.05 });
  assert.ok(output.durationSeconds >= 10, `duration ${output.durationSeconds}`);
  assert.ok(peak(output.wav) > 1000, 'M9 example must be audible');
  assert.ok(output.report.peakDb <= -0.9);
});

test('renders the M10 tuned additive piano example', async () => {
  const raw = await readFile(new URL('../examples/m10-tuning.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.equal(example.tuning.a4, 442);
  assert.equal(example.tuning.temperament, 'equal');
  assert.equal(example.tuning.cents.get(84), 18, 'C6 sits 18 cents sharp');
  assert.equal(example.tracks[0]?.instrument?.type, 'additive');
  const first = example.tracks[0]?.events[0];
  assert.ok(Math.abs((first?.frequency ?? 0) - 442 * 2 ** (-9 / 12)) < 1e-9);

  const output = renderLoop(example, { post: [], minutes: 0.05 });
  assert.ok(peak(output.wav) > 1000, 'M10 example must be audible');
  assert.ok(output.report.peakDb <= -0.9);
});

test('renders the M11 velocity-to-timbre example', async () => {
  const raw = await readFile(new URL('../examples/m11-velocity-timbre.json', import.meta.url), 'utf8');
  const example = parseScore(raw);
  assert.deepEqual(example.tracks[0]?.instrument?.velocity, {
    cutoffOctaves: 2.5,
    drive: 0.25,
  });

  const output = renderLoop(example, { post: [], minutes: 0.05 });
  assert.ok(peak(output.wav) > 1000, 'M11 example must be audible');
  assert.ok(output.report.peakDb <= -0.9);
});

function renderAdditiveNote(definition: Record<string, unknown>, pattern = 'A4:16'): Float32Array {
  return monoOf(
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        tracks: [{ instrument: { type: 'additive', ...definition }, pattern }],
      }),
      { post: [], minutes: 0.05 },
    ).wav,
  );
}

test('explicit zero stretch and decay keep the static additive table path', () => {
  const base = { partials: [1, 0.5, [0.25, 90]] };
  const plain = renderAdditiveNote(base);
  const zeroed = renderAdditiveNote({ ...base, stretch: 0, partials: [1, 0.5, [0.25, 90, 0]] });
  assert.deepEqual(Array.from(plain), Array.from(zeroed));
});

test('stretch keeps the fundamental in tune and sharpens upper harmonics', () => {
  const harmonic = renderAdditiveNote({ partials: [1, 0.8] });
  const stretched = renderAdditiveNote({ partials: [1, 0.8], stretch: 0.4 });
  const f0 = 440;
  const stampedSecond = 2 * Math.sqrt(1 + 0.4 * (2 * 2 - 1)) * f0;

  const harmonicSecond = magnitudeBetween(harmonic, 2 * f0, 0.2, 1.8);
  const stretchedSecond = magnitudeBetween(stretched, 2 * f0, 0.2, 1.8);
  const shiftedSecond = magnitudeBetween(stretched, stampedSecond, 0.2, 1.8);
  const harmonicFundamental = magnitudeBetween(harmonic, f0, 0.2, 1.8);
  const stretchedFundamental = magnitudeBetween(stretched, f0, 0.2, 1.8);

  assert.ok(harmonicSecond > harmonicFundamental * 0.5, 'the stock second harmonic is present');
  assert.ok(stretchedSecond < harmonicSecond * 0.1, 'stretch must move energy off 2*f0');
  assert.ok(shiftedSecond > stretchedSecond * 5, `shifted ${shiftedSecond} vs 2f0 ${stretchedSecond}`);
  assert.ok(stretchedFundamental > harmonicFundamental * 0.3, 'stretch must not detune the fundamental');
});

test('tilt rolls off upper harmonics relative to the fundamental', () => {
  const flat = renderAdditiveNote({ partials: [1, 0.8, 0.6, 0.4, 0.2] });
  const tilted = renderAdditiveNote({ partials: [1, 0.8, 0.6, 0.4, 0.2], tilt: 2 });
  const ratioOf = (samples: Float32Array) =>
    magnitudeBetween(samples, 4 * 440, 0.2, 1.8) / magnitudeBetween(samples, 440, 0.2, 1.8);

  assert.ok(ratioOf(tilted) < ratioOf(flat) * 0.5, `tilted ${ratioOf(tilted)} vs flat ${ratioOf(flat)}`);
});

test('velocity opens an instrument filter and adds drive', () => {
  const render = (definition: Record<string, unknown>, volume: number) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          tracks: [
            {
              instrument: { type: 'additive', ...definition },
              pattern: `A4:8@${volume} -:8`,
            },
          ],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );
  const ratio = (samples: Float32Array, harmonic: number) =>
    magnitudeBetween(samples, harmonic * 440, 0.05, 0.9) /
    Math.max(1e-9, magnitudeBetween(samples, 440, 0.05, 0.9));

  const cutoff = {
    partials: [1, 0.6, 0.4, 0.3, 0.2, 0.15, 0.1],
    filter: {
      cutoffHz: 400,
      resonance: 0.707,
      envAmount: 0,
      attack: 0,
      decay: 0,
      sustain: 1,
      release: 0,
    },
    velocity: { cutoffOctaves: 4 },
  };
  const quiet = render(cutoff, 1);
  const loud = render(cutoff, 7);
  assert.ok(
    ratio(loud, 4) > ratio(quiet, 4) * 2,
    `loud ${ratio(loud, 4)} quiet ${ratio(quiet, 4)}`,
  );

  const drive = { partials: [1], velocity: { drive: 1 } };
  const quietDrive = render(drive, 1);
  const loudDrive = render(drive, 7);
  assert.ok(
    ratio(loudDrive, 3) > ratio(quietDrive, 3) * 3,
    `loud drive ${ratio(loudDrive, 3)} quiet ${ratio(quietDrive, 3)}`,
  );
});

test('an all-zero velocity mapping stays sample-identical', () => {
  const render = (velocity?: Record<string, number>) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          tracks: [
            {
              instrument: {
                type: 'additive',
                partials: [1, 0.5, [0.3, 45, 0.5]],
                ...(velocity === undefined ? {} : { velocity }),
              },
              pattern: 'A4:4@7',
            },
          ],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );

  assert.deepEqual(
    Array.from(render()),
    Array.from(render({ cutoffOctaves: 0, drive: 0 })),
  );
});

test('per-harmonic decay lets highs die before the fundamental', () => {
  const voice = renderAdditiveNote({ partials: [[1, 0, 4], [0.8, 0, 0.25]] });
  const earlyHigh = magnitudeBetween(voice, 880, 0.15, 0.35);
  const lateHigh = magnitudeBetween(voice, 880, 1.2, 1.9);
  const earlyLow = magnitudeBetween(voice, 440, 0.15, 0.35);
  const lateLow = magnitudeBetween(voice, 440, 1.2, 1.9);

  assert.ok(lateHigh < earlyHigh * 0.2, `high early ${earlyHigh} late ${lateHigh}`);
  assert.ok(lateLow > earlyLow * 0.3, `low early ${earlyLow} late ${lateLow}`);
});

test('send and delay keep the loop seam seamless', () => {
  const wetLoop = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [
        {
          name: 'lead',
          waveform: 'triangle',
          pattern: 'C4:2 E4:2 G4:2 E4:2',
          send: 0.6,
          delay: { steps: 3, feedback: 0.4, mix: 0.4 },
          pan: -0.2,
        },
      ],
    }),
    { post: [], minutes: 0.05 },
  );
  const left = channelsOf(wetLoop.wav).left;
  const n = wetLoop.loopSamples;
  let maxJump = 0;
  for (let i = 1; i < n; i += 1) {
    maxJump = Math.max(maxJump, Math.abs((left[i] ?? 0) - (left[i - 1] ?? 0)));
  }
  const seam = Math.abs((left[0] ?? 0) - (left[n - 1] ?? 0));
  assert.notEqual(left[n - 1], 0, 'the loop must not end in zero padding');
  assert.ok(seam <= Math.max(0.02, maxJump * 2), `seam ${seam}, max jump ${maxJump}`);
});

test('a delay longer than the loop folds instead of silently disappearing', () => {
  const pattern = `C4:1 ${'-:1 '.repeat(15)}`.trim();
  const render = (steps: number) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          tracks: [{ waveform: 'triangle', pattern, delay: { steps, feedback: 0, mix: 0.8 } }],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );
  const dry = renderPattern(pattern);
  // 32 steps = twice the 16-step loop: the echo lands on top of the hit.
  const doubled = render(32);
  const dryStart = rmsAll(dry, 0.0, 0.05);
  const doubledStart = rmsAll(doubled, 0.0, 0.05);
  assert.ok(doubledStart > dryStart * 1.4, `folded echo ${doubledStart}, dry ${dryStart}`);

  // 24 steps = 1.5 loops: the echo moves half a loop later.
  const folded = render(24);
  const lateWindow = rmsAll(folded, 1.0, 1.1);
  const dryLate = rmsAll(dry, 1.0, 1.1);
  assert.ok(lateWindow > dryLate * 5, `folded echo ${lateWindow}, dry ${dryLate}`);

  // 16 steps = exactly one loop: the echo lands on the original hit, rather
  // than reading before index 0 and turning into silence.
  const sameLength = render(16);
  const sameStart = rmsAll(sameLength, 0.0, 0.05);
  assert.ok(sameStart > dryStart * 1.4, `one-loop echo ${sameStart}, dry ${dryStart}`);
});

test('a song delay longer than the song is silent, not noise', () => {
  const song = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ waveform: 'triangle', pattern: 'C4:1 -:1 -:1 -:1', delay: { steps: 64, feedback: 0, mix: 0.8 } }],
    arrangement: [{ name: 'a', bars: 1 }],
  });
  const output = renderLoop(song, { post: [] });
  assert.ok(peak(output.wav) > 1000);
});

test('an aborted render stops before writing audio', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => renderLoop(parseScore({ tracks: [{ pattern: 'C4:4' }] }), { post: [], signal: controller.signal }),
    /aborted/,
  );
});

test('a section riser sweeps upward into the next section', () => {
  const output = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ waveform: 'triangle', pattern: '-:16' }],
      arrangement: [
        { name: 'build', bars: 2, riser: 2 },
        { name: 'drop', bars: 1 },
      ],
    }),
    { post: [] },
  );

  const earlyBand = highBandBetween(output.left, 0.1, 0.8);
  const lateBand = highBandBetween(output.left, 3.0, 3.95);
  assert.ok(lateBand > earlyBand * 3, `early ${earlyBand.toFixed(6)} late ${lateBand.toFixed(6)}`);
  assert.ok(
    rmsBetween(output.left, 3.0, 3.95) > rmsBetween(output.left, 0.1, 0.8) * 2,
    'the riser should grow toward the section boundary',
  );
});

test('riser length follows beatsPerBar', () => {
  const output = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      beatsPerBar: 3,
      tracks: [{ waveform: 'triangle', pattern: '-:24' }],
      arrangement: [
        { name: 'build', bars: 2, riser: 1 },
        { name: 'drop', bars: 1 },
      ],
    }),
    { post: [] },
  );

  // 3/4 at 120 bpm: one step is 0.125 s, one bar is 1.5 s, the build is 3 s.
  // The riser covers only the last bar (1.5-3 s), so the first bar stays silent.
  // With a hard-coded four-beat bar it would start at 1 s and leak into this window.
  const beforeRiser = highBandBetween(output.left, 0.3, 1.4);
  const endOfBuild = highBandBetween(output.left, 2.6, 2.9);
  assert.equal(beforeRiser, 0, 'the riser must not start before the last bar');
  assert.ok(endOfBuild > 0, 'the riser should be audible at the section boundary');
});

test('tail extends a song so the send reverb can ring out', () => {
  const song = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tail: 1,
    tracks: [{ waveform: 'triangle', pattern: '-:15 C4:1', send: 1 }],
    arrangement: [{ name: 'a', bars: 1 }],
  });
  const output = renderLoop(song, { post: [] });
  assert.equal(output.loopSamples, Math.round((song.durationSeconds + 1) * 44100));
  assert.ok(Math.abs(output.durationSeconds - (song.durationSeconds + 1)) < 0.01);

  const tailRms = rmsAll(output.left, song.durationSeconds + 0.1, song.durationSeconds + 0.9);
  const noteRms = rmsAll(output.left, 1.9, 2.0);
  assert.ok(tailRms > 0.0005, `tail rms ${tailRms}`);
  assert.ok(tailRms < noteRms, `tail ${tailRms} should decay below the note ${noteRms}`);
  assert.ok(Math.abs(output.left[output.left.length - 1] ?? 0) < 0.01, 'the tail end is faded');
});

test('humanize is deterministic, seed-dependent, and neutral at zero', () => {
  const render = (seed: number, humanize?: { timingMs: number; velocity: number }) =>
    monoOf(
      renderLoop(
        parseScore({
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          seed,
          ...(humanize === undefined ? {} : { humanize }),
          tracks: [{ waveform: 'triangle', pattern: '-:1 C4:1g1 -:14' }],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );

  const neutral = render(1);
  const jittered = render(1, { timingMs: 25, velocity: 0 });
  assert.notEqual(firstAudibleSample(jittered), firstAudibleSample(neutral));
  assert.deepEqual(Array.from(render(1, { timingMs: 25, velocity: 0 })), Array.from(jittered));
  assert.notDeepEqual(Array.from(render(2, { timingMs: 25, velocity: 0 })), Array.from(jittered));
  assert.deepEqual(Array.from(render(1, { timingMs: 0, velocity: 0 })), Array.from(neutral));
});

test('humanize velocity varies repeated hits deterministically', () => {
  const render = (humanize?: { timingMs: number; velocity: number }) =>
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        humanize,
        tracks: [{ role: 'drums', volume: 7, pattern: 'H:2 '.repeat(8).trim() }],
      }),
      { post: [], minutes: 0.05 },
    ).left;

  const flat = render();
  const varied = render({ timingMs: 0, velocity: 1 });
  const windows = Array.from({ length: 8 }, (_, index) =>
    rmsAll(varied, index * 0.25, index * 0.25 + 0.06),
  );
  assert.ok(Math.max(...windows) > Math.min(...windows) * 1.2, `windows ${windows.join(', ')}`);
  assert.deepEqual(Array.from(render({ timingMs: 0, velocity: 1 })), Array.from(varied));
  assert.ok(rmsAll(flat) > 0);
});

test('renders an arrangement with more than four tracks', () => {
  const output = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: Array.from({ length: 6 }, (_, index) => ({
        name: `t${index}`,
        waveform: 'triangle',
        pattern: `C${3 + index}:4`,
      })),
    }),
    { post: [], minutes: 0.05 },
  );
  assert.ok(peak(output.wav) > 1000);
});


function sampleSource(loop: boolean): SampleSource {
  const audio = new Float32Array(2205);
  for (let i = 0; i < audio.length; i += 1) {
    audio[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
  }
  return { name: 'tone', audio, rate: 44100, rootMidi: 60, loop, gain: 1 };
}

function rms(left: Float32Array, from = 0, to = left.length): number {
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i += 1) {
    const value = left[i] ?? 0;
    sum += value * value;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

test('plays a persisted sample instrument at the note pitch', () => {
  const parsed = parseScore({
    samples: { tone: 'assets/tone.wav' },
    tracks: [{ instrument: { type: 'sample', sample: 'tone' }, pattern: 'C4:4' }],
  });
  const bank = new Map([['tone', sampleSource(false)]]);
  const output = renderLoop(parsed, { post: [], minutes: 0.05, samples: bank });

  assert.ok(rms(output.left) > 0.001, 'expected the sample to be audible');
  assert.ok(output.left.some((value) => value !== 0), 'expected non-silent samples');
  assert.deepEqual(output.left, output.right, 'a centred mono sample stays centred');

  const again = renderLoop(parsed, { post: [], minutes: 0.05, samples: bank });
  assert.deepEqual(output.left, again.left, 'sample playback is deterministic');
});

test('a looped sample fills its gate and a one-shot stops at the file end', () => {
  const parsed = parseScore({
    bpm: 120,
    bars: 1,
    samples: { tone: 'assets/tone.wav' },
    tracks: [{ instrument: { type: 'sample', sample: 'tone' }, pattern: 'C4:8' }],
  });
  const oneShot = renderLoop(parsed, {
    post: [],
    minutes: 0.05,
    samples: new Map([['tone', sampleSource(false)]]),
  });
  const looped = renderLoop(parsed, {
    post: [],
    minutes: 0.05,
    samples: new Map([['tone', sampleSource(true)]]),
  });

  // The file is 0.05 s and the first gate is 1 s at 120 bpm, so only the looped
  // version still has energy in the second half of that gate.
  const start = Math.round(0.5 * 44100);
  const end = Math.round(0.95 * 44100);
  assert.ok(rms(oneShot.left, start, end) < 1e-4, 'one-shot should have stopped');
  assert.ok(rms(looped.left, start, end) > 1e-4, 'looped sample should still be playing');
});

test('a drum replacement sample renders alongside synthetic voices', () => {
  const parsed = parseScore({
    samples: { hit: 'assets/hit.wav' },
    drumSamples: { kick: 'hit' },
    tracks: [{ role: 'drums', pattern: 'K:1 S:1 K:1 S:1' }],
  });
  const output = renderLoop(parsed, {
    post: [],
    minutes: 0.05,
    samples: new Map([['hit', sampleSource(false)]]),
  });
  assert.ok(rms(output.left) > 0.001);
  assert.deepEqual(output.left, output.right);
});

test('a sample instrument without a loaded bank fails explicitly', () => {
  const parsed = parseScore({
    samples: { tone: 'assets/tone.wav' },
    tracks: [{ instrument: { type: 'sample', sample: 'tone' }, pattern: 'C4:4' }],
  });
  assert.throws(() => renderLoop(parsed, { post: [], minutes: 0.05 }), /missing from the render bank/);
});

test('the renderer sounds the tuned frequency, not the 12-TET default', () => {
  const render = (tuning?: unknown) =>
    monoOf(
      renderLoop(
        parseScore({
          ...(tuning === undefined ? {} : { tuning }),
          bpm: 120,
          stepsPerBeat: 4,
          bars: 1,
          tracks: [{ waveform: 'triangle', pattern: 'A4:8' }],
        }),
        { post: [], minutes: 0.05 },
      ).wav,
    );
  const tuned = render({ a4: 442 });
  assert.ok(
    magnitudeAt(tuned, 442, 1) > magnitudeAt(tuned, 440, 1) * 5,
    'energy must sit at the tuned A4',
  );
  const plain = render();
  assert.ok(magnitudeAt(plain, 440, 1) > magnitudeAt(plain, 442, 1) * 5);
});
