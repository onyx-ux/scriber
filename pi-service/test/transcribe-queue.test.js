import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-tq-'));
  const db = openDb(join(dir, 'db.sqlite'));
  // Close the native handle before removing the directory — on Windows,
  // deleting a WAL file better-sqlite3 still has open fails with EBUSY.
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

const seedMeeting = (db, n = 1) =>
  db.createMeeting({
    guildId: 'G1',
    channelId: `C${n}`,
    channelName: 'Cipher',
    startedAt: '2026-08-05T10:00:00Z',
    audioDir: `/tmp/audio/${n}`,
  });

test('a new transcribe job parks itself instead of running', async (t) => {
  const db = await freshDb(t);
  const job = db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: true });

  assert.equal(job.type, 'transcribe');
  assert.equal(job.status, 'awaiting_approval');
});

test('approval can be turned off entirely', async (t) => {
  const db = await freshDb(t);
  const job = db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: false });
  assert.equal(job.status, 'pending', 'still schedule-gated, just not asking first');
});

// /leave and the startup recovery pass can both reach the same meeting.
test('enqueueing twice does not create two jobs for one session', async (t) => {
  const db = await freshDb(t);
  const meeting = seedMeeting(db);

  const first = db.enqueueTranscribeJob(meeting, { requireApproval: true });
  const second = db.enqueueTranscribeJob(meeting, { requireApproval: true });

  assert.equal(second.id, first.id);
  assert.equal(db.dueTranscribeJobs().length, 1, 'a duplicate would transcribe the session twice on the GPU');
});

// The two job types share one table. Without a type filter each worker picks
// up the other's work.
test('the summarise worker never sees a transcribe job', async (t) => {
  const db = await freshDb(t);
  db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: false });

  assert.equal(db.nextDueJob(), undefined, 'summarising a meeting with no transcript yet produces nonsense');
});

test('the transcribe worker never sees a summarise job', async (t) => {
  const db = await freshDb(t);
  db.enqueueSummarizeJob(seedMeeting(db));

  assert.equal(db.dueTranscribeJobs().length, 0);
});

test('approving moves a parked job into the runnable state', async (t) => {
  const db = await freshDb(t);
  const job = db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: true });

  db.approveTranscribeNow(job.id);
  assert.equal(db.dueTranscribeJobs()[0].status, 'pending');
});

test('snoozing parks the job again and pushes its eligibility out', async (t) => {
  const db = await freshDb(t);
  const job = db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: false });
  const until = new Date(Date.now() + 24 * 3600_000).toISOString();

  db.snoozeTranscribeJob(job.id, until);

  const [after] = db.dueTranscribeJobs();
  assert.equal(after.status, 'awaiting_approval', 'a snooze has to revoke an earlier approval, or it does nothing');
  assert.equal(after.next_attempt_at, until);
  assert.ok(after.notified_at, 'the snooze itself counts as having been told');
});

test('a job still in the queue is findable from its meeting', async (t) => {
  const db = await freshDb(t);
  const meeting = seedMeeting(db);
  const job = db.enqueueTranscribeJob(meeting, { requireApproval: true });

  assert.equal(db.getTranscribeJobForMeeting(meeting).id, job.id);
  assert.equal(db.getTranscribeJobForMeeting(9999), undefined);
});

test('a finished job stops being due', async (t) => {
  const db = await freshDb(t);
  const job = db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: false });

  db.markJobDone(job.id);
  assert.equal(db.dueTranscribeJobs().length, 0);
});

// A crash at 15:59 must not come back pre-approved at 21:00. 'pending' means
// "the owner said yes" for a transcribe job, so resetting one to pending
// would hand over the GPU at an hour the schedule exists to protect.
test('a transcribe job interrupted by a crash comes back re-gated, not approved', async (t) => {
  const db = await freshDb(t);
  const job = db.enqueueTranscribeJob(seedMeeting(db), { requireApproval: true });
  db.approveTranscribeNow(job.id);
  db.markJobRunning(job.id);
  db.markJobNotified(job.id, '2026-08-05T05:00:00.000Z');

  assert.equal(db.resetStuckRunningJobs(), 1);

  const [after] = db.dueTranscribeJobs();
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.notified_at, null, 'cleared so the owner is re-asked promptly rather than a day later');
});

// Summarising costs an API call, not somebody's frame rate — it should just
// pick up where it left off.
test('a summarise job interrupted by a crash is retried without asking', async (t) => {
  const db = await freshDb(t);
  db.enqueueSummarizeJob(seedMeeting(db));
  const job = db.nextDueJob();
  db.markJobRunning(job.id);

  assert.equal(db.resetStuckRunningJobs(), 1);
  assert.equal(db.nextDueJob().id, job.id);
});

test('both job types are reset together and counted', async (t) => {
  const db = await freshDb(t);
  const a = db.enqueueTranscribeJob(seedMeeting(db, 1), { requireApproval: false });
  db.enqueueSummarizeJob(seedMeeting(db, 2));
  db.markJobRunning(a.id);
  db.markJobRunning(db.nextDueJob().id);

  assert.equal(db.resetStuckRunningJobs(), 2);
});
