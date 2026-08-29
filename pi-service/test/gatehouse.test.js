import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { maySignIn, admissionOf, ACTION_NEEDS, mayAct } from '../src/web/authority.js';
import { buildViewer, OPERATOR } from '../src/web/viewer.js';
import { accessRoster } from '../src/web/access.js';
import { runAction } from '../src/web/actions.js';
import { openSession } from '../src/web/auth.js';

// The guest list, and the page that edits it.
//
// This is the one list-shaped check in a codebase where every other permission
// is derived from a fact about Discord, so it gets the scrutiny that goes with
// being the exception. Three questions run through everything here:
//
//   * does admitting somebody grant them anything?  (it must not)
//   * can the list lock the operator out of their own Pi?  (it must not)
//   * does a button that says Remove actually remove?  (it must)

const OWNER = '175407464513011713';
const FRIEND = '412907556128374785';
const STRANGER = '910273645518293004';

async function world(t, cfg = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-gatehouse-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    db,
    cfg: { ownerUserId: OWNER, statusToken: 'x', authSecret: 'a'.repeat(32), ...cfg },
    dir,
  };
}

const run = (db, cfg, name, body, ctx = {}) =>
  runAction({ pathname: `/actions/${name}`, body, db, cfg, ctx: { viewer: OPERATOR, ...ctx } });

// --- who may hold a session at all ---------------------------------------

test('with nothing configured the door is open, and open means everybody', async (t) => {
  const { db, cfg } = await world(t, { ownerUserId: null });

  assert.equal(maySignIn(cfg, STRANGER, db), true);
  assert.equal(admissionOf(cfg, STRANGER, db), 'open');
});

test('one row in the table closes the door on everybody not in it', async (t) => {
  const { db, cfg } = await world(t, { ownerUserId: null });
  db.setInvited(FRIEND);

  assert.equal(maySignIn(cfg, FRIEND, db), true);
  assert.equal(maySignIn(cfg, STRANGER, db), false, 'a list of one is still a list');
});

test('the environment and the table are one list, not two competing ones', async (t) => {
  const { db, cfg } = await world(t, { ownerUserId: null, dashboardAllowedUsers: FRIEND });
  db.setInvited(STRANGER);

  assert.equal(maySignIn(cfg, FRIEND, db), true, 'named in .env');
  assert.equal(maySignIn(cfg, STRANGER, db), true, 'added on the page');
  assert.equal(maySignIn(cfg, '1'.repeat(18), db), false);

  // And each says which half admitted it, because only one of them is a row
  // this bot can delete.
  assert.equal(admissionOf(cfg, FRIEND, db), 'env');
  assert.equal(admissionOf(cfg, STRANGER, db), 'list');
});

test('the operator is on their own guest list however badly it is edited', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: STRANGER });

  assert.equal(maySignIn(cfg, OWNER, db), true, 'even though OWNER is on neither list');
  assert.equal(admissionOf(cfg, OWNER, db), 'owner');
});

test('the old two-argument call still answers, so nothing that has not been told about the table breaks', async (t) => {
  const { db, cfg } = await world(t, { ownerUserId: null, dashboardAllowedUsers: FRIEND });
  db.setInvited(STRANGER);

  assert.equal(maySignIn(cfg, FRIEND), true);
  assert.equal(maySignIn(cfg, STRANGER), false, 'without the db it can only see the .env half');
});

test('nobody is not somebody, whatever shape they arrive in', async (t) => {
  const { db, cfg } = await world(t, { ownerUserId: null });
  db.setInvited(FRIEND);

  for (const id of [null, undefined, '', 0, false, NaN]) {
    assert.equal(maySignIn(cfg, id, db), false, String(id));
    assert.equal(admissionOf(cfg, id, db), null, String(id));
  }
});

// --- admitting somebody grants them nothing ------------------------------

test('being on the list does not raise a level by one step', async (t) => {
  const { db, cfg } = await world(t);
  db.setInvited(STRANGER);

  const viewer = buildViewer({ db, cfg, userId: STRANGER, guildsOwned: [] });
  assert.equal(viewer.level, 'none', 'admitted, and still nobody');
  assert.deepEqual(viewer.campaignIds, []);
  assert.equal(viewer.can.everything, false);
  assert.equal(viewer.can.machinery, false);
});

