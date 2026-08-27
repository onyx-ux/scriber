import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';
import { ACTIONS } from '../src/web/actions.js';

// What a request with no Discord session gets.
//
// This is the security boundary of the whole dashboard, and it used not to be
// one. Before DASHBOARD_REQUIRE_LOGIN was turned on, anything that reached the
// API past nginx WAS the operator: `curl /api/status` with no cookie returned
// the full snapshot, and POST /api/actions/pause worked. The OAuth flow was a
// convenience sitting next to the door rather than the lock on it, and the
// only real perimeter was one shared basic-auth password.
//
// The config is now right on the install this ships to. That is not the same
// as it being guaranteed, which is what this file is for: the toggle is one
// line in a .env, the capability table is one object in viewer.js, and either
// could be loosened by somebody who did not know this was the thing holding
// the door. Every assertion here fails loudly if it is.
//
// Driven over a real socket rather than against the modules, because the claim
// being tested is about what answers an HTTP request — a module that returns
// the right object is no use if a route reaches around it.

const OWNER = '20000000000000002';
const PLAYER = '40000000000000004';

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function world(t, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-nosession-'));
  const db = openDb(join(dir, 'db.sqlite'));

  // Something worth stealing, so "sees nothing" is a real answer rather than
  // an empty database answering itself.
  const campaignId = db.createCampaign('guild-1', 'Cipher', OWNER);
  db.setConsent(campaignId, PLAYER, true);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'The ledger is in the vault.' },
  ]);
  db.endMeeting(meeting, '2026-08-01T22:00:00Z');
  db.setMeetingStatus(meeting, 'done');

  const cfg = {
    statusHost: '127.0.0.1', statusPort: await freePort(), statusToken: 'sesame',
    authSecret: 'a'.repeat(32), ownerUserId: OWNER,
    dashboardRequireLogin: true,
    scheduleTimeZone: 'Europe/London', summaryProvider: 'gemini', geminiApiKey: 'k',
    whisperServerUrl: `http://127.0.0.1:${await freePort()}/`,
    ...over,
  };

  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(),
    client: { user: { tag: 'Quill#0233' },
      guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'The Cellar', ownerId: OWNER }]]) } },
    discord: { findKnownMember: async () => null, sendCode: async () => ({ ok: true }),
      findPeople: async () => ({ ok: true, people: [] }), invite: async () => ({ ok: true }) },
  });
  await new Promise((r) => server.once('listening', r));

  t.after(async () => { await close(); db.close(); await rm(dir, { recursive: true, force: true }); });

  // The token is what nginx adds on the way through, so every request here
  // carries it. That is the whole point: holding the token must not be the
  // same as being somebody.
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=sesame`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const post = async (action, body = {}) => {
    const res = await fetch(`${base}/actions/${action}?token=sesame`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return { db, cfg, campaignId, meeting, get, post };
}

// ---------------------------------------------------------------------------
// Who the server thinks a cookieless request is
// ---------------------------------------------------------------------------

test('a request with no session is nobody, holding the token or not', async (t) => {
  const { get } = await world(t);
  const me = await get('/me');

  assert.equal(me.status, 200);
  assert.equal(me.body.signedIn, false);
  assert.equal(me.body.userId, null);
  assert.equal(me.body.level, 'none');
});

test('and every capability is false — not most of them', async (t) => {
  const { get } = await world(t);
  const { can } = (await get('/me')).body;

  const granted = Object.entries(can).filter(([, yes]) => yes).map(([name]) => name);
  assert.deepEqual(granted, [], `a cookieless request was granted: ${granted.join(', ')}`);
  // Named explicitly as well, so adding a capability that defaults to true is
  // caught here rather than in whatever it unlocks.
  for (const name of ['machinery', 'approvals', 'models', 'servers', 'metrics',
                      'manage', 'transcripts', 'everything']) {
    assert.equal(can[name], false, name);
  }
});

// ---------------------------------------------------------------------------
// What it can see
// ---------------------------------------------------------------------------

test('the status snapshot has nothing of anybody\'s in it', async (t) => {
  const { get } = await world(t);
  const s = (await get('/status')).body;

  assert.deepEqual(s.campaigns, [], 'a cookieless request was handed the campaign list');
  assert.deepEqual(s.recording, [], 'a cookieless request was told what is being recorded');
  assert.equal(s.viewer.level, 'none');
  // The roster left /status when the gatehouse was built. It must not come back.
  assert.equal('access' in s, false, 'the roster is in /status again');
});

test('a transcript is not readable by asking for it directly', async (t) => {
  const { get, meeting, campaignId } = await world(t);

  for (const path of [`/transcript?meeting=${meeting}`, `/campaign?id=${campaignId}`,
                      `/notes?meeting=${meeting}`]) {
    const res = await get(path);
    assert.ok(res.status >= 400, `${path} answered ${res.status}`);
    assert.ok(
      !JSON.stringify(res.body ?? '').includes('ledger is in the vault'),
      `${path} leaked the transcript`
    );
  }
});

test('the gatehouse roster is refused outright', async (t) => {
  const { get } = await world(t);
  const res = await get('/access');

  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
});

// ---------------------------------------------------------------------------
// What it can do
// ---------------------------------------------------------------------------

// Enumerated from ACTIONS rather than typed out, so an action added next year
// is covered on the day it is written rather than the day somebody remembers
// this file exists.
test('EVERY action is refused, including ones invented after this was written', async (t) => {
  const { post } = await world(t);

  const names = Object.keys(ACTIONS);
  assert.ok(names.length >= 15, 'the action list looks empty — this test would prove nothing');

  const allowed = [];
  for (const name of names) {
    const res = await post(name, {});
    if (res.status !== 403) allowed.push(`${name} -> ${res.status}`);
  }

  assert.deepEqual(allowed, [], `a cookieless request reached: ${allowed.join(', ')}`);
});

test('the refusal does not depend on the body being empty', async (t) => {
  const { post, campaignId } = await world(t);

  // A well-formed request for a real thing, which is what an attacker sends.
  for (const [name, body] of [
    ['pause', { paused: true }],
    ['campaign/delete', { campaignId }],
    ['access/invite', { userId: PLAYER, username: 'saf' }],
    ['access/tier', { userId: PLAYER, tier: 9 }],
    ['summary/approve-all', {}],
  ]) {
    const res = await post(name, body);
    assert.equal(res.status, 403, `${name} was reachable with a real body`);
  }
});

// ---------------------------------------------------------------------------
// The toggle itself
// ---------------------------------------------------------------------------

// The counterpart, stated out loud rather than left implied. With the toggle
// OFF the old behaviour is back and anything past nginx is the operator. That
// is the documented default for a LAN install and it is also exactly the hole
// this file exists to keep shut, so it is asserted here where the two sit
// together: turning it off is a decision, never an accident.
test('with the toggle off, a cookieless request IS the operator', async (t) => {
  const { get, post } = await world(t, { dashboardRequireLogin: false });

  const me = (await get('/me')).body;
  assert.equal(me.level, 'dev', 'the documented off behaviour changed — check whether that was meant');
  assert.equal(me.can.everything, true);

  const res = await post('pause', { paused: true });
  assert.notEqual(res.status, 403, 'the off behaviour changed');
});

test('turning it on is the whole of the difference', async (t) => {
  const off = await world(t, { dashboardRequireLogin: false });
  const on = await world(t);

  assert.equal((await off.get('/me')).body.level, 'dev');
  assert.equal((await on.get('/me')).body.level, 'none');

  assert.notEqual((await off.get('/status')).body.campaigns.length, 0);
  assert.equal((await on.get('/status')).body.campaigns.length, 0);
});
