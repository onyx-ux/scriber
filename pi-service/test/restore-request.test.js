import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { archiveCampaign } from '../src/campaign/archive.js';
import {
  requestRestore, decideRestoreRequest, pendingRestoreRequests, wasAtTheTable, QUESTIONS,
} from '../src/campaign/restore-request.js';
import { buildRestoreRequestDm } from '../src/delivery/restore-notify.js';
import { runAction } from '../src/web/actions.js';

// Asking for a deleted campaign back.
//
// The reason this is a ticket and not a button: deleting is the creator's
// decision, and restoring is not. The sessions inside a campaign belong to
// everybody who sat at that table, so the person who deleted it in a temper
// should not be able to undo it twenty minutes later without anybody knowing —
// and the other players should not lose four years of Thursday nights because
// the person holding it is still angry.
//
// Which is why the interesting tests here are about who may ASK, and about the
// fact that nothing comes back without somebody having read why.

const DEV = 'owner-1';
const CREATOR = 'dm-of-cipher';
const PLAYER = 'plays-in-cipher';
const OUTSIDER = 'never-played';

const cfg = { ownerUserId: DEV };

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-req-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cipher = db.createCampaign('guild-1', 'Cipher', CREATOR);
  db.setConsent(cipher, PLAYER, true);

  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId: cipher, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
  ]);
  db.endMeeting(meeting, '2026-08-01T22:00:00Z');

  archiveCampaign({ db, cfg, campaignId: cipher, userId: CREATOR, typedName: 'Cipher' });

  return { db, cipher, meeting };
}

const ask = (db, campaignId, userId, extra = {}) =>
  requestRestore({
    db, cfg, campaignId, userId,
    reason: 'We want to keep playing.',
    whyDeleted: 'I lost my temper after a bad session.',
    takingOwnership: 'no',
    ...extra,
  });

// --- who may ask ---

// The point of the whole feature. A creator who deletes in a temper does not
// get to quietly undo it, and the players who lost their campaign are not
// dependent on that creator calming down.
test('a player who was at the table may ask, not only the creator', async (t) => {
  const { db, cipher } = await world(t);

  assert.equal(ask(db, cipher, CREATOR).ok, true);
  assert.equal(ask(db, cipher, PLAYER).ok, true);
});

test('somebody who never played there may not', async (t) => {
  const { db, cipher } = await world(t);
  const result = ask(db, cipher, OUTSIDER);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-yours');
  assert.equal(db.listRestoreRequests().length, 0);
});

test('wasAtTheTable counts the manager, the roster and anybody who spoke', async (t) => {
  const { db, cipher } = await world(t);

  assert.equal(wasAtTheTable({ db, campaignId: cipher, userId: CREATOR }), true, 'ran it');
  assert.equal(wasAtTheTable({ db, campaignId: cipher, userId: PLAYER }), true, 'spoke in it');
  assert.equal(wasAtTheTable({ db, campaignId: cipher, userId: OUTSIDER }), false);
  assert.equal(wasAtTheTable({ db, campaignId: cipher, userId: null }), false);
});

test('asking about a campaign that is not deleted is refused', async (t) => {
  const { db, cipher } = await world(t);
  db.restoreCampaign(cipher);

  assert.equal(ask(db, cipher, CREATOR).reason, 'not-archived');
});

test('asking past the window says so, and says nothing was erased', async (t) => {
  const { db, cipher } = await world(t);
  // Re-archived with an old date. archiveCampaign will not re-stamp something
  // already archived — deliberately, so a second delete cannot reset the clock.
  db.restoreCampaign(cipher);
  db.archiveCampaign(cipher, CREATOR, new Date(Date.now() - 40 * 86400000).toISOString());

  const late = ask(db, cipher, CREATOR);
  assert.equal(late.reason, 'expired');
  assert.match(late.message, /nothing has been erased/i);
});

// --- the answers ---

test('a request with no reason is not a request', async (t) => {
  const { db, cipher } = await world(t);
  const empty = ask(db, cipher, CREATOR, { reason: '   ' });

  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-reason');
  assert.equal(db.listRestoreRequests().length, 0);
});

test('the three answers are kept exactly as written', async (t) => {
  const { db, cipher } = await world(t);
  ask(db, cipher, PLAYER, {
    reason: 'Four years of Thursdays.',
    whyDeleted: 'The DM and I fell out.',
    takingOwnership: 'Yes, if he does not want it back.',
  });

  const [waiting] = pendingRestoreRequests({ db });
  assert.equal(waiting.reason, 'Four years of Thursdays.');
  assert.equal(waiting.whyDeleted, 'The DM and I fell out.');
  assert.equal(waiting.takingOwnership, 'Yes, if he does not want it back.');
  assert.equal(waiting.isTheCreator, false, 'and it is clear this is not who deleted it');
});

// Somebody told "no" should not be able to simply ask again until they get a
// different answer, which is the pestering the review exists to slow down.
test('one open ticket per person per campaign', async (t) => {
  const { db, cipher } = await world(t);
  assert.equal(ask(db, cipher, PLAYER).ok, true);

  const again = ask(db, cipher, PLAYER);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-pending');
  assert.equal(db.listRestoreRequests().length, 1);
});

test('but two different people may each ask about the same campaign', async (t) => {
  const { db, cipher } = await world(t);
  ask(db, cipher, CREATOR);
  ask(db, cipher, PLAYER);

  assert.equal(pendingRestoreRequests({ db }).length, 2);
});

// --- nothing comes back on its own ---

test('filing a request does not restore anything', async (t) => {
  const { db, cipher } = await world(t);
  ask(db, cipher, CREATOR);

  assert.equal(db.getCampaign(cipher), null, 'still deleted, still waiting');
});

