import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatReport, renderLoop } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

function rmsBetween(samples: Float32Array, start: number, end: number, rate = 44100): number {
  const first = Math.max(0, Math.floor(start * rate));
  const last = Math.min(samples.length, Math.floor(end * rate));
  let squares = 0;
  for (let i = first; i < last; i += 1) squares += (samples[i] ?? 0) ** 2;
  return last > first ? Math.sqrt(squares / (last - first)) : 0;
}

/**
 * P0 of docs/space-energy-plan.md: per-section space readings, a `space` send
 * multiplier, and a `width` side multiplier. Every assertion here is about the
 * arc between sections, not a single global measurement.
 */

test('sections parse space and width, default to neutral, and reject out-of-range values', () => {
  const parsed = parseScore({
    mode: 'song',
    tracks: [{ name: 'pad', send: 0.4, pattern: 'C3:8 E3:8' }],
    arrangement: [
      { name: 'intro', bars: 1, space: 1.6, width: 0.4 },
      { name: 'drop', bars: 1 },
    ],
  });
  assert.equal(parsed.sections[0]?.space, 1.6);
  assert.equal(parsed.sections[0]?.width, 0.4);
  assert.equal(parsed.sections[1]?.space, undefined);
  assert.equal(parsed.sections[1]?.width, undefined);

  assert.throws(
    () =>
      parseScore({
        mode: 'song',
        tracks: [{ pattern: 'C3:8' }],
        arrangement: [{ bars: 1, space: 2.5 }],
      }),
    /\.space must be between 0 and 2/,
  );
  assert.throws(
    () =>
      parseScore({
        mode: 'song',
        tracks: [{ pattern: 'C3:8' }],
        arrangement: [{ bars: 1, width: -0.1 }],
      }),
    /\.width must be between 0 and 2/,
  );
});

test('explicit neutral space and width render exactly like the defaults', () => {
  const base = {
    mode: 'song' as const,
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [
      { name: 'pad', waveform: 'triangle' as const, pan: 0.4, send: 0.5, pattern: 'C3:8 E3:8' },
    ],
    arrangement: [{ name: 'a', bars: 1 }, { name: 'b', bars: 1 }],
  };
  const options = { post: [{ type: 'reverb' as const, wet: 0.2 }], withWav: false };
  const plain = renderLoop(parseScore(base), options);
  const neutral = renderLoop(
    parseScore({
      ...base,
      arrangement: [
        { name: 'a', bars: 1, space: 1, width: 1 },
        { name: 'b', bars: 1, space: 1, width: 1 },
      ],
    }),
    options,
  );
  assert.deepEqual(neutral.left, plain.left);
  assert.deepEqual(neutral.right, plain.right);
});

test('space moves the send into the reverb, so distance changes the measured width', () => {
  const parsed = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [
      { name: 'pad', role: 'pad', waveform: 'triangle', send: 0.6, pattern: 'C3:8 E3:8' },
    ],
    arrangement: [
      { name: 'far', bars: 2, space: 2 },
      { name: 'near', bars: 2, space: 0.2 },
    ],
  });
  const output = renderLoop(parsed, { post: [], withWav: false });
  const [far, near] = output.report.sections;
  assert.ok(far !== undefined && near !== undefined);
  // The dry pad is mono; the width here can only come from the send reverb.
  assert.ok(far.width > near.width + 0.05, `far ${far.width} near ${near.width}`);
  assert.ok(far.width > 0.05, `far width ${far.width}`);
});

test('section width opens the stereo image across the arrangement', () => {
  const parsed = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ name: 'lead', waveform: 'pulse', pan: 0.7, pattern: 'C4:4 E4:4' }],
    arrangement: [
      { name: 'narrow', bars: 2, width: 0.3 },
      { name: 'wide', bars: 2, width: 1.7 },
    ],
  });
  const output = renderLoop(parsed, { post: [], withWav: false });
  const [narrow, wide] = output.report.sections;
  assert.ok(narrow !== undefined && wide !== undefined);
  assert.ok(wide.width > narrow.width * 2, `narrow ${narrow.width} wide ${wide.width}`);
  assert.doesNotMatch(output.report.warnings.join(' | '), /flat-space/);
});

test('section width follows the tape/slow timeline', () => {
  const parsed = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tracks: [{ name: 'lead', waveform: 'pulse', pan: 0.7, pattern: 'C4:4 E4:4' }],
    arrangement: [
      { name: 'narrow', bars: 2, width: 0.3 },
      { name: 'wide', bars: 2, width: 1.7 },
    ],
  });
  const output = renderLoop(parsed, {
    post: [{ type: 'tape', speed: 0.8 }],
    withWav: false,
  });
  const [narrow, wide] = output.report.sections;
  assert.ok(narrow !== undefined && wide !== undefined);
  assert.ok(wide.width > narrow.width * 2, `narrow ${narrow.width} wide ${wide.width}`);
});

