import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeRender } from '../src/app/render-service.ts';
import { decodeWav, encodeWav, formatProbe, probeTrack, renderLoop } from '../src/features/render/feature.ts';
import type { SampleSource, SampleZoneSet } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const RATE = 44100;

function rms(samples: Float32Array, fromSeconds: number, toSeconds: number): number {
  const start = Math.max(0, Math.round(fromSeconds * RATE));
  const end = Math.min(samples.length, Math.round(toSeconds * RATE));
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** Amplitude of one frequency over a window; enough to identify a zone's source. */
function magnitudeAt(
  samples: Float32Array,
  frequency: number,
  fromSeconds: number,
  toSeconds: number,
): number {
  const start = Math.max(0, Math.round(fromSeconds * RATE));
  const end = Math.min(samples.length, Math.round(toSeconds * RATE));
  let real = 0;
  let imaginary = 0;
  for (let i = start; i < end; i += 1) {
    const t = (i - start) / RATE;
    const value = samples[i] ?? 0;
    real += value * Math.cos(2 * Math.PI * frequency * t);
    imaginary += value * Math.sin(2 * Math.PI * frequency * t);
  }
  const count = Math.max(1, end - start);
  return (2 * Math.hypot(real, imaginary)) / count;
}

function tone(frequency: number, durationSeconds: number, amplitude = 0.5): Float32Array {
  const output = new Float32Array(Math.round(durationSeconds * RATE));
  for (let i = 0; i < output.length; i += 1) {
    output[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE);
  }
  return output;
}

function concat(...parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function silent(durationSeconds: number): Float32Array {
  return new Float32Array(Math.round(durationSeconds * RATE));
}

function source(
  name: string,
  audio: Float32Array,
  rootMidi: number,
  loop = true,
): SampleSource {
  return { name, audio, rate: RATE, rootMidi, loop, gain: 1 };
}

async function renderInWorkspace(
  directory: string,
  score: unknown,
  out = 'out',
): Promise<{ left: Float32Array; right: Float32Array }> {
  await executeRender(
    { score: JSON.stringify(score), post: [], minutes: 0.05, out },
    { cwd: directory },
  );
  const decoded = decodeWav(await readFile(join(directory, `${out}.wav`)));
  return { left: decoded.left, right: decoded.right };
}

async function withWorkspace<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-timbral-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sample regions: start/end, reverse, loop points (app layer slicing)
// ---------------------------------------------------------------------------

test('start trims silence off the front of a sample', async () => {
  await withWorkspace(async (directory) => {
    await writeFile(
      join(directory, 'tone.wav'),
      encodeWav(concat(silent(0.5), tone(440, 0.5)), concat(silent(0.5), tone(440, 0.5)), RATE),
    );
    const score = {
      bpm: 120,
      bars: 1,
      samples: { peak: { file: 'tone.wav', start: 0.5 } },
      tracks: [{ instrument: { type: 'sample', sample: 'peak' }, pattern: 'C4:16' }],
    };
    const output = await renderInWorkspace(directory, score);
    assert.ok(rms(output.left, 0, 0.05) > 0.1, 'the sliced tone must start immediately');
  });
});

test('end stops a one-shot at the region boundary', async () => {
  await withWorkspace(async (directory) => {
    const audio = tone(440, 1);
    await writeFile(join(directory, 'tone.wav'), encodeWav(audio, audio, RATE));
    const score = {
      bpm: 120,
      bars: 1,
      samples: { short: { file: 'tone.wav', end: 0.1 } },
      tracks: [{ instrument: { type: 'sample', sample: 'short' }, pattern: 'C4:16' }],
    };
    const output = await renderInWorkspace(directory, score);
    assert.ok(rms(output.left, 0.02, 0.09) > 0.1, 'the selected region is audible');
    assert.ok(rms(output.left, 0.2, 0.5) < 1e-4, 'playback stops at the end offset');
  });
});

test('reverse plays the selected region backwards', async () => {
  await withWorkspace(async (directory) => {
    const audio = concat(tone(440, 0.5, 0.35), tone(440, 0.5, 0.02));
    await writeFile(join(directory, 'oneway.wav'), encodeWav(audio, audio, RATE));
    const score = {
      bpm: 120,
      bars: 1,
      samples: { back: { file: 'oneway.wav', reverse: true } },
      tracks: [{ instrument: { type: 'sample', sample: 'back' }, pattern: 'C4:16' }],
    };
    const output = await renderInWorkspace(directory, score);
    assert.ok(rms(output.left, 0.05, 0.35) < rms(output.left, 0.6, 0.9) * 0.5);
  });
});

test('loop points repeat only the selected window', async () => {
  await withWorkspace(async (directory) => {
    const audio = concat(silent(0.3), tone(440, 0.1), silent(0.6));
    await writeFile(join(directory, 'blip.wav'), encodeWav(audio, audio, RATE));
    const score = {
      bpm: 120,
      bars: 1,
      samples: {
        windowed: { file: 'blip.wav', loop: true, loopStart: 0.3, loopEnd: 0.4 },
        whole: { file: 'blip.wav', loop: true },
      },
      tracks: [
        { name: 'window', instrument: { type: 'sample', sample: 'windowed' }, pattern: 'C4:16' },
        { name: 'whole', instrument: { type: 'sample', sample: 'whole' }, pattern: 'C4:16' },
      ],
    };
    // Compare each source on its own so the mix cannot mask the loop shape.
    const windowed = await renderInWorkspace(
      directory,
      { ...score, tracks: [score.tracks[0]] },
      'windowed-only',
    );
    const whole = await renderInWorkspace(
      directory,
      { ...score, tracks: [score.tracks[1]] },
      'whole-only',
    );
    assert.ok(rms(windowed.left, 0.05, 0.25) < 1e-3, 'the intro before loopStart still plays first');
    assert.ok(rms(windowed.left, 1.0, 1.2) > 0.05, 'the loop window keeps sounding');
    assert.ok(rms(whole.left, 1.0, 1.2) < 1e-3, 'the whole-file loop is in its silent stretch');
  });
});

test('a start offset past the decoded file is a clear error', async () => {
  await withWorkspace(async (directory) => {
    const audio = tone(440, 0.5);
    await writeFile(join(directory, 'short.wav'), encodeWav(audio, audio, RATE));
    await assert.rejects(
      () =>
        executeRender(
          {
            score: JSON.stringify({
              samples: { late: { file: 'short.wav', start: 2 } },
              tracks: [{ instrument: { type: 'sample', sample: 'late' }, pattern: 'C4:4' }],
            }),
            post: [],
            minutes: 0.05,
            out: 'late',
          },
          { cwd: directory },
        ),
      /start 2\.00s is past the end of the file \(0\.50s\)/,
    );
  });
});

test('sample ~decay shortens a one-shot tail', async () => {
  await withWorkspace(async (directory) => {
    const audio = tone(440, 1, 0.5);
    await writeFile(join(directory, 'hit.wav'), encodeWav(audio, audio, RATE));
    const score = (decay?: number) => ({
      bpm: 120,
      bars: 1,
      samples: { hit: 'hit.wav' },
      drumSamples: { kick: 'hit' },
      tracks: [
        {
          role: 'drums',
          pattern: decay === undefined ? 'K:16' : `K:16~decay(${decay})`,
        },
      ],
    });
    const plain = await renderInWorkspace(directory, score(), 'plain');
    const shortened = await renderInWorkspace(directory, score(4), 'short');
    assert.ok(rms(plain.left, 0.6, 0.9) > 0.05, 'the sample keeps ringing by default');
    assert.ok(rms(shortened.left, 0.6, 0.9) < rms(plain.left, 0.6, 0.9) * 0.1);
  });
});

// ---------------------------------------------------------------------------
// Zones: key ranges and velocity layers
// ---------------------------------------------------------------------------

test('a zone set chooses the source by key range', () => {
  const bank = new Map<string, SampleSource | SampleZoneSet>([
    [
      'multi',
      {
        name: 'multi',
        zones: [
          { source: source('low', tone(220, 1), 48), loMidi: 0, hiMidi: 59, loVelocity: 0, hiVelocity: 1 },
          { source: source('high', tone(880, 1), 72), loMidi: 60, hiMidi: 127, loVelocity: 0, hiVelocity: 1 },
        ],
      },
    ],
  ]);
  // The parser only validates references; the renderer needs the actual bank.
  const score = parseScore({
    bpm: 120,
    bars: 1,
    samples: { multi: 'placeholder.wav' },
    tracks: [{ instrument: { type: 'sample', sample: 'multi' }, pattern: 'C3:8 C5:8' }],
  });
  const output = renderLoop(score, { post: [], minutes: 0.05, samples: bank });
  assert.ok(magnitudeAt(output.left, 220, 0.2, 0.8) > 0.1, 'C3 picks the low source');
  assert.ok(magnitudeAt(output.left, 880, 1.2, 1.8) > 0.1, 'C5 picks the high source');
  assert.ok(magnitudeAt(output.left, 880, 0.2, 0.8) < 0.01, 'the low zone is not transposed up');
  assert.ok(magnitudeAt(output.left, 220, 1.2, 1.8) < 0.01, 'the high zone is not transposed down');
});

test('a zone set chooses the source by velocity layer', () => {
  const bank = new Map<string, SampleSource | SampleZoneSet>([
    [
      'multi',
      {
        name: 'multi',
        zones: [
          { source: source('soft', tone(440, 1), 60), loMidi: 0, hiMidi: 127, loVelocity: 0, hiVelocity: 0.5 },
          { source: source('hard', tone(1320, 1), 60), loMidi: 0, hiMidi: 127, loVelocity: 0.5, hiVelocity: 1 },
        ],
      },
    ],
  ]);
  const score = parseScore({
    bpm: 120,
    bars: 1,
    samples: { multi: 'placeholder.wav' },
    tracks: [{ instrument: { type: 'sample', sample: 'multi' }, pattern: 'C4:8@2 C4:8@6' }],
  });
  const output = renderLoop(score, { post: [], minutes: 0.05, samples: bank });
  assert.ok(magnitudeAt(output.left, 440, 0.2, 0.8) > 0.1, '@2 uses the soft layer');
  assert.ok(magnitudeAt(output.left, 1320, 1.2, 1.8) > 0.1, '@6 uses the hard layer');
  assert.ok(magnitudeAt(output.left, 1320, 0.2, 0.8) < 0.01);
});

// ---------------------------------------------------------------------------
// Velocity to FM index
// ---------------------------------------------------------------------------

function fmScore(instrument: Record<string, unknown>): ReturnType<typeof parseScore> {
  return parseScore({
    bpm: 120,
    bars: 1,
    tracks: [{ name: 'lead', instrument: { type: 'fm', ...instrument }, pattern: 'A4:16' }],
  });
}

test('velocity.indexScale darkens quiet FM notes', () => {
  const fixed = probeTrack(fmScore({ ratio: 2, index: 6, indexDecay: 4 }), 'lead', {
    volume: 1,
    seconds: 1,
    sensitivity: false,
  });
  const mapped = probeTrack(
    fmScore({ ratio: 2, index: 6, indexDecay: 4, velocity: { indexScale: 1 } }),
    'lead',
    { volume: 1, seconds: 1, sensitivity: false },
  );
  assert.ok(
    mapped.metrics.centroidHz < fixed.metrics.centroidHz * 0.8,
    `expected a darker centroid, got ${mapped.metrics.centroidHz} vs ${fixed.metrics.centroidHz}`,
  );
});

test('an all-zero indexScale keeps the FM render unchanged', () => {
  const plain = renderLoop(fmScore({ ratio: 2, index: 3, indexDecay: 0.4 }), {
    post: [],
    minutes: 0.05,
  });
  const zeroed = renderLoop(
    fmScore({ ratio: 2, index: 3, indexDecay: 0.4, velocity: { indexScale: 0 } }),
    { post: [], minutes: 0.05 },
  );
  assert.deepEqual(plain.left, zeroed.left);
});

// ---------------------------------------------------------------------------
// Multi-operator FM
// ---------------------------------------------------------------------------

test('one operator reproduces the classic two-operator voice exactly', () => {
  const legacy = renderLoop(fmScore({ ratio: 2, index: 3, indexDecay: 0.3 }), {
    post: [],
    minutes: 0.05,
  });
  const routed = renderLoop(
    fmScore({ operators: [{ ratio: 2, index: 3, indexDecay: 0.3, target: 0 }] }),
    { post: [], minutes: 0.05 },
  );
  assert.deepEqual(routed.left, legacy.left);
});

test('a chained modulator changes the spectrum and stays deterministic', () => {
  const twoOp = renderLoop(
    fmScore({ operators: [{ ratio: 2, index: 3, indexDecay: 0.3, target: 0 }] }),
    { post: [], minutes: 0.05 },
  );
  const fourOp = renderLoop(
    fmScore({
      operators: [
        { ratio: 2, index: 3, indexDecay: 0.3, target: 0 },
        { ratio: 1, index: 2, indexDecay: 0.5, target: 1 },
        { ratio: 3, index: 1, indexDecay: 0.2, target: 0 },
      ],
    }),
    { post: [], minutes: 0.05 },
  );
  assert.notDeepEqual(fourOp.left, twoOp.left);
  const again = renderLoop(
    fmScore({
      operators: [
        { ratio: 2, index: 3, indexDecay: 0.3, target: 0 },
        { ratio: 1, index: 2, indexDecay: 0.5, target: 1 },
        { ratio: 3, index: 1, indexDecay: 0.2, target: 0 },
      ],
    }),
    { post: [], minutes: 0.05 },
  );
  assert.deepEqual(fourOp.left, again.left);
});

test('the probe summarises a multi-operator voice', () => {
  const reading = probeTrack(
    fmScore({
      operators: [
        { ratio: 2, index: 2, indexDecay: 0.3, target: 0 },
        { ratio: 1, index: 5, indexDecay: 0.4, target: 0 },
        { ratio: 1.5, index: 1, indexDecay: 0.2, target: 1 },
      ],
      velocity: { indexScale: 0.4 },
    }),
    'lead',
    { sensitivity: false },
  );
  assert.equal(reading.metrics.fm?.operators, 4);
  assert.equal(reading.metrics.fm?.index, 5);
  const text = formatProbe(reading);
  assert.match(text, /fm 4 operators ratio 1\.00/);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parses sample regions, loops, and zone bounds', () => {
  const parsed = parseScore({
    samples: {
      sliced: {
        file: 'assets/tone.wav',
        root: 'A3',
        loop: true,
        gain: 0.5,
        start: 0.1,
        end: 1.5,
        reverse: true,
        loopStart: 0.2,
        loopEnd: 1.4,
      },
      low: 'assets/low.wav',
      high: { file: 'assets/high.wav', root: 'C5' },
      multi: {
        zones: [
          { sample: 'low', lo: 'A0', hi: 'C4' },
          { sample: 'high', lo: 'C#4', velLo: 0.4 },
        ],
      },
    },
    tracks: [{ pattern: 'C4:4' }],
  });
  const sliced = parsed.samples.get('sliced');
  assert.equal(sliced?.kind, 'file');
  if (sliced?.kind !== 'file') throw new Error('expected a file sample');
  assert.equal(sliced.rootMidi, 57);
  assert.equal(sliced.startSeconds, 0.1);
  assert.equal(sliced.endSeconds, 1.5);
  assert.equal(sliced.reverse, true);
  assert.equal(sliced.loopStartSeconds, 0.2);
  assert.equal(sliced.loopEndSeconds, 1.4);

  const multi = parsed.samples.get('multi');
  assert.equal(multi?.kind, 'zones');
  if (multi?.kind !== 'zones') throw new Error('expected a zone set');
  assert.equal(multi.zones[0]?.sample, 'low');
  assert.equal(multi.zones[0]?.loMidi, 21);
  assert.equal(multi.zones[0]?.hiMidi, 60);
  assert.equal(multi.zones[0]?.loVelocity, 0);
  assert.equal(multi.zones[0]?.hiVelocity, 1);
  assert.equal(multi.zones[1]?.loMidi, 61);
  assert.equal(multi.zones[1]?.hiMidi, 127);
  assert.equal(multi.zones[1]?.loVelocity, 0.4);
});

test('rejects contradictory sample regions and bad zone references', () => {
  const parse = (samples: unknown) => () =>
    parseScore({ samples, tracks: [{ pattern: 'C4:4' }] });

  assert.throws(
    parse({ bad: { file: 'a.wav', start: 1, end: 0.5 } }),
    /\.end \(0\.5s\) must be after \.start \(1s\)/,
  );
  assert.throws(
    parse({ bad: { file: 'a.wav', loopStart: 0.2 } }),
    /loopStart and \.loopEnd need .*loop true/,
  );
  assert.throws(
    parse({ bad: { file: 'a.wav', loopEnd: 2 } }),
    /loopStart and \.loopEnd need .*loop true/,
  );
  assert.throws(
    parse({ bad: { file: 'a.wav', loop: true, start: 0.5, loopStart: 0.2 } }),
    /loopStart must not be before/,
  );
  assert.throws(
    parse({ bad: { file: 'a.wav', loop: true, loopStart: 0.4, loopEnd: 0.3 } }),
    /loopEnd must be after/,
  );
  assert.throws(
    parse({ multi: { zones: [{ sample: 'missing' }] } }),
    /zone references|unknown sample "missing"/,
  );
  assert.throws(
    parse({
      a: { zones: [{ sample: 'b' }] },
      b: { zones: [{ sample: 'a' }] },
    }),
    /zones must point at plain files/,
  );
  assert.throws(
    parse({ multi: { zones: [] } }),
    /must be an array of 1-16 zones/,
  );
  assert.throws(
    parse({ multi: { zones: [{ sample: 'a', lo: 'C5', hi: 'C4' }] }, a: 'a.wav' }),
    /\.lo \(72\) must not be above \.hi \(60\)/,
  );
  assert.throws(
    parse({ multi: { zones: [{ sample: 'a', velLo: 0.8, velHi: 0.2 }] }, a: 'a.wav' }),
    /velLo \(0\.8\) must not be above \.velHi \(0\.2\)/,
  );
  assert.throws(
    parse({ a: { file: 'a.wav', zones: [{ sample: 'a' }] } }),
    /unknown field "file"/,
  );
});

test('rejects malformed FM operator routing', () => {
  const parse = (instrument: unknown) => () =>
    parseScore({ tracks: [{ instrument, pattern: 'C4:4' }] });

  assert.throws(
    parse({ type: 'fm', operators: [{ ratio: 2, index: 3, target: 1 }] }),
    /target must be 0 \(the carrier\) or a lower modulator index/,
  );
  assert.throws(
    parse({ type: 'fm', operators: [{ ratio: 2, index: 3, target: 0 }], index: 4 }),
    /operators replaces/,
  );
  assert.throws(
    parse({ type: 'additive', operators: [{ ratio: 2, index: 3, target: 0 }] }),
    /only apply to fm instruments/,
  );
  assert.throws(parse({ type: 'fm', operators: [] }), /array of 1-3 modulators/);
  assert.throws(
    parse({ type: 'fm', operators: [{ ratio: 9, index: 3, target: 0 }] }),
    /ratio must be between 0\.25 and 8/,
  );
});

test('parses a four-operator FM definition', () => {
  const parsed = parseScore({
    tracks: [
      {
        instrument: {
          type: 'fm',
          operators: [
            { ratio: 2, index: 3, indexDecay: 0.3, target: 0 },
            { ratio: 1, index: 2, target: 1 },
            { ratio: 3, index: 1, indexDecay: 2, target: 0 },
          ],
        },
        pattern: 'C4:4',
      },
    ],
  });
  const operators = parsed.tracks[0]?.instrument?.operators;
  assert.equal(operators?.length, 3);
  assert.deepEqual(operators?.[1], {
    ratio: 1,
    index: 2,
    indexDecay: 0.3,
    target: 1,
  });
});

test('the timbral-depth example combines regions, zones, and operators', async () => {
  const raw = await readFile(
    new URL('../examples/m16-timbral-depth.json', import.meta.url),
    'utf8',
  );
  const parsed = parseScore(raw);
  assert.deepEqual(parsed.warnings, []);
  const keys = parsed.samples.get('keys');
  assert.equal(keys?.kind, 'zones');
  if (keys?.kind !== 'zones') throw new Error('expected a zone set');
  assert.equal(keys.zones.length, 2);

  const low = parsed.samples.get('pluckLow');
  assert.equal(low?.kind, 'file');
  if (low?.kind !== 'file') throw new Error('expected a file region');
  assert.equal(low.endSeconds, 0.34);

  const high = parsed.samples.get('pluckHigh');
  assert.equal(high?.kind, 'file');
  if (high?.kind !== 'file') throw new Error('expected a file region');
  assert.equal(high.loop, true);
  assert.equal(high.loopStartSeconds, 0.22);

  const lead = parsed.tracks.find((track) => track.name === 'lead');
  assert.equal(lead?.instrument?.operators?.length, 3);
  assert.equal(lead?.instrument?.velocity?.indexScale, 0.6);
});
