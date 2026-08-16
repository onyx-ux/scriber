import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { registerCommandHandlers, activeSessions } from '../src/commands/index.js';

// The command surface itself, driven through the real dispatcher.
//
// Everything below this file was already covered — the resolvers, the queries,
// the migration. The handlers were not: they were only ever exercised by
// running the bot. So the gate, the campaign resolution and the replies could
// each be right on their own and still not add up to a working command, and
// nothing would have said so.
//
// A fake interaction rather than a fake Discord: the dispatcher only ever
// touches interaction.options, .user, .guildId and the reply methods, so a
// plain object covers it and the test stays about the bot's own logic.

const OWNER = 'owner-1';
const DM_A = 'dm-of-cipher';
const DM_B = 'dm-of-strahd';
const PLAYER_A = 'plays-in-cipher';
const PLAYER_B = 'plays-in-strahd';
const GUILD = 'one-server';

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-cmd-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const cfg = {
    ownerUserId: OWNER,
    dataDir: dir,
    obsidianExportDir: join(dir, 'obsidian'),
    summaryProvider: 'gemini',
    geminiApiKey: 'test-key',
    geminiModel: 'gemini-3.6-flash',
    driveSyncEnabled: false,
    transcribeRequireApproval: false,
    summaryRequireApproval: false,
  };
  await mkdir(cfg.obsidianExportDir, { recursive: true });

  // registerCommandHandlers attaches one listener; capture it and call it
  // directly, so the test drives exactly what Discord would.
  let dispatch = null;
  registerCommandHandlers({ on: (event, fn) => { if (event === 'interactionCreate') dispatch = fn; } }, db, cfg);
  assert.ok(dispatch, 'the dispatcher registered itself');

  t.after(async () => {
    activeSessions.clear();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, dir, dispatch };
}

// Captures whatever the handler replied with, however it replied.
function command(name, { user, guildId = GUILD, sub = null, options = {}, channelId = 'the-channel' } = {}) {
  const said = { content: null, replied: false };
  const take = (payload) => {
    said.replied = true;
    said.content = typeof payload === 'string' ? payload : (payload?.content ?? said.content);
    return Promise.resolve();
  };

  return {
    said,
    commandName: name,
    guildId,
    channelId,
    user: { id: user, username: user },
    member: null,
    client: {},
    isButton: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
      getString: (k) => (options[k] === undefined ? null : String(options[k])),
      getInteger: (k) => (options[k] === undefined ? null : Number(options[k])),
      getUser: (k) => (options[k] === undefined ? null : { id: options[k], username: options[k] }),
      getChannel: (k) => (options[k] === undefined ? null : { id: options[k] }),
      getAttachment: () => null,
      getFocused: () => '',
    },
    reply: take,
    editReply: take,
    followUp: take,
    deferReply: () => Promise.resolve(),
  };
}

// An autocomplete interaction, which answers through respond() instead.
function autocomplete(name, { user, guildId = GUILD, focused = 'campaign', sub = null, options = {} } = {}) {
  const got = { choices: null };
  return {
    got,
    commandName: name,
    guildId,
    user: { id: user },
    isButton: () => false,
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    options: {
      getSubcommand: () => sub,
      getString: (k) => (options[k] === undefined ? null : String(options[k])),
      getFocused: (withType) => (withType ? { name: focused, value: '' } : ''),
    },
    respond: (choices) => { got.choices = choices; return Promise.resolve(); },
  };
}

const run = async (dispatch, interaction) => {
  await dispatch(interaction);
  return interaction.said?.content ?? interaction.got?.choices;
};

// --- two campaigns, set up entirely through the commands ---

async function twoTables(t) {
  const h = await harness(t);

  assert.match(await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: 'Cipher' } })), /Cipher/);
  assert.match(await run(h.dispatch, command('campaign', { user: DM_B, sub: 'create', options: { name: 'Strahd' } })), /Strahd/);

  const [cipher, strahd] = h.db.listCampaignsInGuild(GUILD);
  await run(h.dispatch, command('dm', { user: DM_A, sub: 'add', options: { player: PLAYER_A, name: 'BenTen', campaign: cipher.id } }));
  await run(h.dispatch, command('dm', { user: DM_B, sub: 'add', options: { player: PLAYER_B, name: 'Ireena', campaign: strahd.id } }));

  return { ...h, cipher, strahd };
}

