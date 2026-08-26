import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { standing, stopRecording, resumeRecording } from '../src/campaign/withdrawal.js';

// Taking consent back.
//
// Consent here is forward-looking, and only forward-looking: withdrawing stops
// the microphone, and every session already recorded stays exactly as it is.
// Half of these tests are about the switch working; the other half are about
// that boundary holding, because a transcript is four or five people's record
// of a shared evening and one of them must not be able to reach back through
// it afterwards.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-withdraw-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  return { db, campaignId };
}

const SAF = '10000000000000001';
const OTHER = '10000000000000002';

function played(db, campaignId, rows, summary = null) {
  const id = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(id, rows);
  db.endMeeting(id, '2026-08-01T22:00:00Z');
  if (summary) db.setSummary(id, summary);
  return id;
}

const LINES = [
  { userId: SAF, displayName: 'Saf', startMs: 0, endMs: 1, text: 'I have paid the fee.' },
  { userId: OTHER, displayName: 'Brett', startMs: 2, endMs: 3, text: 'Nobody voted on that.' },
  { userId: SAF, displayName: 'Saf', startMs: 4, endMs: 5, text: 'We are moving up the queue.' },
];

// --- where you stand ---

test('someone never asked is told so, rather than shown a blank', async (t) => {
  const { db, campaignId } = await harness(t);
  const now = standing(db, { campaignId, userId: SAF });

  assert.equal(now.state, 'unasked');
  assert.equal(now.mayRecord, false);
  assert.equal(now.hasRecord, false);
});

test('standing counts the lines and sessions actually on file', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, LINES);
  played(db, campaignId, [{ userId: SAF, displayName: 'Saf', startMs: 0, endMs: 1, text: 'again' }]);
  db.setCharacterName(campaignId, SAF, 'Sáfriel');

  const now = standing(db, { campaignId, userId: SAF });
  assert.equal(now.lines, 3);
  assert.equal(now.sessions, 2);
  assert.equal(now.displayName, 'Saf');
  assert.equal(now.characterName, 'Sáfriel');
  assert.equal(now.hasRecord, true);
});

// --- stopping ---

// The gap this whole file exists to close: decideConsent only answers an OPEN
// invitation, so a person who had already accepted could not take it back.
test('someone who already accepted can stop, with no invitation open', async (t) => {
  const { db, campaignId } = await harness(t);
  db.inviteToCampaign(campaignId, SAF, 'dm-1', '2099-01-01T00:00:00Z');
  db.decideConsent(campaignId, SAF, true);
  assert.equal(db.mayRecord(campaignId, SAF), true);

  const result = stopRecording(db, { campaignId, userId: SAF });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyStopped, false);
  assert.equal(db.mayRecord(campaignId, SAF), false);
});

test('someone never invited at all can still switch recording off', async (t) => {
  const { db, campaignId } = await harness(t);
  assert.equal(db.getConsent(campaignId, SAF), null);

  assert.equal(stopRecording(db, { campaignId, userId: SAF }).ok, true);
  assert.equal(db.getConsent(campaignId, SAF).state, 'declined');
  assert.equal(db.mayRecord(campaignId, SAF), false);
});

// Pressing it twice must be idempotent AND say so, because the second press is
// what decides whether the DM gets a second notification.
test('stopping twice is harmless and reports that nothing changed', async (t) => {
  const { db, campaignId } = await harness(t);
  stopRecording(db, { campaignId, userId: SAF });

  const again = stopRecording(db, { campaignId, userId: SAF });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyStopped, true);
  assert.equal(db.mayRecord(campaignId, SAF), false);
});

test('stopping is reversible, and resuming is forward-looking too', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, LINES);

  stopRecording(db, { campaignId, userId: SAF });
  assert.equal(db.mayRecord(campaignId, SAF), false);

  resumeRecording(db, { campaignId, userId: SAF });
  assert.equal(db.mayRecord(campaignId, SAF), true);
  assert.equal(standing(db, { campaignId, userId: SAF }).lines, 2, 'and the record was never touched by either');
});

// Declining must not un-enrol them: being on the roster is not being recorded,
// and quietly removing them would also take away their /recap.
test('stopping leaves them on the roster', async (t) => {
  const { db, campaignId } = await harness(t);
  db.forTests.addCampaignMember(campaignId, SAF, 'dm-1');

  stopRecording(db, { campaignId, userId: SAF });
  assert.equal(db.isCampaignMember(campaignId, SAF), true);
});

test('one person stopping does not affect anybody else', async (t) => {
  const { db, campaignId } = await harness(t);
  db.setConsent(campaignId, OTHER, true);

  stopRecording(db, { campaignId, userId: SAF });

  assert.equal(db.mayRecord(campaignId, SAF), false);
  assert.equal(db.mayRecord(campaignId, OTHER), true);
});

