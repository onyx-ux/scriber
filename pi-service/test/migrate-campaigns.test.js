import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { openDb } from '../src/store/db.js';

// The migration onto campaign ids, exercised from the ORIGINAL schema — the
// one that existed before campaigns were a thing, where a guild was a
// campaign and `characters` and `corrections` were keyed on the guild.
//
// This is the one migration that cannot be checked by reading the code. It
// rebuilds two tables, which means dropping and recreating them: if the copy
// is wrong, the rows are gone, and nothing complains. The live database has
// three sessions and seven players in it.

// Verbatim from the schema as it stood before campaigns existed. Deliberately
// a literal copy rather than something generated: the point is to migrate what
// was actually deployed, so it must not track later edits to db.js.
const LEGACY_SCHEMA = `
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'recording', audio_dir TEXT, transcript_path TEXT, summary_json TEXT);
CREATE TABLE utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  display_name TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE characters (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_name TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id));
CREATE TABLE corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, wrong_text TEXT NOT NULL,
  correct_text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, wrong_text));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'summarize',
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')), last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

async function legacyDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-migrate-'));
  const path = join(dir, 'db.sqlite');

  const raw = new Database(path);
  raw.exec(LEGACY_SCHEMA);

  const meeting = raw.prepare(
    `INSERT INTO meetings (guild_id, channel_id, channel_name, started_at, ended_at, status)
     VALUES (?, ?, ?, ?, ?, 'done')`
  );
  const line = raw.prepare(
    `INSERT INTO utterances (meeting_id, user_id, display_name, start_ms, end_ms, text) VALUES (?,?,?,?,?,?)`
  );
  const character = raw.prepare(`INSERT INTO characters (guild_id, user_id, character_name) VALUES (?,?,?)`);
  const correction = raw.prepare(`INSERT INTO corrections (guild_id, wrong_text, correct_text) VALUES (?,?,?)`);

  const a1 = meeting.run('GUILD-A', 'C', 'Session', '2026-01-01T10:00:00Z', '2026-01-01T13:00:00Z').lastInsertRowid;
  const a2 = meeting.run('GUILD-A', 'C', 'Session', '2026-01-08T10:00:00Z', '2026-01-08T13:00:00Z').lastInsertRowid;
  const b1 = meeting.run('GUILD-B', 'C', 'Other Game', '2026-01-02T10:00:00Z', '2026-01-02T12:00:00Z').lastInsertRowid;

  line.run(a1, 'u1', 'Brett', 0, 1, 'the vecks opens');
  line.run(a2, 'u2', 'Saf', 0, 1, 'second night');
  line.run(b1, 'u3', 'Someone', 0, 1, 'a different table entirely');

  character.run('GUILD-A', 'u1', 'BenTen');
  character.run('GUILD-A', 'u2', 'Saf');
  character.run('GUILD-B', 'u3', 'Elsewhere');
  // A roster row for a guild with no meetings at all: a table that set itself
  // up and never played. The campaign backfill is driven from meetings, so
  // this row has nothing to attach to unless the migration looks for it.
  character.run('GUILD-C', 'u9', 'NeverPlayed');

  // The same misheard word in two guilds. Under the old UNIQUE(guild_id,
  // wrong_text) these coexist; they must still coexist under the new
  // UNIQUE(campaign_id, wrong_text) rather than one silently winning.
  correction.run('GUILD-A', 'vecks', 'Vex');
  correction.run('GUILD-B', 'vecks', 'Vecks the Other');

  raw.close();

  const db = openDb(path);
  // Close before removing, and in that order: on Windows, unlinking a file
  // better-sqlite3 still holds open fails with EBUSY.
  t.after(async () => {
    if (db.raw.open) db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

const inGuild = (db, guildId) => db.listCampaigns().find((c) => c.guild_id === guildId);

test('every guild that had data comes out with a campaign', async (t) => {
  const db = await legacyDb(t);
  assert.equal(db.listCampaigns().length, 3);
  for (const g of ['GUILD-A', 'GUILD-B', 'GUILD-C']) assert.ok(inGuild(db, g), g);
});

test('no roster or correction row is lost in the rebuild', async (t) => {
  const db = await legacyDb(t);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM characters').get().n, 4);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM corrections').get().n, 2);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM characters WHERE campaign_id IS NULL').get().n, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM corrections WHERE campaign_id IS NULL').get().n, 0);
});

test('each roster row lands on the campaign of its old guild', async (t) => {
  const db = await legacyDb(t);
  const a = inGuild(db, 'GUILD-A').id;
  const b = inGuild(db, 'GUILD-B').id;

  assert.equal(db.getCharacterName(a, 'u1'), 'BenTen');
  assert.equal(db.getCharacterName(b, 'u3'), 'Elsewhere');
  assert.equal(db.getCharacterName(a, 'u3'), null, "another guild's player did not follow");
});

test('a guild that only ever had a roster keeps it', async (t) => {
  const db = await legacyDb(t);
  assert.equal(db.getCharacterName(inGuild(db, 'GUILD-C').id, 'u9'), 'NeverPlayed');
});

test('two guilds correcting the same word keep both corrections', async (t) => {
  const db = await legacyDb(t);
  assert.equal(db.listCorrections(inGuild(db, 'GUILD-A').id)[0].correct_text, 'Vex');
  assert.equal(db.listCorrections(inGuild(db, 'GUILD-B').id)[0].correct_text, 'Vecks the Other');
});

test('every session is adopted by a campaign, and stays with its own', async (t) => {
  const db = await legacyDb(t);
  const a = inGuild(db, 'GUILD-A').id;
  const b = inGuild(db, 'GUILD-B').id;

  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM meetings WHERE campaign_id IS NULL').get().n, 0);
  assert.equal(db.listRecentMeetings(a, 10).length, 2);
  assert.equal(db.listRecentMeetings(b, 10).length, 1);
  assert.equal(db.campaignStats(a).totalSessions, 2);
  assert.equal(db.searchUtterances(a, 'different table', 5).length, 0, 'and its transcripts stay its own');
});

test('everyone the bot had recorded is grandfathered onto their roster', async (t) => {
  const db = await legacyDb(t);
  const a = inGuild(db, 'GUILD-A').id;
  const b = inGuild(db, 'GUILD-B').id;

  assert.equal(db.isCampaignMember(a, 'u1'), true, 'or they could no longer /join the game they play in');
  assert.equal(db.isCampaignMember(b, 'u1'), false);
});

// A migration that is not idempotent is a migration that runs on every restart.
test('opening the database again migrates nothing', async (t) => {
  const db = await legacyDb(t);
  const before = {
    campaigns: db.listCampaigns().length,
    characters: db.raw.prepare('SELECT COUNT(*) n FROM characters').get().n,
    members: db.raw.prepare('SELECT COUNT(*) n FROM campaign_members').get().n,
  };
  const path = db.raw.name;
  db.close();

  const again = openDb(path);
  try {
    assert.equal(again.listCampaigns().length, before.campaigns);
    assert.equal(again.raw.prepare('SELECT COUNT(*) n FROM characters').get().n, before.characters);
    assert.equal(again.raw.prepare('SELECT COUNT(*) n FROM campaign_members').get().n, before.members);
  } finally {
    again.close();
  }
});
