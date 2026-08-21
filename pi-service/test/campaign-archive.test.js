import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  archiveCampaign, restoreArchivedCampaign, restorableBy,
  mayDelete, nameMatches, daysLeftToRestore, RESTORE_WINDOW_DAYS,
} from '../src/campaign/archive.js';
import { campaignNameClash } from '../src/campaign/resolve.js';
import { runAction } from '../src/web/actions.js';
import { registerCommandHandlers, activeSessions } from '../src/commands/index.js';

// Deleting a campaign, and being able to take it back.
//
// The thing this file is really testing is that "delete" does not delete. A
// campaign holds every session anybody ever recorded at that table, and the
// moment somebody is most likely to press this is the moment they should least
// be trusted with it — after a bad session, or an argument. So the tests below
// are mostly about what is still there afterwards.

const DEV = 'owner-1';
const CREATOR = 'dm-of-cipher';
const OTHER_DM = 'dm-of-strahd';
const PLAYER = 'plays-in-cipher';

const cfg = { ownerUserId: DEV };

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-archive-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cipher = db.createCampaign('guild-1', 'Cipher', CREATOR);
  db.createCampaign('guild-1', 'Strahd', OTHER_DM);
  db.setConsent(cipher, PLAYER, true);

  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId: cipher, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
    { userId: CREATOR, displayName: 'kez', startMs: 2, endMs: 3, text: 'The clerk looks up.' },
  ]);
  db.endMeeting(meeting, '2026-08-01T22:00:00Z');
  db.addCorrection(cipher, 'Kaylen', 'Kaelen');

  return { db, dir, cipher, meeting };
}

const del = (db, campaignId, userId, typedName) =>
  archiveCampaign({ db, cfg, campaignId, userId, typedName });

// --- it does not delete ---

test('deleting keeps every line anybody spoke', async (t) => {
  const { db, cipher, meeting } = await world(t);
  const before = db.listUtterances(meeting).map((u) => u.text);

  assert.equal(del(db, cipher, CREATOR, 'Cipher').ok, true);

  assert.deepEqual(db.listUtterances(meeting).map((u) => u.text), before, 'not one line touched');
  assert.ok(db.getCampaignIncludingArchived(cipher), 'the campaign row is still there');
  assert.deepEqual(db.listCorrections(cipher), [{ wrong_text: 'Kaylen', correct_text: 'Kaelen' }]);
});

test('and it comes back whole', async (t) => {
  const { db, cipher, meeting } = await world(t);
  del(db, cipher, CREATOR, 'Cipher');

  const back = restoreArchivedCampaign({ db, cfg, campaignId: cipher, userId: CREATOR });
  assert.equal(back.ok, true);

  const restored = db.getCampaign(cipher);
  assert.equal(restored.name, 'Cipher');
  assert.equal(restored.sessions, 1);
  assert.equal(db.listUtterances(meeting).length, 2);
});

// --- it disappears ---

test('a deleted campaign is gone from every list at once', async (t) => {
  const { db, cipher } = await world(t);
  del(db, cipher, CREATOR, 'Cipher');

  assert.deepEqual(db.listCampaigns().map((c) => c.name), ['Strahd']);
  assert.deepEqual(db.listCampaignsInGuild('guild-1').map((c) => c.name), ['Strahd']);
  assert.deepEqual(db.listCampaignsForUser(PLAYER), [], 'a player it belonged to cannot see it either');
  assert.equal(db.getCampaign(cipher), null, 'so every action on it refuses by itself');
});

// getCampaign returning null is what makes the rest of the bot safe without
// auditing it: every permission check already refuses a campaign it cannot find.
test('nothing can be done to a deleted campaign while it is deleted', async (t) => {
  const { db, cipher } = await world(t);
  del(db, cipher, CREATOR, 'Cipher');

  assert.equal(db.getCampaign(cipher), null);
  assert.equal(
    archiveCampaign({ db, cfg, campaignId: cipher, userId: CREATOR, typedName: 'Cipher' }).ok,
    false,
    'including deleting it twice'
  );
});