// Gives a campaign a finished session, so the reads have something to find.
function played(db, campaignId, { text, speaker = PLAYER_A, name = 'Someone', tldr = 'a recap' } = {}) {
  const id = db.createMeeting({
    guildId: GUILD,
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: '2026-08-01T19:00:00Z',
    audioDir: '/tmp',
  });
  db.finalizeTranscription(id, [{ userId: speaker, displayName: name, startMs: 0, endMs: 1000, text }]);
  db.endMeeting(id, '2026-08-01T22:00:00Z');
  db.setSummary(id, { tldr, funnyMoments: [`${tldr} — the funny bit`] });
  return id;
}

// --- creating ---

test('/campaign create makes a campaign and hands it to whoever ran it', async (t) => {
  const h = await harness(t);
  const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: 'Cipher' } }));

  assert.match(said, /You run it/);
  assert.match(said, /Cipher_01/, 'and tells them how sessions will be referred to');
  const [c] = h.db.listCampaignsInGuild(GUILD);
  assert.equal(c.name, 'Cipher');
  assert.equal(c.manager_user_id, DM_A);
  assert.equal(h.db.isCampaignMember(c.id, DM_A), true);
});

test('/campaign create refuses a name already in use', async (t) => {
  const h = await harness(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: 'Cipher' } }));
  const said = await run(h.dispatch, command('campaign', { user: DM_B, sub: 'create', options: { name: 'Cipher' } }));

  assert.match(said, /already a campaign called/);
  assert.equal(h.db.listCampaignsInGuild(GUILD).length, 1, 'and does not create a second one');
});

test('/campaign create refuses in a DM, where there is no server to attach to', async (t) => {
  const h = await harness(t);
  const said = await run(h.dispatch, command('campaign', { user: DM_A, guildId: null, sub: 'create', options: { name: 'X' } }));
  assert.match(said, /server the game is played in/);
  assert.equal(h.db.listCampaigns().length, 0);
});

test('a second campaign in the same server is allowed and separate', async (t) => {
  const { db, cipher, strahd } = await twoTables(t);

  assert.equal(db.listCampaignsInGuild(GUILD).length, 2);
  assert.notEqual(cipher.id, strahd.id);
  assert.equal(db.getCampaignManager(cipher.id), DM_A);
  assert.equal(db.getCampaignManager(strahd.id), DM_B);
});

// --- the roster ---

test('/dm add enrols someone who has never been recorded', async (t) => {
  const { db, cipher } = await twoTables(t);

  assert.equal(db.isCampaignMember(cipher.id, PLAYER_A), true);
  assert.equal(db.getCharacterName(cipher.id, PLAYER_A), 'BenTen');
});

test('/dm add on one table does not touch the other', async (t) => {
  const { db, cipher, strahd } = await twoTables(t);

  assert.equal(db.isCampaignMember(strahd.id, PLAYER_A), false);
  assert.equal(db.getCharacterName(strahd.id, PLAYER_A), null, 'the same person can be unknown at the other table');
});

test("a DM cannot touch the other table's roster", async (t) => {
  const { dispatch, db, strahd } = await twoTables(t);
  const said = await run(dispatch, command('dm', { user: DM_A, sub: 'add', options: { player: 'ringer', campaign: strahd.id } }));

  assert.match(said, /runs \*\*Strahd\*\*|only they can/);
  assert.equal(db.isCampaignMember(strahd.id, 'ringer'), false);
});

test('/dm roster shows this campaign only, and flags who has no character', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  await run(dispatch, command('dm', { user: DM_A, sub: 'add', options: { player: 'unnamed-player', campaign: cipher.id } }));

  const said = await run(dispatch, command('dm', { user: DM_A, sub: 'roster', options: { campaign: cipher.id } }));
  assert.match(said, /BenTen/);
  assert.doesNotMatch(said, /Ireena/, "the other table's character is not listed");
  assert.match(said, /no character set/);
});

test('/dm remove takes someone off the roster', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  const said = await run(dispatch, command('dm', { user: DM_A, sub: 'remove', options: { player: PLAYER_A, campaign: cipher.id } }));

  assert.match(said, /off the roster/);
  assert.equal(db.isCampaignMember(cipher.id, PLAYER_A), false);
});

test('a DM cannot remove themselves and strand the campaign', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  const said = await run(dispatch, command('dm', { user: DM_A, sub: 'remove', options: { player: DM_A, campaign: cipher.id } }));

  assert.match(said, /can't take yourself off/);
  assert.equal(db.isCampaignMember(cipher.id, DM_A), true);
});

