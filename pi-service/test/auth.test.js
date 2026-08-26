import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  openSession, readSession, closeSession,
  sessionCookie, clearedCookie, cookieFrom,
  newState, askedForConsent, stateMatches, stateCookie, clearedStateCookie,
  SESSION_TTL_MS, STATE_TTL_MS, COOKIE, STATE_COOKIE,
} from '../src/web/auth.js';

// The two credentials that live in a browser, and nothing else.
//
// Signing in is Discord's job now — web/discord-oauth.js does the asking. What
// is left here is what happens either side of it: a state that ties one
// callback to the browser that started it, and a session cookie that is the
// only thing standing between a stranger and somebody's campaign. Both are
// stored as HMACs or not stored at all, and every test here is a plank of that.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-auth-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, cfg: { statusToken: 'a-real-secret' } };
}

const WHO = { userId: '10000000000000001', username: 'saf' };

// --- what is stored ---

test('the session token is never stored in a readable form', async (t) => {
  const { db, cfg } = await harness(t);
  const { token } = openSession(db, cfg, WHO);

  assert.equal(db.getAuthSession(token), null, 'the raw token is not the key');
  assert.equal(readSession(db, cfg, token).userId, WHO.userId, 'but hashing it finds the row');
});

// The point of the whole design: there is no password column to leak.
test('no table in the schema holds a password', async (t) => {
  const { db } = await harness(t);
  const columns = db.raw
    .prepare(`SELECT name FROM pragma_table_info('auth_sessions')`)
    .all()
    .map((r) => r.name);

  assert.equal(columns.some((c) => /pass|secret|token(?!_hash)/i.test(c)), false, columns.join(', '));
  assert.ok(columns.includes('token_hash'));
});

// The codes table went with the flow that needed it. A table of live
// credentials for a sign-in nothing performs any more is the worst kind of dead
// code, because it still works.
test('the six-digit code table is gone, not merely unused', async (t) => {
  const { db } = await harness(t);
  const tables = db.raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r) => r.name);

  assert.equal(tables.includes('auth_codes'), false, tables.join(', '));
});

// A leaked database must not be usable against another install, so the hash
// has to be keyed on something per-install.
test('the same token hashes differently under a different secret', async (t) => {
  const { db } = await harness(t);
  const { token } = openSession(db, { statusToken: 'one' }, WHO);

  assert.ok(readSession(db, { statusToken: 'one' }, token), 'its own install reads it');
  assert.equal(readSession(db, { statusToken: 'two' }, token), null, 'another install cannot');
});

test('a bot with no secret cannot sign anybody in', async (t) => {
  const { db } = await harness(t);
  assert.equal(openSession(db, {}, WHO), null);
  assert.equal(readSession(db, {}, 'anything'), null);
});

// --- one sign-in attempt ---

// OAuth's whole CSRF defence. Without it, anybody can hand somebody a callback
// link that quietly signs them into an attacker's Discord account and leaves
// them typing into it.
test('a state matches only itself', async () => {
  const mine = newState();
  const theirs = newState();

  assert.equal(stateMatches(mine, mine), true);
  assert.equal(stateMatches(mine, theirs), false);
  assert.equal(stateMatches(mine, `${mine}x`), false, 'not a prefix of itself');
});

// The callback has to be able to fail closed on a request that carries no
// cookie at all, which is what a link from somewhere else looks like.
test('a missing half is never a match', async () => {
  const state = newState();
  for (const [held, given] of [[null, state], [state, null], [null, null], ['', ''], [undefined, undefined]]) {
    assert.equal(stateMatches(held, given), false);
  }
});

// prompt=none can answer "ask them properly", and the retry has to be able to
// say it has already done so or Discord bounces the browser round for ever.
test('a state remembers whether consent has already been asked for', async () => {
  assert.equal(askedForConsent(newState()), false);
  assert.equal(askedForConsent(newState({ consent: true })), true);
  assert.equal(askedForConsent(null), false);
});

test('states do not repeat', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(newState());
  assert.equal(seen.size, 200, 'a state you can guess is no defence at all');
});

// --- sessions ---

