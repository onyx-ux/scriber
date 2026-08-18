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

const cfg = { ownerUserId: DEV, statusToken: 'secret' };

const GUILDS = [
  { id: 'guild-1', name: 'The Cellar' },
  { id: 'guild-2', name: 'Somewhere Else' },
];

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-create-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

const ctxFor = (viewer) => ({ viewer, guilds: () => GUILDS });

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

test('the ceilings hold for other people', async (t) => {
  const { db } = await world(t);
  for (let i = 0; i < MAX_CAMPAIGNS_PER_GUILD; i += 1) {
    assert.equal(createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: `Table ${i}` }).ok, true);
  }

  const full = createCampaign({ db, cfg, guildId: 'guild-1', userId: CREATOR, name: 'One More' });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'guild-full');
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

test('the operator may start one anywhere the bot is', async (t) => {
  const { db } = await world(t);
  assert.deepEqual(guildsCreatableBy({ db, viewer: OPERATOR, guilds: GUILDS }), GUILDS);
});

test('a server owner may start one in the server they own, and nowhere else', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: OWNER, guildsOwned: ['guild-1'] });

  assert.deepEqual(guildsCreatableBy({ db, viewer, guilds: GUILDS }).map((g) => g.id), ['guild-1']);
});

test('a creator may start another where they already run one', async (t) => {
  const { db } = await world(t);
  db.createCampaign('guild-2', 'Strahd', CREATOR);
  const viewer = buildViewer({ db, cfg, userId: CREATOR });

  assert.deepEqual(guildsCreatableBy({ db, viewer, guilds: GUILDS }).map((g) => g.id), ['guild-2']);
});

// A player is offered nothing, and that is not a hole: the dashboard is
// optional, and `/campaign create` is still there for them.
test('a player is offered no server, and the button never draws', async (t) => {
  const { db } = await world(t);
  const cipher = db.createCampaign('guild-1', 'Cipher', CREATOR);
  db.setConsent(cipher, PLAYER, true);
  const viewer = buildViewer({ db, cfg, userId: PLAYER });

  assert.deepEqual(guildsCreatableBy({ db, viewer, guilds: GUILDS }), []);
});

// --- the dashboard action ---

test('the dashboard makes one, and says which it made', async (t) => {
  const { db } = await world(t);
  const res = create(db, { name: 'Cipher', guildId: 'guild-1' }, OPERATOR);

  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.campaignId);
  assert.equal(db.getCampaign(res.payload.campaignId).name, 'Cipher');
});

// The field that decides who may change a campaign for the rest of its life is
// the one field a caller must never get to choose.
test('the manager comes from the session, never from the body', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: OWNER, guildsOwned: ['guild-1'] });

  const res = create(db, { name: 'Cipher', guildId: 'guild-1', userId: PLAYER, managerUserId: PLAYER }, viewer);
  assert.equal(res.payload.ok, true);
  assert.equal(db.getCampaign(res.payload.campaignId).manager_user_id, OWNER, 'not the id in the body');
});

test('with login off the campaign belongs to the bot owner rather than nobody', async (t) => {
  const { db } = await world(t);
  const res = create(db, { name: 'Cipher', guildId: 'guild-1' }, OPERATOR);

  assert.equal(db.getCampaign(res.payload.campaignId).manager_user_id, DEV);
});

// The server is resolved against what this viewer may create in, rather than
// trusted from the body — otherwise the picker is advisory and the API is not.
test('a server the viewer may not create in is refused even if the body names it', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: OWNER, guildsOwned: ['guild-1'] });

  const res = create(db, { name: 'Cipher', guildId: 'guild-2' }, viewer);
  assert.equal(res.status, 400);
  assert.equal(db.listCampaigns().length, 0);
});

test('a server the bot is not even in is refused', async (t) => {
  const { db } = await world(t);
  const res = create(db, { name: 'Cipher', guildId: 'guild-999' }, OPERATOR);

  assert.equal(res.status, 400);
  assert.equal(db.listCampaigns().length, 0);
});

test('somebody with nowhere to put one is told so, not given an empty refusal', async (t) => {
  const { db } = await world(t);
  const viewer = buildViewer({ db, cfg, userId: PLAYER });

  const res = create(db, { name: 'Cipher', guildId: 'guild-1' }, viewer);
  assert.equal(res.status, 400);
  assert.match(res.payload.message, /no server/i);
});

test('an unidentified caller cannot make one at all', async (t) => {
  const { db } = await world(t);
  const nobody = buildViewer({ db, cfg: { ...cfg, ownerUserId: null }, userId: null });

  const res = create(db, { name: 'Cipher', guildId: 'guild-1' }, nobody);
  assert.equal(res.status, 403);
  assert.equal(db.listCampaigns().length, 0);
});

// --- the two doors agree ---

test('the dashboard refuses exactly what the slash command refuses', async (t) => {
  const { db } = await world(t);
  createCampaign({ db, cfg, guildId: 'guild-1', userId: DEV, name: 'Cipher' });

  for (const name of ['🎲', 'cipher', '   ']) {
    const direct = createCampaign({ db, cfg, guildId: 'guild-1', userId: DEV, name });
    const web = create(db, { name, guildId: 'guild-1' }, OPERATOR);

    assert.equal(direct.ok, false, `${name} should be refused`);
    assert.equal(web.payload.ok, false, `${name} should be refused on the web too`);
    assert.equal(web.payload.message, direct.message, 'and for the same stated reason');
  }
});
