import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderLoop } from '../src/features/render/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

const RATE = 44100;

function rmsBetween(samples: Float32Array, start: number, end: number): number {
  const first = Math.max(0, Math.floor(start * RATE));
  const last = Math.min(samples.length, Math.floor(end * RATE));
  let squares = 0;
  for (let i = first; i < last; i += 1) squares += (samples[i] ?? 0) ** 2;
  return last > first ? Math.sqrt(squares / (last - first)) : 0;
}

const oneShot = 'C4:1 ' + '-:1 '.repeat(15);

test('groups and their track routing parse with defaults and aliases', () => {
  const parsed = parseScore({
    buses: {
      drums: { gain: 0.8, pan: -0.2, send: 0.3, duck: 0.4, reverb: { room: 0.9, damp: 0.3 } },
      pads: {},
    },
    tracks: [
      { name: 'kick', group: 'drums', pattern: 'C4:4' },
      { name: 'pad', bus: 'pads', pattern: 'E4:4' },
    ],
  });

  const drums = parsed.groups.get('drums');
  assert.equal(drums?.name, 'drums');
  assert.equal(drums?.gain, 0.8);
  assert.equal(drums?.pan, -0.2);
  assert.equal(drums?.send, 0.3);
  assert.equal(drums?.duck, 0.4);
  assert.deepEqual(drums?.reverb, { room: 0.9, damp: 0.3 });

  const pads = parsed.groups.get('pads');
  assert.equal(pads?.gain, 1);
  assert.equal(pads?.pan, 0);
  assert.equal(pads?.send, 0);
  assert.equal(pads?.reverb, undefined);

  assert.equal(parsed.tracks[0]?.group, 'drums');
  assert.equal(parsed.tracks[1]?.group, 'pads');

  const direct = parseScore({
    groups: { drums: { room: 0.6, damp: 0.7, predelayMs: 12 } },
    tracks: [{ group: 'drums', pattern: 'C4:4' }],
  });
  assert.deepEqual(direct.groups.get('drums')?.reverb, {
    room: 0.6,
    damp: 0.7,
    predelayMs: 12,
  });
});

test('group routing rejects unknown names, mixed aliases, and bad settings', () => {
  assert.throws(
    () =>
      parseScore({
        groups: { drums: {} },
        tracks: [{ group: 'nope', pattern: 'C4:4' }],
      }),
    /unknown group "nope"/,
  );
  assert.throws(
    () =>
      parseScore({
        groups: { drums: {} },
        buses: { pads: {} },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /groups and buses are synonyms/,
  );
  assert.throws(
    () =>
      parseScore({
        groups: { drums: {} },
        tracks: [{ group: 'drums', bus: 'other', pattern: 'C4:4' }],
      }),
    /group and bus are synonyms/,
  );
  assert.throws(
    () =>
      parseScore({
        groups: { drums: { reverb: { room: 0.5, wet: 0.3 } } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /unknown field "wet"/,
  );
  assert.throws(
    () =>
      parseScore({
        groups: { drums: { mystery: 1 } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /unknown field "mystery"/,
  );
});

test('a group fader and pan move its members as one submix', () => {
  const render = (gain: number, pan: number) =>
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 1,
        groups: { pad: { gain, pan } },
        tracks: [
          { name: 'pad', group: 'pad', waveform: 'triangle', pattern: 'C4:16' },
          { name: 'lead', waveform: 'pulse', pattern: '-:16' },
        ],
      }),
      { post: [], withWav: false },
    );

  const full = render(1, 0);
  const half = render(0.5, 0);
  const fullRms = rmsBetween(full.left, 0, 2);
  const halfRms = rmsBetween(half.left, 0, 2);
  assert.ok(
    Math.abs(halfRms / fullRms - 0.5) < 0.02,
    `gain ${halfRms.toFixed(4)} should be half of ${fullRms.toFixed(4)}`,
  );

  const left = render(1, -1);
  const right = render(1, 1);
  assert.ok(rmsBetween(left.left, 0, 2) > rmsBetween(left.right, 0, 2) * 100);
  assert.ok(rmsBetween(right.right, 0, 2) > rmsBetween(right.left, 0, 2) * 100);
});

test('a group filter runs once on the summed group, not on each track separately', () => {
  const score = (filtered: boolean) =>
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      groups: { bright: filtered ? { filter: 500 } : {} },
      tracks: [
        { name: 'a', group: 'bright', waveform: 'saw', pattern: 'C5:16' },
        { name: 'b', group: 'bright', waveform: 'saw', pattern: 'E5:16' },
      ],
    });
  const open = renderLoop(score(false), { post: [], withWav: false });
  const dark = renderLoop(score(true), { post: [], withWav: false });
  assert.ok(
    dark.report.centroidHz < open.report.centroidHz * 0.7,
    `open ${open.report.centroidHz.toFixed(0)} Hz, filtered ${dark.report.centroidHz.toFixed(0)} Hz`,
  );
});

test('track sends keep their pan instead of folding to a mono bus', () => {
  const output = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [{ waveform: 'triangle', pattern: oneShot, pan: -1, send: 1 }],
    }),
    { post: [], minutes: 0.05 },
  );

  const leftTail = rmsBetween(output.left, 0.5, 2);
  const rightTail = rmsBetween(output.right, 0.5, 2);
  assert.ok(leftTail > 0.01, `left return ${leftTail}`);
  assert.ok(rightTail < leftTail * 0.01, `right return ${rightTail} should stay behind the pan`);
});

