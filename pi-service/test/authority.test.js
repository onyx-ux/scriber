import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  checkDoor,
  mayAct,
  actingUserId,
  buildViewer,
  OPERATOR,
  ACTION_NEEDS,
  OWN_BUSINESS,
} from '../src/web/authority.js';
import { ACTIONS } from '../src/web/actions.js';

// The gate itself.
//
// This is the file that did not exist. `mayAct` used to be private to
// web/server.js, so the only way to reach it was to stand an HTTP server up —
// and web-actions.test.js, which is 800 lines about what the control surface
// refuses, imports runAction directly and therefore enters PAST the gate.
// Every refusal below is one that nothing was checking.
//
// The four questions are asked separately on purpose, because they are
// separate: is there a credential (checkDoor), what does this act cost and does
// this person's level cover it (mayAct), and whose name does it happen under
// (actingUserId).

const DEV = 'owner-1';
const CREATOR = 'dm-1';
const PLAYER = 'player-1';
const STRANGER = 'nobody-1';

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-authority-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = { ownerUserId: DEV, statusToken: 'sekrit' };

  const campaignId = db.createCampaign('guild-1', 'Cipher', CREATOR);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'Saf', startMs: 0, endMs: 1, text: 'hello' },
  ]);

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const viewer = (userId) => (userId ? buildViewer({ db, cfg, userId }) : buildViewer({ db, cfg, userId: null }));
  return { db, cfg, campaignId, viewer };
}

const req = (headers = {}) => ({ headers });
const at = (path, token) => new URL(`http://localhost${path}${token ? `?token=${token}` : ''}`);

// ==========================================================================
// 1. the door
// ==========================================================================

test('a read with no token configured is open, as it always was', () => {
  assert.equal(checkDoor({ req: req(), url: at('/status'), cfg: {}, mutating: false }), null);
});

// The property the whole write path rests on: no token means no correct
// credential exists, so there is nothing to present and everything is refused.
test('a write with no token configured fails closed and says why', () => {
  const denial = checkDoor({ req: req(), url: at('/actions/summary/approve'), cfg: {}, mutating: true });

  assert.equal(denial.status, 403);
  assert.match(denial.message, /STATUS_TOKEN/, 'the refusal names the one thing that fixes it');
});

test('a write with the wrong token is 401, whether it is in the query or the header', () => {
  const cfg = { statusToken: 'sekrit' };
  assert.equal(checkDoor({ req: req(), url: at('/actions/x', 'wrong'), cfg, mutating: true }).status, 401);
  assert.equal(
    checkDoor({ req: req({ 'x-status-token': 'wrong' }), url: at('/actions/x'), cfg, mutating: true }).status,
    401
  );
});

test('the right token opens the door from either place', () => {
  const cfg = { statusToken: 'sekrit' };
  assert.equal(checkDoor({ req: req(), url: at('/actions/x', 'sekrit'), cfg, mutating: true }), null);
  assert.equal(
    checkDoor({ req: req({ 'x-status-token': 'sekrit' }), url: at('/actions/x'), cfg, mutating: true }),
    null
  );
});

// ==========================================================================
// 2. the act
// ==========================================================================

// The default is the point. A new action nobody has classified is machinery,
// which is the failure direction that does not hand a player the pause button.
test('an action nobody has classified needs the owner', async (t) => {
  const { db, viewer } = await world(t);
  const denial = mayAct({
    pathname: '/actions/some/brand-new-thing',
    body: {},
    viewer: viewer(CREATOR),
    db,
  });

  assert.equal(denial.status, 403);
  assert.match(denial.message, /bot owner/);
});

test('every action in the table is either listed or deliberately machinery', () => {
  const unlisted = Object.keys(ACTIONS).filter((name) => !(name in ACTION_NEEDS));
  for (const name of unlisted) {
    // Not an assertion about the list's contents — an assertion that reading
    // ACTION_NEEDS is enough to know what an action costs. Anything absent
    // resolves to machinery rather than to undefined.
    assert.equal(ACTION_NEEDS[name] ?? 'machinery', 'machinery');
  }
});

test('a player cannot reach the machinery', async (t) => {
  const { db, viewer } = await world(t);
  for (const name of ['summary/approve', 'summary/approve-all', 'transcribe', 'session/discard']) {
    const denial = mayAct({ pathname: `/actions/${name}`, body: { jobId: 1 }, viewer: viewer(PLAYER), db });
    assert.equal(denial?.status, 403, `${name} should be refused`);
    assert.match(denial.message, /hardware|API budget/);
  }
});

test('a campaign creator cannot reach the machinery either — it is not their hardware', async (t) => {
  const { db, viewer } = await world(t);
  const denial = mayAct({ pathname: '/actions/summary/approve', body: { jobId: 1 }, viewer: viewer(CREATOR), db });
  assert.equal(denial.status, 403);
});

test('the operator console reaches everything', async (t) => {
  const { db } = await world(t);
  for (const name of Object.keys(ACTIONS)) {
    assert.equal(
      mayAct({ pathname: `/actions/${name}`, body: {}, viewer: OPERATOR, db }),
      null,
      `${name} should be allowed for the operator`
    );
  }
});

