import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePcmWav } from '../src/pipeline/wav-merge.js';
import { planBatches, transcribeAll, shouldBatch } from '../src/pipeline/transcribe.js';

const FORMAT = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };
const BYTES_PER_MS = 32;

// cfg pointing at a whisper that doesn't exist — every call fails, which is
// exactly what's wanted for testing the surrounding logic without the model.
const BROKEN_WHISPER = {
  whisperBin: '/nonexistent/whisper',
  whisperModelPath: '/nonexistent/model',
  whisperThreads: 1,
};

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-batch-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function clip(dir, name, durationMs) {
  const p = join(dir, name);
  await writeFile(p, writePcmWav(FORMAT, Buffer.alloc(Math.round(durationMs * BYTES_PER_MS), 0x11)));
  return p;
}

// THE regression test. Merging clips from different people is what made
// whisper smear text across speakers on real session audio — the transcript
// stopped being a record of who said what. A batch must never contain two.
test('a batch never contains more than one speaker', async () => {
  await withTempDir(async (dir) => {
    const utterances = [];
    for (let i = 0; i < 8; i++) {
      const userId = i % 2 === 0 ? 'alice' : 'bob'; // interleaved, as real conversation is
      utterances.push({
        userId,
        displayName: userId,
        wavPath: await clip(dir, `${userId}-${i}.wav`, 1000),
        startMs: i * 2000,
        endMs: i * 2000 + 1000,
      });
    }

    const batches = await planBatches(utterances);
    assert.ok(batches.length > 0);
    for (const batch of batches) {
      const speakers = new Set(batch.map((u) => u.userId));
      assert.equal(speakers.size, 1, `batch mixed speakers: ${[...speakers].join(', ')}`);
    }
    assert.equal(
      batches.flat().length,
      utterances.length,
      'every utterance is scheduled exactly once — none dropped, none duplicated'
    );
  });
});

test('clips are batched up to roughly one encode window, not unboundedly', async () => {
  await withTempDir(async (dir) => {
    // 10 x 5s from one speaker = 50s of audio; a 27s target must split it.
    const utterances = [];
    for (let i = 0; i < 10; i++) {
      utterances.push({
        userId: 'alice',
        displayName: 'alice',
        wavPath: await clip(dir, `a${i}.wav`, 5000),
        startMs: i * 6000,
        endMs: i * 6000 + 5000,
      });
    }

    const batches = await planBatches(utterances);
    assert.ok(batches.length >= 2, '50s of audio cannot be one batch');
    for (const batch of batches) {
      const totalMs = batch.length * 5000 + (batch.length - 1) * 700;
      assert.ok(totalMs <= 30_000, `batch is ${totalMs}ms — would spill into a second encode window`);
    }
  });
});

test('short clips from one speaker are actually merged, not left one-per-batch', async () => {
  await withTempDir(async (dir) => {
    // 10 x 1s — the shape that made a real session take hours one-at-a-time.
    const utterances = [];
    for (let i = 0; i < 10; i++) {
      utterances.push({
        userId: 'alice',
        displayName: 'alice',
        wavPath: await clip(dir, `a${i}.wav`, 1000),
        startMs: i * 2000,
        endMs: i * 2000 + 1000,
      });
    }

    const batches = await planBatches(utterances);
    assert.equal(batches.length, 1, 'ten one-second clips fit in a single window and should merge');
  });
});

test('a clip longer than a whole window is transcribed on its own', async () => {
  await withTempDir(async (dir) => {
    const utterances = [
      { userId: 'a', displayName: 'a', wavPath: await clip(dir, 'short.wav', 1000), startMs: 0, endMs: 1000 },
      { userId: 'a', displayName: 'a', wavPath: await clip(dir, 'long.wav', 40_000), startMs: 2000, endMs: 42_000 },
      { userId: 'a', displayName: 'a', wavPath: await clip(dir, 'short2.wav', 1000), startMs: 43_000, endMs: 44_000 },
    ];

    const batches = await planBatches(utterances);
    const longBatch = batches.find((b) => b.some((u) => u.wavPath.endsWith('long.wav')));
    assert.equal(longBatch.length, 1, 'an oversized clip must not drag others into a spilled window');
  });
});

test('an unreadable clip is still scheduled rather than silently dropped', async () => {
  await withTempDir(async (dir) => {
    const utterances = [
      { userId: 'a', displayName: 'a', wavPath: join(dir, 'missing.wav'), startMs: 0, endMs: 1000 },
      { userId: 'a', displayName: 'a', wavPath: await clip(dir, 'real.wav', 1000), startMs: 2000, endMs: 3000 },
    ];

    const batches = await planBatches(utterances);
    assert.equal(batches.flat().length, 2, 'a file we cannot stat is still handed to whisper to report on');
  });
});

test('no utterances yields no batches and no work', async () => {
  assert.deepEqual(await planBatches([]), []);
  const result = await transcribeAll([], BROKEN_WHISPER);
  assert.deepEqual(result.utterances, []);
  assert.deepEqual(result.failures, []);
});

test('results read chronologically even though batching walks one speaker at a time', async () => {
  await withTempDir(async (dir) => {
    const utterances = [
      { userId: 'alice', displayName: 'alice', wavPath: await clip(dir, 'a1.wav', 500), startMs: 0, endMs: 500 },
      { userId: 'bob', displayName: 'bob', wavPath: await clip(dir, 'b1.wav', 500), startMs: 1000, endMs: 1500 },
      { userId: 'alice', displayName: 'alice', wavPath: await clip(dir, 'a2.wav', 500), startMs: 2000, endMs: 2500 },
    ];

    // planBatches groups by speaker, so alice's two clips are adjacent; the
    // final transcript still has to run in wall-clock order.
    const batches = await planBatches(utterances);
    const flatOrder = batches.flat().map((u) => u.startMs);
    assert.notDeepEqual(flatOrder, [0, 1000, 2000], 'precondition: batching does reorder');

    const { utterances: out } = await transcribeAll(utterances, BROKEN_WHISPER);
    const offsets = out.map((u) => u.startMs);
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets, 'transcript must read in time order');
  });
});

