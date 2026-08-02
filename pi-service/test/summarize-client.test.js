import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { summarizeTranscript } from '../src/pipeline/summarize-client.js';

// Ollama is reached over node:http (see model-client.js — Node's fetch
// imposes an unraisable 300s header deadline that killed real summaries), so
// these tests answer with a real local server rather than a stubbed fetch.
let server;
let responder = null;

before(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    responder(JSON.parse(body), res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cfg.ollamaUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
});

const cfg = { ollamaUrl: null, ollamaModel: 'test', ollamaNumCtx: 8192, ollamaKeepAlive: '30m' };
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

// stream:true means a reply is newline-delimited JSON, not one object.
function writeStream(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  res.end(
    JSON.stringify({ message: { content }, done: false }) +
      '\n' +
      JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 1e9 }) +
      '\n'
  );
}

function record(body) {
  calls.push({ system: body.messages[0].content, user: body.messages[1].content, numCtx: body.options?.num_ctx });
}

function stub(reply) {
  calls = [];
  responder = (body, res) => {
    record(body);
    writeStream(res, reply(calls.length));
  };
}

const kind = (c) =>
  c.system.startsWith('You are analyzing') ? 'SINGLE'
  : c.system.startsWith('You are extracting') ? 'MAP'
  : c.system.startsWith('You are assembling') ? 'REDUCE'
  : 'UNKNOWN';

test('a short transcript takes the single-pass path', async () => {
  stub(() => GOOD);
  const notes = await summarizeTranscript('[00:01] Alice: hello there', meta, cfg);
  assert.equal(calls.length, 1);
  assert.equal(kind(calls[0]), 'SINGLE');
  assert.equal(notes.tldr, 'Something happened.');
});

// The bug this guards: Ollama silently truncates an over-long prompt instead
// of erroring, so without an explicit num_ctx the model only ever saw the
// tail of a session.
test('num_ctx is always sent explicitly', async () => {
  stub(() => GOOD);
  await summarizeTranscript('[00:01] Alice: hi', meta, cfg);
  assert.equal(calls[0].numCtx, 8192);
});

test('a long transcript is sliced and reduced, never sent in one oversized call', async () => {
  stub(() => GOOD);
  await summarizeTranscript(longTranscript, meta, cfg);

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
  await summarizeTranscript(longTranscript, meta, cfg);

  for (const c of calls.filter((x) => kind(x) === 'MAP')) {
    const slice = c.user.split('Transcript slice:\n')[1] ?? '';
    for (const line of slice.split('\n').filter(Boolean)) {
      assert.match(line, /^\[\d+\] Alice: /, 'a slice must not begin or end mid-utterance');
    }
  }
});

test('one bad slice degrades gracefully instead of losing the session', async () => {
  stub((n) => (n === 2 ? 'not json at all' : GOOD));
  const notes = await summarizeTranscript(longTranscript, meta, cfg);
  assert.ok(notes.tldr.length > 0, 'the rest of the session still produces a summary');
});

test('every slice failing throws, so the queue retries rather than storing a blank summary', async () => {
  stub(() => 'not json at all');
  await assert.rejects(() => summarizeTranscript(longTranscript, meta, cfg), /slices failed/);
});

// Guards a crash: a model returning null for an array used to overwrite the
// default and blow up on the first .map() in the Discord post / markdown.
test('malformed model output is coerced, not fatal', async () => {
  stub(() =>
    JSON.stringify({ tldr: null, scenes: null, npcsIntroduced: 'not an array', followUps: [{ nope: 1 }] })
  );
  const notes = await summarizeTranscript('[00:01] Alice: hi', meta, cfg);

  assert.equal(typeof notes.tldr, 'string');
  assert.ok(Array.isArray(notes.scenes));
  assert.ok(Array.isArray(notes.npcsIntroduced));
  assert.deepEqual(notes.followUps, [], 'a follow-up with no task is dropped');
  assert.doesNotThrow(() => notes.scenes.map((s) => s.title));
});

test('placeholder follow-ups with an empty task are dropped', async () => {
  stub(() => JSON.stringify({ tldr: 't', followUps: [{ assignee: null, task: '' }, { assignee: 'A', task: 'real' }] }));
  const notes = await summarizeTranscript('[00:01] Alice: hi', meta, cfg);
  assert.equal(notes.followUps.length, 1);
  assert.equal(notes.followUps[0].task, 'real');
});

test('JSON wrapped in markdown fences is still parsed', async () => {
  stub(() => '```json\n' + GOOD + '\n```');
  const notes = await summarizeTranscript('[00:01] Alice: hi', meta, cfg);
  assert.equal(notes.tldr, 'Something happened.');
});

// --- losing most of a session must not read as "nothing happened" ---
//
// A real 3-hour session was posted as "casual chat / bot testing, not
// gameplay" because six of its seven slices had failed and the reduce step
// faithfully summarised the resulting emptiness. The transcript was intact
// the whole time; only the summariser calls had failed.

// Fails the first N calls the way a real outage does — the connection simply
// drops — then succeeds, so slice failures can be simulated precisely.
function stubWithFailures(failFirst, reply = () => GOOD) {
  calls = [];
  let n = 0;
  responder = (body, res) => {
    record(body);
    n += 1;
    if (n <= failFirst) return res.destroy();
    writeStream(res, reply(calls.length));
  };
}

test('losing most of the slices fails the job instead of summarising the gap', async () => {
  // Each slice is attempted twice (one retry), so 6 failed slices = 12 calls.
  stubWithFailures(12);

  await assert.rejects(
    () => summarizeTranscript(longTranscript, meta, cfg),
    /slices failed to summarise/,
    'a summary built from a minority of the session is a fabrication, not a summary'
  );
});

test('a job that fails this way stays retryable rather than storing a wrong answer', async () => {
  stubWithFailures(12);
  const err = await summarizeTranscript(longTranscript, meta, cfg).catch((e) => e);
  assert.ok(err instanceof Error, 'it throws, so queue-worker retries it later');
  assert.match(err.message, /refusing/);
});

test('a small number of failed slices still summarises, but says so', async () => {
  // Two calls = one slice failing after its retry.
  stubWithFailures(2);

  const notes = await summarizeTranscript(longTranscript, meta, cfg);
  assert.match(notes.tldr, /Partial summary/, 'the reader must be able to tell it is incomplete');
  assert.match(notes.tldr, /1 of \d+/, 'and how much is missing');
});

test('a clean run carries no partial-summary warning', async () => {
  stub(() => GOOD);
  const notes = await summarizeTranscript(longTranscript, meta, cfg);
  assert.doesNotMatch(notes.tldr, /Partial summary/);
});
