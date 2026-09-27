import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, parseLimits, limitsFor, DEFAULT_LIMITS } from '../src/pipeline/rate-limits.js';

// Google reports no remaining quota, so the bot counts. These are the numbers
// off the key's own AI Studio page (28 Sep 2026), and the pacing that keeps
// the bot under them.

// A clock the test moves, and a sleep that moves it.
function clock() {
  let t = Date.parse('2026-09-28T10:00:00');
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    slept,
  };
}

test('the key\'s own limits ship as the defaults', () => {
  assert.deepEqual(DEFAULT_LIMITS['gemini-3.8-flash'], { rpm: 5, tpm: 250_000, rpd: null });
  assert.equal(DEFAULT_LIMITS['gemini-3.5-transcribe-live'].tpm, 20_000);
  assert.equal(DEFAULT_LIMITS['gemini-3.8-live-extended-thinking'].tpm, 65_000);
});

test('GEMINI_RATE_LIMITS overrides a model and leaves the rest', () => {
  const own = parseLimits('gemini-3.8-flash=10/500000/1000, gemini-3.5-transcribe-live=/30_000/');
  assert.deepEqual(own['gemini-3.8-flash'], { rpm: 10, tpm: 500_000, rpd: 1000 });
  assert.deepEqual(own['gemini-3.5-transcribe-live'], { rpm: null, tpm: 30_000, rpd: null });
  const cfg = { geminiRateLimits: own };
  assert.equal(limitsFor(cfg, 'gemini-3.8-flash').rpm, 10);
  assert.equal(limitsFor(cfg, 'gemini-3.7-flash').rpm, 5, 'untouched models keep the default');
  assert.equal(limitsFor(cfg, 'some-unknown-model'), null, 'an unknown model is not paced');
});

test('the sixth request in a minute waits for the first to age out', async () => {
  const c = clock();
  const limiter = createRateLimiter({ now: c.now, sleep: c.sleep });
  const limits = { rpm: 5, tpm: null };
  for (let i = 0; i < 5; i += 1) await limiter.acquire('m', { limits });
  assert.equal(c.slept.length, 0, 'five go straight through');

  await limiter.acquire('m', { limits });
  const waited = c.slept.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 60_000 && waited < 62_000, `waited ${waited}ms`);
});

test('tokens are budgeted with headroom, and one oversized request still goes alone', async () => {
  const c = clock();
  const limiter = createRateLimiter({ now: c.now, sleep: c.sleep, headroom: 0.85 });
  const limits = { tpm: 20_000 };
  await limiter.acquire('live', { limits, tokens: 10_000 });
  await limiter.acquire('live', { limits, tokens: 6_000 });
  assert.equal(c.slept.length, 0, '16,000 is under 85% of 20,000');
  await limiter.acquire('live', { limits, tokens: 2_000 });
  assert.ok(c.slept.length > 0, '18,000 is not');

  const fresh = createRateLimiter({ now: c.now, sleep: c.sleep });
  const before = c.slept.length;
  await fresh.acquire('live', { limits, tokens: 50_000 });
  assert.equal(c.slept.length, before, 'bigger than the whole budget, into an empty minute');
});

test('a settled booking counts what was really spent', async () => {
  const c = clock();
  const limiter = createRateLimiter({ now: c.now, sleep: c.sleep });
  const booking = await limiter.acquire('m', { limits: { tpm: 250_000 }, tokens: 1_000 });
  booking.settle(40_000);
  assert.equal(limiter.usage('m').tokens, 40_000);
});

test('a pause holds every caller until it ends', async () => {
  const c = clock();
  const limiter = createRateLimiter({ now: c.now, sleep: c.sleep });
  limiter.pause('m', 30_000);
  await limiter.acquire('m', { limits: { rpm: 5 } });
  assert.equal(c.slept.reduce((a, b) => a + b, 0), 30_000);
});

test('a daily allowance, once spent, refuses like a quota error so the ladder steps down', async () => {
  const c = clock();
  const limiter = createRateLimiter({ now: c.now, sleep: c.sleep });
  const limits = { rpd: 2 };
  await limiter.acquire('m', { limits });
  await limiter.acquire('m', { limits });
  await assert.rejects(limiter.acquire('m', { limits }), (err) => err.status === 429 && /RESOURCE_EXHAUSTED/.test(err.message));
});

test('a model with no known limits is never held', async () => {
  const c = clock();
  const limiter = createRateLimiter({ now: c.now, sleep: c.sleep });
  for (let i = 0; i < 50; i += 1) await limiter.acquire('m', { limits: null, tokens: 1e9 });
  assert.equal(c.slept.length, 0);
});
