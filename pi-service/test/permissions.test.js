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

// A guild's default campaign — its oldest, and for a fresh test database its
// only one. Everything is keyed on campaign ids now, so a test that means "the
// campaign in server G" has to say so.
const only = (db, guildId) => db.forTests.defaultCampaignId(guildId);

// --- claiming ---

test('claiming a campaign gives it to whoever claimed it', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');

  assert.equal(db.getCampaignManager(g), null, 'unclaimed to begin with');
  assert.equal(db.claimCampaign(g, DM), DM);
  assert.equal(db.getCampaignManager(g), DM);
});

// The claim is what makes it safe to call unconditionally: it does not need a
// separate "is it claimed?" read that could race with itself.
test('a second person claiming it does not take it over', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);

  assert.equal(db.claimCampaign(g, PLAYER), DM, 'still the original manager');
});

test('claiming does not disturb the session counter', async (t) => {
  const db = await tmpDb(t);
  db.createMeeting({ guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/tmp' });
  const before = db.listCampaigns();
  const g = only(db, 'G');

  db.claimCampaign(g, DM);
  db.setCampaignName(g, 'Cipher');

  assert.equal(db.raw.prepare('SELECT next_session FROM campaigns WHERE id = ?').get(g).next_session, 2);
  assert.equal(before.length, db.listCampaigns().length);
});

test('a campaign can be handed over', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);
  db.setCampaignManager(g, PLAYER);
  assert.equal(db.getCampaignManager(g), PLAYER);
  assert.equal(db.isCampaignMember(g, PLAYER), true, 'the new manager is on their own roster');
});

// Existing campaigns predate the idea of a manager. Left unclaimed, the first
// person to run /campaign in one would take over a table they never ran.
test('campaigns that predate management are adopted by the owner, once', async (t) => {
  const db = await tmpDb(t);
  db.setCampaignName(only(db, 'OLD-A'), 'Cipher');
  db.setCampaignName(only(db, 'OLD-B'), 'Other');
  db.claimCampaign(only(db, 'ALREADY-RUN'), DM);

  assert.equal(db.adoptUnmanagedCampaigns(OWNER), 2);
  assert.equal(db.getCampaignManager(only(db, 'OLD-A')), OWNER);
  assert.equal(db.getCampaignManager(only(db, 'ALREADY-RUN')), DM, 'a claimed campaign is left alone');
  assert.equal(db.adoptUnmanagedCampaigns(OWNER), 0, 'and a second boot changes nothing');
});

// --- who may do what ---

test('the manager runs their own campaign; a player does not', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);

  assert.equal(isManager(DM, db, g, cfg), true);
  assert.equal(isManager(PLAYER, db, g, cfg), false);
  assert.equal(refuseUnlessManager(DM, db, g, cfg), null);
  assert.match(refuseUnlessManager(PLAYER, db, g, cfg), /runs this campaign/);
});

// Deliberately NOT Discord's Manage Server: the person running the game is
// often not the person administering the server.
test('managing one campaign gives nothing in another', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign(only(db, 'MINE'), DM);
  const theirs = only(db, 'THEIRS');
  db.claimCampaign(theirs, PLAYER);

  assert.equal(isManager(DM, db, theirs, cfg), false);
  assert.ok(refuseUnlessManager(DM, db, theirs, cfg));
});

// The same holds WITHIN one server, which is the whole point of campaigns
// having their own ids: running one table is not running the other.
test('managing one campaign gives nothing in the other one in the same server', async (t) => {
  const db = await tmpDb(t);
  const mine = db.createCampaign('G', 'Cipher', DM);
  const theirs = db.createCampaign('G', 'Strahd', PLAYER);

  assert.equal(isManager(DM, db, mine, cfg), true);
  assert.equal(isManager(DM, db, theirs, cfg), false, 'same Discord, different table');
  assert.match(refuseUnlessManager(DM, db, theirs, cfg), /runs this campaign/);
});

