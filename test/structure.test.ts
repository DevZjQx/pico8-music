import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAnalyze, executeRender } from '../src/app/render-service.ts';
import { analyseAudio, formatReport, renderLoop } from '../src/features/render/feature.ts';
import { parseScore, type Score } from '../src/features/score/feature.ts';
import { analyseScore } from '../src/features/structure/feature.ts';

/**
 * The symbolic structure reading answers the three composition questions the
 * mix report cannot: how busy is each bar, how does the melody move and repeat,
 * and which parts share a register. These tests pin the definitions to the
 * score timeline, not to a rendered signal.
 */

/** Same threshold render/analyze.ts uses; the test only needs to exceed it. */
const LEAPY_SHARE = 0.4;

const SILENCE = new Float32Array(2048);

function findingsOf(score: Score) {
  return analyseAudio(SILENCE, SILENCE, 44100, { structure: analyseScore(score) }).findings;
}

test('a loop pattern is expanded once, and every bar is counted', () => {
  const score = parseScore({
    bpm: 120,
    bars: 2,
    tracks: [
      { name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:4 D4:4 E4:4 F4:4' },
    ],
  });
  const structure = analyseScore(score);
  assert.equal(structure.stepsPerBar, 16);
  assert.equal(structure.bars, 2);
  assert.deepEqual(structure.grid.map((row) => row.attacks), [4, 4]);
  assert.deepEqual(structure.grid.map((row) => row.steps), [4, 4]);
  assert.equal(structure.notes, 8);
  assert.equal(structure.activeBars, 2);
  assert.equal(structure.drumBars, 0);

  const lead = structure.tracks[0];
  assert.ok(lead !== undefined);
  assert.equal(lead.attacks, 8);
  assert.equal(lead.notes, 8);
  assert.equal(lead.voicesPerAttack, 1);
  assert.equal(lead.lowestMidi, 60);
  assert.equal(lead.highestMidi, 65);
  assert.equal(lead.pitchClasses, 4);
  assert.ok(Math.abs(lead.entropyBits - 2) < 1e-9, `entropy ${lead.entropyBits}`);
  assert.equal(lead.intervals, 7);
  assert.ok(Math.abs(lead.stepwise - 6 / 7) < 1e-9, `stepwise ${lead.stepwise}`);
  assert.ok(Math.abs(lead.leaps - 1 / 7) < 1e-9, `leaps ${lead.leaps}`);
  assert.equal(lead.largestLeap, 5);
  // Both bars are the same phrase, so half of them restate an earlier bar.
  assert.equal(lead.repeatRate, 0.5);
});

test('a chord is one rhythmic attack but several voices', () => {
  const structure = analyseScore(
    parseScore({
      bpm: 120,
      bars: 1,
      tracks: [
        {
          name: 'chords',
          role: 'pad',
          waveform: 'triangle',
          pattern: '[C4,E4,G4]:4 [C4,E4,G4]:4',
        },
      ],
    }),
  );
  const row = structure.grid[0];
  assert.ok(row !== undefined);
  assert.equal(row.attacks, 4);
  assert.equal(row.notes, 12);
  assert.equal(row.steps, 4);

  const chords = structure.tracks[0];
  assert.ok(chords !== undefined);
  assert.equal(chords.attacks, 4);
  assert.equal(chords.notes, 12);
  assert.equal(chords.voicesPerAttack, 3);
  assert.equal(chords.intervals, 9);
  // Each voice repeats the same pitch, so no interval is a leap.
  assert.equal(chords.stepwise, 1);
  assert.equal(chords.leaps, 0);
});

test('the reading follows the resolved arrangement, including section mutes', () => {
  const score = parseScore({
    mode: 'song',
    bpm: 120,
    bars: 2,
    tracks: [
      { name: 'drums', role: 'drums', pattern: 'K:4 H:4 S:4 H:4' },
      { name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' },
    ],
    arrangement: [
      { name: 'intro', bars: 1, mute: ['drums'] },
      { name: 'drop', bars: 1 },
    ],
  });
  const structure = analyseScore(score);
  assert.deepEqual(structure.grid.map((row) => row.section), ['intro', 'drop']);
  // A muted track has an empty timeline in the section, so it contributes 0.
  assert.deepEqual(structure.grid.map((row) => row.drumHits), [0, 4]);
  assert.deepEqual(structure.grid.map((row) => row.notes), [4, 4]);
  assert.equal(structure.drumBars, 1);
});

test('bar length follows stepsPerBeat and beatsPerBar', () => {
  const score = parseScore({
    bpm: 120,
    stepsPerBeat: 2,
    beatsPerBar: 3,
    bars: 2,
    tracks: [{ name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:2 D4:2 E4:2' }],
  });
  const structure = analyseScore(score);
  assert.equal(structure.stepsPerBar, 6);
  assert.equal(structure.bars, 2);
  assert.deepEqual(structure.grid.map((row) => row.attacks), [3, 3]);
  assert.deepEqual(structure.grid.map((row) => row.notes), [3, 3]);
});

test('rolls and flams expand into their real attack counts', () => {
  const structure = analyseScore(
    parseScore({
      bpm: 120,
      bars: 1,
      tracks: [
        { name: 'drums', role: 'drums', pattern: 'K:4~roll4 S:4~flam H:4 H:4' },
      ],
    }),
  );
  const row = structure.grid[0];
  assert.ok(row !== undefined);
  assert.equal(row.attacks, 8);
  assert.equal(row.drumHits, 8);
  assert.equal(row.notes, 0);
  assert.equal(structure.tracks[0]?.voicesPerAttack, 0);
  // Drum tracks have no pitch reading.
  assert.equal(structure.tracks[0]?.pitchClasses, 0);
});

test('section density names the busiest bar and its spread', () => {
  const score = parseScore({
    mode: 'song',
    bpm: 120,
    patterns: {
      'lead.a': 'C4:4 E4:4 G4:4 C5:4',
      'lead.fill':
        'C4:1 D4:1 E4:1 F4:1 G4:1 A4:1 B4:1 C5:1 C5:1 B4:1 A4:1 G4:1 F4:1 E4:1 D4:1 C4:1',
    },
    tracks: [{ name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'lead.a' }],
    arrangement: [
      {
        name: 'drop',
        bars: 8,
        patterns: { lead: 'lead.a' },
        fill: { bars: 1, patterns: { lead: 'lead.fill' } },
      },
    ],
  });
  const structure = analyseScore(score);
  const section = structure.sections[0];
  assert.ok(section !== undefined);
  assert.equal(section.name, 'drop');
  assert.equal(section.bars, 8);
  assert.equal(section.attacksPerBar, 5.5);
  assert.equal(section.busiestBar, 8);
  assert.equal(section.busiest, 16);
  assert.equal(section.quietest, 4);
  assert.equal(section.quietestBar, 1);

  const spike = findingsOf(score).find((finding) => finding.kind === 'density-spike');
  assert.ok(spike !== undefined, 'a 16-attack fill bar should be named');
  assert.match(spike.message, /bar 8 has 16 attacks vs 5\.5 per bar in drop/);
  assert.match(spike.next ?? '', /thin that bar/);
});

test('a long section with one attack count everywhere is called flat', () => {
  const score = parseScore({
    mode: 'song',
    bpm: 120,
    tracks: [{ name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
    arrangement: [{ name: 'loop', bars: 8 }],
  });
  const flat = findingsOf(score).find((finding) => finding.kind === 'density-flat');
  assert.ok(flat !== undefined, 'eight identical bars should be named');
  assert.match(flat.message, /loop holds 4\.0 attacks in every one of its 8 bars/);
});

test('a whole arrangement stuck on one pitch class is melody-static', () => {
  const score = parseScore({
    bpm: 120,
    bars: 4,
    // 16 attacks per bar, all on C4: 64 notes, one pitch class.
    tracks: [{ name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'C4:1 C4:1' }],
  });
  const staticFinding = findingsOf(score).find((finding) => finding.kind === 'melody-static');
  assert.ok(staticFinding !== undefined, 'one pitch class over 64 notes should be named');
  assert.match(staticFinding.message, /1 pitch class across 64 notes/);
  // A repeated note is stepwise, not a leap.
  assert.ok(!findingsOf(score).some((finding) => finding.kind === 'melody-leapy'));
});

test('an all-leap melody is named, but a jumping bass line is not', () => {
  const lead = parseScore({
    bpm: 120,
    bars: 4,
    tracks: [
      { name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:4 C6:4 C4:4 C6:4' },
      // A pad supplies other pitch classes so the static-harmony rule stays out.
      { name: 'pad', role: 'pad', waveform: 'triangle', pattern: '[C3,E3,G3,B3]:16' },
    ],
  });
  const leapy = findingsOf(lead).find((finding) => finding.kind === 'melody-leapy');
  assert.ok(leapy !== undefined, 'a line of octave jumps should be named');
  assert.match(leapy.message, /lead leaps on 100% of 15 intervals \(largest 24 st, 0% stepwise\)/);

  const bass = parseScore({
    bpm: 120,
    bars: 4,
    tracks: [{ name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'C2:4 C4:4 C2:4 C4:4' }],
  });
  assert.ok(
    !findingsOf(bass).some((finding) => finding.kind === 'melody-leapy'),
    'octave bass lines are idiomatic and must not be flagged',
  );
});

test('a chord part is not a melodic line, so its root motion is not a leaping melody', () => {
  const score = parseScore({
    bpm: 120,
    bars: 8,
    tracks: [
      {
        name: 'pad',
        role: 'pad',
        waveform: 'triangle',
        pattern: '[A3,C4,E4]:4 [F3,A3,C4]:4 [C4,E4,G4]:4 [G3,B3,D4]:4',
      },
    ],
  });
  const structure = analyseScore(score);
  // The per-voice intervals really are wide: they are the chord roots moving.
  assert.ok((structure.tracks[0]?.leaps ?? 0) > LEAPY_SHARE);
  assert.ok(
    !findingsOf(score).some((finding) => finding.kind === 'melody-leapy'),
    'a three-voice pad must not be read as a wandering melody',
  );
});

test('two parts that occupy the same two octaves are a register collision', () => {
  const score = parseScore({
    bpm: 120,
    bars: 1,
    tracks: [
      { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'C2:8 C4:8' },
      { name: 'pad', role: 'pad', waveform: 'triangle', pattern: '[C2,C4]:16' },
    ],
  });
  const structure = analyseScore(score);
  const overlap = structure.register[0];
  assert.ok(overlap !== undefined);
  assert.equal(overlap.section, 'loop');
  assert.equal(overlap.a, 'bass');
  assert.equal(overlap.b, 'pad');
  assert.ok(Math.abs(overlap.overlapOctaves - 25 / 12) < 1e-9, `octaves ${overlap.overlapOctaves}`);
  assert.equal(overlap.sharedPitchClasses, 1);

  const collision = findingsOf(score).find((finding) => finding.kind === 'register-collision');
  assert.ok(collision !== undefined);
  assert.match(collision.message, /bass and pad share 2\.1 octaves in loop/);
});

test('narrow ranges that only touch stay out of the register list', () => {
  const score = parseScore({
    bpm: 120,
    bars: 1,
    tracks: [
      { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'C2:16' },
      { name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'C3:16' },
    ],
  });
  assert.deepEqual(analyseScore(score).register, []);
});

test('the density line caps a many-section arrangement', () => {
  const arrangement = Array.from({ length: 10 }, (_, index) => ({
    name: `s${index + 1}`,
    bars: 1,
  }));
  const score = parseScore({
    mode: 'song',
    bpm: 120,
    tracks: [{ name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
    arrangement,
  });
  const text = formatReport(
    analyseAudio(SILENCE, SILENCE, 44100, { structure: analyseScore(score) }),
  );
  assert.match(text, /report density s1 .* · s8 .* · \+2 more/);
  assert.doesNotMatch(text, /s9 /);
});

test('the render report carries structure lines and keeps loop bars authored', () => {
  const score = parseScore({
    bpm: 120,
    bars: 1,
    tracks: [
      { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'C2:8 C4:8' },
      { name: 'pad', role: 'pad', waveform: 'triangle', pattern: '[C2,E4]:16' },
    ],
  });
  const output = renderLoop(score, { post: [], minutes: 0.1, withWav: false });
  // A 2-minute loop still measures the one authored bar, not its repeats.
  assert.equal(output.report.structure?.bars, 1);

  const text = formatReport(output.report);
  assert.match(text, /report bars 1 · \d+\.\d{2} attacks\/bar .* 2 pitch classes \(entropy \d\.\d{2}\)/);
  assert.match(text, /report density loop \d+\.\d{2}\/bar d0\.00 n\d+\.\d{2} \d+-\d+/);
  assert.match(text, /report structure bass n2 pc1 e0\.00 s\d\.\d{2} l\d\.\d{2} r\d\.\d{2}/);
  assert.match(text, /report register loop bass\+pad 2\.1 oct/);
});

test('structure is deterministic and independent of the post chain', () => {
  const score = parseScore({
    bpm: 120,
    bars: 2,
    tracks: [
      { name: 'drums', role: 'drums', pattern: 'K:1 H:1 S:1 H:1' },
      { name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'C4:4 E4:4 G4:4 C5:4' },
    ],
  });
  assert.deepEqual(analyseScore(score), analyseScore(score));

  const dry = renderLoop(score, { post: [], minutes: 0.05, withWav: false });
  const wet = renderLoop(score, { style: 'hitech', minutes: 0.05, withWav: false });
  assert.deepEqual(dry.report.structure, wet.report.structure);
});

test('the raw render artifact keeps the bar grid, and p8_analyze cannot', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-structure-'));
  try {
    const target = join(directory, 'loop');
    const score = {
      bpm: 120,
      bars: 2,
      tracks: [{ name: 'lead', role: 'lead', waveform: 'triangle', pattern: 'C4:4 E4:4 G4:4 C5:4' }],
    };
    const rendered = await executeRender({
      score: JSON.stringify(score),
      out: target,
      detail: 'raw',
    });
    assert.match(rendered, /report structure lead n8 /);

    const raw = JSON.parse(await readFile(`${target}.analysis.json`, 'utf8'));
    assert.equal(raw.analysis.structure.bars, 2);
    assert.equal(raw.analysis.structure.grid.length, 2);
    assert.equal(raw.analysis.structure.tracks[0].name, 'lead');

    // A finished WAV has no score, so the symbolic reading must be absent.
    const analyzed = await executeAnalyze({ path: `${target}.wav` });
    assert.doesNotMatch(analyzed, /report bars|report structure|report density|report harmony/);
    const analyzedRaw = await executeAnalyze({ path: `${target}.wav`, detail: 'raw' });
    assert.match(analyzedRaw, /raw analysis /);
    const wavRaw = JSON.parse(await readFile(`${target}.wav.analysis.json`, 'utf8'));
    assert.equal(wavRaw.analysis.structure, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('harmony reads one bass root per bar and how far it moves', () => {
  const score = parseScore({
    key: 'Am',
    bpm: 120,
    bars: 4,
    tracks: [
      { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'A2:16 F2:16 C3:16 G2:16' },
      {
        name: 'pad',
        role: 'pad',
        waveform: 'triangle',
        pattern: '[A3,C4,E4]:16 [F3,A3,C4]:16 [C4,E4,G4]:16 [G3,B3,D4]:16',
      },
    ],
  });
  const harmony = analyseScore(score).harmony;
  assert.ok(harmony !== undefined, 'a score with melodic notes has a harmony reading');

  assert.equal(harmony.classes, 4);
  assert.equal(harmony.soundingBars, 4);
  assert.equal(harmony.changes, 3);
  assert.ok(Math.abs(harmony.changesPerBar - 0.75) < 1e-9, `perBar ${harmony.changesPerBar}`);
  // A down to F is a third; F to C and C to G are fifths.
  assert.ok(Math.abs(harmony.fifths - 2 / 3) < 1e-9, `fifths ${harmony.fifths}`);
  assert.equal(harmony.seconds, 0);
  assert.equal(harmony.largest, 5);

  assert.equal(harmony.key?.label, 'Am');
  assert.equal(harmony.key?.inKey, 1);
  assert.deepEqual(harmony.key?.chromatic, []);
  // Four bass notes plus four three-voice pad chords.
  assert.equal(harmony.key?.notes, 4 + 4 * 3);
  assert.deepEqual(harmony.sections, [
    { section: 'loop', bars: 4, changes: 3, bass: ['A', 'F', 'C', 'G'], truncated: false },
  ]);
});

test('an arpeggio inside one bar is one root, not one per note', () => {
  const score = parseScore({
    bpm: 120,
    bars: 2,
    tracks: [{ name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'A3:4 C4:4 E4:4 C4:4' }],
  });
  const harmony = analyseScore(score).harmony;
  assert.ok(harmony !== undefined);
  assert.equal(harmony.changes, 0);
  assert.deepEqual(harmony.sections[0]?.bass, ['A']);
  // Without a declared key there is no diatonic share to state.
  assert.equal(harmony.key, undefined);
  assert.equal(analyseScore(score).tracks[0]?.outside, undefined);
});

test('a declared key measures the notes that disagree with it', () => {
  const score = parseScore({
    key: 'C',
    bpm: 120,
    bars: 1,
    tracks: [{ name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'C4:4 E4:4 F#4:4 A#4:4' }],
  });
  const structure = analyseScore(score);
  assert.equal(structure.harmony?.key?.label, 'C');
  assert.equal(structure.harmony?.key?.inKey, 0.5);
  assert.deepEqual(structure.harmony?.key?.chromatic, ['F#', 'A#']);
  assert.equal(structure.tracks[0]?.outside, 0.5);
});

test('key-mismatch names the disagreement instead of calling chromaticism wrong', () => {
  const score = parseScore({
    key: 'Am',
    bpm: 120,
    bars: 8,
    tracks: [
      { name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'D#2:4 F#2:4 C#3:4 A2:4' },
      { name: 'lead', role: 'lead', waveform: 'pulse', pattern: 'D#4:4 F#4:4 C#5:4 A4:4' },
    ],
  });
  const finding = findingsOf(score).find((entry) => entry.kind === 'key-mismatch');
  assert.ok(finding !== undefined, 'a key that the notes contradict is worth naming');
  assert.match(finding.message, /^75% of 64 melodic notes are outside Am/);
  assert.match(finding.message, /C# D# F#/);
  assert.ok(finding.next !== undefined);
});

test('harmony-static names a section that never leaves one root', () => {
  const score = parseScore({
    mode: 'song',
    bpm: 120,
    tracks: [{ name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'A2:16' }],
    arrangement: [
      { name: 'intro', bars: 8 },
      { name: 'drop', bars: 4 },
    ],
  });
  const finding = findingsOf(score).find((entry) => entry.kind === 'harmony-static');
  assert.ok(finding !== undefined);
  assert.match(finding.message, /intro keeps the bass on A for 8 bars/);
  // Four bars is too short to call a pedal: only the eight-bar intro fires.
  assert.equal(findingsOf(score).filter((entry) => entry.kind === 'harmony-static').length, 1);
});

test('the harmony line carries the key, the rate, and the root order', () => {
  const score = parseScore({
    key: 'Am',
    bpm: 120,
    bars: 4,
    tracks: [{ name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'A2:16 F2:16 C3:16 G2:16' }],
  });
  const text = formatReport(
    analyseAudio(SILENCE, SILENCE, 44100, { structure: analyseScore(score) }),
  );
  assert.match(
    text,
    /report harmony key Am 100% in key · 0\.75 bass changes\/bar · fifths 67% · steps 0% · bass loop A F C G/,
  );

  const keyless = parseScore({
    bpm: 120,
    bars: 2,
    tracks: [{ name: 'bass', role: 'bass', waveform: 'triangle', pattern: 'A2:16 C3:16' }],
  });
  const keylessText = formatReport(
    analyseAudio(SILENCE, SILENCE, 44100, { structure: analyseScore(keyless) }),
  );
  assert.match(keylessText, /report harmony 0\.50 bass changes\/bar/);
  assert.doesNotMatch(keylessText, /in key/);
});

test('the key example reads its mode, its bass arc, and its one accidental', async () => {
  const raw = await readFile(new URL('../examples/m17-key-harmony.json', import.meta.url), 'utf8');
  const structure = analyseScore(parseScore(raw));
  const harmony = structure.harmony;
  assert.ok(harmony !== undefined);

  assert.equal(harmony.key?.label, 'Am');
  assert.equal(harmony.key?.mode, 'minor');
  assert.deepEqual(harmony.key?.chromatic, ['G#']);
  assert.ok(Math.abs((harmony.key?.inKey ?? 0) - 63 / 64) < 1e-9, `inKey ${harmony.key?.inKey}`);

  // i VI III VII i VI iv V: the bass moves once per bar.
  assert.deepEqual(harmony.sections[0]?.bass, ['A', 'F', 'C', 'G', 'A', 'F', 'D', 'E']);
  assert.equal(harmony.changes, 7);
  assert.equal(harmony.soundingBars, 8);
  // Seven moves, all by fourths, fifths, or a third: only the fifth/step
  // shares are reported, so a third is neither.
  assert.ok(harmony.largest <= 5);

  // The same score without `key` keeps the bass reading and drops the ratio.
  const keyless = JSON.parse(raw) as Record<string, unknown>;
  delete keyless.key;
  const bare = analyseScore(parseScore(keyless)).harmony;
  assert.deepEqual(bare?.sections, harmony.sections);
  assert.equal(bare?.key, undefined);
});
