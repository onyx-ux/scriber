import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  createCampaign, guildsCreatableBy,
  MAX_CAMPAIGNS_PER_GUILD, MAX_CAMPAIGNS_PER_MANAGER,
} from '../src/campaign/create.js';
import { buildViewer, OPERATOR } from '../src/web/viewer.js';
import { runAction } from '../src/web/actions.js';

// Starting a campaign, from either front door.
//
// The rules used to live inside the slash command. The dashboard now performs
// the same act, and the reason these tests exist is that a second copy of the
// rules would drift — the folder-clash check especially, which is not obvious
// and whose failure mode is two campaigns quietly interleaving their notes.
//
// So the interesting tests here are not "can you make a campaign". They are
// "does the web page get to decide anything the slash command does not", and
// the answer has to stay no.

const DEV = '10000000000000001';
const OWNER = '20000000000000002';
const CREATOR = '30000000000000003';
const PLAYER = '40000000000000004';
const STRANGER = '50000000000000005';

const cfg = { ownerUserId: DEV, statusToken: 'secret' };

const GUILDS = [
  { id: 'guild-1', name: 'The Cellar' },
  { id: 'guild-2', name: 'Somewhere Else' },
];

// Who is actually in which Discord.
//
// This is the whole gate now, so it is stated here rather than derived from
// anything in the database. The point of the rule is that it asks Discord and
// not the bot's own records: somebody can be in a server having never spoken,
// never been rostered and never created anything, and they may still start a
// table there — which is exactly what typing /campaign create in that server
// would do.
const IN_GUILD = {
  [OWNER]: ['guild-1'],
  [CREATOR]: ['guild-2'],
  [PLAYER]: ['guild-1'],
  [STRANGER]: [],
};

const isMember = async (guildId, userId) => (IN_GUILD[userId] ?? []).includes(guildId);

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-create-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

const ctxFor = (viewer) => ({
  viewer,
  guilds: () => GUILDS,
  // The one part of `ctx` this act needs Discord for. Injected the same way
  // the real bridge is, so the rule can be exercised without a logged-in bot.
  discord: { isMemberOf: (guildId, userId) => isMember(guildId, userId) },
});

// Awaited: the membership check is a REST read in the real thing, so the
// action is async and so is every call to it below.
const create = (db, body, viewer) =>
  runAction({ pathname: '/actions/campaign/create', body, db, cfg, ctx: ctxFor(viewer) });

// --- the rules, which belong to neither surface ---

test('a campaign is made, and the person who asked runs it', async (t) => {
  const { db } = await world(t);
  const made = createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: 'Cipher' });

  assert.equal(made.ok, true);
  assert.equal(db.getCampaign(made.id).manager_user_id, CREATOR);
  assert.equal(db.getCampaign(made.id).guild_id, 'guild-1');
});

test('a name with nothing filable in it is refused', async (t) => {
  const { db } = await world(t);
  const made = createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: '🎲🎲🎲' });

  assert.equal(made.ok, false);
  assert.equal(made.reason, 'unusable');
});

// The check that is easy to leave out of a second implementation, and the one
// whose absence is worst: two campaigns sharing a folder interleave their notes.
test('a name that would share a folder with an existing campaign is refused', async (t) => {
  const { db } = await world(t);
  createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: 'Cipher' });

  const clash = createCampaign({ db, cfg, guildId: 'guild-2', userId: OWNER, name: 'cipher' });
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, 'clash');
  assert.match(clash.message, /interleave/);
});

// Ten campaigns in one Discord, spread across enough managers that nobody hits
// their own tier ceiling on the way — which is what makes this a test of the
// per-GUILD ceiling rather than an accidental test of the per-person one.
test('the ceilings hold for other people', async (t) => {
  const { db } = await world(t);
  for (let i = 0; i < MAX_CAMPAIGNS_PER_GUILD; i += 1) {
    const who = `9${String(i).padStart(17, '0')}`;
    assert.equal(createCampaign({ db, cfg, guildId: 'guild-1', userId: who, name: `Table ${i}` }).ok, true);
  }

  const full = createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: 'One More' });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'guild-full');
});

// --- what a tier is worth, at the point that spends ---

test('the free tier runs five campaigns and is then told so', async (t) => {
  const { db } = await world(t);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: `Table ${i}` }).ok, true);
  }

  const full = createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: 'One More' });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'tier-full');
  assert.equal(full.limit, 5);
});

