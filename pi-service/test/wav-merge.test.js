import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePcmWav, mergeWavs, assignSegmentsToRanges } from '../src/pipeline/wav-merge.js';

const FORMAT = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };
const BYTES_PER_MS = (FORMAT.sampleRate * FORMAT.channels * FORMAT.bitsPerSample) / 8 / 1000; // 32

// A tone rather than silence, so a merged file's data section is visibly not
// all-zero — makes it obvious a test failure means real data went missing,
// not just that a run of zeros looks the same as silence would.
function toneWav(durationMs, fillByte = 0x11) {
  const data = Buffer.alloc(Math.round(durationMs * BYTES_PER_MS), fillByte);
  return writePcmWav(FORMAT, data);
}

async function writeTemp(dir, name, buffer) {
  const p = join(dir, name);
  await writeFile(p, buffer);
  return p;
}

test('mergeWavs concatenates files in order with a silence gap between them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-wavmerge-'));
  try {
    const a = await writeTemp(dir, 'a.wav', toneWav(100, 0x11));
    const b = await writeTemp(dir, 'b.wav', toneWav(200, 0x22));

    const { buffer, ranges } = await mergeWavs([a, b], 50);

    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].startMs, 0);
    assert.equal(ranges[0].endMs, 100);
    // second range starts after the 50ms gap
    assert.equal(ranges[1].startMs, 150);
    assert.equal(ranges[1].endMs, 350);

    // Merged data section: 44-byte header, then a's 100ms, 50ms silence, b's 200ms.
    const dataStart = 44;
    const aBytes = Math.round(100 * BYTES_PER_MS);
    const gapBytes = Math.round(50 * BYTES_PER_MS);
    assert.equal(buffer.readUInt8(dataStart), 0x11, "a's tone byte survives at the start");
    assert.equal(buffer.readUInt8(dataStart + aBytes - 1), 0x11, "a's tone byte survives at its end");
    assert.equal(buffer.readUInt8(dataStart + aBytes), 0x00, 'the gap is silent');
    assert.equal(buffer.readUInt8(dataStart + aBytes + gapBytes), 0x22, "b's tone starts right after the gap");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeWavs rejects inputs with mismatched formats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-wavmerge-'));
  try {
    const a = await writeTemp(dir, 'a.wav', toneWav(100));
    const stereo = await writeTemp(dir, 'stereo.wav', writePcmWav({ ...FORMAT, channels: 2 }, Buffer.alloc(400)));

    await assert.rejects(() => mergeWavs([a, stereo]), /same format/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeWavs on an empty list produces an empty, valid result rather than throwing', async () => {
  const { buffer, ranges } = await mergeWavs([]);
  assert.deepEqual(ranges, []);
  assert.ok(buffer.length >= 44, 'still a well-formed (empty) WAV header');
});

test('mergeWavs on a single file needs no gap and still reports the right range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-wavmerge-'));
  try {
    const a = await writeTemp(dir, 'a.wav', toneWav(123));
    const { ranges } = await mergeWavs([a], 700);
    assert.deepEqual(ranges, [{ startMs: 0, endMs: 123 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assignSegmentsToRanges attributes a segment inside a range to that range', () => {
  const ranges = [
    { startMs: 0, endMs: 100 },
    { startMs: 150, endMs: 350 },
  ];
  const texts = assignSegmentsToRanges(
    [
      { fromMs: 10, toMs: 90, text: 'first' },
      { fromMs: 160, toMs: 300, text: 'second' },
    ],
    ranges
  );
  assert.deepEqual(texts, ['first', 'second']);
});

test('assignSegmentsToRanges joins multiple segments landing in the same range, in order', () => {
  const ranges = [{ startMs: 0, endMs: 500 }];
  const texts = assignSegmentsToRanges(
    [
      { fromMs: 0, toMs: 100, text: 'hello' },
      { fromMs: 100, toMs: 200, text: 'there' },
    ],
    ranges
  );
  assert.deepEqual(texts, ['hello there']);
});

test('assignSegmentsToRanges gives a range with no matching segments an empty string', () => {
  const ranges = [
    { startMs: 0, endMs: 100 },
    { startMs: 150, endMs: 350 },
  ];
  const texts = assignSegmentsToRanges([{ fromMs: 10, toMs: 90, text: 'only the first range spoke' }], ranges);
  assert.deepEqual(texts, ['only the first range spoke', '']);
});

test('assignSegmentsToRanges gives a segment stranded in a gap to whichever range is nearer', () => {
  const ranges = [
    { startMs: 0, endMs: 100 },
    { startMs: 200, endMs: 300 },
  ];
  // Midpoint 120 is 20ms past range 0's end and 80ms before range 1's start.
  const closerToFirst = assignSegmentsToRanges([{ fromMs: 110, toMs: 130, text: 'x' }], ranges);
  assert.deepEqual(closerToFirst, ['x', '']);

  // Midpoint 180 is 80ms past range 0's end and 20ms before range 1's start.
  const closerToSecond = assignSegmentsToRanges([{ fromMs: 170, toMs: 190, text: 'y' }], ranges);
  assert.deepEqual(closerToSecond, ['', 'y']);
});
