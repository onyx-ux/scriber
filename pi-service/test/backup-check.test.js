import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { verifyNewestBackup, newestSnapshot, checkAndRecordBackup, lastBackupCheck, startBackupTimer } from '../src/maintenance/backup-check.js';

// Proving the backup is a backup.
//
// The snapshot has always been taken correctly. Nobody had ever opened one,
// which makes it a hypothesis rather than a backup — and the failure mode of a
// hypothesis is that you find out on the evening the SD card dies.

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-backup-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: '111', displayName: 'Saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
    { userId: '222', displayName: 'Brett', startMs: 2, endMs: 3, text: 'Nobody voted on that.' },
  ]);

  const cfg = { dataDir: dir };
  return { db, cfg, dir, campaignId, meeting };
}

const snapshot = async (db, dir) => {
  await mkdir(join(dir, 'backups'), { recursive: true });
  await db.raw.backup(join(dir, 'backups', `db-${Date.now()}.sqlite`));
};

// --- the happy path, which is the one that has never been checked ---

test('a real snapshot opens, passes integrity and matches the live counts', async (t) => {
  const { db, cfg, dir } = await world(t);
  await snapshot(db, dir);

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.ok, true, report.reason ?? '');
  assert.equal(report.counts.utterances.backed, 2);
  assert.equal(report.counts.utterances.live, 2);
  assert.ok(report.bytes > 0);
  assert.ok(report.takenAt);
});

test('with no snapshots at all it says so rather than passing', async (t) => {
  const { db, cfg } = await world(t);
  const report = await verifyNewestBackup(db, cfg);

  assert.equal(report.ok, false);
  assert.match(report.reason, /no snapshots/);
});

test('the newest snapshot is the one checked', async (t) => {
  const { db, cfg, dir } = await world(t);
  await snapshot(db, dir);
  await new Promise((r) => setTimeout(r, 5));
  await snapshot(db, dir);

  const files = (await readdir(join(dir, 'backups'))).sort();
  const found = await newestSnapshot(dir);
  assert.ok(found.path.endsWith(files.at(-1)));
});

// --- the failures worth catching ---

test('a truncated snapshot is caught rather than counted', async (t) => {
  const { db, cfg, dir } = await world(t);
  await snapshot(db, dir);

  const files = (await readdir(join(dir, 'backups'))).sort();
  await writeFile(join(dir, 'backups', files.at(-1)), 'this is not a database');

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.ok, false);
  assert.ok(report.reason);
});

// The quiet failure: a file that opens fine and holds nothing. A file-copy
// backup taken mid-write can look exactly like this.
test('a snapshot missing the tables that matter is not ok', async (t) => {
  const { db, cfg, dir } = await world(t);
  await mkdir(join(dir, 'backups'), { recursive: true });

  const empty = openDb(join(dir, 'decoy.sqlite'));
  empty.raw.exec('DROP TABLE utterances');
  await empty.raw.backup(join(dir, 'backups', `db-${Date.now()}.sqlite`));
  empty.close();

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.ok, false);
  assert.match(report.reason, /missing.*utterances/);
});

// Live growing since the snapshot is expected and must not read as a failure —
// otherwise every check during an active session cries wolf.
test('a session recorded after the snapshot is not a failure', async (t) => {
  const { db, cfg, dir, campaignId } = await world(t);
  await snapshot(db, dir);

  const later = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-02T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(later, [{ userId: '111', displayName: 'Saf', startMs: 0, endMs: 1, text: 'later' }]);

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.ok, true, report.reason ?? '');
});

// But a snapshot far behind live is the thing worth shouting about: it means
// the backup has silently stopped running.
test('a snapshot badly behind live is reported', async (t) => {
  const { db, cfg, dir, campaignId } = await world(t);
  await snapshot(db, dir);

  for (let i = 0; i < 12; i += 1) {
    const m = db.createMeeting({
      guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
      startedAt: `2026-09-${String(i + 1).padStart(2, '0')}T19:00:00Z`, audioDir: '/tmp',
    });
    db.finalizeTranscription(m, [{ userId: '111', displayName: 'Saf', startMs: 0, endMs: 1, text: 'x' }]);
  }

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.ok, false);
  assert.match(report.reason, /behind on/);
});

// --- remembering the answer ---

test('the result is stored where the dashboard can read it', async (t) => {
  const { db, cfg, dir } = await world(t);
  await snapshot(db, dir);

  await checkAndRecordBackup(db, cfg);
  const stored = lastBackupCheck(db);

  assert.equal(stored.ok, true);
  assert.ok(stored.checkedAt, 'the honest answer is "it was, when it was last checked"');
});

test('a bot that has never checked reports nothing rather than success', async (t) => {
  const { db } = await world(t);
  assert.equal(lastBackupCheck(db), null);
});

// The failure that actually matters day to day, and the one row counts cannot
// see: the backup stopped running weeks ago and nobody noticed. The snapshot is
// perfect. It is just old.
test('a snapshot that has stopped being taken is caught by its age', async (t) => {
  const { db, cfg, dir } = await world(t);
  await snapshot(db, dir);

  const files = (await readdir(join(dir, 'backups'))).sort();
  const path = join(dir, 'backups', files.at(-1));
  const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 3600 * 1000);
  await utimes(path, threeWeeksAgo, threeWeeksAgo);

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.ok, false);
  assert.equal(report.stale, true);
  assert.match(report.reason, /stopped running/);
  assert.ok(report.ageHours > 500);
});

test('a fresh snapshot is not stale', async (t) => {
  const { db, cfg, dir } = await world(t);
  await snapshot(db, dir);

  const report = await verifyNewestBackup(db, cfg);
  assert.equal(report.stale, false);
  assert.ok(report.ageHours < 1);
});

// --- taking one on a timer, not only when somebody plays ---

test('the timer fires an immediate snapshot and then repeats', async (t) => {
  const { db, cfg } = await world(t);
  let taken = 0;

  const handle = startBackupTimer(db, { ...cfg, driveSyncEnabled: true }, {
    backupAndSync: async () => { taken += 1; },
    everyMs: 10,
  });
  t.after(() => clearInterval(handle.timer));

  await handle.tick();
  assert.equal(taken, 1, 'one straight away, so a restart is a backup');

  await new Promise((r) => setTimeout(r, 45));
  assert.ok(taken > 1, 'and again on the interval');
});

test('a failing backup does not take the bot down', async (t) => {
  const { db, cfg } = await world(t);
  const handle = startBackupTimer(db, { ...cfg, driveSyncEnabled: true }, {
    backupAndSync: async () => { throw new Error('rclone exploded'); },
    everyMs: 10_000,
  });
  t.after(() => clearInterval(handle.timer));

  await assert.doesNotReject(() => handle.tick());
});

test('with drive sync off there is no timer at all', async (t) => {
  const { db, cfg } = await world(t);
  assert.equal(startBackupTimer(db, { ...cfg, driveSyncEnabled: false }, { backupAndSync: async () => {} }), null);
});
