import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// A fresh DB snapshot is written on every transcription AND every summary —
// roughly two per session — and nothing ever removed them, so the Pi
// accumulated a full copy of the database (transcripts included) forever.
// Keep a rolling window instead; Drive holds the long-term history.
const MAX_DB_SNAPSHOTS = 10;

async function pruneOldSnapshots(dir) {
  try {
    const files = (await readdir(dir))
      .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
      .sort(); // db-<epoch-ms>.sqlite — fixed-width timestamps sort chronologically
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_DB_SNAPSHOTS))) {
      await rm(join(dir, stale), { force: true });
    }
  } catch (err) {
    console.warn(`[drive-sync] snapshot prune skipped: ${err.message}`);
  }
}

function remotePath(cfg, ...parts) {
  return `${cfg.driveRemoteName}:${cfg.driveRemotePath}/${parts.join('/')}`;
}

async function rcloneCopy(src, dest) {
  // `copy` (not `sync`) on purpose — sync can delete files on the remote
  // that don't exist locally, which is the wrong behavior for an
  // append-only session archive. copy only adds/updates.
  await execFileAsync('rclone', ['copy', src, dest, '--quiet'], { timeout: 10 * 60 * 1000 });
}

// The per-session notes and DB snapshots are write-once — the Pi is always
// the source of truth for those, so a plain upload is fine. The CAMPAIGN
// LEDGER is different: you edit those files directly in Obsidian (fixing
// typos, merging duplicate NPCs, adding your own notes), so the version on
// Drive can be newer/better than the Pi's local copy. Before appending
// anything, pull the Drive version down first so we're appending onto your
// edits, not silently overwriting them with a stale local copy.
//
// This is "last-writer-wins at the pull step," not real two-way sync — if
// you edit a ledger file in Obsidian at the exact moment a session finishes
// summarizing, whichever write lands last on Drive wins. For a solo/home
// campaign that's finishing a session once every week or two, that
// collision window is small enough not to worry about in practice.
export async function pullLedgerFromDrive(localDir, remoteSubpath, cfg) {
  if (!cfg.driveSyncEnabled) return;
  try {
    await rcloneCopy(remotePath(cfg, remoteSubpath), localDir);
  } catch (err) {
    // If nothing exists on Drive yet (first run), rclone errors on the
    // missing remote path — that's expected and fine, just proceed with
    // whatever's local (possibly nothing, which appendUnique handles).
    console.warn(`[drive-sync] ledger pull skipped/failed (likely first run): ${err.message}`);
  }
}

export async function pushLedgerToDrive(localDir, remoteSubpath, cfg) {
  if (!cfg.driveSyncEnabled) return;
  try {
    await rcloneCopy(localDir, remotePath(cfg, remoteSubpath));
    console.log(`[drive-sync] pushed ledger ${remoteSubpath}`);
  } catch (err) {
    console.error(`[drive-sync] ledger push failed: ${err.message}`);
  }
}

export async function syncSessionMarkdown(mdPath, cfg) {
  if (!cfg.driveSyncEnabled) return;
  try {
    await rcloneCopy(mdPath, remotePath(cfg, 'notes'));
    console.log(`[drive-sync] uploaded ${mdPath}`);
  } catch (err) {
    // Sync failures should never block the bot's core function — log and
    // move on. Nothing about Discord delivery or local storage depends on
    // this succeeding.
    console.error(`[drive-sync] markdown upload failed: ${err.message}`);
  }
}

// `audioPath` is normally the single compressed whole-session recording built
// by pipeline/session-recording.js, not the raw per-utterance fragment
// directory — rclone copy handles a single file the same way it handles a
// directory, so no change needed here when the caller switched from one to
// the other.
export async function syncSessionAudio(audioPath, meetingId, cfg) {
  if (!cfg.driveSyncEnabled || !cfg.driveSyncAudio) return;
  try {
    await rcloneCopy(audioPath, remotePath(cfg, 'audio', String(meetingId)));
    console.log(`[drive-sync] uploaded audio for meeting ${meetingId}`);
  } catch (err) {
    console.error(`[drive-sync] audio upload failed: ${err.message}`);
  }
}

// SQLite is being actively written to (WAL mode), so we never rclone the
// live db.sqlite directly — that risks uploading a torn/inconsistent file.
// better-sqlite3's .backup() API produces a proper point-in-time-consistent
// snapshot first; only the snapshot gets uploaded.
export async function backupAndSyncDatabase(db, cfg) {
  if (!cfg.driveSyncEnabled) return;
  const backupDir = join(cfg.dataDir, 'backups');
  try {
    const snapshotPath = join(backupDir, `db-${Date.now()}.sqlite`);
    await mkdir(backupDir, { recursive: true });
    await db.raw.backup(snapshotPath);
    await rcloneCopy(snapshotPath, remotePath(cfg, 'db-backups'));
    console.log(`[drive-sync] uploaded db snapshot ${snapshotPath}`);
  } catch (err) {
    console.error(`[drive-sync] db backup/upload failed: ${err.message}`);
  } finally {
    // Prune even when the upload failed — the local snapshot was still written.
    await pruneOldSnapshots(backupDir);
  }
}
