import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { handOverCampaign, mayHandOver, handoverCandidates } from '../src/campaign/handover.js';
import { buildViewer } from '../src/web/viewer.js';
import { ACTION_NEEDS } from '../src/web/authority.js';
import { runAction } from '../src/web/actions.js';

// Handing a campaign to somebody else at the table.
//
// A campaign used to acquire a manager exactly once — whoever typed
// `/campaign create` got it, permanently — and there was no answer to "the
// person who set this up has stopped running the game" except an operator with
// SSH. HOW_TO_RAISE has meanwhile been telling people for months that the way
// to make somebody a creator is to "hand them one from that campaign's
// settings", describing a control that did not exist.
//
// The property that matters most here is the LAST one: nothing in this grants a
// level. It changes who runs a campaign, and buildViewer derives `creator` from
// that fact the next time it is asked, exactly as it does for everybody else.

const DEV = '10000000000000001';
const DM = '30000000000000003';
const PLAYER = '40000000000000004';
const OTHER = '50000000000000005';
const STRANGER = '60000000000000006';

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-handover-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

  const cfg = { ownerUserId: DEV, statusToken: 'sesame' };
  const campaignId = db.createCampaign('guild-1', 'Cipher', DM);

  // Two more people at the table: one the bot has actually heard, and one
  // merely enrolled. Both are on the roster, which is what handing over needs.
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meetingId, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1000, text: 'I open the door.' },
  ]);
  // The real route onto a roster rather than forTests: naming somebody's
  // character enrols them, which is exactly how a DM sets a table up before
  // anybody has spoken.
  db.setCharacterName(campaignId, OTHER, 'Aurion');

  return { db, cfg, campaignId };
}

const viewerFor = (db, cfg, userId) => buildViewer({ db, cfg, userId });

// --- the act itself ---

test('the operator hands the campaign to somebody at the table', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });

  assert.equal(res.ok, true);
  assert.equal(res.from, DM);
  assert.equal(res.to, PLAYER);
  assert.equal(db.getCampaign(campaignId).manager_user_id, PLAYER);
});

// The rule that separates this from every other control on the campaign screen.
// A manager may reshape their campaign's records all day; they may not decide
// who somebody is on this bot, which is what handing the table on amounts to.
test('the campaign’s own manager cannot hand it on', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = handOverCampaign({ db, cfg, campaignId, userId: DM, toUserId: PLAYER });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-yours');
  assert.equal(db.getCampaign(campaignId).manager_user_id, DM, 'and nothing moved');
});

// The refusal has to land well on somebody who genuinely runs the campaign:
// they will read a flat "not yours" as a bug, so it names which question this
// is and points at the half that is still theirs.
test('the refusal tells a manager what they do still control', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const res = handOverCampaign({ db, cfg, campaignId, userId: DM, toUserId: PLAYER });

  assert.match(res.message, /bot owner/i);
  assert.match(res.message, /roster/);
  assert.match(res.message, /corrections/);
});

// The whole point. Nothing here writes a level anywhere — the fact changes and
// the level follows, which is the rule web/viewer.js exists to protect.
test('the new manager resolves to creator on their own', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  assert.equal(viewerFor(db, cfg, PLAYER).level, 'player', 'they were at the table, no more');

  handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });

  const now = viewerFor(db, cfg, PLAYER);
  assert.equal(now.level, 'creator');
  assert.equal(now.derivedLevel, 'creator', 'derived, not granted');
  assert.equal(now.cap, null, 'and nothing was written into the access table');
  assert.deepEqual(now.manageableCampaignIds, [campaignId]);
});

// Handing it over is not throwing somebody out. Worth a test because "handed
// it over" reads to some people as "removed", and the message says otherwise.
test('the old manager stays on the roster', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });

  assert.match(res.message, /stays on the roster/);
  assert.ok(db.listRoster(campaignId).some((p) => p.userId === DM));
  assert.ok(!viewerFor(db, cfg, DM).manageableCampaignIds.includes(campaignId), 'but no longer runs it');
});

// The consequence of viewer.js's rule that a `player` claim is having SPOKEN at
// the table rather than being listed on it, met head-on here: a DM who hands the
// campaign on keeps reading it if they ever played, and does not if they never
// did. That is why the message says "stays on the roster" rather than "still
// sees it" — the roster is what a handover can promise.
test('a manager who played keeps reading the campaign; one who never did does not', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  // DM set the table up and never recorded a word in it.
  handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });
  assert.ok(!viewerFor(db, cfg, DM).campaignIds.includes(campaignId));

  // PLAYER did speak, so moving it on again leaves them able to read it.
  handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: OTHER });
  const after = viewerFor(db, cfg, PLAYER);
  assert.ok(after.campaignIds.includes(campaignId), 'they spoke at that table, which is a fact handing it on cannot undo');
  assert.equal(after.level, 'player');
});

// setCampaignManager also enrols, which matters for somebody the bot has only
// ever HEARD: they are on the roster without a campaign_members row, and the
// person running a campaign should have one.
test('taking it on puts them on the roster properly', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });

  assert.equal(db.isCampaignMember(campaignId, PLAYER), true);
});

// --- what it refuses ---

test('a campaign cannot be handed to somebody who is not at the table', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: STRANGER });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-at-the-table');
  assert.match(res.message, /Invite them/);
  assert.equal(db.getCampaign(campaignId).manager_user_id, DM, 'and nothing moved');
});

