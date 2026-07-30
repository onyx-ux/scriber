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

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'summarize',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
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

    insertUtterances(meetingId, utterances) {
      const stmt = db.prepare(
        `INSERT INTO utterances (meeting_id, user_id, display_name, start_ms, end_ms, text)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const tx = db.transaction((rows) => {
        for (const u of rows) {
          stmt.run(meetingId, u.userId, u.displayName, u.startMs, u.endMs, u.text);
        }
      });
      tx(utterances);
    },

    listUtterances(meetingId) {
      return db
        .prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY start_ms ASC`)
        .all(meetingId);
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

    nextDueJob() {
      return db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'pending' AND next_attempt_at <= datetime('now') ORDER BY id ASC LIMIT 1`
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
        .prepare(`SELECT * FROM jobs WHERE status IN ('pending', 'running') ORDER BY next_attempt_at ASC`)
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

    // --- orphaned session recovery (bot crashed/restarted mid-session) ---

    listInterruptedMeetings() {
      return db.prepare(`SELECT * FROM meetings WHERE status IN ('recording', 'transcribing')`).all();
    },
  };
}
