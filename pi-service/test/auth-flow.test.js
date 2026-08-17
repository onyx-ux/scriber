import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';
import { COOKIE } from '../src/web/auth.js';

// Signing in and being scoped, over a real socket.
//
// The pieces are tested apart in auth.test.js and viewer-scope.test.js. What
// only shows up here is the join: whether the cookie the server sets is the
// cookie it later believes, and whether a signed-in player is actually cut off
// from another table's records by the routes rather than only by the page.

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

// A stand-in for Discord that hands the code straight back instead of DMing
// it, so the test can read what a real person would read off their phone.
function fakeDiscord() {
  const sent = [];
  return {
    sent,
    bridge: {
      findKnownMember: async ({ query }) =>
        query.toLowerCase() === 'saf' ? { userId: PLAYER, username: 'saf' } : null,
      sendCode: async ({ userId, code }) => {
        sent.push({ userId, code });
        return { ok: true };
      },
      findPeople: async () => ({ ok: true, people: [] }),
      invite: async () => ({ ok: true, message: 'sent' }),
    },
  };
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
    db, cfg, activeSessions: new Map(), discord: discord.bridge,
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

const call = (base, path, { cookie, method = 'GET', body } = {}) =>
  fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=sesame`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Walk the whole thing: name in, code out of the fake DM, code back, cookie.
async function signIn(base, discord, name = 'saf') {
  const asked = await json(await call(base, '/auth/request', { method: 'POST', body: { name } }));
  assert.equal(asked.body.ok, true, asked.body.message);

  const { code } = discord.sent.at(-1);
  const verified = await json(await call(base, '/auth/verify', { method: 'POST', body: { name, code } }));
  assert.equal(verified.body.ok, true, verified.body.message);

  const setCookie = verified.res.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`${COOKIE}=`));
  return setCookie.split(';')[0];
}

// --- the flow ---

test('a name, a code, a session', async (t) => {
  const { base, discord } = await serving(t);

  const before = await json(await call(base, '/me'));
  assert.equal(before.body.signedIn, false);
  assert.equal(before.body.level, 'none');

  const cookie = await signIn(base, discord);

  const after = await json(await call(base, '/me', { cookie }));
  assert.equal(after.body.signedIn, true);
  assert.equal(after.body.username, 'saf');
  assert.equal(after.body.level, 'player');
});

test('the code is never in any response body', async (t) => {
  const { base, discord } = await serving(t);
  const res = await json(await call(base, '/auth/request', { method: 'POST', body: { name: 'saf' } }));

  const { code } = discord.sent.at(-1);
  assert.equal(JSON.stringify(res.body).includes(code), false);
});

// The answer must be the same whether or not the account exists, or this is a
// way to find out who plays on somebody's bot.
test('an unknown name gets the same answer as a known one', async (t) => {
  const { base } = await serving(t);
  const known = await json(await call(base, '/auth/request', { method: 'POST', body: { name: 'saf' } }));
  const unknown = await json(await call(base, '/auth/request', { method: 'POST', body: { name: 'nobody-at-all' } }));

  assert.equal(known.body.message, unknown.body.message);
  assert.equal(known.body.ok, unknown.body.ok);
});

test('a wrong code does not sign anybody in', async (t) => {
  const { base, discord } = await serving(t);
  await call(base, '/auth/request', { method: 'POST', body: { name: 'saf' } });

  const bad = await json(await call(base, '/auth/verify', { method: 'POST', body: { name: 'saf', code: '000000' } }));
  assert.equal(bad.status, 401);
  assert.equal(bad.res.headers.get('set-cookie'), null, 'and no cookie is handed out');
});

test('signing out makes the cookie stop working', async (t) => {
  const { base, discord } = await serving(t);
  const cookie = await signIn(base, discord);

  assert.equal((await json(await call(base, '/me', { cookie }))).body.signedIn, true);
  await call(base, '/auth/logout', { method: 'POST', cookie, body: {} });
  assert.equal((await json(await call(base, '/me', { cookie }))).body.signedIn, false);
});

// --- what a signed-in player can reach ---

test('a player sees their own campaign and not another', async (t) => {
  const { base, discord, mine, theirs } = await serving(t);
  const cookie = await signIn(base, discord);

  assert.equal((await call(base, `/campaign?id=${mine}`, { cookie })).status, 200);
  assert.equal((await call(base, `/campaign?id=${theirs}`, { cookie })).status, 404,
    '404 rather than 403 — a refusal would confirm it exists');
});

test('a player cannot read another table\'s notes by guessing a session id', async (t) => {
  const { base, discord, meeting, secret } = await serving(t);
  const cookie = await signIn(base, discord);

  assert.equal((await call(base, `/notes?meeting=${meeting}`, { cookie })).status, 200);
  assert.equal((await call(base, `/notes?meeting=${secret}`, { cookie })).status, 404);
});

// Notes, not the verbatim record. Being at the table is not the same as being
// handed every word five people said.
test('a player gets the notes but not the transcript', async (t) => {
  const { base, discord, meeting } = await serving(t);
  const cookie = await signIn(base, discord);

  assert.equal((await call(base, `/notes?meeting=${meeting}`, { cookie })).status, 200);
  assert.equal((await call(base, `/transcript?meeting=${meeting}`, { cookie })).status, 403);
  assert.equal((await call(base, `/transcript?meeting=${meeting}&format=json`, { cookie })).status, 403);
});

test('a player is told nothing about models or the queue', async (t) => {
  const { base, discord } = await serving(t);
  const cookie = await signIn(base, discord);

  const status = await json(await call(base, '/status', { cookie }));
  const body = JSON.stringify(status.body);

  assert.doesNotMatch(body, /gemini|whisper|anthropic/i);
  assert.equal(status.body.queue, undefined);
  assert.equal(status.body.schedule, undefined);
});

test('a player cannot fire a machinery action', async (t) => {
  const { base, discord, db } = await serving(t);
  const cookie = await signIn(base, discord);

  const paused = await json(await call(base, '/actions/pause', {
    method: 'POST', cookie, body: { queue: 'summarize', paused: true },
  }));

  assert.equal(paused.status, 403);
  assert.equal(db.getSetting('summarize_paused'), null, 'and nothing moved');
});

test('a player cannot manage a campaign they merely play in', async (t) => {
  const { base, discord, db, mine } = await serving(t);
  const cookie = await signIn(base, discord);

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
// it either way. Without the check a bot on an exposed port could be told
// "DM this person a code" by a stranger.
test('signing in still goes through the door', async (t) => {
  const { base, discord } = await serving(t);

  const res = await fetch(`${base}/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'saf' }),
  });

  assert.equal(res.status, 401);
  assert.equal(discord.sent.length, 0, 'and no DM was sent');
});

// /campaign setchar has always let a player name their own character, and it
// is obviously theirs to name. The dashboard being stricter than the slash
// command for the same act was an accident, not a decision.
test('a player may set their own character name but nobody else\'s', async (t) => {
  const { base, discord, db, mine } = await serving(t);
  const cookie = await signIn(base, discord);

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
  const { base, discord, db, theirs } = await serving(t);
  const cookie = await signIn(base, discord);

  const res = await json(await call(base, '/actions/roster/character', {
    method: 'POST', cookie, body: { campaignId: theirs, userId: PLAYER, name: 'Gatecrasher' },
  }));

  assert.equal(res.status, 403);
  assert.equal(db.getCharacterName(theirs, PLAYER), null);
});
