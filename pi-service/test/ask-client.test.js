import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { askCampaign, extractKeywords } from '../src/pipeline/ask-client.js';
import { DND_ASK_PROMPT, buildAskUserMessage } from '../src/prompts/ask-prompt.js';

const summaries = [{ id: 3, channel: 'Cipher', date: '2026-07-31', tldr: 'The party entered the crypt.' }];
const excerpts = [{ meetingId: 3, time: '00:12', speaker: 'Koru', text: 'I open the lantern' }];

// Ollama is reached over node:http rather than fetch (see model-client.js), so
// these answer with a real local server instead of a stubbed global.
let server;
let responder = null;

before(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    responder({ url: req.url, body: JSON.parse(body) }, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // Trailing slash on purpose — it must not produce a double slash in the path.
  cfg.ollamaUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  server.close();
  await once(server, 'close');
});

const cfg = { ollamaUrl: null, ollamaModel: 'test', ollamaNumCtx: 9216, ollamaKeepAlive: '30m' };

function replyStream(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  res.end(
    JSON.stringify({ message: { content }, done: false }) + '\n' + JSON.stringify({ done: true }) + '\n'
  );
}

test('extractKeywords keeps distinctive words and drops filler', () => {
  const kw = extractKeywords('Who was the smuggler we met at the docks in Marrowgate?');
  assert.ok(kw.includes('marrowgate'));
  assert.ok(kw.includes('smuggler'));
  assert.ok(!kw.includes('the'));
  assert.ok(!kw.includes('was'));
});

test('extractKeywords handles degenerate questions', () => {
  assert.deepEqual(extractKeywords(''), []);
  assert.deepEqual(extractKeywords('what did they do'), [], 'an all-stopword question yields nothing to search');
  assert.deepEqual(extractKeywords('Marrowgate?!'), ['marrowgate'], 'punctuation is stripped');
  assert.equal(extractKeywords('lantern lantern lantern').length, 1, 'repeats are deduped');
  assert.ok(extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel').length <= 6, 'result count is capped');
});

test('askCampaign sends a well-formed grounded request', async () => {
  let captured;
  responder = (req, res) => {
    captured = req;
    replyStream(res, '  An answer (session #3).  ');
  };

  const answer = await askCampaign({ question: 'What happened in the crypt?', summaries, excerpts, cfg });

  assert.equal(captured.url, '/api/chat', 'a trailing slash in the URL must not double up');
  assert.equal(captured.body.options.num_ctx, 9216);
  // Streaming is required: Ollama withholds its headers until the first token
  // either way, and the non-streaming wait is the whole generation.
  assert.equal(captured.body.stream, true);
  assert.match(captured.body.messages[1].content, /What happened in the crypt\?/);
  assert.match(captured.body.messages[1].content, /Session #3/, 'recaps are included as context');
  assert.match(captured.body.messages[1].content, /I open the lantern/, 'transcript excerpts are included');
  assert.equal(answer, 'An answer (session #3).', 'the answer is trimmed');
});

test('askCampaign surfaces failures clearly rather than returning junk', async () => {
  responder = (_req, res) => {
    res.writeHead(500);
    res.end('boom');
  };
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg }), /500/);

  responder = (_req, res) => replyStream(res, '');
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg }), /no message content/);

  responder = () => {
    /* never answer, so our own timeout is what fires */
  };
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg, timeoutMs: 100 }), /timed out/);

  // A dropped connection is what a PC going to sleep mid-answer looks like.
  responder = (_req, res) => res.destroy();
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg }), /socket hang up|ECONNRESET/);
});

test('the ask prompt is grounded against invention', () => {
  assert.match(DND_ASK_PROMPT, /never guess/i);
  assert.match(DND_ASK_PROMPT, /session number/i);
  assert.match(DND_ASK_PROMPT, /can't find anything/i);
  assert.match(DND_ASK_PROMPT, /Australian English/i);
});

test('an empty campaign is described honestly to the model', () => {
  const msg = buildAskUserMessage('q', [], []);
  assert.match(msg, /no session recaps recorded yet/);
  assert.match(msg, /no matching transcript lines/);
});
