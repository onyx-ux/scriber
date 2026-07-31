import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePcmWav } from '../src/pipeline/wav-merge.js';
import { buildSessionRecording } from '../src/pipeline/session-recording.js';

const FORMAT = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };
const BYTES_PER_MS = (FORMAT.sampleRate * FORMAT.channels * FORMAT.bitsPerSample) / 8 / 1000; // 32

function toneWav(durationMs, fillByte) {
  return writePcmWav(FORMAT, Buffer.alloc(Math.round(durationMs * BYTES_PER_MS), fillByte));
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-sessrec-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('utterances land at their real start time, not concatenated back to back', async () => {
  await withTempDir(async (dir) => {
    const aPath = join(dir, 'a.wav');
    const bPath = join(dir, 'b.wav');
    await writeFile(aPath, toneWav(50, 0x11));
    await writeFile(bPath, toneWav(50, 0x22));

    const outPath = join(dir, 'out.wav');
    // b starts 500ms in, far later than a (which is only 50ms long) — a
    // naive concatenation would butt them together at byte 1600.
    await buildSessionRecording(
      [
        { wavPath: aPath, startMs: 0, endMs: 50 },
        { wavPath: bPath, startMs: 500, endMs: 550 },
      ],
      outPath
    );

    const out = await readFile(outPath);
    const dataStart = 44;
    assert.equal(out.readUInt8(dataStart), 0x11, "a's tone is at byte 0");
    assert.equal(out.readUInt8(dataStart + Math.round(500 * BYTES_PER_MS)), 0x22, "b's tone is at the 500ms mark, not right after a");
    // Well into the gap between them, it must be silence.
    assert.equal(out.readUInt8(dataStart + Math.round(200 * BYTES_PER_MS)), 0x00, 'the gap between utterances is silent');
  });
});

test('the file is sized for the full session, not just the last utterance', async () => {
  await withTempDir(async (dir) => {
    const aPath = join(dir, 'a.wav');
    await writeFile(aPath, toneWav(10, 0x11));

    const outPath = join(dir, 'out.wav');
    await buildSessionRecording([{ wavPath: aPath, startMs: 0, endMs: 3000 }], outPath);

    const out = await readFile(outPath);
    const expectedBytes = 44 + Math.floor(3000 / 1000 * FORMAT.sampleRate) * 2;
    assert.equal(out.length, expectedBytes, 'file spans the utterance\'s full endMs, not just its 10ms of real audio');
  });
});

test('an empty utterance list produces no file rather than an empty session', async () => {
  await withTempDir(async (dir) => {
    const outPath = join(dir, 'out.wav');
    const result = await buildSessionRecording([], outPath);
    assert.equal(result, null);
    await assert.rejects(() => readFile(outPath));
  });
});

test('overlapping utterances: the later write wins for that overlap, rather than the build failing', async () => {
  await withTempDir(async (dir) => {
    const aPath = join(dir, 'a.wav');
    const bPath = join(dir, 'b.wav');
    await writeFile(aPath, toneWav(100, 0x11));
    await writeFile(bPath, toneWav(100, 0x22));

    const outPath = join(dir, 'out.wav');
    // Both start at 0 and fully overlap — b is listed second, so it should win.
    await buildSessionRecording(
      [
        { wavPath: aPath, startMs: 0, endMs: 100 },
        { wavPath: bPath, startMs: 0, endMs: 100 },
      ],
      outPath
    );

    const out = await readFile(outPath);
    assert.equal(out.readUInt8(44), 0x22, 'the second (later-written) utterance overwrites the first in the overlap');
  });
});

test('a clip with the wrong format is skipped, not fatal to the whole build', async () => {
  await withTempDir(async (dir) => {
    const goodPath = join(dir, 'good.wav');
    const badPath = join(dir, 'bad.wav');
    await writeFile(goodPath, toneWav(50, 0x11));
    await writeFile(badPath, writePcmWav({ ...FORMAT, channels: 2 }, Buffer.alloc(200)));

    const outPath = join(dir, 'out.wav');
    const result = await buildSessionRecording(
      [
        { wavPath: goodPath, startMs: 0, endMs: 50 },
        { wavPath: badPath, startMs: 100, endMs: 200 },
      ],
      outPath
    );

    assert.equal(result, outPath);
    const out = await readFile(outPath);
    assert.equal(out.readUInt8(44), 0x11, "the good clip's audio still made it in");
  });
});
