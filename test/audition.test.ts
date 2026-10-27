import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeRender } from '../src/app/render-service.ts';

const song = JSON.stringify({
  mode: 'song',
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  patterns: {
    drums: 'K:1 -:1 S:1 -:1',
    bass: 'C2:4 E2:4 G2:4 A2:4',
    lead: 'C5:4 E5:4 G5:8',
  },
  tracks: [
    { name: 'drums', role: 'drums', pattern: 'drums' },
    { name: 'bass', role: 'bass', pattern: 'bass' },
    { name: 'lead', role: 'lead', pattern: 'lead' },
  ],
  arrangement: [
    { name: 'intro', bars: 1, mute: ['drums'], patterns: { lead: 'lead' } },
    { name: 'drop', bars: 1, patterns: { drums: 'drums', bass: 'bass', lead: 'lead' } },
    { name: 'break', bars: 1, mute: ['bass'], patterns: { lead: 'lead' } },
  ],
});

async function withWorkspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'p8-audition-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('solo keeps only the named track and marks the report as an audition', async () => {
  await withWorkspace(async (cwd) => {
    const summary = await executeRender(
      { score: song, post: [], solo: ['lead'], out: 'solo.wav' },
      { cwd },
    );
    assert.match(summary, /solo lead · 1\/3 tracks audible/);
    assert.match(summary, /report stems lead/);
    assert.doesNotMatch(summary, /report stems .*bass/);
    assert.match(summary, /report structure lead/);
    assert.doesNotMatch(summary, /report structure .*bass/);
    assert.match(summary, /warnings:.*solo: lead/);
  });
});

test('mute silences matching names or roles, and mute wins over solo', async () => {
  await withWorkspace(async (cwd) => {
    const muted = await executeRender(
      { score: song, post: [], mute: ['drums'], out: 'muted.wav' },
      { cwd },
    );
    assert.match(muted, /mute drums · 2\/3 tracks audible/);
    assert.doesNotMatch(muted, /report stems drums/);

    const overlap = await executeRender(
      { score: song, post: [], solo: ['lead', 'bass'], mute: ['lead'], out: 'overlap.wav' },
      { cwd },
    );
    assert.match(overlap, /solo lead, bass · 1\/3 tracks audible/);
    assert.match(overlap, /report stems bass/);
    assert.doesNotMatch(overlap, /report stems lead/);
  });
});

test('solo/mute reject unknown names and a silent result', async () => {
  await withWorkspace(async (cwd) => {
    await assert.rejects(
      () => executeRender({ score: song, solo: ['nope'], out: 'x.wav' }, { cwd }),
      /unknown track or role "nope"/,
    );
    await assert.rejects(
      () =>
        executeRender(
          { score: song, mute: ['drums', 'bass', 'lead'], out: 'x.wav' },
          { cwd },
        ),
      /no audible tracks/,
    );
  });
});

test('sections render a rebased excerpt and write its provenance to the raw artifact', async () => {
  await withWorkspace(async (cwd) => {
    const summary = await executeRender(
      { score: song, post: [], sections: ['drop', 'break'], out: 'excerpt.wav', detail: 'raw' },
      { cwd },
    );
    assert.match(summary, /excerpt drop\+break · bars 2-3/);
    assert.match(summary, /report sections drop .*break/);

    const artifact = JSON.parse(await readFile(join(cwd, 'excerpt.analysis.json'), 'utf8'));
    assert.equal(artifact.excerpt.label, 'drop+break');
    assert.equal(artifact.excerpt.startStep, 16);
    assert.equal(artifact.excerpt.endStep, 48);
    assert.equal(artifact.analysis.seconds, 4);
    assert.deepEqual(
      artifact.analysis.stems.map((stem: { name: string }) => stem.name),
      ['drums', 'bass', 'lead'],
    );
    for (const stem of artifact.analysis.stems) {
      assert.deepEqual(
        stem.sections.map((section: { name: string }) => section.name),
        ['drop', 'break'],
      );
      assert.ok(stem.sections.every((section: { rmsDb: number }) => Number.isFinite(section.rmsDb)));
    }
  });
});

test('sections reject loops, unknown names, duplicates, and non-contiguous picks', async () => {
  await withWorkspace(async (cwd) => {
    const loop = JSON.stringify({ bars: 1, tracks: [{ pattern: 'C4:4' }] });
    await assert.rejects(
      () => executeRender({ score: loop, sections: ['drop'], out: 'x.wav' }, { cwd }),
      /sections selection needs song mode/,
    );
    await assert.rejects(
      () => executeRender({ score: song, sections: ['nope'], out: 'x.wav' }, { cwd }),
      /unknown section "nope"/,
    );
    await assert.rejects(
      () => executeRender({ score: song, sections: ['drop', 'drop'], out: 'x.wav' }, { cwd }),
      /duplicate name/,
    );
    await assert.rejects(
      () => executeRender({ score: song, sections: ['intro', 'break'], out: 'x.wav' }, { cwd }),
      /contiguous/,
    );
  });
});
