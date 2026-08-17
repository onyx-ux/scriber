import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { standing, stopRecording, resumeRecording, describePlan, erase, ANONYMOUS } from '../src/campaign/withdrawal.js';

// Taking consent back.
//
// These tests are about blast radius and about honesty. Erasing is the one
// operation in the whole bot that destroys somebody's data on purpose, and the
// two ways it can be wrong are destroying more than was asked for, and telling
// the person it did something it did not do.

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

  assert.equal(db.decideConsent(campaignId, SAF, false) && db.mayRecord(campaignId, SAF), false,
    'sanity: the old path can decline an open invite');

  db.decideConsent(campaignId, SAF, true);
  const result = stopRecording(db, { campaignId, userId: SAF });

  assert.equal(result.ok, true);
  assert.equal(db.mayRecord(campaignId, SAF), false);
});

test('someone never invited at all can still switch recording off', async (t) => {
  const { db, campaignId } = await harness(t);
  assert.equal(db.getConsent(campaignId, SAF), null);

  assert.equal(stopRecording(db, { campaignId, userId: SAF }).ok, true);
  assert.equal(db.getConsent(campaignId, SAF).state, 'declined');
  assert.equal(db.mayRecord(campaignId, SAF), false);
});

test('stopping is reversible and resuming does not resurrect anything', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, LINES);

  stopRecording(db, { campaignId, userId: SAF });
  erase(db, { campaignId, userId: SAF });
  resumeRecording(db, { campaignId, userId: SAF });

  assert.equal(db.mayRecord(campaignId, SAF), true, 'they can be recorded again');
  assert.equal(standing(db, { campaignId, userId: SAF }).lines, 0, 'what was removed stays removed');
});

// Declining must not un-enrol them: being on the roster is not being recorded,
// and quietly removing them would also take away their /recap.
test('stopping leaves them on the roster', async (t) => {
  const { db, campaignId } = await harness(t);
  db.addCampaignMember(campaignId, SAF, 'dm-1');

  stopRecording(db, { campaignId, userId: SAF });
  assert.equal(db.isCampaignMember(campaignId, SAF), true);
});

// --- the plan, before anything happens ---

test('the plan is counted, not estimated', async (t) => {
  const { db, campaignId } = await harness(t);
  db.setCharacterName(campaignId, SAF, 'Sáfriel');
  played(db, campaignId, LINES, { tldr: 'Sáfriel paid a bribe nobody voted on.', scenes: [] });
  played(db, campaignId, [{ userId: OTHER, displayName: 'Brett', startMs: 0, endMs: 1, text: 'x' }],
    { tldr: 'A quiet night at the docks.', scenes: [] });

  const plan = describePlan(db, { campaignId, userId: SAF });
  assert.equal(plan.lines, 2);
  assert.equal(plan.sessions, 1);
  assert.equal(plan.notes, 1, 'only the recap that actually names them');
  assert.deepEqual(plan.names, ['Sáfriel', 'Saf']);
  assert.ok(plan.cannot.some((c) => /message ids/.test(c)), 'it says what it cannot reach');
});

// A two-letter name would match half the words in a recap; shredding the notes
// is worse than leaving a name in.
test('a name too short to redact safely is not redacted', async (t) => {
  const { db, campaignId } = await harness(t);
  played(db, campaignId, [{ userId: SAF, displayName: 'Jo', startMs: 0, endMs: 1, text: 'hi' }],
    { tldr: 'Jo joined the party.', scenes: [] });

  assert.deepEqual(describePlan(db, { campaignId, userId: SAF }).names, []);
});

// --- erasing ---

test('erasing removes their lines and nobody else’s', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = played(db, campaignId, LINES);

  const result = erase(db, { campaignId, userId: SAF });
  assert.equal(result.lines, 2);
  assert.equal(result.sessions, 1);

  const left = db.listUtterances(meetingId);
  assert.equal(left.length, 1);
  assert.equal(left[0].user_id, OTHER, 'what everyone else said is untouched');
});

// The single most important test here. Agreeing at one table and withdrawing at
// another are separate decisions, and crossing that line would destroy a record
// nobody asked to have destroyed.
test('erasing at one table does not touch the same person at another', async (t) => {
  const { db, campaignId } = await harness(t);
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  const mine = played(db, campaignId, LINES);
  const theirs = played(db, other, LINES, { tldr: 'Saf did a thing.', scenes: [] });

  erase(db, { campaignId, userId: SAF });

  assert.equal(db.listUtterances(mine).length, 1);
  assert.equal(db.listUtterances(theirs).length, 3, 'the other campaign is whole');
  assert.match(JSON.parse(db.getMeeting(theirs).summary_json).tldr, /Saf/, 'and its notes still name them');
});

