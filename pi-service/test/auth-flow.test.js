import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';
import { COOKIE, STATE_COOKIE } from '../src/web/auth.js';

// Signing in and being scoped, over a real socket.
//
// The pieces are tested apart in auth.test.js, discord-oauth.test.js and
// viewer-scope.test.js. What only shows up here is the join: whether a browser
// following two redirects really does come back holding a session, whether the
// cookie the server sets is the cookie it later believes, and whether a
// signed-in player is actually cut off from another table's records by the
// routes rather than only by the page.

const DEV = '10000000000000001';
const CREATOR = '30000000000000003';
const PLAYER = '40000000000000004';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Discord's OAuth API, as far as the server can tell. A code is redeemed for a
// token, a token is spent on one identity, and both are recorded so a test can
// ask what actually left the machine.
function fakeDiscord() {
  const calls = [];
  const people = {
    'code-saf': { id: PLAYER, username: 'saf' },
    // Whoever runs Cipher. On the campaign as its manager, and never once
    // recorded saying anything -- a DM who set the table up from the
    // dashboard has no utterances to their name.
    'code-dm': { id: CREATOR, username: 'dm' },
  };

  const fetchImpl = async (url, init = {}) => {
    const sent = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url, sent });

    if (url.endsWith('/oauth2/token')) {
      const who = people[sent?.code];
      return who
        ? { ok: true, json: async () => ({ access_token: `tok:${sent.code}` }) }
        : { ok: false, json: async () => ({ error: 'invalid_grant' }) };
    }
    if (url.endsWith('/users/@me')) {
      const code = String(init.headers?.Authorization ?? '').replace(/^Bearer tok:/, '');
      return people[code]
        ? { ok: true, json: async () => people[code] }
        : { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };

  // The bot's own Discord, which sign-in no longer touches at all.
  const bridge = {
    findPeople: async () => ({ ok: true, people: [] }),
    invite: async () => ({ ok: true, message: 'sent' }),
  };

  return { calls, fetchImpl, bridge };
}

async function serving(t, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-authflow-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const mine = db.createCampaign('guild-1', 'Cipher', CREATOR);
  const theirs = db.createCampaign('guild-2', 'Somewhere Else', 'someone-else');

  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId: mine, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
  ]);
  db.endMeeting(meeting, '2026-08-01T22:00:00Z');
  db.setSummary(meeting, { tldr: 'They talked their way in.', scenes: [] });
  db.setMeetingStatus(meeting, 'done');

  const secret = db.createMeeting({
    guildId: 'guild-2', campaignId: theirs, channelId: 'v', channelName: 'Elsewhere',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(secret, [
    { userId: 'stranger', displayName: 'nobody', startMs: 0, endMs: 1, text: 'private.' },
  ]);
  db.setSummary(secret, { tldr: 'Something else entirely.', scenes: [] });

  const cfg = {
    statusHost: '127.0.0.1',
    statusPort: await freePort(),
    statusToken: 'sesame',
    ownerUserId: DEV,
    discordClientId: 'app-1',
    discordClientSecret: 'shh',
    dashboardUrl: 'http://dash.test',
    dashboardRequireLogin: true,
    scheduleTimeZone: 'Australia/Brisbane',
    transcribeWindowStartHour: 8,
    transcribeWindowEndHour: 16,
    transcribeWeekdaysOnly: true,
    transcribeRequireApproval: true,
    summaryProvider: 'gemini',
    geminiApiKey: 'k',
    geminiModel: 'g',
    ...over,
  };

  const discord = fakeDiscord();
  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(), discord: discord.bridge, fetchImpl: discord.fetchImpl,
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, base, discord, mine, theirs, meeting, secret };
}

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})), res });

const call = (base, path, { cookie, method = 'GET', body, redirect } = {}) =>
  fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=sesame`, {
    method,
    redirect,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const cookieIn = (res, name) =>
  res.headers.getSetCookie().map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean) ?? null;

// Walk the whole thing the way a browser does: follow the link, come back from
// Discord carrying what Discord would have carried, end up with a session.
//
// `redirect: 'manual'` throughout, because the interesting part of every step
// here is the 302 itself — where it points and what it sets — and fetch would
// otherwise swallow all of it and try to reach discord.com.
async function signIn(base, who = 'saf') {
  const started = await call(base, '/auth/discord', { redirect: 'manual' });
  assert.equal(started.status, 302);

  const state = cookieIn(started, STATE_COOKIE);
  const onUrl = new URL(started.headers.get('location')).searchParams.get('state');
  assert.equal(state, onUrl, 'the state goes out twice and matches');

  const back = await call(base, `/auth/callback?code=code-${who}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    cookie: `${STATE_COOKIE}=${state}`,
  });
  assert.equal(back.status, 302, 'and back to the dashboard');

  const token = cookieIn(back, COOKIE);
  assert.ok(token, 'holding a session');
  return `${COOKIE}=${token}`;
}

