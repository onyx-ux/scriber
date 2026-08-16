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
    ['approve', 'export', 'import', 'pause', 'pending', 'resume', 'summarise', 'transcribe'],
    'the pipeline'
  );
  assert.deepEqual(
    [...MANAGER_ONLY].sort(),
    ['correct', 'corrections', 'dm', 'status', 'uncorrect'],
    "the campaign's records, plus the read-only /status"
  );

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

// --- campaigns as things in their own right ---

test('a guild can hold more than one campaign', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Curse of Strahd', PLAYER);

  assert.notEqual(a, b);
  assert.deepEqual(db.listCampaignsInGuild('G').map((c) => c.name), ['Cipher', 'Curse of Strahd']);
  assert.equal(db.getCampaign(a).manager_user_id, DM);
  assert.equal(db.getCampaign(b).manager_user_id, PLAYER, 'each has its own manager');
});

// The guild-keyed methods have to keep working while the call sites still
// speak in guild ids, so they resolve to the guild's OLDEST campaign.
test('guild-keyed methods resolve to the oldest campaign in the guild', async (t) => {
  const db = await tmpDb(t);
  const first = db.createCampaign('G', 'Cipher', DM);
  db.createCampaign('G', 'Second Game', PLAYER);

  assert.equal(db.defaultCampaignId('G'), first);
  assert.equal(db.getCampaignName('G'), 'Cipher');
  assert.equal(db.getCampaignManager('G'), DM);
});

test('a guild with no campaign gets one on demand', async (t) => {
  const db = await tmpDb(t);
  const id = db.defaultCampaignId('BRAND-NEW');
  assert.ok(id);
  assert.equal(db.defaultCampaignId('BRAND-NEW'), id, 'and not a second one');
});

test('each campaign numbers its own sessions', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Second Game', DM);

  const make = (campaignId) =>
    db.getMeeting(
      db.createMeeting({ guildId: 'G', campaignId, channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t' })
    );

  assert.equal(make(a).session_number, 1);
  assert.equal(make(a).session_number, 2);
  assert.equal(make(b).session_number, 1, 'the second campaign starts at one');
  assert.equal(make(b).campaign_id, b);
});

// --- membership ---

test('the manager is a member of their own campaign before speaking', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  assert.equal(db.isCampaignMember(id, DM), true);
  assert.equal(db.isCampaignMember(id, PLAYER), false);
});

test('claiming a campaign enrols the claimer', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);
  assert.equal(db.isCampaignMember(db.defaultCampaignId('G'), DM), true);
});

test('membership is per campaign, not per server', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Second Game', DM);
  db.addCampaignMember(a, PLAYER, DM);

  assert.equal(db.isCampaignMember(a, PLAYER), true);
  assert.equal(db.isCampaignMember(b, PLAYER), false, 'same server, different table');
});

test('adding the same member twice is a no-op', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  assert.equal(db.addCampaignMember(id, PLAYER, DM), 1);
  assert.equal(db.addCampaignMember(id, PLAYER, DM), 0);
  assert.equal(db.listCampaignMembers(id).length, 2, 'manager + player');
});

// This is what /join offers. Deliberately different from listCampaignsForUser,
// which is "has spoken" — a player added to a brand new campaign belongs to it
// before they have said a word.
test('listCampaignsForMember covers a player who has never spoken', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.addCampaignMember(id, PLAYER, DM);

  assert.deepEqual(db.listCampaignsForMember(PLAYER).map((c) => c.name), ['Cipher']);
  assert.deepEqual(db.listCampaignsForUser(PLAYER), [], 'and has still spoken in none');
});

test('a removed member is no longer offered the campaign', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.addCampaignMember(id, PLAYER, DM);

  assert.equal(db.removeCampaignMember(id, PLAYER), 1);
  assert.deepEqual(db.listCampaignsForMember(PLAYER), []);
});

// --- where a campaign's notes go ---

// NOTES_TO_OWNER_DM is one setting for every table the bot serves. A campaign
// wanting its recaps in #session-notes and another wanting them DM'd cannot
// both be expressed that way, so the choice belongs on the campaign.
test('a campaign chooses its own output, and it survives a rename', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);
  const meeting = db.createMeeting({
    guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t',
  });

  assert.equal(db.getOutputForMeeting(meeting).mode, null, 'starts on the bot default');

  db.setCampaignOutput('G', 'channel', 'CHAN-123');
  assert.deepEqual(
    (({ mode, channelId, managerUserId }) => ({ mode, channelId, managerUserId }))(db.getOutputForMeeting(meeting)),
    { mode: 'channel', channelId: 'CHAN-123', managerUserId: DM }
  );

  db.setCampaignName('G', 'Renamed');
  assert.equal(db.getOutputForMeeting(meeting).mode, 'channel', 'renaming does not reset it');
});

