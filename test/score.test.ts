import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScore, ScoreError } from '../src/features/score/feature.ts';

const score = {
  bpm: 120,
  stepsPerBeat: 4,
  bars: 1,
  tracks: [{ waveform: 'pulse', volume: 5, pattern: 'C4:2 E4:2 G4:4 -:8' }],
};

test('parses the minimal score shape', () => {
  const parsed = parseScore(JSON.stringify(score));
  assert.equal(parsed.bpm, 120);
  assert.equal(parsed.totalSteps, 16);
  assert.equal(parsed.stepSeconds, 0.125);
  assert.equal(parsed.durationSeconds, 2);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0]?.patternSteps, 16);
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [event.step, event.steps, event.midi]),
    [
      [0, 2, 60],
      [2, 2, 64],
      [4, 4, 67],
    ],
  );
});

test('applies defaults for bpm, stepsPerBeat, bars, waveform, and volume', () => {
  const parsed = parseScore({ tracks: [{ pattern: 'A3:4' }] });
  assert.equal(parsed.bpm, 90);
  assert.equal(parsed.stepsPerBeat, 4);
  assert.equal(parsed.bars, 4);
  assert.equal(parsed.totalSteps, 64);
  assert.equal(parsed.tracks[0]?.waveform, 4);
  assert.equal(parsed.tracks[0]?.volume, 5);
});

test('accepts rests, effects, and accidentals', () => {  const parsed = parseScore({
    tracks: [{ waveform: 'Tilted-Saw', pattern: 'F#3:2~vibrato Bb2:2~slide rest:1 -:1' }],
  });
  const events = parsed.tracks[0]?.events ?? [];
  assert.deepEqual(
    events.map((event) => [event.midi, event.effect]),
    [
      [54, 2],
      [46, 1],
    ],
  );
  assert.equal(parsed.tracks[0]?.waveform, 1);
  assert.equal(parsed.tracks[0]?.patternSteps, 6);
});

test('parses per-note volumes and defaults them from the track', () => {
  const parsed = parseScore({ tracks: [{ volume: 6, pattern: 'C4:2@7 E4:2@0 G4:2~slide@3 A4:2~slide' }] });
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [event.volume, event.effect]),
    [
      [7, 0],
      [0, 0],
      [3, 1],
      [6, 1],
    ],
  );
});

test('parses an envelope and defaults it to the declick edges', () => {
  const plain = parseScore({ tracks: [{ pattern: 'C4:4' }] });
  assert.deepEqual(plain.tracks[0]?.envelope, {
    attack: 0.004,
    decay: 0,
    sustain: 1,
    release: 0.008,
  });

  const pluck = parseScore({
    tracks: [{ pattern: 'C4:4', envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.02 } }],
  });
  assert.deepEqual(pluck.tracks[0]?.envelope, {
    attack: 0.001,
    decay: 0.1,
    sustain: 0,
    release: 0.02,
  });

  const partial = parseScore({ tracks: [{ pattern: 'C4:4', envelope: { decay: 0.2 } }] });
  assert.equal(partial.tracks[0]?.envelope.decay, 0.2);
  assert.equal(partial.tracks[0]?.envelope.attack, 0.004);
});

test('rejects invalid per-note volumes and envelopes', () => {
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:4@8' }] }), /volume must be between 0 and 7/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:4@x' }] }), /volume must be an integer/);
  assert.throws(() => parseScore({ tracks: [{ pattern: '-:4@3' }] }), /rest cannot carry/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:4@3@4' }] }), /at most one/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:4', envelope: { sustain: 2 } }] }), /\.sustain/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:4', envelope: { attack: -1 } }] }), /\.attack/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:4', volume: 5.5 }] }), /integer/);
});

test('reports the failing field for bad input', () => {
  assert.throws(() => parseScore('{'), /not valid JSON/);
  assert.throws(() => parseScore({ tracks: [] }), /non-empty array/);
  assert.throws(
    () => parseScore({ tracks: Array.from({ length: 5 }, () => ({ pattern: 'C4' })) }),
    /at most 4/,
  );
  assert.throws(() => parseScore({ tracks: [{ pattern: 'H3:4' }] }), /unknown note "H3"/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4:0' }] }), /between 1 and 64/);
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C4~swing' }] }), ScoreError);
  assert.throws(() => parseScore({ tracks: [{ waveform: 'violin', pattern: 'C4' }] }), /waveform/);
});

test('parses drum tokens into drum events with nominal keys', () => {
  const parsed = parseScore({
    tracks: [
      {
        name: 'drums',
        role: 'drums',
        pattern: 'K:1 S:1 H:1 O:1 C:1 T:1 R:1 X:1',
      },
    ],
  });
  const track = parsed.tracks[0];
  assert.equal(track?.isDrums, true);
  assert.equal(track?.name, 'drums');
  assert.deepEqual(
    track?.events.map((event) => [event.drum, event.midi]),
    [
      ['kick', 36],
      ['snare', 38],
      ['hat', 42],
      ['openhat', 46],
      ['clap', 39],
      ['tom', 45],
      ['rim', 37],
      ['crash', 49],
    ],
  );

  const aliases = parseScore({
    tracks: [{ role: 'drums', pattern: 'kick:1 snare:1 open-hat:1 crash:1' }],
  });
  assert.deepEqual(
    aliases.tracks[0]?.events.map((event) => event.drum),
    ['kick', 'snare', 'openhat', 'crash'],
  );
});

test('rejects pitched notes and unknown tokens on drum tracks', () => {
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'C4:1' }] }),
    /drum tracks use drum tokens/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'Q:1' }] }),
    /unknown drum "Q"/,
  );
});

