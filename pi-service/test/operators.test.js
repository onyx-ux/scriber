import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/store/db.js';
import {
  operatorIds, isOperator, isPrimaryOperator, operatorCount, runsThisBot, mayGrantHouseTier,
} from '../src/access/operators.js';
import { mayDelete } from '../src/campaign/archive.js';
import { isManager } from '../src/campaign/permissions.js';
import { buildViewer, OPERATOR } from '../src/web/viewer.js';
import { maySignIn, admissionOf } from '../src/web/authority.js';
import { tierOf } from '../src/access/tiers.js';
import { runAction } from '../src/web/actions.js';
import { accessRoster } from '../src/web/access.js';

// A second person who runs this install.
//
// OWNER_USER_ID was compared inline at a dozen call sites in three spellings,
// two of which would have answered "no" to the right person given an id that
// had been through a number. access/operators.js is now the only module that
// answers "who runs this", and these tests are about the two halves of that:
// what a second operator gets, and what it deliberately does not get.

const OWNER = '20000000000000002';
const SECOND = '70000000000000007';
const STRANGER = '90000000000000009';
// Somebody the config file does not name, who gets the house tier handed to
// them. The whole point of the rules below is what this account may NOT do.
const SECOND_HOUSE = '80000000000000008';

async function world(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-ops-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

  return {
    db,
    cfg: { ownerUserId: OWNER, operatorUserIds: SECOND, statusToken: 'sesame', ...extra },
  };
}

const viewer = (db, cfg, userId, guildsOwned = []) =>
  buildViewer({ db, cfg, userId, guildsOwned });

// ---------------------------------------------------------------------------
// The list itself
// ---------------------------------------------------------------------------

test('with nothing configured, the owner is the only operator', async (t) => {
  const { cfg } = await world(t, { operatorUserIds: null });

  assert.deepEqual([...operatorIds(cfg)], [OWNER]);
  assert.equal(operatorCount(cfg), 1);
  assert.equal(isOperator(cfg, OWNER), true);
  assert.equal(isOperator(cfg, SECOND), false);
});

test('a second id joins the answer, primary first', async (t) => {
  const { cfg } = await world(t);

  assert.deepEqual([...operatorIds(cfg)], [OWNER, SECOND]);
  assert.equal(operatorCount(cfg), 2);
  assert.equal(isOperator(cfg, SECOND), true);
  assert.equal(isOperator(cfg, STRANGER), false);
});

test('the list is read the way a person types it', async (t) => {
  const { cfg } = await world(t, { operatorUserIds: ` ${SECOND} , , ${STRANGER} ,` });

  assert.deepEqual([...operatorIds(cfg)], [OWNER, SECOND, STRANGER], 'spacing or a stray comma broke it');
});

test('naming the owner again does not list them twice', async (t) => {
  const { cfg } = await world(t, { operatorUserIds: `${OWNER},${SECOND},${SECOND}` });

  assert.deepEqual([...operatorIds(cfg)], [OWNER, SECOND]);
});

// The bug the old inline checks could actually have had: an id that has been
// through JSON or a number compares false against a config string.
test('an id is compared as a string, whatever shape it arrives in', async (t) => {
  const { cfg } = await world(t, { ownerUserId: 42, operatorUserIds: 77 });

  assert.equal(isOperator(cfg, 42), true);
  assert.equal(isOperator(cfg, '42'), true);
  assert.equal(isOperator(cfg, 77), true);
  assert.equal(isOperator(cfg, '77'), true);
});

// String(0 ?? '') is "0" -- a non-empty string that sails past an emptiness
// test. maySignIn documents this trap; this is the same one.
test('nothing falsy is anybody', async (t) => {
  const { cfg } = await world(t);

  for (const nobody of [null, undefined, '', 0, false, NaN]) {
    assert.equal(isOperator(cfg, nobody), false, String(nobody));
    assert.equal(isPrimaryOperator(cfg, nobody), false, String(nobody));
  }
});

test('primary is the owner alone, and a second operator is not it', async (t) => {
  const { cfg } = await world(t);

  assert.equal(isPrimaryOperator(cfg, OWNER), true);
  assert.equal(isPrimaryOperator(cfg, SECOND), false);
  assert.equal(isOperator(cfg, SECOND), true, 'not primary is not the same as not an operator');
});

