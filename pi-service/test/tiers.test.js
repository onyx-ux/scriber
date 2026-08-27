import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { TIERS, TOP_TIER, FREE_TIER, isTier, tierOf, askLimitFor, allowanceFor } from '../src/access/tiers.js';
import { askAllowance } from '../src/pipeline/ask-client.js';
import { runAction } from '../src/web/actions.js';
import { OPERATOR } from '../src/web/viewer.js';
import { accessRoster } from '../src/web/access.js';

// How much of the owner's money a person may spend.
//
// The tier is the one opinion on the gatehouse that goes UP, and these tests
// are mostly about the two ways that could go wrong: a tier that quietly
// changes what the bot already allowed before anybody configured it, and a
// tier that can be turned on the owner.

const OWNER = '175407464513011713';
const FRIEND = '412907556128374785';

async function world(t, cfg = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-tiers-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, cfg: { ownerUserId: OWNER, statusToken: 'x', askDailyLimit: 20, ...cfg } };
}

const run = (db, cfg, name, body) =>
  runAction({ pathname: `/actions/${name}`, body, db, cfg, ctx: { viewer: OPERATOR } });

// --- which tier somebody is on -------------------------------------------

test('everybody starts free, and free is tier zero', async (t) => {
  const { db, cfg } = await world(t);
  assert.equal(tierOf(db, cfg, FRIEND), FREE_TIER);
  assert.equal(FREE_TIER, 0);
});

// Tier 0 is falsy, so any `|| default` on this path would be a bug that only
// shows on the tier everybody is on.
test('a default of zero survives being read', async (t) => {
  const { db, cfg } = await world(t, { defaultTier: 0 });
  assert.equal(tierOf(db, cfg, FRIEND), 0);

  db.setTier(FRIEND, 0);
  assert.equal(tierOf(db, cfg, FRIEND), 0, 'an explicit tier 0 fell through to something else');
});

test('DEFAULT_TIER moves the floor without touching anybody already placed', async (t) => {
  const { db, cfg } = await world(t, { defaultTier: 3 });
  assert.equal(tierOf(db, cfg, FRIEND), 3);

  db.setTier(FRIEND, 2);
  assert.equal(tierOf(db, cfg, FRIEND), 2, 'a tier somebody chose was overruled by the default');
});

test('the owner is always on the top tier, whatever the table says', async (t) => {
  const { db, cfg } = await world(t, { defaultTier: 1 });
  db.setTier(OWNER, 1);

  assert.equal(tierOf(db, cfg, OWNER), TOP_TIER,
    'the owner was rate-limited out of their own API key');
});

test('a tier written by hand that is not a tier is discarded, not clamped', async (t) => {
  const { db, cfg } = await world(t);

  for (const junk of [5, 6, 7, 8, 10, -1, 2.5, 'gold', null]) {
    db.setTier(FRIEND, junk);
    assert.equal(tierOf(db, cfg, FRIEND), FREE_TIER, `${junk} became a tier`);
  }
});

test('isTier is the same answer everywhere, string or number', () => {
  for (const good of [0, 1, 2, 3, 4, 9, '0', '9']) assert.equal(isTier(good), true, String(good));
  // 5 to 8 are the hole in the numbering and are not tiers today. If one ever
  // becomes one it is a new entry in TIERS and nothing else moves, which is
  // the whole reason the hole is there.
  for (const bad of [5, 6, 7, 8, 10, -1, 2.5, '', 'four', null, undefined, NaN]) {
    assert.equal(isTier(bad), false, String(bad));
  }
  assert.deepEqual(TIERS, [0, 1, 2, 3, 4, 9]);
  assert.equal(TOP_TIER, 9);
});

// --- what a tier buys ----------------------------------------------------

test('with nothing configured every tier buys exactly what the bot allowed before', async (t) => {
  const { cfg } = await world(t);
  for (const tier of TIERS) assert.equal(askLimitFor(cfg, tier), 20, `tier ${tier}`);
});

