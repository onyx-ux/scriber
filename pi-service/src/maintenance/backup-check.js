// Proving the backup is a backup.
//
// The snapshot is taken correctly — SQLite's own .backup() rather than a file
// copy, so it is point-in-time consistent even though WAL writes are landing
// underneath it. That was never the risk. The risk is that nobody has ever
// opened one.
//
// An untested restore is a hypothesis. This is the cheap half of testing it:
// open the newest snapshot as a real database, ask it the questions the bot
// would ask on boot, and compare the answers to the live one. It does not
// prove a Raspberry Pi will boot from it — only walking that path does — but
// it does turn "there are files in a folder" into "the newest file is a
// database containing this campaign's sessions", which is most of the way.
//
// Run after each snapshot. Cheap: opening a SQLite file read-only and running
// five COUNT(*)s costs milliseconds.
import Database from 'better-sqlite3';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// The tables without which a restored bot is not the same bot. Deliberately
// the ones holding things that cannot be regenerated: a transcript is gone
// for ever, a job queue rebuilds itself.
const MUST_HOLD = ['campaigns', 'meetings', 'utterances', 'campaign_consent', 'characters', 'corrections'];

// Row counts and age answer different questions, and conflating them made the
// check cry wolf.
//
// COUNTS catch a snapshot that is empty or truncated — the file-copy-mid-write
// failure. They are deliberately generous, because the snapshot was taken at a
// point in time and the bot has been running since: a session recorded in
// between legitimately makes live bigger, and on a small database one session
// is a large fraction. Half is the line, and it is about corruption, not drift.
//
// AGE catches the failure that actually matters day to day: the backup quietly
// stopped running weeks ago and nobody noticed. That is not visible in a row
// count at all — the snapshot is perfect, it is just old.
const SEVERE_SHORTFALL = 0.5;
const STALE_AFTER_HOURS = 48;

export async function newestSnapshot(dataDir) {
  const dir = join(dataDir, 'backups');
  try {
    const files = (await readdir(dir))
      .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
      .sort();
    if (!files.length) return null;

    const path = join(dir, files.at(-1));
    const info = await stat(path);
    return { path, bytes: info.size, takenAt: new Date(info.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

// Open the newest snapshot and see whether it is worth having.
export async function verifyNewestBackup(db, cfg) {
  const snapshot = await newestSnapshot(cfg.dataDir);
  if (!snapshot) {
    return { ok: false, checkedAt: new Date().toISOString(), reason: 'There are no snapshots to check.' };
  }

  let copy = null;
  try {
    // readonly, and fileMustExist so a typo cannot create an empty database
    // and then cheerfully report that it opened.
    copy = new Database(snapshot.path, { readonly: true, fileMustExist: true });

    // SQLite's own opinion first. A file that fails this is corrupt whatever
    // the row counts say.
    const integrity = copy.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') {
      return { ok: false, ...snapshot, checkedAt: new Date().toISOString(), reason: `quick_check said "${integrity}"` };
    }

    const missing = MUST_HOLD.filter(
      (table) => !copy.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table)
    );
    if (missing.length) {
      return {
        ok: false, ...snapshot, checkedAt: new Date().toISOString(),
        reason: `the snapshot is missing ${missing.join(', ')}`,
      };
    }

    const counts = {};
    const shortfall = [];
    for (const table of MUST_HOLD) {
      const backed = copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      const live = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      counts[table] = { backed, live };

      // Empty while live has rows is the clearest corruption signal there is.
      if (live > 0 && backed < live * SEVERE_SHORTFALL) shortfall.push(`${table} ${backed}/${live}`);
    }

    const ageHours = (Date.now() - new Date(snapshot.takenAt).getTime()) / 3_600_000;
    const stale = ageHours > (cfg.backupMaxAgeHours ?? STALE_AFTER_HOURS);

    const reasons = [
      shortfall.length ? `behind on ${shortfall.join(', ')}` : null,
      stale ? `the newest snapshot is ${Math.floor(ageHours)}h old — has the backup stopped running?` : null,
    ].filter(Boolean);

    return {
      ok: reasons.length === 0,
      ...snapshot,
      checkedAt: new Date().toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      stale,
      counts,
      reason: reasons.length ? reasons.join('; ') : null,
    };
  } catch (err) {
    return { ok: false, ...snapshot, checkedAt: new Date().toISOString(), reason: err.message };
  } finally {
    try {
      copy?.close();
    } catch {
      // Closing a database that failed to open is not an error worth raising.
    }
  }
}

// Verify, and remember the answer where the dashboard can read it.
//
// Stored rather than recomputed on every status poll: opening a file is cheap
// but not free, and the honest answer to "is the backup good" is "it was, when
// it was last checked" — which needs a timestamp anyway.
export async function checkAndRecordBackup(db, cfg) {
  const report = await verifyNewestBackup(db, cfg);
  try {
    db.setSetting('backup_last_check', JSON.stringify(report));
  } catch (err) {
    console.warn('[backup] could not record the check:', err.message);
  }

  if (report.ok) {
    console.log(`[backup] verified ${report.path} (${Math.round((report.bytes ?? 0) / 1024)} KB)`);
  } else {
    console.error(`[backup] the newest snapshot is NOT restorable: ${report.reason}`);
  }
  return report;
}

// Take a snapshot on a timer, not only when a session finishes.
//
// Backups used to fire from exactly two places: the end of a recording and the
// end of a summary. That is fine for transcripts, which is what everybody
// thinks of as the data — and wrong for everything else. Consent decisions,
// character names, corrections and the roster all change on days nobody plays,
// and a table that has a quiet fortnight had no snapshot for a fortnight.
//
// Observed doing exactly that: the newest automatic snapshot was 40 hours old
// and missing all six character names, because they were set after the last
// session was transcribed.
//
// Cheap enough to be boring: SQLite's .backup() on a 950 KB database, once a
// day, and the rolling window already keeps ten.
export function startBackupTimer(db, cfg, { backupAndSync, everyMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!cfg.driveSyncEnabled) return null;

  const tick = async () => {
    try {
      await backupAndSync(db, cfg);
    } catch (err) {
      // A failed backup must never take the bot down. It is already logged
      // and, from today, the dashboard shows when the newest one went stale.
      console.error('[backup] scheduled snapshot failed:', err.message);
    }
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { timer, tick };
}

export function lastBackupCheck(db) {
  try {
    const raw = db.getSetting('backup_last_check');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