test('parses drum articulations and carries them through motifs', () => {
  const parsed = parseScore({
    motifs: { fill: 'S:1~flam(20)' },
    tracks: [{ role: 'drums', pattern: 'K:1~ghost S:1~flam(20) H:1~roll4 T:1~roll(3) @fill' }],
  });
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [event.drum, event.drumEffect]),
    [
      ['kick', { kind: 'ghost' }],
      ['snare', { kind: 'flam', offsetMs: 20 }],
      ['hat', { kind: 'roll', hits: 4 }],
      ['tom', { kind: 'roll', hits: 3 }],
      ['snare', { kind: 'flam', offsetMs: 20 }],
    ],
  );
});

test('rejects drum articulations in the wrong place', () => {
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:1~ghost' }] }),
    /only for drum tracks/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'K:1~slide' }] }),
    /use ~ghost, ~flam, or ~roll/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: '-:1~ghost' }] }),
    /rest cannot carry a drum effect/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'K:1~ghost~flam' }] }),
    /at most one drum effect/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'K:1~roll(1)' }] }),
    /roll hits must be an integer between 2 and 8/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'K:1~flam(100)' }] }),
    /flam offset must be between 5 and 40 ms/,
  );
  assert.throws(
    () =>
      parseScore({
        envelopes: { ghost: { attack: 0.001 } },
        tracks: [{ pattern: 'C4:1' }],
      }),
    /collides with the ghost effect/,
  );
});

const songScore = {
  mode: 'song',
  bpm: 120,
  stepsPerBeat: 4,
  patterns: {
    'drums.B': 'K:1 H:1 S:1 H:1',
  },
  tracks: [
    { name: 'drums', role: 'drums', pattern: 'K:1 -:1 H:1 -:1' },
    { name: 'bass', role: 'bass', pattern: 'C2:4' },
  ],
  arrangement: [
    { name: 'intro', bars: 1, mute: ['drums'], filter: 1200 },
    { name: 'drop', bars: 1, patterns: { drums: 'drums.B' }, gain: 0.5 },
  ],
};

test('song mode resolves arrangement sections, mutes, gains, filters, and named patterns', () => {
  const parsed = parseScore(songScore);
  assert.equal(parsed.mode, 'song');
  assert.equal(parsed.bars, 2);
  assert.equal(parsed.totalSteps, 32);
  assert.deepEqual(
    parsed.sections.map((section) => [section.name, section.startStep, section.steps, section.filterHz]),
    [
      ['intro', 0, 16, 1200],
      ['drop', 16, 16, undefined],
    ],
  );

  const drums = parsed.tracks[0];
  const bass = parsed.tracks[1];
  assert.equal(drums?.timeline?.length, 16);
  assert.deepEqual(
    drums?.timeline?.slice(0, 4).map((event) => [event.step, event.drum, event.gain]),
    [
      [16, 'kick', 0.5],
      [17, 'hat', 0.5],
      [18, 'snare', 0.5],
      [19, 'hat', 0.5],
    ],
  );
  assert.equal(bass?.timeline?.length, 8);
  assert.deepEqual(
    bass?.timeline?.slice(0, 2).map((event) => [event.step, event.midi, event.gain]),
    [
      [0, 36, 1],
      [4, 36, 1],
    ],
  );
  assert.equal(bass?.timeline?.[4]?.gain, 0.5);
});

test('song mode defaults from the arrangement and accepts track-local patterns', () => {
  const parsed = parseScore({
    tracks: [
      {
        name: 'lead',
        pattern: 'C4:4',
        patterns: { B: 'D4:4' },
      },
    ],
    arrangement: [{ bars: 2, patterns: { lead: 'B' } }],
  });
  assert.equal(parsed.mode, 'song');
  assert.equal(parsed.bars, 2);
  assert.deepEqual(
    parsed.tracks[0]?.timeline?.map((event) => [event.step, event.midi]),
    [
      [0, 62],
      [4, 62],
      [8, 62],
      [12, 62],
      [16, 62],
      [20, 62],
      [24, 62],
      [28, 62],
    ],
  );
});

