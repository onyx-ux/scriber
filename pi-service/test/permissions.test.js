import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { isOwner, isManager, refuseUnlessOwner, refuseUnlessManager } from '../src/campaign/permissions.js';

const OWNER = 'owner-1';
const DM = 'dungeon-master';
const PLAYER = 'random-player';
const cfg = { ownerUserId: OWNER };

async function tmpDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-perms-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// --- claiming ---

test('naming a campaign claims it for whoever named it', async (t) => {
  const db = await tmpDb(t);

  assert.equal(db.getCampaignManager('G'), null, 'unclaimed to begin with');
  assert.equal(db.claimCampaign('G', DM), DM);
  assert.equal(db.getCampaignManager('G'), DM);
});

// The claim is what makes /campaign safe to call unconditionally: it does not
// need a separate "is it claimed?" read that could race with itself.
test('a second person naming it does not take it over', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);

  assert.equal(db.claimCampaign('G', PLAYER), DM, 'still the original manager');
});

test('claiming does not disturb the session counter', async (t) => {
  const db = await tmpDb(t);
  db.createMeeting({ guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/tmp' });
  const before = db.listCampaigns();

  db.claimCampaign('G', DM);
  db.setCampaignName('G', 'Cipher');

  assert.equal(db.raw.prepare('SELECT next_session FROM campaigns WHERE guild_id = ?').get('G').next_session, 2);
  assert.equal(before.length, db.listCampaigns().length);
});

test('a campaign can be handed over', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);
  db.setCampaignManager('G', PLAYER);
  assert.equal(db.getCampaignManager('G'), PLAYER);
});

// Existing campaigns predate the idea of a manager. Left unclaimed, the first
// person to run /campaign in one would take over a table they never ran.
test('campaigns that predate management are adopted by the owner, once', async (t) => {
  const db = await tmpDb(t);
  db.setCampaignName('OLD-A', 'Cipher');
  db.setCampaignName('OLD-B', 'Other');
  db.claimCampaign('ALREADY-RUN', DM);

  assert.equal(db.adoptUnmanagedCampaigns(OWNER), 2);
  assert.equal(db.getCampaignManager('OLD-A'), OWNER);
  assert.equal(db.getCampaignManager('ALREADY-RUN'), DM, 'a claimed campaign is left alone');
  assert.equal(db.adoptUnmanagedCampaigns(OWNER), 0, 'and a second boot changes nothing');
});

// --- who may do what ---

test('the manager runs their own campaign; a player does not', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);

  assert.equal(isManager(DM, db, 'G', cfg), true);
  assert.equal(isManager(PLAYER, db, 'G', cfg), false);
  assert.equal(refuseUnlessManager(DM, db, 'G', cfg), null);
  assert.match(refuseUnlessManager(PLAYER, db, 'G', cfg), /runs this campaign/);
});

// Deliberately NOT Discord's Manage Server: the person running the game is
// often not the person administering the server.
test('managing one campaign gives nothing in another', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('MINE', DM);
  db.claimCampaign('THEIRS', PLAYER);

  assert.equal(isManager(DM, db, 'THEIRS', cfg), false);
  assert.ok(refuseUnlessManager(DM, db, 'THEIRS', cfg));
});

// Somebody has to be able to unstick a campaign whose manager left.
test('the bot owner can act on any campaign', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);

  assert.equal(isOwner(OWNER, cfg), true);
  assert.equal(isManager(OWNER, db, 'G', cfg), true);
  assert.equal(refuseUnlessManager(OWNER, db, 'G', cfg), null);
});

test('an unclaimed campaign tells you how to claim it', async (t) => {
  const db = await tmpDb(t);
  assert.match(refuseUnlessManager(PLAYER, db, 'G', cfg), /Nobody has claimed this campaign/);
  assert.match(refuseUnlessManager(PLAYER, db, 'G', cfg), /\/campaign name:/);
});

test('the pipeline is the owner alone, manager or not', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);

  assert.equal(refuseUnlessOwner(OWNER, cfg), null);
  assert.match(refuseUnlessOwner(DM, cfg), /bot owner/);
  assert.match(refuseUnlessOwner(PLAYER, cfg), /bot owner/);
});

// With no owner configured there is nobody to check against. Refusing
// everyone would lock the pipeline out of a fresh install entirely.
test('an unconfigured owner locks the pipeline rather than opening it', () => {
  assert.ok(refuseUnlessOwner(PLAYER, {}), 'still refused');
  assert.equal(isOwner(PLAYER, {}), false);
});

// --- the gate table matches the tiers ---

test('the command surface splits into the three intended tiers', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.DISCORD_CLIENT_ID ||= 'x';
  process.env.GEMINI_API_KEY ||= 'x';
  const { commandDefs, OWNER_ONLY, MANAGER_ONLY } = await import('../src/commands/index.js');

  assert.deepEqual(
    [...OWNER_ONLY].sort(),
    ['approve', 'export', 'import', 'pause', 'pending', 'resume', 'status', 'summarise', 'transcribe'],
    'the pipeline'
  );
  assert.deepEqual([...MANAGER_ONLY].sort(), ['correct', 'corrections', 'dm', 'uncorrect'], "the campaign's records");

  // What is left is what the table itself may run. /campaign is here because
  // an unclaimed campaign has to be claimable; its handler does that check.
  const open = commandDefs
    .map((c) => c.name)
    .filter((n) => !OWNER_ONLY.has(n) && !MANAGER_ONLY.has(n))
    .sort();
  assert.deepEqual(open, [
    'archive', 'ask', 'campaign', 'funny', 'history', 'join', 'leave',
    'locations', 'npcs', 'recap', 'search', 'setcharacter', 'stats', 'whoami',
  ]);

  // Nothing gated is reachable from a user install — those are read-only.
  const userInstallable = commandDefs.filter((c) => c.integration_types.includes(1)).map((c) => c.name);
  assert.ok(
    userInstallable.every((n) => !OWNER_ONLY.has(n) && !MANAGER_ONLY.has(n)),
    'a user-installed command cannot be a gated one'
  );
});
