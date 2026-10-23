import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSongwriterSkill, SKILL_FILE, splitFrontmatter } from '../src/app/skill.ts';

/**
 * The skill is the one authoring document both hosts ship; these checks keep
 * the packaging (file present in `files`), the split from `p8_help`, and the
 * frontmatter reader honest.
 */
test('the packaged skill loads with a name, description and body', () => {
  const skill = readSongwriterSkill();
  assert.ok(skill, 'SKILL.md is present at the packaged path');
  assert.equal(skill.name, 'pico8-songwriter');
  assert.match(skill.description, /composing or editing a score/);
  assert.match(skill.content, /^# PICO-8 songwriting/);
  assert.equal(skill.path, SKILL_FILE);
  assert.match(skill.directory, /pico8-songwriter$/);
});

test('the skill owns authoring and defers the wire format to p8_help', () => {
  const skill = readSongwriterSkill();
  assert.ok(skill);
  // The hand-off is the whole point of the split: no field tables here.
  assert.match(skill.content, /`p8_help`/);
  assert.match(skill.content, /wire format/);
  // Composition guidance lives here, not in the reference.
  assert.match(skill.content, /## Workflow/);
  assert.match(skill.content, /## Arrangement/);
  assert.match(skill.content, /## Revise loop/);
  // A packaged skill cannot reach the repository layout.
  assert.doesNotMatch(skill.content, /\.\.\//);
});

test('frontmatter parsing keeps flat keys and drops the block from the body', () => {
  const { fields, body } = splitFrontmatter(
    ['---', 'name: one', "description: 'Quoted: with a colon'", 'metadata:', '  nested: 1', '---', '', '# Title', 'text'].join('\n'),
  );
  assert.equal(fields.name, 'one');
  assert.equal(fields.description, 'Quoted: with a colon');
  assert.equal(fields['  nested'], undefined);
  assert.equal(body, '# Title\ntext');
});

test('a file without frontmatter keeps its whole body and no fields', () => {
  const { fields, body } = splitFrontmatter('# Just a document\n');
  assert.deepEqual(fields, {});
  assert.equal(body, '# Just a document');
});

test('a missing skill file returns undefined instead of throwing', () => {
  assert.equal(readSongwriterSkill('/nonexistent/SKILL.md'), undefined);
});