test('lets a track default pattern name a track-local or global pattern', () => {
  const local = parseScore({
    tracks: [{ name: 'lead', pattern: 'lead.A', patterns: { 'lead.A': 'E4:4 G4:4' } }],
    arrangement: [{ bars: 2 }],
  });
  assert.deepEqual(
    local.tracks[0]?.timeline?.slice(0, 2).map((event) => [event.step, event.midi]),
    [
      [0, 64],
      [4, 67],
    ],
  );

  const global = parseScore({
    patterns: { arpA: 'C4:2 E4:2' },
    tracks: [{ name: 'arp', pattern: 'arpA' }],
    arrangement: [{ bars: 1 }],
  });
  assert.deepEqual(
    global.tracks[0]?.timeline?.slice(0, 4).map((event) => event.midi),
    [60, 64, 60, 64],
  );
});

test('keeps inline patterns working and reports mistyped pattern names', () => {
  const inline = parseScore({ tracks: [{ pattern: 'C4' }] });
  assert.equal(inline.tracks[0]?.events.length, 1);
  assert.equal(inline.tracks[0]?.patternSteps, 1);

  assert.throws(
    () => parseScore({ tracks: [{ name: 'lead', pattern: 'leadx' }] }),
    /tracks\[0\]\.pattern: unknown pattern "leadx"; define it in tracks\[\]\.patterns or top-level patterns/,
  );
});

test('accepts a one-token inline pattern in an arrangement', () => {
  const parsed = parseScore({
    mode: 'song',
    tracks: [{ name: 'lead', pattern: 'C4:4' }],
    arrangement: [{ bars: 1, patterns: { lead: 'C4' } }],
  });
  assert.equal(parsed.tracks[0]?.timeline?.length, 16);
  assert.deepEqual(
    parsed.tracks[0]?.timeline?.slice(0, 3).map((event) => [event.step, event.midi, event.steps]),
    [
      [0, 60, 1],
      [1, 60, 1],
      [2, 60, 1],
    ],
  );
});

test('rejects mismatched song bars and arrangement in loop mode', () => {
  assert.throws(
    () => parseScore({ ...songScore, bars: 3 }),
    /arrangement totals 2 bars/,
  );
  assert.throws(
    () => parseScore({ ...songScore, mode: 'loop' }),
    /arrangement requires mode "song"/,
  );
  assert.throws(
    () => parseScore({ ...songScore, arrangement: [] }),
    /arrangement must be a non-empty array/,
  );
  assert.throws(
    () =>
      parseScore({
        mode: 'song',
        tracks: [{ name: 'lead', pattern: 'C4:4' }],
        arrangement: [{ bars: 1, patterns: { lead: 'missing' } }],
      }),
    /unknown pattern "missing"/,
  );
});

test('reads drum type and waveform from an instrument object', () => {
  const parsed = parseScore({
    tracks: [
      { name: 'drums', instrument: { type: 'drums' }, pattern: 'K:1' },
      { name: 'bass', instrument: { type: 'chip', waveform: 'saw' }, pattern: 'C2:4' },
    ],
  });
  assert.equal(parsed.tracks[0]?.isDrums, true);
  assert.equal(parsed.tracks[1]?.waveform, 2);
});

test('resolves named and inline instruments without changing track fields', () => {
  const parsed = parseScore({
    instruments: {
      pad: {
        type: 'additive',
        partials: [1, 0.5, 0.25],
        unison: 3,
        detune: 8,
        filter: { cutoffHz: 1800, envAmount: 1.5 },
      },
      bell: { type: 'fm', ratio: 3, index: 2, indexDecay: 0.6 },
    },
    tracks: [
      { name: 'pad', role: 'pad', instrument: 'pad', pattern: '[C4,E4,G4]:4' },
      { name: 'lead', instrument: { type: 'fm', ratio: 2 }, pattern: 'C4:4' },
    ],
  });

  assert.equal(parsed.tracks[0]?.instrument?.type, 'additive');
  assert.equal(parsed.tracks[0]?.instrument?.unison, 3);
  assert.equal(parsed.tracks[0]?.instrument?.detuneCents, 8);
  assert.equal(parsed.tracks[0]?.instrument?.filter?.cutoffHz, 1800);
  assert.equal(parsed.tracks[0]?.waveform, 4);
  assert.equal(parsed.tracks[1]?.instrument?.type, 'fm');
  assert.equal(parsed.tracks[1]?.instrument?.ratio, 2);
});

