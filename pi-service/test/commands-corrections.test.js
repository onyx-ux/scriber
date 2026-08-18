import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { registerCommandHandlers, activeSessions } from '../src/commands/index.js';

// Correcting a misheard name, from Discord.
//
// Driven through the real dispatcher rather than by calling the handlers,
// because the handler was the easy part. What needed proving is the wiring
// around it: that the route exists, that the subcommand sits in the manager
// tier so a player at the table cannot rewrite the record, and that the
// blast-radius guard came along rather than being left behind on the web page.

const OWNER = 'owner-1';
const DM = 'dm-of-cipher';
const PLAYER = 'plays-in-cipher';
const GUILD = 'one-server';

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-corr-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const cfg = {
    ownerUserId: OWNER, dataDir: dir, summaryProvider: 'gemini',
    geminiApiKey: 'k', geminiModel: 'gemini-3.6-flash',
    driveSyncEnabled: false, transcribeRequireApproval: false, summaryRequireApproval: false,
  };

  let dispatch = null;
  registerCommandHandlers({ on: (e, fn) => { if (e === 'interactionCreate') dispatch = fn; } }, db, cfg);
  assert.ok(dispatch, 'the dispatcher registered itself');

  t.after(async () => {
    activeSessions.clear();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, dispatch };
}

function command({ user, sub, options = {} }) {
  const said = { content: null };
  const take = (payload) => {
    said.content = typeof payload === 'string' ? payload : payload?.content ?? '';
    return Promise.resolve({});
  };
  return {
    said,
    commandName: 'campaign',
    guildId: GUILD,
    channelId: 'chan',
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
      getBoolean: (k) => (options[k] === undefined ? null : Boolean(options[k])),
      getUser: () => null,
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

const run = async (dispatch, i) => {
  await dispatch(i);
  return i.said.content ?? '';
};

// A campaign with enough recorded lines that the blast-radius guard has
// something to measure.
async function withCampaign(t, { lines = 12 } = {}) {
  const h = await harness(t);
  await run(h.dispatch, command({ user: DM, sub: 'create', options: { name: 'Cipher' } }));
  const campaign = h.db.listCampaigns()[0];

  const meeting = h.db.createMeeting({
    guildId: GUILD, campaignId: campaign.id, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  h.db.finalizeTranscription(
    meeting,
    Array.from({ length: lines }, (_, n) => ({
      userId: PLAYER, displayName: 'saf', startMs: n, endMs: n + 1,
      text: n % 2 ? 'Kaylen opens the ledger.' : 'The clerk looks up.',
    }))
  );
  h.db.endMeeting(meeting, '2026-08-01T22:00:00Z');

  return { ...h, campaign, meeting };
}

// --- the act itself ---

test('a correction can be added without opening a browser', async (t) => {
  const h = await withCampaign(t);

  const said = await run(h.dispatch, command({
    user: DM, sub: 'correct', options: { heard: 'Kaylen', write: 'Kaelen' },
  }));

  assert.match(said, /Kaelen/);
  assert.deepEqual(h.db.listCorrections(h.campaign.id), [{ wrong_text: 'Kaylen', correct_text: 'Kaelen' }]);
});

test('adding one rewrites the lines already recorded', async (t) => {
  const h = await withCampaign(t);
  await run(h.dispatch, command({ user: DM, sub: 'correct', options: { heard: 'Kaylen', write: 'Kaelen' } }));

  const texts = h.db.listUtterances(h.meeting).map((u) => u.text);
  assert.equal(texts.some((t2) => t2.includes('Kaylen')), false, 'the old spelling is gone');
  assert.ok(texts.some((t2) => t2.includes('Kaelen')));
});

test('a correction can be listed and dropped again', async (t) => {
  const h = await withCampaign(t);
  await run(h.dispatch, command({ user: DM, sub: 'correct', options: { heard: 'Kaylen', write: 'Kaelen' } }));

  const listed = await run(h.dispatch, command({ user: DM, sub: 'corrections' }));
  assert.match(listed, /Kaylen/);
  assert.match(listed, /Kaelen/);

  await run(h.dispatch, command({ user: DM, sub: 'uncorrect', options: { heard: 'Kaylen' } }));
  assert.deepEqual(h.db.listCorrections(h.campaign.id), []);
});

test('an empty list says how to start one rather than nothing', async (t) => {
  const h = await withCampaign(t);
  const said = await run(h.dispatch, command({ user: DM, sub: 'corrections' }));

  assert.match(said, /no corrections/i);
  assert.match(said, /campaign correct/);
});

test('replay re-applies every correction over the campaign', async (t) => {
  const h = await withCampaign(t);
  await run(h.dispatch, command({ user: DM, sub: 'correct', options: { heard: 'Kaylen', write: 'Kaelen' } }));

  const said = await run(h.dispatch, command({ user: DM, sub: 'replay' }));
  assert.match(said, /[Rr]eplay/);
});

test('replaying with nothing saved says so', async (t) => {
  const h = await withCampaign(t);
  const said = await run(h.dispatch, command({ user: DM, sub: 'replay' }));

  assert.match(said, /no corrections/i);
});

// --- the guard came with it ---

// The dashboard refuses a one or two character term outright, because matching
// on that catches articles and initials rather than a name. Discord must too,
// or the guard is a property of the web page rather than of the bot.
test('a term too short to be safe is refused here as well', async (t) => {
  const h = await withCampaign(t);

  const said = await run(h.dispatch, command({
    user: DM, sub: 'correct', options: { heard: 'a', write: 'b' },
  }));

  assert.match(said, /too short/i);
  assert.deepEqual(h.db.listCorrections(h.campaign.id), [], 'and nothing was written');
});

test('the refusal says how to go ahead anyway, since there is no dialog to confirm in', async (t) => {
  const h = await withCampaign(t);
  const said = await run(h.dispatch, command({
    user: DM, sub: 'correct', options: { heard: 'a', write: 'b' },
  }));

  assert.match(said, /confirm:True/);
});

test('confirming really does apply it', async (t) => {
  const h = await withCampaign(t);
  const said = await run(h.dispatch, command({
    user: DM, sub: 'correct', options: { heard: 'a', write: 'b', confirm: true },
  }));

  assert.doesNotMatch(said, /too short/i);
  assert.equal(h.db.listCorrections(h.campaign.id).length, 1);
});

test('the same text twice is refused', async (t) => {
  const h = await withCampaign(t);
  const said = await run(h.dispatch, command({
    user: DM, sub: 'correct', options: { heard: 'Kaylen', write: 'kaylen' },
  }));

  assert.match(said, /same thing/i);
});

// --- who may do it ---

// Corrections rewrite the transcript itself, which is the same authority as
// renaming the campaign rather than a lesser one.
test('a player at the table cannot rewrite the record', async (t) => {
  const h = await withCampaign(t);
  h.db.setConsent(h.campaign.id, PLAYER, true);

  const said = await run(h.dispatch, command({
    user: PLAYER, sub: 'correct', options: { heard: 'Kaylen', write: 'Kaelen' },
  }));

  assert.deepEqual(h.db.listCorrections(h.campaign.id), [], 'nothing was saved');
  assert.ok(said.length > 0, 'and they were told why rather than ignored');
});
