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

  const mine = db.forTests.defaultCampaignId('G1');
  assert.equal(db.searchUtterances(mine, 'marrowgate', 5).length, 1);
  assert.equal(db.searchUtterances(mine, 'MARROWGATE', 5).length, 1);
  assert.equal(db.searchUtterances(mine, '%', 5).length, 0, 'a bare % must not match everything');
  assert.equal(db.searchUtterances(mine, '_', 5).length, 0);
  assert.equal(
    db.searchUtterances(db.forTests.defaultCampaignId('OTHER_GUILD'), 'marrowgate', 5).length,
    0,
    'campaigns must not leak across guilds'
  );
});

test('search does not leak between two campaigns in one server', async (t) => {
  const db = await freshDb(t);
  const first = db.createCampaign('G', 'Cipher', 'dm-a');
  const second = db.createCampaign('G', 'Strahd', 'dm-b');
  const id = db.createMeeting({
    guildId: 'G',
    campaignId: first,
    channelId: 'C',
    channelName: 'Cipher',
    startedAt: 'x',
    audioDir: '/tmp',
  });
  db.finalizeTranscription(id, ROWS);

  assert.equal(db.searchUtterances(first, 'marrowgate', 5).length, 1);
  assert.equal(db.searchUtterances(second, 'marrowgate', 5).length, 0, 'the other table in the same Discord sees nothing');
});

test('character names are per-campaign and upsert cleanly', async (t) => {
  const db = await freshDb(t);
  const a = db.forTests.defaultCampaignId('G1');
  const b = db.forTests.defaultCampaignId('G2');
  db.setCharacterName(a, 'u1', 'Thalric');
  db.setCharacterName(a, 'u1', 'Thalric the Second');

  assert.equal(db.getCharacterName(a, 'u1'), 'Thalric the Second');
  assert.equal(db.getCharacterName(b, 'u1'), null);
});

test('one person can play different characters in two campaigns in one server', async (t) => {
  const db = await freshDb(t);
  const first = db.createCampaign('G', 'Cipher', 'dm-a');
  const second = db.createCampaign('G', 'Strahd', 'dm-b');

  db.setCharacterName(first, 'u1', 'Thalric');
  db.setCharacterName(second, 'u1', 'Ireena');

  assert.equal(db.getCharacterName(first, 'u1'), 'Thalric');
  assert.equal(db.getCharacterName(second, 'u1'), 'Ireena');
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

  const stats = db.campaignStats(db.forTests.defaultCampaignId('G1'));
  assert.equal(stats.totalSessions, 2);
  assert.equal(stats.totalLines, 4, 'only lines from the 2 completed sessions');
  assert.equal(stats.totalMs, 60 * 60_000 + 3 * 60 * 60_000);
  assert.equal(stats.longestMeetingId, id2);
  assert.equal(stats.longestMs, 3 * 60 * 60_000);
  assert.deepEqual(stats.talkative[0], { display_name: 'Koru', lines: 3 });

  assert.deepEqual(db.campaignStats(db.forTests.defaultCampaignId('OTHER_GUILD')), {
    totalSessions: 0,
    totalMs: 0,
    totalLines: 0,
    talkative: [],
    longestMeetingId: null,
    longestSessionNumber: null,
    longestMs: 0,
  });
});

// --- the test-only surface stays test-only ---

// db.forTests exists so that arranging state by hand is visible at the call
// site rather than indistinguishable from something the bot does. That only
// holds while the bot itself never reaches for it: the moment a src/ module
// does, the label is a lie and the store has quietly grown a door again.
//
// See docs/adr/0001 for why the store is one wide module rather than five, and
// why the fix for a cluster like this is a narrower seam, not a split.
test('nothing in src/ opens a test-only door', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');

  const root = fileURLToPath(new URL('../src', import.meta.url));

  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const offenders = [];
  for (const file of await walk(root)) {
    const source = await readFile(file, 'utf8');
    // The definition itself lives in store/db.js; every other mention is a use.
    if (file.endsWith(join('store', 'db.js'))) continue;
    if (/\bforTests\b/.test(source)) offenders.push(file.slice(root.length + 1));
  }

  assert.deepEqual(offenders, [], 'these reach into the store\'s test-only surface');
});