test('flat-space only fires when neither width nor brightness moves', () => {
  const uniform = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'lead', pan: 0.4, pattern: 'C4:4 E4:4' }],
      arrangement: [{ name: 'a', bars: 2 }, { name: 'b', bars: 2 }],
    }),
    { post: [], withWav: false },
  );
  assert.match(uniform.report.warnings.join(' | '), /flat-space:/);

  const brighter = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'lead', pan: 0.4, pattern: 'C4:4 E4:4' }],
      arrangement: [
        { name: 'dark', bars: 2, filter: 500 },
        { name: 'open', bars: 2 },
      ],
    }),
    { post: [], withWav: false },
  );
  assert.doesNotMatch(brighter.report.warnings.join(' | '), /flat-space:/);
});

test('space without any track send warns instead of silently doing nothing', () => {
  const parsed = parseScore({
    mode: 'song',
    tracks: [{ pattern: 'C3:8' }],
    arrangement: [{ name: 'intro', bars: 1, space: 1.5 }, { name: 'drop', bars: 1 }],
  });
  assert.match(parsed.warnings.join(' | '), /space-no-send:/);

  const withSend = parseScore({
    mode: 'song',
    tracks: [{ pattern: 'C3:8', send: 0.3 }],
    arrangement: [{ name: 'intro', bars: 1, space: 1.5 }, { name: 'drop', bars: 1 }],
  });
  assert.doesNotMatch(withSend.warnings.join(' | '), /space-no-send:/);
});

test('section readings stay finite through a silent section and a song tail', () => {
  const parsed = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    tail: 1,
    tracks: [{ name: 'lead', waveform: 'pulse', pan: 0.5, pattern: 'C4:4 E4:4' }],
    arrangement: [
      { name: 'silent', bars: 1, mute: ['lead'] },
      { name: 'drop', bars: 1, width: 1.5 },
    ],
  });
  const output = renderLoop(parsed, { post: [], withWav: false });
  assert.equal(output.report.sections.length, 2);
  const [silent, drop] = output.report.sections;
  assert.ok(silent !== undefined && drop !== undefined);
  for (const section of [silent, drop]) {
    assert.ok(Number.isFinite(section.rmsDb), `${section.name} rmsDb`);
    assert.ok(Number.isFinite(section.width) && section.width >= 0, `${section.name} width`);
    assert.ok(
      Number.isFinite(section.centroidHz) && section.centroidHz >= 0,
      `${section.name} centroid`,
    );
    assert.ok(
      Number.isFinite(section.onsetPerSecond) && section.onsetPerSecond >= 0,
      `${section.name} onsets`,
    );
  }
  assert.ok(drop.width > silent.width, `silent ${silent.width} drop ${drop.width}`);
});

test('section tracks move pan and filter for one part without touching the others', () => {
  const output = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [
        {
          name: 'lead',
          waveform: 'pulse',
          pattern: 'C5:2 E5:2 G5:2 C6:2',
        },
      ],
      arrangement: [
        { name: 'left-dark', bars: 1, tracks: { lead: { pan: -0.9, filter: 500 } } },
        { name: 'right-open', bars: 1, tracks: { lead: { pan: 0.9 } } },
      ],
    }),
    { post: [], withWav: false },
  );

  const [leftDark, rightOpen] = output.report.sections;
  assert.ok(leftDark !== undefined && rightOpen !== undefined);
  assert.ok(
    rmsBetween(output.left, 0, 2) > rmsBetween(output.right, 0, 2) * 2,
    'the first section should sit left',
  );
  assert.ok(
    rmsBetween(output.right, 2, 4) > rmsBetween(output.left, 2, 4) * 2,
    'the second section should sit right',
  );
  assert.ok(
    rightOpen.centroidHz > leftDark.centroidHz * 2,
    `filtered ${leftDark.centroidHz} Hz vs open ${rightOpen.centroidHz} Hz`,
  );
});

test('a section-only send creates the bus and follows the space multiplier', () => {
  const output = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'pad', waveform: 'triangle', pattern: 'C3:8 E3:8' }],
      arrangement: [
        { name: 'far', bars: 2, space: 1.5, tracks: { pad: { send: 0.8 } } },
        { name: 'near', bars: 2 },
      ],
    }),
    { post: [], withWav: false },
  );

  const [far, near] = output.report.sections;
  assert.ok(far !== undefined && near !== undefined);
  assert.ok(far.width > near.width + 0.05, `far ${far.width} near ${near.width}`);
  assert.doesNotMatch(output.report.warnings.join(' | '), /space-no-send/);
});

test('the report text carries per-section width, centroid, and onsets', () => {
  const output = renderLoop(
    parseScore({
      mode: 'song',
      bpm: 120,
      stepsPerBeat: 4,
      tracks: [{ name: 'lead', waveform: 'pulse', pan: 0.4, pattern: 'C4:2 E4:2 G4:2 C5:2' }],
      arrangement: [{ name: 'intro', bars: 1 }, { name: 'drop', bars: 1 }],
    }),
    { post: [], withWav: false },
  );
  const text = formatReport(output.report);
  assert.match(text, /report sections intro .* w\d\.\d{2} \d+Hz \d+\.\d\/s/);
  for (const section of output.report.sections) {
    assert.ok(section.width >= 0, `${section.name} width`);
    assert.ok(section.centroidHz >= 0, `${section.name} centroid`);
    assert.ok(section.onsetPerSecond >= 0, `${section.name} onsets`);
  }
});
