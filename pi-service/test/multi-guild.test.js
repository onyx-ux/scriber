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
// recording path keeps every session apart on its own (activeSessions is keyed
// by meeting, the in-flight latch by voice channel, audioDir by guild AND
// channel, and startCapture closes over its own connection/decoders), so what
// needs pinning here is everything AFTER capture: that two campaigns cannot end
// up sharing a queue slot, an approval, or each other's vocabulary.
//
// Several servers at once was always possible with one bot. Several TABLES at
// once inside one server is the newer case and needs a second bot user — see
// two-tables.test.js, which pins the recording path itself.

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
    // Mirrors handleJoin: guild id, voice channel id and a timestamp, so
    // neither two servers nor two tables in one server can collide on disk.
    audioDir: `/data/audio/${guildId}-chan-${guildId}-${1785579484748 + n}`,
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
//
// Keyed on real campaign ids, not on guild ids standing in for them: SQLite is
// loosely typed, so passing 'guild-A' where a campaign id belongs stores the
// string quite happily and the test goes on passing while testing nothing.
test('campaign vocabulary does not leak between servers', async (t) => {
  const db = await freshDb(t);
  const a = db.createCampaign('guild-A', 'Cipher', 'dm-a');
  const b = db.createCampaign('guild-B', 'Strahd', 'dm-b');
  db.setCharacterName(a, 'u1', 'Kaelen Zyrthax');
  db.setCharacterName(b, 'u2', 'Bram Stormhill');
  db.addCorrection(a, 'kaylen', 'Kaelen Zyrthax');

  const promptA = buildWhisperPrompt({ corrections: db.listCorrections(a), characters: db.listCharacters(a) });
  const promptB = buildWhisperPrompt({ corrections: db.listCorrections(b), characters: db.listCharacters(b) });

  assert.match(promptA, /Kaelen Zyrthax/);
  assert.doesNotMatch(promptA, /Bram/, 'guild A must not be biased toward guild B’s cast');
  assert.match(promptB, /Bram Stormhill/);
  assert.doesNotMatch(promptB, /Kaelen/);
});

// The same, for two tables in ONE Discord — the case the guild key could never
// express. Biasing whisper toward the wrong campaign's proper nouns is worse
// than no prompt at all: it invents the other game's cast into this one.
test('campaign vocabulary does not leak between two tables in one server', async (t) => {
  const db = await freshDb(t);
  const a = db.createCampaign('one-server', 'Cipher', 'dm-a');
  const b = db.createCampaign('one-server', 'Strahd', 'dm-b');
  db.setCharacterName(a, 'u1', 'Kaelen Zyrthax');
  db.setCharacterName(b, 'u2', 'Bram Stormhill');

  const promptA = buildWhisperPrompt({ corrections: db.listCorrections(a), characters: db.listCharacters(a) });
  const promptB = buildWhisperPrompt({ corrections: db.listCorrections(b), characters: db.listCharacters(b) });

  assert.match(promptA, /Kaelen/);
  assert.doesNotMatch(promptA, /Bram/);
  assert.match(promptB, /Bram/);
  assert.doesNotMatch(promptB, /Kaelen/);
});

// The prompt is built from the MEETING, so the lookup that matters is
// meeting.campaign_id — not its guild, which no longer identifies a campaign.
test('the vocabulary prompt follows the meeting to its own campaign', async (t) => {
  const { campaignPrompt } = await import('../src/stt/vocabulary.js');
  const db = await freshDb(t);
  const a = db.createCampaign('one-server', 'Cipher', 'dm-a');
  const b = db.createCampaign('one-server', 'Strahd', 'dm-b');
  db.setCharacterName(a, 'u1', 'Kaelen Zyrthax');
  db.setCharacterName(b, 'u2', 'Bram Stormhill');

  const meetingIn = (campaignId) =>
    db.getMeeting(
      db.createMeeting({
        guildId: 'one-server',
        campaignId,
        channelId: 'c',
        channelName: 'Voice',
        startedAt: 'now',
        audioDir: '/tmp',
      })
    );

  const cfg = { whisperPrompt: true, obsidianExportDir: '/nonexistent' };
  const forA = await campaignPrompt(db, cfg, meetingIn(a));
  const forB = await campaignPrompt(db, cfg, meetingIn(b));

  assert.match(forA, /Kaelen/);
  assert.doesNotMatch(forA, /Bram/, "the other table in the same Discord is not in this session's vocabulary");
  assert.match(forB, /Bram/);
  assert.doesNotMatch(forB, /Kaelen/);
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
