import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  resolveReadableCampaign,
  resolveManagedCampaign,
  campaignNameClash,
  NOT_A_MEMBER,
} from '../src/campaign/resolve.js';

// The read tier answers with a campaign row now, not a guild id — that is the
// whole migration in one line. `where` keeps the assertions readable.
const where = (result) => result.campaign?.guild_id;

async function tmpDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-scope-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

function played(db, { guildId, userId, name = 'Cipher' }) {
  const id = db.createMeeting({
    guildId,
    channelId: 'C',
    channelName: name,
    startedAt: new Date().toISOString(),
    audioDir: '/tmp/none',
  });
  db.finalizeTranscription(id, [{ userId, displayName: 'Someone', text: 'hi', startMs: 0, endMs: 1 }], {
    requireApproval: false,
  });
  return id;
}

// A fake interaction. `campaign` is the option a user-installed command can
// carry; guildId is whatever server they happened to type it in.
const at = (guildId, userId, campaign = null) => ({
  guildId,
  user: { id: userId },
  options: { getString: (n) => (n === 'campaign' ? campaign : null) },
});

test("in the campaign's own server, being in the server is the permission", async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  // A lurker who has never spoken still gets the campaign they are sitting in.
  assert.equal(where(resolveReadableCampaign(at('G', 'never-spoke'), db)), 'G');
});

// The whole point of the boundary: anyone can add a user-installed app to
// their own account, so a stranger must not be able to read a table's
// transcripts by naming their campaign.
test('a stranger in an unrelated server gets nothing', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  const scope = resolveReadableCampaign(at('SOME-OTHER-SERVER', 'stranger'), db);
  assert.equal(where(scope), undefined);
  assert.equal(scope.error, NOT_A_MEMBER);
});

test('naming a campaign you have not played in is refused', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'stranger' });
  const theirs = db.forTests.defaultCampaignId('G');

  const scope = resolveReadableCampaign(at('SOME-OTHER-SERVER', 'stranger', String(theirs)), db);
  assert.equal(where(scope), undefined);
  assert.match(scope.error, /haven't played in|isn't a campaign you've played in/);
});

// Being in one table's server is not permission to read another's.
test('sitting in one campaign does not unlock another by name', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'other' });
  const theirs = db.forTests.defaultCampaignId('H');

  const scope = resolveReadableCampaign(at('G', 'player', String(theirs)), db);
  assert.equal(where(scope), undefined);
  assert.ok(scope.error);
});

// Two tables in ONE server. A player in the second must not have the first's
// records answer their /recap just because it is older.
test('a second campaign in the same server does not answer for the first', async (t) => {
  const db = await tmpDb(t);
  const first = db.createCampaign('G', 'Cipher', 'dm-a');
  const second = db.createCampaign('G', 'Strahd', 'dm-b');
  const id = db.createMeeting({
    guildId: 'G',
    campaignId: second,
    channelId: 'C',
    channelName: 'x',
    startedAt: 'now',
    audioDir: '/t',
  });
  db.finalizeTranscription(id, [{ userId: 'player', displayName: 'P', text: 'hi', startMs: 0, endMs: 1 }]);

  const resolved = resolveReadableCampaign(at('G', 'player'), db);
  assert.equal(resolved.campaign.id, second, 'the table they actually play at, not the older one');
  assert.notEqual(resolved.campaign.id, first);
});

// A lurker in a server with two tables genuinely cannot be guessed for.
test('a lurker in a server with two campaigns is asked which', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', 'dm-a');
  db.createCampaign('G', 'Strahd', 'dm-b');

  const resolved = resolveReadableCampaign(at('G', 'never-spoke'), db);
  assert.equal(where(resolved), undefined);
  assert.match(resolved.error, /Cipher/);
  assert.match(resolved.error, /Strahd/);
});

test('a player in exactly one campaign needs no option', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  const scope = resolveReadableCampaign(at('SOME-OTHER-SERVER', 'player'), db);
  assert.equal(where(scope), 'G');
  assert.equal(scope.elsewhere, true, 'flagged so the reply can say which campaign answered');
});

test('a player in two campaigns is asked which, and told the names', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player', name: 'Cipher' });
  played(db, { guildId: 'H', userId: 'player', name: 'Other Game' });
  db.setCampaignName(db.forTests.defaultCampaignId('G'), 'Cipher');

  const scope = resolveReadableCampaign(at('SOME-OTHER-SERVER', 'player'), db);
  assert.equal(where(scope), undefined);
  assert.match(scope.error, /more than one campaign/);
  assert.match(scope.error, /Cipher/);
  assert.match(scope.error, /Other Game/);
});

test('and can pick one of their own', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'player' });
  const mine = db.forTests.defaultCampaignId('H');

  assert.equal(where(resolveReadableCampaign(at('SOME-OTHER-SERVER', 'player', String(mine)), db)), 'H');
});

// Autocomplete sends the id, but people type the name — into the box before
// the list loads, or copied out of a message.
test('a campaign can be named as well as picked', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'player' });
  db.setCampaignName(db.forTests.defaultCampaignId('H'), 'Curse of Strahd');

  assert.equal(where(resolveReadableCampaign(at('ELSEWHERE', 'player', 'Curse of Strahd'), db)), 'H');
  assert.equal(where(resolveReadableCampaign(at('ELSEWHERE', 'player', 'curseofstrahd'), db)), 'H', 'the slug too');
});

// Run from a DM there is no guild at all, which is the same problem.
test('a DM channel resolves through membership too', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  assert.equal(where(resolveReadableCampaign(at(null, 'player'), db)), 'G');
  assert.equal(resolveReadableCampaign(at(null, 'stranger'), db).error, NOT_A_MEMBER);
});

// --- the manage tier ---