// ---------------------------------------------------------------------------
// What a second operator gets
// ---------------------------------------------------------------------------

test('a second operator holds the dev level, same as the owner', async (t) => {
  const { db, cfg } = await world(t);

  assert.equal(viewer(db, cfg, SECOND).level, 'dev');
  assert.equal(viewer(db, cfg, SECOND).derivedLevel, 'dev');
  assert.equal(viewer(db, cfg, STRANGER).level, 'none', 'everybody became an operator');
});

test('a second operator sees the machinery', async (t) => {
  const { db, cfg } = await world(t);
  const them = viewer(db, cfg, SECOND);

  assert.equal(them.can.everything, true);
  assert.deepEqual(them.can, viewer(db, cfg, OWNER).can, 'the two operators see different things');
});

test('a second operator is on the top tier and cannot be metered', async (t) => {
  const { db, cfg } = await world(t, { defaultTier: 0, tierAskLimits: { 0: 5, 4: 20 } });

  assert.equal(tierOf(db, cfg, SECOND), 9);

  // Even written straight into the database, which is the path that skips
  // every guard the dashboard has.
  db.setTier(SECOND, 0);
  assert.equal(tierOf(db, cfg, SECOND), 9, 'a row in the database demoted an operator');
});

test('a second operator may sign in through a guest list that never named them', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: STRANGER });

  assert.equal(maySignIn(cfg, SECOND, db), true, 'an operator was locked out by a list');
  assert.equal(maySignIn(cfg, OWNER, db), true);
  assert.equal(maySignIn(cfg, '11111111111111111', db), false, 'the list stopped meaning anything');
});

test('the gatehouse can tell the two apart without treating them differently', async (t) => {
  const { db, cfg } = await world(t);

  assert.equal(admissionOf(cfg, OWNER, db), 'owner');
  assert.equal(admissionOf(cfg, SECOND, db), 'op');
  assert.equal(admissionOf(cfg, STRANGER, db), 'open', 'no list is in use, so everybody is welcome');
});

test('a cap written into the database is ignored for a second operator', async (t) => {
  const { db, cfg } = await world(t);

  db.setCap(SECOND, 'player');
  assert.equal(viewer(db, cfg, SECOND).level, 'dev', 'an operator was held down by a stored cap');
  assert.equal(viewer(db, cfg, SECOND).cap, null);
});

// ---------------------------------------------------------------------------
// What it deliberately does not get
// ---------------------------------------------------------------------------

// Two people receiving every approval DM is how both start ignoring them, and
// "who should this bot talk to" is a different question from "who may act".
// Asserted structurally rather than by sending a DM, because what has to hold
// is not "this one notifier is right today" but "nothing under delivery/ ever
// learned about the list". A future notifier that imports it would be the
// regression, and this catches it on the day it is written.
test('nothing that sends a DM knows the operator list exists', async () => {
  const dir = fileURLToPath(new URL('../src/delivery/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5, 'delivery/ went missing');

  const leaked = [];
  for (const file of files) {
    const source = await readFile(join(dir, file), 'utf8');
    if (/access\/operators\.js/.test(source)) leaked.push(file);
  }

  assert.deepEqual(leaked, [],
    `these send to whoever runs the bot rather than to its owner: ${leaked.join(', ')}`);
});

// Same argument for startup: a second operator arriving should not silently
// take ownership of every campaign nobody is managing.
test('orphaned campaigns are still adopted to the owner alone', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
  const line = source.split('\n').find((l) => l.includes('adoptUnmanagedCampaigns'));

  assert.ok(line, 'adoptUnmanagedCampaigns is gone');
  assert.match(line, /ownerUserId/, 'adoption was repointed at the operator list');
});

test('the console still acts as one identity', async (t) => {
  const { cfg } = await world(t);
  const { actingUserId } = await import('../src/web/authority.js');

  // The STATUS_TOKEN path has no Discord session. A request that proves only
  // "somebody holds the token" cannot pick which operator it is.
  assert.equal(actingUserId({ can: { everything: true } }, cfg), OWNER);
});

// ---------------------------------------------------------------------------
// The two controls that must refuse
// ---------------------------------------------------------------------------

const run = (db, cfg, name, body) =>
  runAction({ pathname: `/actions/${name}`, body, db, cfg, ctx: { viewer: OPERATOR } });

test('the gatehouse refuses to cap a second operator, and says which file to edit', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/level', { userId: SECOND, level: 'player' });

  assert.equal(res.status, 400);
  assert.match(res.payload.message, /OPERATOR_USER_IDS/);
  assert.equal(db.capFor(SECOND), null, 'the refusal still wrote a cap');
});

