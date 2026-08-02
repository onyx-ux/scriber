import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askCampaign, extractKeywords } from '../src/pipeline/ask-client.js';
import { DND_ASK_PROMPT, buildAskUserMessage } from '../src/prompts/ask-prompt.js';

const cfg = { summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-3.1-flash-lite' };
const summaries = [{ id: 3, channel: 'Cipher', date: '2026-07-31', tldr: 'The party entered the crypt.' }];
const excerpts = [{ meetingId: 3, time: '00:12', speaker: 'Koru', text: 'I open the lantern' }];

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
  const answer = await askCampaign({
    question: 'What happened in the crypt?',
    summaries,
    excerpts,
    cfg,
    callModel: async (system, user) => {
      captured = { system, user };
      return '  An answer (session #3).  ';
    },
  });

  assert.equal(captured.system, DND_ASK_PROMPT, 'the grounding prompt must be the system message');
  assert.match(captured.user, /What happened in the crypt\?/);
  assert.match(captured.user, /Session #3/, 'recaps are included as context');
  assert.match(captured.user, /I open the lantern/, 'transcript excerpts are included');
  assert.equal(answer, 'An answer (session #3).', 'the answer is trimmed');
});

test('askCampaign surfaces failures clearly rather than returning junk', async () => {
  const boom = (message) => async () => {
    throw new Error(message);
  };

  await assert.rejects(
    () => askCampaign({ question: 'q', summaries, excerpts, cfg, callModel: boom('Gemini returned HTTP 500') }),
    /500/
  );
  await assert.rejects(
    () => askCampaign({ question: 'q', summaries, excerpts, cfg, callModel: boom('Gemini response contained no text') }),
    /no text/
  );
  await assert.rejects(
    () => askCampaign({ question: 'q', summaries, excerpts, cfg, callModel: boom('Gemini request timed out after 300s') }),
    /timed out/
  );
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
