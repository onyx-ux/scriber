import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  issueCode, checkCode, openSession, readSession, closeSession,
  sessionCookie, clearedCookie, cookieFrom, newCode,
  CODE_TTL_MS, SESSION_TTL_MS, MAX_ATTEMPTS, COOKIE,
} from '../src/web/auth.js';

// Signing in without ever holding a password.
//
// Six digits is only strong enough because of the fence around it: one live
// code per person, ten minutes, five attempts, destroyed on first success.
// Every test here is a plank of that fence, because removing any one of them
// turns six digits into a number you can guess.

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

test('the code is never stored in a readable form', async (t) => {
  const { db, cfg } = await harness(t);
  const { code } = issueCode(db, cfg, WHO);

  const row = db.getAuthCode(WHO.userId);
  assert.notEqual(row.code_hash, code);
  assert.equal(JSON.stringify(row).includes(code), false, 'not anywhere in the row');
});

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
    .prepare(`SELECT name FROM pragma_table_info('auth_codes') UNION ALL SELECT name FROM pragma_table_info('auth_sessions')`)
    .all()
    .map((r) => r.name);

  assert.equal(columns.some((c) => /pass|secret|token(?!_hash)/i.test(c)), false, columns.join(', '));
  assert.ok(columns.includes('code_hash') && columns.includes('token_hash'));
});

// A leaked database must not be usable against another install, so the hash
// has to be keyed on something per-install.
test('the same code hashes differently under a different secret', async (t) => {
  const { db } = await harness(t);
  issueCode(db, { statusToken: 'one' }, { ...WHO, code: '123456' });
  const first = db.getAuthCode(WHO.userId).code_hash;

  issueCode(db, { statusToken: 'two' }, { ...WHO, code: '123456' });
  assert.notEqual(db.getAuthCode(WHO.userId).code_hash, first);
});

test('a bot with no secret cannot sign anybody in', async (t) => {
  const { db } = await harness(t);
  assert.equal(issueCode(db, {}, WHO).ok, false);
  assert.equal(openSession(db, {}, WHO), null);
  assert.equal(readSession(db, {}, 'anything'), null);
});

// --- the fence around six digits ---

test('the right code works exactly once', async (t) => {
  const { db, cfg } = await harness(t);
  const { code } = issueCode(db, cfg, WHO);

  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code }).ok, true);
  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code }).ok, false, 'a code that works twice works twice');
});

test('five wrong tries burn the code', async (t) => {
  const { db, cfg } = await harness(t);
  const { code } = issueCode(db, cfg, WHO);

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    assert.equal(checkCode(db, cfg, { userId: WHO.userId, code: '000000' }).ok, false);
  }

  const after = checkCode(db, cfg, { userId: WHO.userId, code });
  assert.equal(after.ok, false, 'even the correct code is dead once the tries are spent');
  assert.equal(db.getAuthCode(WHO.userId), null, 'and the row is gone, not just marked');
});

test('a code expires on time', async (t) => {
  const { db, cfg } = await harness(t);
  const now = Date.now();
  const { code } = issueCode(db, cfg, { ...WHO, now });

  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code, now: now + CODE_TTL_MS - 1000 }).ok, true);

  const { code: second } = issueCode(db, cfg, { ...WHO, now });
  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code: second, now: now + CODE_TTL_MS + 1 }).ok, false);
});

// Asking again must restart the window, not add a second key to the door.
test('a new code replaces the old one rather than joining it', async (t) => {
  const { db, cfg } = await harness(t);
  const first = issueCode(db, cfg, WHO).code;
  const second = issueCode(db, cfg, WHO).code;

  assert.notEqual(first, second);
  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code: first }).ok, false, 'the old one is dead');
  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code: second }).ok, true);
});

test('a wrong attempt on one account cannot burn another', async (t) => {
  const { db, cfg } = await harness(t);
  const mine = issueCode(db, cfg, WHO).code;
  issueCode(db, cfg, { userId: '20000000000000002', username: 'brett' });

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    checkCode(db, cfg, { userId: '20000000000000002', code: '000000' });
  }
  assert.equal(checkCode(db, cfg, { userId: WHO.userId, code: mine }).ok, true);
});

test('a code for one account never verifies for another', async (t) => {
  const { db, cfg } = await harness(t);
  const { code } = issueCode(db, cfg, WHO);
  issueCode(db, cfg, { userId: '20000000000000002', username: 'brett', code });

  // Same six digits, deliberately. The hash is keyed on the user id too, so
  // they are not interchangeable.
  const row = db.getAuthCode('20000000000000002');
  assert.notEqual(row.code_hash, db.getAuthCode(WHO.userId)?.code_hash ?? null);
});

test('codes are six digits, zero-padded, and vary', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = newCode();
    assert.match(code, /^\d{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 150, 'a generator that repeats is a generator you can guess');
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

// --- the cookie ---

test('the cookie is HttpOnly and SameSite, and only Secure on https', async () => {
  const plain = sessionCookie('abc');
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.doesNotMatch(plain, /Secure/, 'Secure on a LAN http page means the browser discards it');

  assert.match(sessionCookie('abc', { secure: true }), /Secure/);
  assert.match(clearedCookie(), /Max-Age=0/);
});

test('the cookie is read back out of a real header', async () => {
  assert.equal(cookieFrom(`other=1; ${COOKIE}=deadbeef; another=2`), 'deadbeef');
  assert.equal(cookieFrom('other=1'), null);
  assert.equal(cookieFrom(undefined), null);
});

// --- housekeeping ---

test('the sweep deletes what has expired and keeps what has not', async (t) => {
  const { db, cfg } = await harness(t);
  const past = Date.now() - 60_000;
  issueCode(db, cfg, { ...WHO, now: past - CODE_TTL_MS });
  openSession(db, cfg, { userId: '20000000000000002', username: 'brett', now: past - SESSION_TTL_MS });
  const alive = openSession(db, cfg, { userId: '30000000000000003', username: 'kez' }).token;

  const swept = db.sweepAuth();
  assert.equal(swept.codes, 1);
  assert.equal(swept.sessions, 1);
  assert.ok(readSession(db, cfg, alive), 'a live session is not swept');
});
