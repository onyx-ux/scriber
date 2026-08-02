import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { contextTokens, isSummariserReachable, summariserLabel } from '../src/pipeline/model-client.js';

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