test('rejects malformed instrument definitions', () => {
  const withTrack = (track: Record<string, unknown>) => () =>
    parseScore({ tracks: [track] });

  assert.throws(
    withTrack({ instrument: 'missing', pattern: 'C4:4' }),
    /unknown instrument "missing"/,
  );
  assert.throws(
    withTrack({ instrument: { type: 'orchestra' }, pattern: 'C4:4' }),
    /type must be chip, fm, or additive/,
  );
  assert.throws(
    withTrack({ instrument: { type: 'chip', partials: [1] }, pattern: 'C4:4' }),
    /partials only applies to additive/,
  );
  assert.throws(
    withTrack({ instrument: { type: 'additive', ratio: 2 }, pattern: 'C4:4' }),
    /only apply to fm/,
  );
  assert.throws(
    () =>
      parseScore({
        instruments: { chip: { type: 'chip' } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /built-in instrument type/,
  );
});

test('reads additive harmonics as amplitude, or amplitude and phase degrees', () => {
  const partialsOf = (partials: unknown) =>
    parseScore({ tracks: [{ instrument: { type: 'additive', partials }, pattern: 'C4:4' }] })
      .tracks[0]?.instrument?.partials;

  assert.deepEqual(partialsOf([1, -0.5, [0.25, 90]]), [
    { amplitude: 1, phase: 0 },
    { amplitude: 0.5, phase: Math.PI },
    { amplitude: 0.25, phase: Math.PI / 2 },
  ]);
  // Degrees wrap, so a model can write 450 without a special case.
  assert.deepEqual(partialsOf([[0.5, 450]]), partialsOf([[0.5, 90]]));

  assert.throws(() => partialsOf([1.5]), /must be between -1 and 1/);
  assert.throws(() => partialsOf([[0.5, 90, 3]]), /got 3 items/);
  assert.throws(() => partialsOf([[1.2, 0]]), /\[0\] must be between 0 and 1/);
  assert.throws(() => partialsOf([[0.5, 'fast']]), /\[1\] must be a number/);
  assert.throws(() => partialsOf([]), /1-16 harmonics/);
  assert.throws(
    () => partialsOf(new Array(17).fill(0.1)),
    /1-16 harmonics/,
  );
});

test('parses per-hit drum pitch, decay, and tone alongside articulations', () => {
  const parsed = parseScore({
    tracks: [
      {
        role: 'drums',
        pattern: 'K:1~ghost~pitch(-3)~decay(1.5)~tone(2500) S:4~pitch(2)',
      },
    ],
  });
  const first = parsed.tracks[0]?.events[0];
  assert.deepEqual(first?.drumEffect, { kind: 'ghost' });
  assert.deepEqual(first?.drumParams, { pitchSemitones: -3, decayScale: 1.5, toneHz: 2500 });
  assert.deepEqual(parsed.tracks[0]?.events[1]?.drumParams, { pitchSemitones: 2 });

  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'K:1~pitch(13)' }] }),
    /pitch must be between -12 and 12/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: 'K:1~pitch(2)~pitch(3)' }] }),
    /at most one ~pitch/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: '-:1~decay(2)' }] }),
    /a rest cannot carry ~pitch, ~decay, or ~tone/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~tone(800)' }] }),
    /only for drum tracks/,
  );
});

test('expands motif transpose, invert, and retrograde transforms', () => {
  const parsed = parseScore({
    motifs: { A: 'C4:1 E4:1 G4:2' },
    tracks: [{ pattern: '@A @A.transpose(2) @A.invert @A.retrograde' }],
  });
  assert.equal(parsed.tracks[0]?.patternSteps, 16);
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [event.step, event.midi, event.steps]),
    [
      [0, 60, 1],
      [1, 64, 1],
      [2, 67, 2],
      [4, 62, 1],
      [5, 66, 1],
      [6, 69, 2],
      [8, 60, 1],
      [9, 56, 1],
      [10, 53, 2],
      [12, 67, 2],
      [14, 64, 1],
      [15, 60, 1],
    ],
  );
});

test('expands motif augment, diminish, volumes, and effects', () => {
  const augmented = parseScore({
    motifs: { A: 'C4:2@3~slide E4:4' },
    tracks: [{ pattern: '@A.augment(2)' }],
  });
  assert.equal(augmented.tracks[0]?.patternSteps, 12);
  assert.deepEqual(
    augmented.tracks[0]?.events.map((event) => [event.steps, event.volume, event.effect]),
    [
      [4, 3, 1],
      [8, 5, 0],
    ],
  );

  const diminished = parseScore({
    motifs: { A: 'C4:2 E4:4' },
    tracks: [{ pattern: '@A.diminish(2)' }],
  });
  assert.equal(diminished.tracks[0]?.patternSteps, 3);
  assert.deepEqual(
    diminished.tracks[0]?.events.map((event) => [event.step, event.steps]),
    [
      [0, 1],
      [1, 2],
    ],
  );
});