// The one thing archiving must NOT hide. The folder is still on disk with the
// notes in it, so a new campaign taking that name would interleave the two —
// and would do it to a campaign nobody can currently see to notice.
test('a deleted campaign still holds its name against a new one', async (t) => {
  const { db, cipher } = await world(t);
  del(db, cipher, CREATOR, 'Cipher');

  const clash = campaignNameClash(db, 'Cipher');
  assert.ok(clash, 'the folder is still there, so the name is still taken');
  assert.equal(clash.id, cipher);
});

// --- typing the name ---

test('the name has to be typed, and typed correctly', async (t) => {
  const { db, cipher } = await world(t);

  assert.equal(del(db, cipher, CREATOR, '').reason, 'name-mismatch');
  assert.equal(del(db, cipher, CREATOR, 'Cypher').reason, 'name-mismatch');
  assert.equal(del(db, cipher, CREATOR, 'yes').reason, 'name-mismatch');
  assert.ok(db.getCampaign(cipher), 'and none of those deleted anything');

  assert.equal(del(db, cipher, CREATOR, 'Cipher').ok, true);
});

// Loose on case and whitespace on purpose: demanding exact capitalisation only
// teaches people to copy-paste the name, which removes the pause entirely.
test('case and surrounding space are forgiven, because the pause is the point', async (t) => {
  const { db, cipher } = await world(t);
  assert.equal(del(db, cipher, CREATOR, '  cipher  ').ok, true);
});

test('the refusal says what to type', async (t) => {
  const { db, cipher } = await world(t);
  assert.match(del(db, cipher, CREATOR, 'nope').message, /Cipher/);
});

test('nameMatches refuses a campaign with no name rather than matching empty', () => {
  assert.equal(nameMatches('', { name: null, channel_name: null }), false);
  assert.equal(nameMatches('  ', { name: 'Cipher' }), false);
});

// --- who may do it ---

test('only whoever runs it can delete it', async (t) => {
  const { db, cipher } = await world(t);

  for (const who of [PLAYER, OTHER_DM, 'a-stranger']) {
    const result = del(db, cipher, who, 'Cipher');
    assert.equal(result.ok, false, `${who} must not be able to delete it`);
    assert.equal(result.reason, 'not-yours');
  }
  assert.ok(db.getCampaign(cipher), 'and it is still there');
});

// The operator is not a second DM, but it is their hardware, and a campaign
// whose creator has left Discord otherwise cannot be cleaned up by anyone.
test('the bot owner can too', async (t) => {
  const { db, cipher } = await world(t);
  assert.equal(del(db, cipher, DEV, 'Cipher').ok, true);
});

test('mayDelete says no to the people it should', async (t) => {
  const { db, cipher } = await world(t);
  const campaign = db.getCampaign(cipher);

  assert.equal(mayDelete({ campaign, userId: CREATOR, cfg }), true);
  assert.equal(mayDelete({ campaign, userId: DEV, cfg }), true);
  assert.equal(mayDelete({ campaign, userId: PLAYER, cfg }), false);
  assert.equal(mayDelete({ campaign, userId: null, cfg }), false);
  assert.equal(mayDelete({ campaign: null, userId: CREATOR, cfg }), false);
  assert.equal(mayDelete({ campaign, userId: DEV, cfg: {} }), false, 'no configured owner, no exemption');
});

test('somebody else cannot restore what they could not delete', async (t) => {
  const { db, cipher } = await world(t);
  del(db, cipher, CREATOR, 'Cipher');

  const sneak = restoreArchivedCampaign({ db, cfg, campaignId: cipher, userId: OTHER_DM });
  assert.equal(sneak.ok, false);
  assert.equal(db.getCampaign(cipher), null, 'still deleted');
});

// --- the thirty days ---

test('the window is counted in whole days remaining', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const justNow = new Date(now).toISOString();

  assert.equal(daysLeftToRestore(justNow, now), RESTORE_WINDOW_DAYS);
  assert.equal(daysLeftToRestore(new Date(now - 29 * 86400000).toISOString(), now), 1);
  assert.equal(daysLeftToRestore(new Date(now - 30 * 86400000).toISOString(), now), 0);
  assert.equal(daysLeftToRestore(new Date(now - 400 * 86400000).toISOString(), now), 0, 'never negative');
});

