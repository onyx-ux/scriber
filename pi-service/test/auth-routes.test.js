import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { handleAuthRoute } from '../src/web/auth-routes.js';

// The three requests that make up signing in, tested where they are decided.
//
// auth-flow.test.js drives these through a running server, which is the right
// place to prove the wiring. This file is about the rules themselves -- who a
// typed name resolves to, and what each outcome is allowed to give away -- and
// nothing imported this module directly before it.

async function world(t, { campaign = 'Cipher' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-auth-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = { authSecret: 'a'.repeat(32), ownerUserId: 'dev-1' };
  const campaignId = db.createCampaign('guild-1', campaign, 'dm-1');

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, campaignId };
}

// A model of the bot's side of Discord: it DMs, and it can find a member of a
// guild the bot is in. Records the code so a test can type it back.
function discord({ findable = {} } = {}) {
  const sent = [];
  return {
    sent,
    lastCode: () => sent[sent.length - 1]?.code ?? null,
    ctx: {
      discord: {
        sendCode: async ({ userId, code, username }) => {
          sent.push({ userId, code, username });
          return { ok: true };
        },
        findKnownMember: async ({ query }) => findable[query.toLowerCase()] ?? null,
      },
    },
  };
}

const post = (pathname, body, { db, cfg, ctx, cookie = null }) =>
  handleAuthRoute({
    pathname,
    body,
    req: { headers: cookie ? { cookie } : {} },
    db,
    cfg,
    ctx,
    secure: false,
    tooSoon: () => false,
  });

// Somebody invited to a table who has not been recorded saying anything yet.
//
// /auth/request finds them: it falls back to Discord's member search for
// exactly this person, and the comment on that fallback says so. /auth/verify
// then looked them up in the utterances table alone -- so the bot DMed a valid
// code and refused that same code a moment later with "That code is not
// right." There was no way through it: the only cure was to be recorded
// speaking, which is the thing they were signing in to arrange.
test('a player who has been invited but has never spoken can still sign in', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const bot = discord({ findable: { priya: { userId: 'newbie-1', username: 'Priya' } } });

  // On the roster, with a character name. No utterances: they have not played.
  db.addCampaignMember(campaignId, 'newbie-1', 'dm-1');
  db.setConsent(campaignId, 'newbie-1', true);
  db.setCharacterName(campaignId, 'newbie-1', 'Sildar');

  const asked = await post('/auth/request', { name: 'Priya' }, { db, cfg, ...bot });
  assert.equal(asked.status, 200);
  assert.equal(bot.sent.length, 1, 'the bot DMed a code');

  const done = await post('/auth/verify', { name: 'Priya', code: bot.lastCode() }, { db, cfg, ...bot });

  assert.equal(done.status, 200, done.payload.message);
  assert.equal(done.payload.ok, true);
  assert.equal(done.payload.username, 'Priya');
  assert.match(done.cookie ?? '', /quill_session=/, 'and got a session');
});

// Identity is the Discord username, and only that.
//
// The lookup used to try the transcripts table first, matching whatever
// display name somebody happened to be recorded under, and fall back to
// Discord only if that missed. So the name on screen during a session was an
// identity, which it is not -- it is per-server, changeable at will, and
// usually the character rather than the person. Two things went wrong with it:
// a player typing their real username got nowhere, and a display name shared
// with somebody else could send that person's code to the wrong account.
test('a display name is not an identity, and does not get a code', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  // Recorded all season as "Old Dad", whose actual Discord username is petonyx.
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: 'real-1', displayName: 'Old Dad', startMs: 0, endMs: 1, text: 'I search the body.' },
  ]);
  db.setCharacterName(campaignId, 'real-1', 'Thalgrim');

  const bot = discord({ findable: { petonyx: { userId: 'real-1', username: 'petonyx' } } });

  // The display name they are recorded under: no.
  const byDisplay = await post('/auth/request', { name: 'Old Dad' }, { db, cfg, ...bot });
  assert.equal(byDisplay.status, 200, 'and says so without confirming the account exists');
  assert.equal(bot.sent.length, 0, 'a display name must not get a code');

  // The character name: also no.
  const byCharacter = await post('/auth/request', { name: 'Thalgrim' }, { db, cfg, ...bot });
  assert.equal(byCharacter.status, 200);
  assert.equal(bot.sent.length, 0, 'a character name must not get a code');

  // The username: yes.
  const byUsername = await post('/auth/request', { name: 'petonyx' }, { db, cfg, ...bot });
  assert.equal(byUsername.status, 200);
  assert.equal(bot.sent.length, 1, 'the username is what gets a code');
  assert.equal(bot.sent[0].userId, 'real-1');
  assert.equal(bot.sent[0].username, 'petonyx', 'and the DM names the username, not the display name');

  // And the code verifies against the username it was sent under.
  const done = await post('/auth/verify', { name: 'petonyx', code: bot.lastCode() }, { db, cfg, ...bot });
  assert.equal(done.status, 200, done.payload.message);
  assert.equal(done.payload.username, 'petonyx');
});

// The same string can be one person's display name and another's username.
// Whoever owns the USERNAME is the one who gets the code -- the other account
// must not receive somebody else's sign-in.
test('a username wins over somebody else using it as a display name', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: 'impostor-1', displayName: 'petonyx', startMs: 0, endMs: 1, text: 'that is my name too.' },
  ]);

  const bot = discord({ findable: { petonyx: { userId: 'real-1', username: 'petonyx' } } });

  const asked = await post('/auth/request', { name: 'petonyx' }, { db, cfg, ...bot });
  assert.equal(asked.status, 200);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].userId, 'real-1', 'the code goes to the account that owns the username');
});