// Consent is per campaign. Stopping at one table says nothing about another.
test('stopping at one table leaves the same person recordable at another', async (t) => {
  const { db, campaignId } = await harness(t);
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  db.setConsent(campaignId, SAF, true);
  db.setConsent(other, SAF, true);

  stopRecording(db, { campaignId, userId: SAF });

  assert.equal(db.mayRecord(campaignId, SAF), false);
  assert.equal(db.mayRecord(other, SAF), true, 'a different table is a different decision');
});

// --- what withdrawal must never do ---
//
// The guarantee, pinned. Everything below would have to be deliberately
// undone for a withdrawal to start destroying the table's record.

test('stopping leaves every transcript exactly as it was', async (t) => {
  const { db, campaignId } = await harness(t);
  const first = played(db, campaignId, LINES);
  const second = played(db, campaignId, LINES);
  const before = [first, second].map((id) => db.listUtterances(id).map((u) => `${u.user_id}:${u.text}`));

  stopRecording(db, { campaignId, userId: SAF });

  const after = [first, second].map((id) => db.listUtterances(id).map((u) => `${u.user_id}:${u.text}`));
  assert.deepEqual(after, before, 'the sessions they consented to are untouched');
  assert.equal(standing(db, { campaignId, userId: SAF }).lines, 4, 'two lines in each of two sessions');
});

test('stopping leaves the notes naming them exactly as they were', async (t) => {
  const { db, campaignId } = await harness(t);
  const summary = {
    tldr: 'Sáfriel paid the queue-jumping fee out of party funds unasked.',
    scenes: [{ title: 'The queue', points: ['Saf argued with the clerk.'] }],
  };
  const meetingId = played(db, campaignId, LINES, summary);
  db.setCharacterName(campaignId, SAF, 'Sáfriel');
  const before = db.getMeeting(meetingId).summary_json;

  stopRecording(db, { campaignId, userId: SAF });

  assert.equal(db.getMeeting(meetingId).summary_json, before, 'the recap is a record of what happened');
});

test('stopping keeps their character name, so old transcripts still read right', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, LINES);
  db.setCharacterName(campaignId, SAF, 'Sáfriel');

  stopRecording(db, { campaignId, userId: SAF });

  assert.equal(db.getCharacterName(campaignId, SAF), 'Sáfriel',
    'dropping it would relabel every line they already agreed to');
});

// The bluntest possible statement of the boundary: there is no method on the
// database that deletes one speaker's lines, so no future caller can reach for
// one by accident.
test('the database exposes no way to delete a speaker', async (t) => {
  const { db } = await harness(t);

  for (const name of ['eraseSpeaker', 'redactSummaries', 'deleteUtterancesBy', 'forgetSpeaker']) {
    assert.equal(typeof db[name], 'undefined', `db.${name} must not exist`);
  }
});

// --- what the DM is told when the bot joins ---

import { describeUnrecorded } from '../src/campaign/consent.js';

test('the join message tells the DM to invite only the people who were never asked', () => {
  const said = describeUnrecorded({ unasked: ['Priya'], declined: ['Saf'] });

  assert.match(said, /Priya.*\/campaign invite/s, 'the unasked one gets an invite');
  assert.match(said, /their own choice: \*\*Saf\*\*/, 'the one who chose is described as having chosen');
  assert.doesNotMatch(said.split('Recording off')[1], /campaign invite/,
    'and the DM is never pointed at a button to re-ask them');
});

test('nobody unrecorded means nothing is said at all', () => {
  assert.equal(describeUnrecorded({ unasked: [], declined: [] }), '');
  assert.equal(describeUnrecorded([]), '');
});

// The signature grew; a caller that has not been updated must not silently
// produce an empty line where a warning belongs.
test('the old array form still names people', () => {
  assert.match(describeUnrecorded(['Priya']), /Priya.*campaign invite/s);
});

// Informed consent means being told what agreeing commits you to, at the moment
// of agreeing. "You can change your mind" is true and is not the whole truth:
// the switch is forward-only, and that is the part somebody would most
// reasonably feel misled about a year later.
test('the invite says withdrawal is forward-looking before anyone agrees', async () => {
  const { buildInviteMessage } = await import('../src/campaign/consent.js');
  const { content } = buildInviteMessage({
    campaignName: 'Cipher', inviterName: 'Kez', retentionDays: 14, expiresAt: new Date(),
  });

  assert.match(content, /campaign consent/, 'it names the command that turns it off');
  assert.match(content, /stops future recording/i, 'and says what that does');
  assert.match(content, /stay as they are/i, 'and what it does not');
});