test('tier one runs ten', async (t) => {
  const { db } = await world(t);
  db.setTier(CREATOR, 1);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(createCampaign({ db, cfg, guildId: `guild-${i}`, userId: CREATOR, name: `Table ${i}` }).ok, true);
  }

  const full = createCampaign({ db, cfg, guildId: 'guild-x', userId: CREATOR, name: 'One More' });
  assert.equal(full.reason, 'tier-full');
  assert.equal(full.limit, 10);
});

// The refusal has to name the way out, and the way out is deleting one — not
// asking the operator for a tier, which most people have no idea exists.
test('the refusal says what frees a place, and that joining is free', async (t) => {
  const { db } = await world(t);
  for (let i = 0; i < 5; i += 1) {
    createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: `Table ${i}` });
  }

  const full = createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: 'One More' });
  assert.match(full.message, /Deleting one/i);
  assert.match(full.message, /never counted/i, 'somebody at six tables should not think they are the problem');
});

test('the operator is not metered on campaigns', async (t) => {
  const { db } = await world(t);
  for (let i = 0; i < 8; i += 1) {
    assert.equal(createCampaign({ db, cfg, guildId: `guild-${i}`, userId: DEV, name: `Table ${i}` }).ok, true);
  }
});

test('the ceilings do not hold for the operator, whose Pi it is', async (t) => {
  const { db } = await world(t);
  for (let i = 0; i < MAX_CAMPAIGNS_PER_GUILD + 2; i += 1) {
    assert.equal(createCampaign({ db, cfg, guildId: 'guild-1', userId: DEV, name: `Table ${i}` }).ok, true);
  }
});

test('a campaign has to belong to a server', async (t) => {
  const { db } = await world(t);
  assert.equal(createCampaign({ db, cfg, guildId: null, userId: DEV, name: 'Cipher' }).reason, 'no-guild');
  assert.equal(createCampaign({ db, cfg, guildId: 'guild-1', userId: DEV, name: '  ' }).reason, 'no-name');
});

// --- which servers are on offer ---
//
// The rule is membership and nothing else. It used to be `can.manage` plus a
// guild you own or already run a campaign in, which made a FIRST campaign
// impossible for anybody who was not a Discord's owner: you had to run one to
// be offered the chance to make one. Meanwhile the slash command had no gate
// at all. These tests hold the two surfaces to the same answer.

test('the operator may start one anywhere the bot is', async (t) => {
  await world(t);
  assert.deepEqual(await guildsCreatableBy({ viewer: OPERATOR, guilds: GUILDS, isMember }), GUILDS);
});

test('a server owner may start one where they are, not merely where they own', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: OWNER, guildsOwned: ['guild-1'] });

  assert.deepEqual(
    (await guildsCreatableBy({ viewer, guilds: GUILDS, isMember })).map((g) => g.id),
    ['guild-1']
  );
});

// Running a campaign in guild-2 is no longer what qualifies them — being in
// guild-2 is. The two happen to agree here, and the next test is the one that
// proves which of them the code is actually reading.
test('a creator may start another where they already run one', async (t) => {
  const { db } = await world(t);
  db.createCampaign('guild-2', 'Strahd', CREATOR);
  const viewer = buildViewer({ db, cfg, userId: CREATOR });

  assert.deepEqual(
    (await guildsCreatableBy({ viewer, guilds: GUILDS, isMember })).map((g) => g.id),
    ['guild-2']
  );
});

// The case the old rule got wrong, and the reason for the change. Somebody who
// plays at a table owns no Discord and runs no campaign, so they were offered
// nothing and the button never drew — while `/campaign create`, three seconds
// away in the same server, would have worked.
test('a player may start one in a server they are in', async (t) => {
  const { db } = await world(t);
  const cipher = db.createCampaign('guild-1', 'Cipher', CREATOR);
  db.setConsent(cipher, PLAYER, true);
  const viewer = buildViewer({ db, cfg, userId: PLAYER });

  assert.deepEqual(
    (await guildsCreatableBy({ viewer, guilds: GUILDS, isMember })).map((g) => g.id),
    ['guild-1'],
    'the table they play at'
  );
});

// Membership is the gate, so somebody with none passes nothing — no level,
// however high, substitutes for being in the room.
test('somebody in none of the servers is offered none of them', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: STRANGER, guildsOwned: [] });

  assert.deepEqual(await guildsCreatableBy({ viewer, guilds: GUILDS, isMember }), []);
});