test('a session survives until it expires and not a moment longer', async (t) => {
  const { db, cfg } = await harness(t);
  const now = Date.now();
  const { token } = openSession(db, cfg, { ...WHO, now });

  assert.ok(readSession(db, cfg, token, { now: now + SESSION_TTL_MS - 1000 }));
  assert.equal(readSession(db, cfg, token, { now: now + SESSION_TTL_MS + 1 }), null);
  assert.equal(db.getAuthSession(token), null, 'and expiry deletes rather than hides');
});

test('signing out makes the cookie permanently meaningless', async (t) => {
  const { db, cfg } = await harness(t);
  const { token } = openSession(db, cfg, WHO);

  assert.equal(closeSession(db, cfg, token), 1);
  assert.equal(readSession(db, cfg, token), null);
});

test('signing out everywhere ends every session for that account', async (t) => {
  const { db, cfg } = await harness(t);
  const one = openSession(db, cfg, WHO).token;
  const two = openSession(db, cfg, WHO).token;
  const other = openSession(db, cfg, { userId: '20000000000000002', username: 'brett' }).token;

  assert.equal(closeSession(db, cfg, one, { everywhere: true }), 2);
  assert.equal(readSession(db, cfg, two), null);
  assert.ok(readSession(db, cfg, other), 'somebody else is untouched');
});

test('a made-up token is not a session', async (t) => {
  const { db, cfg } = await harness(t);
  openSession(db, cfg, WHO);

  for (const guess of ['', 'x', 'null', 'undefined', '0'.repeat(64)]) {
    assert.equal(readSession(db, cfg, guess), null);
  }
});

// --- the cookies ---

test('the cookie is HttpOnly and SameSite, and only Secure on https', async () => {
  const plain = sessionCookie('abc');
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/, 'Secure on a LAN http page means the browser discards it');

  assert.match(sessionCookie('abc', { secure: true }), /Secure/);
  assert.match(clearedCookie(), /Max-Age=0/);
});

// Lax rather than Strict is load-bearing here specifically. The callback is a
// top-level navigation arriving from discord.com; under Strict the cookie is
// not sent back and every single sign-in fails its own CSRF check.
test('the state cookie is short-lived, HttpOnly and Lax', async () => {
  const cookie = stateCookie('abc');
  assert.match(cookie, new RegExp(`^${STATE_COOKIE}=abc`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, new RegExp(`Max-Age=${STATE_TTL_MS / 1000}\\b`));
  assert.match(stateCookie('abc', { secure: true }), /Secure/);
  assert.match(clearedStateCookie(), /Max-Age=0/);
});

test('each cookie is read back out of a real header without catching the other', async () => {
  const header = `other=1; ${COOKIE}=deadbeef; ${STATE_COOKIE}=feedface; another=2`;
  assert.equal(cookieFrom(header), 'deadbeef');
  assert.equal(cookieFrom(header, STATE_COOKIE), 'feedface');
  assert.equal(cookieFrom('other=1'), null);
  assert.equal(cookieFrom(undefined), null);
});

// --- housekeeping ---

test('the sweep deletes what has expired and keeps what has not', async (t) => {
  const { db, cfg } = await harness(t);
  const past = Date.now() - 60_000;
  openSession(db, cfg, { userId: '20000000000000002', username: 'brett', now: past - SESSION_TTL_MS });
  const alive = openSession(db, cfg, { userId: '30000000000000003', username: 'kez' }).token;

  assert.equal(db.sweepAuth().sessions, 1);
  assert.ok(readSession(db, cfg, alive), 'a live session is not swept');
});

// The dashboard polls every few seconds and every poll carries the cookie. A
// naive touch-on-read is a database write every five seconds, for ever, onto
// the SD card of a Raspberry Pi.
test('reading a session does not write on every poll', async (t) => {
  const { db, cfg } = await harness(t);
  const { token } = openSession(db, cfg, WHO);

  let writes = 0;
  const realTouch = db.touchAuthSession.bind(db);
  db.touchAuthSession = (hash) => { writes += 1; return realTouch(hash); };

  for (let i = 0; i < 20; i += 1) readSession(db, cfg, token);
  assert.equal(writes, 0, 'a fresh session was just written; twenty reads need no more');

  // An hour later it is worth recording that somebody is still there.
  db.raw.prepare(`UPDATE auth_sessions SET last_seen_at = datetime('now','-1 hour')`).run();
  readSession(db, cfg, token);
  assert.equal(writes, 1);
});
