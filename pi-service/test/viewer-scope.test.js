import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildViewer, OPERATOR, maySee, mayManage, atLeast } from '../src/web/viewer.js';
import { scopeStatus, scopeCampaign } from '../src/web/scope.js';
import { buildStatus } from '../src/web/status.js';
import { buildCampaignView } from '../src/web/campaign-view.js';

// Who sees what.
//
// Two halves, and the second is the one that matters: deciding a level is easy,
// and every test below the divider is about the payload actually being cut
// before it leaves the Pi. Hiding a button is a courtesy to whoever is looking
// at the screen; not sending the data is what survives somebody opening the
// network tab.

const DEV = '10000000000000001';
const OWNER = '20000000000000002';
const CREATOR = '30000000000000003';
const PLAYER = '40000000000000004';
const STRANGER = '50000000000000005';

const cfg = {
  ownerUserId: DEV,
  summaryProvider: 'gemini',
  scheduleTimeZone: 'Europe/London',
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeRequireApproval: true,
  whisperServerUrl: 'http://192.168.1.24:9001/',
  statusToken: 'secret',
};

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-viewer-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Two servers. OWNER owns guild-1. CREATOR runs a campaign in guild-2.
  const cipher = db.createCampaign('guild-1', 'Cipher', CREATOR);
  const strahd = db.createCampaign('guild-2', 'Strahd', CREATOR);
  const other = db.createCampaign('guild-3', 'Someone Else', STRANGER);

  play(db, cipher, 'guild-1', [
    { userId: PLAYER, displayName: 'Saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
    { userId: CREATOR, displayName: 'Kez', startMs: 2, endMs: 3, text: 'The clerk looks up.' },
  ]);
  play(db, other, 'guild-3', [{ userId: STRANGER, displayName: 'Nobody', startMs: 0, endMs: 1, text: 'hi' }]);

  db.addCorrection(cipher, 'Kaylen', 'Kaelen');
  db.setConsent(cipher, PLAYER, true);
  db.setConsent(cipher, CREATOR, true);

  return { db, cipher, strahd, other };
}

