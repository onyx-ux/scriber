import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildTranscriptView } from '../src/web/transcript-view.js';

// The transcript, as something you read rather than something you save.
//
// The plain-text download already existed and is unchanged — these are the
// extra questions the reader asks that the text file cannot answer: who said
// this, what do we call them, and who talked most.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-transcript-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  return { db, campaignId };
}

function recorded(db, campaignId, rows) {
  const meetingId = db.createMeeting({
    guildId: 'guild-1',
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: '2026-08-01T19:00:00Z',
    audioDir: '/tmp',
  });
  db.finalizeTranscription(meetingId, rows);
  db.endMeeting(meetingId, '2026-08-01T22:00:00Z');
  return meetingId;
}

const LINES = [
  { userId: 'dm-1', displayName: 'Kez', startMs: 12_000, endMs: 14_000, text: 'The queue has not moved.' },
  { userId: '111', displayName: 'Matt', startMs: 29_000, endMs: 31_000, text: 'Does it need a seal?' },
  { userId: '111', displayName: 'Matt', startMs: 41_000, endMs: 43_000, text: 'I have paid the fee.' },
  { userId: 'dm-1', displayName: 'Kez', startMs: 58_000, endMs: 60_000, text: 'He believes you.' },
];

test('an unknown session is nothing, not an empty transcript', async (t) => {
  const { db } = await harness(t);
  assert.equal(buildTranscriptView({ db, meetingId: 9999 }), null);
});

test('every line comes back with its clock, its speaker and its words', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, LINES);

  const view = buildTranscriptView({ db, meetingId });
  assert.equal(view.total, 4);
  assert.equal(view.ref, 'Cipher_01');
  assert.deepEqual(view.lines[0], {
    ms: 12_000,
    userId: 'dm-1',
    speaker: 'Kez',
    text: 'The queue has not moved.',
  });
});

// The name a clip is captured under is the Discord display name, which is the
// one name nobody at the table uses. Where a character is set, that wins.
test('a player who has a character is read as the character', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, LINES);
  db.setCharacterName(campaignId, '111', 'Sáfriel');

  const view = buildTranscriptView({ db, meetingId });
  assert.equal(view.lines[1].speaker, 'Sáfriel');
  assert.equal(view.speakers.find((s) => s.userId === '111').name, 'Sáfriel');
  assert.equal(view.lines[0].speaker, 'Kez', 'and one without a character keeps the display name');
});

test('who spoke is counted in lines and adds up', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, LINES);

  const view = buildTranscriptView({ db, meetingId });
  assert.equal(view.speakers.length, 2);
  assert.deepEqual(view.speakers.map((s) => s.lines), [2, 2], 'busiest first');
  assert.equal(view.speakers.reduce((sum, s) => sum + s.share, 0), 100);
});

// Whose account owns the campaign, marked as a fact. Not "the DM" — on a real
// table the manager and the person narrating are often different accounts, so
// the mark says who claimed the campaign and concludes nothing else.
test("the campaign's manager is marked among the speakers", async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, LINES);

  const view = buildTranscriptView({ db, meetingId });
  assert.equal(view.speakers.find((s) => s.userId === 'dm-1').manager, true);
  assert.equal(view.speakers.find((s) => s.userId === '111').manager, false);
});

// What is on disk is already corrected — the rules ran as the transcript was
// written. Carrying them is about saying which ones were in force, so nobody
// reads a rewritten name as a mishearing.
test('the corrections in force are carried, not applied again', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, LINES);
  db.addCorrection(campaignId, 'Kaylen', 'Kaelen');

  const view = buildTranscriptView({ db, meetingId });
  assert.deepEqual(view.corrections, [{ wrong: 'Kaylen', right: 'Kaelen' }]);
  assert.equal(view.lines[0].text, 'The queue has not moved.', 'nothing was rewritten on the way out');
});

test('a session with no transcript yet reads as empty rather than failing', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = db.createMeeting({
    guildId: 'guild-1',
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: '2026-08-01T19:00:00Z',
    audioDir: '/tmp',
  });

  const view = buildTranscriptView({ db, meetingId });
  assert.equal(view.total, 0);
  assert.deepEqual(view.lines, []);
  assert.deepEqual(view.speakers, []);
  assert.equal(view.hasNotes, false);
});
