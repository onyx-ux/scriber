import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  callModel,
  contextTokens,
  fallbackProvider,
  isProviderUnreachable,
  isQuotaError,
  isSummariserReachable,
  summariserLabel,
} from '../src/pipeline/model-client.js';

const anthropicCfg = { summaryProvider: 'anthropic', anthropicApiKey: 'sk-test', anthropicModel: 'claude-opus-5' };
const geminiCfg = { summaryProvider: 'gemini', geminiApiKey: 'gm-test', geminiModel: 'gemini-3.1-flash-lite' };

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

test('context budget follows the configured provider', () => {
  assert.ok(
    contextTokens(anthropicCfg) > 100_000,
    'Claude has room for a whole session in one pass, so slicing rarely triggers'
  );
  assert.ok(
    contextTokens(geminiCfg) > 100_000,
    'Gemini has room for a whole session in one pass, so slicing rarely triggers'
  );
});

// Deliberately does not burn an API call — a real outage surfaces through the
// normal retry queue rather than costing a request on every /leave.
test('reachability for Claude is a key check, not a network call', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true };
  };

  assert.equal(await isSummariserReachable(anthropicCfg), true);
  assert.equal(called, false, 'must not hit the network just to answer "is it available"');
  assert.equal(await isSummariserReachable({ ...anthropicCfg, anthropicApiKey: null }), false);
});

// Same reasoning as the Claude check above — a configured key reads as
// available, a real Gemini outage surfaces through the retry queue instead.
test('reachability for Gemini is a key check, not a network call', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true };
  };

  assert.equal(await isSummariserReachable(geminiCfg), true);
  assert.equal(called, false, 'must not hit the network just to answer "is it available"');
  assert.equal(await isSummariserReachable({ ...geminiCfg, geminiApiKey: null }), false);
});

test('summariserLabel names the provider actually in use', () => {
  assert.match(summariserLabel(anthropicCfg), /Claude/);
  assert.match(summariserLabel(anthropicCfg), /claude-opus-5/);
  assert.match(summariserLabel(geminiCfg), /Gemini/);
  assert.match(summariserLabel(geminiCfg), /gemini-3\.1-flash-lite/);
});

// --- when a whole provider cannot answer ---
//
// The model ladder already steps down within one provider when it is out of
// quota. What was missing is the level above it: every model of theirs
// exhausted, or nothing answering at the other end, used to fail the job and
// leave a recorded evening unwritten while a second configured key sat idle.
//
// `ask` is injected throughout, so none of this needs a live key — what is
// under test is which provider gets asked, how many times, and when the bot
// refuses to cross over at all.

const bothKeys = {
  summaryProvider: 'gemini',
  geminiApiKey: 'gm-test',
  geminiModel: 'gemini-3.6-flash',
  anthropicApiKey: 'sk-test',
  anthropicModel: 'claude-opus-5',
};

const quota = () => Object.assign(new Error('RESOURCE_EXHAUSTED: quota'), { status: 429 });
const offline = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const refusal = () => Object.assign(new Error('invalid request: bad schema'), { status: 400 });

// Records who was asked what, and answers however the test says.
function recorder(answer) {
  const calls = [];
  const ask = async (provider, _sys, _user, _cfg, _timeout, model) => {
    calls.push({ provider, model });
    return answer(provider, model);
  };
  return { calls, ask, byProvider: (p) => calls.filter((c) => c.provider === p) };
}