test('nobody at all is offered nothing, without Discord being asked', async (t) => {
  await world(t);
  let asked = 0;
  const counting = async (...args) => { asked += 1; return isMember(...args); };
  const nobody = { userId: null, can: { everything: false } };

  assert.deepEqual(await guildsCreatableBy({ viewer: nobody, guilds: GUILDS, isMember: counting }), []);
  assert.equal(asked, 0, 'an unsigned request is refused before it costs a REST call');
});

// --- the dashboard action ---

test('the dashboard makes one, and says which it made', async (t) => {
  const { db } = await world(t);
  const res = await create(db, { name: 'Cipher', guildId: 'guild-1' }, OPERATOR);

  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.campaignId);
  assert.equal(db.getCampaign(res.payload.campaignId).name, 'Cipher');
});

// The field that decides who may change a campaign for the rest of its life is
// the one field a caller must never get to choose.
test('the manager comes from the session, never from the body', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: OWNER, guildsOwned: ['guild-1'] });

  const res = await create(db, { name: 'Cipher', guildId: 'guild-1', userId: PLAYER, managerUserId: PLAYER }, viewer);
  assert.equal(res.payload.ok, true);
  assert.equal(db.getCampaign(res.payload.campaignId).manager_user_id, OWNER, 'not the id in the body');
});

test('with login off the campaign belongs to the bot owner rather than nobody', async (t) => {
  const { db } = await world(t);
  const res = await create(db, { name: 'Cipher', guildId: 'guild-1' }, OPERATOR);

  assert.equal(db.getCampaign(res.payload.campaignId).manager_user_id, DEV);
});

// The server is resolved against what this viewer may create in, rather than
// trusted from the body — otherwise the picker is advisory and the API is not.
test('a server the viewer may not create in is refused even if the body names it', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: OWNER, guildsOwned: ['guild-1'] });

  const res = await create(db, { name: 'Cipher', guildId: 'guild-2' }, viewer);
  assert.equal(res.status, 400);
  assert.equal(db.listCampaigns().length, 0, 'they own guild-1 and are in no other');
});

// The point of the whole change, end to end through the action rather than
// through the rule on its own.
test('a player makes their first campaign, owning nothing and running nothing', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: PLAYER });

  const res = await create(db, { name: 'Cipher', guildId: 'guild-1' }, viewer);
  assert.equal(res.payload.ok, true);
  assert.equal(db.getCampaign(res.payload.campaignId).manager_user_id, PLAYER, 'and they run it');
});

test('a server the bot is not even in is refused', async (t) => {
  const { db } = await world(t);
  const res = await create(db, { name: 'Cipher', guildId: 'guild-999' }, OPERATOR);

  assert.equal(res.status, 400);
  assert.equal(db.listCampaigns().length, 0);
});

test('somebody in none of these servers is told what to do about it', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: STRANGER });

  const res = await create(db, { name: 'Cipher', guildId: 'guild-1' }, viewer);
  assert.equal(res.status, 400);
  assert.match(res.payload.message, /not in a server/i);
  assert.equal(db.listCampaigns().length, 0);
});

// The picker is a convenience; this is the check that holds. A guild id is
// eighteen digits and the browser is free to send any of them.
test('a member of one server cannot create in another by naming it', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: PLAYER });

  const res = await create(db, { name: 'Cipher', guildId: 'guild-2' }, viewer);
  assert.equal(res.status, 400);
  assert.equal(db.listCampaigns().length, 0, 'guild-2 is a server they are not in');
});

test('an unidentified caller cannot make one at all', async (t) => {
  const { db } = await world(t);
  const nobody = buildViewer({ db, cfg: { ...cfg, ownerUserId: null }, userId: null });

  const res = await create(db, { name: 'Cipher', guildId: 'guild-1' }, nobody);
  assert.equal(res.status, 403);
  assert.equal(db.listCampaigns().length, 0);
});

// --- the two doors agree ---

test('the dashboard refuses exactly what the slash command refuses', async (t) => {
  const { db } = await world(t);
  createCampaign({ db, cfg, guildId: 'guild-1', userId: DEV, name: 'Cipher' });

  for (const name of ['🎲', 'cipher', '   ']) {
    const direct = createCampaign({ db, cfg, guildId: 'guild-1', userId: DEV, name });
    const web = await create(db, { name, guildId: 'guild-1' }, OPERATOR);

    assert.equal(direct.ok, false, `${name} should be refused`);
    assert.equal(web.payload.ok, false, `${name} should be refused on the web too`);
    assert.equal(web.payload.message, direct.message, 'and for the same stated reason');
  }
});
