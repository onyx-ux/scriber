import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { registerCommandHandlers, activeSessions, sessionsInGuild } from '../src/commands/index.js';
import { JOIN_ALREADY_RECORDING, JOIN_CHANNEL_BUSY } from '../src/flavor.js';
import { voicePool } from '../src/voice/pool.js';
import { buildStatus } from '../src/web/status.js';
import { buildViewer } from '../src/web/viewer.js';
import { scopeStatus } from '../src/web/scope.js';

// Two tables playing in ONE Discord at the same time.
//
// Discord gives one bot user one voice connection per server, so this needs a
// second bot USER — a second application, its own token in DISCORD_VOICE_TOKENS
// — and everything below is about what the rest of the bot then has to stop
// assuming. The guild used to identify the session: it keyed activeSessions,
// it answered "is this campaign recording", it chose which session /leave
// ended, and it decided who the dashboard showed a live recording to. None of
// those questions has one answer any more.
//
// What is NOT covered here is the voice socket itself, which needs a real
// Discord to say anything about. The line this file stops at is the one where
// startCapture is called; the decision of WHICH bot and WHICH channel is
// everything before it, and that is what is pinned below.

const OWNER = 'owner-1';
const DM_A = 'dm-of-cipher';
const DM_B = 'dm-of-strahd';
const PLAYER_A = 'plays-in-cipher';
const PLAYER_B = 'plays-in-strahd';
const GUILD = 'one-server';
const CELLAR = 'voice-cellar';   // where Cipher plays
const SOLAR = 'voice-solar';     // where Strahd plays
const SNUG = 'voice-snug';       // a third room, nobody recording

const cfg = {
  ownerUserId: OWNER,
  summaryProvider: 'gemini',
  geminiApiKey: 'k',
  geminiModel: 'gemini-3.6-flash',
  scheduleTimeZone: 'Australia/Brisbane',
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeRequireApproval: true,
  summaryRequireApproval: false,
  driveSyncEnabled: false,
};

// A bot client, asked only whether it is in a guild and — for the extras —
// for the channel as IT sees it. `reachable: false` models the state a mule is
// in before it has been invited to the server, which is where /join stops.
function botClient({ guilds = [GUILD], username = 'Quill', reachable = true } = {}) {
  return {
    user: { username, tag: `${username}#0001` },
    guilds: { cache: new Map(guilds.map((id) => [id, { id, name: 'The Cellar' }])) },
    channels: { fetch: async (id) => (reachable ? { id, name: 'a room', guild: {} } : null) },
  };
}

async function harness(t, { extras = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-two-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const conf = { ...cfg, dataDir: dir, obsidianExportDir: join(dir, 'obsidian') };
  await mkdir(conf.obsidianExportDir, { recursive: true });

  const cipher = db.createCampaign(GUILD, 'Cipher', DM_A);
  const strahd = db.createCampaign(GUILD, 'Strahd', DM_B);
  // Agreeing to be recorded is what puts somebody at a table, which is the
  // route the roster actually grows by — see campaign/consent.js.
  db.setConsent(cipher, PLAYER_A, true);
  db.setConsent(strahd, PLAYER_B, true);

  const pool = voicePool(botClient({ username: 'Quill' }), extras);

  let dispatch = null;
  registerCommandHandlers(
    { on: (event, fn) => { if (event === 'interactionCreate') dispatch = fn; } },
    db,
    conf,
    pool
  );
  assert.ok(dispatch, 'the dispatcher registered itself');

  t.after(async () => {
    activeSessions.clear();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg: conf, dir, dispatch, pool, cipher, strahd };
}

// Puts a table on air, exactly as handleJoin does when the connection comes up.
function onAir(db, { campaignId, voiceChannelId, botId = 'primary', channelName = 'a room' }) {
  const meetingId = db.createMeeting({
    guildId: GUILD,
    campaignId,
    channelId: 'the-channel',
    channelName,
    startedAt: new Date().toISOString(),
    audioDir: `/tmp/${voiceChannelId}`,
  });
  activeSessions.set(meetingId, {
    meetingId,
    guildId: GUILD,
    voiceChannelId,
    campaignId,
    botId,
    handle: { disconnect() {} },
    capturedUtterances: [],
    audioDir: `/tmp/${voiceChannelId}`,
    channelName,
    startedAtMs: Date.now(),
  });
  return meetingId;
}

function command(name, { user, sub = null, options = {}, inVoice = null } = {}) {
  const said = { content: null };
  const take = (payload) => {
    said.content = typeof payload === 'string' ? payload : (payload?.content ?? said.content);
    return Promise.resolve();
  };

  return {
    said,
    commandName: name,
    guildId: GUILD,
    channelId: 'the-channel',
    user: { id: user, username: user },
    // Where the person running the command is sitting. The strongest signal
    // /leave has about which of two sessions they mean.
    member: inVoice
      ? { voice: { channelId: inVoice, channel: { id: inVoice, name: inVoice, members: new Map() } } }
      : null,
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
      getUser: () => null,
      getChannel: () => null,
      getAttachment: () => null,
      getFocused: (withType) => (withType ? { name: 'campaign', value: '' } : ''),
    },
    reply: take,
    editReply: take,
    followUp: take,
    deferReply: () => Promise.resolve(),
  };
}

function autocomplete(name, { user } = {}) {
  const got = { choices: null };
  return {
    got,
    commandName: name,
    guildId: GUILD,
    user: { id: user },
    isButton: () => false,
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    options: {
      getSubcommand: () => null,
      getString: () => null,
      getFocused: (withType) => (withType ? { name: 'campaign', value: '' } : ''),
    },
    respond: (choices) => { got.choices = choices; return Promise.resolve(); },
  };
}

const run = async (dispatch, interaction) => {
  await dispatch(interaction);
  return interaction.said?.content ?? interaction.got?.choices;
};

// --- which bot takes the table ---

// The refusal that survives, and the only one that should. Two /joins in the
// same room is still one room.
test('a second /join into a channel already being recorded is refused', async (t) => {
  const { db, dispatch, cipher } = await harness(t, { extras: [botClient({ username: 'Quill II' })] });
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });

  const said = await run(dispatch, command('join', { user: PLAYER_A, inVoice: CELLAR }));

  // One of a dozen flavour lines, picked at random — so this asserts WHICH
  // refusal it is, not how that refusal happens to be worded today. The room
  // being taken and every bot being busy are different noes now.
  assert.ok(JOIN_CHANNEL_BUSY.includes(said), `unexpected refusal: ${said}`);
  assert.equal(sessionsInGuild(GUILD).length, 1, 'and nothing was started on top of it');
});