test('/dm forget clears the character but keeps them at the table', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  const said = await run(dispatch, command('dm', { user: DM_A, sub: 'forget', options: { player: PLAYER_A, campaign: cipher.id } }));

  assert.match(said, /still on the roster/);
  assert.equal(db.getCharacterName(cipher.id, PLAYER_A), null);
  assert.equal(db.isCampaignMember(cipher.id, PLAYER_A), true);
});

// --- the reads land on the right table ---

test('/recap answers with the campaign the caller plays in', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  played(db, cipher.id, { speaker: PLAYER_A, text: 'the marrowgate opens', tldr: 'CIPHER RECAP' });
  played(db, strahd.id, { speaker: PLAYER_B, text: 'the mists close in', tldr: 'STRAHD RECAP' });

  assert.match(await run(dispatch, command('recap', { user: PLAYER_A })), /CIPHER RECAP/);
  assert.match(await run(dispatch, command('recap', { user: PLAYER_B })), /STRAHD RECAP/);
});

test('/search cannot reach the other table in the same server', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  played(db, cipher.id, { speaker: PLAYER_A, text: 'the marrowgate opens' });
  played(db, strahd.id, { speaker: PLAYER_B, text: 'the mists close in' });

  assert.match(await run(dispatch, command('search', { user: PLAYER_A, options: { query: 'marrowgate' } })), /marrowgate/);
  const crossed = await run(dispatch, command('search', { user: PLAYER_A, options: { query: 'mists' } }));
  assert.doesNotMatch(crossed, /mists close in/, "one table's player cannot search the other's transcripts");
});

test('/stats and /history are per campaign and quote its own session refs', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  played(db, cipher.id, { speaker: PLAYER_A, text: 'one' });
  played(db, cipher.id, { speaker: PLAYER_A, text: 'two' });
  played(db, strahd.id, { speaker: PLAYER_B, text: 'elsewhere' });

  const stats = await run(dispatch, command('stats', { user: PLAYER_A }));
  assert.match(stats, /2 session|sessions.*2|2\b/, stats);
  assert.match(stats, /Cipher/);

  const history = await run(dispatch, command('history', { user: PLAYER_A }));
  assert.match(history, /Cipher_01/);
  assert.match(history, /Cipher_02/);
  assert.doesNotMatch(history, /Strahd/);
});

test('/funny draws only from the campaign it resolved to', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  played(db, cipher.id, { speaker: PLAYER_A, text: 'x', tldr: 'CIPHERJOKE' });
  played(db, strahd.id, { speaker: PLAYER_B, text: 'y', tldr: 'STRAHDJOKE' });

  for (let i = 0; i < 8; i++) {
    assert.match(await run(dispatch, command('funny', { user: PLAYER_A })), /CIPHERJOKE/);
  }
});

// --- corrections stay put ---

test('/correct rewrites only its own campaign', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  const mine = played(db, cipher.id, { speaker: PLAYER_A, text: 'Vecks opens the door' });
  const theirs = played(db, strahd.id, { speaker: PLAYER_B, text: 'Vecks opens the door' });

  await run(dispatch, command('correct', { user: DM_A, options: { wrong: 'Vecks', right: 'Vex', campaign: cipher.id } }));

  assert.equal(db.listUtterances(mine)[0].text, 'Vex opens the door');
  assert.equal(db.listUtterances(theirs)[0].text, 'Vecks opens the door', 'the other table is untouched');
  assert.deepEqual(db.listCorrections(strahd.id), []);
});

test('/corrections lists only this campaign', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  played(db, cipher.id, { speaker: PLAYER_A, text: 'x' });
  played(db, strahd.id, { speaker: PLAYER_B, text: 'y' });

  await run(dispatch, command('correct', { user: DM_A, options: { wrong: 'Vecks', right: 'Vex', campaign: cipher.id } }));
  const said = await run(dispatch, command('corrections', { user: DM_B, options: { campaign: strahd.id } }));
  assert.match(said, /No corrections saved/);
});

// --- the gate ---

test('a player cannot run a manager command', async (t) => {
  const { dispatch, cipher } = await twoTables(t);
  const said = await run(dispatch, command('correct', { user: PLAYER_A, options: { wrong: 'a', right: 'b', campaign: cipher.id } }));
  // Names the DM rather than saying "this campaign": you are in their server
  // and can see the game happening, so pretending it does not exist is worse
  // than telling you who to ask.
  assert.match(said, new RegExp(DM_A));
  assert.match(said, /only they can change its records/);
});

