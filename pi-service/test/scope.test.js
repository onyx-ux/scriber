import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { resolveScope, NOT_A_MEMBER } from '../src/campaign/scope.js';

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
  assert.deepEqual(resolveScope(at('G', 'never-spoke'), db), { guildId: 'G' });
});

// The whole point of the boundary: anyone can add a user-installed app to
// their own account, so a stranger must not be able to read a table's
// transcripts by naming their campaign.
test('a stranger in an unrelated server gets nothing', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  const scope = resolveScope(at('SOME-OTHER-SERVER', 'stranger'), db);
  assert.equal(scope.guildId, undefined);
  assert.equal(scope.error, NOT_A_MEMBER);
});

test('naming a campaign you have not played in is refused', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'stranger' });

  const scope = resolveScope(at('SOME-OTHER-SERVER', 'stranger', 'G'), db);
  assert.equal(scope.guildId, undefined);
  assert.match(scope.error, /haven't played in|isn't a campaign you've played in/);
});

// Being in one table's server is not permission to read another's.
test('sitting in one campaign does not unlock another by name', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'other' });

  const scope = resolveScope(at('G', 'player', 'H'), db);
  assert.equal(scope.guildId, undefined);
  assert.ok(scope.error);
});

test('a player in exactly one campaign needs no option', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  const scope = resolveScope(at('SOME-OTHER-SERVER', 'player'), db);
  assert.equal(scope.guildId, 'G');
  assert.equal(scope.elsewhere, true, 'flagged so the reply can say which campaign answered');
});

test('a player in two campaigns is asked which, and told the names', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player', name: 'Cipher' });
  played(db, { guildId: 'H', userId: 'player', name: 'Other Game' });
  db.setCampaignName('G', 'Cipher');

  const scope = resolveScope(at('SOME-OTHER-SERVER', 'player'), db);
  assert.equal(scope.guildId, undefined);
  assert.match(scope.error, /more than one campaign/);
  assert.match(scope.error, /Cipher/);
  assert.match(scope.error, /Other Game/);
});

test('and can pick one of their own', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });
  played(db, { guildId: 'H', userId: 'player' });

  assert.equal(resolveScope(at('SOME-OTHER-SERVER', 'player', 'H'), db).guildId, 'H');
});

// Run from a DM there is no guild at all, which is the same problem.
test('a DM channel resolves through membership too', async (t) => {
  const db = await tmpDb(t);
  played(db, { guildId: 'G', userId: 'player' });

  assert.equal(resolveScope(at(null, 'player'), db).guildId, 'G');
  assert.equal(resolveScope(at(null, 'stranger'), db).error, NOT_A_MEMBER);
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
  db.setCampaignName('G', 'Cipher');

  const [c] = db.listCampaignsForUser('player');
  assert.equal(c.campaign_name, 'Cipher');
  assert.equal(c.channel_name, '🎲Session', 'and the channel it was recorded in, as a fallback');
});

// --- what gets registered with Discord ---

// A command that omits integration_types inherits the APPLICATION's, so
// enabling user install in the Developer Portal silently made all 27
// user-installable on the first deploy. /join was then offered in servers the
// bot is not in, where it can only fail.
test('exactly the nine read commands are user-installable', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.DISCORD_CLIENT_ID ||= 'x';
  process.env.GEMINI_API_KEY ||= 'x';
  const { commandDefs } = await import('../src/commands/index.js');

  const userInstallable = commandDefs.filter((c) => c.integration_types.includes(1)).map((c) => c.name);
  assert.deepEqual(
    userInstallable.sort(),
    ['archive', 'ask', 'funny', 'history', 'locations', 'npcs', 'recap', 'search', 'stats']
  );

  assert.ok(
    commandDefs.every((c) => Array.isArray(c.integration_types) && Array.isArray(c.contexts)),
    'every command states its own install types rather than inheriting the app default'
  );

  const join = commandDefs.find((c) => c.name === 'join');
  assert.deepEqual(join.integration_types, [0], '/join needs the bot in the voice channel');
  assert.deepEqual(join.contexts, [0]);

  // /dm and /campaign are the owner's housekeeping and stay usable in a DM
  // with the bot, which is a context, not an install type.
  for (const name of ['dm', 'campaign']) {
    const c = commandDefs.find((x) => x.name === name);
    assert.deepEqual(c.integration_types, [0], `/${name} is not user-installable`);
    assert.deepEqual(c.contexts, [0, 1], `/${name} still works in a DM with the bot`);
  }
});