test('nests motifs and applies outer transforms to the expanded phrase', () => {
  const parsed = parseScore({
    motifs: {
      call: 'C4:1 E4:1',
      phrase: '@call @call.transpose(2)',
    },
    tracks: [{ pattern: '@phrase.invert' }],
  });
  assert.equal(parsed.tracks[0]?.patternSteps, 4);
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [event.step, event.midi]),
    [
      [0, 60],
      [1, 56],
      [2, 58],
      [3, 54],
    ],
  );
});

test('track-local motifs override global motifs', () => {
  const parsed = parseScore({
    motifs: { A: 'C4:1' },
    tracks: [{ motifs: { A: 'G4:1' }, pattern: '@A' }],
  });
  assert.deepEqual(parsed.tracks[0]?.events.map((event) => event.midi), [67]);
});

test('motifs expand in song patterns referenced by the arrangement', () => {
  const parsed = parseScore({
    mode: 'song',
    motifs: { A: 'C4:1 E4:1' },
    patterns: { leadA: '@A.transpose(2)' },
    tracks: [{ name: 'lead', pattern: 'C4:4' }],
    arrangement: [{ bars: 1, patterns: { lead: 'leadA' } }],
  });
  assert.equal(parsed.tracks[0]?.timeline?.length, 16);
  assert.deepEqual(
    parsed.tracks[0]?.timeline?.slice(0, 4).map((event) => [event.step, event.midi]),
    [
      [0, 62],
      [1, 66],
      [2, 62],
      [3, 66],
    ],
  );
});

test('drum motifs support time and order transforms, not pitch transforms', () => {
  const parsed = parseScore({
    motifs: { D: 'K:1 S:2 H:1' },
    tracks: [{ role: 'drums', pattern: '@D.retrograde' }],
  });
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [event.step, event.drum, event.steps]),
    [
      [0, 'hat', 1],
      [1, 'snare', 2],
      [3, 'kick', 1],
    ],
  );

  assert.throws(
    () =>
      parseScore({
        motifs: { D: 'K:1' },
        tracks: [{ role: 'drums', pattern: '@D.transpose(2)' }],
      }),
    /cannot transform drum token/,
  );
});

test('rejects invalid motif references and transforms', () => {
  assert.throws(
    () => parseScore({ tracks: [{ pattern: '@missing' }] }),
    /unknown motif "missing"/,
  );
  assert.throws(
    () => parseScore({ motifs: { A: 'C4:1' }, tracks: [{ pattern: '@A.flip' }] }),
    /invalid motif transform "flip"/,
  );
  assert.throws(
    () => parseScore({ motifs: { A: 'C4:1' }, tracks: [{ pattern: '@A.transpose' }] }),
    /transpose requires an integer argument/,
  );
  assert.throws(
    () => parseScore({ motifs: { A: 'C4:1' }, tracks: [{ pattern: '@A.invert(2)' }] }),
    /invert takes no argument/,
  );
  assert.throws(
    () => parseScore({ motifs: { A: 'C4:1' }, tracks: [{ pattern: '@A.diminish(2)' }] }),
    /needs every slot and gate duration divisible by 2/,
  );
  assert.throws(
    () =>
      parseScore({
        motifs: { A: '@B', B: '@A' },
        tracks: [{ pattern: '@A' }],
      }),
    /motif cycle A -> B -> A/,
  );
  assert.throws(
    () =>
      parseScore({
        motifs: { A: 'C7:1' },
        tracks: [{ pattern: '@A.transpose(24)' }],
      }),
    /outside C1..C8/,
  );
});

test('parses chords and gate lengths into polyphonic events', () => {
  const parsed = parseScore({
    swing: 0.25,
    tracks: [{ waveform: 'triangle', pattern: '[C4,E4,G4]:4g2@6~slide' }],
  });
  assert.equal(parsed.swing, 0.25);
  assert.equal(parsed.tracks[0]?.patternSteps, 4);
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => [
      event.step,
      event.steps,
      event.gateSteps,
      event.voice,
      event.midi,
      event.volume,
      event.effect,
    ]),
    [
      [0, 4, 2, 0, 60, 6, 1],
      [0, 4, 2, 1, 64, 6, 1],
      [0, 4, 2, 2, 67, 6, 1],
    ],
  );

  const legato = parseScore({ tracks: [{ pattern: 'C4:4g8' }] });
  assert.equal(legato.tracks[0]?.events[0]?.steps, 4);
  assert.equal(legato.tracks[0]?.events[0]?.gateSteps, 8);
});

