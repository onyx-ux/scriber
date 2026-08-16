import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildCampaignView } from '../src/web/campaign-view.js';

// The detail behind one campaign, which is what replaced /dm roster,
// /corrections and /history.
//
// Unlike the status snapshot, this one DOES carry Discord user ids — a roster
// is a list of accounts and managing one without them is impossible. That is
// the reason it is a separate endpoint rather than part of the poll, so the
// test pins the split rather than leaving it to whoever edits next.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-campview-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  return { db, dir, campaignId };
}

const played = (db, campaignId, rows, { number = null } = {}) => {
  const id = db.createMeeting({
    guildId: 'guild-1',
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: '2026-08-01T19:00:00Z',
    audioDir: '/tmp',
  });
  db.finalizeTranscription(id, rows);
  db.endMeeting(id, '2026-08-01T22:00:00Z');
  return id;
};

test('an unknown campaign is nothing, not an empty shell', async (t) => {
  const { db } = await harness(t);
  assert.equal(buildCampaignView({ db, campaignId: 9999 }), null);
});

test('the roster carries who they are, what they play, and whether they agreed', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, [{ userId: '111', displayName: 'Matt', startMs: 0, endMs: 1, text: 'hello' }]);
  db.setCharacterName(campaignId, '111', 'Vex');

  const [person] = buildCampaignView({ db, campaignId }).roster;
  assert.equal(person.userId, '111');
  assert.equal(person.characterName, 'Vex');
  assert.equal(person.lines, 1);
  assert.equal(person.enrolled, true);
});

// Four database states, one outcome: not recorded. Showing four different
// words for it invites the reader to think one of them is permissive.
test('every not-granted consent state reads as not recordable', async (t) => {
  const { db, campaignId } = await harness(t);
  db.addCampaignMember(campaignId, '111', 'dm-1');
  db.addCampaignMember(campaignId, '222', 'dm-1');
  db.raw.prepare('DELETE FROM campaign_consent').run();

  db.inviteToCampaign(campaignId, '222', 'dm-1', new Date(Date.now() + 3_600_000).toISOString());

  const roster = buildCampaignView({ db, campaignId }).roster;
  const by = (id) => roster.find((r) => r.userId === id).consent;

  assert.equal(by('111').state, 'unasked');
  assert.equal(by('111').mayRecord, false);
  assert.equal(by('222').state, 'pending');
  assert.equal(by('222').mayRecord, false, 'silence is not agreement');

  db.decideConsent(campaignId, '222', true);
  assert.equal(buildCampaignView({ db, campaignId }).roster.find((r) => r.userId === '222').consent.mayRecord, true);
});

test('sessions are listed by the reference people actually type', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, [{ userId: '111', displayName: 'Matt', startMs: 0, endMs: 1, text: 'hi' }]);

  const [session] = buildCampaignView({ db, campaignId }).sessions;
  assert.equal(session.ref, 'Cipher_01', 'not a bare meeting id — that is an implementation detail');
  assert.equal(session.lines, 1);
  assert.equal(session.status, 'awaiting_summary');
});

test('corrections come back as the pair they are', async (t) => {
  const { db, campaignId } = await harness(t);
  db.addCorrection(campaignId, 'Vecks', 'Vex');

  assert.deepEqual(buildCampaignView({ db, campaignId }).corrections, [{ wrong: 'Vecks', right: 'Vex' }]);
});

// The status snapshot deliberately has no user ids because it can be
// published. This one has them by necessity — so it must never be folded back
// into that payload by someone tidying up.
test('this view is separate from the status snapshot for a reason', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, [{ userId: 'a-real-snowflake', displayName: 'Matt', startMs: 0, endMs: 1, text: 'x' }]);

  const json = JSON.stringify(buildCampaignView({ db, campaignId }));
  assert.ok(json.includes('a-real-snowflake'), 'a roster without ids cannot be managed');
});

test('one campaign never reports another table', async (t) => {
  const { db, campaignId } = await harness(t);
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  played(db, other, [{ userId: '999', displayName: 'Elsewhere', startMs: 0, endMs: 1, text: 'not mine' }]);
  db.addCorrection(other, 'Strad', 'Strahd');

  const view = buildCampaignView({ db, campaignId });
  // Cipher's own roster is not empty — creating a campaign claims it, which
  // enrols the person who did. What must not be here is the other table.
  assert.deepEqual(view.roster.map((r) => r.userId), ['dm-1']);
  assert.deepEqual(view.corrections, []);
  assert.deepEqual(view.sessions, []);
});
