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

-- Who plays what, per CAMPAIGN rather than per server: one Discord can host
-- two tables, and the same person may play in both under different names.
CREATE TABLE IF NOT EXISTS characters (
  campaign_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  character_name TEXT NOT NULL,
  PRIMARY KEY (campaign_id, user_id)
);

-- Per-campaign speech-to-text corrections. Columns are *_text rather than
-- "wrong"/"right" because RIGHT is a SQL keyword (RIGHT JOIN) in newer SQLite.
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  wrong_text TEXT NOT NULL,
  correct_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, wrong_text)
);

-- The job queue is what makes "PC is sometimes off" safe: a summarize job
-- is enqueued the moment transcription finishes, independent of whether
-- the summariser is currently reachable. queue-worker.js polls this table.

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

-- Signing in to the dashboard.
--
-- There is no password column here and there never will be one. You sign in
-- with Discord: Discord asks you, Discord checks you, and this bot is handed a
-- user id — which is exactly as strong as "you control that Discord account",
-- and that is the only identity this bot has ever cared about.
--
-- One table, where there used to be two. The other held six-digit codes the
-- bot DMed out, and it went with the flow that needed them: nothing is typed
-- any more, so there is nothing to hold for ten minutes and count wrong
-- guesses against. The DROP is deliberate rather than a tidy-up — a table of
-- live credentials for a flow that no longer exists is the worst kind of dead
-- code, because it still works.
--
-- This table stores nothing a leak would make worse: a Discord id and the
-- username attached to it, both of which are public in any server you are in.
-- No email, no real name, no password, and no OAuth token — the one Discord
-- issues is spent on a single question and revoked. See web/discord-oauth.js.
DROP TABLE IF EXISTS auth_codes;