test('changing the list is the owner\'s alone — a server owner cannot edit it', async (t) => {
  const { db, cfg } = await world(t);
  db.createCampaign('guild-1', 'Cipher', 'dm-1');
  const serverOwner = buildViewer({ db, cfg, userId: FRIEND, guildsOwned: ['guild-1'] });

  assert.equal(serverOwner.level, 'owner');
  assert.equal(serverOwner.can.manage, true, 'they can reshape a campaign');

  for (const name of ['access/invite', 'access/uninvite', 'access/revoke']) {
    assert.equal(ACTION_NEEDS[name], 'everything', `${name} is not gated to the owner`);
    const denial = mayAct({ pathname: `/actions/${name}`, body: { userId: STRANGER }, viewer: serverOwner, db });
    assert.equal(denial?.status, 403, `${name} let a server owner through`);
  }
});

// --- the actions ---------------------------------------------------------

test('admitting writes a row, and says what it did and did not do', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/invite', { userId: STRANGER });
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.match(res.payload.message, /still their own/, 'the reply says admission is not a level');
  assert.equal(db.isInvited(STRANGER), true);
  assert.equal(maySignIn(cfg, STRANGER, db), true);
});

test('a typo is refused rather than admitted', async (t) => {
  const { db, cfg } = await world(t);

  for (const bad of ['', 'nope', '12', '<script>', `${STRANGER}x`]) {
    const res = await run(db, cfg, 'access/invite', { userId: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(db.countInvited(), 0);
});

test('Discord is asked whether the account exists before a row is written', async (t) => {
  const { db, cfg } = await world(t);
  const discord = { lookUp: async () => ({ ok: false, message: 'Discord does not know that account.' }) };

  const res = await run(db, cfg, 'access/invite', { userId: STRANGER }, { discord });
  assert.equal(res.status, 400);
  assert.equal(db.countInvited(), 0, 'a well-formed id belonging to nobody was still written');
});

test('the name Discord gives beats the one the page sent', async (t) => {
  const { db, cfg } = await world(t);
  const discord = { lookUp: async () => ({ ok: true, userId: STRANGER, username: 'thistlewick' }) };

  await run(db, cfg, 'access/invite', { userId: STRANGER, username: 'whatever-the-page-guessed' }, { discord });
  assert.equal(db.listAccessRows()[0].username, 'thistlewick');
});

test('admitting somebody twice is a shrug, not an error', async (t) => {
  const { db, cfg } = await world(t);

  await run(db, cfg, 'access/invite', { userId: STRANGER });
  const again = await run(db, cfg, 'access/invite', { userId: STRANGER });

  assert.equal(again.status, 200);
  assert.equal(db.countInvited(), 1);
});

test('removing somebody ends their sessions, because a name struck off should not still be inside', async (t) => {
  const { db, cfg } = await world(t);
  db.setInvited(STRANGER, { username: 'thistlewick' });
  openSession(db, cfg, { userId: STRANGER, username: 'thistlewick' });
  openSession(db, cfg, { userId: STRANGER, username: 'thistlewick' });

  const res = await run(db, cfg, 'access/uninvite', { userId: STRANGER });

  assert.equal(res.status, 200);
  assert.equal(res.payload.ended, 2);
  assert.match(res.payload.message, /2 sessions/);
  assert.equal(db.isInvited(STRANGER), false);
});

// The boundary nobody expects. An empty list is not the tightest setting, it
// is the absence of a setting -- so the removal that empties it is the one
// that has to explain itself.
test('taking the last name off opens the door, and the reply says so', async (t) => {
  const { db, cfg } = await world(t);
  db.setInvited(FRIEND);
  db.setInvited(STRANGER);

  const first = await run(db, cfg, 'access/uninvite', { userId: FRIEND });
  assert.equal(first.payload.emptied, false);
  assert.doesNotMatch(first.payload.message, /ANY Discord account/);
  assert.equal(maySignIn(cfg, '1'.repeat(18), db), false, 'one name left is still a list');

  const last = await run(db, cfg, 'access/uninvite', { userId: STRANGER });
  assert.equal(last.payload.emptied, true);
  assert.match(last.payload.message, /ANY Discord account can now sign in/);
  assert.equal(maySignIn(cfg, '1'.repeat(18), db), true, 'which is the fact the message exists for');
});

test('a name still in .env keeps the list alive when the table empties', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: FRIEND });
  db.setInvited(STRANGER);

  const res = await run(db, cfg, 'access/uninvite', { userId: STRANGER });
  assert.equal(res.payload.emptied, false, 'the environment half is still holding the door');
  assert.equal(maySignIn(cfg, '1'.repeat(18), db), false);
});