test('a player cannot run an owner command', async (t) => {
  const { dispatch } = await twoTables(t);
  assert.match(await run(dispatch, command('pause', { user: PLAYER_A })), /bot owner/);
  assert.match(await run(dispatch, command('import', { user: DM_A, options: { url: 'http://x' } })), /bot owner/);
});

test('the owner reaches a campaign they do not run', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  await run(dispatch, command('dm', { user: OWNER, sub: 'add', options: { player: 'rescued', campaign: cipher.id } }));
  assert.equal(db.isCampaignMember(cipher.id, 'rescued'), true, 'so a stranded campaign can be unstuck');
});

// --- picking between tables ---

test('someone at both tables is asked which, by name', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  db.addCampaignMember(cipher.id, 'plays-both', DM_A);
  db.addCampaignMember(strahd.id, 'plays-both', DM_B);
  played(db, cipher.id, { speaker: 'plays-both', text: 'a' });
  played(db, strahd.id, { speaker: 'plays-both', text: 'b' });

  const said = await run(dispatch, command('recap', { user: 'plays-both' }));
  assert.match(said, /more than one campaign/);
  assert.match(said, /Cipher/);
  assert.match(said, /Strahd/);
});

test('and naming one resolves it', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  db.addCampaignMember(cipher.id, 'plays-both', DM_A);
  db.addCampaignMember(strahd.id, 'plays-both', DM_B);
  played(db, cipher.id, { speaker: 'plays-both', text: 'a', tldr: 'CIPHER RECAP' });
  played(db, strahd.id, { speaker: 'plays-both', text: 'b', tldr: 'STRAHD RECAP' });

  assert.match(await run(dispatch, command('recap', { user: 'plays-both', options: { campaign: strahd.id } })), /STRAHD RECAP/);
});

test('a stranger who plays in neither is refused', async (t) => {
  const h = await harness(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: 'Cipher' } }));

  const said = await run(h.dispatch, command('recap', { user: 'stranger', guildId: 'SOME-OTHER-SERVER' }));
  assert.match(said, /don't have you recorded in any campaign/);
});

// --- autocomplete offers exactly what the handler will accept ---

test('the campaign picker offers a manager only what they run', async (t) => {
  const { dispatch, cipher } = await twoTables(t);
  const choices = await run(dispatch, autocomplete('dm', { user: DM_A, sub: 'add' }));

  assert.equal(choices.length, 1);
  assert.equal(choices[0].value, String(cipher.id));
  assert.match(choices[0].name, /Cipher/);
});

test('the campaign picker offers a player the tables they are at', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  played(db, cipher.id, { speaker: PLAYER_A, text: 'a' });

  const choices = await run(dispatch, autocomplete('recap', { user: PLAYER_A }));
  assert.ok(choices.some((c) => c.value === String(cipher.id)));
});

test('the player picker reads the roster of the resolved campaign', async (t) => {
  const { dispatch, cipher } = await twoTables(t);
  const choices = await run(dispatch, autocomplete('dm', { user: DM_A, sub: 'character', focused: 'player', options: { campaign: cipher.id } }));

  assert.ok(choices.some((c) => /BenTen/.test(c.name)), JSON.stringify(choices));
  assert.ok(!choices.some((c) => /Ireena/.test(c.name)), "and not the other table's");
});

// --- renaming carries the vault folder ---

test('/campaign rename moves the notes folder with it', async (t) => {
  const { dispatch, cfg, cipher } = await twoTables(t);
  await mkdir(join(cfg.obsidianExportDir, 'Cipher'), { recursive: true });
  await writeFile(join(cfg.obsidianExportDir, 'Cipher', 'Session 01.md'), '# one', 'utf8');

  const said = await run(dispatch, command('campaign', { user: DM_A, sub: 'rename', options: { name: 'Cipher Reborn', campaign: cipher.id } }));
  assert.match(said, /renamed to/);

  // Spaces survive: the folder is read in Obsidian, so "Sunless Citadel"
  // stays "Sunless Citadel". The session REFERENCE drops them, because that
  // one is typed — see refSlug.
  const folders = await readdir(cfg.obsidianExportDir);
  assert.ok(folders.includes('Cipher Reborn'), JSON.stringify(folders));
  assert.ok(!folders.includes('Cipher'), 'the old folder is gone, not orphaned');
  assert.match(said, /CipherReborn_01/, 'and the new session reference is quoted back');
});