// A campaign's DM goes to its MANAGER, not the bot owner — it is their game.
test('DM output carries the manager, so delivery knows who to write to', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);
  const meeting = db.createMeeting({
    guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t',
  });

  db.setCampaignOutput('G', 'dm');
  const out = db.getOutputForMeeting(meeting);
  assert.equal(out.mode, 'dm');
  assert.equal(out.managerUserId, DM);
  assert.equal(out.channelId, null);
});

test('clearing the choice falls back to the bot default', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign('G', DM);
  const meeting = db.createMeeting({
    guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t',
  });

  db.setCampaignOutput('G', 'dm');
  db.setCampaignOutput('G', null);
  assert.equal(db.getOutputForMeeting(meeting).mode, null);
});

test('two campaigns in one server can send their notes to different places', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Second Game', PLAYER);
  const inA = db.createMeeting({ guildId: 'G', campaignId: a, channelId: 'C', channelName: 'x', startedAt: 'n', audioDir: '/t' });
  const inB = db.createMeeting({ guildId: 'G', campaignId: b, channelId: 'C', channelName: 'x', startedAt: 'n', audioDir: '/t' });

  db.raw.prepare('UPDATE campaigns SET output_mode = ?, output_channel_id = ? WHERE id = ?').run('channel', 'A-CHAN', a);
  db.raw.prepare('UPDATE campaigns SET output_mode = ? WHERE id = ?').run('dm', b);

  assert.equal(db.getOutputForMeeting(inA).channelId, 'A-CHAN');
  assert.equal(db.getOutputForMeeting(inB).mode, 'dm');
  assert.equal(db.getOutputForMeeting(inB).managerUserId, PLAYER);
});

// --- /join is gated on the bot's own roster ---

const { resolveJoinCampaign } = await import('../src/commands/index.js');

const joining = (guildId, userId, campaign = null) => ({
  guildId,
  user: { id: userId },
  options: { getString: (n) => (n === 'campaign' ? campaign : null) },
});

// In a server the bot was merely invited to, being able to see a voice
// channel is not permission to record the game happening in it.
test('someone not on the roster cannot start a recording', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', DM);

  const { error, campaign } = resolveJoinCampaign(joining('G', PLAYER), db);
  assert.equal(campaign, undefined);
  assert.match(error, /not on the roster/);
  assert.match(error, /\/dm character/, 'and says how to get on it');
});

test('the manager can always start their own campaign', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  assert.equal(resolveJoinCampaign(joining('G', DM), db).campaign.id, id);
});

test('a player added to the roster can start a recording', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.addCampaignMember(id, PLAYER, DM);
  assert.equal(resolveJoinCampaign(joining('G', PLAYER), db).campaign.id, id);
});

// Membership in one server says nothing about another.
test('being at a table elsewhere does not let you record here', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('ELSEWHERE', 'Cipher', PLAYER);
  db.createCampaign('HERE', 'Someone Elses Game', DM);

  assert.match(resolveJoinCampaign(joining('HERE', PLAYER), db).error, /not on the roster/);
});

test('two tables in one server ask which, and name them', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Curse of Strahd', DM);

  const { error } = resolveJoinCampaign(joining('G', DM), db);
  assert.match(error, /more than one table/);
  assert.match(error, /Cipher/);
  assert.match(error, /Curse of Strahd/);

  assert.equal(resolveJoinCampaign(joining('G', DM, String(a)), db).campaign.id, a);
  assert.equal(resolveJoinCampaign(joining('G', DM, String(b)), db).campaign.id, b);
});

test('naming a campaign you are not on the roster for is refused', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', DM);
  const theirs = db.createCampaign('G', 'Private Game', PLAYER);
  db.addCampaignMember(db.defaultCampaignId('G'), 'newbie', DM);

  assert.match(resolveJoinCampaign(joining('G', 'newbie', String(theirs)), db).error, /roster for here/);
});
