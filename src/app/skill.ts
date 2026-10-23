// The authoring guide ships as one Markdown resource at
// `.agents/skills/pico8-songwriter/SKILL.md`. Pi loads it through the package
// manifest's `pi.skills`; DSH's filesystem skill provider only scans the project,
// custom and user roots and never an installed package, so the plugin reads the
// same file and registers it as a runtime skill. One file, both hosts, no second
// copy of the text.

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the packaged skill file. Correct from `src/app` and `dist/app`. */
export const SKILL_FILE = fileURLToPath(
  new URL('../../.agents/skills/pico8-songwriter/SKILL.md', import.meta.url),
);

export interface SongwriterSkill {
  readonly name: string;
  readonly description: string;
  /** Instruction body, with the frontmatter removed. */
  readonly content: string;
  readonly path: string;
  /** Directory the body's relative references would resolve against. */
  readonly directory: string;
}

export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Read the top-level `key: value` lines of a YAML frontmatter block. Skill
 * frontmatter is flat by definition here, so a full YAML parser would be a new
 * dependency for nine lines of text.
 */
export function splitFrontmatter(source: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { fields: {}, body: source.trim() };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) fields[pair[1]] = value;
  }
  return { fields, body: source.slice(match[0].length).trim() };
}

/**
 * Load the packaged skill, or `undefined` when the file is missing or its
 * frontmatter does not name it. A packaging mistake should cost one warning, not
 * the plugin's tools.
 */
export function readSongwriterSkill(file = SKILL_FILE): SongwriterSkill | undefined {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  const { fields, body } = splitFrontmatter(source);
  const name = fields.name;
  const description = fields.description;
  if (!name || !description || !body) return undefined;

  return { name, description, content: body, path: file, directory: dirname(file) };
}
