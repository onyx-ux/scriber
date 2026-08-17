import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { ladderFor, topModel, knownModels, ROLES } from '../src/pipeline/model-choice.js';
import { isQuotaError } from '../src/pipeline/model-client.js';
import { askAllowance } from '../src/pipeline/ask-client.js';

// Which model does which job, and what happens when one runs out.
//
// Two things are worth being careful about, and both cost money to get wrong:
// stepping down the ladder for the wrong reason pays twice to fail twice, and
// letting /ask off its ceiling hands the owner's API budget to whoever is
// bored.

const cfg = {
  summaryProvider: 'gemini',
  geminiApiKey: 'k',
  geminiModel: 'gemini-3.6-flash',
  geminiModelFallbacks: 'gemini-3.5-flash,gemini-3.1-flash-lite',
  geminiAskModel: 'gemini-3.1-flash-lite',
  askDailyLimit: 20,
};

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-models-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// --- who does what ---

test('writing up a session starts at the configured model', async (t) => {
  const db = await harness(t);
  assert.equal(topModel(cfg, 'summary', db), 'gemini-3.6-flash');
});

// The measured reason this exists: a seven-token prompt costs 109 total tokens
// on gemini-3.6-flash and 8 on gemini-3.1-flash-lite, because the flash models
// think whether the question needs it or not.
test('answering a question starts at the cheap model, not the summariser', async (t) => {
  const db = await harness(t);
  assert.equal(topModel(cfg, 'ask', db), 'gemini-3.1-flash-lite');
  assert.notEqual(topModel(cfg, 'ask', db), topModel(cfg, 'summary', db));
});

test('the summary ladder runs best to cheapest, without repeats', async (t) => {
  const db = await harness(t);
  assert.deepEqual(ladderFor(cfg, 'summary', db), [
    'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite',
  ]);
});

// /ask must not climb. If the lite tier is out, the honest answer is to wait,
// not to quietly spend ten times as much on a question asked in passing.
test('the ask ladder never climbs above the summary ladder\'s cheapest', async (t) => {
  const db = await harness(t);
  const ask = ladderFor(cfg, 'ask', db);

  assert.equal(ask[0], 'gemini-3.1-flash-lite');
  assert.equal(ask.includes('gemini-3.6-flash'), false, 'the expensive model is not an /ask fallback');
});

test('a model chosen on the dashboard beats the env file', async (t) => {
  const db = await harness(t);
  db.setSetting('model_summary', 'gemini-3.5-flash');

  assert.equal(topModel(cfg, 'summary', db), 'gemini-3.5-flash');
  assert.equal(ladderFor(cfg, 'summary', db)[0], 'gemini-3.5-flash');
});

// There has to be a way back to the default, or a bad choice is permanent.
test('clearing the choice puts the config back in charge', async (t) => {
  const db = await harness(t);
  db.setSetting('model_summary', 'gemini-3.5-flash');
  db.setSetting('model_summary', '');

  assert.equal(topModel(cfg, 'summary', db), 'gemini-3.6-flash');
});

test('anthropic gets its own ladder rather than gemini names', async (t) => {
  const db = await harness(t);
  const claude = { ...cfg, summaryProvider: 'anthropic', anthropicModel: 'claude-opus-5' };

  assert.equal(topModel(claude, 'summary', db), 'claude-opus-5');
  assert.match(topModel(claude, 'ask', db), /^claude-/);
  assert.equal(ladderFor(claude, 'summary', db).some((m) => m.startsWith('gemini')), false);
});

test('a bot with no db still resolves a model', () => {
  assert.equal(topModel(cfg, 'summary'), 'gemini-3.6-flash');
  assert.equal(topModel(cfg, 'ask'), 'gemini-3.1-flash-lite');
});

test('the selector offers every model either role might use', async (t) => {
  const db = await harness(t);
  const choices = knownModels(cfg, db);

  assert.ok(choices.includes('gemini-3.6-flash'));
  assert.ok(choices.includes('gemini-3.1-flash-lite'));
  assert.equal(new Set(choices).size, choices.length, 'no repeats in a dropdown');
  assert.deepEqual(ROLES, ['summary', 'ask']);
});

// --- when to step down ---

test('quota errors are recognised in every shape either provider sends', () => {
  for (const err of [
    { status: 429 },
    { status: 503 },
    { status: 529 },
    new Error('429 RESOURCE_EXHAUSTED: quota exceeded'),
    new Error('rate_limit_error'),
    new Error('This model is currently experiencing high demand'),
    new Error('Overloaded'),
  ]) {
    assert.equal(isQuotaError(err), true, `${JSON.stringify(err.message ?? err)} should read as quota`);
  }
});

