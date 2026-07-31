import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { askCampaign, extractKeywords } from '../src/pipeline/ask-client.js';
import { DND_ASK_PROMPT, buildAskUserMessage } from '../src/prompts/ask-prompt.js';

const cfg = { ollamaUrl: 'http://stub:11434/', ollamaModel: 'test', ollamaNumCtx: 9216 };
const summaries = [{ id: 3, channel: 'Cipher', date: '2026-07-31', tldr: 'The party entered the crypt.' }];
const excerpts = [{ meetingId: 3, time: '00:12', speaker: 'Koru', text: 'I open the lantern' }];

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

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
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ message: { content: '  An answer (session #3).  ' } }) };
  };

  const answer = await askCampaign({ question: 'What happened in the crypt?', summaries, excerpts, cfg });

  assert.equal(captured.url, 'http://stub:11434/api/chat', 'a trailing slash in the URL must not double up');
  assert.equal(captured.body.options.num_ctx, 9216);
  assert.equal(captured.body.stream, false);
  assert.match(captured.body.messages[1].content, /What happened in the crypt\?/);
  assert.match(captured.body.messages[1].content, /Session #3/, 'recaps are included as context');
  assert.match(captured.body.messages[1].content, /I open the lantern/, 'transcript excerpts are included');
  assert.equal(answer, 'An answer (session #3).', 'the answer is trimmed');
});

test('askCampaign surfaces failures clearly rather than returning junk', async () => {
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg }), /500/);

  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg }), /no message content/);

  global.fetch = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg, timeoutMs: 10 }), /timed out/);

  global.fetch = async () => {
    throw new Error('fetch failed');
  };
  await assert.rejects(() => askCampaign({ question: 'q', summaries, excerpts, cfg }), /fetch failed/);
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