test('rejects invalid chords, drum chords, and swing values', () => {
  assert.throws(
    () => parseScore({ tracks: [{ pattern: '[C4,E4,F4,G4,A4]:4' }] }),
    /use at most 4/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: '[C4,E4,G4]:4' }], swing: 0.6 }),
    /swing must be between 0 and 0.5/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ role: 'drums', pattern: '[K,S]:1' }] }),
    /drum chords are not supported/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4g0' }] }),
    /gate must be between 1 and 256/,
  );
});

test('expands named chords, slash basses, and explicit octaves', () => {
  const parsed = parseScore({
    tracks: [
      {
        pattern:
          'Cmaj7:4 Fm:4 Fm/E:4 G7/B:4 Cmaj74:4 Fm2:4 {C7}:4 {C4}:4 C9/E:4',
      },
    ],
  });
  const byStep = new Map<number, number[]>();
  for (const event of parsed.tracks[0]?.events ?? []) {
    const list = byStep.get(event.step) ?? [];
    list.push(event.midi);
    byStep.set(event.step, list);
  }
  assert.deepEqual(byStep.get(0), [60, 64, 67, 71]); // Cmaj7
  assert.deepEqual(byStep.get(4), [65, 68, 72]); // Fm
  assert.deepEqual(byStep.get(8), [52, 65, 68, 72]); // Fm/E: E3 bass
  assert.deepEqual(byStep.get(12), [59, 67, 71, 77]); // G7/B: B3 bass, fifth dropped
  assert.deepEqual(byStep.get(16), [60, 64, 67, 71]); // Cmaj74
  assert.deepEqual(byStep.get(20), [41, 44, 48]); // Fm2: quality first, then octave
  assert.deepEqual(byStep.get(24), [60, 64, 67, 70]); // {C7} forced chord
  assert.deepEqual(byStep.get(28), [60, 64, 67]); // {C4} forced C major
  assert.deepEqual(byStep.get(32), [52, 64, 70, 74]); // C9/E keeps 3/7/9
});

test('bare notes win over chord names that look like an octave', () => {
  const parsed = parseScore({ tracks: [{ pattern: 'C7:4 C5:4 Bb2:4' }] });
  assert.deepEqual(
    parsed.tracks[0]?.events.map((event) => event.midi),
    [96, 72, 46],
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'Hmaj7:4' }] }),
    /unknown note "Hmaj7"/,
  );
  // A bare letter is a missing octave, not an implicit major triad.
  assert.throws(() => parseScore({ tracks: [{ pattern: 'C:4' }] }), /unknown note "C"/);
  assert.deepEqual(
    parseScore({ tracks: [{ pattern: 'Cmaj:4' }] }).tracks[0]?.events.map((event) => event.midi),
    [60, 64, 67],
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: '{C99}:4' }] }),
    /outside C1\.\.C8|unknown note/,
  );
});

test('named envelopes attach per note without changing the track default', () => {
  const parsed = parseScore({
    envelopes: {
      pluck: { attack: 0.001, decay: 0.05, sustain: 0.02, release: 0.02 },
    },
    tracks: [
      {
        pattern: 'C4:4~pluck C4:4~vib~pluck C4:4@6~pluck',
        envelope: { attack: 0.2, decay: 0.1, sustain: 0.8, release: 0.3 },
      },
    ],
  });
  const events = parsed.tracks[0]?.events ?? [];
  assert.equal(events[0]?.envelope?.decay, 0.05);
  assert.equal(events[1]?.envelope?.decay, 0.05);
  assert.equal(events[1]?.effect, 2);
  assert.equal(events[2]?.volume, 6);
  assert.equal(events[2]?.envelope?.decay, 0.05);
  assert.equal(parsed.tracks[0]?.envelope.decay, 0.1);
});

test('rejects unknown envelopes, effect-name collisions, and envelope parameters', () => {
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~pluck' }] }),
    /unknown envelope "pluck"/,
  );
  assert.throws(
    () => parseScore({
      envelopes: { vibrato: { attack: 0.01 } },
      tracks: [{ pattern: 'C4:4' }],
    }),
    /collides with the vibrato effect/,
  );
  assert.throws(
    () => parseScore({
      envelopes: { pluck: { attack: 0.01 } },
      tracks: [{ pattern: 'C4:4~pluck(2)' }],
    }),
    /takes no parameters/,
  );
  assert.throws(
    () =>
      parseScore({
        envelopes: { pitch: { attack: 0.01 } },
        tracks: [{ pattern: 'C4:4' }],
      }),
    /collides with the pitch effect/,
  );
});

