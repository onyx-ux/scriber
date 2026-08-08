import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { transcribeTick } from '../src/pipeline/transcribe-worker.js';
import { decideTranscribeAction } from '../src/pipeline/transcribe-schedule.js';
import { buildWhisperPrompt } from '../src/stt/vocabulary.js';

// One bot, several Discord servers, sessions running at the same time. The
// recording path keeps everything per-guild (activeSessions, startingGuilds
// and audioDir are all keyed by guild id, and startCapture closes over its
// own connection/decoders), so what needs pinning here is everything AFTER
// capture: that two campaigns cannot end up sharing a queue slot, an
// approval, or each other's vocabulary.

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-mg-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

const cfg = {
  scheduleTimeZone: 'Australia/Brisbane',
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeSnoozeHours: 24,
  ownerUserId: 'OWNER',
};

// enqueueTranscribeJob stamps next_attempt_at with SQLite's datetime('now'),
// so a hard-coded date in the past would read every freshly queued job as
// snoozed. An approved job ignores the window, so the weekday is irrelevant
// to these tests — only "after the row was written" matters.
const afterEnqueue = () => new Date(Date.now() + 60_000);

const startSession = (db, guildId, n) =>
  db.createMeeting({
    guildId,
    channelId: `chan-${guildId}`,
    channelName: `Session ${n}`,
    startedAt: new Date().toISOString(),
    // Mirrors handleJoin: guild id plus a timestamp, so two servers recording
    // at the same moment cannot collide on disk.
    audioDir: `/data/audio/${guildId}-${1785579484748 + n}`,
  });

test('three servers recording at once produce three independent sessions', async (t) => {
  const db = await freshDb(t);
  const guilds = ['guild-A', 'guild-B', 'guild-C'];
  const meetings = guilds.map((g, i) => startSession(db, g, i));

  assert.equal(new Set(meetings).size, 3, 'distinct meeting ids');

  const dirs = meetings.map((id) => db.getMeeting(id).audio_dir);
  assert.equal(new Set(dirs).size, 3, 'audio must never share a directory — clips would interleave');
  for (const [i, g] of guilds.entries()) {
    assert.ok(dirs[i].includes(g), `${dirs[i]} should be attributable to ${g}`);
    assert.equal(db.getMeeting(meetings[i]).guild_id, g);
  }
});

test('each server gets its own queued job', async (t) => {
  const db = await freshDb(t);
  const jobs = ['guild-A', 'guild-B', 'guild-C'].map((g, i) =>
    db.enqueueTranscribeJob(startSession(db, g, i), { requireApproval: true })
  );

  assert.equal(new Set(jobs.map((j) => j.id)).size, 3);
  assert.equal(db.dueTranscribeJobs().length, 3);
});

// The GPU is one machine. Three servers finishing together must not mean
// three concurrent transcriptions competing for the same card.
test('simultaneous sessions transcribe one at a time, not all at once', async (t) => {
  const db = await freshDb(t);
  for (const [i, g] of ['guild-A', 'guild-B', 'guild-C'].entries()) {
    const id = startSession(db, g, i);
    db.approveTranscribeNow(db.enqueueTranscribeJob(id, { requireApproval: false }).id);
  }

  const runs = [];
  const runJob = async (_db, _client, _cfg, job) => runs.push(job.id);
  const probe = async () => true;

  await transcribeTick(db, null, cfg, { now: afterEnqueue(), probe, runJob });
  assert.equal(runs.length, 1, 'one tick, one session');

  // The others are still queued, not dropped.
  assert.equal(db.dueTranscribeJobs().length, 3);
});

test('approving one server’s session leaves the others parked', async (t) => {
  const db = await freshDb(t);
  const [a, b] = ['guild-A', 'guild-B'].map((g, i) =>
    db.enqueueTranscribeJob(startSession(db, g, i), { requireApproval: true })
  );

  db.approveTranscribeNow(a.id);

  const byId = Object.fromEntries(db.dueTranscribeJobs().map((j) => [j.id, j.status]));
  assert.equal(byId[a.id], 'pending');
  assert.equal(byId[b.id], 'awaiting_approval', 'approving one campaign must not release another');
});

test('snoozing one server’s session does not delay another', async (t) => {
  const db = await freshDb(t);
  const [a, b] = ['guild-A', 'guild-B'].map((g, i) =>
    db.enqueueTranscribeJob(startSession(db, g, i), { requireApproval: false })
  );

  db.snoozeTranscribeJob(a.id, new Date(Date.now() + 3600_000 + 60_000).toISOString());

  const jobs = Object.fromEntries(db.dueTranscribeJobs().map((j) => [j.id, j]));
  assert.equal(decideTranscribeAction({ job: jobs[a.id], now: afterEnqueue(), serverReachable: true, cfg }).action, 'wait');
  assert.equal(decideTranscribeAction({ job: jobs[b.id], now: afterEnqueue(), serverReachable: true, cfg }).action, 'run');
});

// Two campaigns on one bot must not bleed names into each other's transcripts.
test('campaign vocabulary does not leak between servers', async (t) => {
  const db = await freshDb(t);
  db.setCharacterName('guild-A', 'u1', 'Kaelen Zyrthax');
  db.setCharacterName('guild-B', 'u2', 'Bram Stormhill');
  db.addCorrection('guild-A', 'kaylen', 'Kaelen Zyrthax');

  const a = buildWhisperPrompt({
    corrections: db.listCorrections('guild-A'),
    characters: db.listCharacters('guild-A'),
  });
  const b = buildWhisperPrompt({
    corrections: db.listCorrections('guild-B'),
    characters: db.listCharacters('guild-B'),
  });

  assert.match(a, /Kaelen Zyrthax/);
  assert.doesNotMatch(a, /Bram/, 'guild A must not be biased toward guild B’s cast');
  assert.match(b, /Bram Stormhill/);
  assert.doesNotMatch(b, /Kaelen/);
});

test('a per-session Pi override applies only to that session', async (t) => {
  const db = await freshDb(t);
  const [a, b] = ['guild-A', 'guild-B'].map((g, i) =>
    db.enqueueTranscribeJob(startSession(db, g, i), { requireApproval: false })
  );

  db.setSetting(`transcribe_target_${a.id}`, 'pi');

  assert.equal(db.getSetting(`transcribe_target_${a.id}`), 'pi');
  assert.equal(db.getSetting(`transcribe_target_${b.id}`), null, 'the other server still uses the GPU');
});

// With the PC off, "wait" has to mean wait for every server equally.
test('an unreachable PC parks every server’s session', async (t) => {
  const db = await freshDb(t);
  for (const [i, g] of ['guild-A', 'guild-B', 'guild-C'].entries()) {
    db.approveTranscribeNow(
      db.enqueueTranscribeJob(startSession(db, g, i), { requireApproval: false }).id
    );
  }

  const runs = [];
  await transcribeTick(db, null, cfg, {
    now: afterEnqueue(),
    probe: async () => false,
    runJob: async (_d, _c, _cfg, job) => runs.push(job.id),
  });

  assert.equal(runs.length, 0);
  assert.equal(db.dueTranscribeJobs().length, 3, 'still queued for when it comes back');
});
