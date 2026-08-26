import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { handleAuthRoute } from '../src/web/auth-routes.js';
import { readSession, STATE_COOKIE } from '../src/web/auth.js';

// The three requests that make up signing in, tested where they are decided.
//
// auth-flow.test.js drives these through a running server, which is the right
// place to prove the wiring. This file is about the rules themselves — which
// callbacks are answered at all, what a refusal gives away, and the one error
// from Discord that is not a refusal.

async function world(t, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-auth-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = {
    authSecret: 'a'.repeat(32),
    discordClientId: 'app-1',
    discordClientSecret: 'shh',
    dashboardUrl: 'http://pihouse.local:8095',
    ownerUserId: 'dev-1',
    ...over,
  };

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg };
}

// Discord, as far as these routes can tell.
function discordApi({ codes = {}, users = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const sent = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url, sent });
    if (url.endsWith('/oauth2/token')) {
      const token = codes[sent?.code];
      return token
        ? { ok: true, json: async () => ({ access_token: token }) }
        : { ok: false, json: async () => ({ error: 'invalid_grant' }) };
    }
    if (url.endsWith('/users/@me')) {
      const bearer = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const user = users[bearer];
      return user ? { ok: true, json: async () => user } : { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

const go = ({ db, cfg, fetchImpl, path = '/auth/discord', query = '', cookie = null, method = 'GET', body = {} }) =>
  handleAuthRoute({
    pathname: path,
    method,
    url: new URL(`http://pi${path}${query}`),
    body,
    req: { headers: cookie ? { cookie } : {} },
    db,
    cfg,
    secure: false,
    fetchImpl,
  });

// The state that went out on the URL, pulled back out of the cookie the same
// answer set — which is exactly what a browser would send back.
const cookieState = (answer) => /quill_signin=([^;]+)/.exec([answer.cookie].flat().join('; '))?.[1] ?? null;
const urlState = (answer) => new URL(answer.redirect).searchParams.get('state');
const errorIn = (answer) => /#signin-error=(.+)$/.exec(answer.redirect)?.[1] ?? null;

// --- off to Discord ---

test('starting a sign-in hands out one state, twice', async (t) => {
  const { db, cfg } = await world(t);
  const answer = await go({ db, cfg });

  assert.match(answer.redirect, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  assert.ok(urlState(answer), 'Discord is given a state to hand back');
  assert.equal(cookieState(answer), urlState(answer), 'and only this browser holds the other copy');
});

test('two visitors do not share a state', async (t) => {
  const { db, cfg } = await world(t);
  assert.notEqual(urlState(await go({ db, cfg })), urlState(await go({ db, cfg })));
});

// A button that sends somebody to Discord to be told off by a screen mentioning
// none of this bot's settings is worse than a button that does not appear.
test('an install with no OAuth credentials sends nobody to Discord', async (t) => {
  const { db, cfg } = await world(t, { discordClientSecret: null });
  const answer = await go({ db, cfg });

  assert.equal(errorIn(answer), 'config');
  assert.doesNotMatch(answer.redirect, /discord\.com/);
});

// --- back from Discord ---

test('a code and a matching state become a session', async (t) => {
  const { db, cfg } = await world(t);
  const api = discordApi({ codes: { 'code-1': 'tok-1' }, users: { 'tok-1': { id: '10000000000000001', username: 'saf' } } });

  const started = await go({ db, cfg, fetchImpl: api.fetchImpl });
  const state = cookieState(started);

  const back = await go({
    db, cfg, fetchImpl: api.fetchImpl,
    path: '/auth/callback',
    query: `?code=code-1&state=${state}`,
    cookie: `${STATE_COOKIE}=${state}`,
  });

  assert.equal(back.redirect, 'http://pihouse.local:8095/app/', 'and back to the page they left');

  const token = /quill_session=([^;]+)/.exec(back.cookie.join('; '))?.[1];
  assert.ok(token, 'holding a session');
  assert.deepEqual(
    { userId: readSession(db, cfg, token).userId, username: readSession(db, cfg, token).username },
    { userId: '10000000000000001', username: 'saf' }
  );

  // The attempt is spent either way. A state that still works once it has been
  // answered is a state that works twice.
  assert.match(back.cookie.join('; '), new RegExp(`${STATE_COOKIE}=; .*Max-Age=0`));
});

// OAuth's whole CSRF defence, and the reason it is checked first: without it
// anybody can hand somebody a link that quietly signs them into an attacker's
// account and leaves them typing into it.
test('a callback this browser did not start is not answered', async (t) => {
  const { db, cfg } = await world(t);
  const api = discordApi({ codes: { 'code-1': 'tok-1' }, users: { 'tok-1': { id: '1', username: 'saf' } } });

  const attempts = [
    { note: 'no cookie at all', query: '?code=code-1&state=abc', cookie: null },
    { note: 'a cookie for a different attempt', query: '?code=code-1&state=abc', cookie: `${STATE_COOKIE}=xyz` },
    { note: 'no state on the url', query: '?code=code-1', cookie: `${STATE_COOKIE}=abc` },
  ];

  for (const { note, query, cookie } of attempts) {
    const answer = await go({ db, cfg, fetchImpl: api.fetchImpl, path: '/auth/callback', query, cookie });
    assert.equal(errorIn(answer), 'state', note);
  }

  assert.equal(api.calls.length, 0, 'and not one request left for Discord over any of it');
});

test('somebody who says no to Discord is told that is what happened', async (t) => {
  const { db, cfg } = await world(t);
  const answer = await go({
    db, cfg,
    path: '/auth/callback',
    query: '?error=access_denied&state=abc',
    cookie: `${STATE_COOKIE}=abc`,
  });

  assert.equal(errorIn(answer), 'denied');
});

// Not a failure — it is Discord answering prompt=none honestly, and the cure
// is to ask properly.
test('a first-time visitor is sent back to be asked properly', async (t) => {
  const { db, cfg } = await world(t);
  const started = await go({ db, cfg });
  const state = cookieState(started);
  assert.equal(new URL(started.redirect).searchParams.get('prompt'), 'none');

  const again = await go({
    db, cfg,
    path: '/auth/callback',
    query: `?error=consent_required&state=${state}`,
    cookie: `${STATE_COOKIE}=${state}`,
  });

  assert.match(again.redirect, /discord\.com\/oauth2\/authorize/);
  assert.equal(new URL(again.redirect).searchParams.get('prompt'), null, 'asked properly this time');
  assert.notEqual(cookieState(again), state, 'on a fresh attempt, not the spent one');
});

// The retry has to be able to say it has already retried, or a Discord that
// keeps answering consent_required bounces the browser round for ever.
test('the retry is only ever offered once', async (t) => {
  const { db, cfg } = await world(t);
  const state = cookieState(await go({ db, cfg }));
  const retried = cookieState(await go({
    db, cfg, path: '/auth/callback', query: `?error=consent_required&state=${state}`, cookie: `${STATE_COOKIE}=${state}`,
  }));

  const third = await go({
    db, cfg, path: '/auth/callback', query: `?error=consent_required&state=${retried}`, cookie: `${STATE_COOKIE}=${retried}`,
  });

  assert.equal(errorIn(third), 'discord', 'the loop stops');
});

test('a code Discord will not honour hands out no session', async (t) => {
  const { db, cfg } = await world(t);
  const api = discordApi({ codes: {} });
  const state = cookieState(await go({ db, cfg }));

  const answer = await go({
    db, cfg, fetchImpl: api.fetchImpl,
    path: '/auth/callback', query: `?code=stale&state=${state}`, cookie: `${STATE_COOKIE}=${state}`,
  });

  assert.equal(errorIn(answer), 'discord');
  assert.doesNotMatch([answer.cookie].flat().join('; '), /quill_session=[^;]+/);
});

// A bot with no key to hash session cookies with cannot keep anybody signed in,
// and should say so rather than redirecting to a dashboard that has forgotten
// them by the time it loads.
test('a bot with no signing secret refuses at the last step', async (t) => {
  const { db, cfg } = await world(t, { authSecret: null, statusToken: null });
  const api = discordApi({ codes: { c: 'tok-1' }, users: { 'tok-1': { id: '1', username: 'saf' } } });

  const answer = await go({
    db, cfg, fetchImpl: api.fetchImpl,
    path: '/auth/callback', query: '?code=c&state=abc', cookie: `${STATE_COOKIE}=abc`,
  });

  assert.equal(errorIn(answer), 'secret');
});

// --- who is allowed in at all ---

// The list refuses BEFORE a session exists, not after. A row written and then
// reasoned about is a row that outlives the reasoning.
test('somebody Discord vouches for, who is not on the guest list, gets no session', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: '11111111111111111' });
  const api = discordApi({ codes: { c: 'tok-1' }, users: { 'tok-1': { id: '99999999999999999', username: 'stranger' } } });
  const state = cookieState(await go({ db, cfg }));

  const answer = await go({
    db, cfg, fetchImpl: api.fetchImpl,
    path: '/auth/callback', query: `?code=c&state=${state}`, cookie: `${STATE_COOKIE}=${state}`,
  });

  assert.equal(errorIn(answer), 'notinvited');
  assert.doesNotMatch([answer.cookie].flat().join('; '), /quill_session=[^;]+/);
  assert.equal(
    db.raw.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,
    0,
    'and nothing was written to show for it'
  );
});