// One bot, one table — the install nobody has added a token to, which must
// behave exactly as it did before any of this existed.
test('with one bot, a second table in the same server is refused', async (t) => {
  const { db, dispatch, cipher } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });

  const said = await run(dispatch, command('join', { user: PLAYER_B, inVoice: SOLAR, options: { campaign: 'Strahd' } }));

  assert.ok(JOIN_ALREADY_RECORDING.includes(said), `unexpected refusal: ${said}`);
  assert.equal(sessionsInGuild(GUILD).length, 1);
});

// The whole point. With a second bot the same /join gets past the gate and is
// routed to that bot — proved by where it fails: only a non-primary bot is
// asked to fetch the channel through its own client, so reaching that message
// means the second bot was the one picked.
test('with a second bot, a second table is allowed and routed to it', async (t) => {
  const { db, dispatch, cipher } = await harness(t, {
    extras: [botClient({ username: 'Quill II', reachable: false })],
  });
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });

  const said = await run(dispatch, command('join', { user: PLAYER_B, inVoice: SOLAR, options: { campaign: 'Strahd' } }));

  assert.match(said, /second voice/, 'the mule was chosen, and said so when it could not reach the channel');
  assert.ok(!JOIN_ALREADY_RECORDING.some((line) => said.startsWith(line)), 'the other table is no longer a reason to refuse');
});

// Every bot busy is a no, not a queue: a /join that quietly succeeded when
// some other table finished would start recording mid-scene, unannounced.
test('when every bot is busy the refusal says how many there are', async (t) => {
  const { db, dispatch, cipher, strahd } = await harness(t, {
    extras: [botClient({ username: 'Quill II' })],
  });
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR, botId: 'primary' });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1' });
  db.setConsent(cipher, PLAYER_B, true); // so the roster gate is not what answers

  const said = await run(dispatch, command('join', { user: PLAYER_B, inVoice: SNUG, options: { campaign: 'Cipher' } }));

  assert.match(said, /All 2 of my voices/, 'and says how many, since that is the number to act on');
  assert.match(said, /DISCORD_VOICE_TOKENS/, 'and where another one would come from');
  assert.equal(sessionsInGuild(GUILD).length, 2, 'nothing was started, and nothing was stopped');
});

// --- which session /leave ends ---

test('two live sessions and a bare /leave from outside names both, and stops neither', async (t) => {
  const { db, dispatch, cipher, strahd } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1' });

  const said = await run(dispatch, command('leave', { user: PLAYER_A }));

  assert.match(said, /\*\*2\*\* tables/);
  assert.match(said, /Cipher/);
  assert.match(said, /Strahd/, 'the difficulty is not being able to see what is live, so both are named');
  assert.equal(sessionsInGuild(GUILD).length, 2, 'nothing is stopped by being asked');
});

test('naming one of two live tables ends exactly that one', async (t) => {
  const { db, dispatch, cipher, strahd } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });
  const strahdMeeting = onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1' });

  await run(dispatch, command('leave', { user: PLAYER_A, options: { campaign: 'Cipher' } }));

  const left = sessionsInGuild(GUILD);
  assert.equal(left.length, 1);
  assert.equal(left[0].meetingId, strahdMeeting, "the other table's evening is untouched");
  assert.equal(db.getMeeting(strahdMeeting).ended_at, null, 'and not ended behind its back');
});