// The important half. Re-running a refusal on a cheaper model spends money to
// fail twice, so only quota may send the call down the ladder.
test('an ordinary failure is not a quota error', () => {
  for (const err of [
    new Error('Gemini declined this request (SAFETY)'),
    new Error('Gemini request timed out after 300s'),
    new Error('Claude response contained no text'),
    { status: 400 },
    { status: 500 },
  ]) {
    assert.equal(isQuotaError(err), false, `${JSON.stringify(err.message ?? err)} should not read as quota`);
  }
});

// --- what the models cost ---

test('usage is recorded per model, per role, and totalled', async (t) => {
  const db = await harness(t);

  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.6-flash', role: 'summary',
                        inputTokens: 900, outputTokens: 300, totalTokens: 1400 });
  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.1-flash-lite', role: 'ask',
                        inputTokens: 40, outputTokens: 10, totalTokens: 50 });

  const rows = db.modelUsage(7);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, 'gemini-3.6-flash', 'biggest spender first');
  assert.equal(rows[0].total_tokens, 1400);

  const today = db.modelUsageToday();
  assert.equal(today.tokens, 1450);
  assert.equal(today.calls, 2);
});

// The thinking tokens are the whole reason /ask moved. If total were just
// input + output the difference would be invisible.
test('the total is stored as reported, not recomputed from input and output', async (t) => {
  const db = await harness(t);
  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.6-flash', role: 'summary',
                        inputTokens: 7, outputTokens: 1, totalTokens: 109 });

  assert.equal(db.modelUsageToday().tokens, 109, 'thinking is billed and has to show');
});

test('a refused call is recorded too, because that is the event worth seeing', async (t) => {
  const db = await harness(t);
  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.6-flash', role: 'summary',
                        outcome: 'rate_limited', error: '429 RESOURCE_EXHAUSTED' });

  const [row] = db.modelUsage(7);
  assert.equal(row.limited, 1);
  assert.equal(db.modelUsageToday().limited, 1);
});

test('old usage is pruned and recent usage is not', async (t) => {
  const db = await harness(t);
  db.recordModelUsage({ provider: 'gemini', model: 'm', role: 'ask', totalTokens: 1 });
  db.raw.prepare(`UPDATE model_usage SET day = date('now','-200 days')`).run();
  db.recordModelUsage({ provider: 'gemini', model: 'm', role: 'ask', totalTokens: 2 });

  assert.equal(db.pruneModelUsage(90), 1);
  assert.equal(db.modelUsageToday().tokens, 2);
});

// --- the ceiling on /ask ---

test('a normal number of questions is allowed', async (t) => {
  const db = await harness(t);
  const who = '10000000000000001';

  for (let i = 0; i < 5; i += 1) {
    assert.equal(askAllowance(db, cfg, who).allowed, true);
    db.countAsk(who);
  }
  assert.equal(askAllowance(db, cfg, who).used, 5);
  assert.equal(askAllowance(db, cfg, who).left, 15);
});

test('the twenty-first question is refused, with a reason', async (t) => {
  const db = await harness(t);
  const who = '10000000000000001';
  for (let i = 0; i < 20; i += 1) db.countAsk(who);

  const verdict = askAllowance(db, cfg, who);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.message, /daily limit/);
  assert.match(verdict.message, /recap/, 'and points at the free commands');
});

test('one person exhausting their questions does not stop anybody else', async (t) => {
  const db = await harness(t);
  for (let i = 0; i < 20; i += 1) db.countAsk('10000000000000001');

  assert.equal(askAllowance(db, cfg, '10000000000000001').allowed, false);
  assert.equal(askAllowance(db, cfg, '20000000000000002').allowed, true);
});

test('yesterday\'s questions do not count against today', async (t) => {
  const db = await harness(t);
  const who = '10000000000000001';
  for (let i = 0; i < 20; i += 1) db.countAsk(who);
  db.raw.prepare(`UPDATE ask_quota SET day = date('now','-1 day')`).run();

  assert.equal(askAllowance(db, cfg, who).allowed, true);
});

test('a limit of zero means no limit', async (t) => {
  const db = await harness(t);
  const who = '10000000000000001';
  for (let i = 0; i < 50; i += 1) db.countAsk(who);

  assert.equal(askAllowance(db, { ...cfg, askDailyLimit: 0 }, who).allowed, true);
});

// Who asked what is personal data about a player; what the models cost is a
// bill. This bot keeps those apart everywhere else, and here too.
test('the question counter holds no more than a count and a date', async (t) => {
  const db = await harness(t);
  const columns = db.raw.prepare(`SELECT name FROM pragma_table_info('ask_quota')`).all().map((r) => r.name);
  assert.deepEqual(columns.sort(), ['asks', 'day', 'user_id']);

  const usage = db.raw.prepare(`SELECT name FROM pragma_table_info('model_usage')`).all().map((r) => r.name);
  assert.equal(usage.includes('user_id'), false, 'the cost table names no people');
});