test('parses parameterised vibrato and slide effects', () => {
  const parsed = parseScore({
    tracks: [{ pattern: 'C4:4~vib(0.4,6) C4:4~slide(0.5) C4:4~vib(0.3)' }],
  });
  const events = parsed.tracks[0]?.events ?? [];
  assert.deepEqual(events[0]?.effectParams, { vibratoDepth: 0.4, vibratoRate: 6 });
  assert.deepEqual(events[1]?.effectParams, { slideSteps: 0.5 });
  assert.equal(events[2]?.effectParams?.vibratoDepth, 0.3);
  assert.equal(events[2]?.effectParams?.vibratoRate, 7.5);

  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~vib(3)' }] }),
    /vibrato depth must be between 0 and 2/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~vib(0.4,50)' }] }),
    /vibrato rate must be between 0.1 and 20/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~slide(0)' }] }),
    /slide time must be between 0.05 and 8/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~drop(1)' }] }),
    /drop takes no parameters/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4~slide(a)' }] }),
    /is not a number/,
  );
});

test('parses the score seed and mix-stage track fields', () => {
  const parsed = parseScore({
    seed: 42,
    tracks: [
      {
        name: 'bass',
        pattern: 'C2:4',
        pan: -0.5,
        send: 0.4,
        duck: 0.7,
        filter: { cutoffHz: 800, q: 6, lfoHz: 1.5, lfoDepth: 2 },
        delay: { steps: 3, feedback: 0.4, mix: 0.3 },
      },
    ],
  });
  assert.equal(parsed.seed, 42);
  const track = parsed.tracks[0];
  assert.equal(track?.pan, -0.5);
  assert.equal(track?.send, 0.4);
  assert.equal(track?.duck, 0.7);
  assert.deepEqual(track?.filter, {
    cutoffHz: 800,
    resonance: 6,
    lfoHz: 1.5,
    lfoDepth: 2,
  });
  assert.deepEqual(track?.delay, { steps: 3, feedback: 0.4, mix: 0.3 });

  const defaults = parseScore({ tracks: [{ pattern: 'C2:4' }] });
  assert.equal(defaults.seed, 0);
  assert.equal(defaults.tracks[0]?.pan, 0);
  assert.equal(defaults.tracks[0]?.send, 0);
  assert.equal(defaults.tracks[0]?.duck, 0);
  assert.equal(defaults.tracks[0]?.filter, undefined);
  assert.equal(defaults.tracks[0]?.delay, undefined);
});

test('rejects unknown fields instead of silently dropping them', () => {
  // The old bug: mix-stage fields nested under "mix" parsed as centred and
  // dry, so pan/send/duck looked like no-ops in the renderer.
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4', mix: { pan: -1 } }] }),
    (error: unknown) =>
      error instanceof ScoreError &&
      /tracks\[0\]: unknown field "mix"/.test(error.message) &&
      /flat: pan, send, duck, filter, delay/.test(error.message),
  );
  assert.throws(
    () => parseScore({ tempo: 120, tracks: [{ pattern: 'C4:4' }] }),
    /score: unknown field "tempo"/,
  );
  // Tool arguments are a separate level of the call. Name that boundary so a
  // model does not have to guess whether post belongs to the score or the tool.
  assert.throws(
    () => parseScore({ post: [], tracks: [{ pattern: 'C4:4' }] }),
    (error: unknown) =>
      error instanceof ScoreError &&
      /score: unknown field "post"/.test(error.message) &&
      /"post" is a p8_music tool parameter, not a top-level score field/.test(error.message) &&
      /alongside "score", outside the score JSON/.test(error.message),
  );
  assert.throws(
    () => parseScore({ post: [], preset: 'dreamy', tracks: [{ pattern: 'C4:4' }] }),
    /"post", "preset" are p8_music tool parameters, not top-level score fields/,
  );
  assert.throws(
    () =>
      parseScore({
        tracks: [{ pattern: 'C4:4', delay: { steps: 2, wet: 0.5 } }],
      }),
    /tracks\[0\]\.delay: unknown field "wet"/,
  );
  assert.throws(
    () =>
      parseScore({
        mode: 'song',
        tracks: [{ name: 'lead', pattern: 'C4:4' }],
        arrangement: [{ bars: 1, mute: [], sideways: true }],
      }),
    /arrangement\[0\]: unknown field "sideways"/,
  );
  // Known fields and aliases still parse.
  const parsed = parseScore({
    tracks: [{ pattern: 'C4:4', pan: -1, filter: { cutoff: 800, q: 2 } }],
  });
  assert.equal(parsed.tracks[0]?.pan, -1);
  assert.equal(parsed.tracks[0]?.filter?.cutoffHz, 800);
});

test('parses a section filter sweep', () => {
  const parsed = parseScore({
    mode: 'song',
    tracks: [{ name: 'lead', pattern: 'C4:4' }],
    arrangement: [
      { name: 'build', bars: 1, filter: { from: 400, to: 8000 } },
      { name: 'drop', bars: 1, filter: 1200 },
    ],
  });
  assert.equal(parsed.sections[0]?.filterHz, 400);
  assert.equal(parsed.sections[0]?.filterEndHz, 8000);
  assert.equal(parsed.sections[1]?.filterHz, 1200);
  assert.equal(parsed.sections[1]?.filterEndHz, undefined);
});