function play(db, campaignId, guildId, rows) {
  const id = db.createMeeting({
    guildId, campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(id, rows);
  db.endMeeting(id, '2026-08-01T22:00:00Z');
  db.setSummary(id, { tldr: 'They talked their way in.', scenes: [] });
  db.setMeetingStatus(id, 'done');
  return id;
}

const viewerFor = (db, userId, guildsOwned = []) => buildViewer({ db, cfg, userId, guildsOwned });

// --- which level ---

test('the bot owner is dev, and nothing else needs configuring', async (t) => {
  const { db } = await world(t);
  const v = viewerFor(db, DEV);

  assert.equal(v.level, 'dev');
  assert.equal(v.can.everything, true);
  assert.equal(v.can.models, true);
});

test('owning a Discord the bot is in makes you owner of it', async (t) => {
  const { db } = await world(t);
  assert.equal(viewerFor(db, OWNER, ['guild-1']).level, 'owner');
  assert.equal(viewerFor(db, OWNER, []).level, 'none', 'owning nothing here is not a level');
});

test('making a campaign makes you its creator, wherever it lives', async (t) => {
  const { db, cipher, strahd } = await world(t);
  const v = viewerFor(db, CREATOR);

  assert.equal(v.level, 'creator');
  assert.deepEqual(v.manageableCampaignIds.sort(), [cipher, strahd].sort(),
    'both servers, because a campaign is theirs wherever it is');
});

test('having spoken at a table makes you a player there and nowhere else', async (t) => {
  const { db, cipher, other } = await world(t);
  const v = viewerFor(db, PLAYER);

  assert.equal(v.level, 'player');
  assert.deepEqual(v.campaignIds, [cipher]);
  assert.deepEqual(v.manageableCampaignIds, [], 'playing at a table is not running it');
  assert.equal(maySee(v, other), false);
});

test('somebody with no connection to the bot is nobody', async (t) => {
  const { db, cipher } = await world(t);
  const v = viewerFor(db, '99999999999999999');

  assert.equal(v.level, 'none');
  assert.equal(maySee(v, cipher), false);
  assert.equal(v.can.manage, false);
});

// The levels are ordered but the SCOPE is a union — someone who owns a server
// and plays elsewhere sees both, because both are true about them.
test('scope is a union, not a ladder', async (t) => {
  const { db, cipher, other } = await world(t);
  // OWNER owns guild-1 (Cipher lives there) and has also played in `other`.
  play(db, other, 'guild-3', [{ userId: OWNER, displayName: 'Owner', startMs: 0, endMs: 1, text: 'visiting' }]);

  const v = viewerFor(db, OWNER, ['guild-1']);
  assert.equal(v.level, 'owner');
  assert.ok(maySee(v, cipher));
  assert.ok(maySee(v, other), 'a table they play at elsewhere is still theirs to read');
  assert.equal(mayManage(v, other), false, 'but not to run');
});

test('atLeast orders the levels the way the brief does', () => {
  assert.ok(atLeast({ level: 'dev' }, 'owner'));
  assert.ok(atLeast({ level: 'owner' }, 'player'));
  assert.equal(atLeast({ level: 'player' }, 'creator'), false);
  assert.equal(atLeast({ level: 'none' }, 'player'), false);
  assert.equal(atLeast(null, 'player'), false);
});

// ==========================================================================
// What actually leaves the Pi
// ==========================================================================

const snapshot = (db) => buildStatus({ db, cfg, client: null, activeSessions: new Map() });

test('the operator console is unfiltered, exactly as before sign-in existed', async (t) => {
  const { db } = await world(t);
  const full = snapshot(db);
  assert.equal(scopeStatus(full, OPERATOR), full, 'same object — nothing is cut');
});

// The user's rule, verbatim: no model names below dev.
test('no level below dev is told which model wrote anything', async (t) => {
  const { db } = await world(t);
  const full = snapshot(db);

  for (const [who, guilds] of [[OWNER, ['guild-1']], [CREATOR, []], [PLAYER, []]]) {
    const scoped = scopeStatus(full, viewerFor(db, who, guilds));
    const json = JSON.stringify(scoped);

    assert.doesNotMatch(json, /gemini|anthropic|claude|whisper/i, `${who} was told about a model`);
    assert.equal(scoped.health.summariserName, undefined);
    assert.equal(scoped.providers, undefined);
    assert.equal(scoped.schedule, undefined, 'nor when the GPU is allowed to run');
  }
});

test('the whisper server address never leaves the operator console', async (t) => {
  const { db } = await world(t);
  const json = JSON.stringify(scopeStatus(snapshot(db), viewerFor(db, OWNER, ['guild-1'])));
  assert.doesNotMatch(json, /192\.168\.1\.24|9001/);
});

test('below dev nobody is shown the queue or the pause switches', async (t) => {
  const { db } = await world(t);
  const scoped = scopeStatus(snapshot(db), viewerFor(db, CREATOR));

  assert.equal(scoped.queue, undefined);
  assert.equal(scoped.working, undefined);
  assert.equal(scoped.can?.machinery ?? scoped.viewer.can.machinery, false);
});

// A player is still entitled to know the bot is broken — that is why last
// night has not appeared — without being told which part.
test('a player is told whether it is working, not what it is made of', async (t) => {
  const { db } = await world(t);
  const scoped = scopeStatus(snapshot(db), viewerFor(db, PLAYER));

  assert.equal(typeof scoped.health.working, 'boolean');
  assert.equal(scoped.health.whisperServer, undefined);
  assert.equal(scoped.health.summariserName, undefined);
});

test('a player only ever sees campaigns they played in', async (t) => {
  const { db, cipher } = await world(t);
  const scoped = scopeStatus(snapshot(db), viewerFor(db, PLAYER));

  assert.deepEqual(scoped.campaigns.map((c) => c.id), [cipher]);
});

test('a campaign creator gets their campaigns and no metrics', async (t) => {
  const { db, cipher, strahd } = await world(t);
  const scoped = scopeStatus(snapshot(db), viewerFor(db, CREATOR));

  assert.deepEqual(scoped.campaigns.map((c) => c.id).sort(), [cipher, strahd].sort());
  assert.equal(scoped.totals, undefined, 'they asked for their campaign, not a dashboard of numbers');
  assert.equal(scoped.campaigns[0].hours, 0);
  assert.equal(scoped.servers, undefined);
});

test('a server owner gets their server and its numbers', async (t) => {
  const { db, cipher } = await world(t);
  const scoped = scopeStatus(snapshot(db), viewerFor(db, OWNER, ['guild-1']));

  assert.deepEqual(scoped.campaigns.map((c) => c.id), [cipher]);
  assert.ok(scoped.totals, 'server stats are the point of this level');
  assert.ok(scoped.campaigns[0].hours >= 0);
});

// A decision badge on a card you cannot act on is a nag, not information.
test('the approvals badge is zero for anyone who cannot approve', async (t) => {
  const { db, cipher } = await world(t);
  const full = snapshot(db);
  full.campaigns.find((c) => c.id === cipher).awaiting = 3;

  assert.equal(scopeStatus(full, viewerFor(db, CREATOR)).campaigns[0].awaiting, 0);
  assert.equal(scopeStatus(full, OPERATOR).campaigns.find((c) => c.id === cipher).awaiting, 3);
});

// --- one campaign in full ---

test('a player is not shown the rest of the table\'s consent states', async (t) => {
  const { db, cipher } = await world(t);
  const view = buildCampaignView({ db, campaignId: cipher });
  const scoped = scopeCampaign(view, viewerFor(db, PLAYER));

  const me = scoped.roster.find((p) => p.userId === PLAYER);
  const them = scoped.roster.find((p) => p.displayName === 'Kez');

  assert.equal(me.consent.state, 'granted', 'their own answer is theirs to see');
  assert.equal(them.consent.state, 'hidden');
  assert.equal(them.userId, null, "and somebody else's Discord id is not theirs at all");
});

test('a player gets no corrections list and cannot manage', async (t) => {
  const { db, cipher } = await world(t);
  const scoped = scopeCampaign(buildCampaignView({ db, campaignId: cipher }), viewerFor(db, PLAYER));

  assert.deepEqual(scoped.corrections, []);
  assert.equal(scoped.viewerCan.manage, false);
  assert.equal(scoped.viewerCan.transcripts, false, 'notes, not the verbatim record');
});

test('the campaign creator gets the roster and the corrections', async (t) => {
  const { db, cipher } = await world(t);
  const scoped = scopeCampaign(buildCampaignView({ db, campaignId: cipher }), viewerFor(db, CREATOR));

  assert.equal(scoped.viewerCan.manage, true);
  assert.equal(scoped.corrections.length, 1);
  assert.ok(scoped.roster.every((p) => p.userId), 'ids, because managing a roster needs them');
});

test('sessions lose the job behind them below dev', async (t) => {
  const { db, cipher } = await world(t);
  const view = buildCampaignView({ db, campaignId: cipher });
  const scoped = scopeCampaign(view, viewerFor(db, CREATOR));

  for (const s of scoped.sessions) {
    assert.equal(s.discardable, false, 'throwing a session away is machinery');
    if (s.job) {
      assert.equal(s.job.lastError, undefined);
      assert.equal(s.job.id, undefined, 'a job id is a handle on the queue');
    }
  }
});

// The failure direction that matters: a new field added to the payload later
// must not leak by default. scopeStatus is a list of what goes IN.
test('a field nobody thought about is not carried through', async (t) => {
  const { db } = await world(t);
  const full = { ...snapshot(db), apiKeyHint: 'sk-live-oops', internalPaths: ['/data/secrets'] };
  const json = JSON.stringify(scopeStatus(full, viewerFor(db, PLAYER)));

  assert.doesNotMatch(json, /sk-live-oops|internalPaths/);
});