test('a Remove that would delete nothing says so instead of reporting success', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: FRIEND });

  for (const id of [OWNER, FRIEND]) {
    const res = await run(db, cfg, 'access/uninvite', { userId: id });
    assert.equal(res.status, 400, id);
    assert.match(res.payload.message, /DASHBOARD_ALLOWED_USERS|OWNER_USER_ID/);
    assert.equal(maySignIn(cfg, id, db), true, 'and they are still admitted, which is the honest part');
  }
});

// --- the level control ---------------------------------------------------
//
// A ceiling and never a floor. Every test here is really the same test asked
// from a different side: can a row in a table make something true that Discord
// or the record does not already say. It must not.

test('a ceiling lowers the level and narrows the scope with it', async (t) => {
  const { db, cfg } = await world(t);
  const owned = db.createCampaign('guild-1', 'Cipher', OWNER);
  const played = db.createCampaign('guild-2', 'Ledger', 'somebody-else');
  const meeting = db.createMeeting({
    guildId: 'guild-2', campaignId: played, channelId: 'v', channelName: 'x',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: FRIEND, displayName: 'fenwick', startMs: 0, endMs: 1, text: 'hi' },
  ]);

  const full = buildViewer({ db, cfg, userId: FRIEND, guildsOwned: ['guild-1'] });
  assert.equal(full.level, 'owner');
  assert.ok(full.campaignIds.includes(owned), 'a server owner sees what is on their server');
  assert.equal(full.can.manage, true);

  db.setCap(FRIEND, 'player');
  const held = buildViewer({ db, cfg, userId: FRIEND, guildsOwned: ['guild-1'] });

  assert.equal(held.level, 'player');
  assert.equal(held.derivedLevel, 'owner', 'what is true of them has not changed');
  assert.equal(held.cap, 'player');
  assert.equal(held.can.manage, false);
  assert.deepEqual(held.campaignIds, [played],
    'a ceiling that leaves the rows in place and only greys the buttons is not a ceiling');
  assert.deepEqual(held.guildIds, []);
});

// The Level column used to refuse every rung above what somebody had earned,
// on the grounds that a level somebody could be awarded is a level somebody
// could be awarded by mistake. It goes both ways now — and the argument it was
// protecting survives, because a grant moves the CONTROLS and never the SCOPE.

test('a level above what they resolve to is a grant, not a refusal', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/level', { userId: FRIEND, level: 'owner' });

  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(db.grantFor(FRIEND), 'owner');
  assert.equal(db.capFor(FRIEND), null);

  const now = buildViewer({ db, cfg, userId: FRIEND });
  assert.equal(now.level, 'owner');
  assert.equal(now.derivedLevel, 'none', 'nothing became true about them');
  assert.equal(now.granted, 'owner');
  assert.equal(now.can.servers, true, 'the controls an owner gets');
});

// The property the whole design rests on. Granting a level hands somebody more
// machinery over the campaigns they already have a claim on — and they may have
// none, in which case they have been given a fuller view of nothing.
test('a grant adds controls and never a single campaign', async (t) => {
  const { db, cfg } = await world(t);
  db.createCampaign('guild-1', 'Cipher', 'somebody-else');

  await run(db, cfg, 'access/level', { userId: FRIEND, level: 'creator' });

  const now = buildViewer({ db, cfg, userId: FRIEND });
  assert.equal(now.level, 'creator');
  assert.equal(now.can.manage, true, 'a creator’s controls');
  assert.deepEqual(now.campaignIds, [], 'over nothing at all');
  assert.deepEqual(now.manageableCampaignIds, []);
});