test('a full map gives each tier its own number', async (t) => {
  const { cfg } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 2: 60, 3: 200, 4: 0, 9: 0 } });

  assert.equal(askLimitFor(cfg, 0), 5);
  assert.equal(askLimitFor(cfg, 1), 20);
  assert.equal(askLimitFor(cfg, 2), 60);
  assert.equal(askLimitFor(cfg, 3), 200);
  assert.equal(askLimitFor(cfg, 4), 0, 'zero is unlimited, as it always was');
  assert.equal(askLimitFor(cfg, 9), 0);
});

// A tier nobody wrote a number for inherits from the one below it. Reading
// downward cannot hand anybody more than was actually written; falling back to
// the old global could.
test('a tier nobody wrote a number for inherits from the tier below it', async (t) => {
  const { cfg } = await world(t, { tierAskLimits: { 0: 5, 4: 0 } });

  assert.equal(askLimitFor(cfg, 0), 5);
  assert.equal(askLimitFor(cfg, 1), 5, 'an undecided tier was quietly given the old default');
  assert.equal(askLimitFor(cfg, 2), 5);
  assert.equal(askLimitFor(cfg, 3), 5);
  assert.equal(askLimitFor(cfg, 4), 0);
  assert.equal(askLimitFor(cfg, 9), 0, 'the house inherits the top of the paid band');
});

test('with nothing written at or below them, the old global answers', async (t) => {
  const { cfg } = await world(t, { tierAskLimits: { 4: 0 } });

  assert.equal(askLimitFor(cfg, 0), 20, 'guessing unlimited is the wrong way to be wrong');
  assert.equal(askLimitFor(cfg, 4), 0);
});

test('a tier nobody recognises is answered as free, never as the house', async (t) => {
  const { cfg } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 9: 0 } });
  for (const junk of [7, 'gold', null, undefined]) {
    assert.equal(askLimitFor(cfg, junk), 5, String(junk));
  }
});

test('allowanceFor is the tier and its limit together, which is what a caller wants', async (t) => {
  const { db, cfg } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 2: 60, 3: 200, 4: 0 } });
  db.setTier(FRIEND, 3);

  assert.deepEqual(allowanceFor(db, cfg, FRIEND), { tier: 3, askLimit: 200 });
  assert.deepEqual(allowanceFor(db, cfg, OWNER), { tier: TOP_TIER, askLimit: 0 });
});

// --- the one place it is enforced ----------------------------------------

test('an install that has not configured tiers behaves exactly as it did before', async (t) => {
  const { db, cfg } = await world(t);

  const before = askAllowance(db, cfg, FRIEND);
  assert.equal(before.limit, 20);
  assert.equal(before.used, 0);
  assert.equal(before.allowed, true);

  for (let i = 0; i < 20; i += 1) db.countAsk(FRIEND);

  const after = askAllowance(db, cfg, FRIEND);
  assert.equal(after.allowed, false);
  assert.match(after.message, /daily limit/);
});

test('the ceiling on /ask is the asker\'s tier, not one number for everybody', async (t) => {
  const { db, cfg } = await world(t, { tierAskLimits: { 0: 2, 1: 40, 4: 120, 9: 0 } });
  db.setTier(FRIEND, 0);

  db.countAsk(FRIEND);
  assert.equal(askAllowance(db, cfg, FRIEND).allowed, true);
  db.countAsk(FRIEND);
  assert.equal(askAllowance(db, cfg, FRIEND).allowed, false, 'the free tier ran past its ceiling');

  // Moving them up gives them the rest of the day back, which is the point of
  // being able to change a tier at all.
  db.setTier(FRIEND, 1);
  const lifted = askAllowance(db, cfg, FRIEND);
  assert.equal(lifted.allowed, true);
  assert.equal(lifted.tier, 1);
  assert.equal(lifted.limit, 40);
  assert.equal(lifted.used, 2, 'what they had already spent was forgotten');
});

test('the top tier at zero is unlimited rather than locked out', async (t) => {
  const { db, cfg } = await world(t, { tierAskLimits: { 0: 2, 1: 40, 4: 120, 9: 0 } });
  db.setTier(FRIEND, 9);

  for (let i = 0; i < 500; i += 1) db.countAsk(FRIEND);

  const left = askAllowance(db, cfg, FRIEND);
  assert.equal(left.allowed, true);
  assert.equal(left.limit, 0);
  assert.equal(left.left, Infinity);
});