test('restoring is refused once the window has closed', async (t) => {
  const { db, cipher } = await world(t);
  const longAgo = new Date(Date.now() - 31 * 86400000).toISOString();
  db.archiveCampaign(cipher, CREATOR, longAgo);

  const late = restoreArchivedCampaign({ db, cfg, campaignId: cipher, userId: CREATOR });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
});

// The window closing must not be mistaken for the data going away.
test('an expired campaign has still lost nothing', async (t) => {
  const { db, cipher, meeting } = await world(t);
  db.archiveCampaign(cipher, CREATOR, new Date(Date.now() - 400 * 86400000).toISOString());

  assert.equal(db.listUtterances(meeting).length, 2, 'a year later, every line is still there');
  assert.ok(db.getCampaignIncludingArchived(cipher));
});

test('what you can restore is only ever yours', async (t) => {
  const { db, cipher } = await world(t);
  const strahd = db.listCampaigns().find((c) => c.name === 'Strahd');
  del(db, cipher, CREATOR, 'Cipher');
  del(db, strahd.id, OTHER_DM, 'Strahd');

  assert.deepEqual(restorableBy({ db, cfg, userId: CREATOR }).map((c) => c.name), ['Cipher']);
  assert.deepEqual(restorableBy({ db, cfg, userId: OTHER_DM }).map((c) => c.name), ['Strahd']);
  assert.deepEqual(restorableBy({ db, cfg, userId: PLAYER }), []);
  assert.equal(restorableBy({ db, cfg, userId: DEV }).length, 2, 'the operator sees both');
});

test('an expired campaign drops off the restorable list', async (t) => {
  const { db, cipher } = await world(t);
  db.archiveCampaign(cipher, CREATOR, new Date(Date.now() - 31 * 86400000).toISOString());

  assert.deepEqual(restorableBy({ db, cfg, userId: CREATOR }), []);
});

// --- the dashboard's version of the same act ---

// The typed name is checked by the bot, not by the page. A confirmation the
// client can skip is a confirmation that is not there — anybody can POST.
test('the web action checks the typed name itself', async (t) => {
  const { db, cipher } = await world(t);
  const viewer = { level: 'creator', userId: CREATOR, can: { manage: true } };

  const skipped = runAction({
    pathname: '/actions/campaign/delete',
    body: { campaignId: cipher },
    db, cfg, ctx: { viewer },
  });
  assert.equal(skipped.payload.ok, false, 'no name typed, no deletion');
  assert.ok(db.getCampaign(cipher));

  const wrong = runAction({
    pathname: '/actions/campaign/delete',
    body: { campaignId: cipher, confirm: 'something else' },
    db, cfg, ctx: { viewer },
  });
  assert.equal(wrong.payload.ok, false);
  assert.ok(db.getCampaign(cipher), 'still there');

  const right = runAction({
    pathname: '/actions/campaign/delete',
    body: { campaignId: cipher, confirm: 'Cipher' },
    db, cfg, ctx: { viewer },
  });
  assert.equal(right.payload.ok, true);
  assert.equal(db.getCampaign(cipher), null);
});

test('the web action takes who is asking from the session, not the body', async (t) => {
  const { db, cipher } = await world(t);
  const viewer = { level: 'player', userId: PLAYER, can: { manage: true } };

  const res = runAction({
    pathname: '/actions/campaign/delete',
    body: { campaignId: cipher, confirm: 'Cipher', userId: CREATOR },
    db, cfg, ctx: { viewer },
  });

  assert.equal(res.payload.ok, false, 'naming the creator in the body does not make you them');
  assert.equal(res.payload.reason, 'not-yours');
  assert.ok(db.getCampaign(cipher));
});

test('an unidentified caller cannot delete anything', async (t) => {
  const { db, cipher } = await world(t);
  const res = runAction({
    pathname: '/actions/campaign/delete',
    body: { campaignId: cipher, confirm: 'Cipher' },
    db, cfg: { ownerUserId: null }, ctx: { viewer: { level: 'none', userId: null, can: {} } },
  });

  assert.equal(res.status, 403);
  assert.ok(db.getCampaign(cipher));
});