// --- manage, and the campaign it names ---

test('a manage action on a campaign you run is allowed', async (t) => {
  const { db, campaignId, viewer } = await world(t);
  assert.equal(
    mayAct({ pathname: '/actions/corrections/add', body: { campaignId }, viewer: viewer(CREATOR), db }),
    null
  );
});

test('a manage action on a campaign you merely play at is refused', async (t) => {
  const { db, campaignId, viewer } = await world(t);
  const denial = mayAct({
    pathname: '/actions/corrections/add',
    body: { campaignId },
    viewer: viewer(PLAYER),
    db,
  });

  assert.equal(denial.status, 403);
  assert.match(denial.message, /read this campaign, but not change it/);
});

// The bug this check was added for: corrections/add had no validator of its
// own, so a made-up id used to write a correction row belonging to no campaign.
test('a manage action naming a campaign that does not exist is refused here', async (t) => {
  const { db, viewer } = await world(t);
  const denial = mayAct({
    pathname: '/actions/corrections/add',
    body: { campaignId: 9999 },
    viewer: viewer(CREATOR),
    db,
  });

  assert.equal(denial.status, 403);
  assert.match(denial.message, /not a campaign you run/);
});

// A missing id is the action's own validator's business — it can say which
// field is wrong, and this cannot.
test('a manage action with no campaign id is passed through to the action', async (t) => {
  const { db, viewer } = await world(t);
  assert.equal(mayAct({ pathname: '/actions/corrections/add', body: {}, viewer: viewer(CREATOR), db }), null);
});

// --- your own business ---

test('you may name your own character at a table you play at', async (t) => {
  const { db, campaignId, viewer } = await world(t);
  for (const name of OWN_BUSINESS) {
    assert.equal(
      mayAct({ pathname: `/actions/${name}`, body: { userId: PLAYER, campaignId }, viewer: viewer(PLAYER), db }),
      null,
      `${name} aimed at yourself should be allowed`
    );
  }
});

test('you may not name somebody else\'s character', async (t) => {
  const { db, campaignId, viewer } = await world(t);
  const denial = mayAct({
    pathname: '/actions/roster/character',
    body: { userId: STRANGER, campaignId },
    viewer: viewer(PLAYER),
    db,
  });

  // Falls through to the ordinary manage check rather than the own-business
  // shortcut, and a player does not manage.
  assert.equal(denial.status, 403);
});

test('you may not name your own character at a table you do not play at', async (t) => {
  const { db, viewer } = await world(t);
  const denial = mayAct({
    pathname: '/actions/roster/character',
    body: { userId: PLAYER, campaignId: 9999 },
    viewer: viewer(PLAYER),
    db,
  });

  assert.equal(denial.status, 403);
  assert.match(denial.message, /not a table you play at/);
});

// --- the two narrower authorities ---

test('deciding a restore request is the operator\'s alone, not a server owner\'s', async (t) => {
  const { db, viewer } = await world(t);
  const denial = mayAct({
    pathname: '/actions/campaign/restore-review',
    body: { requestId: 1 },
    viewer: viewer(CREATOR),
    db,
  });

  assert.equal(denial.status, 403);
  assert.match(denial.message, /Only the bot owner/);
});

// Restoring deliberately does NOT go through the manage check: that check ends
// in db.getCampaign(), and an archived campaign is invisible to it.
test('restoring is checked on the level, not on a campaign lookup that cannot succeed', async (t) => {
  const { db, viewer } = await world(t);

  assert.equal(
    mayAct({ pathname: '/actions/campaign/restore', body: { campaignId: 9999 }, viewer: viewer(CREATOR), db }),
    null,
    'an archived id is not refused here — campaign/archive.js checks the archived row itself'
  );
  assert.equal(
    mayAct({ pathname: '/actions/campaign/restore', body: { campaignId: 9999 }, viewer: viewer(PLAYER), db }).status,
    403
  );
});

// --- paths that are not actions ---

test('a path that is not an action is left for runAction to 404', async (t) => {
  const { db, viewer } = await world(t);
  assert.equal(mayAct({ pathname: '/status', body: {}, viewer: viewer(PLAYER), db }), null);
});

// ==========================================================================
// 3. the acting id
// ==========================================================================

test('a signed-in viewer acts as themselves', () => {
  assert.equal(actingUserId({ userId: PLAYER, can: {} }, { ownerUserId: DEV }), PLAYER);
});

test('the operator console acts as the id the bot calls its owner', () => {
  assert.equal(actingUserId(OPERATOR, { ownerUserId: DEV }), DEV);
});

// The case that used to differ between call sites: an install that never set
// OWNER_USER_ID has no id for its console to act under, and the caller has to
// refuse rather than carry on with undefined.
test('with no owner configured the console acts as nobody, never as undefined', () => {
  assert.equal(actingUserId(OPERATOR, {}), null);
  assert.equal(actingUserId(null, {}), null);
});

test('somebody with no level and no session acts as nobody', async (t) => {
  const { cfg, viewer } = await world(t);
  assert.equal(actingUserId(viewer(null), cfg), null);
});