test('and names OWNER_USER_ID instead when it is the owner', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/level', { userId: OWNER, level: 'player' });

  assert.equal(res.status, 400);
  assert.match(res.payload.message, /OWNER_USER_ID/);
});

test('the gatehouse refuses to move a second operator off the top tier', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/tier', { userId: SECOND, tier: 0 });

  assert.equal(res.status, 400);
  assert.match(res.payload.message, /OPERATOR_USER_IDS/);
  assert.equal(tierOf(db, cfg, SECOND), 9);
});

test('somebody who is not an operator can still be capped and tiered', async (t) => {
  const { db, cfg } = await world(t);

  assert.equal((await run(db, cfg, 'access/tier', { userId: STRANGER, tier: 2 })).status, 200);
  assert.equal(db.tierOf(STRANGER), 2, 'the operator guard caught everybody');
});

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

test('a second operator appears on the gatehouse before they have ever signed in', async (t) => {
  const { db, cfg } = await world(t);

  const roster = accessRoster({ db, cfg });
  const them = roster.people.find((p) => p.userId === SECOND);

  assert.ok(them, 'an operator who has never opened the dashboard was left off it');
  assert.equal(them.level, 'dev');
  assert.equal(them.tier, 9);
  assert.equal(them.admission, 'op');
});

test('the roster says how many people run this install', async (t) => {
  const one = await world(t, { operatorUserIds: null });
  const two = await world(t);

  assert.deepEqual([...accessRoster(one).operators], [OWNER]);
  assert.deepEqual([...accessRoster(two).operators], [OWNER, SECOND]);
});

// ---------------------------------------------------------------------------
// The house tier — the third way in
// ---------------------------------------------------------------------------
//
// The gatehouse offered tier 9 as "the house" and it made nobody an operator,
// which read as a bug and was a decision: a level is derived from a fact, and
// deriving one from a number somebody typed would mean inventing the fact.
//
// So it goes the other way round. Tier 9 does not become a level — it becomes
// a fourth way of BEING an operator, and the level derives from that honestly.
// See docs/adr/0003.

test('putting somebody on the house tier makes them an operator', async (t) => {
  const { db, cfg } = await world(t);

  assert.equal(runsThisBot(db, cfg, STRANGER), false);
  assert.equal(viewer(db, cfg, STRANGER).level, 'none');

  db.setTier(STRANGER, 9);

  assert.equal(runsThisBot(db, cfg, STRANGER), true);
  const v = viewer(db, cfg, STRANGER);
  assert.equal(v.level, 'dev');
  assert.equal(v.derivedLevel, 'dev', 'derived, not granted — the level still follows a fact');
  assert.equal(v.can.everything, true);
  assert.equal(v.can.machinery, true);
});

// The invariant the rest of the tiers rest on: 0 to 4 still answer only "how
// much may they spend", and none of them touches a level.
test('no other tier is a level', async (t) => {
  const { db, cfg } = await world(t);

  for (const tier of [0, 1, 2, 3, 4]) {
    db.setTier(STRANGER, tier);
    assert.equal(runsThisBot(db, cfg, STRANGER), false, `tier ${tier} must not run the bot`);
    assert.equal(viewer(db, cfg, STRANGER).level, 'none', `tier ${tier} must not be a level`);
  }
});

test('taking the house tier away takes the bot back', async (t) => {
  const { db, cfg } = await world(t);

  db.setTier(STRANGER, 9);
  assert.equal(viewer(db, cfg, STRANGER).level, 'dev');

  db.setTier(STRANGER, 2);
  assert.equal(viewer(db, cfg, STRANGER).level, 'none', 'back to whatever is actually true of them');
  assert.equal(runsThisBot(db, cfg, STRANGER), false);
});