test('a send object can target another group return and opt back into a mono feed', () => {
  const targeted = parseScore({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 2,
    groups: {
      dry: {},
      hall: { reverb: { room: 0.92, damp: 0.2 } },
    },
    tracks: [
      { group: 'dry', waveform: 'triangle', pattern: oneShot, send: { amount: 0.8, bus: 'hall' } },
    ],
  });
  assert.equal(targeted.tracks[0]?.send, 0.8);
  assert.equal(targeted.tracks[0]?.sendBus, 'hall');
  const targetedOut = renderLoop(targeted, { post: [], minutes: 0.05 });
  assert.ok(rmsBetween(targetedOut.right, 0.5, 1.5) > 0.01, 'the named return should carry the send');

  assert.throws(
    () =>
      parseScore({
        groups: { dry: {} },
        tracks: [{ pattern: 'C4:4', send: { amount: 0.5, bus: 'nope' } }],
      }),
    /unknown return "nope"/,
  );

  const stereo = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [{ waveform: 'triangle', pattern: oneShot, pan: -1, send: 1 }],
    }),
    { post: [], minutes: 0.05 },
  );
  const mono = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      tracks: [
        { waveform: 'triangle', pattern: oneShot, pan: -1, send: { amount: 1, stereo: false } },
      ],
    }),
    { post: [], minutes: 0.05 },
  );
  assert.ok(rmsBetween(mono.right, 0.5, 1.5) > 0.01, 'stereo:false should feed both return channels');
  assert.ok(rmsBetween(stereo.right, 0.5, 1.5) < 0.001, 'the default send should stay left');
});

test('a member send follows its source group fader and pan', () => {
  const render = (gain: number, pan: number) =>
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 2,
        groups: { pad: { gain, pan } },
        tracks: [{ group: 'pad', waveform: 'triangle', pattern: oneShot, send: 1 }],
      }),
      { post: [], minutes: 0.05 },
    );

  const full = render(1, 0);
  const half = render(0.5, 0);
  const muted = render(0, 0);
  assert.ok(rmsBetween(full.left, 0.5, 1.5) > rmsBetween(half.left, 0.5, 1.5) * 1.8);
  assert.ok(rmsBetween(muted.left, 0.5, 1.5) < 0.001, 'a muted group should not return its sends');

  const left = render(1, -1);
  assert.ok(rmsBetween(left.left, 0.5, 1.5) > rmsBetween(left.right, 0.5, 1.5) * 100);
});

test('a member track send feeds its group return, and group.send adds the finished group', () => {
  const render = (trackSend: number, groupSend: number) =>
    renderLoop(
      parseScore({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 2,
        groups: { pad: { send: groupSend, reverb: { room: 0.9, damp: 0.2 } } },
        tracks: [{ group: 'pad', waveform: 'triangle', pattern: oneShot, send: trackSend }],
      }),
      { post: [], minutes: 0.05 },
    );

  const dry = render(0, 0);
  const trackWet = render(0.8, 0);
  const groupWet = render(0, 0.8);
  assert.ok(rmsBetween(dry.right, 0.5, 1.5) < 0.005, 'no send should leave a dry gap');
  assert.ok(rmsBetween(trackWet.right, 0.5, 1.5) > 0.01, 'a track send should reach the group return');
  assert.ok(rmsBetween(groupWet.right, 0.5, 1.5) > 0.01, 'a group send should reach the same return');
});

