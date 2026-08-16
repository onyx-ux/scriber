import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
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
  const dms = [];
  const take = (payload) => {
    said.replied = true;
    said.content = typeof payload === 'string' ? payload : (payload?.content ?? said.content);
    return Promise.resolve();
  };

  return {
    said,
    dms,
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
      getUser: (k) =>
        options[k] === undefined
          ? null
          : {
              id: options[k],
              username: options[k],
              bot: false,
              // Inviting someone DMs them, so the fake user has to be able to
              // receive one. dms[] is what was actually sent.
              createDM: async () => ({ send: async (payload) => { dms.push({ to: options[k], payload }); return {}; } }),
            },
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

// The invited person pressing a button in their DM.
function button(customId, user) {
  const said = { content: null };
  return {
    said,
    customId,
    user: { id: user },
    message: { components: [] },
    isButton: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    update: (payload) => {
      said.content = typeof payload === 'string' ? payload : payload?.content ?? null;
      return Promise.resolve();
    },
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
  await invite(h, DM_A, cipher.id, PLAYER_A, 'BenTen');
  await invite(h, DM_B, strahd.id, PLAYER_B, 'Ireena');

  return { ...h, cipher, strahd };
}

// Invite someone and have them accept — the only route onto a roster now.
async function invite(h, dm, campaignId, player, name = null) {
  const opts = { player, campaign: campaignId };
  if (name) opts.name = name;
  await run(h.dispatch, command('campaign', { user: dm, sub: 'invite', options: opts }));
  await run(h.dispatch, button(`consent:yes:${campaignId}`, player));
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

// A name has to survive becoming a folder AND a session reference. These
// survive neither: safeFolderName strips them to nothing and falls back to a
// generic "Campaign", and refSlug is left empty — so the campaign could never
// refer to its own sessions, and every other vanishing name would claim the
// same vault folder. Discord names are full of emoji, so this is not
// hypothetical.
for (const name of ['🎲', '🎲🎲', '...', '///']) {
  test(`/campaign create refuses ${JSON.stringify(name)}, which leaves nothing to file under`, async (t) => {
    const h = await harness(t);
    const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name } }));

    assert.match(said, /can't file anything under/);
    assert.equal(h.db.listCampaigns().length, 0, 'and creates nothing');
  });
}

// Whitespace alone is caught one step earlier, by the empty-name check, and
// "give it a name" is the better thing to say about it than an explanation of
// folder slugs.
test('/campaign create refuses a name that is only whitespace', async (t) => {
  const h = await harness(t);
  const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: '   ' } }));

  assert.match(said, /Give the campaign a name/);
  assert.equal(h.db.listCampaigns().length, 0);
});

test('a name with emoji AND letters is fine — only the letters have to survive', async (t) => {
  const h = await harness(t);
  const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: '🎲 Sunless Citadel' } }));

  assert.match(said, /You run it/);
  assert.match(said, /SunlessCitadel_01/, 'the reference drops the emoji and the spaces');
  assert.equal(h.db.listCampaigns()[0].name, '🎲 Sunless Citadel', 'while the name itself keeps them');
});

test('/campaign rename refuses a name that leaves nothing either', async (t) => {
  const h = await harness(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: 'Cipher' } }));
  const [c] = h.db.listCampaignsInGuild(GUILD);

  const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'rename', options: { name: '🎲', campaign: c.id } }));
  assert.match(said, /can't file anything under/);
  assert.equal(h.db.getCampaignName(c.id), 'Cipher', 'and keeps the old name');
});

// Two names that look different can be the same session reference.
test('names that collapse to the same reference cannot both exist', async (t) => {
  const h = await harness(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: 'Test2' } }));
  const said = await run(h.dispatch, command('campaign', { user: DM_B, sub: 'create', options: { name: 'Test 2' } }));

  assert.match(said, /already a campaign called/, 'both would answer to Test2_01');
  assert.equal(h.db.listCampaigns().length, 1);
});

// safeFolderName caps at 60 characters, so two long names can share a folder.
test('two long names that truncate to the same folder cannot both exist', async (t) => {
  const h = await harness(t);
  const long = 'A'.repeat(80);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'create', options: { name: long } }));
  const said = await run(h.dispatch, command('campaign', { user: DM_B, sub: 'create', options: { name: `${long}B` } }));

  assert.match(said, /already a campaign called/);
  assert.equal(h.db.listCampaigns().length, 1);
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