// Somebody has to be able to unstick a campaign whose manager left.
test('the bot owner can act on any campaign', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);

  assert.equal(isOwner(OWNER, cfg), true);
  assert.equal(isManager(OWNER, db, g, cfg), true);
  assert.equal(refuseUnlessManager(OWNER, db, g, cfg), null);
});

test('an unclaimed campaign tells you how to claim it', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  assert.match(refuseUnlessManager(PLAYER, db, g, cfg), /Nobody has claimed this campaign/);
  assert.match(refuseUnlessManager(PLAYER, db, g, cfg), /\/campaign create/);
});

test('the pipeline is the owner alone, manager or not', async (t) => {
  const db = await tmpDb(t);
  db.claimCampaign(only(db, 'G'), DM);

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
  const { commandDefs, MANAGER_SUBCOMMANDS } = await import('../src/commands/index.js');

  // The tiers are per SUBCOMMAND now. There is no owner tier left in Discord
  // at all: approve, pause, transcribe, summarise, pending and import spend
  // the owner's GPU, API budget and disk, so they moved to the dashboard
  // rather than sitting in a picker every player can open.
  // The corrections four sit here rather than a tier lower: they rewrite the
  // transcript itself, which is the same authority as renaming the campaign,
  // not the lesser one of reading it.
  assert.deepEqual([...MANAGER_SUBCOMMANDS].sort(), [
    'correct', 'corrections', 'delete', 'invite', 'output', 'remove', 'rename', 'replay', 'uncorrect',
  ]);

  const campaign = commandDefs.find((c) => c.name === 'campaign');
  const subs = campaign.options.filter((o) => o.type === 1).map((o) => o.name);

  // Everything that is not a manager subcommand is something the table itself
  // may run. `create` is here because an unclaimed campaign has to be
  // claimable, and `list` because seeing what is here is not a privilege.
  assert.deepEqual(subs.filter((s) => !MANAGER_SUBCOMMANDS.has(s)).sort(), [
    'archive', 'ask', 'consent', 'create', 'export', 'funny', 'history', 'list',
    'locations', 'npcs', 'recap', 'restore', 'search', 'setchar', 'stats', 'whoami',
  ]);

  // `consent` must never drift into the manager tier. It is the one command
  // whose whole purpose is that the person it concerns can run it without the
  // person recording them being involved — gating it behind the roster owner
  // would turn withdrawing consent back into asking a favour.
  assert.equal(MANAGER_SUBCOMMANDS.has('consent'), false);

  // The gated ones are reachable from a user install, and that is fine — the
  // tier is enforced by RESOLUTION, not by which command carries them. A
  // manager subcommand resolves only among campaigns you run, so installing
  // the app grants nothing.
  assert.ok(campaign.integration_types.includes(1), 'the reads travel with the player');
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

// defaultCampaignId survives the migration as the answer to "which campaign
// did this guild mean, before campaigns had ids" — recovery of an orphaned
// meeting, and a /join in a server whose campaign nobody has created yet.
test('a guild resolves to its oldest campaign when nothing names one', async (t) => {
  const db = await tmpDb(t);
  const first = db.createCampaign('G', 'Cipher', DM);
  db.createCampaign('G', 'Second Game', PLAYER);

  assert.equal(db.forTests.defaultCampaignId('G'), first);
  assert.equal(db.getCampaignName(first), 'Cipher');
  assert.equal(db.getCampaignManager(first), DM);
});

// The reads are where two tables in one Discord would actually mix: everything
// else can be wrong and recoverable, but a recap that quietly contains the
// other game's session is not noticed until it is in the vault.
test('the reads are per campaign, not per server', async (t) => {
  const db = await tmpDb(t);
  const first = db.createCampaign('G', 'Cipher', DM);
  const second = db.createCampaign('G', 'Strahd', PLAYER);

  const make = (campaignId, text) => {
    const id = db.createMeeting({
      guildId: 'G',
      campaignId,
      channelId: 'C',
      channelName: 'x',
      startedAt: '2026-08-01T10:00:00Z',
      audioDir: '/t',
    });
    db.finalizeTranscription(id, [{ userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1, text }]);
    db.endMeeting(id, '2026-08-01T12:00:00Z');
    db.setSummary(id, { tldr: text });
    return id;
  };

  const mine = make(first, 'the marrowgate opens');
  make(second, 'the mists close in');

  assert.deepEqual(db.listRecentMeetings(first, 10).map((m) => m.id), [mine]);
  assert.deepEqual(db.listCompletedMeetings(first).map((m) => m.id), [mine]);
  assert.equal(db.getLastCompletedMeeting(first).id, mine);
  assert.equal(db.campaignStats(first).totalSessions, 1);
  assert.equal(db.searchUtterances(first, 'mists', 5).length, 0, "the other table's transcript is not searchable");
  assert.equal(db.searchUtterances(second, 'mists', 5).length, 1);
});

test('a guild with no campaign gets one on demand', async (t) => {
  const db = await tmpDb(t);
  const id = db.forTests.defaultCampaignId('BRAND-NEW');
  assert.ok(id);
  assert.equal(db.forTests.defaultCampaignId('BRAND-NEW'), id, 'and not a second one');
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
  const g = only(db, 'G');
  db.claimCampaign(g, DM);
  assert.equal(db.isCampaignMember(g, DM), true);
});

// The gap that made /join refuse a player the DM had already named: the
// message said naming someone adds them to the roster, and it did not.
test('naming a player enrols them', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);

  db.setCharacterName(id, PLAYER, 'BenTen');
  assert.equal(db.isCampaignMember(id, PLAYER), true);
});