// --- the control ---------------------------------------------------------

test('setting a tier says what it now buys', async (t) => {
  const { db, cfg } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 2: 60, 3: 200 } });

  const res = await run(db, cfg, 'access/tier', { userId: FRIEND, tier: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.payload.tier, 3);
  assert.match(res.payload.message, /200 questions a day/);
  assert.equal(db.tierOf(FRIEND), 3);
});

test('tier zero is a tier you can be put on, not a missing value', async (t) => {
  const { db, cfg } = await world(t, { defaultTier: 2, tierAskLimits: { 0: 5, 2: 60 } });

  const res = await run(db, cfg, 'access/tier', { userId: FRIEND, tier: 0 });
  assert.equal(res.status, 200);
  assert.equal(res.payload.tier, 0);
  assert.equal(db.tierOf(FRIEND), 0);
  assert.equal(tierOf(db, cfg, FRIEND), 0, 'an explicit 0 was read back as the default');
  assert.equal(askLimitFor(cfg, tierOf(db, cfg, FRIEND)), 5);
});

test('and admits that the buttons do nothing yet when nothing is configured', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/tier', { userId: FRIEND, tier: 3 });
  assert.equal(res.status, 200);
  assert.match(res.payload.message, /TIER_ASK_LIMITS/,
    'four buttons that are all worth the same said nothing about being all worth the same');
});

test('a tier that is not a tier is refused rather than rounded', async (t) => {
  const { db, cfg } = await world(t);

  for (const bad of [5, 6, 7, 8, 10, -1, 'gold', null, undefined]) {
    const res = await run(db, cfg, 'access/tier', { userId: FRIEND, tier: bad });
    assert.equal(res.status, 400, String(bad));
  }
  assert.equal(db.tierOf(FRIEND), null);
});

test('the owner cannot be moved off the top tier', async (t) => {
  const { db, cfg } = await world(t);

  const res = await run(db, cfg, 'access/tier', { userId: OWNER, tier: 1 });
  assert.equal(res.status, 400);
  assert.match(res.payload.message, /OWNER_USER_ID/);
  assert.equal(tierOf(db, cfg, OWNER), TOP_TIER);
});

test('the tier is a third opinion and does not disturb the other two', async (t) => {
  const { db, cfg } = await world(t);
  db.createCampaign('guild-1', 'Cipher', FRIEND);

  await run(db, cfg, 'access/invite', { userId: FRIEND });
  await run(db, cfg, 'access/level', { userId: FRIEND, level: 'player' });
  await run(db, cfg, 'access/tier', { userId: FRIEND, tier: 4 });

  assert.equal(db.isInvited(FRIEND), true);
  assert.equal(db.capFor(FRIEND), 'player');
  assert.equal(db.tierOf(FRIEND), 4);

  // And a row still holding a tier is not litter, so it survives being taken
  // off the guest list.
  await run(db, cfg, 'access/uninvite', { userId: FRIEND });
  assert.equal(db.tierOf(FRIEND), 4, 'the tier went out with the invite');
  assert.equal(db.capFor(FRIEND), 'player');
});

// --- what the page is told -----------------------------------------------

test('the roster carries the tier, what it buys, and what has been spent of it', async (t) => {
  const { db, cfg } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 2: 60 } });
  db.setInvited(FRIEND, { username: 'fenwick' });
  db.setTier(FRIEND, 2);
  db.countAsk(FRIEND);
  db.countAsk(FRIEND);

  const row = accessRoster({ db, cfg }).people.find((p) => p.userId === FRIEND);

  assert.equal(row.tier, 2);
  assert.equal(row.askLimit, 60);
  assert.equal(row.asksToday, 2);
});

test('the page is told whether the tiers are worth different amounts yet', async (t) => {
  const flat = await world(t);
  assert.equal(accessRoster(flat).tiersDiffer, false);

  const graded = await world(t, { tierAskLimits: { 0: 5, 4: 0 } });
  assert.equal(accessRoster(graded).tiersDiffer, true);
  assert.deepEqual(accessRoster(graded).tiers, [0, 1, 2, 3, 4, 9]);
});
