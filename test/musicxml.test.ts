import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeExport } from '../src/app/render-service.ts';
import { musicXmlOf } from '../src/features/musicxml/feature.ts';
import { parseScore } from '../src/features/score/feature.ts';

test('writes a partwise MusicXML document with parts, key, time, and tempo', () => {
  const score = parseScore(
    JSON.stringify({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      key: 'Ebm',
      tracks: [
        { name: 'keys', pattern: '[C4,Eb4]:4 -:4 G4:8' },
        { name: 'drums', role: 'drums', pattern: 'K:2 H:2 S:2 H:2 K:2 H:2 S:2 H:2' },
      ],
    }),
  );
  const xml = musicXmlOf(score);

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<score-partwise version="4.0">/);
  assert.match(xml, /<part-list>/);
  assert.match(xml, /<score-part id="P1">/);
  assert.match(xml, /<score-part id="P2">/);
  assert.match(xml, /<divisions>4<\/divisions>/);
  // E-flat minor has six flats; the label's flat spelling wins over F# minor.
  assert.match(xml, /<key><fifths>-6<\/fifths><mode>minor<\/mode><\/key>/);
  assert.match(xml, /<time><beats>4<\/beats><beat-type>4<\/beat-type><\/time>/);
  assert.match(xml, /<sound tempo="120"\/>/);
  assert.match(xml, /<chord\/>/);
  assert.match(xml, /<rest\/>/);
  // The drum part is percussion, not pitched notes.
  assert.match(xml, /<clef><sign>percussion<\/sign><line>2<\/line><\/clef>/);
  assert.match(xml, /<unpitched><display-step>F<\/display-step><display-octave>4<\/display-octave><\/unpitched>/);
  assert.match(xml, /<notehead>x<\/notehead>/);
  assert.match(xml, /<midi-channel>10<\/midi-channel>/);
  assert.match(xml, /<midi-unpitched>36<\/midi-unpitched>/);
  // MusicXML puts every score-instrument before every midi-instrument inside
  // one score-part; interleaving the drum declarations would be schema-invalid.
  const drumPart = xml.slice(xml.indexOf('<score-part id="P2">'), xml.indexOf('</score-part>', xml.indexOf('<score-part id="P2">')));
  assert.ok(drumPart.lastIndexOf('</score-instrument>') < drumPart.indexOf('<midi-instrument'));
  assert.equal((xml.match(/<chord\/>/g) ?? []).length, 1);
});

test('ties notes across a bar line and keeps a staccato gate inside its slot', () => {
  const tied = musicXmlOf(
    parseScore(
      JSON.stringify({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 2,
        tracks: [{ name: 'lead', pattern: '-:14 C4:8' }],
      }),
    ),
  );
  assert.match(tied, /<note><pitch><step>C<\/step><octave>4<\/octave><\/pitch><duration>2<\/duration><tie type="start"\/>/);
  assert.match(tied, /<note><pitch><step>C<\/step><octave>4<\/octave><\/pitch><duration>6<\/duration><tie type="stop"\/>/);
  assert.match(tied, /<tied type="start"\/>/);
  assert.match(tied, /<tied type="stop"\/>/);

  const staccato = musicXmlOf(
    parseScore(
      JSON.stringify({
        bpm: 120,
        stepsPerBeat: 4,
        bars: 2,
        tracks: [{ name: 'lead', pattern: '-:14 C4:8g2' }],
      }),
    ),
  );
  assert.doesNotMatch(staccato, /tie type="start"/);
  assert.match(staccato, /<note><pitch><step>C<\/step><octave>4<\/octave><\/pitch><duration>2<\/duration>/);
  // The unused part of the slot becomes a rest in the next measure.
  assert.match(staccato, /<rest measure="yes"\/>/);
});

test('writes section rehearsal names and tempo changes, and keeps tuning as alter', () => {
  const score = parseScore(
    JSON.stringify({
      mode: 'song',
      bpm: 100,
      stepsPerBeat: 4,
      tuning: { a4: 442 },
      tracks: [{ name: 'bass', role: 'bass', pattern: 'A2:4' }],
      arrangement: [
        { name: 'intro', bars: 1, bpm: 90 },
        { name: 'drop', bars: 1, bpm: 140 },
      ],
    }),
  );
  const xml = musicXmlOf(score);
  assert.match(xml, /<rehearsal>intro<\/rehearsal>/);
  assert.match(xml, /<rehearsal>drop<\/rehearsal>/);
  assert.match(xml, /<sound tempo="90"\/>/);
  assert.match(xml, /<sound tempo="140"\/>/);
  assert.match(xml, /<clef><sign>F<\/sign><line>4<\/line><\/clef>/);
  // A4=442 is +7.85 cents, written as a fractional alter.
  assert.match(xml, /<step>A<\/step><alter>0.0785<\/alter><octave>2<\/octave>/);
});

test('escapes track names and writes an optional work title', () => {
  const score = parseScore(
    JSON.stringify({
      bpm: 120,
      stepsPerBeat: 4,
      bars: 1,
      tracks: [{ name: 'lead & "bass"', pattern: 'C4:16' }],
    }),
  );
  const xml = musicXmlOf(score, { title: 'A < B & C' });
  assert.match(xml, /<work-title>A &lt; B &amp; C<\/work-title>/);
  assert.match(xml, /<part-name>lead &amp; &quot;bass&quot;<\/part-name>/);
});

test('executeExport writes .musicxml and validates paths', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-tmp-p8-musicxml-'));
  const score = JSON.stringify({
    bpm: 120,
    stepsPerBeat: 4,
    bars: 1,
    tracks: [{ waveform: 'pulse', volume: 5, pattern: 'C4:4 E4:4 G4:8' }],
  });
  try {
    const summary = await executeExport({ score, out: 'lead' }, { cwd: directory });
    assert.match(summary, /Exported/);
    assert.match(summary, /MusicXML 4\.0 partwise \(uncompressed\)/);
    const written = await readFile(join(directory, 'lead.musicxml'), 'utf8');
    assert.match(written, /<score-partwise version="4.0">/);
    assert.match(written, /<step>G<\/step>/);

    await assert.rejects(
      () => executeExport({ score, out: 'lead.xml' }, { cwd: directory }),
      /out must end in \.musicxml/,
    );
    await assert.rejects(
      () => executeExport({ score, out: '../escape.musicxml' }, { cwd: directory }),
      /must stay inside the workspace/,
    );
    await assert.rejects(() => executeExport({}, { cwd: directory }), /provide score JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
