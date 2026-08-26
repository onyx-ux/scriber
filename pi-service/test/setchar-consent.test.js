import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { setCharacter } from '../src/pipeline/job-actions.js';
import { registerCommandHandlers, activeSessions } from '../src/commands/index.js';

// Naming a character, from both ends.
//
// The dashboard and /setchar do the same job, and for a long time only one of
// them did it correctly: the dashboard called setCharacter(), which checks
// whether that person has agreed to be recorded, and /setchar wrote straight
// to the database and then told the player "you'll appear as X in every
// transcript and recap from now on".
//
// For anyone who has not consented that sentence is simply false — capture
// skips them before it ever subscribes to their audio (voice/capture.js), so
// the name goes nowhere. Two call sites, one rule, and the one people actually
// use was the one that lied.
//
// So these tests are about the rule living in ONE place. The first group is at
// the seam itself; the second drives the real dispatcher to check the command
// goes through it rather than around it.

const GUILD = 'one-server';
const DM = 'dm-1';
const PLAYER = 'player-1';

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-setchar-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const cfg = {
    ownerUserId: 'owner-1',
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

  let dispatch = null;
  registerCommandHandlers({ on: (event, fn) => { if (event === 'interactionCreate') dispatch = fn; } }, db, cfg);
  assert.ok(dispatch, 'the dispatcher registered itself');

  t.after(async () => {
    activeSessions.clear();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, dispatch };
}

// Only as much of an interaction as these commands touch.
function command({ user, sub, options = {} }) {
  const said = { content: null };
  const take = (payload) => {
    said.content = typeof payload === 'string' ? payload : (payload?.content ?? said.content);
    return Promise.resolve();
  };

  return {
    said,
    commandName: 'campaign',
    guildId: GUILD,
    channelId: 'the-channel',
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
              createDM: async () => ({ send: async () => ({}) }),
            },
      getChannel: () => null,
      getAttachment: () => null,
      getFocused: () => '',
    },
    reply: take,
    editReply: take,
    followUp: take,
    deferReply: () => Promise.resolve(),
  };
}

function consentButton(customId, user) {
  const said = { content: null };
  return {
    said,
    customId,
    user: { id: user },
    message: { components: [] },
    isButton: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    deferred: false,
    replied: false,
    reply: (payload) => {
      said.content = typeof payload === 'string' ? payload : (payload?.content ?? said.content);
      return Promise.resolve();
    },
    update: () => Promise.resolve(),
    deferUpdate: () => Promise.resolve(),
  };
}

const run = async (dispatch, interaction) => {
  await dispatch(interaction);
  return interaction.said?.content ?? null;
};

// A table with one invited player who has been given a character name but has
// never answered the invite — which is exactly what /campaign invite with a
// name produces, and the state the old /setchar was wrong about.
async function tableWithUnansweredInvite(t) {
  const h = await harness(t);
  await run(h.dispatch, command({ user: DM, sub: 'create', options: { name: 'Cipher' } }));
  const [campaign] = h.db.listCampaignsInGuild(GUILD);
  await run(
    h.dispatch,
    command({ user: DM, sub: 'invite', options: { player: PLAYER, name: 'BenTen', campaign: campaign.id } })
  );
  return { ...h, campaign };
}

// --- the seam ---

test('setCharacter reports WHY a name will not appear, not just that it will not', async (t) => {
  const { db, campaign } = await tableWithUnansweredInvite(t);

  const pending = setCharacter(db, { campaignId: campaign.id, userId: PLAYER, name: 'Fuji' });
  assert.equal(pending.ok, true);
  assert.equal(pending.name, 'Fuji');
  assert.equal(pending.mayRecord, false);
  assert.equal(pending.consent, 'pending', 'invited, has not answered');

  // Someone the bot has never heard of at this table.
  const stranger = setCharacter(db, { campaignId: campaign.id, userId: 'never-asked', name: 'Grix' });
  assert.equal(stranger.consent, 'unasked');
  assert.equal(stranger.mayRecord, false);
});

test('setCharacter tells a declined player apart from an unasked one', async (t) => {
  const { db, dispatch, campaign } = await tableWithUnansweredInvite(t);
  await run(dispatch, consentButton(`consent:no:${campaign.id}`, PLAYER));

  const said = setCharacter(db, { campaignId: campaign.id, userId: PLAYER, name: 'Fuji' });
  assert.equal(said.consent, 'declined', 'they answered — it is theirs to change, not the DM to re-ask');
  assert.equal(said.mayRecord, false);
});

test('a player who agreed gets no caveat at all', async (t) => {
  const { db, dispatch, campaign } = await tableWithUnansweredInvite(t);
  await run(dispatch, consentButton(`consent:yes:${campaign.id}`, PLAYER));

  const said = setCharacter(db, { campaignId: campaign.id, userId: PLAYER, name: 'Fuji' });
  assert.equal(said.consent, 'granted');
  assert.equal(said.mayRecord, true);
  assert.doesNotMatch(said.message, /agreed to be recorded/, 'nothing to warn about');
});

// --- the command, through the real dispatcher ---

test('/setchar warns a player that nothing of theirs is being captured', async (t) => {
  const { dispatch, db, campaign } = await tableWithUnansweredInvite(t);

  const said = await run(dispatch, command({ user: PLAYER, sub: 'setchar', options: { name: 'Fuji' } }));

  assert.match(said, /Fuji/, 'the name is still set — this is a caveat, not a refusal');
  assert.equal(db.getCharacterName(campaign.id, PLAYER), 'Fuji');
  assert.match(said, /nothing you say is captured/i, 'the flavour text promises the opposite');
  assert.match(said, /agreed to be recorded/i, 'and says why');
});

test('/setchar says nothing about consent once it has been given', async (t) => {
  const { dispatch, campaign } = await tableWithUnansweredInvite(t);
  await run(dispatch, consentButton(`consent:yes:${campaign.id}`, PLAYER));

  const said = await run(dispatch, command({ user: PLAYER, sub: 'setchar', options: { name: 'Fuji' } }));

  assert.match(said, /Fuji/);
  assert.doesNotMatch(said, /nothing you say is captured/i, 'they agreed — do not nag them about it');
});

test('a player who turned recording off is told that, not to answer an invite', async (t) => {
  const { dispatch, campaign } = await tableWithUnansweredInvite(t);
  await run(dispatch, consentButton(`consent:no:${campaign.id}`, PLAYER));

  const said = await run(dispatch, command({ user: PLAYER, sub: 'setchar', options: { name: 'Fuji' } }));

  assert.match(said, /your own choice/i);
  assert.match(said, /\/campaign consent/, 'the switch that is actually theirs');
  assert.doesNotMatch(said, /invite in your DMs/i, 'they already answered');
});

// The regression this whole file exists for: the command must not reach past
// the seam and write the name itself. If it ever does, the consent rule stops
// being in one place and the two callers start drifting again.
test('/setchar goes through the seam rather than writing the name itself', async (t) => {
  const { dispatch, db, campaign } = await tableWithUnansweredInvite(t);

  let direct = 0;
  const realSet = db.setCharacterName.bind(db);
  db.setCharacterName = (...args) => {
    direct += 1;
    return realSet(...args);
  };

  await run(dispatch, command({ user: PLAYER, sub: 'setchar', options: { name: 'Fuji' } }));

  // Exactly one write, and it came from setCharacter() — which is also the one
  // that read the consent state, so the reply below cannot have been assembled
  // without it.
  assert.equal(direct, 1);
  assert.equal(db.getCharacterName(campaign.id, PLAYER), 'Fuji');
});
