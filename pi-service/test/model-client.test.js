import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { contextTokens, isSummariserReachable, summariserLabel } from '../src/pipeline/model-client.js';

const ollamaCfg = { summaryProvider: 'ollama', ollamaUrl: 'http://stub:11434', ollamaModel: 'qwen', ollamaNumCtx: 9216 };
const anthropicCfg = { summaryProvider: 'anthropic', anthropicApiKey: 'sk-test', anthropicModel: 'claude-opus-5' };

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

test('context budget follows the configured provider', () => {
  assert.equal(contextTokens(ollamaCfg), 9216, 'Ollama is capped by the local num_ctx');
  assert.ok(
    contextTokens(anthropicCfg) > 100_000,
    'Claude has room for a whole session in one pass, so slicing rarely triggers'
  );
});

test('reachability for Ollama actually probes the server', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return { ok: true };
  };
  assert.equal(await isSummariserReachable(ollamaCfg), true);

  global.fetch = async () => {
    throw new Error('connection refused');
  };
  assert.equal(await isSummariserReachable(ollamaCfg), false, 'a PC that is off reads as unreachable');
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

test('summariserLabel names the provider actually in use', () => {
  assert.match(summariserLabel(ollamaCfg), /Ollama/);
  assert.match(summariserLabel(anthropicCfg), /Claude/);
  assert.match(summariserLabel(anthropicCfg), /claude-opus-5/);
});