// Said in the message rather than left to a help panel, because "raised to
// creator" reads like "given a campaign" and is not.
test('the grant says out loud that it is not a campaign', async (t) => {
  const { db, cfg } = await world(t);
  const res = await run(db, cfg, 'access/level', { userId: FRIEND, level: 'creator' });

  assert.match(res.payload.message, /controls, not campaigns/);
  assert.match(res.payload.message, /hand it to them/i, 'and names the act that would');
});

// One way to appoint an operator, not two. The house tier next door does it.
test('dev is still not on this column’s menu', async (t) => {
  const { db, cfg } = await world(t);
  const res = await run(db, cfg, 'access/level', { userId: FRIEND, level: 'dev' });

  assert.equal(res.status, 400);
  assert.match(res.payload.message, /Tier column/);
  assert.equal(buildViewer({ db, cfg, userId: FRIEND }).level, 'none');
});

// A floor of creator under a ceiling of player is two instructions that cannot
// both be obeyed. The store makes the state unreachable rather than leaving
// buildViewer to pick one while the page draws the other.
test('a person can never hold a grant and a cap at once', async (t) => {
  const { db, cfg } = await world(t);
  db.createCampaign('guild-1', 'Cipher', FRIEND);

  await run(db, cfg, 'access/level', { userId: FRIEND, level: 'owner' });
  assert.equal(db.grantFor(FRIEND), 'owner');

  await run(db, cfg, 'access/level', { userId: FRIEND, level: 'player' });
  assert.equal(db.capFor(FRIEND), 'player');
  assert.equal(db.grantFor(FRIEND), null, 'the raise was cleared, not stacked under the ceiling');
  assert.equal(buildViewer({ db, cfg, userId: FRIEND }).level, 'player');
});

// The rule for when the world catches up: the grant stops doing anything, and
// the row stays. Deleting it would take the operator's decision away for good
// the moment it was briefly redundant — and the fact can go away again.
test('a grant the derived level has overtaken goes quiet without being lost', async (t) => {
  const { db, cfg } = await world(t);

  await run(db, cfg, 'access/level', { userId: FRIEND, level: 'creator' });
  assert.equal(buildViewer({ db, cfg, userId: FRIEND }).granted, 'creator');

  // They go and actually run a campaign, which is a higher rung than the grant.
  const guildOwner = buildViewer({ db, cfg, userId: FRIEND, guildsOwned: ['guild-1'] });
  assert.equal(guildOwner.level, 'owner', 'the fact wins');
  assert.equal(guildOwner.granted, null, 'and the grant stops claiming credit');
  assert.equal(db.grantFor(FRIEND), 'creator', 'but the row is still there for when it stops being true');
});

test('picking their own level back lifts the ceiling', async (t) => {
  const { db, cfg } = await world(t);
  const campaignId = db.createCampaign('guild-1', 'Cipher', FRIEND);
  assert.ok(campaignId);

  db.setCap(FRIEND, 'none');
  assert.equal(buildViewer({ db, cfg, userId: FRIEND }).level, 'none');

  const res = await run(db, cfg, 'access/level', { userId: FRIEND, level: 'creator' });
  assert.equal(res.status, 200);
  assert.match(res.payload.message, /Back to creator/);
  assert.equal(db.capFor(FRIEND), null);
  assert.equal(buildViewer({ db, cfg, userId: FRIEND }).level, 'creator');
});

test('the empty string is the same as picking their own level back', async (t) => {
  const { db, cfg } = await world(t);
  db.setCap(FRIEND, 'none');

  const res = await run(db, cfg, 'access/level', { userId: FRIEND, level: '' });
  assert.equal(res.status, 200);
  assert.equal(db.capFor(FRIEND), null);
});

test('the operator cannot be held below their own level, because that click has no way back', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/level', { userId: OWNER, level: 'none' });

  assert.equal(res.status, 400);
  assert.match(res.payload.message, /OWNER_USER_ID/);
  assert.equal(buildViewer({ db, cfg, userId: OWNER }).level, 'dev');
});