test('/campaign rename refuses to collide with the other table', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  const said = await run(dispatch, command('campaign', { user: DM_A, sub: 'rename', options: { name: 'Strahd', campaign: cipher.id } }));

  assert.match(said, /already files its notes there/);
  assert.equal(db.getCampaignName(cipher.id), 'Cipher', 'and leaves the name alone');
});

// --- where the notes go ---

test('/campaign output is per campaign', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  await run(dispatch, command('campaign', { user: DM_A, sub: 'output', options: { mode: 'dm', campaign: cipher.id } }));
  await run(dispatch, command('campaign', { user: DM_B, sub: 'output', options: { mode: 'channel', channel: 'CHAN-9', campaign: strahd.id } }));

  const inCipher = played(db, cipher.id, { speaker: PLAYER_A, text: 'a' });
  const inStrahd = played(db, strahd.id, { speaker: PLAYER_B, text: 'b' });

  assert.equal(db.getOutputForMeeting(inCipher).mode, 'dm');
  assert.equal(db.getOutputForMeeting(inCipher).managerUserId, DM_A);
  assert.equal(db.getOutputForMeeting(inStrahd).channelId, 'CHAN-9');
});

// Found by running the bot, not by these tests — every test above names the
// campaign explicitly, so none of them ever hit the refusal that tells you to
// do exactly that. Six commands shipped able to say "re-run with the
// `campaign` option" while having no such option, which made them unusable in
// any server holding two tables.
test('every command that resolves a campaign lets you name one', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.DISCORD_CLIENT_ID ||= 'x';
  process.env.GEMINI_API_KEY ||= 'x';
  const { commandDefs, MANAGER_ONLY } = await import('../src/commands/index.js');

  // The tiers that resolve a campaign, and so can refuse with "which one?".
  const resolves = new Set([...MANAGER_ONLY, 'join', 'setcharacter', 'whoami']);
  const SUBCOMMAND = 1;

  const missing = commandDefs
    .filter((c) => resolves.has(c.name))
    .filter((c) => {
      const subs = (c.options ?? []).filter((o) => o.type === SUBCOMMAND);
      // A command with subcommands carries the option on each of them.
      return subs.length
        ? !subs.every((s) => (s.options ?? []).some((o) => o.name === 'campaign'))
        : !(c.options ?? []).some((o) => o.name === 'campaign');
    })
    .map((c) => c.name);

  assert.deepEqual(missing, [], `these can ask you to name a campaign but offer no way to: ${missing.join(', ')}`);
});

// The same invariant from the other end: the refusal must only be reachable
// from a command that can act on it.
test('being asked which campaign is always answerable', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  db.addCampaignMember(cipher.id, 'plays-both', DM_A);
  db.addCampaignMember(strahd.id, 'plays-both', DM_B);

  // /setcharacter is the one a player reaches for first, and the one that was
  // broken: a member of two tables here got told to use an option that did
  // not exist.
  const asked = await run(dispatch, command('setcharacter', { user: 'plays-both', options: { name: 'Fuji' } }));
  assert.match(asked, /more than one table/);

  const done = await run(
    dispatch,
    command('setcharacter', { user: 'plays-both', options: { name: 'Fuji', campaign: cipher.id } })
  );
  assert.doesNotMatch(done, /more than one table/, 'and naming one actually works');
  assert.equal(db.getCharacterName(cipher.id, 'plays-both'), 'Fuji');
  assert.equal(db.getCharacterName(strahd.id, 'plays-both'), null, 'on that table only');
});

test('/whoami answers per campaign', async (t) => {
  const { dispatch, db, cipher, strahd } = await twoTables(t);
  db.addCampaignMember(cipher.id, 'plays-both', DM_A);
  db.addCampaignMember(strahd.id, 'plays-both', DM_B);
  db.setCharacterName(cipher.id, 'plays-both', 'Fuji');

  assert.match(await run(dispatch, command('whoami', { user: 'plays-both', options: { campaign: cipher.id } })), /Fuji/);
  assert.doesNotMatch(
    await run(dispatch, command('whoami', { user: 'plays-both', options: { campaign: strahd.id } })),
    /Fuji/,
    'the other table does not know that character'
  );
});

test('/campaign list names both tables and who runs them', async (t) => {
  const { dispatch } = await twoTables(t);
  const said = await run(dispatch, command('campaign', { user: DM_A, sub: 'list' }));

  assert.match(said, /Cipher/);
  assert.match(said, /Strahd/);
  assert.match(said, new RegExp(DM_A));
  assert.match(said, new RegExp(DM_B));
});
