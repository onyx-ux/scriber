import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-db-'));
  const db = openDb(join(dir, 'db.sqlite'));
  // Close the native handle before removing the directory — on Windows,
  // deleting a WAL file that better-sqlite3 still has open fails with EBUSY
  // (Linux allows unlinking open files; Windows doesn't).
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

function seedMeeting(db) {
  return db.createMeeting({
    guildId: 'G1',
    channelId: 'C1',
    channelName: 'Cipher',
    startedAt: '2026-07-31T10:00:00Z',
    audioDir: '/tmp/audio',
  });
}

const ROWS = [{ userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1000, text: 'hello Marrowgate' }];

test('finalizeTranscription enqueues a due job by default', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  const job = db.finalizeTranscription(id, ROWS);

  assert.equal(job.status, 'pending');
  assert.equal(db.getMeeting(id).status, 'awaiting_summary');
  assert.equal(db.nextDueJob()?.id, job.id);
});

test('with approval required the job is parked and the worker ignores it', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  const job = db.finalizeTranscription(id, ROWS, { requireApproval: true });

  assert.equal(job.status, 'awaiting_approval');
  assert.equal(db.nextDueJob(), undefined, 'a parked job must never be picked up');
  assert.equal(
    db.listMeetingsAwaitingSummaryWithoutJob().length,
    0,
    'a parked job must not look orphaned, or startup would re-queue it and defeat the gate'
  );
});

test('approveJob releases a parked job exactly once', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  const job = db.finalizeTranscription(id, ROWS, { requireApproval: true });

  assert.equal(db.approveJob(job.id), true);
  assert.equal(db.nextDueJob()?.id, job.id);
  assert.equal(db.approveJob(job.id), false, 'a second click must be a no-op');
});

test('approveAllWaiting releases every parked job', async (t) => {
  const db = await freshDb(t);
  const a = seedMeeting(db);
  const b = seedMeeting(db);
  db.finalizeTranscription(a, ROWS, { requireApproval: true });
  db.finalizeTranscription(b, ROWS, { requireApproval: true });

  assert.equal(db.approveAllWaiting(), 2);
  assert.equal(db.approveAllWaiting(), 0);
});

// The crash this guards: transcription used to be three separate statements,
// so dying in the middle either duplicated every utterance on recovery or
// stranded the meeting with no job at all.
test('re-running finalizeTranscription duplicates neither utterances nor jobs', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  db.finalizeTranscription(id, ROWS);
  db.finalizeTranscription(id, ROWS);

  assert.equal(db.listUtterances(id).length, 1);
  assert.equal(db.listPendingJobs().length, 1);
});

test('a job stranded in running is recovered on startup', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  const job = db.finalizeTranscription(id, ROWS);

  db.markJobRunning(job.id);
  assert.equal(db.nextDueJob(), undefined, 'running jobs are not due...');
  assert.equal(db.resetStuckRunningJobs(), 1);
  assert.equal(db.nextDueJob()?.id, job.id, '...until startup resets them');
});

test('a meeting left with no live job is detected as orphaned', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  const job = db.finalizeTranscription(id, ROWS);
  db.failJobPermanently(job.id, 'gave up');

  const orphans = db.listMeetingsAwaitingSummaryWithoutJob();
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, id);
});

test('requeueSummarizeNow reuses the existing job instead of stacking a duplicate', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  db.finalizeTranscription(id, ROWS);

  db.requeueSummarizeNow(id);
  db.requeueSummarizeNow(id);
  assert.equal(db.listPendingJobs().length, 1, 'spamming /summarise must not post the session twice');
});

test('requeueSummarizeNow also releases a parked job', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  db.finalizeTranscription(id, ROWS, { requireApproval: true });

  db.requeueSummarizeNow(id);
  assert.equal(db.nextDueJob()?.meeting_id, id);
});

// The retry queue stores ISO timestamps but SQLite's datetime() uses a space
// separator; comparing them as raw strings meant a failed job was never due
// again, silently disabling the whole "PC is sometimes off" design.
test('a rescheduled job becomes due again once its backoff has passed', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  const job = db.finalizeTranscription(id, ROWS);

  db.rescheduleJob(job.id, new Date(Date.now() - 60_000).toISOString(), 'fetch failed');
  assert.equal(db.nextDueJob()?.id, job.id, 'ISO vs SQLite datetime formats must compare correctly');

  db.rescheduleJob(job.id, new Date(Date.now() + 3_600_000).toISOString(), 'fetch failed');
  assert.equal(db.nextDueJob(), undefined, 'a future retry is not yet due');
});