const said = (text) => ({ text, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

test('a provider out of quota on every model hands the session to the other one', async () => {
  const r = recorder((provider) => {
    if (provider === 'gemini') throw quota();
    return said('Claude wrote it.');
  });

  const out = await callModel('sys', 'user', bothKeys, 1000, { ask: r.ask });

  assert.equal(out, 'Claude wrote it.');
  assert.ok(r.byProvider('gemini').length >= 2, 'the whole ladder is walked before giving up on a provider');
  assert.equal(r.byProvider('anthropic').length, 1);
});

// The distinction that keeps this from doubling the bill on a bad request: a
// refusal is the request's fault and would be refused again, at another price.
test('an ordinary failure never crosses to the other provider', async () => {
  const r = recorder(() => { throw refusal(); });

  await assert.rejects(
    () => callModel('sys', 'user', bothKeys, 1000, { ask: r.ask }),
    /bad schema/
  );
  assert.equal(r.byProvider('gemini').length, 1, 'and does not walk its own ladder either');
  assert.equal(r.byProvider('anthropic').length, 0);
});

// A cheaper model of theirs is the same host over the same dead link. Walking
// down is three more ways to fail identically.
test('an unreachable provider is not walked down, it is stepped across', async () => {
  const r = recorder((provider) => {
    if (provider === 'gemini') throw offline();
    return said('Claude wrote it.');
  });

  assert.equal(await callModel('sys', 'user', bothKeys, 1000, { ask: r.ask }), 'Claude wrote it.');
  assert.equal(r.byProvider('gemini').length, 1, 'asked once, then given up on');
  assert.equal(r.byProvider('anthropic').length, 1);
});

// Same reasoning as the ask ladder not climbing: a question asked in passing is
// not worth quietly reaching for a second bill. An evening already recorded is.
test('a question never crosses over, however unavailable the provider is', async () => {
  const r = recorder(() => { throw quota(); });

  await assert.rejects(() => callModel('sys', 'user', bothKeys, 1000, { role: 'ask', ask: r.ask }));
  assert.equal(r.byProvider('anthropic').length, 0);
});

test('the switch turns it off without touching anything else', async () => {
  const r = recorder((provider) => {
    if (provider === 'gemini') throw quota();
    return said('Claude wrote it.');
  });

  await assert.rejects(
    () => callModel('sys', 'user', { ...bothKeys, summaryProviderFallback: false }, 1000, { ask: r.ask }),
    /quota/
  );
  assert.equal(r.byProvider('anthropic').length, 0);
  assert.ok(r.byProvider('gemini').length >= 2, 'the within-provider ladder still runs');
});

test('one configured key behaves exactly as it did before', async () => {
  const only = { summaryProvider: 'gemini', geminiApiKey: 'gm-test', geminiModel: 'gemini-3.6-flash' };
  const r = recorder(() => { throw quota(); });

  await assert.rejects(() => callModel('sys', 'user', only, 1000, { ask: r.ask }), /quota/);
  assert.equal(r.byProvider('anthropic').length, 0);
});

// Both down is the configured provider's problem to report — that is the one
// the operator set up and the one they will look for in the log.
test('when both are down the configured provider is the one named', async () => {
  const r = recorder((provider) => {
    throw provider === 'gemini' ? quota() : Object.assign(new Error('claude is out too'), { status: 429 });
  });

  await assert.rejects(
    () => callModel('sys', 'user', bothKeys, 1000, { ask: r.ask }),
    /RESOURCE_EXHAUSTED/
  );
});

// ...unless the fallback failed for its own reason, which says something about
// the request rather than about the weather.
test('a fallback that refuses the request reports that instead', async () => {
  const r = recorder((provider) => {
    if (provider === 'gemini') throw quota();
    throw refusal();
  });

  await assert.rejects(() => callModel('sys', 'user', bothKeys, 1000, { ask: r.ask }), /bad schema/);
});

// The bill has to say who actually spent it. A session written by the fallback
// and recorded against the configured provider is a wrong number on a screen
// whose entire job is being right about money.
test('the fallback leg is billed to the provider that ran it', async () => {
  const rows = [];
  const db = { recordModelUsage: (row) => rows.push(row) };
  const r = recorder((provider) => {
    if (provider === 'gemini') throw quota();
    return said('Claude wrote it.');
  });

  await callModel('sys', 'user', bothKeys, 1000, { ask: r.ask, db, meetingId: 7 });

  const ok = rows.filter((row) => row.outcome === 'ok');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].provider, 'anthropic');
  assert.equal(ok[0].model, 'claude-opus-5');
  assert.ok(rows.some((row) => row.provider === 'gemini' && row.outcome === 'rate_limited'));
});

test('unreachable and out-of-quota are told apart', () => {
  assert.equal(isProviderUnreachable(offline()), true);
  assert.equal(isProviderUnreachable(Object.assign(new Error('x'), { name: 'APIConnectionError' })), true);
  assert.equal(isProviderUnreachable(new Error('Gemini request timed out after 1200s')), true);
  assert.equal(isProviderUnreachable(refusal()), false);

  // Being out of quota is the provider talking, which is why it walks the
  // ladder rather than stepping across on the first refusal.
  assert.equal(isQuotaError(quota()), true);
  assert.equal(isProviderUnreachable(quota()), false);
});

test('the other provider is only offered when it has a key and is allowed', () => {
  assert.equal(fallbackProvider(bothKeys, 'gemini'), 'anthropic');
  assert.equal(fallbackProvider(bothKeys, 'anthropic'), 'gemini');
  assert.equal(fallbackProvider({ ...bothKeys, anthropicApiKey: null }, 'gemini'), null);
  assert.equal(fallbackProvider({ ...bothKeys, summaryProviderFallback: false }, 'gemini'), null);
});