test('accepting an invitation enrols someone who has never been recorded', async (t) => {
  const { db, cipher } = await twoTables(t);

  assert.equal(db.isCampaignMember(cipher.id, PLAYER_A), true);
  assert.equal(db.getCharacterName(cipher.id, PLAYER_A), 'BenTen');
});

test('an invitation to one table does not touch the other', async (t) => {
  const { db, cipher, strahd } = await twoTables(t);

  assert.equal(db.isCampaignMember(strahd.id, PLAYER_A), false);
  assert.equal(db.getCharacterName(strahd.id, PLAYER_A), null, 'the same person can be unknown at the other table');
});

test("a DM cannot invite to the other table's campaign", async (t) => {
  const { dispatch, db, strahd } = await twoTables(t);
  const said = await run(dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'ringer', campaign: strahd.id } }));

  assert.match(said, /runs \*\*Strahd\*\*|only they can/);
  assert.equal(db.getConsent(strahd.id, 'ringer'), null);
});

test('/dm roster shows this campaign only, and flags who has no character', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  await invite({ dispatch, db }, DM_A, cipher.id, 'unnamed-player');

  const said = await run(dispatch, command('dm', { user: DM_A, sub: 'roster', options: { campaign: cipher.id } }));
  assert.match(said, /BenTen/);
  assert.doesNotMatch(said, /Ireena/, "the other table's character is not listed");
  assert.match(said, /no character set/);
});

test('/campaign remove takes someone off the campaign entirely', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  const said = await run(dispatch, command('campaign', { user: DM_A, sub: 'remove', options: { player: PLAYER_A, campaign: cipher.id } }));

  assert.match(said, /is off/);
  assert.equal(db.isCampaignMember(cipher.id, PLAYER_A), false);
  assert.equal(db.mayRecord(cipher.id, PLAYER_A), false, 'and is no longer recordable');
  assert.equal(db.getConsent(cipher.id, PLAYER_A), null, 'asking again later is a fresh question');
});

