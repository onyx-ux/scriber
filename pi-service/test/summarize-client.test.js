import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeViaOllama } from '../src/pipeline/summarize-client.js';

const cfg = { ollamaUrl: 'http://stub:11434', ollamaModel: 'test', ollamaNumCtx: 8192 };
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

const longTranscript = Array.from(
  { length: 4000 },
  (_, i) => `[${i}] Alice: this is line number ${i} of a very long session transcript indeed.`
).join('\n');

let calls;
let realFetch;

function stub(reply) {
  calls = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ system: body.messages[0].content, user: body.messages[1].content, numCtx: body.options?.num_ctx });
    return { ok: true, json: async () => ({ message: { content: reply(calls.length) }, prompt_eval_count: 1e9 }) };
  };
}

const kind = (c) =>
  c.system.startsWith('You are analyzing') ? 'SINGLE'
  : c.system.startsWith('You are extracting') ? 'MAP'
  : c.system.startsWith('You are assembling') ? 'REDUCE'
  : 'UNKNOWN';

beforeEach(() => {
  realFetch = global.fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

test('a short transcript takes the single-pass path', async () => {
  stub(() => GOOD);
  const notes = await summarizeViaOllama('[00:01] Alice: hello there', meta, cfg);
  assert.equal(calls.length, 1);
  assert.equal(kind(calls[0]), 'SINGLE');
  assert.equal(notes.tldr, 'Something happened.');
});

// The bug this guards: Ollama silently truncates an over-long prompt instead
// of erroring, so without an explicit num_ctx the model only ever saw the
// tail of a session.
test('num_ctx is always sent explicitly', async () => {
  stub(() => GOOD);
  await summarizeViaOllama('[00:01] Alice: hi', meta, cfg);
  assert.equal(calls[0].numCtx, 8192);
});

test('a long transcript is sliced and reduced, never sent in one oversized call', async () => {
  stub(() => GOOD);
  await summarizeViaOllama(longTranscript, meta, cfg);

  const kinds = calls.map(kind);
  assert.ok(kinds.filter((k) => k === 'MAP').length > 1, 'expected several map calls');
  assert.ok(kinds.filter((k) => k === 'REDUCE').length >= 1, 'expected at least one reduce');
  assert.ok(!kinds.includes('SINGLE'), 'must not fall back to a single oversized request');

  for (const c of calls) {
    assert.ok(c.user.length < cfg.ollamaNumCtx * 3.5, 'every request must fit the context budget');
  }
});

test('slices are cut on utterance boundaries, never mid-line', async () => {
  stub(() => GOOD);
  await summarizeViaOllama(longTranscript, meta, cfg);

  for (const c of calls.filter((x) => kind(x) === 'MAP')) {
    const slice = c.user.split('Transcript slice:\n')[1] ?? '';
    for (const line of slice.split('\n').filter(Boolean)) {
      assert.match(line, /^\[\d+\] Alice: /, 'a slice must not begin or end mid-utterance');
    }
  }
});

test('one bad slice degrades gracefully instead of losing the session', async () => {
  stub((n) => (n === 2 ? 'not json at all' : GOOD));
  const notes = await summarizeViaOllama(longTranscript, meta, cfg);
  assert.ok(notes.tldr.length > 0, 'the rest of the session still produces a summary');
});

test('every slice failing throws, so the queue retries rather than storing a blank summary', async () => {
  stub(() => 'not json at all');
  await assert.rejects(() => summarizeViaOllama(longTranscript, meta, cfg), /slices failed/);
});

// Guards a crash: a model returning null for an array used to overwrite the
// default and blow up on the first .map() in the Discord post / markdown.
test('malformed model output is coerced, not fatal', async () => {
  stub(() =>
    JSON.stringify({ tldr: null, scenes: null, npcsIntroduced: 'not an array', followUps: [{ nope: 1 }] })
  );
  const notes = await summarizeViaOllama('[00:01] Alice: hi', meta, cfg);

  assert.equal(typeof notes.tldr, 'string');
  assert.ok(Array.isArray(notes.scenes));
  assert.ok(Array.isArray(notes.npcsIntroduced));
  assert.deepEqual(notes.followUps, [], 'a follow-up with no task is dropped');
  assert.doesNotThrow(() => notes.scenes.map((s) => s.title));
});

test('placeholder follow-ups with an empty task are dropped', async () => {
  stub(() => JSON.stringify({ tldr: 't', followUps: [{ assignee: null, task: '' }, { assignee: 'A', task: 'real' }] }));
  const notes = await summarizeViaOllama('[00:01] Alice: hi', meta, cfg);
  assert.equal(notes.followUps.length, 1);
  assert.equal(notes.followUps[0].task, 'real');
});

test('JSON wrapped in markdown fences is still parsed', async () => {
  stub(() => '```json\n' + GOOD + '\n```');
  const notes = await summarizeViaOllama('[00:01] Alice: hi', meta, cfg);
  assert.equal(notes.tldr, 'Something happened.');
});