test('the web action restores, for the person who deleted it', async (t) => {
  const { db, cipher } = await world(t);
  del(db, cipher, CREATOR, 'Cipher');

  const mine = { level: 'creator', userId: CREATOR, can: { manage: true } };
  const theirs = { level: 'creator', userId: OTHER_DM, can: { manage: true } };

  const refused = runAction({
    pathname: '/actions/campaign/restore', body: { campaignId: cipher }, db, cfg, ctx: { viewer: theirs },
  });
  assert.equal(refused.payload.ok, false);
  assert.equal(db.getCampaign(cipher), null, 'still deleted');

  const back = runAction({
    pathname: '/actions/campaign/restore', body: { campaignId: cipher }, db, cfg, ctx: { viewer: mine },
  });
  assert.equal(back.payload.ok, true);
  assert.ok(db.getCampaign(cipher));
});

// --- and through the real dispatcher ---
//
// The handlers are the easy part. What needed proving is the routing: `delete`
// resolves a campaign the normal way, and `restore` deliberately does not,
// because the resolver cannot see an archived campaign at all.

async function dispatcher(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-arch-cmd-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const conf = {
    ownerUserId: DEV, dataDir: dir, summaryProvider: 'gemini',
    geminiApiKey: 'k', geminiModel: 'gemini-3.6-flash',
    driveSyncEnabled: false, transcribeRequireApproval: false, summaryRequireApproval: false,
  };

  let dispatch = null;
  registerCommandHandlers({ on: (e, fn) => { if (e === 'interactionCreate') dispatch = fn; } }, db, conf);

  t.after(async () => {
    activeSessions.clear();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cipher = db.createCampaign('guild-x', 'Cipher', CREATOR);
  return { db, dispatch, cipher };
}

function say({ user, sub, options = {} }) {
  const said = { content: null };
  const take = (p) => { said.content = typeof p === 'string' ? p : p?.content ?? ''; return Promise.resolve({}); };
  return {
    said, commandName: 'campaign', guildId: 'guild-x', channelId: 'c',
    user: { id: user, username: user }, member: null, client: {},
    isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true,
    deferred: false, replied: false,
    options: {
      getSubcommand: () => sub,
      getString: (k) => (options[k] === undefined ? null : String(options[k])),
      getInteger: () => null, getBoolean: () => null, getUser: () => null,
      getChannel: () => null, getAttachment: () => null, getFocused: () => '',
    },
    reply: take, editReply: take, followUp: take, deferReply: () => Promise.resolve(),
  };
}

const fire = async (dispatch, i) => { await dispatch(i); return i.said.content ?? ''; };

test('/campaign delete needs the name, then works', async (t) => {
  const { db, dispatch, cipher } = await dispatcher(t);

  await fire(dispatch, say({ user: CREATOR, sub: 'delete', options: { confirm: 'nope', campaign: cipher } }));
  assert.ok(db.getCampaign(cipher), 'a wrong name deletes nothing');

  await fire(dispatch, say({ user: CREATOR, sub: 'delete', options: { confirm: 'Cipher', campaign: cipher } }));
  assert.equal(db.getCampaign(cipher), null);
});

test('/campaign restore lists what is waiting, then brings it back', async (t) => {
  const { db, dispatch, cipher } = await dispatcher(t);
  await fire(dispatch, say({ user: CREATOR, sub: 'delete', options: { confirm: 'Cipher', campaign: cipher } }));

  const listed = await fire(dispatch, say({ user: CREATOR, sub: 'restore' }));
  assert.match(listed, /Cipher/);
  assert.match(listed, /day/);

  const back = await fire(dispatch, say({ user: CREATOR, sub: 'restore', options: { campaign: 'Cipher' } }));
  assert.match(back, /back/i);
  assert.ok(db.getCampaign(cipher), 'restored through a resolver that cannot see archived campaigns');
});

test('/campaign restore shows a player nothing, because they deleted nothing', async (t) => {
  const { dispatch, cipher } = await dispatcher(t);
  await fire(dispatch, say({ user: CREATOR, sub: 'delete', options: { confirm: 'Cipher', campaign: cipher } }));

  const said = await fire(dispatch, say({ user: PLAYER, sub: 'restore' }));
  assert.doesNotMatch(said, /Cipher/, 'somebody else\'s deleted campaign is not theirs to see');
});
