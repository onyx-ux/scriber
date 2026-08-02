import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTranscript } from '../src/pipeline/summarize-client.js';

// These exercise slicing, reducing and failure handling — not any provider's
// wire format — so the model call is injected rather than mocked over HTTP.
const cfg = { summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-3.1-flash-lite' };
const meta = { channelName: 'Cipher', date: '2026-07-31', attendees: ['Alice', 'Bob'] };

const GOOD = JSON.stringify({
  tldr: 'Something happened.',
  narrative: 'Something happened.',
  scenes: [{ title: 'A Scene', points: ['a point'] }],
  partyDecisions: ['decided'],
  unresolvedThreads: [],
  followUps: [{ assignee: 'Alice', task: 'do thing' }],
  npcsIntroduced: ['Bob the NPC'],
  locationsVisited: [],
  lootAndRewards: [],
  funnyMoments: ['someone fell over'],
});

// Long enough to actually exceed one request. Worth noting how much room a
// cloud context buys: a normal 3-hour session (~140k chars) now fits in a
// SINGLE pass, so slicing only engages for genuinely enormous transcripts.
// This one is deliberately ~5M chars so that path is exercised at all.
const longTranscript = Array.from(
  { length: 60_000 },
  (_, i) => `[${i}] Alice: this is line number ${i} of a very long session transcript indeed.`
).join('\n');

let calls = [];

// Records every request and replies with whatever `reply` returns.
function stub(reply) {
  calls = [];
  return async (system, user) => {
    calls.push({ system, user });
    return reply(calls.length);
  };
}

// Fails the first N calls the way a real outage does, then succeeds.
function stubWithFailures(failFirst, reply = () => GOOD) {
  calls = [];
  let n = 0;
  return async (system, user) => {
    calls.push({ system, user });
    n += 1;
    if (n <= failFirst) throw new Error('connect ECONNREFUSED');
    return reply(calls.length);
  };
}

const run = (transcript, callModel) => summarizeTranscript(transcript, meta, cfg, { callModel });

const kind = (c) =>
  c.system.startsWith('You are analyzing') ? 'SINGLE'
  : c.system.startsWith('You are extracting') ? 'MAP'
  : c.system.startsWith('You are assembling') ? 'REDUCE'
  : 'UNKNOWN';

test('a short transcript takes the single-pass path', async () => {
  const notes = await run('[00:01] Alice: hello there', stub(() => GOOD));
  assert.equal(calls.length, 1);
  assert.equal(kind(calls[0]), 'SINGLE');
  assert.equal(notes.tldr, 'Something happened.');
});

test('a long transcript is sliced and reduced, never sent in one oversized call', async () => {
  await run(longTranscript, stub(() => GOOD));

  const kinds = calls.map(kind);
  assert.ok(kinds.filter((k) => k === 'MAP').length > 1, 'expected several map calls');
  assert.ok(kinds.filter((k) => k === 'REDUCE').length >= 1, 'expected at least one reduce');
  assert.ok(!kinds.includes('SINGLE'), 'must not fall back to a single oversized request');
});

// Cutting mid-utterance would garble the text on both sides of the join.
test('slices are cut on utterance boundaries, never mid-line', async () => {
  await run(longTranscript, stub(() => GOOD));

  for (const c of calls.filter((x) => kind(x) === 'MAP')) {
    const slice = c.user.split('Transcript slice:\n')[1] ?? '';
    for (const line of slice.split('\n').filter(Boolean)) {
      assert.match(line, /^\[\d+\] Alice: /, 'a slice must not begin or end mid-utterance');
    }
  }
});

test('one bad slice degrades gracefully instead of losing the session', async () => {
  const notes = await run(longTranscript, stub((n) => (n === 2 ? 'not json at all' : GOOD)));
  assert.ok(notes.tldr.length > 0, 'the rest of the session still produces a summary');
});

test('every slice failing throws, so the queue retries rather than storing a blank summary', async () => {
  await assert.rejects(() => run(longTranscript, stub(() => 'not json at all')), /slices failed/);
});

// Guards a crash: a model returning null for an array used to overwrite the
// default and blow up on the first .map() in the Discord post / markdown.
test('malformed model output is coerced, not fatal', async () => {
  const notes = await run(
    '[00:01] Alice: hi',
    stub(() => JSON.stringify({ tldr: null, scenes: null, npcsIntroduced: 'not an array', followUps: [{ nope: 1 }] }))
  );

  assert.equal(typeof notes.tldr, 'string');
  assert.ok(Array.isArray(notes.scenes));
  assert.ok(Array.isArray(notes.npcsIntroduced));
  assert.deepEqual(notes.followUps, [], 'a follow-up with no task is dropped');
  assert.doesNotThrow(() => notes.scenes.map((s) => s.title));
});

test('placeholder follow-ups with an empty task are dropped', async () => {
  const notes = await run(
    '[00:01] Alice: hi',
    stub(() => JSON.stringify({ tldr: 't', followUps: [{ assignee: null, task: '' }, { assignee: 'A', task: 'real' }] }))
  );
  assert.equal(notes.followUps.length, 1);
  assert.equal(notes.followUps[0].task, 'real');
});

test('JSON wrapped in markdown fences is still parsed', async () => {
  const notes = await run('[00:01] Alice: hi', stub(() => '```json\n' + GOOD + '\n```'));
  assert.equal(notes.tldr, 'Something happened.');
});

// --- losing most of a session must not read as "nothing happened" ---
//
// A real 3-hour session was posted as "casual chat / bot testing, not
// gameplay" because six of its seven slices had failed and the reduce step
// faithfully summarised the resulting emptiness. The transcript was intact the
// whole time; only the summariser calls had failed.

test('losing most of the slices fails the job instead of summarising the gap', async () => {
  // Each slice is attempted twice (one retry), so 12 failures = 6 lost slices.
  await assert.rejects(
    () => run(longTranscript, stubWithFailures(12)),
    /slices failed to summarise/,
    'a summary built from a minority of the session is a fabrication, not a summary'
  );
});

test('a job that fails this way stays retryable rather than storing a wrong answer', async () => {
  const err = await run(longTranscript, stubWithFailures(12)).catch((e) => e);
  assert.ok(err instanceof Error, 'it throws, so queue-worker retries it later');
  assert.match(err.message, /refusing/);
});

test('a small number of failed slices still summarises, but says so', async () => {
  // Two failures = one slice lost after its retry.
  const notes = await run(longTranscript, stubWithFailures(2));
  assert.match(notes.tldr, /Partial summary/, 'the reader must be able to tell it is incomplete');
  assert.match(notes.tldr, /1 of \d+/, 'and how much is missing');
});

test('a clean run carries no partial-summary warning', async () => {
  const notes = await run(longTranscript, stub(() => GOOD));
  assert.doesNotMatch(notes.tldr, /Partial summary/);
});

// Progress drives the Discord status line; without it the bot goes silent for
// what can be a long time.
test('progress is reported for each slice and for the reduce', async () => {
  const seen = [];
  await summarizeTranscript(longTranscript, meta, cfg, {
    callModel: stub(() => GOOD),
    onProgress: (e) => seen.push(e),
  });

  const slices = seen.filter((e) => e.phase === 'slices');
  assert.ok(slices.length > 1, 'each slice reports');
  assert.equal(slices.at(-1).done, slices.at(-1).total, 'the last report is complete');
  assert.ok(
    seen.some((e) => e.phase === 'reduce'),
    'the reduce stage is distinguishable from slicing'
  );
});

test('a broken progress reporter cannot fail the summary', async () => {
  const notes = await summarizeTranscript(longTranscript, meta, cfg, {
    callModel: stub(() => GOOD),
    onProgress: () => {
      throw new Error('reporter exploded');
    },
  });
  assert.ok(notes.tldr.length > 0);
});