// The other half of the same gap: a player who turns up and speaks is at the
// table whether or not anyone remembered to enrol them.
test('speaking in a recorded session enrols the speaker', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  const meeting = db.createMeeting({
    guildId: 'G',
    campaignId: id,
    channelId: 'C',
    channelName: 'x',
    startedAt: 'now',
    audioDir: '/t',
  });

  assert.equal(db.isCampaignMember(id, 'newcomer'), false);
  db.finalizeTranscription(meeting, [
    { userId: 'newcomer', displayName: 'Sam', startMs: 0, endMs: 1, text: 'hello' },
  ]);
  assert.equal(db.isCampaignMember(id, 'newcomer'), true);
});

test('an imported recording does not enrol its synthetic speaker', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  const meeting = db.createMeeting({
    guildId: 'G',
    campaignId: id,
    channelId: 'C',
    channelName: 'x',
    startedAt: 'now',
    audioDir: '/t',
  });

  db.finalizeTranscription(meeting, [
    { userId: 'imported', displayName: 'Table', startMs: 0, endMs: 1, text: 'in person game' },
  ]);
  assert.equal(db.isCampaignMember(id, 'imported'), false, '"imported" is a label, not a Discord account');
});

test('forgetting a character name leaves the player on the roster', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.setCharacterName(id, PLAYER, 'BenTen');

  db.forgetCharacterName(id, PLAYER);
  assert.equal(db.getCharacterName(id, PLAYER), null);
  assert.equal(db.isCampaignMember(id, PLAYER), true, 'forgetting a name is not throwing them out');
});

test('membership is per campaign, not per server', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Second Game', DM);
  db.forTests.addCampaignMember(a, PLAYER, DM);

  assert.equal(db.isCampaignMember(a, PLAYER), true);
  assert.equal(db.isCampaignMember(b, PLAYER), false, 'same server, different table');
});

test('adding the same member twice is a no-op', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  assert.equal(db.forTests.addCampaignMember(id, PLAYER, DM), 1);
  assert.equal(db.forTests.addCampaignMember(id, PLAYER, DM), 0);
  assert.equal(db.forTests.listCampaignMembers(id).length, 2, 'manager + player');
});

// This is what /join offers. Deliberately different from listCampaignsForUser,
// which is "has spoken" — a player added to a brand new campaign belongs to it
// before they have said a word.
test('listCampaignsForMember covers a player who has never spoken', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.forTests.addCampaignMember(id, PLAYER, DM);

  assert.deepEqual(db.listCampaignsForMember(PLAYER).map((c) => c.name), ['Cipher']);
  assert.deepEqual(db.listCampaignsForUser(PLAYER), [], 'and has still spoken in none');
});