test('somebody on the guest list is let through as normal', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: '11111111111111111' });
  const api = discordApi({ codes: { c: 'tok-1' }, users: { 'tok-1': { id: '11111111111111111', username: 'matt' } } });
  const state = cookieState(await go({ db, cfg }));

  const answer = await go({
    db, cfg, fetchImpl: api.fetchImpl,
    path: '/auth/callback', query: `?code=c&state=${state}`, cookie: `${STATE_COOKIE}=${state}`,
  });

  const token = /quill_session=([^;]+)/.exec(answer.cookie.join('; '))?.[1];
  assert.ok(token, 'no session was opened');
  assert.equal(readSession(db, cfg, token).username, 'matt');
});

// --- signing out ---

test('signing out clears the cookie and the row behind it', async (t) => {
  const { db, cfg } = await world(t);
  const api = discordApi({ codes: { c: 'tok-1' }, users: { 'tok-1': { id: '1', username: 'saf' } } });
  const state = cookieState(await go({ db, cfg }));
  const back = await go({
    db, cfg, fetchImpl: api.fetchImpl,
    path: '/auth/callback', query: `?code=c&state=${state}`, cookie: `${STATE_COOKIE}=${state}`,
  });
  const token = /quill_session=([^;]+)/.exec(back.cookie.join('; '))[1];

  const out = await go({ db, cfg, path: '/auth/logout', method: 'POST', cookie: `quill_session=${token}` });

  assert.equal(out.payload.ok, true);
  assert.match(out.cookie, /Max-Age=0/);
  assert.equal(readSession(db, cfg, token), null, 'the cookie is meaningless because the row is gone');
});

// --- what is not a route ---

test('the routes answer the method they are meant for and no other', async (t) => {
  const { db, cfg } = await world(t);

  assert.equal(await go({ db, cfg, path: '/auth/discord', method: 'POST' }), null);
  assert.equal(await go({ db, cfg, path: '/auth/logout', method: 'GET' }), null);
  assert.equal(await go({ db, cfg, path: '/auth/verify', method: 'POST' }), null, 'the old code flow is gone');
  assert.equal(await go({ db, cfg, path: '/auth/request', method: 'POST' }), null);
});
