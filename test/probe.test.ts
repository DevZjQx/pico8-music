import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeProbe } from '../src/app/render-service.ts';
import { encodeWav, formatProbe, probeTrack } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const PARTS = [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08];

function parseTrack(track: Record<string, unknown>, name = 'lead') {
  return parseScore(
    JSON.stringify({
      bpm: 120,
      bars: 1,
      tracks: [{ name, pattern: 'A4:16', ...track }],
    }),
  );
}

function probe(track: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return probeTrack(parseTrack(track), 'lead', {
    seconds: 0.5,
    sensitivity: false,
    ...options,
  });
}

test('odd/even separates odd-only from even-only additive sources', () => {
  const odd = probe({
    instrument: { type: 'additive', partials: [1, 0, 0.7, 0, 0.5] },
  });
  assert.equal(odd.metrics.oddEvenApplicable, true);
  assert.equal(odd.metrics.oddEvenRatio, 999);
  assert.ok((odd.metrics.oddShare ?? 0) > 0.95, `odd share ${odd.metrics.oddShare}`);

  const even = probe({
    instrument: { type: 'additive', partials: [1, 0.8, 0, 0.6, 0, 0.5] },
  });
  assert.equal(even.metrics.oddEvenApplicable, true);
  assert.equal(even.metrics.oddEvenRatio, 0);
  assert.ok((even.metrics.oddShare ?? 1) < 0.05, `odd share ${even.metrics.oddShare}`);
});

test('odd/even is omitted where the source is not a stable harmonic series', () => {
  const fm = probe({
    instrument: { type: 'fm', ratio: 3, index: 2.4, indexDecay: 0.6 },
  });
  assert.equal(fm.metrics.oddEvenApplicable, false);
  assert.ok(fm.metrics.fm !== undefined);
  assert.equal(fm.metrics.fm?.ratio, 3);
  assert.ok((fm.metrics.fm?.sidebandCount ?? 0) > 0);
  assert.match(fm.notes.join(' '), /FM/);

  const stretched = probe({
    instrument: { type: 'additive', partials: [1, 0.7, 0.4], stretch: 0.3 },
  });
  assert.equal(stretched.metrics.oddEvenApplicable, false);
  assert.match(stretched.notes.join(' '), /stretch/);

  const noise = probe({ waveform: 'noise' });
  assert.equal(noise.metrics.oddEvenApplicable, false);
  assert.match(noise.notes.join(' '), /noise/);
});

test('attack time follows the authored envelope and the sensitivity variant', () => {
  const slow = probe({
    envelope: { attack: 0.2, decay: 0, sustain: 1, release: 0.02 },
  });
  const fast = probe({
    envelope: { attack: 0.01, decay: 0, sustain: 1, release: 0.02 },
  });
  assert.ok((slow.metrics.attackSeconds ?? 0) > 0.12, `slow ${slow.metrics.attackSeconds}`);
  assert.ok((slow.metrics.attackSeconds ?? 1) < 0.22, `slow ${slow.metrics.attackSeconds}`);
  assert.ok((fast.metrics.attackSeconds ?? 1) < 0.04, `fast ${fast.metrics.attackSeconds}`);

  const articulated = probeTrack(
    parseScore(
      JSON.stringify({
        bpm: 120,
        bars: 1,
        envelopes: { slow: { attack: 0.2, decay: 0, sustain: 1, release: 0.02 } },
        tracks: [{ name: 'lead', pattern: 'A4:16~slow' }],
      }),
    ),
    'lead',
    { seconds: 0.5, sensitivity: false },
  );
  assert.ok(
    (articulated.metrics.attackSeconds ?? 0) > 0.12,
    `per-note envelope ${articulated.metrics.attackSeconds}`,
  );

  const sensitive = probe(
    { envelope: { attack: 0.05, decay: 0, sustain: 1, release: 0.02 } },
    { sensitivity: true },
  );
  const attack = sensitive.sensitivity.find((item) => item.parameter === 'envelope.attack');
  assert.ok(attack !== undefined);
  assert.ok((attack.effects.attackSeconds ?? 0) > 0.02, `delta ${attack.effects.attackSeconds}`);
});