// Standing in the room is what tells the two apart. It does not excuse anyone
// from naming the table — a server with two campaigns still asks, exactly as
// it did before — but it decides WHICH one the question is asked about, and
// that used to be an arbitrary pick between them.
test('a bare /leave from inside a recorded channel asks about that table', async (t) => {
  const { db, dispatch, cipher, strahd } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1' });

  const said = await run(dispatch, command('leave', { user: PLAYER_B, inVoice: SOLAR }));

  assert.match(said, /more than one table/);
  assert.match(said, /I'm recording \*\*Strahd\*\*/, 'the room they are sitting in, not whichever came first');
  assert.equal(sessionsInGuild(GUILD).length, 2);
});

// The membership gate still answers first, and now has two sessions to be
// wrong about rather than one.
test("a player at one table cannot end the other table's session", async (t) => {
  const { db, dispatch, cipher, strahd } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1' });

  const said = await run(dispatch, command('leave', { user: PLAYER_A, options: { campaign: 'Strahd' } }));

  assert.match(said, /you're not at that table/);
  assert.equal(sessionsInGuild(GUILD).length, 2);
});

test('the picker offers every table that is actually recording', async (t) => {
  const { db, dispatch, cipher, strahd } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1' });

  const choices = await run(dispatch, autocomplete('leave', { user: PLAYER_A }));

  // The label carries a session count after the name, so match rather than
  // compare — the value is the id, and that is what has to be exactly right.
  assert.deepEqual(choices.map((c) => c.value).sort(), [String(cipher), String(strahd)].sort());
  assert.ok(choices.some((c) => /Cipher/.test(c.name)));
  assert.ok(choices.some((c) => /Strahd/.test(c.name)));
});

// --- what the dashboard is told ---

test('two tables in one Discord are two sessions, on their own campaigns', async (t) => {
  const { db, cfg: conf, cipher, strahd } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR, channelName: 'The Cellar' });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1', channelName: 'The Solar' });

  const client = { user: { tag: 'Quill#1' }, guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'The House' }]]) } };
  const s = buildStatus({ db, cfg: conf, client, activeSessions });

  assert.equal(s.recording.length, 2);
  assert.deepEqual(s.recording.map((r) => r.channel).sort(), ['The Cellar', 'The Solar']);
  assert.equal(s.servers[0].recording, true);
  assert.equal(s.servers[0].recordings, 2, 'one flag could not have said there were two');

  // The flag used to mean "this Discord is recording", so one /join lit every
  // campaign in the server. Each campaign now answers for itself.
  const byName = Object.fromEntries(s.campaigns.map((c) => [c.name, c]));
  assert.equal(byName.Cipher.recording, true);
  assert.equal(byName.Strahd.recording, true);
  assert.ok(byName.Cipher.meetingId, 'and names its own session, so the live clock can find it');
  assert.notEqual(byName.Cipher.meetingId, byName.Strahd.meetingId);
});

test('one of two tables recording lights only that one', async (t) => {
  const { db, cfg: conf, cipher } = await harness(t);
  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR });

  const s = buildStatus({ db, cfg: conf, client: null, activeSessions });
  const byName = Object.fromEntries(s.campaigns.map((c) => [c.name, c]));

  assert.equal(byName.Cipher.recording, true);
  assert.equal(byName.Strahd.recording, false, 'sharing a Discord is not being recorded');
});

// A player could always see the live session in a server they had a table in.
// That was harmless while a server held one session; it is not now, because
// the session it shows them may be the other group's game.
test("a player is not shown the other table's live session", async (t) => {
  const { db, cfg: conf, cipher, strahd } = await harness(t);
  // A viewer's scope comes from having actually spoken at a table.
  const played = db.createMeeting({
    guildId: GUILD, campaignId: cipher, channelId: 'c', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(played, [
    { userId: PLAYER_A, displayName: 'Ben', startMs: 0, endMs: 1, text: 'We go left.' },
  ]);
  db.endMeeting(played, '2026-08-01T22:00:00Z');

  onAir(db, { campaignId: cipher, voiceChannelId: CELLAR, channelName: 'The Cellar' });
  onAir(db, { campaignId: strahd, voiceChannelId: SOLAR, botId: 'voice-1', channelName: 'The Solar' });

  const viewer = buildViewer({ db, cfg: conf, userId: PLAYER_A });
  const scoped = scopeStatus(buildStatus({ db, cfg: conf, client: null, activeSessions, viewer }), viewer);

  assert.equal(scoped.recording.length, 1, 'one table is theirs; the other is a different game in the same house');
  assert.equal(scoped.recording[0].campaignId, cipher);
});
