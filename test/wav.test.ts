import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDitherState,
  decodeWav,
  encodeWav,
  encodeWavFrames,
  encodeWavHeader,
} from '../src/features/render/feature.ts';

const RATE = 44100;

function codes(wav: Uint8Array): number[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const out: number[] = [];
  for (let offset = 44; offset + 1 < wav.length; offset += 2) out.push(view.getInt16(offset, true));
  return out;
}

test('digital silence is quantised to LSB noise instead of all zeros', () => {
  const silence = new Float32Array(4096);
  const values = codes(encodeWav(silence, silence, RATE));
  const seen = new Set(values);

  assert.deepEqual([...seen].sort((a, b) => a - b), [-1, 0, 1]);
  assert.ok(values.filter((value) => value !== 0).length > 0, 'no dither applied');
});

test('a constant level spans two codes, so the error is noise and not a fixed offset', () => {
  const flat = new Float32Array(4096).fill(0.5);
  const values = codes(encodeWav(flat, flat, RATE));

  // 0.5 * 32767 = 16383.5, plus 2 LSB peak-to-peak triangular noise.
  assert.deepEqual([...new Set(values)].sort((a, b) => a - b), [16383, 16384]);

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(Math.abs(mean - 16383.5) < 0.5, `mean ${mean} drifted from the input level`);
});

test('encoding is deterministic, so two renders of a score stay byte-identical', () => {
  const left = new Float32Array(2048).map((_, i) => Math.sin(i / 17) * 0.4);
  const right = new Float32Array(2048).map((_, i) => Math.cos(i / 23) * 0.3);
  const first = encodeWav(left, right, RATE);
  const second = encodeWav(left, right, RATE);
  assert.ok(Buffer.from(first).equals(Buffer.from(second)));
});

test('chunked streaming with a shared dither state matches a one-shot encode', () => {
  const frames = 5000;
  const left = new Float32Array(frames).map((_, i) => Math.sin(i / 9) * 0.7);
  const right = new Float32Array(frames).map((_, i) => Math.sin(i / 13) * 0.7);

  const oneShot = encodeWav(left, right, RATE);

  const header = encodeWavHeader(frames, RATE);
  const dither = createDitherState();
  const chunks: Uint8Array[] = [header];
  for (let start = 0; start < frames; start += 16384) {
    const count = Math.min(16384, frames - start);
    chunks.push(encodeWavFrames(left, right, start, count, dither));
  }
  const streamed = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  assert.ok(streamed.equals(Buffer.from(oneShot)), 'chunk boundaries changed the dither');
});

test('dither cannot push a limited render past its -1 dBFS ceiling reserve', () => {
  // PEAK_CEILING is 0.89; 0.89 * 32767 = 29162.63, plus at most 1 LSB.
  const hot = new Float32Array(4096).fill(0.89);
  const values = codes(encodeWav(hot, hot, RATE)).map(Math.abs);
  assert.equal(Math.max(...values), 29164);
  assert.equal(Math.min(...values), 29162);
});

test('the decoded floats stay within a couple of LSBs of the source', () => {
  const source = new Float32Array(1024).map((_, i) => Math.sin(i / 11) * 0.5);
  const decoded = decodeWav(encodeWav(source, source, RATE));
  let worst = 0;
  for (let i = 0; i < source.length; i += 1) {
    worst = Math.max(worst, Math.abs((decoded.left[i] ?? 0) - (source[i] ?? 0)));
  }
  // 2 LSB of dither plus the 1/32767 vs 1/32768 scale mismatch.
  assert.ok(worst < 3.5 / 32767, `worst error ${worst * 32767} LSB`);
});