test('whisper failing reports the failure instead of throwing away the run', async () => {
  await withTempDir(async (dir) => {
    const utterances = [
      { userId: 'a', displayName: 'a', wavPath: await clip(dir, 'a1.wav', 500), startMs: 0, endMs: 500 },
    ];

    const result = await transcribeAll(utterances, BROKEN_WHISPER);
    assert.equal(result.utterances.length, 0);
    assert.equal(result.failures.length, 1, 'the failure surfaces rather than being swallowed');
  });
});

test('progress counts utterances (what a user understands), not batches', async () => {
  await withTempDir(async (dir) => {
    const utterances = [];
    for (let i = 0; i < 5; i++) {
      utterances.push({
        userId: 'alice',
        displayName: 'alice',
        wavPath: await clip(dir, `a${i}.wav`, 500),
        startMs: i * 1000,
        endMs: i * 1000 + 500,
      });
    }

    const seen = [];
    await transcribeAll(utterances, BROKEN_WHISPER, { onProgress: (done, total) => seen.push([done, total]) });

    assert.ok(seen.length > 0, 'progress fires at least once');
    const [lastDone, lastTotal] = seen[seen.length - 1];
    assert.equal(lastTotal, 5);
    assert.equal(lastDone, 5, 'progress reaches the total');
  });
});

test('TRANSCRIBE_BATCHING=false transcribes every clip on its own', async () => {
  await withTempDir(async (dir) => {
    const utterances = [];
    for (let i = 0; i < 4; i++) {
      utterances.push({
        userId: 'alice',
        displayName: 'alice',
        wavPath: await clip(dir, `a${i}.wav`, 500),
        startMs: i * 1000,
        endMs: i * 1000 + 500,
      });
    }

    // With batching on these four short clips merge into one batch; off, each
    // must be handled alone so line breaks and timestamps stay exact.
    assert.equal((await planBatches(utterances)).length, 1, 'precondition: they would otherwise merge');

    const result = await transcribeAll(utterances, { ...BROKEN_WHISPER, transcribeBatching: false });
    assert.equal(result.failures.length, 4, 'each clip was attempted individually');
  });
});

// --- where batching is worth its accuracy cost ---
//
// Batching buys ~5x speed for ragged line breaks. On the GPU a session is
// already over in minutes, so paying that is pure loss; on the Pi's CPU it is
// the difference between "ready in the morning" and "ready next week".

const AUTO = { transcribeBatching: 'auto' };

test('auto stays clean when the GPU server is there to do the work', () => {
  assert.equal(
    shouldBatch({ ...AUTO, whisperServerUrl: 'http://pc:8089' }, { serverReachable: true }),
    false,
    'a ~0.17s/clip backend has no speed problem worth degrading the transcript for'
  );
});

test('auto batches when there is no server, so it is the Pi doing it', () => {
  assert.equal(shouldBatch({ ...AUTO, whisperServerUrl: null }), true);
});

// The case that would otherwise quietly hurt most: the PC is configured but
// switched off, so every clip falls back to the CPU one at a time.
test('auto batches when the configured server is unreachable', () => {
  assert.equal(
    shouldBatch({ ...AUTO, whisperServerUrl: 'http://pc:8089' }, { serverReachable: false }),
    true,
    'a configured-but-off PC means CPU transcription, which needs the 5x'
  );
});

test('an explicit setting overrides auto in both directions', () => {
  const withServer = { whisperServerUrl: 'http://pc:8089' };
  assert.equal(shouldBatch({ ...withServer, transcribeBatching: true }, { serverReachable: true }), true);
  assert.equal(shouldBatch({ ...withServer, transcribeBatching: false }, { serverReachable: false }), false);
});

// Proves transcribeAll actually routes on the decision rather than ignoring
// it. Kept entirely on the local path (no whisperServerUrl) so the test never
// touches the network — the server-vs-CPU choice itself is covered above.
test('transcribeAll routes through the batching decision', async () => {
  await withTempDir(async (dir) => {
    const utterances = [];
    for (let i = 0; i < 4; i++) {
      utterances.push({
        userId: 'alice',
        displayName: 'alice',
        wavPath: await clip(dir, `auto${i}.wav`, 500),
        startMs: i * 1000,
        endMs: i * 1000 + 500,
      });
    }

    // auto with no server means the Pi is doing it, so these four merge into
    // one batch; progress therefore arrives in a single step of 4.
    const batchedSteps = [];
    await transcribeAll(
      utterances,
      { ...BROKEN_WHISPER, transcribeBatching: 'auto', whisperServerUrl: null },
      { onProgress: (done) => batchedSteps.push(done) }
    );
    assert.deepEqual(batchedSteps, [4], 'one merged batch reports once');

    // Forced off, each clip is its own unit of work.
    const cleanSteps = [];
    await transcribeAll(
      utterances,
      { ...BROKEN_WHISPER, transcribeBatching: false },
      { onProgress: (done) => cleanSteps.push(done) }
    );
    assert.deepEqual(cleanSteps, [1, 2, 3, 4], 'unbatched reports per clip');
  });
});