test('settings persist and fall back cleanly', async (t) => {
  const db = await freshDb(t);
  assert.equal(db.getSetting('summarize_paused', 'unset'), 'unset');

  db.setSetting('summarize_paused', 'true');
  assert.equal(db.getSetting('summarize_paused'), 'true');

  db.setSetting('summarize_paused', 'false');
  assert.equal(db.getSetting('summarize_paused'), 'false');
});

test('listPipeline reports in-flight work with utterance counts', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  db.finalizeTranscription(id, ROWS, { requireApproval: true });

  const pipeline = db.listPipeline();
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].id, id);
  assert.equal(pipeline[0].job_status, 'awaiting_approval');
  assert.equal(pipeline[0].utterance_count, 1);
});

test('searchUtterances is case-insensitive and neutralises LIKE wildcards', async (t) => {
  const db = await freshDb(t);
  const id = seedMeeting(db);
  db.finalizeTranscription(id, ROWS);

  assert.equal(db.searchUtterances('G1', 'marrowgate', 5).length, 1);
  assert.equal(db.searchUtterances('G1', 'MARROWGATE', 5).length, 1);
  assert.equal(db.searchUtterances('G1', '%', 5).length, 0, 'a bare % must not match everything');
  assert.equal(db.searchUtterances('G1', '_', 5).length, 0);
  assert.equal(db.searchUtterances('OTHER_GUILD', 'marrowgate', 5).length, 0, 'campaigns must not leak across guilds');
});

test('character names are per-guild and upsert cleanly', async (t) => {
  const db = await freshDb(t);
  db.setCharacterName('G1', 'u1', 'Thalric');
  db.setCharacterName('G1', 'u1', 'Thalric the Second');

  assert.equal(db.getCharacterName('G1', 'u1'), 'Thalric the Second');
  assert.equal(db.getCharacterName('G2', 'u1'), null);
});

test('campaignStats totals only completed sessions, ranks talkers, and finds the longest', async (t) => {
  const db = await freshDb(t);

  // Session 1: 1 hour, two speakers.
  const id1 = db.createMeeting({ guildId: 'G1', channelId: 'C1', channelName: 'Cipher', startedAt: '2026-07-01T10:00:00Z', audioDir: '/tmp' });
  db.finalizeTranscription(id1, [
    { userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1000, text: 'a' },
    { userId: 'u1', displayName: 'Koru', startMs: 1000, endMs: 2000, text: 'b' },
    { userId: 'u2', displayName: 'Vex', startMs: 2000, endMs: 3000, text: 'c' },
  ]);
  db.endMeeting(id1, '2026-07-01T11:00:00Z');
  db.setSummary(id1, { tldr: 'x' });

  // Session 2: 3 hours (the longest), one speaker.
  const id2 = db.createMeeting({ guildId: 'G1', channelId: 'C1', channelName: 'Cipher', startedAt: '2026-07-08T10:00:00Z', audioDir: '/tmp' });
  db.finalizeTranscription(id2, [{ userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1000, text: 'd' }]);
  db.endMeeting(id2, '2026-07-08T13:00:00Z');
  db.setSummary(id2, { tldr: 'y' });

  // Never finished — must not count toward totals at all.
  const id3 = db.createMeeting({ guildId: 'G1', channelId: 'C1', channelName: 'Cipher', startedAt: '2026-07-15T10:00:00Z', audioDir: '/tmp' });
  db.finalizeTranscription(id3, [{ userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1000, text: 'e' }]);

  const stats = db.campaignStats('G1');
  assert.equal(stats.totalSessions, 2);
  assert.equal(stats.totalLines, 4, 'only lines from the 2 completed sessions');
  assert.equal(stats.totalMs, 60 * 60_000 + 3 * 60 * 60_000);
  assert.equal(stats.longestMeetingId, id2);
  assert.equal(stats.longestMs, 3 * 60 * 60_000);
  assert.deepEqual(stats.talkative[0], { display_name: 'Koru', lines: 3 });

  assert.deepEqual(db.campaignStats('OTHER_GUILD'), {
    totalSessions: 0,
    totalMs: 0,
    totalLines: 0,
    talkative: [],
    longestMeetingId: null,
    longestMs: 0,
  });
});