CREATE TABLE IF NOT EXISTS auth_sessions (
  -- The HMAC of the cookie, so the row cannot be turned back into a session.
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- What the operator has said about a person, as opposed to what is true of
-- them.
--
-- Everything else about a viewer is derived: what their Discord account owns,
-- runs and plays in decides what they see, so nothing is administered and
-- nothing drifts out of step with reality. This table is the one place an
-- opinion is recorded, and it holds exactly two of them.
--
--   invited  may this account open a session at all. Nothing more -- being on
--            the list shows you nothing you would not otherwise see.
--
--   tier     how much of the owner's GPU and API bill they may spend, 1 to 4.
--            The one opinion here that goes UP as well as down, because
--            unlike a level it answers a question no fact in the world
--            answers: what the person paying is willing to pay. See
--            access/tiers.js.
--
--   cap      a CEILING on the level they resolve to, never a floor. It can
--            take an owner down to a player; it cannot make a player anything.
--            That asymmetry is not squeamishness, it is what the levels are:
--            "owner" means Discord says you own a server and "player"
--            means you actually spoke at a table, and this bot cannot make
--            either true by writing a row. What it can always do is show
--            somebody less than they have earned.
--
-- A row may hold any of the three, or all of them. Clearing them all deletes
-- the row, so an empty table means the operator has never had an opinion about
-- anybody -- the state every install starts in and the state most stay in.
CREATE TABLE IF NOT EXISTS dashboard_access (
  user_id TEXT PRIMARY KEY,
  -- A name to show beside the id, captured when the row was written. Only ever
  -- decoration: nothing is matched on it, because names change and ids do not.
  username TEXT,
  invited INTEGER NOT NULL DEFAULT 0,
  -- The operator's one opinion about somebody's level, in two columns because
  -- they are two different facts and the row has to be able to say which.
  --
  -- cap holds this person below what they have earned; granted holds them
  -- above it. Only ever one at a time — the control that writes them is a single
  -- dropdown, and access/level clears the other whichever way it is pointed.
  --
  -- Two columns rather than one signed opinion because "held down from owner"
  -- and "raised to creator" want different words on the page, and working out
  -- which a single column meant would need the derived level fetched first,
  -- every time anybody read a row.
  --
  -- A GRANT DOES NOT WIDEN SCOPE, and that is the property that keeps
  -- web/viewer.js honest. It changes how much machinery is on screen for the
  -- campaigns somebody already has a claim on. Which campaigns those are stays
  -- the union of three checkable facts, so granting creator to somebody who
  -- runs nothing gives them a creator's controls over nothing. The way to make
  -- somebody run a campaign is to hand them one — see campaign/handover.js.
  cap TEXT,
  granted TEXT,
  -- NULL means "whatever DEFAULT_TIER says", not tier 1. Storing the default
  -- would freeze today's answer into every row and quietly ignore the setting
  -- the next time it changed.
  tier INTEGER,
  set_by TEXT,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT,
  -- When this person asked to be let in, if they ever did. A row with this set
  -- and invited = 0 is somebody waiting at the door: Discord vouched for them,
  -- the guest list did not, and they pressed the button rather than leaving.
  --
  -- Separate from "invited" rather than a third state of it, because the two
  -- answer different questions and both can be true. Admitting somebody who
  -- asked should not erase the fact that they asked, or the date -- that is the
  -- only record of how long they waited.
  requested_at TEXT
);

-- Asking for a deleted campaign back.
--
-- Restoring is not the requester's decision, because deleting was not
-- everybody's. A campaign belongs to whoever runs it, but the sessions in it
-- belong to everyone who sat at the table, and a table that was deleted in a
-- temper should not be restorable by the same temper an hour later. So the
-- answers are recorded and the operator decides, one at a time.
CREATE TABLE IF NOT EXISTS restore_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  requester_name TEXT,
  -- The three answers, kept verbatim. They are the whole point of the ticket:
  -- a request with no reasoning is a button, and a button is what this replaced.
  reason TEXT NOT NULL,
  why_deleted TEXT,
  taking_ownership TEXT,
  -- pending | approved | denied
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_restore_requests_state ON restore_requests(state, created_at);

-- What the models have actually cost.
--
-- Neither provider will tell you how much of your allowance is left: Anthropic
-- reports it in a response header, Google reports nothing at all. So the only
-- way to answer "how close am I" is to count every call as it happens, which
-- is what this is.
--
-- One row per attempt, including the failures — a call that was refused for
-- quota is exactly the event worth seeing, and it costs nothing to store.
CREATE TABLE IF NOT EXISTS model_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Kept alongside the timestamp so a day's total is an index lookup rather than a
  -- scan with date arithmetic on every dashboard poll.
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  meeting_id INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Not input + output on the flash models: the difference is thinking, which
  -- is billed, and which is the whole reason /ask moved to a lite model.
  total_tokens INTEGER NOT NULL DEFAULT 0,
  ms INTEGER,
  -- ok | rate_limited | failed
  outcome TEXT NOT NULL DEFAULT 'ok',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_usage_day ON model_usage(day, model);

-- How many questions each person has asked today.
--
-- Kept apart from model_usage on purpose. That table is a cost record shown on
-- a dashboard; this one is about a named player, and in a bot whose whole
-- posture is that people's data stays where it belongs, "who asked what" does
-- not belong in the billing view. A count and a date, and the row is dropped
-- when the day rolls over.
CREATE TABLE IF NOT EXISTS ask_quota (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  asks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
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

  // Run on every boot, not just the once. Every read is keyed on campaign_id
  // now, so a meeting that somehow has none is not merely untidy — it is
  // invisible to /recap, /history, /stats, the archive and the ledger, while
  // still sitting in the database looking fine. Cheap to check, and the guild
  // always tells us which campaign it belonged to.
  const adopted = db
    .prepare(
      `UPDATE meetings
          SET campaign_id = (SELECT MIN(c.id) FROM campaigns c WHERE c.guild_id = meetings.guild_id)
        WHERE campaign_id IS NULL`
    )
    .run().changes;
  if (adopted) console.log(`[db] ${adopted} session(s) with no campaign adopted by their server's oldest`);

  // The roster and the correction list move off the guild and onto the
  // campaign, which is the last thing standing between one server and two
  // tables. Both are keyed by guild in their primary key / unique constraint,
  // and SQLite cannot alter either — hence the copy-and-rename, same as
  // campaigns above.
  //
  // Sharing them across a server was never right, only harmless while a guild
  // held one campaign: two tables in one Discord would otherwise share a
  // roster, so naming your paladin in one game renames you in the other, and
  // a /correct for one campaign's NPC rewrites the other's transcripts.
  const accessCols = db.prepare(`PRAGMA table_info(dashboard_access)`).all().map((c) => c.name);
  if (accessCols.length && !accessCols.includes('requested_at')) {
    db.prepare(`ALTER TABLE dashboard_access ADD COLUMN requested_at TEXT`).run();
    console.log('[db] migrated: added dashboard_access.requested_at');
  }
  // The Level column could only ever take somebody down. Existing `cap` rows
  // keep meaning exactly what they meant — the new column starts empty, so an
  // install that never grants anybody anything behaves as it did yesterday.
  if (accessCols.length && !accessCols.includes('granted')) {
    db.prepare(`ALTER TABLE dashboard_access ADD COLUMN granted TEXT`).run();
    console.log('[db] migrated: added dashboard_access.granted');
  }

  const charCols = db.prepare(`PRAGMA table_info(characters)`).all().map((c) => c.name);
  const corrCols = db.prepare(`PRAGMA table_info(corrections)`).all().map((c) => c.name);

  if (!charCols.includes('campaign_id') || !corrCols.includes('campaign_id')) {
    // A guild can appear in these tables and nowhere else — a table that set
    // its roster up before recording anything. The backfill above only made
    // campaigns for guilds with meetings, so without this those rows would
    // re-key onto a NULL campaign and vanish.
    const orphanSources = [
      charCols.includes('guild_id') ? `SELECT guild_id FROM characters` : null,
      corrCols.includes('guild_id') ? `SELECT guild_id FROM corrections` : null,
    ].filter(Boolean);

    if (orphanSources.length) {
      db.exec(`
        INSERT INTO campaigns (guild_id)
        SELECT guild_id FROM (${orphanSources.join(' UNION ')}) g
         WHERE g.guild_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.guild_id = g.guild_id)
      `);
    }

    db.exec('BEGIN');
    try {
      if (!charCols.includes('campaign_id')) {
        db.exec(`
          CREATE TABLE characters_new (
            campaign_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            character_name TEXT NOT NULL,
            PRIMARY KEY (campaign_id, user_id)
          );
          INSERT INTO characters_new (campaign_id, user_id, character_name)
               SELECT (SELECT MIN(c.id) FROM campaigns c WHERE c.guild_id = ch.guild_id),
                      ch.user_id, ch.character_name
                 FROM characters ch
                WHERE EXISTS (SELECT 1 FROM campaigns c WHERE c.guild_id = ch.guild_id);
          DROP TABLE characters;
          ALTER TABLE characters_new RENAME TO characters;
        `);
      }

      if (!corrCols.includes('campaign_id')) {
        db.exec(`
          CREATE TABLE corrections_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL,
            wrong_text TEXT NOT NULL,
            correct_text TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (campaign_id, wrong_text)
          );
          INSERT INTO corrections_new (campaign_id, wrong_text, correct_text, created_at)
               SELECT (SELECT MIN(c.id) FROM campaigns c WHERE c.guild_id = co.guild_id),
                      co.wrong_text, co.correct_text, co.created_at
                 FROM corrections co
                WHERE EXISTS (SELECT 1 FROM campaigns c WHERE c.guild_id = co.guild_id);
          DROP TABLE corrections;
          ALTER TABLE corrections_new RENAME TO corrections;
        `);
      }
      db.exec('COMMIT');
      console.log('[db] migrated: rosters and corrections are now per-campaign');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Where a campaign's finished notes go, chosen by whoever runs it.
  //
  // NOTES_TO_OWNER_DM / NOTES_CHANNEL_ID set this for the whole bot, which is
  // one setting for every table it serves. A campaign that wants its recaps
  // in #session-notes and another that wants them DM'd to its DM cannot both
  // be expressed that way, so the choice belongs on the campaign.
  // Deleting a campaign, with thirty days to change your mind.
  //
  // A campaign holds every session anybody ever recorded at that table, so
  // erasing it on the spot is the one irreversible act in this whole bot that
  // somebody might perform while angry. It is archived instead: invisible
  // immediately, restorable until the window closes.
  if (!campaignColumns.includes('archived_at')) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN archived_at TEXT`);
    db.exec(`ALTER TABLE campaigns ADD COLUMN archived_by TEXT`);
    console.log('[db] migrated: added campaigns.archived_at / archived_by');
  }

  if (!campaignColumns.includes('output_mode')) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN output_mode TEXT`);
    db.exec(`ALTER TABLE campaigns ADD COLUMN output_channel_id TEXT`);
    console.log('[db] migrated: added campaigns.output_mode / output_channel_id');
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

  // Whether the bot may record a given person in a given campaign.
  //
  // Separate from membership on purpose. Membership answers "may you start a
  // session" — consent answers "may your voice be captured", and only the
  // person themselves can give that. Keeping them apart means a DM adding
  // someone to the roster cannot also decide, on their behalf, that they agree
  // to be recorded.
  //
  // Per campaign rather than per account: agreeing to be recorded at one table
  // is not agreeing at every table you are ever invited to.
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_consent (
      campaign_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      -- pending | granted | declined | expired
      state TEXT NOT NULL,
      invited_by TEXT,
      invited_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      decided_at TEXT,
      PRIMARY KEY (campaign_id, user_id)
    )
  `);

  // Everyone already at a table when consent arrived keeps being recorded.
  // They have been playing on the old understanding and asking them to
  // re-consent mid-campaign would stop a running game dead; the ask applies
  // from here on. Written as an explicit row rather than an implicit "no row
  // means yes", so the rule is visible in the data rather than in code.
  // ONCE, on the first boot after consent arrived — never again.
  //
  // Running it every boot looks harmless (ON CONFLICT DO NOTHING protects
  // anyone who has answered) and is not. Membership and consent are separate,
  // so a member can legitimately have no consent row: setCharacterName enrols
  // someone, and /campaign invite creates the row only when it is delivered.
  // Every restart would then read "member, no answer on file" as "grandfather
  // them" and grant consent nobody gave — turning a restart into a way to be
  // opted in.
  //
  // Seen for real: a declined row was removed, the process reopened the
  // database, and the decline came back as 'granted'.
  const alreadyCarried = db.prepare(`SELECT value FROM settings WHERE key = 'consent_grandfathered'`).get();
  if (!alreadyCarried) {
    const carried = db
      .prepare(
        // WHERE true is not decoration: in an INSERT ... SELECT, SQLite cannot
        // tell an upsert clause from part of the SELECT without one, and errors
        // with "near DO: syntax error".
        `INSERT INTO campaign_consent (campaign_id, user_id, state, invited_by, decided_at)
         SELECT campaign_id, user_id, 'granted', 'grandfathered', datetime('now')
           FROM campaign_members
          WHERE true
         ON CONFLICT(campaign_id, user_id) DO NOTHING`
      )
      .run().changes;
    db.prepare(`INSERT INTO settings (key, value) VALUES ('consent_grandfathered', datetime('now'))`).run();
    if (carried) console.log(`[db] ${carried} existing player(s) carried over as already agreeing to be recorded`);
  }

  // The manager runs the campaign, so they are a member of it by definition —
  // including before they have ever spoken in one.
  db.exec(`
    INSERT INTO campaign_members (campaign_id, user_id, added_by)
    SELECT id, manager_user_id, 'manager' FROM campaigns WHERE manager_user_id IS NOT NULL
    ON CONFLICT(campaign_id, user_id) DO NOTHING
  `);
}

// One shape for a campaign wherever it is read, so the display code never has
// to care which query produced the row.
//
// channel_name and sessions are derived rather than stored: a campaign that
// nobody has named is shown by the channel it last recorded in, and a campaign
// with no sessions at all still has to appear — it is brand new and needs
// setting up, which is precisely when it must be selectable.
const CAMPAIGN_COLUMNS = `
  SELECT c.*,
         (SELECT m.channel_name FROM meetings m
           WHERE m.campaign_id = c.id ORDER BY m.id DESC LIMIT 1)  AS channel_name,
         (SELECT COUNT(*)      FROM meetings m WHERE m.campaign_id = c.id) AS sessions,
         (SELECT MAX(m.started_at) FROM meetings m WHERE m.campaign_id = c.id) AS last_session_at
    FROM campaigns c`;

// An archived campaign is invisible everywhere, and that is enforced here
// rather than at the call sites. There are five listing methods and about
// forty callers between them; a filter each one has to remember is a filter
// one of them will forget, and the failure mode is a deleted campaign showing
// up in a picker.
//
// Every query below therefore continues the WHERE with AND rather than
// starting one. CAMPAIGN_VIEW_ALL is for the two places that must see through
// the archive: restoring, and checking a new name against folders that still
// exist on disk.
const CAMPAIGN_VIEW = `${CAMPAIGN_COLUMNS} WHERE c.archived_at IS NULL`;
const CAMPAIGN_VIEW_ALL = `${CAMPAIGN_COLUMNS} WHERE 1 = 1`;

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
    //
    // Everything below takes a CAMPAIGN id. It used to take a guild id, back
    // when those were the same thing; they are not, and a guild that holds two
    // campaigns would have had both of them answer to the first one's records.

    setCampaignName(campaignId, name) {
      // Must not reset next_session — the row may already exist because
      // sessions have been recorded, and clobbering the counter would restart
      // numbering over notes that already exist.
      db.prepare(`UPDATE campaigns SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(name, campaignId);
    },

    getCampaignName(campaignId) {
      return db.prepare(`SELECT name FROM campaigns WHERE id = ?`).get(campaignId)?.name ?? null;
    },

    getCampaignManager(campaignId) {
      return db.prepare(`SELECT manager_user_id FROM campaigns WHERE id = ?`).get(campaignId)?.manager_user_id ?? null;
    },

    // Claims an UNMANAGED campaign for a user, and returns who holds it
    // afterwards. Whoever names a campaign first becomes its manager; a
    // campaign that already has one is left alone, so this can be called on
    // every /campaign without a separate "is it claimed?" round trip racing
    // against itself.
    claimCampaign: db.transaction((campaignId, userId) => {
      db.prepare(
        `UPDATE campaigns SET manager_user_id = COALESCE(manager_user_id, ?), updated_at = datetime('now') WHERE id = ?`
      ).run(userId, campaignId);
      const manager = db.prepare(`SELECT manager_user_id FROM campaigns WHERE id = ?`).get(campaignId)?.manager_user_id;
      // The manager is a member of their own campaign by definition, before
      // they have ever spoken in it.
      if (manager) {
        db.prepare(
          `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'manager')
           ON CONFLICT(campaign_id, user_id) DO NOTHING`
        ).run(campaignId, manager);
      }
      return manager ?? null;
    }),

    // Handing a campaign over, and the backfill that gives existing campaigns
    // a manager on first boot after the column was added.
    setCampaignManager: db.transaction((campaignId, userId) => {
      db.prepare(`UPDATE campaigns SET manager_user_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        userId,
        campaignId
      );
      db.prepare(
        `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'manager')
         ON CONFLICT(campaign_id, user_id) DO NOTHING`
      ).run(campaignId, userId);
    }),

    // mode is 'dm' (to the campaign's manager) or 'channel'. A null mode
    // means "whatever the bot is configured to do", which is where every
    // campaign starts.
    setCampaignOutput(campaignId, mode, channelId = null) {
      db.prepare(
        `UPDATE campaigns SET output_mode = ?, output_channel_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(mode, channelId, campaignId);
    },

    // Looked up from a MEETING, because that is what the delivery code has in
    // hand when a session finishes.
    getOutputForMeeting(meetingId) {
      return (
        db
          .prepare(
            `SELECT c.output_mode AS mode, c.output_channel_id AS channelId, c.manager_user_id AS managerUserId
               FROM meetings m
               JOIN campaigns c ON c.id = m.campaign_id
              WHERE m.id = ?`
          )
          .get(meetingId) ?? null
      );
    },

    // --- campaign identity and membership ---

    listCampaignsInGuild(guildId) {
      return db.prepare(`${CAMPAIGN_VIEW} AND c.guild_id = ? ORDER BY c.id`).all(guildId);
    },

    getCampaign(campaignId) {
      return db.prepare(`${CAMPAIGN_VIEW} AND c.id = ?`).get(campaignId) ?? null;
    },

    createCampaign: db.transaction((guildId, name, managerUserId) => {
      const id = db
        .prepare(`INSERT INTO campaigns (guild_id, name, manager_user_id) VALUES (?, ?, ?)`)
        .run(guildId, name, managerUserId).lastInsertRowid;
      if (managerUserId) {
        db.prepare(`INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'manager')`).run(
          id,
          managerUserId
        );
      }
      return id;
    }),

    countCampaignsInGuild(guildId) {
      return db.prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE guild_id = ?`).get(guildId).n;
    },

    countCampaignsManagedBy(userId) {
      return db.prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE manager_user_id = ?`).get(userId).n;
    },

    isCampaignMember(campaignId, userId) {
      return Boolean(
        db.prepare(`SELECT 1 FROM campaign_members WHERE campaign_id = ? AND user_id = ?`).get(campaignId, userId)
      );
    },

    // What /join offers: the campaigns this person is actually at the table
    // for. Not the same as listCampaignsForUser, which is participation
    // (has spoken) and answers a different question — a player added to a
    // brand new campaign belongs to it before they have said a word.
    // Everyone this bot knows, for the access page.
    //
    // Access is not one list. Somebody can reach this bot because they were
    // added to a table, because they run one, because they have signed in, or
    // simply because they once spoke while it was recording. All of those are
    // access, so all of them are here: a page showing only live sessions would
    // answer "who is signed in", which is a smaller and much less useful
    // question than "who could sign in".
    listKnownPeople() {
      return db
        .prepare(
          `WITH people(user_id) AS (
             SELECT user_id FROM campaign_members
             UNION SELECT manager_user_id FROM campaigns WHERE manager_user_id IS NOT NULL
             UNION SELECT user_id FROM campaign_consent
             UNION SELECT user_id FROM auth_sessions
             UNION SELECT user_id FROM utterances
             -- Somebody admitted this morning who has not signed in yet is
             -- the person most worth seeing on the access page, not the one
             -- to leave off it for lack of history. Same for anybody the
             -- operator has capped: a ceiling on a person who then vanishes
             -- from the page is a ceiling nobody can lift.
             UNION SELECT user_id FROM dashboard_access
           )
           SELECT p.user_id AS userId,
             COALESCE(
               (SELECT s.username FROM auth_sessions s WHERE s.user_id = p.user_id
                 ORDER BY s.created_at DESC LIMIT 1),
               (SELECT u.display_name FROM utterances u WHERE u.user_id = p.user_id
                 ORDER BY u.id DESC LIMIT 1),
               (SELECT a.username FROM dashboard_access a WHERE a.user_id = p.user_id)
             ) AS name,
             (SELECT COUNT(*) FROM auth_sessions s
               WHERE s.user_id = p.user_id AND s.expires_at > datetime('now')) AS sessions,
             (SELECT MAX(COALESCE(s.last_seen_at, s.created_at)) FROM auth_sessions s
               WHERE s.user_id = p.user_id) AS lastSeen,
             (SELECT COUNT(*) FROM utterances u WHERE u.user_id = p.user_id) AS lines
           FROM people p
           WHERE p.user_id IS NOT NULL AND p.user_id <> ''`
        )
        .all();
    },

    listCampaignsForMember(userId) {
      return db
        .prepare(
          `${CAMPAIGN_VIEW}
            AND EXISTS (SELECT 1 FROM campaign_members cm
                         WHERE cm.campaign_id = c.id AND cm.user_id = ?)
            ORDER BY c.guild_id, c.id`
        )
        .all(userId);
    },

    // --- consent to be recorded ---

    inviteToCampaign: db.transaction((campaignId, userId, invitedBy, expiresAt) => {
      // Re-inviting someone who already declined is allowed — people change
      // their minds, and a DM should be able to ask again after talking to
      // them. It resets to pending rather than silently granting.
      db.prepare(
        `INSERT INTO campaign_consent (campaign_id, user_id, state, invited_by, invited_at, expires_at, decided_at)
         VALUES (?, ?, 'pending', ?, datetime('now'), ?, NULL)
         ON CONFLICT(campaign_id, user_id) DO UPDATE SET
           state = 'pending', invited_by = excluded.invited_by,
           invited_at = excluded.invited_at, expires_at = excluded.expires_at, decided_at = NULL`
      ).run(campaignId, userId, invitedBy, expiresAt);
    }),

    getConsent(campaignId, userId) {
      return (
        db.prepare(`SELECT * FROM campaign_consent WHERE campaign_id = ? AND user_id = ?`).get(campaignId, userId) ??
        null
      );
    },

    // Returns the row as it stands after the decision, or null if there was no
    // live invite to decide on — expired, withdrawn, or never sent.
    decideConsent: db.transaction((campaignId, userId, granted, nowIso = new Date().toISOString()) => {
      const row = db
        .prepare(`SELECT * FROM campaign_consent WHERE campaign_id = ? AND user_id = ?`)
        .get(campaignId, userId);
      if (!row) return null;
      if (row.state === 'pending' && row.expires_at && row.expires_at <= nowIso) {
        db.prepare(`UPDATE campaign_consent SET state = 'expired' WHERE campaign_id = ? AND user_id = ?`).run(
          campaignId,
          userId
        );
        return { ...row, state: 'expired' };
      }
      db.prepare(
        `UPDATE campaign_consent SET state = ?, decided_at = ? WHERE campaign_id = ? AND user_id = ?`
      ).run(granted ? 'granted' : 'declined', nowIso, campaignId, userId);

      // Agreeing puts you at the table; declining does not throw you off it,
      // because being on the roster is not the same as being recorded.
      if (granted) {
        db.prepare(
          `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'accepted')
           ON CONFLICT(campaign_id, user_id) DO NOTHING`
        ).run(campaignId, userId);
      }
      return { ...row, state: granted ? 'granted' : 'declined' };
    }),

    // The person deciding for themselves, unprompted.
    //
    // decideConsent answers an invitation, so it refuses when there is no live
    // one — which is right for a button in a DM and wrong for /campaign
    // consent, where the two people who most need it are someone who already
    // accepted and is taking it back, and someone who was never asked and wants
    // to settle it now. Neither has an open invite.
    //
    // Deliberately a separate method rather than a flag on decideConsent: this
    // one is only ever called with the caller's OWN user id, and keeping it
    // apart makes a future change that breaks that rule obvious.
    setConsent: db.transaction((campaignId, userId, granted, nowIso = new Date().toISOString()) => {
      db.prepare(
        `INSERT INTO campaign_consent (campaign_id, user_id, state, invited_at, decided_at)
         VALUES (?, ?, ?, datetime('now'), ?)
         ON CONFLICT(campaign_id, user_id) DO UPDATE SET
           state = excluded.state, decided_at = excluded.decided_at, expires_at = NULL`
      ).run(campaignId, userId, granted ? 'granted' : 'declined', nowIso);

      // Same rule as decideConsent: agreeing puts you at the table, declining
      // does not throw you off it. Being on the roster is not being recorded,
      // and quietly un-enrolling someone would take away their /recap too.
      if (granted) {
        db.prepare(
          `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'self')
           ON CONFLICT(campaign_id, user_id) DO NOTHING`
        ).run(campaignId, userId);
      }
      return db.prepare(`SELECT * FROM campaign_consent WHERE campaign_id = ? AND user_id = ?`).get(campaignId, userId);
    }),

    // The one question the capture path asks, and the only state that answers
    // yes. Absent, pending, declined and expired all mean "do not record" —
    // silence is not agreement.
    mayRecord(campaignId, userId) {
      const row = db
        .prepare(`SELECT state FROM campaign_consent WHERE campaign_id = ? AND user_id = ?`)
        .get(campaignId, userId);
      return row?.state === 'granted';
    },

    listConsent(campaignId) {
      return db.prepare(`SELECT * FROM campaign_consent WHERE campaign_id = ?`).all(campaignId);
    },

    // An invite nobody answered stops being an invite. Swept on a timer and
    // checked again when a button is pressed, so a stale DM sitting in
    // somebody's inbox for a week cannot still be acted on.
    expireStaleInvites(nowIso = new Date().toISOString()) {
      return db
        .prepare(
          `UPDATE campaign_consent SET state = 'expired'
            WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
        )
        .run(nowIso).changes;
    },

    // Withdrawing an invitation, or a player being taken off the table
    // entirely. Removes the consent record too: if they are asked again later
    // it should be a fresh question, not a resumed one.
    removeFromCampaign: db.transaction((campaignId, userId) => {
      const members = db
        .prepare(`DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?`)
        .run(campaignId, userId).changes;
      const consent = db
        .prepare(`DELETE FROM campaign_consent WHERE campaign_id = ? AND user_id = ?`)
        .run(campaignId, userId).changes;
      db.prepare(`DELETE FROM characters WHERE campaign_id = ? AND user_id = ?`).run(campaignId, userId);
      return members + consent;
    }),

    adoptUnmanagedCampaigns(userId) {
      return db
        .prepare(`UPDATE campaigns SET manager_user_id = ? WHERE manager_user_id IS NULL`)
        .run(userId).changes;
    },

    // Every campaign the bot knows, so /campaign can offer them by name in a
    // DM — where there is no guild to infer one from.
    //
    // Driven from the campaigns table, not from meetings. It used to be the
    // other way round, which meant a campaign only existed once it had been
    // recorded — so a freshly created one could not be named, claimed or
    // picked from any autocomplete until after its first session, which is
    // exactly when you need to set it up.
    //
    // channel_name is the last channel it recorded in, kept only as the
    // display fallback for a campaign nobody has named yet.
    // Sees through the archive. Only two callers should: restoring something,
    // and checking whether a new name would collide with a folder that still
    // exists on disk because the campaign that owns it is only archived.
    listCampaignsIncludingArchived() {
      return db.prepare(`${CAMPAIGN_VIEW_ALL} ORDER BY c.guild_id, c.id`).all();
    },

    getCampaignIncludingArchived(campaignId) {
      return db.prepare(`${CAMPAIGN_VIEW_ALL} AND c.id = ?`).get(campaignId) ?? null;
    },

    listArchivedCampaigns({ userId = null, since = null } = {}) {
      const clauses = ['c.archived_at IS NOT NULL'];
      const args = [];
      if (userId) { clauses.push('c.manager_user_id = ?'); args.push(userId); }
      if (since) { clauses.push('c.archived_at >= ?'); args.push(since); }
      return db
        .prepare(`${CAMPAIGN_VIEW_ALL} AND ${clauses.join(' AND ')} ORDER BY c.archived_at DESC`)
        .all(...args);
    },

    // --- asking for one back ---

    createRestoreRequest({ campaignId, requestedBy, requesterName = null, reason, whyDeleted = null, takingOwnership = null }) {
      return db
        .prepare(
          `INSERT INTO restore_requests
             (campaign_id, requested_by, requester_name, reason, why_deleted, taking_ownership)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(campaignId, requestedBy, requesterName, reason, whyDeleted, takingOwnership).lastInsertRowid;
    },

    getRestoreRequest(id) {
      return db.prepare(`SELECT * FROM restore_requests WHERE id = ?`).get(id) ?? null;
    },

    // One open ticket per person per campaign. Without this, somebody told
    // "no" can simply ask again, which is the pestering the review exists to
    // slow down.
    pendingRestoreRequest(campaignId, requestedBy) {
      return db
        .prepare(
          `SELECT * FROM restore_requests
            WHERE campaign_id = ? AND requested_by = ? AND state = 'pending'`
        )
        .get(campaignId, requestedBy) ?? null;
    },

    listRestoreRequests({ state = 'pending' } = {}) {
      const rows = state
        ? db.prepare(`SELECT * FROM restore_requests WHERE state = ? ORDER BY created_at`).all(state)
        : db.prepare(`SELECT * FROM restore_requests ORDER BY created_at DESC`).all();
      return rows;
    },

    decideRestoreRequest(id, { state, decidedBy, note = null, at = new Date().toISOString() }) {
      return db
        .prepare(
          `UPDATE restore_requests
              SET state = ?, decided_by = ?, decision_note = ?, decided_at = ?
            WHERE id = ? AND state = 'pending'`
        )
        .run(state, decidedBy ?? null, note, at, id).changes;
    },
    archiveCampaign(campaignId, archivedBy, at = new Date().toISOString()) {
      return db
        .prepare(`UPDATE campaigns SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL`)
        .run(at, archivedBy ?? null, campaignId).changes;
    },

    restoreCampaign(campaignId) {
      return db
        .prepare(`UPDATE campaigns SET archived_at = NULL, archived_by = NULL WHERE id = ? AND archived_at IS NOT NULL`)
        .run(campaignId).changes;
    },

    listCampaigns() {
      return db.prepare(`${CAMPAIGN_VIEW} ORDER BY c.guild_id, c.id`).all();
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

    listRecentMeetings(campaignId, limit = 10) {
      return db
        .prepare(`SELECT * FROM meetings WHERE campaign_id = ? ORDER BY started_at DESC LIMIT ?`)
        .all(campaignId, limit);
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

      // Anyone who spoke in a recorded session plainly belongs to that
      // campaign, so speaking enrols you. Without this, membership only ever
      // grew by the DM naming someone: a player who joined the table after the
      // roster was created could be recorded all evening and still be refused
      // by /join, since /join checks membership rather than participation.
      const enrol = db.prepare(
        `INSERT INTO campaign_members (campaign_id, user_id, added_by)
         SELECT m.campaign_id, ?, 'spoke' FROM meetings m
          WHERE m.id = ? AND m.campaign_id IS NOT NULL
         ON CONFLICT(campaign_id, user_id) DO NOTHING`
      );

      const tx = db.transaction((rows) => {
        del.run(meetingId);
        for (const u of rows) {
          ins.run(meetingId, u.userId, u.displayName, u.startMs, u.endMs, u.text);
        }
        // 'imported' is the synthetic speaker every line of an /import is
        // attributed to, not a Discord account — enrolling it would put a
        // non-existent user on the roster.
        for (const userId of new Set(rows.map((u) => u.userId))) {
          if (userId && userId !== 'imported') enrol.run(userId, meetingId);
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

    // Throw away a meeting that never produced a transcript, and the jobs
    // that keep retrying it.
    //
    // The NOT EXISTS is the safety, and it lives in the SQL rather than in the
    // caller on purpose: checking "is it empty?" and then deleting are two
    // statements, and a transcription finishing between them would delete a
    // real session. Here the emptiness is part of the delete's own WHERE, so
    // there is no gap to lose a session in.
    //
    // Returns 0 when the meeting was not empty, so the caller can say so.
    discardEmptyMeeting: db.transaction((meetingId) => {
      const gone = db
        .prepare(
          `DELETE FROM meetings
            WHERE id = ?
              AND NOT EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = meetings.id)`
        )
        .run(meetingId).changes;
      if (gone) db.prepare(`DELETE FROM jobs WHERE meeting_id = ?`).run(meetingId);
      return gone;
    }),

    listPendingJobs() {
      return db
        .prepare(
          `SELECT * FROM jobs WHERE status IN ('awaiting_approval', 'pending', 'running')
           ORDER BY next_attempt_at ASC`
        )
        .all();
    },

    // The most recent job of any status for one meeting.
    //
    // listPendingJobs deliberately excludes finished and permanently-failed
    // jobs, which is right for the queue but wrong for the one screen that
    // exists to explain a failure: by the time a session reads 'failed', the
    // job carrying the reason has left the pending set, and the dashboard was
    // left saying a session had failed with no way to say why.
    lastJobForMeeting(meetingId) {
      return db.prepare(`SELECT * FROM jobs WHERE meeting_id = ? ORDER BY id DESC LIMIT 1`).get(meetingId) ?? null;
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

    addCorrection(campaignId, wrongText, correctText) {
      db.prepare(
        `INSERT INTO corrections (campaign_id, wrong_text, correct_text) VALUES (?, ?, ?)
         ON CONFLICT(campaign_id, wrong_text) DO UPDATE SET correct_text = excluded.correct_text`
      ).run(campaignId, wrongText, correctText);
    },

    listCorrections(campaignId) {
      return db
        .prepare(`SELECT wrong_text, correct_text FROM corrections WHERE campaign_id = ? ORDER BY id ASC`)
        .all(campaignId);
    },

    removeCorrection(campaignId, wrongText) {
      return db.prepare(`DELETE FROM corrections WHERE campaign_id = ? AND wrong_text = ?`).run(campaignId, wrongText)
        .changes;
    },

    // How many stored lines contain a piece of text.
    //
    // Used by the dashboard to say how much of the campaign a correction is
    // actually holding up. It counts the CORRECT text, not the wrong one:
    // corrections are applied as the transcript is written and replayed over
    // everything already on disk, so by the time you are looking at the list
    // the misheard spelling is gone. "Kaelen appears on 184 lines" is a fact
    // about the transcripts; "Kaylen was fixed 184 times" is not recorded
    // anywhere and would have to be invented.
    countUtterancesContaining(campaignId, text) {
      const needle = String(text ?? '');
      if (!needle) return 0;
      // LIKE's own wildcards have to be neutralised, or a correction whose
      // text contains % or _ would match far more than it should.
      const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ? AND u.text LIKE ? ESCAPE '\\'`
        )
        .get(campaignId, `%${escaped}%`).n;
    },

    // How many lines a rewrite WOULD change, without changing any.
    //
    // The rewrite is not reversible — once "a" has become "b" there is no
    // telling which "b" used to be an "a" — so the only safe moment to learn
    // how big a correction is, is before applying it. Same iteration as
    // rewriteUtterances, minus the UPDATE.
    countRewrites(campaignId, rewrite) {
      const rows = db
        .prepare(
          `SELECT u.text FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ?`
        )
        .all(campaignId);

      let n = 0;
      for (const row of rows) if (rewrite(row.text) !== row.text) n += 1;
      return n;
    },

    countUtterancesIn(campaignId) {
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ?`
        )
        .get(campaignId).n;
    },

    // Rewrites already-stored transcripts. Takes the replace function rather
    // than doing it in SQL because SQLite's REPLACE() is case-sensitive and
    // has no word-boundary support, so "vecks" wouldn't match "Vecks" and
    // correcting a short name would corrupt longer words containing it.
    rewriteUtterances(campaignId, rewrite) {
      const rows = db
        .prepare(
          `SELECT u.id, u.text FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ?`
        )
        .all(campaignId);

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

    // --- signing in to the dashboard ---
    //
    // Deliberately dumb storage. Every decision about what a session MEANS
    // lives in web/auth.js; this only writes rows and deletes them, so there is
    // one place to read to know how sign-in works.

    openAuthSession(tokenHash, userId, username, expiresAt) {
      db.prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, username, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(tokenHash, userId, username, expiresAt);
    },

    getAuthSession(tokenHash) {
      return db.prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`).get(tokenHash) ?? null;
    },

    touchAuthSession(tokenHash) {
      db.prepare(`UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE token_hash = ?`).run(tokenHash);
    },

    closeAuthSession(tokenHash) {
      return db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash).changes;
    },

    // Signing out everywhere. Offered because the honest answer to "I think
    // somebody else has my session" is to end all of them, not to guess which.
    closeAllAuthSessions(userId) {
      return db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId).changes;
    },

    // Expired rows are not merely ignored, they are deleted: a table of dead
    // sessions is a table of things that could come back if a clock moved.
    sweepAuth(nowIso = new Date().toISOString()) {
      const sessions = db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(nowIso).changes;
      return { sessions };
    },

    // --- what the operator has said about a person ---
    //
    // Storage only. Whether an invited id may actually sign in is maySignIn's
    // question and whether a cap bites is buildViewer's; both weigh this
    // against things it knows nothing about. See web/authority.js.

    listAccessRows() {
      return db
        .prepare(
          `SELECT user_id AS userId, username, invited, cap, granted, tier,
                  set_by AS setBy, set_at AS setAt, note,
                  requested_at AS requestedAt
             FROM dashboard_access ORDER BY set_at DESC, user_id`
        )
        .all()
        .map((r) => ({ ...r, invited: Boolean(r.invited) }));
    },

    // One row per person holding both opinions, so setting either has to leave
    // the other alone. Writing the whole row would mean admitting somebody
    // silently lifted the ceiling you put on them last week.
    setInvited(userId, { username = null, setBy = null, note = null } = {}) {
      db.prepare(
        `INSERT INTO dashboard_access (user_id, username, invited, set_by, note)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           invited = 1,
           username = COALESCE(excluded.username, dashboard_access.username),
           note = COALESCE(excluded.note, dashboard_access.note)`
      ).run(String(userId), username, setBy, note);
    },

    // Setting either half of the level opinion clears the other. The control
    // is one dropdown with one answer, and a row holding a floor of `creator`
    // and a ceiling of `player` would be two answers that cannot both be
    // obeyed — buildViewer would silently pick one and the page would show the
    // other.
    setCap(userId, cap, { username = null, setBy = null } = {}) {
      db.prepare(
        `INSERT INTO dashboard_access (user_id, username, cap, granted, set_by)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           cap = excluded.cap,
           granted = NULL,
           username = COALESCE(excluded.username, dashboard_access.username),
           set_by = excluded.set_by`
      ).run(String(userId), username, cap === null ? null : String(cap), setBy);
      this.tidyAccess(userId);
    },

    setGrant(userId, granted, { username = null, setBy = null } = {}) {
      db.prepare(
        `INSERT INTO dashboard_access (user_id, username, granted, cap, set_by)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           granted = excluded.granted,
           cap = NULL,
           username = COALESCE(excluded.username, dashboard_access.username),
           set_by = excluded.set_by`
      ).run(String(userId), username, granted === null ? null : String(granted), setBy);
      this.tidyAccess(userId);
    },

    setTier(userId, tier, { username = null, setBy = null } = {}) {
      db.prepare(
        `INSERT INTO dashboard_access (user_id, username, tier, set_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           tier = excluded.tier,
           username = COALESCE(excluded.username, dashboard_access.username),
           set_by = excluded.set_by`
      ).run(String(userId), username, tier === null ? null : Number(tier), setBy);
      this.tidyAccess(userId);
    },

    tierOf(userId) {
      return (
        db.prepare(`SELECT tier FROM dashboard_access WHERE user_id = ?`).get(String(userId))?.tier
        ?? null
      );
    },

    clearInvited(userId) {
      const changed = db
        .prepare(`UPDATE dashboard_access SET invited = 0 WHERE user_id = ? AND invited = 1`)
        .run(String(userId)).changes;
      this.tidyAccess(userId);
      return changed;
    },

    // A row saying nothing is not a record of a decision, it is litter -- and
    // litter here is worse than elsewhere, because listKnownPeople treats any
    // row as "the operator has an opinion about this person" and puts them on
    // the page for ever.
    tidyAccess(userId) {
      db.prepare(
        `DELETE FROM dashboard_access
          WHERE user_id = ?
            AND invited = 0 AND cap IS NULL AND granted IS NULL AND tier IS NULL
            AND requested_at IS NULL`
      ).run(String(userId));
    },

    isInvited(userId) {
      return Boolean(
        db.prepare(`SELECT 1 FROM dashboard_access WHERE user_id = ? AND invited = 1`)
          .get(String(userId))
      );
    },

    capFor(userId) {
      return (
        db.prepare(`SELECT cap FROM dashboard_access WHERE user_id = ?`).get(String(userId))?.cap
        ?? null
      );
    },

    grantFor(userId) {
      return (
        db.prepare(`SELECT granted FROM dashboard_access WHERE user_id = ?`).get(String(userId))?.granted
        ?? null
      );
    },

    countInvited() {
      return db.prepare(`SELECT COUNT(*) AS n FROM dashboard_access WHERE invited = 1`).get().n;
    },

    // --- people waiting at the door ---

    // Somebody who got as far as Discord, came back, and was turned away.
    //
    // The timestamp is only written the FIRST time. Somebody who tries again
    // next week is still somebody who asked last week, and refreshing the date
    // on every attempt would turn the queue into a list sorted by impatience.
    // The name is refreshed, because names change and the newer one is the one
    // that will be recognised.
    recordRequest(userId, { username = null } = {}) {
      db.prepare(
        `INSERT INTO dashboard_access (user_id, username, invited, requested_at)
         VALUES (?, ?, 0, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           username = COALESCE(excluded.username, dashboard_access.username),
           requested_at = COALESCE(dashboard_access.requested_at, excluded.requested_at)`
      ).run(String(userId), username);
      return this.requestFor(userId);
    },

    requestFor(userId) {
      return (
        db.prepare(
          `SELECT user_id AS userId, username, requested_at AS requestedAt, invited
             FROM dashboard_access WHERE user_id = ? AND requested_at IS NOT NULL`
        ).get(String(userId)) ?? null
      );
    },

    // Still waiting: they asked, and nobody has let them in. Oldest first,
    // because a queue that puts the newest arrival on top is not a queue.
    listRequests() {
      return db
        .prepare(
          `SELECT user_id AS userId, username, requested_at AS requestedAt
             FROM dashboard_access
            WHERE requested_at IS NOT NULL AND invited = 0
            ORDER BY requested_at`
        )
        .all();
    },

    countRequests() {
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM dashboard_access
            WHERE requested_at IS NOT NULL AND invited = 0`
        ).get().n;
    },

    // "No thank you" -- clears the ask without admitting them, and lets
    // tidyAccess remove the row entirely if it now says nothing. They can ask
    // again; this is a decision about a queue, not a ban.
    dismissRequest(userId) {
      const changed = db
        .prepare(
          `UPDATE dashboard_access SET requested_at = NULL
            WHERE user_id = ? AND requested_at IS NOT NULL`
        ).run(String(userId)).changes;
      this.tidyAccess(userId);
      return changed;
    },

    // --- what the models have cost ---

    recordModelUsage({ provider, model, role, meetingId = null, inputTokens = 0, outputTokens = 0,
                       totalTokens = 0, ms = null, outcome = 'ok', error = null } = {}) {
      db.prepare(
        `INSERT INTO model_usage
           (day, provider, model, role, meeting_id, input_tokens, output_tokens, total_tokens, ms, outcome, error)
         VALUES (date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(provider), String(model), String(role), meetingId,
        inputTokens | 0, outputTokens | 0, totalTokens | 0, ms == null ? null : ms | 0,
        String(outcome), error ? String(error).slice(0, 300) : null
      );
    },

    // Per model, for the last N days. Grouped in SQL rather than in JavaScript
    // because this is read on a dashboard poll and the table only grows.
    modelUsage(days = 7) {
      return db
        .prepare(
          `SELECT model, provider, role,
                  COUNT(*)                                     AS calls,
                  SUM(outcome = 'ok')                          AS ok,
                  SUM(outcome = 'rate_limited')                AS limited,
                  SUM(outcome = 'failed')                      AS failed,
                  SUM(input_tokens)                            AS input_tokens,
                  SUM(output_tokens)                           AS output_tokens,
                  SUM(total_tokens)                            AS total_tokens,
                  MAX(at)                                      AS last_at
             FROM model_usage
            WHERE day >= date('now', ?)
            GROUP BY model, provider, role
            ORDER BY total_tokens DESC`
        )
        .all(`-${Math.max(0, days | 0)} days`);
    },

    // Today alone, which is the number that matters against a daily ceiling.
    modelUsageToday() {
      return db
        .prepare(
          `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
                  COUNT(*)                       AS calls,
                  SUM(outcome = 'rate_limited')  AS limited
             FROM model_usage WHERE day = date('now')`
        )
        .get();
    },

    // A sparkline's worth of history: one row per day, oldest first.
    modelUsageByDay(days = 14) {
      return db
        .prepare(
          `SELECT day, SUM(total_tokens) AS tokens, COUNT(*) AS calls
             FROM model_usage
            WHERE day >= date('now', ?)
            GROUP BY day ORDER BY day ASC`
        )
        .all(`-${Math.max(0, days | 0)} days`);
    },

    // How many questions one person has asked today.
    //
    // Its own table rather than a user_id column on model_usage, deliberately.
    // model_usage is a cost record and is shown on a dashboard; who asked what
    // is personal data about a player, and this bot's whole posture is that
    // those two things stay apart. This holds a count and a date, nothing else,
    // and the row is dropped when the day rolls over.
    countAsksToday(userId) {
      return (
        db.prepare(`SELECT asks FROM ask_quota WHERE user_id = ? AND day = date('now')`).get(userId)?.asks ?? 0
      );
    },

    // Counted BEFORE the model is called, so a question that fails still costs
    // the asker a slot. Otherwise a failing model is an unlimited one.
    countAsk: db.transaction((userId) => {
      db.prepare(
        `INSERT INTO ask_quota (user_id, day, asks) VALUES (?, date('now'), 1)
         ON CONFLICT(user_id, day) DO UPDATE SET asks = asks + 1`
      ).run(userId);
      db.prepare(`DELETE FROM ask_quota WHERE day < date('now')`).run();
      return db.prepare(`SELECT asks FROM ask_quota WHERE user_id = ? AND day = date('now')`).get(userId).asks;
    }),

    // Old rows are noise: the dashboard shows a fortnight and nothing reads
    // further back. Swept with the auth tables, on the hourly timer in
    // web/server.js — which this comment claimed for a long time before it was
    // true of anything, so the table grew without limit.
    pruneModelUsage(days = 90) {
      return db.prepare(`DELETE FROM model_usage WHERE day < date('now', ?)`).run(`-${Math.max(1, days | 0)} days`)
        .changes;
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

    // Naming someone enrols them. Setting a character name is how a DM says
    // "this person is at my table", and the two were separate steps before:
    // the message said /dm character adds you to the roster, and it did not,
    // so a named player was still refused by /join.
    setCharacterName: db.transaction((campaignId, userId, characterName) => {
      db.prepare(
        `INSERT INTO characters (campaign_id, user_id, character_name) VALUES (?, ?, ?)
         ON CONFLICT(campaign_id, user_id) DO UPDATE SET character_name = excluded.character_name`
      ).run(campaignId, userId, characterName);
      db.prepare(
        `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, 'character')
         ON CONFLICT(campaign_id, user_id) DO NOTHING`
      ).run(campaignId, userId);
    }),

    getCharacterName(campaignId, userId) {
      const row = db
        .prepare(`SELECT character_name FROM characters WHERE campaign_id = ? AND user_id = ?`)
        .get(campaignId, userId);
      return row?.character_name || null;
    },

    listCharacters(campaignId) {
      return db.prepare(`SELECT * FROM characters WHERE campaign_id = ?`).all(campaignId);
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
          `${CAMPAIGN_VIEW}
            AND EXISTS (SELECT 1 FROM utterances u
                          JOIN meetings m ON m.id = u.meeting_id
                         WHERE m.campaign_id = c.id AND u.user_id = ?)
            ORDER BY last_session_at DESC`
        )
        .all(userId);
    },

    // Every label this campaign's transcripts have ever carried, including
    // ones nobody uses any more. listRoster deliberately collapses to the
    // CURRENT name — that is what a DM should be picking from — but a summary
    // of an old session is reading a transcript labelled with the old one, so
    // "who is a player" has to span the whole history.
    listSpeakerNames(campaignId) {
      return db
        .prepare(
          `SELECT DISTINCT u.display_name AS displayName
             FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ?`
        )
        .all(campaignId)
        .map((r) => r.displayName)
        .filter(Boolean);
    },

    // Clears the character name but leaves them on the roster: forgetting what
    // someone's paladin is called is not the same as throwing them out of the
    // campaign, and conflating the two would silently revoke their /join.
    forgetCharacterName(campaignId, userId) {
      return db.prepare(`DELETE FROM characters WHERE campaign_id = ? AND user_id = ?`).run(campaignId, userId).changes;
    },

    // Who is at this table, with whatever character name is on file.
    //
    // Three sources, unioned, because each one alone has a hole:
    //   * campaign_members — everyone the DM has enrolled, including players
    //     who have not spoken yet. This is what /join checks.
    //   * characters — someone named before their first session.
    //   * utterances — everyone the bot has actually heard, which is the only
    //     record of a player who turned up and was never enrolled.
    //
    // It used to be the utterances alone, which meant a brand new campaign's
    // roster was empty until its first recording — so the DM could not set the
    // table up before playing, which is the one time they most want to.
    //
    // Latest display name wins: someone who changes their Discord nickname
    // mid-campaign should appear under the name they use now, not the one
    // they had in session 1. A member who has never spoken has no display name
    // here at all; the caller resolves it from Discord.
    listRoster(campaignId) {
      return db
        .prepare(
          `WITH people AS (
             SELECT user_id FROM campaign_members WHERE campaign_id = @campaignId
             UNION
             SELECT user_id FROM characters WHERE campaign_id = @campaignId
             UNION
             SELECT u.user_id FROM utterances u
               JOIN meetings m ON m.id = u.meeting_id
              WHERE m.campaign_id = @campaignId
           )
           SELECT p.user_id AS userId,
                  (SELECT u2.display_name
                     FROM utterances u2
                     JOIN meetings m2 ON m2.id = u2.meeting_id
                    WHERE m2.campaign_id = @campaignId AND u2.user_id = p.user_id
                    ORDER BY u2.id DESC
                    LIMIT 1)                AS displayName,
                  ch.character_name         AS characterName,
                  (SELECT COUNT(*)
                     FROM utterances u3
                     JOIN meetings m3 ON m3.id = u3.meeting_id
                    WHERE m3.campaign_id = @campaignId AND u3.user_id = p.user_id) AS lines,
                  EXISTS (SELECT 1 FROM campaign_members cm
                           WHERE cm.campaign_id = @campaignId AND cm.user_id = p.user_id) AS enrolled
             FROM people p
             LEFT JOIN characters ch
                    ON ch.campaign_id = @campaignId AND ch.user_id = p.user_id
            ORDER BY lines DESC, p.user_id`
        )
        .all({ campaignId });
    },

    // --- one person's footprint in a campaign ---
    //
    // Read-only, and deliberately so. Consent can be taken back, but taking it
    // back stops the microphone rather than unwriting the sessions somebody
    // agreed to at the time — a transcript is four or five people's record of a
    // shared evening, not one person's file. There is no method here that
    // deletes a speaker, because that operation should not exist to be called
    // by mistake.

    // What this person has said here: how many lines, across how many sessions,
    // and the name those lines are filed under. Shown by /campaign consent so
    // that "stop" is pressed by someone who knows what it does and does not do.
    contributionOf(campaignId, userId) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS lines, COUNT(DISTINCT u.meeting_id) AS sessions
             FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ? AND u.user_id = ?`
        )
        .get(campaignId, userId);

      const named = db
        .prepare(
          `SELECT u.display_name FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ? AND u.user_id = ?
            ORDER BY u.id DESC LIMIT 1`
        )
        .get(campaignId, userId);

      return {
        lines: row?.lines ?? 0,
        sessions: row?.sessions ?? 0,
        displayName: named?.display_name ?? null,
      };
    },

    // --- most recent completed meeting, for /recap ---

    getLastCompletedMeeting(campaignId) {
      return db
        .prepare(`SELECT * FROM meetings WHERE campaign_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1`)
        .get(campaignId);
    },

    countUtterances(meetingId) {
      return db.prepare(`SELECT COUNT(*) AS n FROM utterances WHERE meeting_id = ?`).get(meetingId).n;
    },

    // --- full-text lookup across every transcript in the campaign (/search) ---

    searchUtterances(campaignId, term, limit = 25) {
      // LIKE's own wildcards have to be neutralised or a search for "50%"
      // or "under_dark" would silently match far more than the user meant.
      const escaped = String(term).replace(/[\\%_]/g, (c) => `\\${c}`);
      return db
        .prepare(
          `SELECT u.text, u.display_name, u.start_ms,
                  m.id AS meeting_id, m.session_number, m.channel_name, m.started_at
             FROM utterances u
             JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ?
              AND u.text LIKE ? ESCAPE '\\'
            ORDER BY m.started_at DESC, u.start_ms ASC
            LIMIT ?`
        )
        .all(campaignId, `%${escaped}%`, limit);
    },

    // --- every completed meeting with a summary, for /funny to pull from ---

    listCompletedMeetings(campaignId) {
      return db
        .prepare(
          `SELECT * FROM meetings
            WHERE campaign_id = ? AND status = 'done' AND summary_json IS NOT NULL
            ORDER BY started_at ASC`
        )
        .all(campaignId);
    },

    // --- orphaned session recovery (bot crashed/restarted mid-session) ---

    listInterruptedMeetings() {
      return db.prepare(`SELECT * FROM meetings WHERE status IN ('recording', 'transcribing')`).all();
    },

    // --- the owner's view of every table the bot serves, for the dashboard ---
    //
    // One row per campaign rather than per server, which is the whole point of
    // this being here: with several campaigns in one Discord, a server-shaped
    // summary can no longer tell you who is playing what.
    campaignOverview() {
      return db
        .prepare(
          `SELECT c.id, c.guild_id, c.name, c.manager_user_id, c.output_mode, c.next_session,
                  (SELECT m.channel_name FROM meetings m
                    WHERE m.campaign_id = c.id ORDER BY m.id DESC LIMIT 1)        AS channel_name,
                  (SELECT COUNT(*) FROM meetings m WHERE m.campaign_id = c.id)     AS sessions,
                  (SELECT COUNT(*) FROM meetings m
                    WHERE m.campaign_id = c.id AND m.status = 'done')              AS completed,
                  (SELECT MAX(m.started_at) FROM meetings m WHERE m.campaign_id = c.id) AS last_session_at,
                  (SELECT COUNT(*) FROM campaign_members cm WHERE cm.campaign_id = c.id) AS members,
                  (SELECT COUNT(*) FROM characters ch WHERE ch.campaign_id = c.id) AS named,
                  (SELECT COUNT(*) FROM utterances u
                     JOIN meetings m ON m.id = u.meeting_id
                    WHERE m.campaign_id = c.id)                                    AS lines,
                  (SELECT COALESCE(SUM(
                            (julianday(m.ended_at) - julianday(m.started_at)) * 86400000
                          ), 0)
                     FROM meetings m
                    WHERE m.campaign_id = c.id AND m.ended_at IS NOT NULL)         AS total_ms,
                  -- How many of this campaign's sessions are stopped waiting
                  -- for a decision. The dashboard's campaign list carries it as
                  -- a badge, so "which table needs me?" is answered before you
                  -- click into one — with three campaigns that is the
                  -- difference between reading a list and opening three.
                  (SELECT COUNT(*) FROM jobs j
                     JOIN meetings m ON m.id = j.meeting_id
                    WHERE m.campaign_id = c.id AND j.status = 'awaiting_approval') AS awaiting
             FROM campaigns c
            ORDER BY (last_session_at IS NULL), last_session_at DESC, c.id`
        )
        .all();
    },

    // --- campaign-wide totals, for /stats ---

    campaignStats(campaignId) {
      const meetings = db
        .prepare(`SELECT id, session_number, started_at, ended_at FROM meetings WHERE campaign_id = ? AND status = 'done'`)
        .all(campaignId);

      let totalMs = 0;
      let longest = null;
      for (const m of meetings) {
        if (!m.ended_at) continue;
        const ms = new Date(m.ended_at).getTime() - new Date(m.started_at).getTime();
        if (!Number.isFinite(ms) || ms <= 0) continue;
        totalMs += ms;
        if (!longest || ms > longest.ms) longest = { id: m.id, sessionNumber: m.session_number, ms };
      }

      const totalLines = db
        .prepare(
          `SELECT COUNT(*) AS n FROM utterances u JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ? AND m.status = 'done'`
        )
        .get(campaignId).n;

      // Ranked by lines rather than words — cheap to compute and a fair enough
      // proxy for "who talked the most" without tokenising every utterance.
      const talkative = db
        .prepare(
          `SELECT u.display_name, COUNT(*) AS lines
             FROM utterances u JOIN meetings m ON m.id = u.meeting_id
            WHERE m.campaign_id = ? AND m.status = 'done'
            GROUP BY u.display_name
            ORDER BY lines DESC
            LIMIT 5`
        )
        .all(campaignId);

      return {
        totalSessions: meetings.length,
        totalMs,
        totalLines,
        talkative,
        longestMeetingId: longest?.id ?? null,
        longestSessionNumber: longest?.sessionNumber ?? null,
        longestMs: longest?.ms ?? 0,
      };
    },

    // --- arranging state in tests ---
    //
    // Doors nothing in src/ opens. They are here rather than on the interface
    // above because a method the bot never calls still LOOKS like a method the
    // bot calls, and the store is already wide enough to read carefully.
    //
    // The SQL stays in this file on purpose — see docs/adr/0001. What moves is
    // the label, not the schema knowledge: `db.forTests.addCampaignMember(...)`
    // says at the call site that a test is arranging state by hand rather than
    // going the way a person would.
    //
    // Prefer the real route where a test has one. Putting somebody on a roster
    // in production means inviting them and having them accept, or naming their
    // character — see the invite() helper in commands-multicampaign.test.js.
    // Reach for these when the state you need is genuinely awkward to reach,
    // not to skip a flow the test is actually about.
    forTests: {
      // A guild's default campaign, creating one if it has none. Production
      // reaches this through createMeeting; tests use it to name "the campaign
      // in this server" without having created one explicitly.
      defaultCampaignId(guildId) {
        return defaultCampaignId(guildId);
      },

      // Membership by fiat, with no consent record — which is a state the bot
      // can reach (naming a character enrols somebody) but never arranges
      // this way.
      addCampaignMember(campaignId, userId, addedBy = null) {
        return db
          .prepare(
            `INSERT INTO campaign_members (campaign_id, user_id, added_by) VALUES (?, ?, ?)
             ON CONFLICT(campaign_id, user_id) DO NOTHING`
          )
          .run(campaignId, userId, addedBy).changes;
      },

      // Membership only. The production act is removeFromCampaign, which also
      // clears the consent row so that being asked again is a fresh question.
      removeCampaignMember(campaignId, userId) {
        return db
          .prepare(`DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?`)
          .run(campaignId, userId).changes;
      },

      listCampaignMembers(campaignId) {
        return db.prepare(`SELECT * FROM campaign_members WHERE campaign_id = ? ORDER BY added_at`).all(campaignId);
      },

      getTranscribeJobForMeeting(meetingId) {
        return db
          .prepare(
            `SELECT * FROM jobs WHERE meeting_id = ? AND type = 'transcribe'
               ORDER BY id DESC LIMIT 1`
          )
          .get(meetingId);
      },
    },
  };
}