// isOperator still means "which line of the config file names you", because
// that is what the gatehouse's own captions are asking about. Only the
// authority question moved.
test('the file and the bot are different questions', async (t) => {
  const { db, cfg } = await world(t);
  db.setTier(STRANGER, 9);

  assert.equal(isOperator(cfg, STRANGER), false, 'no line of .env names them');
  assert.equal(runsThisBot(db, cfg, STRANGER), true, 'and they still run this bot');
  assert.equal(admissionOf(cfg, STRANGER, db), 'house');
  assert.equal(maySignIn(cfg, STRANGER, db), true, 'and cannot be locked out by a guest list');
});

// The question the other two routes answer with an SSH session, and the reason
// this one is safe: an operator appointed from the page cannot appoint another.
test('only the file may hand out the house tier', async (t) => {
  const { db, cfg } = await world(t);
  db.setTier(SECOND_HOUSE, 9);

  const asHouse = { viewer: viewer(db, cfg, SECOND_HOUSE) };
  const refused = runAction({
    pathname: '/actions/access/tier',
    body: { userId: STRANGER, tier: 9 },
    db, cfg, ctx: asHouse,
  });

  assert.equal(refused.status, 403);
  assert.match(refused.payload.message, /Only somebody named in/);
  assert.equal(db.tierOf(STRANGER), null, 'and nothing was written');
});

test('nor may they take it back from each other', async (t) => {
  const { db, cfg } = await world(t);
  db.setTier(SECOND_HOUSE, 9);
  db.setTier(STRANGER, 9);

  const refused = runAction({
    pathname: '/actions/access/tier',
    body: { userId: STRANGER, tier: 0 },
    db, cfg, ctx: { viewer: viewer(db, cfg, SECOND_HOUSE) },
  });

  assert.equal(refused.status, 403);
  assert.equal(Number(db.tierOf(STRANGER)), 9, 'still an operator');
});

test('the owner may hand it out, and is told what they just did', async (t) => {
  const { db, cfg } = await world(t);

  const done = runAction({
    pathname: '/actions/access/tier',
    body: { userId: STRANGER, tier: 9 },
    db, cfg, ctx: { viewer: viewer(db, cfg, OWNER) },
  });

  assert.equal(done.payload.ok, true);
  assert.match(done.payload.message, /run this bot/i, 'a column of spending ceilings must not hand over the machinery quietly');
  assert.equal(viewer(db, cfg, STRANGER).level, 'dev');
});

// A cap on a dev is ignored by buildViewer, so offering one would be a control
// that reports success and changes nothing.
test('an operator made by the house tier cannot be held down', async (t) => {
  const { db, cfg } = await world(t);
  db.setTier(STRANGER, 9);

  const refused = runAction({
    pathname: '/actions/access/level',
    body: { userId: STRANGER, level: 'player' },
    db, cfg, ctx: { viewer: viewer(db, cfg, OWNER) },
  });

  assert.equal(refused.payload.ok, false);
  assert.match(refused.payload.message, /house/i);
  assert.match(refused.payload.message, /Tier column/, 'and says where the real switch is');
  assert.equal(viewer(db, cfg, STRANGER).level, 'dev');
});

// Being an operator has to mean the same thing wherever it is asked, or there
// are two permission models growing quietly beside each other.
test('the house tier reaches the authority checks, not just the level', async (t) => {
  const { db, cfg } = await world(t);
  const campaignId = db.createCampaign('guild-1', 'Cipher', OWNER);
  const campaign = db.getCampaign(campaignId);

  assert.equal(mayDelete({ campaign, userId: STRANGER, cfg, db }), false);

  db.setTier(STRANGER, 9);
  assert.equal(mayDelete({ campaign, userId: STRANGER, cfg, db }), true, 'somebody else’s campaign, because they run the bot');
  assert.equal(isManager(STRANGER, db, campaignId, cfg), true, 'and the slash commands agree');
});

test('the gatehouse locks its own house column for an operator it appointed', async (t) => {
  const { db, cfg } = await world(t);
  db.setTier(SECOND_HOUSE, 9);

  const asOwner = accessRoster({ db, cfg, viewer: viewer(db, cfg, OWNER) });
  const asHouse = accessRoster({ db, cfg, viewer: viewer(db, cfg, SECOND_HOUSE) });

  assert.equal(asOwner.mayGrantHouse, true);
  assert.equal(asHouse.mayGrantHouse, false);
  assert.equal(mayGrantHouseTier(cfg, SECOND_HOUSE), false);
  assert.equal(mayGrantHouseTier(cfg, OWNER), true);
});