test('a ceiling written straight into the database still cannot touch the operator', async (t) => {
  const { db, cfg } = await world(t);
  db.setCap(OWNER, 'none');

  assert.equal(buildViewer({ db, cfg, userId: OWNER }).level, 'dev', 'the owner was locked out of their own Pi');
  assert.equal(buildViewer({ db, cfg, userId: OWNER }).cap, null);
});

test('a level the store has never heard of is ignored rather than guessed at', async (t) => {
  const { db, cfg } = await world(t);
  db.setCap(FRIEND, 'moderator');

  const viewer = buildViewer({ db, cfg, userId: FRIEND });
  assert.equal(viewer.level, 'none', 'and not locked out, and not promoted');
  assert.equal(viewer.cap, null);

  const res = await run(db, cfg, 'access/level', { userId: FRIEND, level: 'moderator' });
  assert.equal(res.status, 400);
  assert.match(res.payload.message, /Not a level/);
});

test('the ceiling and the guest list are separate opinions about the same person', async (t) => {
  const { db, cfg } = await world(t);
  db.createCampaign('guild-1', 'Cipher', FRIEND);

  await run(db, cfg, 'access/invite', { userId: FRIEND });
  await run(db, cfg, 'access/level', { userId: FRIEND, level: 'player' });
  assert.equal(db.isInvited(FRIEND), true, 'setting a ceiling revoked their welcome');
  assert.equal(db.capFor(FRIEND), 'player');

  await run(db, cfg, 'access/invite', { userId: FRIEND });
  assert.equal(db.capFor(FRIEND), 'player', 're-admitting quietly lifted the ceiling');

  await run(db, cfg, 'access/uninvite', { userId: FRIEND });
  assert.equal(db.isInvited(FRIEND), false);
  assert.equal(db.capFor(FRIEND), 'player', 'removing them from the list forgot the ceiling');
});

test('a row saying nothing at all is deleted rather than left as litter', async (t) => {
  const { db, cfg } = await world(t);
  db.createCampaign('guild-1', 'Cipher', FRIEND);

  await run(db, cfg, 'access/invite', { userId: FRIEND });
  await run(db, cfg, 'access/uninvite', { userId: FRIEND });
  assert.deepEqual(db.listAccessRows(), [], 'an opinion-free row was left behind');
});

// --- what the page is shown ----------------------------------------------

test('somebody admitted this morning appears before they have done anything', async (t) => {
  const { db, cfg } = await world(t);
  db.setInvited(STRANGER, { username: 'thistlewick' });

  const roster = accessRoster({ db, cfg });
  const row = roster.people.find((p) => p.userId === STRANGER);

  assert.ok(row, 'the person most worth seeing was filtered out for having no history');
  assert.equal(row.name, 'thistlewick');
  assert.equal(row.level, 'none');
  assert.equal(row.admission, 'list');
  assert.equal(row.invited, true);
});

test('an id that only exists in .env is shown too, rather than silently missing', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: `${FRIEND}, ${STRANGER}` });

  const roster = accessRoster({ db, cfg });
  const ids = roster.people.map((p) => p.userId);

  assert.ok(ids.includes(FRIEND));
  assert.ok(ids.includes(STRANGER));
  assert.equal(roster.people.find((p) => p.userId === FRIEND).admission, 'env');
});

test('listInUse is about the lists, not about who happens to be in the roster', async (t) => {
  const open = await world(t);
  assert.equal(accessRoster(open).listInUse, false, 'the owner existing is not a guest list');

  const byEnv = await world(t, { dashboardAllowedUsers: FRIEND });
  assert.equal(accessRoster(byEnv).listInUse, true);

  const byTable = await world(t);
  byTable.db.setInvited(FRIEND);
  assert.equal(accessRoster(byTable).listInUse, true);
});

test('with no list in use everybody reads as open, so the page can say the door is not shut', async (t) => {
  const { db, cfg } = await world(t, { ownerUserId: null });
  const campaignId = db.createCampaign('guild-1', 'Cipher', FRIEND);
  assert.ok(campaignId);

  const roster = accessRoster({ db, cfg });
  assert.equal(roster.listInUse, false);
  for (const p of roster.people) {
    assert.equal(p.admission, 'open', p.userId);
    assert.equal(p.invited, false, 'open is not the same as invited, and the page prints them differently');
  }
});