// The roster check is what makes a mistyped id harmless. A snowflake regex
// would accept eighteen plausible digits belonging to nobody, and the campaign
// would end up run by an account that cannot sign in to give it back.
test('a well-formed id that belongs to nobody is still refused', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: '123456789012345678' });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-at-the-table');
});

test('a player at the table cannot hand a campaign anywhere', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = handOverCampaign({ db, cfg, campaignId, userId: PLAYER, toUserId: OTHER });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-yours');
});

test('handing it to whoever already runs it is refused rather than reported as work', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: DM });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-change');
});

test('a deleted campaign has to come back before it can be handed on', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  db.archiveCampaign(campaignId, DM);

  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing');
});

// --- the operator, and the unclaimed case ---

test('the operator can settle who runs a campaign that is not theirs', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });

  assert.equal(res.ok, true);
  assert.equal(db.getCampaign(campaignId).manager_user_id, PLAYER);
  assert.match(res.message, new RegExp(DM), 'the person it came from is named');
});

// An unclaimed campaign gets no looser rule. It is the same act with nobody on
// the other side of it, and a table cannot vote itself a DM. In practice it
// barely arises: index.js adopts every unmanaged campaign to the owner on boot.
test('a campaign nobody runs is still the operator’s to settle', async (t) => {
  const { db, cfg } = await world(t);
  const orphan = db.createCampaign('guild-1', 'Unclaimed', null);
  db.setCharacterName(orphan, PLAYER, 'Vex');

  assert.equal(mayHandOver({ db, cfg, userId: PLAYER }), false);
  assert.equal(mayHandOver({ db, cfg, userId: STRANGER }), false);
  assert.equal(mayHandOver({ db, cfg, userId: DEV }), true);

  assert.equal(handOverCampaign({ db, cfg, campaignId: orphan, userId: PLAYER, toUserId: PLAYER }).ok, false);

  const res = handOverCampaign({ db, cfg, campaignId: orphan, userId: DEV, toUserId: PLAYER });
  assert.equal(res.ok, true);
  assert.equal(res.from, null);
  assert.equal(db.getCampaign(orphan).manager_user_id, PLAYER);
});

// The operator settling an unclaimed table onto their own name reads
// differently from moving one between players, and the message follows.
test('taking one on yourself says so', async (t) => {
  const { db, cfg } = await world(t);
  const orphan = db.createCampaign('guild-1', 'Unclaimed', null);
  db.setCharacterName(orphan, DEV, 'Vex');

  const res = handOverCampaign({ db, cfg, campaignId: orphan, userId: DEV, toUserId: DEV });
  assert.equal(res.ok, true);
  assert.match(res.message, /You have taken on/);
});

// --- what it says ---

// `dm` means "to whoever runs this", so a handover quietly redirects every
// future recap into a different person's inbox. Discovered later, that is a
// week of notes somebody never got.
test('a DM destination is called out, because it follows the manager', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  db.setCampaignOutput(campaignId, 'dm', null);

  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });
  assert.match(res.message, /write-ups/i);
  assert.match(res.message, /now go to them/);
});

test('a channel destination says nothing about it, because nothing moved', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const res = handOverCampaign({ db, cfg, campaignId, userId: DEV, toUserId: PLAYER });
  assert.doesNotMatch(res.message, /write-ups/i);
});

// --- the picker's own list ---

test('the picker offers the table without the person who already runs it', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const heirs = handoverCandidates({ db, campaign: db.getCampaign(campaignId) });

  assert.deepEqual(heirs.map((p) => p.userId).sort(), [PLAYER, OTHER].sort());
  assert.ok(!heirs.some((p) => p.userId === DM), 'an option that changes nothing is not an option');
  assert.equal(heirs.find((p) => p.userId === PLAYER).spoken, true);
  assert.equal(heirs.find((p) => p.userId === OTHER).spoken, false, 'enrolled but never heard');
});

// --- the way in from the dashboard ---

// Tighter than campaign/delete, which a manager passes. Throwing a campaign
// away disposes of something already yours; handing one on makes somebody else
// into a creator, and assigning who somebody is belongs with the Level and Tier
// columns rather than inside one campaign's own settings.
test('deciding who runs a campaign is the operator’s alone', async () => {
  assert.equal(ACTION_NEEDS['campaign/manager'], 'everything');
});

test('the action refuses a request with nobody behind it', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = runAction({
    pathname: '/actions/campaign/manager',
    body: { campaignId, userId: PLAYER },
    db, cfg, ctx: {},
  });

  assert.equal(res.status, 403);
  assert.equal(db.getCampaign(campaignId).manager_user_id, DM);
});

test('the action hands it over for somebody it recognises', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  const res = runAction({
    pathname: '/actions/campaign/manager',
    body: { campaignId, userId: PLAYER },
    db, cfg, ctx: { viewer: viewerFor(db, cfg, DEV) },
  });

  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(db.getCampaign(campaignId).manager_user_id, PLAYER);
});

test('the action refuses free text where a Discord id belongs', async (t) => {
  const { db, cfg, campaignId } = await world(t);

  for (const who of ['saf', '', 'user#1234', '12']) {
    const res = runAction({
      pathname: '/actions/campaign/manager',
      body: { campaignId, userId: who },
      db, cfg, ctx: { viewer: viewerFor(db, cfg, DEV) },
    });
    assert.equal(res.status, 400, `${JSON.stringify(who)} should be refused`);
  }
});