test('tilt lowers the harmonic slope, and the probe measures that delta', () => {
  const flat = probe({ instrument: { type: 'additive', partials: PARTS } });
  const tilted = probe({ instrument: { type: 'additive', partials: PARTS, tilt: 2 } });
  assert.ok(flat.metrics.spectralSlopeDbPerOctave !== null);
  assert.ok(tilted.metrics.spectralSlopeDbPerOctave !== null);
  assert.ok(
    (tilted.metrics.spectralSlopeDbPerOctave ?? 0) <
      (flat.metrics.spectralSlopeDbPerOctave ?? 0) - 5,
    `flat ${flat.metrics.spectralSlopeDbPerOctave} tilted ${tilted.metrics.spectralSlopeDbPerOctave}`,
  );

  const sensitive = probe(
    { instrument: { type: 'additive', partials: PARTS } },
    { sensitivity: true },
  );
  const tilt = sensitive.sensitivity.find((item) => item.parameter === 'additive.tilt');
  assert.ok(tilt !== undefined);
  assert.ok(
    (tilt.effects.spectralSlopeDbPerOctave ?? 0) < -4,
    `slope delta ${tilt.effects.spectralSlopeDbPerOctave}`,
  );
});

test('FM index raises the measured centroid and the probe reports the direction', () => {
  const dark = probe({ instrument: { type: 'fm', ratio: 3, index: 1, indexDecay: 0.6 } });
  const bright = probe({ instrument: { type: 'fm', ratio: 3, index: 6, indexDecay: 0.6 } });
  assert.ok(bright.metrics.centroidHz > dark.metrics.centroidHz * 2);

  const sensitive = probe(
    { instrument: { type: 'fm', ratio: 3, index: 1, indexDecay: 0.6 } },
    { sensitivity: true },
  );
  const index = sensitive.sensitivity.find((item) => item.parameter === 'fm.index');
  assert.ok(index !== undefined);
  assert.ok((index.effects.centroidHz ?? 0) > 500, `centroid delta ${index.effects.centroidHz}`);
  assert.ok((index.effects.sidebandCount ?? 0) > 0);
});

test('HF decay follows per-partial decay and FM indexDecay', () => {
  const staticParts = probe({ instrument: { type: 'additive', partials: [1, 0.8, 0.5] } });
  const decayingParts = probe({
    instrument: {
      type: 'additive',
      partials: [
        [1, 0, 4],
        [0.8, 0, 0.05],
        [0.5, 0, 0.02],
      ],
    },
  });
  assert.equal(staticParts.metrics.hfDecaySeconds, null);
  assert.ok(decayingParts.metrics.hfDecaySeconds !== null);

  const fast = probe({ instrument: { type: 'fm', ratio: 3, index: 3, indexDecay: 0.05 } });
  const slow = probe({ instrument: { type: 'fm', ratio: 3, index: 3, indexDecay: 0.3 } });
  assert.ok((slow.metrics.hfDecaySeconds ?? 0) > (fast.metrics.hfDecaySeconds ?? 0) * 2);
});

test('the probe uses the same style role defaults and quality as the render', () => {
  const soft = probeTrack(
    parseScore(
      JSON.stringify({
        bpm: 120,
        bars: 1,
        tracks: [{ name: 'lead', role: 'lead', pattern: 'A4:16' }],
      }),
    ),
    'lead',
    { seconds: 0.5, sensitivity: false, style: 'soft' },
  );
  assert.equal(soft.instrumentType, 'additive');
  assert.equal(soft.quality, 'clean');

  const explicit = probeTrack(
    parseScore(
      JSON.stringify({
        bpm: 120,
        bars: 1,
        tracks: [
          {
            name: 'lead',
            role: 'lead',
            pattern: 'A4:16',
            instrument: { type: 'chip', waveform: 'saw' },
          },
        ],
      }),
    ),
    'lead',
    { seconds: 0.5, sensitivity: false, style: 'soft' },
  );
  assert.equal(explicit.instrumentType, 'chip');
  assert.equal(explicit.waveform, 'saw');
});