test('a manager reaches the campaign they run and not the one they do not', async (t) => {
  const db = await tmpDb(t);
  const mine = db.createCampaign('G', 'Cipher', 'dm-a');
  db.createCampaign('G', 'Strahd', 'dm-b');

  assert.equal(resolveManagedCampaign(at('G', 'dm-a'), db, {}).campaign.id, mine);
});

test('naming a campaign you do not run says who does', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', 'dm-a');
  const theirs = db.createCampaign('G', 'Strahd', 'dm-b');

  const refused = resolveManagedCampaign(at('G', 'dm-a', String(theirs)), db, {});
  assert.equal(refused.campaign, undefined);
  assert.match(refused.error, /dm-b/, 'and points at them rather than pretending it does not exist');
});

test('running two campaigns in one server means being asked which', async (t) => {
  const db = await tmpDb(t);
  const a = db.createCampaign('G', 'Cipher', 'dm-a');
  const b = db.createCampaign('G', 'Strahd', 'dm-a');

  const asked = resolveManagedCampaign(at('G', 'dm-a'), db, {});
  assert.match(asked.error, /more than one campaign/);
  assert.equal(resolveManagedCampaign(at('G', 'dm-a', String(a)), db, {}).campaign.id, a);
  assert.equal(resolveManagedCampaign(at('G', 'dm-a', String(b)), db, {}).campaign.id, b);
});

test('the bot owner reaches every campaign, so a stranded one can be unstuck', async (t) => {
  const db = await tmpDb(t);
  const theirs = db.createCampaign('G', 'Cipher', 'someone-who-left');

  assert.equal(resolveManagedCampaign(at('G', 'owner'), db, { ownerUserId: 'owner' }).campaign.id, theirs);
});

test('someone who runs nothing is told how to start', async (t) => {
  const db = await tmpDb(t);
  assert.match(resolveManagedCampaign(at('EMPTY-SERVER', 'nobody'), db, {}).error, /\/campaign create/);
});

// --- names have to be unique, because they are folder names ---

test('a name already in use is refused, in any server', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', 'dm-a');

  assert.equal(campaignNameClash(db, 'Cipher')?.guild_id, 'G');
  assert.equal(campaignNameClash(db, 'ELSEWHERE-TOO')?.guild_id, undefined, 'a free name is free');
  assert.ok(campaignNameClash(db, 'Cipher'), 'even from another server — the vault folder has no guild in its path');
});

// safeFolderName strips the characters that break paths, so two names that
// look different can be the same folder.
test('a name that collapses to an existing folder is refused too', async (t) => {
  const db = await tmpDb(t);
  db.createCampaign('G', 'Cipher', 'dm-a');

  assert.ok(campaignNameClash(db, 'C i p h e r'), 'spaces are stripped from the folder name');
  assert.ok(campaignNameClash(db, 'Ci:pher'), 'and so are illegal path characters');
});

test('renaming a campaign does not clash with itself', async (t) => {
  const db = await tmpDb(t);
  const id = db.createCampaign('G', 'Cipher', 'dm-a');

  assert.equal(campaignNameClash(db, 'Cipher', id), null);
});

// --- the query behind it ---

test('listCampaignsForUser is participation, not membership of a server', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'someone-else' });

  assert.deepEqual(db.listCampaignsForUser('player').map((c) => c.guild_id), ['G']);
  assert.deepEqual(db.listCampaignsForUser('never-spoke'), []);
});

test('listCampaignsForUser reports the campaign name when one is set', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player', name: '🎲Session' });
  db.setCampaignName(db.forTests.defaultCampaignId('G'), 'Cipher');

  const [c] = db.listCampaignsForUser('player');
  assert.equal(c.name, 'Cipher');
  assert.equal(c.channel_name, '🎲Session', 'and the channel it was recorded in, as a fallback');
});

// --- what gets registered with Discord ---

// A command that omits integration_types inherits the APPLICATION's, so
// enabling user install in the Developer Portal silently made all 27
// user-installable on the first deploy. /join was then offered in servers the
// bot is not in, where it can only fail.
test('the whole surface is three commands, and only the reads travel', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.DISCORD_CLIENT_ID ||= 'x';
  process.env.GEMINI_API_KEY ||= 'x';
  const { commandDefs } = await import('../src/commands/index.js');

  // There used to be twenty-seven. A player who installed the app, or anyone
  // opening the picker in a server the bot was invited to, saw the lot —
  // including approve, pause, import and the rest of the pipeline, which
  // spends the owner's GPU and API budget and has nothing to do with playing
  // D&D. Those live on the dashboard now.
  assert.deepEqual(commandDefs.map((c) => c.name).sort(), ['campaign', 'join', 'leave']);

  assert.ok(
    commandDefs.every((c) => Array.isArray(c.integration_types) && Array.isArray(c.contexts)),
    'every command states its own install types rather than inheriting the app default'
  );

  // /join and /leave have to be run from inside the voice channel being
  // recorded, so they are meaningless anywhere the bot is not.
  for (const name of ['join', 'leave']) {
    const c = commandDefs.find((x) => x.name === name);
    assert.deepEqual(c.integration_types, [0], `/${name} needs the bot in the voice channel`);
    assert.deepEqual(c.contexts, [0]);
  }

  // /campaign carries USER_INSTALL for its READ subcommands, since Discord
  // sets integration types per command rather than per subcommand. Nothing is
  // opened up by that — each subcommand still resolves its own campaign
  // through its own tier — but it is why this one command travels.
  const campaign = commandDefs.find((c) => c.name === 'campaign');
  assert.deepEqual(campaign.integration_types.sort(), [0, 1]);
  assert.deepEqual(campaign.contexts.sort(), [0, 1, 2], 'a server, a DM with the bot, or a group chat');
});
