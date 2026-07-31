import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'recording',
    -- recording -> transcribing -> awaiting_summary -> summarizing -> done
    -- (or *_failed at any stage)
  audio_dir TEXT,
  transcript_path TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utterances_meeting ON utterances(meeting_id);

-- The job queue is what makes "PC is sometimes off" safe: a summarize job
-- is enqueued the moment transcription finishes, independent of whether
-- Ollama is currently reachable. queue-worker.js polls this table.
CREATE TABLE IF NOT EXISTS characters (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  character_name TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Per-campaign speech-to-text corrections. Columns are *_text rather than
-- "wrong"/"right" because RIGHT is a SQL keyword (RIGHT JOIN) in newer SQLite.
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  wrong_text TEXT NOT NULL,
  correct_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, wrong_text)
);

-- Simple persistent key/value store, so operator state (e.g. the summarise
-- queue being paused) survives a restart rather than living only in memory.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'summarize',
  -- awaiting_approval | pending | running | done | failed
  -- awaiting_approval is the parked state used when SUMMARY_REQUIRE_APPROVAL
  -- is on: nextDueJob only ever selects 'pending', so a parked job sits
  -- untouched until it is explicitly approved.
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_attempt_at);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return wrap(db);
}

function wrap(db) {
  return {
    raw: db,

    close() {
      db.close();
    },

    createMeeting({ guildId, channelId, channelName, startedAt, audioDir }) {
      const stmt = db.prepare(
        `INSERT INTO meetings (guild_id, channel_id, channel_name, started_at, audio_dir, status)
         VALUES (?, ?, ?, ?, ?, 'recording')`
      );
      const info = stmt.run(guildId, channelId, channelName, startedAt, audioDir);
      return info.lastInsertRowid;
    },

    setMeetingStatus(meetingId, status) {
      db.prepare(`UPDATE meetings SET status = ? WHERE id = ?`).run(status, meetingId);
    },

    endMeeting(meetingId, endedAt) {
      db.prepare(`UPDATE meetings SET ended_at = ? WHERE id = ?`).run(endedAt, meetingId);
    },

    getMeeting(meetingId) {
      return db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(meetingId);
    },

    listRecentMeetings(guildId, limit = 10) {
      return db
        .prepare(`SELECT * FROM meetings WHERE guild_id = ? ORDER BY started_at DESC LIMIT ?`)
        .all(guildId, limit);
    },

    listUtterances(meetingId) {
      return db
        .prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY start_ms ASC`)
        .all(meetingId);
    },

    // Commits a finished transcription in ONE transaction: replace the
    // meeting's utterances, mark it awaiting_summary, and enqueue the
    // summarise job.
    //
    // These used to be three separate statements, which left two ways to
    // corrupt or strand a session if the process died in between:
    //   - die after inserting but before the status update -> the meeting is
    //     still 'transcribing', so startup recovery re-transcribes it and
    //     inserts a SECOND copy of every utterance (duplicated transcript).
    //   - die after the status update but before enqueueing -> the meeting
    //     sits in 'awaiting_summary' with no job, and recovery only scans
    //     'recording'/'transcribing', so it never gets summarised at all.
    // Deleting first also makes a recovery re-run idempotent rather than additive.
    finalizeTranscription(meetingId, utterances, { requireApproval = false } = {}) {
      const del = db.prepare(`DELETE FROM utterances WHERE meeting_id = ?`);
      const ins = db.prepare(
        `INSERT INTO utterances (meeting_id, user_id, display_name, start_ms, end_ms, text)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const setStatus = db.prepare(`UPDATE meetings SET status = 'awaiting_summary' WHERE id = ?`);
      const existingJob = db.prepare(
        `SELECT id FROM jobs WHERE meeting_id = ? AND type = 'summarize'
           AND status IN ('awaiting_approval', 'pending', 'running')`
      );
      const enqueue = db.prepare(
        `INSERT INTO jobs (meeting_id, type, status, next_attempt_at) VALUES (?, 'summarize', ?, datetime('now'))`
      );

      const tx = db.transaction((rows) => {
        del.run(meetingId);
        for (const u of rows) {
          ins.run(meetingId, u.userId, u.displayName, u.startMs, u.endMs, u.text);
        }
        setStatus.run(meetingId);
        // Don't stack a duplicate job if one is already waiting for this meeting.
        if (!existingJob.get(meetingId)) {
          enqueue.run(meetingId, requireApproval ? 'awaiting_approval' : 'pending');
        }
      });

      tx(utterances);
      return db
        .prepare(
          `SELECT id, status FROM jobs WHERE meeting_id = ? AND type = 'summarize'
             AND status IN ('awaiting_approval', 'pending', 'running')
           ORDER BY id DESC LIMIT 1`
        )
        .get(meetingId);
    },

    setTranscriptPath(meetingId, path) {
      db.prepare(`UPDATE meetings SET transcript_path = ? WHERE id = ?`).run(path, meetingId);
    },

    setSummary(meetingId, notesObj) {
      db.prepare(`UPDATE meetings SET summary_json = ?, status = 'done' WHERE id = ?`).run(
        JSON.stringify(notesObj),
        meetingId
      );
    },

    // --- job queue ---

    enqueueSummarizeJob(meetingId) {
      db.prepare(
        `INSERT INTO jobs (meeting_id, type, status, next_attempt_at) VALUES (?, 'summarize', 'pending', datetime('now'))`
      ).run(meetingId);
    },

    // "Do it now" for /summarise. Reuses the meeting's existing job (clearing
    // its backoff) instead of adding a second one — otherwise running
    // /summarise while a job was already waiting would queue a duplicate and
    // the session would be summarised, and posted to Discord, twice.
    requeueSummarizeNow(meetingId) {
      const existing = db
        .prepare(
          `SELECT id FROM jobs WHERE meeting_id = ? AND type = 'summarize'
             AND status IN ('awaiting_approval', 'pending', 'running')`
        )
        .get(meetingId);

      // Also the manual approval path: /summarise on a parked job releases it.
      if (existing) {
        db.prepare(`UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now') WHERE id = ?`).run(
          existing.id
        );
        return;
      }
      db.prepare(
        `INSERT INTO jobs (meeting_id, type, status, next_attempt_at) VALUES (?, 'summarize', 'pending', datetime('now'))`
      ).run(meetingId);
    },

    nextDueJob() {
      // next_attempt_at is stored in two different formats depending on how
      // the row was written: enqueueSummarizeJob uses SQLite's own
      // datetime('now') ("YYYY-MM-DD HH:MM:SS"), but rescheduleJob stores a
      // JS Date().toISOString() string ("YYYY-MM-DDTHH:MM:SS.sssZ"). A plain
      // string comparison against datetime('now') is wrong for the second
      // format: 'T' (0x54) sorts after a space (0x20), so an ISO string
      // always compares as "later" than datetime('now') regardless of the
      // actual time, and a rescheduled job would never come due again.
      // Wrapping both sides in datetime() normalizes either format before
      // comparing.
      return db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'pending' AND datetime(next_attempt_at) <= datetime('now') ORDER BY id ASC LIMIT 1`
        )
        .get();
    },

    markJobRunning(jobId) {
      db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(jobId);
    },

    markJobDone(jobId) {
      db.prepare(`UPDATE jobs SET status = 'done' WHERE id = ?`).run(jobId);
    },

    rescheduleJob(jobId, nextAttemptAtIso, error) {
      db.prepare(
        `UPDATE jobs SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?`
      ).run(nextAttemptAtIso, String(error).slice(0, 2000), jobId);
    },

    failJobPermanently(jobId, error) {
      db.prepare(`UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?`).run(
        String(error).slice(0, 2000),
        jobId
      );
    },

    getJob(jobId) {
      return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    },

    listPendingJobs() {
      return db
        .prepare(
          `SELECT * FROM jobs WHERE status IN ('awaiting_approval', 'pending', 'running')
           ORDER BY next_attempt_at ASC`
        )
        .all();
    },

    // Release a parked job so the worker can pick it up on its next tick.
    approveJob(jobId) {
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now')
            WHERE id = ? AND status = 'awaiting_approval'`
        )
        .run(jobId);
      return info.changes > 0;
    },

    approveAllWaiting() {
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now')
            WHERE status = 'awaiting_approval'`
        )
        .run();
      return info.changes;
    },

    // Everything currently moving through the pipeline, for /pending.
    listPipeline() {
      return db
        .prepare(
          `SELECT m.id, m.channel_name, m.started_at, m.status AS meeting_status,
                  j.id AS job_id, j.status AS job_status, j.attempts, j.next_attempt_at, j.last_error,
                  (SELECT COUNT(*) FROM utterances u WHERE u.meeting_id = m.id) AS utterance_count
             FROM meetings m
             LEFT JOIN jobs j
               ON j.meeting_id = m.id
              AND j.status IN ('awaiting_approval', 'pending', 'running')
            WHERE m.status != 'done'
               OR j.id IS NOT NULL
            ORDER BY m.id DESC`
        )
        .all();
    },

    // --- speech-to-text corrections ---

    addCorrection(guildId, wrongText, correctText) {
      db.prepare(
        `INSERT INTO corrections (guild_id, wrong_text, correct_text) VALUES (?, ?, ?)
         ON CONFLICT(guild_id, wrong_text) DO UPDATE SET correct_text = excluded.correct_text`
      ).run(guildId, wrongText, correctText);
    },

    listCorrections(guildId) {
      return db
        .prepare(`SELECT wrong_text, correct_text FROM corrections WHERE guild_id = ? ORDER BY id ASC`)
        .all(guildId);
    },

    removeCorrection(guildId, wrongText) {
      return db.prepare(`DELETE FROM corrections WHERE guild_id = ? AND wrong_text = ?`).run(guildId, wrongText).changes;
    },

    // Rewrites already-stored transcripts. Takes the replace function rather
    // than doing it in SQL because SQLite's REPLACE() is case-sensitive and
    // has no word-boundary support, so "vecks" wouldn't match "Vecks" and
    // correcting a short name would corrupt longer words containing it.
    rewriteUtterances(guildId, rewrite) {
      const rows = db
        .prepare(
          `SELECT u.id, u.text FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.guild_id = ?`
        )
        .all(guildId);

      const update = db.prepare(`UPDATE utterances SET text = ? WHERE id = ?`);
      let changed = 0;
      const tx = db.transaction(() => {
        for (const row of rows) {
          const next = rewrite(row.text);
          if (next !== row.text) {
            update.run(next, row.id);
            changed++;
          }
        }
      });
      tx();
      return changed;
    },

    // --- persistent operator settings ---

    getSetting(key, fallback = null) {
      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
      return row ? row.value : fallback;
    },

    setSetting(key, value) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(key, String(value));
    },

    // A job is flipped to 'running' while the worker processes it, but
    // nextDueJob only ever selects 'pending' — so if the process dies
    // mid-summarise (restart, power loss, OOM), that job stays 'running'
    // forever and is never retried. Reset them at startup; the job itself is
    // idempotent, so re-running one that had actually finished is harmless.
    resetStuckRunningJobs() {
      const info = db
        .prepare(`UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now') WHERE status = 'running'`)
        .run();
      return info.changes;
    },

    // Meetings that finished transcription but have no live job — strandable
    // by an ill-timed crash, or by a job that was failed permanently. Used at
    // startup to put them back in the queue rather than losing them silently.
    listMeetingsAwaitingSummaryWithoutJob() {
      return db
        .prepare(
          `SELECT * FROM meetings m
           WHERE m.status = 'awaiting_summary'
             AND NOT EXISTS (
               SELECT 1 FROM jobs j
               WHERE j.meeting_id = m.id
                 AND j.status IN ('awaiting_approval', 'pending', 'running')
             )`
        )
        .all();
    },

    // --- character name mapping ---

    setCharacterName(guildId, userId, characterName) {
      db.prepare(
        `INSERT INTO characters (guild_id, user_id, character_name) VALUES (?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET character_name = excluded.character_name`
      ).run(guildId, userId, characterName);
    },

    getCharacterName(guildId, userId) {
      const row = db
        .prepare(`SELECT character_name FROM characters WHERE guild_id = ? AND user_id = ?`)
        .get(guildId, userId);
      return row?.character_name || null;
    },

    listCharacters(guildId) {
      return db.prepare(`SELECT * FROM characters WHERE guild_id = ?`).all(guildId);
    },

    // --- most recent completed meeting, for /recap ---

    getLastCompletedMeeting(guildId) {
      return db
        .prepare(`SELECT * FROM meetings WHERE guild_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`)
        .get(guildId);
    },

    countUtterances(meetingId) {
      return db.prepare(`SELECT COUNT(*) AS n FROM utterances WHERE meeting_id = ?`).get(meetingId).n;
    },

    // --- full-text lookup across every transcript in the campaign (/search) ---

    searchUtterances(guildId, term, limit = 25) {
      // LIKE's own wildcards have to be neutralised or a search for "50%"
      // or "under_dark" would silently match far more than the user meant.
      const escaped = String(term).replace(/[\\%_]/g, (c) => `\\${c}`);
      return db
        .prepare(
          `SELECT u.text, u.display_name, u.start_ms,
                  m.id AS meeting_id, m.channel_name, m.started_at
             FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.guild_id = ?
              AND u.text LIKE ? ESCAPE '\\'
            ORDER BY m.started_at DESC, u.start_ms ASC
            LIMIT ?`
        )
        .all(guildId, `%${escaped}%`, limit);
    },

    // --- every completed meeting with a summary, for /funny to pull from ---

    listCompletedMeetings(guildId) {
      return db
        .prepare(`SELECT * FROM meetings WHERE guild_id = ? AND status = 'done' AND summary_json IS NOT NULL`)
        .all(guildId);
    },

    // --- orphaned session recovery (bot crashed/restarted mid-session) ---

    listInterruptedMeetings() {
      return db.prepare(`SELECT * FROM meetings WHERE status IN ('recording', 'transcribing')`).all();
    },

    // --- campaign-wide totals, for /stats ---

    campaignStats(guildId) {
      const meetings = db
        .prepare(`SELECT id, started_at, ended_at FROM meetings WHERE guild_id = ? AND status = 'done'`)
        .all(guildId);

      let totalMs = 0;
      let longest = null;
      for (const m of meetings) {
        if (!m.ended_at) continue;
        const ms = new Date(m.ended_at).getTime() - new Date(m.started_at).getTime();
        if (!Number.isFinite(ms) || ms <= 0) continue;
        totalMs += ms;
        if (!longest || ms > longest.ms) longest = { id: m.id, ms };
      }

      const totalLines = db
        .prepare(
          `SELECT COUNT(*) AS n FROM utterances u JOIN meetings m ON m.id = u.meeting_id
            WHERE m.guild_id = ? AND m.status = 'done'`
        )
        .get(guildId).n;

      // Ranked by lines rather than words — cheap to compute and a fair enough
      // proxy for "who talked the most" without tokenising every utterance.
      const talkative = db
        .prepare(
          `SELECT u.display_name, COUNT(*) AS lines
             FROM utterances u JOIN meetings m ON m.id = u.meeting_id
            WHERE m.guild_id = ? AND m.status = 'done'
            GROUP BY u.display_name
            ORDER BY lines DESC
            LIMIT 5`
        )
        .all(guildId);

      return {
        totalSessions: meetings.length,
        totalMs,
        totalLines,
        talkative,
        longestMeetingId: longest?.id ?? null,
        longestMs: longest?.ms ?? 0,
      };
    },
  };
}
