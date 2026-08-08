import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildStatus } from '../src/web/status.js';
import { nextAutoWindowStart } from '../src/pipeline/transcribe-schedule.js';
import { startTranscription, updateTranscription, endTranscription } from '../src/pipeline/progress.js';

const cfg = {
  scheduleTimeZone: 'Australia/Brisbane',
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeRequireApproval: true,
  summaryProvider: 'gemini',
};

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-status-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

const meeting = (db, guildId = 'g1', name = 'Session') =>
  db.createMeeting({
    guildId,
    channelId: 'c1',
    channelName: name,
    startedAt: new Date().toISOString(),
    audioDir: '/data/audio/x',
  });

// --- when the window next opens ---

const SAT_2330 = new Date('2026-08-08T13:30:00Z'); // Sat 23:30 Brisbane
const WED_10AM = new Date('2026-08-05T00:00:00Z'); // Wed 10:00 Brisbane

test('a Saturday night session is told it resumes Monday morning', () => {
  const next = nextAutoWindowStart(SAT_2330, cfg);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.scheduleTimeZone, weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(next);
  const get = (t) => parts.find((p) => p.type === t)?.value;

  assert.equal(get('weekday'), 'Mon', 'Sunday is skipped entirely');
  assert.equal(Number(get('hour')) % 24, 8);
  // Landing on 08:13 because that is where the walk happened to start would
  // read as wrong on a dashboard.
  assert.equal(
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.scheduleTimeZone, minute: 'numeric' }).format(next),
    '0',
    'must land on the window boundary, not an arbitrary offset'
  );
});

test('inside the window, the answer is now', () => {
  assert.equal(nextAutoWindowStart(WED_10AM, cfg).getTime(), WED_10AM.getTime());
});

test('a window that never opens reports nothing rather than looping forever', () => {
  assert.equal(nextAutoWindowStart(WED_10AM, { ...cfg, transcribeWindowStartHour: 8, transcribeWindowEndHour: 8 }), null);
});

// --- the snapshot ---

test('an idle bot reports itself idle rather than omitting the fields', async (t) => {
  const db = await freshDb(t);
  const s = buildStatus({ db, cfg, now: SAT_2330.getTime() });

  assert.deepEqual(s.recording, []);
  assert.deepEqual(s.working.transcribing, []);
  assert.deepEqual(s.queue.awaitingTranscribe, []);
  assert.equal(s.bot.online, false);
  assert.ok(s.schedule.nextAutoWindowAt, 'the dashboard always needs something to show here');
});

test('a live recording reports where it is and how much it has captured', async (t) => {
  const db = await freshDb(t);
  const id = meeting(db, 'g1', 'Table');
  const now = Date.now();

  const activeSessions = new Map([
    ['g1', {
      meetingId: id,
      channelName: 'Voice Chat',
      startedAtMs: now - 90 * 60_000,
      capturedUtterances: [
        { userId: 'u1' }, { userId: 'u2' }, { userId: 'u1' },
      ],
    }],
  ]);

  const client = { user: { tag: 'Scribe#0233' }, guilds: { cache: new Map([['g1', { id: 'g1', name: 'The Table' }]]) } };
  const s = buildStatus({ db, cfg, client, activeSessions, now });

  assert.equal(s.recording.length, 1);
  const r = s.recording[0];
  assert.equal(r.guildName, 'The Table');
  assert.equal(r.channel, 'Voice Chat');
  assert.equal(r.clips, 3);
  assert.equal(r.speakers, 2, 'three clips from two people is two speakers');
  assert.ok(r.recordingForMs >= 90 * 60_000);
  assert.equal(s.servers[0].recording, true);
});

test('transcription in flight is reported with progress', async (t) => {
  const db = await freshDb(t);
  const id = meeting(db);
  startTranscription(id, 100);
  updateTranscription(id, 42, 100);
  t.after(() => endTranscription(id));

  const s = buildStatus({ db, cfg });
  assert.equal(s.working.transcribing.length, 1);
  assert.equal(s.working.transcribing[0].done, 42);
  assert.equal(s.working.transcribing[0].total, 100);
});

// The point of the "waiting for you" panel: these two must not be conflated.
test('transcribe and summarise approvals are reported separately', async (t) => {
  const db = await freshDb(t);
  const a = meeting(db, 'g1', 'Needs transcribing');
  const b = meeting(db, 'g2', 'Needs summarising');

  db.enqueueTranscribeJob(a, { requireApproval: true });
  // A summarise job is created by finalizeTranscription, not enqueueSummarizeJob
  // — that is where SUMMARY_REQUIRE_APPROVAL is applied.
  db.finalizeTranscription(b, [{ userId: 'u1', displayName: 'A', text: 'hello', startMs: 0, endMs: 1 }], {
    requireApproval: true,
  });

  const s = buildStatus({ db, cfg });
  assert.deepEqual(s.queue.awaitingTranscribe.map((q) => q.meetingId), [a]);
  assert.deepEqual(s.queue.awaitingSummary.map((q) => q.meetingId), [b]);
});

test('an approved job shows as waiting for the PC, not for the owner', async (t) => {
  const db = await freshDb(t);
  const id = meeting(db);
  const job = db.enqueueTranscribeJob(id, { requireApproval: true });
  db.approveTranscribeNow(job.id);

  const s = buildStatus({ db, cfg });
  assert.deepEqual(s.queue.awaitingTranscribe, []);
  assert.deepEqual(s.queue.queuedTranscribe.map((q) => q.meetingId), [id]);
});

test('reachability is passed in, never probed while building', async (t) => {
  const db = await freshDb(t);
  const s = buildStatus({ db, cfg, reachability: { whisperServer: false, summariser: true } });

  assert.equal(s.health.whisperServer, false);
  assert.equal(s.health.summariser, true);
  assert.equal(buildStatus({ db, cfg }).health.whisperServer, null, 'unknown until the first probe lands');
});

test('paused workers are visible', async (t) => {
  const db = await freshDb(t);
  db.setSetting('transcribe_paused', 'true');

  const s = buildStatus({ db, cfg });
  assert.equal(s.health.transcribePaused, true);
  assert.equal(s.health.summarisePaused, false);
});

// This is served unauthenticated on the LAN by default.
test('the snapshot contains no secrets', async (t) => {
  const db = await freshDb(t);
  const withSecrets = {
    ...cfg,
    discordToken: 'TOKEN-SHOULD-NOT-APPEAR',
    geminiApiKey: 'KEY-SHOULD-NOT-APPEAR',
    anthropicApiKey: 'ALSO-NOT',
    statusToken: 'NOR-THIS',
  };

  const json = JSON.stringify(buildStatus({ db, cfg: withSecrets }));
  for (const secret of ['TOKEN-SHOULD-NOT-APPEAR', 'KEY-SHOULD-NOT-APPEAR', 'ALSO-NOT', 'NOR-THIS']) {
    assert.ok(!json.includes(secret), `${secret} leaked into the status payload`);
  }
});