test('each group owns its return settings, so two groups do not share one reverb', () => {
  const output = renderLoop(
    parseScore({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 2,
      groups: {
        short: { pan: -1, send: 1, reverb: { room: 0.1, damp: 1 } },
        long: { pan: 1, send: 1, reverb: { room: 0.98, damp: 0 } },
      },
      tracks: [
        { name: 'short', group: 'short', waveform: 'triangle', pattern: oneShot },
        { name: 'long', group: 'long', waveform: 'triangle', pattern: oneShot },
      ],
    }),
    { post: [], minutes: 0.05 },
  );

  const shortTail = rmsBetween(output.left, 1, 1.5);
  const longTail = rmsBetween(output.right, 1, 1.5);
  assert.ok(
    longTail > shortTail * 20,
    `short return ${shortTail.toFixed(5)}, long return ${longTail.toFixed(5)}`,
  );
});

test('space scales grouped sends and no longer warns when only a group has send', () => {
  const parsed = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    groups: { pad: { send: 0.5 } },
    tracks: [{ name: 'pad', group: 'pad', waveform: 'triangle', pattern: 'C4:8 E4:8' }],
    arrangement: [
      { name: 'far', bars: 1, space: 2 },
      { name: 'near', bars: 1, space: 0.2 },
    ],
  });
  assert.doesNotMatch(parsed.warnings.join(' | '), /space-no-send/);

  const output = renderLoop(parsed, { post: [], withWav: false });
  const [far, near] = output.report.sections;
  assert.ok(far !== undefined && near !== undefined);
  assert.ok(far.width > near.width, `far ${far.width} near ${near.width}`);
});

test('group saturation and compression parse and change only that subgroup', () => {
  const score = (group: Record<string, unknown>) =>
    parseScore({
      groups: { drums: { ...group } },
      tracks: [
        { name: 'kick', role: 'drums', group: 'drums', pattern: 'K:1 -:1 S:1 -:1' },
        { name: 'bass', role: 'bass', pattern: 'C2:4 G1:4 C2:8' },
      ],
    });

  const parsed = score({
    saturate: { drive: 0.8, mix: 0.9 },
    compress: { thresholdDb: -20, ratio: 3.5, attack: 0.005, release: 0.2, makeupDb: 1.5 },
  });
  assert.deepEqual(parsed.groups.get('drums')?.saturate, { drive: 0.8, mix: 0.9 });
  assert.deepEqual(parsed.groups.get('drums')?.compress, {
    thresholdDb: -20,
    ratio: 3.5,
    attackSeconds: 0.005,
    releaseSeconds: 0.2,
    makeupDb: 1.5,
  });

  const flat = renderLoop(score({}), { post: [], withWav: false });
  const driven = renderLoop(score({ saturate: { drive: 0.8, mix: 0.9 } }), {
    post: [],
    withWav: false,
  });
  const glued = renderLoop(
    score({ compress: { thresholdDb: -24, ratio: 4, attack: 0.005, release: 0.15 } }),
    { post: [], withWav: false },
  );
  assert.notDeepEqual(driven.left, flat.left);
  assert.notDeepEqual(glued.left, flat.left);
  assert.ok(driven.left.every((sample) => Number.isFinite(sample)));
  assert.ok(glued.left.every((sample) => Number.isFinite(sample)));
});

test('group saturation and compression reject unknown fields and bad ranges', () => {
  assert.throws(
    () =>
      parseScore({
        groups: { drums: { saturate: { drive: 2 } } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /saturate\.drive/,
  );
  assert.throws(
    () =>
      parseScore({
        groups: { drums: { compress: { ratio: 0 } } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /compress\.ratio/,
  );
  assert.throws(
    () =>
      parseScore({
        groups: { drums: { compress: { attackMs: 10 } } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /unknown field|attackMs/,
  );
});