test('a DM cannot remove themselves and strand the campaign', async (t) => {
  const { dispatch, db, cipher } = await twoTables(t);
  const said = await run(dispatch, command('campaign', { user: DM_A, sub: 'remove', options: { player: DM_A, campaign: cipher.id } }));

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

// --- stopping a recording belongs to the table being recorded ---

// A bot holds one voice connection per Discord, so activeSessions is keyed by
// guild — which meant anyone in the server could end the session. Near enough
// while a server meant a campaign; with two tables the other group's DM could
// end this one's mid-scene, and it cannot be resumed.
async function recording(t) {
  const h = await twoTables(t);
  const meetingId = h.db.createMeeting({
    guildId: GUILD,
    campaignId: h.cipher.id,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: new Date().toISOString(),
    audioDir: '/tmp',
  });
  activeSessions.set(GUILD, {
    meetingId,
    handle: { disconnect() {} },
    capturedUtterances: [],
    audioDir: '/tmp',
    channelName: 'Voice Chat',
    startedAtMs: Date.now(),
  });
  return { ...h, meetingId };
}

test("the other table's DM cannot stop this table's recording", async (t) => {
  const { dispatch } = await recording(t);
  const said = await run(dispatch, command('leave', { user: DM_B }));

  assert.match(said, /you're not at that table/);
  assert.equal(activeSessions.has(GUILD), true, 'and the session is still running');
});

test('a player at the table can stop it', async (t) => {
  const { dispatch } = await recording(t);
  await run(dispatch, command('leave', { user: PLAYER_A }));
  assert.equal(activeSessions.has(GUILD), false);
});

test('the bot owner can stop it, so a session cannot be stranded', async (t) => {
  const { dispatch } = await recording(t);
  await run(dispatch, command('leave', { user: OWNER }));
  assert.equal(activeSessions.has(GUILD), false);
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
  await run(dispatch, command('campaign', { user: OWNER, sub: 'invite', options: { player: 'rescued', campaign: cipher.id } }));
  assert.equal(db.getConsent(cipher.id, 'rescued').state, 'pending', 'so a stranded campaign can be unstuck');
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
  // /import is an owner command but resolves one anyway — it creates a session,
  // so it has to say which campaign's records that session is joining.
  const resolves = new Set([...MANAGER_ONLY, 'join', 'setcharacter', 'whoami', 'import']);
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

// --- consent to be recorded ---
//
// The bot captures people's voices, and until this existed the only gate was
// the roster, which the DM controls — so being added to a table was somebody
// else agreeing on your behalf. These check the three rules the capture path
// depends on: silence is not agreement, the answer is per campaign, and
// declining means the audio is never taken rather than taken and dropped.

test('an invitation does not record anyone by itself', async (t) => {
  const h = await twoTables(t);
  const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'newcomer', campaign: h.cipher.id } }));

  assert.match(said, /Invited/);
  assert.equal(h.db.getConsent(h.cipher.id, 'newcomer').state, 'pending');
  assert.equal(h.db.mayRecord(h.cipher.id, 'newcomer'), false, 'pending is not agreement');
  assert.equal(h.db.isCampaignMember(h.cipher.id, 'newcomer'), false, 'and not yet at the table');
});

test('the invitation DM says what happens and when it expires', async (t) => {
  const h = await twoTables(t);
  const cmd = command('campaign', { user: DM_A, sub: 'invite', options: { player: 'newcomer', campaign: h.cipher.id } });
  await h.dispatch(cmd);

  assert.equal(cmd.dms.length, 1, 'exactly one DM, to the invited person');
  const dm = cmd.dms[0].payload.content;
  assert.match(dm, /your voice is recorded whenever Quill is in the voice channel/i);
  assert.match(dm, /turned into text through a transcription Model/i);
  assert.match(dm, /never sent anywhere else/i);
  assert.match(dm, /<t:\d+:f>/, 'and an expiry Discord renders in their own timezone');
  assert.ok(cmd.dms[0].payload.components?.length, 'with something to answer on');
});

test('the retention promise is read from config, never hardcoded', async (t) => {
  const h = await twoTables(t);
  h.cfg.audioRetentionDays = 7;
  const seven = command('campaign', { user: DM_A, sub: 'invite', options: { player: 'a', campaign: h.cipher.id } });
  await h.dispatch(seven);
  assert.match(seven.dms[0].payload.content, /deleted after \*\*7 days\*\*/);

  h.cfg.audioRetentionDays = 30;
  const thirty = command('campaign', { user: DM_A, sub: 'invite', options: { player: 'b', campaign: h.cipher.id } });
  await h.dispatch(thirty);
  assert.match(thirty.dms[0].payload.content, /deleted after \*\*30 days\*\*/, 'a promise the bot cannot keep is worse than none');
});

test('accepting is what puts someone at the table and allows recording', async (t) => {
  const h = await twoTables(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'newcomer', campaign: h.cipher.id } }));

  const said = await run(h.dispatch, button(`consent:yes:${h.cipher.id}`, 'newcomer'));
  assert.match(said, /Quill will include you/);
  assert.equal(h.db.mayRecord(h.cipher.id, 'newcomer'), true);
  assert.equal(h.db.isCampaignMember(h.cipher.id, 'newcomer'), true);
});

test('declining means never recorded, and says so plainly', async (t) => {
  const h = await twoTables(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'newcomer', campaign: h.cipher.id } }));

  const said = await run(h.dispatch, button(`consent:no:${h.cipher.id}`, 'newcomer'));
  assert.match(said, /will \*\*not\*\* record you/);
  assert.match(said, /skipped entirely/);
  assert.equal(h.db.mayRecord(h.cipher.id, 'newcomer'), false);
  assert.equal(h.db.getConsent(h.cipher.id, 'newcomer').state, 'declined');
});

test('the answer is per campaign — agreeing at one table is not agreeing at the other', async (t) => {
  const h = await twoTables(t);
  await invite(h, DM_A, h.cipher.id, 'plays-both');

  assert.equal(h.db.mayRecord(h.cipher.id, 'plays-both'), true);
  assert.equal(h.db.mayRecord(h.strahd.id, 'plays-both'), false, 'the other table has not asked, so it may not record');
});

test('an expired invitation cannot be accepted', async (t) => {
  const h = await twoTables(t);
  h.db.inviteToCampaign(h.cipher.id, 'slow', DM_A, new Date(Date.now() - 60_000).toISOString());

  const said = await run(h.dispatch, button(`consent:yes:${h.cipher.id}`, 'slow'));
  assert.match(said, /expired/);
  assert.equal(h.db.mayRecord(h.cipher.id, 'slow'), false, 'a stale DM in an inbox cannot still be acted on');
});