test('a removed member is no longer offered the campaign', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.forTests.addCampaignMember(id, PLAYER, DM);

  assert.equal(db.forTests.removeCampaignMember(id, PLAYER), 1);
  assert.deepEqual(db.listCampaignsForMember(PLAYER), []);
});

// --- where a campaign's notes go ---

// NOTES_TO_OWNER_DM is one setting for every table the bot serves. A campaign
// wanting its recaps in #session-notes and another wanting them DM'd cannot
// both be expressed that way, so the choice belongs on the campaign.
test('a campaign chooses its own output, and it survives a rename', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);
  const meeting = db.createMeeting({
    guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t',
  });

  assert.equal(db.getOutputForMeeting(meeting).mode, null, 'starts on the bot default');

  db.setCampaignOutput(g, 'channel', 'CHAN-123');
  assert.deepEqual(
    (({ mode, channelId, managerUserId }) => ({ mode, channelId, managerUserId }))(db.getOutputForMeeting(meeting)),
    { mode: 'channel', channelId: 'CHAN-123', managerUserId: DM }
  );

  db.setCampaignName(g, 'Renamed');
  assert.equal(db.getOutputForMeeting(meeting).mode, 'channel', 'renaming does not reset it');
});

// A campaign's DM goes to its MANAGER, not the bot owner — it is their game.
test('DM output carries the manager, so delivery knows who to write to', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);
  const meeting = db.createMeeting({
    guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t',
  });

  db.setCampaignOutput(g, 'dm');
  const out = db.getOutputForMeeting(meeting);
  assert.equal(out.mode, 'dm');
  assert.equal(out.managerUserId, DM);
  assert.equal(out.channelId, null);
});

test('clearing the choice falls back to the bot default', async (t) => {
  const db = await tmpDb(t);
  const g = only(db, 'G');
  db.claimCampaign(g, DM);
  const meeting = db.createMeeting({
    guildId: 'G', channelId: 'C', channelName: 'x', startedAt: 'now', audioDir: '/t',
  });

  db.setCampaignOutput(g, 'dm');
  db.setCampaignOutput(g, null);
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

const { resolveMemberCampaign } = await import('../src/campaign/resolve.js');

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

  const { error, campaign } = resolveMemberCampaign(joining('G', PLAYER), db);
  assert.equal(campaign, undefined);
  assert.match(error, /not on the roster/);
  assert.match(error, /\/dm add/, 'and says how to get on it');
});

test('the manager can always start their own campaign', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  assert.equal(resolveMemberCampaign(joining('G', DM), db).campaign.id, id);
});

test('a player added to the roster can start a recording', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', DM);
  db.forTests.addCampaignMember(id, PLAYER, DM);
  assert.equal(resolveMemberCampaign(joining('G', PLAYER), db).campaign.id, id);
});

// Membership in one server says nothing about another.
test('being at a table elsewhere does not let you record here', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('ELSEWHERE', 'Cipher', PLAYER);
  db.createCampaign('HERE', 'Someone Elses Game', DM);

  assert.match(resolveMemberCampaign(joining('HERE', PLAYER), db).error, /not on the roster/);
});

test('two tables in one server ask which, and name them', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', DM);
  const b = db.createCampaign('G', 'Curse of Strahd', DM);

  const { error } = resolveMemberCampaign(joining('G', DM), db);
  assert.match(error, /more than one table/);
  assert.match(error, /Cipher/);
  assert.match(error, /Curse of Strahd/);

  assert.equal(resolveMemberCampaign(joining('G', DM, String(a)), db).campaign.id, a);
  assert.equal(resolveMemberCampaign(joining('G', DM, String(b)), db).campaign.id, b);
});

test('naming a campaign you are not on the roster for is refused', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', DM);
  const theirs = db.createCampaign('G', 'Private Game', PLAYER);
  db.forTests.addCampaignMember(db.forTests.defaultCampaignId('G'), 'newbie', DM);

  assert.match(resolveMemberCampaign(joining('G', 'newbie', String(theirs)), db).error, /roster for here/);
});