test('the bypass option removes the instrument filter from the measurement', () => {
  const track = {
    instrument: {
      type: 'additive',
      partials: [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08],
      filter: {
        cutoffHz: 900,
        resonance: 0.707,
        envAmount: 0,
        attack: 0,
        decay: 0,
        sustain: 1,
        release: 0,
      },
    },
  };
  const filtered = probe(track);
  const source = probe(track, { bypassFilter: true });
  assert.equal(filtered.filterActive, true);
  assert.equal(source.filterActive, false);
  assert.ok((source.metrics.centroidHz ?? 0) > (filtered.metrics.centroidHz ?? 0));
});

test('the probe tool writes a raw artifact and no WAV', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-probe-'));
  try {
    await writeFile(
      join(directory, 'score.json'),
      JSON.stringify({
        bpm: 120,
        bars: 1,
        tracks: [
          {
            name: 'lead',
            pattern: 'A4:16',
            instrument: { type: 'additive', partials: PARTS },
          },
        ],
      }),
      'utf8',
    );
    const text = await executeProbe(
      { scoreFile: 'score', track: 'lead', seconds: 0.5, detail: 'raw', out: 'probe' },
      { cwd: directory },
    );
    assert.match(text, /raw probe /);
    const artifact = JSON.parse(await readFile(join(directory, 'probe.json'), 'utf8')) as {
      reading?: { track?: string; metrics?: { oddEvenApplicable?: boolean } };
    };
    assert.equal(artifact.reading?.track, 'lead');
    assert.equal(artifact.reading?.metrics?.oddEvenApplicable, true);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.wav')),
      [],
      'the probe must not render an audio file',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the probe tool rejects drum and unknown tracks', async () => {
  const drums = JSON.stringify({
    bpm: 120,
    bars: 1,
    tracks: [{ name: 'drums', role: 'drums', pattern: 'K:4 H:4' }],
  });
  await assert.rejects(() => executeProbe({ score: drums, track: 'drums' }), /drum track|melodic/);

  const melodic = JSON.stringify({
    bpm: 120,
    bars: 1,
    tracks: [{ name: 'lead', pattern: 'A4:16' }],
  });
  await assert.rejects(() => executeProbe({ score: melodic, track: 'missing' }), /unknown track/);
});

test('formatProbe keeps the measurements and the limitation in the summary', () => {
  const reading = probe({
    instrument: { type: 'fm', ratio: 3, index: 2.4, indexDecay: 0.6 },
  });
  const text = formatProbe(reading);
  assert.match(text, /Probe lead \(fm\) A4 440\.00 Hz/);
  assert.match(text, /source slope/);
  assert.match(text, /fm ratio 3\.00/);
  assert.match(text, /probe note: .*odd\/even is not reported for FM/);
  assert.match(text, /sensitivity|next:/);
});

test('a sample source probes without pretending to have harmonics', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-probe-sample-'));
  try {
    const rate = 44100;
    const frames = new Float32Array(rate);
    for (let i = 0; i < frames.length; i += 1) {
      frames[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / rate);
    }
    await writeFile(join(directory, 'tone.wav'), encodeWav(frames, frames, rate));
    await writeFile(
      join(directory, 'score.json'),
      JSON.stringify({
        bpm: 120,
        bars: 1,
        samples: { tone: { file: 'tone.wav' } },
        tracks: [
          {
            name: 'sample',
            pattern: 'A4:16',
            instrument: { type: 'sample', sample: 'tone' },
          },
        ],
      }),
      'utf8',
    );
    const text = await executeProbe(
      { scoreFile: 'score', track: 'sample', seconds: 0.5, sensitivity: false },
      { cwd: directory },
    );
    assert.match(text, /\(sample\)/);
    assert.match(text, /odd\/even is not reported for samples/);
    assert.doesNotMatch(text, /odd\/even .*:1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
