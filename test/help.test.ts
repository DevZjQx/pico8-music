import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCORE_HELP } from '../src/features/score/feature.ts';

/**
 * Fact-level guard for the model-facing reference. The host adapters only
 * assert that p8_help returns a string; these checks keep the fields that
 * otherwise fail a render (or silently change it) inside the text.
 */
test('the help covers fields that fail or change a render', () => {
  // Track-level envelope, as opposed to the named envelopes table.
  assert.match(SCORE_HELP, /inline ADSR/);
  // mode and arrangement constraints.
  assert.match(SCORE_HELP, /song requires an arrangement/);
  assert.match(SCORE_HELP, /arrangement requires song/);
  // Note range enforced by the parser.
  assert.match(SCORE_HELP, /C1-C8/);
  // The complete named-chord vocabulary, not just examples.
  assert.match(SCORE_HELP, /m7b5/);
  assert.match(SCORE_HELP, /7sus4/);
  // Motif transform bounds and the drum/chord restriction.
  assert.match(SCORE_HELP, /transpose\(n\): -24\.\.24/);
  assert.match(SCORE_HELP, /augment\(n\) \/ diminish\(n\): 2-8/);
  // Drum names and track-type rules.
  assert.match(SCORE_HELP, /open hat/);
  assert.match(SCORE_HELP, /invalid on melodic tracks/);
  // Per-token suffix cardinality.
  assert.match(SCORE_HELP, /At most one @volume/);
  // Render budgets that otherwise fail late.
  assert.match(SCORE_HELP, /15 minutes/);
  assert.match(SCORE_HELP, /32 MB/);
  assert.match(SCORE_HELP, /1-256/);
  // The top-level pattern table and the output default.
  assert.match(SCORE_HELP, /top-level name -> token string/);
  // Reusable performance shapes and sound presets.
  assert.match(SCORE_HELP, /gateScale 0\.05-8/);
  assert.match(SCORE_HELP, /top-level presets table/);
  // Named subgroups and the stereo send contract.
  assert.match(SCORE_HELP, /Groups and stereo sends/);
  assert.match(SCORE_HELP, /sends are stereo/);
  assert.match(SCORE_HELP, /group and bus are synonyms/);
  assert.match(SCORE_HELP, /pico8-music\.wav/);
  assert.match(SCORE_HELP, /named suffix/);
  // The second output format is uncompressed MusicXML, not a zipped container.
  assert.match(SCORE_HELP, /p8_export/);
  assert.match(SCORE_HELP, /uncompressed MusicXML/);
  assert.match(SCORE_HELP, /never the zipped \.mxl/);
});

test('the help keeps both worked examples', () => {
  assert.match(SCORE_HELP, /Loop mode:/);
  assert.match(SCORE_HELP, /Song mode adds patterns and an arrangement/);
});

test('the help stays navigable and free of oversized paragraphs', () => {
  assert.match(SCORE_HELP, /## Contents/);
  const lines = SCORE_HELP.split('\n');
  assert.ok(lines.length > 120, 'the reference is a long document and needs sections');
  const oversized = lines.filter((line) => line.length > 400);
  assert.deepEqual(oversized, [], 'no paragraph should need scrolling in a terminal');
  const tables = lines.filter((line) => line.startsWith('|'));
  assert.ok(tables.length > 60, 'parallel fields are presented as tables');
});

test('the reference defers authoring to the skill and stays format-only', () => {
  // One hand-off, one owner per question; the two documents never restate
  // each other's body.
  assert.match(SCORE_HELP, /pico8-songwriter skill/);
  assert.match(SCORE_HELP, /wire format/);
  const body = SCORE_HELP.split('\n').slice(1).join('\n');
  assert.doesNotMatch(body, /## Workflow/);
  assert.doesNotMatch(body, /A chord lives inside one track/);
});
