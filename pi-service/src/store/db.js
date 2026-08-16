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
-- the summariser is currently reachable. queue-worker.js polls this table.
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- When the owner was last nudged about this job, so an un-actioned
  -- transcription becomes a daily reminder rather than a message per tick.
  notified_at TEXT,
  -- Which summariser to use for THIS job, overriding SUMMARY_PROVIDER.
  -- NULL means "whatever the config says at the time it runs" — the normal
  -- case. Set when a specific provider is chosen per-session (an approval
  -- button, or /summarise provider:...).
  provider TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_attempt_at);
`;

// CREATE TABLE IF NOT EXISTS won't add a column to a table that already
// exists, so an existing deployment's jobs table needs the new column added
// explicitly. Checked-then-added rather than blindly ALTERing, since
// re-running the ALTER on an already-migrated database errors.
function migrate(db) {
  const jobColumns = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  if (!jobColumns.includes('provider')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN provider TEXT`);
    console.log('[db] migrated: added jobs.provider');
  }
  if (!jobColumns.includes('notified_at')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN notified_at TEXT`);
    console.log('[db] migrated: added jobs.notified_at');
  }

  // Sessions are numbered PER CAMPAIGN, not by meeting id: the id is global
  // across every server the bot serves, so one table's second session was
  // being filed as "session 16".
  //
  // Stored rather than computed, deliberately. A number derived by counting
  // rows would change under its own notes: delete a meeting, or add one that
  // failed to transcribe, and every later session silently renumbers — while
  // the markdown files that were already exported, synced to Drive and
  // linked from the ledger keep the old numbers.
  const meetingColumns = db.prepare(`PRAGMA table_info(meetings)`).all().map((c) => c.name);
  if (!meetingColumns.includes('session_number')) {
    db.exec(`ALTER TABLE meetings ADD COLUMN session_number INTEGER`);
    // Backfill in id order within each guild, which is the order they happened.
    const guilds = db.prepare(`SELECT DISTINCT guild_id FROM meetings`).all();
    const assign = db.prepare(`UPDATE meetings SET session_number = ? WHERE id = ?`);
    for (const { guild_id: guildId } of guilds) {
      const rows = db.prepare(`SELECT id FROM meetings WHERE guild_id = ? ORDER BY id ASC`).all(guildId);
      rows.forEach((row, i) => assign.run(i + 1, row.id));
    }
    console.log(`[db] migrated: added meetings.session_number (backfilled ${guilds.length} campaign(s))`);
  }

  // Campaign display name (set with /campaign) and the session counter.
  // Keyed by guild so one bot can serve several tables; the guild id never
  // changes, unlike the channel name this used to be derived from.
  //
  // next_session is a high-water mark rather than MAX(session_number) + 1.
  // Deriving it from the meetings table means deleting a session hands its
  // number to the next one — and the note already exported under that name,
  // synced to Drive and linked from the ledger, is then silently overwritten.
  // A counter only ever goes up.
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT,
      next_session INTEGER NOT NULL DEFAULT 1,
      manager_user_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Who runs this campaign, as far as the bot is concerned.
  //
  // Deliberately NOT Discord's Manage Server permission. The person who runs
  // the game is often not the person who administers the server, and in a
  // server the bot was simply invited to, "can manage this Discord" and "is
  // the DM" have nothing to do with each other. Whoever names the campaign
  // claims it; see commands/index.js.
  const campaignColumns = db.prepare(`PRAGMA table_info(campaigns)`).all().map((c) => c.name);
  if (!campaignColumns.includes('manager_user_id')) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN manager_user_id TEXT`);
    console.log('[db] migrated: added campaigns.manager_user_id');
  }

  // A campaign becomes a thing in its own right, rather than a synonym for a
  // Discord server.
  //
  // One server commonly hosts two groups playing different games in different
  // voice channels, and guild_id as the primary key cannot express that. So
  // campaigns get an id, and a guild may hold several. SQLite cannot add a
  // primary key by ALTER, hence the copy-and-rename.
  //
  // Everything keyed on a guild keeps working throughout: a guild's DEFAULT
  // campaign is its oldest, which for every campaign that exists today is its
  // only one. Call sites move over to campaign ids behind that.
  if (!campaignColumns.includes('id')) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE campaigns_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          name TEXT,
          next_session INTEGER NOT NULL DEFAULT 1,
          manager_user_id TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO campaigns_new (guild_id, name, next_session, manager_user_id, updated_at)
             SELECT guild_id, name, next_session, manager_user_id, updated_at FROM campaigns;
        DROP TABLE campaigns;
        ALTER TABLE campaigns_new RENAME TO campaigns;
        CREATE INDEX IF NOT EXISTS idx_campaigns_guild ON campaigns(guild_id);
      `);
      db.exec('COMMIT');
      console.log('[db] migrated: campaigns now have their own id');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // A campaign row for any guild that has recorded sessions but was never
  // named. The counter starts past whatever already exists, so numbering
  // continues rather than restarting on an established campaign.
  //
  // No ON CONFLICT(guild_id): a guild may now hold several campaigns, so
  // guild_id is no longer unique and there is nothing to conflict on.
  db.exec(`
    INSERT INTO campaigns (guild_id, next_session)
    SELECT m.guild_id, COALESCE(MAX(m.session_number), 0) + 1
      FROM meetings m
     WHERE NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.guild_id = m.guild_id)
     GROUP BY m.guild_id
  `);

  const meetingCols = db.prepare(`PRAGMA table_info(meetings)`).all().map((c) => c.name);
  if (!meetingCols.includes('campaign_id')) {
    db.exec(`ALTER TABLE meetings ADD COLUMN campaign_id INTEGER`);
    const filled = db
      .prepare(
        `UPDATE meetings
            SET campaign_id = (SELECT MIN(c.id) FROM campaigns c WHERE c.guild_id = meetings.guild_id)
          WHERE campaign_id IS NULL`
      )
      .run().changes;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_campaign ON meetings(campaign_id)`);
    console.log(`[db] migrated: added meetings.campaign_id (${filled} session(s) assigned)`);
  }

  // Who is at the table. Membership is what /join checks, so that a stranger
  // in a public server cannot start a recording of somebody else's game.
  //
  // The manager adds people (setting a character enrols them); everyone the
  // bot has already recorded is grandfathered in below, since they plainly
  // belong to the campaign they have been speaking in.
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_members (
      campaign_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, user_id)
    )
  `);

  const grandfathered = db
    .prepare(
      `INSERT INTO campaign_members (campaign_id, user_id, added_by)
       SELECT DISTINCT m.campaign_id, u.user_id, 'grandfathered'
         FROM utterances u
         JOIN meetings m ON m.id = u.meeting_id
        WHERE m.campaign_id IS NOT NULL
       ON CONFLICT(campaign_id, user_id) DO NOTHING`
    )
    .run().changes;
  if (grandfathered) console.log(`[db] ${grandfathered} existing speaker(s) enrolled in their campaign`);

  // The manager runs the campaign, so they are a member of it by definition —
  // including before they have ever spoken in one.
  db.exec(`
    INSERT INTO campaign_members (campaign_id, user_id, added_by)
    SELECT id, manager_user_id, 'manager' FROM campaigns WHERE manager_user_id IS NOT NULL
    ON CONFLICT(campaign_id, user_id) DO NOTHING
  `);
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return wrap(db);
}

function wrap(db) {
  // A guild's DEFAULT campaign — its oldest, which for every campaign that
  // exists today is its only one. Guild-keyed methods resolve through here so
  // they keep working while the campaign id spreads through the call sites.
  //
  // Creates one if the guild has none, because /join has to be able to record
  // a server's first session before anybody has named the campaign.
  const defaultCampaignId = db.transaction((guildId) => {
    const row = db.prepare(`SELECT MIN(id) AS id FROM campaigns WHERE guild_id = ?`).get(guildId);
    if (row?.id) return row.id;
    return db.prepare(`INSERT INTO campaigns (guild_id) VALUES (?)`).run(guildId).lastInsertRowid;
  });

  return {
    raw: db,

    close() {
      db.close();
    },

    createMeeting: db.transaction(({ guildId, campaignId = null, channelId, channelName, startedAt, audioDir }) => {
      // Take the next number from the campaign's counter and advance it. The
      // counter never goes backwards, so a deleted session's number is never
      // handed out again — see the note on the campaigns table.
      const id = campaignId ?? defaultCampaignId(guildId);
      const { next_session: sessionNumber } = db
        .prepare(`SELECT next_session FROM campaigns WHERE id = ?`)
        .get(id);
      db.prepare(`UPDATE campaigns SET next_session = next_session + 1 WHERE id = ?`).run(id);

      const info = db
        .prepare(
          `INSERT INTO meetings (guild_id, campaign_id, channel_id, channel_name, started_at, audio_dir, status, session_number)
           VALUES (?, ?, ?, ?, ?, ?, 'recording', ?)`
        )
        .run(guildId, id, channelId, channelName, startedAt, audioDir, sessionNumber);
      return info.lastInsertRowid;
    }),

    // --- campaign names ---

    setCampaignName(guildId, name) {
      // Must not reset next_session — the row may already exist because
      // sessions have been recorded, and clobbering the counter would restart
      // numbering over notes that already exist.
      db.prepare(`UPDATE campaigns SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(
        name,
        defaultCampaignId(guildId)
      );
    },

    getCampaignName(guildId) {
      return db.prepare(`SELECT name FROM campaigns WHERE guild_id = ?`).get(guildId)?.name ?? null;
    },

    getCampaignManager(guildId) {
      return (
        db.prepare(`SELECT manager_user_id FROM campaigns WHERE guild_id = ?`).get(guildId)?.manager_user_id ?? null
      );
    },

    // Claims an UNMANAGED campaign for a user, and returns who holds it
    // afterwards. Whoever names a campaign first becomes its manager; a
    // campaign that already has one is left alone, so this can be called on
    // every /campaign without a separate "is it claimed?" round trip racing
    // against itself.
    claimCampaign: db.transaction((guildId, userId) => {
      const id = defaultCampaignId(guildId);
      db.prepare(
        `UPDATE campaigns SET manager_user_id = COALESCE(manager_user_id, ?), updated_at = datetime('now') WHERE id = ?`
      ).run(userId, id);
      const manager = db.prepare(`SELECT manager_user_id FROM campaigns WHERE id = ?`).get(id).manager_user_id;
      // The manager is a member of their own campaign by definition, before
      // they have ever spoken in it.
      db.prepare(
        `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'manager')
         ON CONFLICT(campaign_id, user_id) DO NOTHING`
      ).run(id, manager);
      return manager;
    }),

    // Handing a campaign over, and the backfill that gives existing campaigns
    // a manager on first boot after the column was added.
    setCampaignManager(guildId, userId) {
      db.prepare(`UPDATE campaigns SET manager_user_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        userId,
        defaultCampaignId(guildId)
      );
    },

    // --- campaign identity and membership ---

    defaultCampaignId(guildId) {
      return defaultCampaignId(guildId);
    },

    listCampaignsInGuild(guildId) {
      return db.prepare(`SELECT * FROM campaigns WHERE guild_id = ? ORDER BY id`).all(guildId);
    },

    getCampaign(campaignId) {
      return db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(campaignId) ?? null;
    },

    createCampaign(guildId, name, managerUserId) {
      const id = db
        .prepare(`INSERT INTO campaigns (guild_id, name, manager_user_id) VALUES (?, ?, ?)`)
        .run(guildId, name, managerUserId).lastInsertRowid;
      db.prepare(`INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'manager')`).run(
        id,
        managerUserId
      );
      return id;
    },

    addCampaignMember(campaignId, userId, addedBy = null) {
      return db
        .prepare(
          `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, ?)
           ON CONFLICT(campaign_id, user_id) DO NOTHING`
        )
        .run(campaignId, userId, addedBy).changes;
    },

    removeCampaignMember(campaignId, userId) {
      return db
        .prepare(`DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?`)
        .run(campaignId, userId).changes;
    },

    isCampaignMember(campaignId, userId) {
      return Boolean(
        db.prepare(`SELECT 1 FROM campaign_members WHERE campaign_id = ? AND user_id = ?`).get(campaignId, userId)
      );
    },

    listCampaignMembers(campaignId) {
      return db.prepare(`SELECT * FROM campaign_members WHERE campaign_id = ? ORDER BY added_at`).all(campaignId);
    },

    // What /join offers: the campaigns this person is actually at the table
    // for. Not the same as listCampaignsForUser, which is participation
    // (has spoken) and answers a different question — a player added to a
    // brand new campaign belongs to it before they have said a word.
    listCampaignsForMember(userId) {
      return db
        .prepare(
          `SELECT c.*
             FROM campaign_members cm
             JOIN campaigns c ON c.id = cm.campaign_id
            WHERE cm.user_id = ?
            ORDER BY c.guild_id, c.id`
        )
        .all(userId);
    },

    adoptUnmanagedCampaigns(userId) {
      return db
        .prepare(`UPDATE campaigns SET manager_user_id = ? WHERE manager_user_id IS NULL`)
        .run(userId).changes;
    },

    // Campaigns the bot has actually recorded, so /campaign can offer them by
    // name in a DM — where there is no guild to infer one from.
    listCampaigns() {
      return db
        .prepare(
          `SELECT m.guild_id,
                  MAX(m.channel_name) AS channel_name,
                  c.name AS campaign_name,
                  COUNT(*) AS sessions
             FROM meetings m
             LEFT JOIN campaigns c ON c.guild_id = m.guild_id
            GROUP BY m.guild_id
            ORDER BY MAX(m.id) DESC`
        )
        .all();
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
    // provider pins which summariser this meeting's job must use, for when
    // the choice was made at /leave rather than left to the global default —
    // e.g. a one-off /summarise that must not use the configured default.
    // null keeps the existing behaviour of deferring to the config at run time.
    finalizeTranscription(meetingId, utterances, { requireApproval = false, provider = null } = {}) {
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
        `INSERT INTO jobs (meeting_id, type, status, provider, next_attempt_at)
         VALUES (?, 'summarize', ?, ?, datetime('now'))`
      );

      const tx = db.transaction((rows) => {
        del.run(meetingId);
        for (const u of rows) {
          ins.run(meetingId, u.userId, u.displayName, u.startMs, u.endMs, u.text);
        }
        setStatus.run(meetingId);
        // Don't stack a duplicate job if one is already waiting for this meeting.
        if (!existingJob.get(meetingId)) {
          enqueue.run(meetingId, requireApproval ? 'awaiting_approval' : 'pending', provider);
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
    //
    // provider: null leaves whatever the job already had (so re-running
    // /summarise without naming one doesn't silently wipe an earlier choice).
    requeueSummarizeNow(meetingId, provider = null) {
      const existing = db
        .prepare(
          `SELECT id FROM jobs WHERE meeting_id = ? AND type = 'summarize'
             AND status IN ('awaiting_approval', 'pending', 'running')`
        )
        .get(meetingId);

      // Also the manual approval path: /summarise on a parked job releases it.
      if (existing) {
        db.prepare(
          `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now'),
                           provider = COALESCE(?, provider)
            WHERE id = ?`
        ).run(provider, existing.id);
        return;
      }
      db.prepare(
        `INSERT INTO jobs (meeting_id, type, status, next_attempt_at, provider)
         VALUES (?, 'summarize', 'pending', datetime('now'), ?)`
      ).run(meetingId, provider);
    },

    // --- transcription scheduling ---
    //
    // A transcribe job is deliberately allowed to sit in one of two live
    // states, unlike a summarise job:
    //   awaiting_approval — waiting for the owner OR for the automatic
    //                       window; the worker may start it on its own.
    //   pending           — the owner said go; run as soon as the PC answers.
    // Snoozing keeps the status and pushes next_attempt_at forward, so
    // "remind me tomorrow" suppresses the automatic window too.
    enqueueTranscribeJob(meetingId, { requireApproval = true } = {}) {
      const existing = db
        .prepare(
          `SELECT * FROM jobs WHERE meeting_id = ? AND type = 'transcribe'
             AND status IN ('awaiting_approval', 'pending', 'running')`
        )
        .get(meetingId);
      if (existing) return existing;

      const info = db
        .prepare(
          `INSERT INTO jobs (meeting_id, type, status, next_attempt_at)
           VALUES (?, 'transcribe', ?, datetime('now'))`
        )
        .run(meetingId, requireApproval ? 'awaiting_approval' : 'pending');
      return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(info.lastInsertRowid);
    },

    // Both live states are returned; the caller decides whether an
    // awaiting_approval job may start, since that depends on the clock.
    dueTranscribeJobs() {
      return db
        .prepare(
          `SELECT * FROM jobs
             WHERE type = 'transcribe' AND status IN ('awaiting_approval', 'pending')
             ORDER BY id ASC`
        )
        .all();
    },

    getTranscribeJobForMeeting(meetingId) {
      return db
        .prepare(
          `SELECT * FROM jobs WHERE meeting_id = ? AND type = 'transcribe'
             ORDER BY id DESC LIMIT 1`
        )
        .get(meetingId);
    },

    approveTranscribeNow(jobId) {
      db.prepare(
        `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now')
          WHERE id = ? AND type = 'transcribe'`
      ).run(jobId);
    },

    snoozeTranscribeJob(jobId, untilIso) {
      db.prepare(
        `UPDATE jobs SET status = 'awaiting_approval', next_attempt_at = ?, notified_at = ?
          WHERE id = ? AND type = 'transcribe'`
      ).run(untilIso, new Date().toISOString(), jobId);
    },

    markJobNotified(jobId, whenIso = new Date().toISOString()) {
      db.prepare(`UPDATE jobs SET notified_at = ? WHERE id = ?`).run(whenIso, jobId);
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
      // type = 'summarize' is load-bearing, not decoration: transcribe jobs
      // live in this same table, and without the filter the summarise worker
      // would claim one and try to summarise a meeting that has no transcript
      // yet.
      return db
        .prepare(
          `SELECT * FROM jobs
             WHERE type = 'summarize' AND status = 'pending'
               AND datetime(next_attempt_at) <= datetime('now')
             ORDER BY id ASC LIMIT 1`
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
    // provider: null keeps whatever the job already had (normally nothing,
    // meaning "use the configured default").
    approveJob(jobId, provider = null) {
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now'),
                           provider = COALESCE(?, provider)
            WHERE id = ? AND status = 'awaiting_approval'`
        )
        .run(provider, jobId);
      return info.changes > 0;
    },

    approveAllWaiting(provider = null) {
      const info = db
        .prepare(
          `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now'),
                           provider = COALESCE(?, provider)
            WHERE status = 'awaiting_approval'`
        )
        .run(provider);
      return info.changes;
    },

    // Everything currently moving through the pipeline, for /pending.
    listPipeline() {
      return db
        .prepare(
          `SELECT m.id, m.channel_name, m.started_at, m.status AS meeting_status,
                  j.id AS job_id, j.status AS job_status, j.type AS job_type,
                  j.attempts, j.next_attempt_at, j.last_error,
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
    //
    // Transcribe jobs are reset to 'awaiting_approval' rather than 'pending',
    // because for those two states 'pending' means "the owner said yes". A
    // crash at 15:59 followed by a restart at 21:00 would otherwise come back
    // pre-approved and take the GPU immediately, which is the exact thing the
    // schedule exists to prevent — recovery.js queues interrupted meetings
    // for the same reason. Clearing notified_at means the owner is told about
    // it on the next tick instead of waiting out the old reminder window.
    resetStuckRunningJobs() {
      const summarize = db
        .prepare(
          `UPDATE jobs SET status = 'pending', next_attempt_at = datetime('now')
            WHERE status = 'running' AND type != 'transcribe'`
        )
        .run();
      const transcribe = db
        .prepare(
          `UPDATE jobs SET status = 'awaiting_approval', next_attempt_at = datetime('now'), notified_at = NULL
            WHERE status = 'running' AND type = 'transcribe'`
        )
        .run();
      return summarize.changes + transcribe.changes;
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

    // The campaigns a given person has actually spoken in.
    //
    // This is the membership check behind the user-installed commands: anyone
    // can add a user-installed app to their own Discord account, so having
    // spoken at the table is what distinguishes a player from a stranger who
    // knows the campaign's name.
    listCampaignsForUser(userId) {
      return db
        .prepare(
          `SELECT m.guild_id,
                  MAX(m.channel_name)  AS channel_name,
                  c.name               AS campaign_name,
                  MAX(m.started_at)    AS last_seen
             FROM utterances u
             JOIN meetings m   ON m.id = u.meeting_id
             LEFT JOIN campaigns c ON c.guild_id = m.guild_id
            WHERE u.user_id = ?
            GROUP BY m.guild_id
            ORDER BY last_seen DESC`
        )
        .all(userId);
    },

    // Every label this campaign's transcripts have ever carried, including
    // ones nobody uses any more. listRoster deliberately collapses to the
    // CURRENT name — that is what a DM should be picking from — but a summary
    // of an old session is reading a transcript labelled with the old one, so
    // "who is a player" has to span the whole history.
    listSpeakerNames(guildId) {
      return db
        .prepare(
          `SELECT DISTINCT u.display_name AS displayName
             FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.guild_id = ?`
        )
        .all(guildId)
        .map((r) => r.displayName)
        .filter(Boolean);
    },

    forgetCharacterName(guildId, userId) {
      return db.prepare(`DELETE FROM characters WHERE guild_id = ? AND user_id = ?`).run(guildId, userId).changes;
    },

    // Everyone the bot has actually heard in this campaign, with whatever
    // character name is on file for them.
    //
    // The characters table alone is not enough to offer a roster: it only has
    // rows for players who have already been named, and the whole point of
    // the roster command is to name the ones who have not. The utterances are
    // the only record of who is at this table, so they are the source of the
    // list and the characters table is a left join onto it.
    //
    // Latest display name wins: someone who changes their Discord nickname
    // mid-campaign should appear under the name they use now, not the one
    // they had in session 1.
    listRoster(guildId) {
      return db
        .prepare(
          `SELECT u.user_id AS userId,
                  (SELECT u2.display_name
                     FROM utterances u2
                     JOIN meetings m2 ON m2.id = u2.meeting_id
                    WHERE m2.guild_id = @guildId AND u2.user_id = u.user_id
                    ORDER BY u2.id DESC
                    LIMIT 1)             AS displayName,
                  c.character_name       AS characterName,
                  COUNT(*)               AS lines
             FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
             LEFT JOIN characters c
                    ON c.guild_id = m.guild_id AND c.user_id = u.user_id
            WHERE m.guild_id = @guildId
            GROUP BY u.user_id
            ORDER BY lines DESC`
        )
        .all({ guildId });
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
