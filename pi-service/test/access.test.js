import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { accessRoster } from '../src/web/access.js';
import { openSession, readSession } from '../src/web/auth.js';
import { scopeStatus } from '../src/web/scope.js';
import { buildViewer } from '../src/web/viewer.js';
import { runAction } from '../src/web/actions.js';

// Who can get into this bot.
//
// The access page answered "is the door locked" and never "who is inside",
// which is the question you actually open it to ask. These tests are about the
// second one — and about the line between the two acts it offers: ending
// somebody's session is not the same as removing them from a table, and a page
// that blurred those would be a page you could not trust to press.

const DEV = '10000000000000001';
const OWNER = '20000000000000002';
const CREATOR = '30000000000000003';
const PLAYER = '40000000000000004';
const GHOST = '50000000000000005';

const cfg = {
  ownerUserId: DEV,
  statusToken: 'a-real-secret',
  dashboardRequireLogin: true,
};

// OWNER owns guild-1 in Discord; nothing in the database says so.
const client = {
  guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'The Cellar', ownerId: OWNER }]]) },
};

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-access-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cipher = db.createCampaign('guild-1', 'Cipher', CREATOR);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId: cipher, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
  ]);

  return { db, dir, cipher, meeting };
}

const find = (roster, userId) => roster.people.find((p) => p.userId === userId);

// --- who is on the list ---

test('everyone the bot knows is on the list, at the level they resolve to', async (t) => {
  const { db } = await world(t);
  const roster = accessRoster({ db, cfg, client });

  assert.equal(find(roster, DEV).level, 'dev');
  assert.equal(find(roster, OWNER).level, 'owner');
  assert.equal(find(roster, CREATOR).level, 'creator');
  assert.equal(find(roster, PLAYER).level, 'player');
});

// Access is held by role as much as by history. A server owner who has only
// ever watched still owns the server, and leaving them off would understate
// who can get in — the one error this page must not make.
test('a server owner who has never spoken or signed in is still listed', async (t) => {
  const { db } = await world(t);
  const owner = find(accessRoster({ db, cfg, client }), OWNER);

  assert.ok(owner, 'owns a server, so they have access whatever the database remembers');
  assert.equal(owner.lines, 0);
  assert.deepEqual(owner.guilds, ['The Cellar']);
});

test('the operator is listed on a bot nobody has used yet', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-access-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const roster = accessRoster({ db, cfg, client: null });
  assert.equal(roster.people.length, 1);
  assert.equal(roster.people[0].level, 'dev');
});

// A row is not the same as a person with access.
test('somebody with no level and no history is not counted as access', async (t) => {
  const { db, cipher } = await world(t);
  db.setConsent(cipher, GHOST, false);

  assert.equal(find(accessRoster({ db, cfg, client }), GHOST), undefined, 'a declined invitation is not access');
});

test('a name comes from the sign-in when there is one, and from speech otherwise', async (t) => {
  const { db } = await world(t);
  openSession(db, cfg, { userId: CREATOR, username: 'kez' });

  const roster = accessRoster({ db, cfg, client });
  assert.equal(find(roster, CREATOR).name, 'kez', 'what they signed in as');
  assert.equal(find(roster, PLAYER).name, 'saf', 'what they were called when they spoke');
});

// --- what the list says about them ---

test('a live session shows as signed in, and a spent one does not', async (t) => {
  const { db } = await world(t);
  const { token } = openSession(db, cfg, { userId: PLAYER, username: 'saf' });

  assert.equal(find(accessRoster({ db, cfg, client }), PLAYER).signedIn, true);

  db.closeAllAuthSessions(PLAYER);
  assert.equal(find(accessRoster({ db, cfg, client }), PLAYER).signedIn, false);
  assert.equal(readSession(db, cfg, token), null);
});

// The headline fact. With login off the levels are not being enforced at all,
// and a page that showed a tidy roster without saying so would be reassuring
// and wrong.
test('the roster says whether the front door is asking for a name', async (t) => {
  const { db } = await world(t);

  assert.equal(accessRoster({ db, cfg, client }).requireLogin, true);
  assert.equal(
    accessRoster({ db, cfg: { ...cfg, dashboardRequireLogin: false }, client }).requireLogin,
    false
  );
});

// --- who may read it ---

test('the roster never leaves the Pi for anyone but the operator', async (t) => {
  const { db } = await world(t);
  const status = { generatedAt: 'x', bot: {}, campaigns: [], access: accessRoster({ db, cfg, client }) };

  for (const userId of [OWNER, CREATOR, PLAYER]) {
    const viewer = buildViewer({ db, cfg, userId, guildsOwned: userId === OWNER ? ['guild-1'] : [] });
    assert.equal(scopeStatus(status, viewer).access, undefined, `${viewer.level} must not receive it`);
  }

  assert.ok(scopeStatus(status, buildViewer({ db, cfg, userId: DEV })).access, 'the operator does');
});

// --- signing somebody out ---

test('revoking ends every session that person holds', async (t) => {
  const { db } = await world(t);
  openSession(db, cfg, { userId: PLAYER, username: 'saf' });
  openSession(db, cfg, { userId: PLAYER, username: 'saf' });
  const other = openSession(db, cfg, { userId: CREATOR, username: 'kez' });

  const res = runAction({ pathname: '/actions/access/revoke', body: { userId: PLAYER }, db, cfg });
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.ended, 2);

  assert.equal(find(accessRoster({ db, cfg, client }), PLAYER).signedIn, false);
  assert.ok(readSession(db, cfg, other.token), 'somebody else is untouched');
});

// The line this page must not blur. Signing somebody out is about the door; it
// is not a way to remove them from a table, and it is not a way to delete what
// they said. Those have their own commands, deliberately.
test('revoking removes nobody from a campaign and deletes nothing they said', async (t) => {
  const { db, cipher, meeting } = await world(t);
  openSession(db, cfg, { userId: PLAYER, username: 'saf' });

  const linesBefore = db.listUtterances(meeting).length;
  const consentBefore = db.getConsent(cipher, PLAYER);

  runAction({ pathname: '/actions/access/revoke', body: { userId: PLAYER }, db, cfg });

  assert.equal(db.listUtterances(meeting).length, linesBefore, 'not one line touched');
  assert.deepEqual(db.getConsent(cipher, PLAYER), consentBefore, 'still at the table');
  assert.equal(find(accessRoster({ db, cfg, client }), PLAYER).level, 'player', 'still a player');
});

test('revoking somebody with no sessions says so rather than claiming success', async (t) => {
  const { db } = await world(t);
  const res = runAction({ pathname: '/actions/access/revoke', body: { userId: PLAYER }, db, cfg });

  assert.equal(res.payload.ended, 0);
  assert.match(res.payload.message, /no sessions/);
});

test('revoking without a userId is refused', async (t) => {
  const { db } = await world(t);
  assert.equal(runAction({ pathname: '/actions/access/revoke', body: {}, db, cfg }).status, 400);
});