test('parses section energy and replaces the last bar with a fill pattern', () => {
  const parsed = parseScore({
    mode: 'song',
    bpm: 120,
    stepsPerBeat: 4,
    patterns: {
      main: 'K:1 -:1 H:1 -:1',
      fill: 'S:1 S:1 S:1 S:1',
    },
    tracks: [
      { name: 'drums', role: 'drums', pattern: 'main' },
      { name: 'bass', role: 'bass', pattern: 'C2:4' },
    ],
    arrangement: [
      { name: 'quiet', bars: 2, energy: 0.25, filter: 800 },
      { name: 'drop', bars: 2, energy: 1, fill: { bars: 1, patterns: { drums: 'fill' } } },
    ],
  });

  assert.deepEqual(
    parsed.sections.map((section) => [section.name, section.energy, section.filterHz]),
    [
      ['quiet', 0.25, 800],
      ['drop', 1, undefined],
    ],
  );
  assert.equal(parsed.tracks[1]?.timeline?.[0]?.gain, 0.625);

  const drums = parsed.tracks[0]?.timeline ?? [];
  assert.ok(
    drums.some((event) => event.step >= 32 && event.step < 48 && event.drum === 'kick'),
    'normal pattern should still play before the fill window',
  );
  const fillBar = drums.filter((event) => event.step >= 48);
  assert.equal(fillBar.length, 16);
  assert.ok(fillBar.every((event) => event.drum === 'snare'));
});

test('validates section fills', () => {
  const base = {
    mode: 'song',
    tracks: [{ name: 'drums', role: 'drums', pattern: 'K:4' }],
  };
  assert.throws(
    () => parseScore({ ...base, arrangement: [{ bars: 1, fill: { bars: 2, patterns: { drums: 'S:4' } } }] }),
    /do not fit/,
  );
  assert.throws(
    () => parseScore({ ...base, arrangement: [{ bars: 1, fill: { bars: 1, patterns: { nope: 'S:4' } } }] }),
    /unknown track or role "nope"/,
  );
  assert.throws(
    () => parseScore({ ...base, arrangement: [{ bars: 1, fill: { patterns: {} } }] }),
    /must name at least one track or role/,
  );
  assert.throws(
    () => parseScore({ ...base, arrangement: [{ bars: 1, energy: 2 }] }),
    /\.energy must be between 0 and 1/,
  );

  const misaligned = parseScore({
    ...base,
    arrangement: [{ bars: 1, fill: { bars: 1, patterns: { drums: 'S:3' } } }],
  });
  assert.match(misaligned.warnings.join(' | '), /fill-misaligned/);
});

test('rejects out-of-range mix fields', () => {
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4', pan: 2 }] }),
    /pan must be between -1 and 1/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4', delay: { steps: 0 } }] }),
    /steps must be between 1 and 64/,
  );
  assert.throws(
    () => parseScore({ tracks: [{ pattern: 'C4:4', filter: { lfoHz: 30 } }] }),
    /cutoffHz is required/,
  );
});

test('warns when a pattern does not fill its loop or section', () => {
  const loop = parseScore({ bpm: 120, bars: 1, tracks: [{ pattern: 'C4:3' }] });
  assert.match(loop.warnings.join(' | '), /pattern-misaligned: track track0 uses a 3-step pattern/);

  const song = parseScore({
    mode: 'song',
    bpm: 120,
    tracks: [{ name: 'lead', pattern: 'C4:3' }],
    arrangement: [{ name: 'intro', bars: 1 }],
  });
  assert.match(song.warnings.join(' | '), /pattern-misaligned: arrangement\[0\].*16 steps/);

  const aligned = parseScore({ bpm: 120, bars: 1, tracks: [{ pattern: 'C4:4' }] });
  assert.deepEqual(aligned.warnings, []);
});

test('bounds the total arrangement length and section count', () => {
  const tooLong = {
    mode: 'song',
    bpm: 30,
    stepsPerBeat: 1,
    tracks: [{ pattern: 'C4:4' }],
    arrangement: [
      { name: 'a', bars: 64 },
      { name: 'b', bars: 64 },
    ],
  };
  assert.throws(() => parseScore(tooLong), /render budget is 900 s/);

  const tooManySections = {
    mode: 'song',
    tracks: [{ pattern: 'C4:4' }],
    arrangement: Array.from({ length: 257 }, (_, index) => ({ name: `s${index}`, bars: 1 })),
  };
  assert.throws(() => parseScore(tooManySections), /at most 256/);
});
