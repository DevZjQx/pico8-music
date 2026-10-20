import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBoundaries } from '../scripts/check-boundaries.ts';

test('src follows shared -> features -> app with one entry per feature', () => {
  const root = new URL('..', import.meta.url).pathname;
  assert.deepEqual(checkBoundaries(root), []);
});