test('the session itself survives — the evening happened', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = played(db, campaignId, LINES);

  erase(db, { campaignId, userId: SAF });

  const meeting = db.getMeeting(meetingId);
  assert.ok(meeting, 'the meeting row is still there');
  assert.equal(db.listRecentMeetings(campaignId, 10).length, 1, 'and it still counts as a session');
});

test('their names come out of the recaps, and the sentence still reads', async (t) => {
  const { db, campaignId } = await harness(t);
  db.setCharacterName(campaignId, SAF, 'Sáfriel');
  const meetingId = played(db, campaignId, LINES, {
    tldr: 'Sáfriel paid the fee out of party funds unasked.',
    scenes: [{ title: 'The queue', points: ['Saf argued with the clerk.'] }],
    npcsIntroduced: ['Wren Halloway: the clerk'],
  });

  const result = erase(db, { campaignId, userId: SAF });
  assert.equal(result.notes, 1);

  const notes = JSON.parse(db.getMeeting(meetingId).summary_json);
  assert.equal(notes.tldr, 'A player paid the fee out of party funds unasked.');
  assert.equal(notes.scenes[0].points[0], 'A player argued with the clerk.');
  assert.equal(notes.npcsIntroduced[0], 'Wren Halloway: the clerk', 'an NPC nobody withdrew is untouched');
  assert.match(notes.tldr, new RegExp(ANONYMOUS, 'i'), 'and it is the documented replacement');
});

// A recap that no longer parses is a recap nothing can read — notes-view.js
// renders it as "unreadable" and the Obsidian export skips it. Redaction must
// go through the parsed structure, never a regex over the serialised blob.
test('redaction leaves the stored recap valid JSON', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = played(db, campaignId, LINES, {
    tldr: 'Saf said "we are moving up the queue" and meant it.\nThen he left.',
    scenes: [],
  });

  erase(db, { campaignId, userId: SAF });
  const raw = db.getMeeting(meetingId).summary_json;
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.match(JSON.parse(raw).tldr, /^A player said "we are moving up the queue"/);
});

test('the character mapping goes too — it was the link they asked to remove', async (t) => {
  const { db, campaignId } = await harness(t);
  db.setCharacterName(campaignId, SAF, 'Sáfriel');
  played(db, campaignId, LINES);

  erase(db, { campaignId, userId: SAF });
  assert.equal(db.getCharacterName(campaignId, SAF), null);
});

test('erasing when there is nothing on file says so rather than claiming work', async (t) => {
  const { db, campaignId } = await harness(t);
  const result = erase(db, { campaignId, userId: SAF });

  assert.equal(result.ok, true);
  assert.equal(result.lines, 0);
  assert.match(result.message, /nothing of yours/);
});

test('an unreadable recap is left alone rather than reported as redacted', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = played(db, campaignId, LINES);
  db.raw.prepare(`UPDATE meetings SET summary_json = ? WHERE id = ?`).run('{not json', meetingId);

  const result = erase(db, { campaignId, userId: SAF });
  assert.equal(result.notes, 0, 'it cannot promise to have redacted what it cannot parse');
  assert.equal(db.getMeeting(meetingId).summary_json, '{not json');
  assert.equal(result.lines, 2, 'the lines still go');
});

// A recap full of "a player paid the fee." reads as broken, which quietly
// punishes the person who withdrew by making their absence look like damage.
test('the replacement is capitalised where a sentence starts', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = played(db, campaignId, LINES, {
    tldr: 'Saf paid the fee. Brett objected. Then Saf left, and Saf did not come back.',
    scenes: [{ title: 'x', points: ['Saf argued.', 'Nobody backed Saf up.'] }],
  });

  erase(db, { campaignId, userId: SAF });
  const notes = JSON.parse(db.getMeeting(meetingId).summary_json);

  assert.equal(notes.tldr, 'A player paid the fee. Brett objected. Then a player left, and a player did not come back.');
  assert.deepEqual(notes.scenes[0].points, ['A player argued.', 'Nobody backed a player up.']);
});