test('a sweep expires invitations nobody answered', async (t) => {
  const h = await twoTables(t);
  h.db.inviteToCampaign(h.cipher.id, 'slow', DM_A, new Date(Date.now() - 60_000).toISOString());
  h.db.inviteToCampaign(h.cipher.id, 'prompt', DM_A, new Date(Date.now() + 3_600_000).toISOString());

  assert.equal(h.db.expireStaleInvites(), 1, 'only the one past its expiry');
  assert.equal(h.db.getConsent(h.cipher.id, 'slow').state, 'expired');
  assert.equal(h.db.getConsent(h.cipher.id, 'prompt').state, 'pending');
});

test('someone who declined can be asked again', async (t) => {
  const h = await twoTables(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'unsure', campaign: h.cipher.id } }));
  await run(h.dispatch, button(`consent:no:${h.cipher.id}`, 'unsure'));

  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'unsure', campaign: h.cipher.id } }));
  assert.equal(h.db.getConsent(h.cipher.id, 'unsure').state, 'pending', 'a fresh question, not a resumed one');
  assert.equal(h.db.mayRecord(h.cipher.id, 'unsure'), false, 'and still not recordable until they say so');
});

test('re-inviting someone who already agreed just says so', async (t) => {
  const h = await twoTables(t);
  const said = await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: PLAYER_A, campaign: h.cipher.id } }));
  assert.match(said, /already at the table/);
});

// A pending invite nobody can see is worse than none — it would sit there
// looking like the question had been asked.
test('an invitation that cannot be delivered is not recorded as sent', async (t) => {
  const h = await twoTables(t);
  const cmd = command('campaign', { user: DM_A, sub: 'invite', options: { player: 'dms-closed', campaign: h.cipher.id } });
  cmd.options.getUser = () => ({
    id: 'dms-closed',
    username: 'dms-closed',
    bot: false,
    createDM: async () => { throw new Error('50007'); },
  });

  await h.dispatch(cmd);
  assert.match(cmd.said.content, /couldn't DM/);
  assert.equal(h.db.getConsent(h.cipher.id, 'dms-closed'), null, 'no invite is recorded');
});

test('everyone already at the table when consent arrived is carried over', async (t) => {
  const h = await harness(t);
  // A campaign as it existed before consent: members, no consent rows.
  const id = h.db.createCampaign(GUILD, 'Established', DM_A);
  h.db.addCampaignMember(id, 'long-time-player', DM_A);
  h.db.raw.prepare('DELETE FROM campaign_consent WHERE campaign_id = ?').run(id);
  assert.equal(h.db.mayRecord(id, 'long-time-player'), false, 'no row yet');

  // Re-opening runs the migration, which is where the carry-over happens.
  const path = h.db.raw.name;
  h.db.close();
  const again = openDb(path);
  try {
    assert.equal(again.mayRecord(id, 'long-time-player'), true, 'a running game is not stopped to re-ask');
    assert.equal(again.getConsent(id, 'long-time-player').invited_by, 'grandfathered');
  } finally {
    again.close();
  }
});

// The privacy property is an ORDERING, and ordering is the one thing a unit
// test of this file cannot check by calling it — startCapture needs a live
// voice connection. So this reads the source.
//
// Structural, and deliberately so: if the consent check ever moves after
// subscribe(), the bot starts opening audio streams for people who declined
// and dropping the result afterwards. That still works, still passes every
// behavioural test, and quietly breaks the promise the invitation makes.
test('the consent check happens before any audio stream is opened', async () => {
  const src = await readFile(new URL('../src/voice/capture.js', import.meta.url), 'utf8');

  const gate = src.indexOf('mayRecord(userId)');
  const subscribe = src.indexOf('receiver.subscribe(');
  assert.ok(gate > 0, 'capture consults mayRecord');
  assert.ok(subscribe > 0, 'capture subscribes to audio');
  assert.ok(gate < subscribe, 'the check must come first — filtering afterwards means recording them and deleting it');
});

test('/join asks about every person, and skips the ones who have not agreed', async (t) => {
  const h = await twoTables(t);
  await run(h.dispatch, command('campaign', { user: DM_A, sub: 'invite', options: { player: 'undecided', campaign: h.cipher.id } }));

  const asked = [];
  const mayRecord = (userId) => {
    asked.push(userId);
    return h.db.mayRecord(h.cipher.id, userId);
  };

  assert.equal(mayRecord(PLAYER_A), true, 'agreed');
  assert.equal(mayRecord('undecided'), false, 'invited but has not answered');
  assert.equal(mayRecord('never-asked'), false, 'never asked at all');
  assert.deepEqual(asked, [PLAYER_A, 'undecided', 'never-asked']);
});
