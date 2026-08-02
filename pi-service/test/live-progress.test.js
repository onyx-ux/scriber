import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startLiveProgress } from '../src/delivery/live-progress.js';
import { renderSummaryProgress } from '../src/pipeline/queue-worker.js';

// A channel that records what was sent, edited and deleted.
function stubChannel({ sendFails = false, editFails = false } = {}) {
  const log = { sent: [], edits: [], deleted: 0 };
  return {
    log,
    send: async ({ content }) => {
      if (sendFails) throw new Error('Missing Permissions');
      log.sent.push(content);
      return {
        edit: async ({ content: c }) => {
          if (editFails) throw new Error('Unknown Message');
          log.edits.push(c);
        },
        delete: async () => {
          log.deleted += 1;
        },
      };
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('a status message is posted immediately, not only once work finishes', async () => {
  const channel = stubChannel();
  const live = startLiveProgress({ channel, initial: 'starting…', render: () => 'starting…' });
  await live.finish();
  assert.deepEqual(channel.log.sent, ['starting…']);
});

test('the closing text replaces the status line', async () => {
  const channel = stubChannel();
  const live = startLiveProgress({ channel, initial: 'working', render: () => 'working' });
  await live.finish('done!');
  assert.equal(channel.log.edits.at(-1), 'done!');
});

test('remove deletes the line so it does not sit above the real result', async () => {
  const channel = stubChannel();
  const live = startLiveProgress({ channel, initial: 'working', render: () => 'working' });
  await live.remove();
  assert.equal(channel.log.deleted, 1);
});

test('it edits as the rendered text changes', async () => {
  const channel = stubChannel();
  let n = 0;
  const live = startLiveProgress({ channel, intervalMs: 10, initial: 'x0', render: () => `x${++n}` });
  await tick();
  await live.finish();
  assert.ok(channel.log.edits.length > 0, 'progress must actually update');
});

// Editing every tick regardless would burn Discord's rate limit for no gain.
test('unchanged text is not re-sent', async () => {
  const channel = stubChannel();
  const live = startLiveProgress({ channel, intervalMs: 10, initial: 'same', render: () => 'same' });
  await tick();
  await live.finish();
  assert.equal(channel.log.edits.length, 0, 'a static status line should cost no edits');
});

// THE property that matters: this is a status line wrapped around real work.
// Nothing it does may throw into the transcription or summary it describes.
test('a channel it cannot post to is survivable', async () => {
  const channel = stubChannel({ sendFails: true });
  const live = startLiveProgress({ channel, initial: 'x', render: () => 'y' });
  await assert.doesNotReject(() => live.finish('done'));
  await assert.doesNotReject(() => live.remove());
});

test('an edit failing mid-run is survivable', async () => {
  const channel = stubChannel({ editFails: true });
  const live = startLiveProgress({ channel, intervalMs: 10, initial: 'a', render: () => `b${Date.now()}` });
  await tick();
  await assert.doesNotReject(() => live.finish('done'));
});

test('a throwing renderer does not escape', async () => {
  const channel = stubChannel();
  const live = startLiveProgress({
    channel,
    intervalMs: 10,
    initial: 'a',
    render: () => {
      throw new Error('renderer exploded');
    },
  });
  await tick();
  await assert.doesNotReject(() => live.finish('done'));
});

// --- what the summary status line actually says ---

test('slice progress names the provider and the position', () => {
  const text = renderSummaryProgress({ phase: 'slices', done: 2, total: 7 }, 'Gemini (gemini-3.1-flash-lite)');
  assert.match(text, /Gemini/);
  assert.match(text, /3 of 7/, 'the section being worked on, not the count completed');
  assert.match(text, /28%/);
});

// Failures were previously invisible until the (wrong) summary appeared.
test('failed sections are surfaced while it is still running', () => {
  const text = renderSummaryProgress({ phase: 'slices', done: 4, total: 7, failed: 2 }, 'Ollama');
  assert.match(text, /2 section\(s\) failed/);
});

test('the reduce stage is distinguishable from slicing', () => {
  assert.match(renderSummaryProgress({ phase: 'reduce', done: 0, total: 1 }, 'Ollama'), /combining/);
  assert.match(renderSummaryProgress({ phase: 'reduce', done: 1, total: 1 }, 'Ollama'), /assembling/);
});

test('a single-pass summary still reports something', () => {
  assert.match(renderSummaryProgress({ phase: 'single', done: 0, total: 1 }, 'Gemini'), /Summarising with \*\*Gemini\*\*/);
});
