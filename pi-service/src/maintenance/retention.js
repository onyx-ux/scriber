import { rm } from 'node:fs/promises';

// Only ever deletes audio for meetings that are fully 'done' (transcribed +
// summarized + posted) — never touches anything still pending/failed/
// retrying, since that audio might still be needed. This runs on a timer,
// not synchronously after every session, so a slow week doesn't matter.
export async function cleanupOldAudio(db, cfg) {
  if (!cfg.audioRetentionDays || cfg.audioRetentionDays <= 0) return; // 0 = keep forever

  const cutoff = Date.now() - cfg.audioRetentionDays * 24 * 60 * 60 * 1000;
  const rows = db.raw
    .prepare(`SELECT id, audio_dir, started_at FROM meetings WHERE status = 'done' AND audio_dir IS NOT NULL`)
    .all();

  let deleted = 0;
  for (const row of rows) {
    const startedAtMs = new Date(row.started_at).getTime();
    if (Number.isNaN(startedAtMs) || startedAtMs > cutoff) continue;

    try {
      await rm(row.audio_dir, { recursive: true, force: true });
      db.raw.prepare(`UPDATE meetings SET audio_dir = NULL WHERE id = ?`).run(row.id);
      deleted++;
    } catch (err) {
      console.error(`[retention] failed to delete audio for meeting ${row.id}: ${err.message}`);
    }
  }

  if (deleted > 0) {
    console.log(`[retention] cleaned up audio for ${deleted} meeting(s) older than ${cfg.audioRetentionDays} days`);
  }
}

export function startRetentionTimer(db, cfg, intervalMs = 6 * 60 * 60 * 1000) {
  // run once shortly after boot, then on the interval
  setTimeout(() => cleanupOldAudio(db, cfg).catch((e) => console.error('[retention] error:', e)), 30_000);
  const handle = setInterval(() => {
    cleanupOldAudio(db, cfg).catch((e) => console.error('[retention] error:', e));
  }, intervalMs);
  return () => clearInterval(handle);
}