test('approving is what restores it', async (t) => {
  const { db, cipher } = await world(t);
  const { requestId } = ask(db, cipher, PLAYER);

  const decided = decideRestoreRequest({ db, cfg, requestId, decidedBy: DEV, approve: true });
  assert.equal(decided.ok, true);
  assert.equal(decided.approved, true);
  assert.ok(db.getCampaign(cipher), 'and it is back');
});

// Turning one down is a decision that worked, not a failure. Reporting it as a
// failure would make "no" indistinguishable from "the button broke".
test('turning one down succeeds, and leaves the campaign deleted', async (t) => {
  const { db, cipher } = await world(t);
  const { requestId } = ask(db, cipher, CREATOR);

  const decided = decideRestoreRequest({ db, cfg, requestId, decidedBy: DEV, approve: false });
  assert.equal(decided.ok, true);
  assert.equal(decided.approved, false);
  assert.equal(db.getCampaign(cipher), null);
  assert.match(decided.message, /nothing has been erased/i);
});

test('only the operator decides', async (t) => {
  const { db, cipher } = await world(t);
  const { requestId } = ask(db, cipher, PLAYER);

  for (const who of [CREATOR, PLAYER, OUTSIDER, null]) {
    const tried = decideRestoreRequest({ db, cfg, requestId, decidedBy: who, approve: true });
    assert.equal(tried.ok, false, `${who} must not decide`);
  }
  assert.equal(db.getCampaign(cipher), null, 'and none of them restored it');
});

test('a request is decided once', async (t) => {
  const { db, cipher } = await world(t);
  const { requestId } = ask(db, cipher, CREATOR);
  decideRestoreRequest({ db, cfg, requestId, decidedBy: DEV, approve: false });

  const twice = decideRestoreRequest({ db, cfg, requestId, decidedBy: DEV, approve: true });
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, 'already-decided');
  assert.equal(db.getCampaign(cipher), null, 'a denied request cannot be re-approved into a restore');
});

test('deciding one leaves the queue empty', async (t) => {
  const { db, cipher } = await world(t);
  const { requestId } = ask(db, cipher, CREATOR);
  assert.equal(pendingRestoreRequests({ db }).length, 1);

  decideRestoreRequest({ db, cfg, requestId, decidedBy: DEV, approve: true });
  assert.equal(pendingRestoreRequests({ db }).length, 0);
});

// --- what the operator is told ---

test('the DM carries the three answers, so it can be read on a phone', async (t) => {
  const { db, cipher } = await world(t);
  ask(db, cipher, PLAYER, {
    reason: 'We still play every week.',
    whyDeleted: 'A row about scheduling.',
    takingOwnership: 'yes',
  });

  const text = buildRestoreRequestDm(pendingRestoreRequests({ db })[0]);
  assert.match(text, /Cipher/);
  assert.match(text, /We still play every week/);
  assert.match(text, /A row about scheduling/);
  assert.match(text, new RegExp(QUESTIONS.takingOwnership.slice(0, 20)));
  assert.match(text, /not the person who deleted it/);
});

test('a blank answer reads as blank rather than as nothing', async (t) => {
  const { db, cipher } = await world(t);
  ask(db, cipher, CREATOR, { whyDeleted: '', takingOwnership: '' });

  const text = buildRestoreRequestDm(pendingRestoreRequests({ db })[0]);
  assert.match(text, /left blank/);
});

// --- and the dashboard cannot go round it ---

// The whole gate is worthless if the web page restores directly. A player
// pressing the button there files the same ticket they would in Discord.
test('the dashboard files a ticket rather than restoring, for anybody but the operator', async (t) => {
  const { db, cipher } = await world(t);
  const viewer = { level: 'player', userId: PLAYER, username: 'saf', can: { manage: true } };

  const res = runAction({
    pathname: '/actions/campaign/restore',
    body: { campaignId: cipher, reason: 'we want it back', whyDeleted: 'a row', takingOwnership: 'no' },
    db, cfg, ctx: { viewer },
  });

  assert.equal(res.payload.ok, true);
  assert.equal(db.getCampaign(cipher), null, 'asked, not restored');
  assert.equal(pendingRestoreRequests({ db }).length, 1);
});

test('the operator restores directly, because they are who the ticket is for', async (t) => {
  const { db, cipher } = await world(t);
  const viewer = { level: 'dev', userId: DEV, can: { manage: true, everything: true } };

  const res = runAction({
    pathname: '/actions/campaign/restore', body: { campaignId: cipher }, db, cfg, ctx: { viewer },
  });

  assert.equal(res.payload.ok, true);
  assert.ok(db.getCampaign(cipher));
  assert.equal(db.listRestoreRequests().length, 0, 'no ticket was needed');
});

test('reviewing through the web checks the operator again', async (t) => {
  const { db, cipher } = await world(t);
  const { requestId } = ask(db, cipher, PLAYER);

  const sneak = runAction({
    pathname: '/actions/campaign/restore-review',
    body: { requestId, approve: true },
    db, cfg, ctx: { viewer: { level: 'creator', userId: CREATOR, can: { manage: true } } },
  });
  assert.equal(sneak.payload.ok, false);
  assert.equal(db.getCampaign(cipher), null);

  const real = runAction({
    pathname: '/actions/campaign/restore-review',
    body: { requestId, approve: true },
    db, cfg, ctx: { viewer: { level: 'dev', userId: DEV, can: { manage: true, everything: true } } },
  });
  assert.equal(real.payload.ok, true);
  assert.ok(db.getCampaign(cipher));
});
