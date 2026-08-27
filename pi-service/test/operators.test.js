import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/store/db.js';
import { operatorIds, isOperator, isPrimaryOperator, operatorCount } from '../src/access/operators.js';
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