// --- the flow ---

test('a Discord account, two redirects, a session', async (t) => {
  const { base } = await serving(t);

  const before = await json(await call(base, '/me'));
  assert.equal(before.body.signedIn, false);
  assert.equal(before.body.level, 'none');

  const cookie = await signIn(base);

  const after = await json(await call(base, '/me', { cookie }));
  assert.equal(after.body.signedIn, true);
  assert.equal(after.body.username, 'saf');
  assert.equal(after.body.level, 'player');
});

// The browser is handed a session cookie and nothing else. The OAuth token is
// spent inside the process on one question and revoked; a copy of it reaching
// the page would be a live Discord credential sitting in somebody's browser.
test('no Discord token ever reaches the browser', async (t) => {
  const { base, discord } = await serving(t);
  const cookie = await signIn(base);

  const issued = discord.calls.find((c) => c.url.endsWith('/oauth2/token'));
  assert.ok(issued, 'a token was issued');
  assert.equal(cookie.includes('tok:'), false);

  const me = await json(await call(base, '/me', { cookie }));
  assert.equal(JSON.stringify(me.body).includes('tok:'), false);
  assert.ok(discord.calls.some((c) => c.url.endsWith('/oauth2/token/revoke')), 'and it was handed back');
});

// The state check is what stops a link from anywhere else signing somebody into
// an account they did not choose.
test('a callback nobody here started hands out no cookie', async (t) => {
  const { base, discord } = await serving(t);

  const res = await call(base, '/auth/callback?code=code-saf&state=made-up', { redirect: 'manual' });

  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /#signin-error=state$/);
  assert.equal(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`) && !c.includes('Max-Age=0')), false);
  assert.equal(discord.calls.length, 0, 'and not one request left for Discord over it');
});

test('signing out makes the cookie stop working', async (t) => {
  const { base } = await serving(t);
  const cookie = await signIn(base);

  assert.equal((await json(await call(base, '/me', { cookie }))).body.signedIn, true);
  await call(base, '/auth/logout', { method: 'POST', cookie, body: {} });
  assert.equal((await json(await call(base, '/me', { cookie }))).body.signedIn, false);
});

// --- what a signed-in player can reach ---

test('a player sees their own campaign and not another', async (t) => {
  const { base, mine, theirs } = await serving(t);
  const cookie = await signIn(base);

  assert.equal((await call(base, `/campaign?id=${mine}`, { cookie })).status, 200);
  assert.equal((await call(base, `/campaign?id=${theirs}`, { cookie })).status, 404,
    '404 rather than 403 — a refusal would confirm it exists');
});

test('a player cannot read another table\'s notes by guessing a session id', async (t) => {
  const { base, meeting, secret } = await serving(t);
  const cookie = await signIn(base);

  assert.equal((await call(base, `/notes?meeting=${meeting}`, { cookie })).status, 200);
  assert.equal((await call(base, `/notes?meeting=${secret}`, { cookie })).status, 404);
});

// Notes, not the verbatim record. Being at the table is not the same as being
// handed every word five people said.
test('a player gets the notes but not the transcript', async (t) => {
  const { base, meeting } = await serving(t);
  const cookie = await signIn(base);

  assert.equal((await call(base, `/notes?meeting=${meeting}`, { cookie })).status, 200);
  assert.equal((await call(base, `/transcript?meeting=${meeting}`, { cookie })).status, 403);
  assert.equal((await call(base, `/transcript?meeting=${meeting}&format=json`, { cookie })).status, 403);
});

test('a player is told nothing about models or the queue', async (t) => {
  const { base } = await serving(t);
  const cookie = await signIn(base);

  const status = await json(await call(base, '/status', { cookie }));
  const body = JSON.stringify(status.body);

  assert.doesNotMatch(body, /gemini|whisper|anthropic/i);
  assert.equal(status.body.queue, undefined);
  assert.equal(status.body.schedule, undefined);
});

test('a player cannot fire a machinery action', async (t) => {
  const { base, db } = await serving(t);
  const cookie = await signIn(base);

  const paused = await json(await call(base, '/actions/pause', {
    method: 'POST', cookie, body: { queue: 'summarize', paused: true },
  }));

  assert.equal(paused.status, 403);
  assert.equal(db.getSetting('summarize_paused'), null, 'and nothing moved');
});

test('a player cannot manage a campaign they merely play in', async (t) => {
  const { base, db, mine } = await serving(t);
  const cookie = await signIn(base);

  const res = await json(await call(base, '/actions/corrections/add', {
    method: 'POST', cookie, body: { campaignId: mine, wrong: 'Vecks', right: 'Vex' },
  }));

  assert.equal(res.status, 403);
  assert.deepEqual(db.listCorrections(mine), []);
});

// --- the operator's own console ---

// The escape hatch, and the reason DASHBOARD_REQUIRE_LOGIN defaults off:
// locking the operator out of their own Pi over a Discord outage would be a
// worse failure than any it prevents.
test('with login not required the token is still the operator console', async (t) => {
  const { base } = await serving(t, { dashboardRequireLogin: false });
  const me = await json(await call(base, '/me'));

  assert.equal(me.body.level, 'dev');
  assert.equal(me.body.can.machinery, true);
  assert.equal((await call(base, '/status')).status, 200);
});

test('with login required the token alone is nobody', async (t) => {
  const { base, theirs } = await serving(t);
  const me = await json(await call(base, '/me'));

  assert.equal(me.body.level, 'none');
  assert.equal((await call(base, `/campaign?id=${theirs}`)).status, 404);
});

// A stranger with neither must not get past the door at all.
test('no token is still no entry', async (t) => {
  const { base } = await serving(t);
  const res = await fetch(`${base}/status`);
  assert.equal(res.status, 401);
});

// The proxy adds the token to every request, so a browser on the dashboard has
// it either way. Without the check, a bot on an exposed port could be walked
// through a sign-in by a stranger.
test('signing in still goes through the door', async (t) => {
  const { base } = await serving(t);

  const res = await fetch(`${base}/auth/discord`, { redirect: 'manual' });

  assert.equal(res.status, 401);
  assert.equal(res.headers.getSetCookie().length, 0, 'and nothing was started');
});

// /campaign setchar has always let a player name their own character, and it
// is obviously theirs to name. The dashboard being stricter than the slash
// command for the same act was an accident, not a decision.
test('a player may set their own character name but nobody else\'s', async (t) => {
  const { base, db, mine } = await serving(t);
  const cookie = await signIn(base);

  const own = await json(await call(base, '/actions/roster/character', {
    method: 'POST', cookie, body: { campaignId: mine, userId: PLAYER, name: 'Safriel' },
  }));
  assert.equal(own.status, 200, own.body.message);
  assert.equal(db.getCharacterName(mine, PLAYER), 'Safriel');

  const theirs = await json(await call(base, '/actions/roster/character', {
    method: 'POST', cookie, body: { campaignId: mine, userId: CREATOR, name: 'Not Yours' },
  }));
  assert.equal(theirs.status, 403);
  assert.equal(db.getCharacterName(mine, CREATOR), null);
});

test('a player cannot name themselves at a table they do not play at', async (t) => {
  const { base, db, theirs } = await serving(t);
  const cookie = await signIn(base);

  const res = await json(await call(base, '/actions/roster/character', {
    method: 'POST', cookie, body: { campaignId: theirs, userId: PLAYER, name: 'Gatecrasher' },
  }));

  assert.equal(res.status, 403);
  assert.equal(db.getCharacterName(theirs, PLAYER), null);
});

// The person who runs the table, who the bot has never heard say a word.
//
// The old flow had to FIND them before it could DM them, which meant a
// membership lookup that only worked for somebody already recorded speaking --
// so a DM who set their campaign up from the dashboard could not sign in to it.
// There is nothing to find any more: Discord says who they are, and what they
// run is worked out from the campaigns table afterwards.
test('a DM who has never been recorded can sign in to the campaign they run', async (t) => {
  const { base, mine } = await serving(t);

  const cookie = await signIn(base, 'dm');

  const me = await json(await call(base, '/me', { cookie }));
  assert.equal(me.body.signedIn, true);
  assert.equal(me.body.level, 'creator', 'and is recognised as running a table, not as a stranger');

  // Not merely a cookie: the campaign they manage is actually there.
  const status = await json(await call(base, '/status', { cookie }));
  assert.deepEqual(
    status.body.campaigns.map((c) => c.id),
    [mine],
    'their own campaign, and only theirs'
  );
});
