import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatSessionNumber,
  safeFolderName,
  campaignFolder,
  sessionFileName,
} from '../src/export/naming.js';
import { exportMarkdown } from '../src/export/markdown.js';
import { openDb } from '../src/store/db.js';

// The old scheme produced "2026-08-08-session-session-16.md": the channel is
// "🎲Session" so the slug collided with the literal word, and 16 was the
// MEETING id — a global counter across every server — for what was only that
// table's second night.

test('session numbers are padded so they sort in order', () => {
  assert.equal(formatSessionNumber(1), '01');
  assert.equal(formatSessionNumber(2), '02');
  assert.equal(formatSessionNumber(16), '16');
  assert.equal(formatSessionNumber(120), '120', 'past 99 it just gets longer');
});

test('a missing or nonsense number is reported rather than rendered', () => {
  for (const bad of [0, -1, null, undefined, 'x', NaN]) {
    assert.equal(formatSessionNumber(bad), null, String(bad));
  }
});

test('the filename is the session number alone', () => {
  assert.equal(sessionFileName({ session_number: 2, id: 16 }), 'Session 02.md');
  assert.equal(sessionFileName({ session_number: 11, id: 40 }), 'Session 11.md');
});

// A row that predates session numbering should still export somewhere sane.
test('a meeting with no session number falls back to its id', () => {
  assert.equal(sessionFileName({ id: 7 }), 'Session 07.md');
  assert.equal(sessionFileName({}), 'Session 00.md');
});

// The folder is read by a human in Obsidian, so it keeps its capitalisation
// and spaces rather than being slugified.
test('the campaign folder is readable, not slugified', () => {
  assert.equal(safeFolderName('Sunless Citadel'), 'Sunless Citadel');
  assert.equal(safeFolderName('Cipher'), 'Cipher');
});

test('characters that break a path are removed', () => {
  assert.equal(safeFolderName('Curse of the Crimson Throne: Book 2'), 'Curse of the Crimson Throne Book 2');
  assert.equal(safeFolderName('A/B\\C'), 'ABC');
  assert.equal(safeFolderName('what? really*'), 'what really');
});

// Windows silently drops these, so a folder named "Cipher." is not the folder
// you asked for.
test('trailing dots and spaces are trimmed', () => {
  assert.equal(safeFolderName('Cipher.'), 'Cipher');
  assert.equal(safeFolderName('  Cipher  '), 'Cipher');
});

test('emoji from a channel name are dropped', () => {
  assert.equal(safeFolderName('🎲Session'), 'Session');
  assert.equal(safeFolderName('🎲 The Table 🎲'), 'The Table');
});

test('a name that is only emoji or symbols falls back', () => {
  assert.equal(safeFolderName('🎲'), 'Campaign');
  assert.equal(safeFolderName(''), 'Campaign');
  assert.equal(safeFolderName(null), 'Campaign');
});

test('the set campaign name wins over the channel name', () => {
  const meeting = { channel_name: '🎲Session', guild_id: 'G1' };
  assert.equal(campaignFolder(meeting, 'Sunless Citadel'), 'Sunless Citadel');
  assert.equal(campaignFolder(meeting, null), 'Session', 'falls back to the channel');
});

// --- as it lands on disk ---

async function exportInto(t, meeting, campaignName) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-naming-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const path = await exportMarkdown({
    meeting,
    utterances: [{ display_name: 'Matt', text: 'hello', start_ms: 0, end_ms: 1 }],
    notes: { tldr: 'A session.' },
    cfg: { obsidianExportDir: dir },
    campaignName,
  });
  return { dir, path };
}

const meeting16 = {
  id: 16,
  session_number: 2,
  guild_id: 'G1',
  channel_name: '🎲Session',
  started_at: '2026-08-08T10:00:00Z',
};

test('a session is filed under its campaign as Session NN.md', async (t) => {
  const { dir, path } = await exportInto(t, meeting16, 'Cipher');

  assert.deepEqual(await readdir(dir), ['Cipher']);
  assert.deepEqual(await readdir(join(dir, 'Cipher')), ['Session 02.md']);
  assert.ok(path.endsWith(join('Cipher', 'Session 02.md')), path);
});

test('the note itself says session 02, not meeting 16', async (t) => {
  const { path } = await exportInto(t, meeting16, 'Cipher');
  const md = await readFile(path, 'utf8');

  assert.match(md, /^title: "Session 02 — Cipher — 2026-08-08"$/m);
  assert.match(md, /^session: 02$/m);
  assert.match(md, /^campaign: "Cipher"$/m);
  assert.match(md, /^# Session 02 — Cipher \(2026-08-08\)$/m);
  // The meeting id is what /summarise and the logs use, so it stays available.
  assert.match(md, /^meeting_id: 16$/m);
});

test('two campaigns do not collide despite both having a session 01', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-naming-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cfg = { obsidianExportDir: dir };
  const utterances = [{ display_name: 'A', text: 'x', start_ms: 0, end_ms: 1 }];
  const notes = { tldr: 'x' };

  await exportMarkdown({
    meeting: { id: 1, session_number: 1, guild_id: 'G1', channel_name: 'A', started_at: '2026-01-01' },
    utterances, notes, cfg, campaignName: 'Cipher',
  });
  await exportMarkdown({
    meeting: { id: 2, session_number: 1, guild_id: 'G2', channel_name: 'B', started_at: '2026-01-02' },
    utterances, notes, cfg, campaignName: 'Crack Animal Zoo',
  });

  assert.deepEqual((await readdir(dir)).sort(), ['Cipher', 'Crack Animal Zoo']);
  assert.deepEqual(await readdir(join(dir, 'Cipher')), ['Session 01.md']);
  assert.deepEqual(await readdir(join(dir, 'Crack Animal Zoo')), ['Session 01.md']);
});

// --- numbering in the database ---

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-num-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

const make = (db, guildId) =>
  db.createMeeting({
    guildId,
    channelId: 'c',
    channelName: 'Session',
    startedAt: new Date().toISOString(),
    audioDir: '/tmp/a',
  });

test('sessions are numbered per campaign, not globally', async (t) => {
  const db = await freshDb(t);

  const a1 = make(db, 'G1');
  const b1 = make(db, 'G2');
  const a2 = make(db, 'G1');

  assert.equal(db.getMeeting(a1).session_number, 1);
  assert.equal(db.getMeeting(b1).session_number, 1, 'a different table starts at 1');
  assert.equal(db.getMeeting(a2).session_number, 2, 'not 3 — the other server does not count');
});

// A reused number silently overwrites the note already exported under it,
// synced to Drive and linked from the ledger.
test('a deleted session never hands its number to the next one', async (t) => {
  const db = await freshDb(t);
  make(db, 'G1');
  const second = make(db, 'G1');
  assert.equal(db.getMeeting(second).session_number, 2);

  db.raw.prepare('DELETE FROM meetings WHERE id = ?').run(second);

  const third = make(db, 'G1');
  assert.equal(db.getMeeting(third).session_number, 3, 'must not reuse 2');
});

// An established campaign must not restart at 1 when the counter is created.
test('numbering continues across the migration on an existing campaign', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-mig-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite');

  const before = openDb(path);
  make(before, 'G1');
  make(before, 'G1');
  // Simulate a database written before the counter existed.
  before.raw.exec('DROP TABLE campaigns');
  before.close();

  const after = openDb(path);
  const third = make(after, 'G1');
  const number = after.getMeeting(third).session_number;
  // Closed here rather than in a hook: on Windows the temp directory cannot
  // be removed while better-sqlite3 still holds the file open.
  after.close();

  assert.equal(number, 3, 'not 1');
});

test('naming a campaign does not disturb its numbering', async (t) => {
  const db = await freshDb(t);
  make(db, 'G1');
  db.setCampaignName(db.forTests.defaultCampaignId('G1'), 'Cipher');

  assert.equal(db.getMeeting(make(db, 'G1')).session_number, 2, 'setting a name must not reset the counter');
  assert.equal(db.getCampaignName(db.forTests.defaultCampaignId('G1')), 'Cipher');
});

test('campaign names are stored per campaign', async (t) => {
  const db = await freshDb(t);
  make(db, 'G1');
  make(db, 'G2');
  const a = db.forTests.defaultCampaignId('G1');
  const b = db.forTests.defaultCampaignId('G2');

  db.setCampaignName(a, 'Cipher');
  assert.equal(db.getCampaignName(a), 'Cipher');
  assert.equal(db.getCampaignName(b), null);

  db.setCampaignName(a, 'Sunless Citadel');
  assert.equal(db.getCampaignName(a), 'Sunless Citadel', 'renaming replaces rather than duplicating');
});

test('campaigns are listable for the DM picker', async (t) => {
  const db = await freshDb(t);
  make(db, 'G1');
  make(db, 'G1');
  make(db, 'G2');
  db.setCampaignName(db.forTests.defaultCampaignId('G1'), 'Cipher');

  const rows = db.listCampaigns();
  assert.equal(rows.length, 2);

  const g1 = rows.find((r) => r.guild_id === 'G1');
  assert.equal(g1.name, 'Cipher');
  assert.equal(g1.sessions, 2);
  assert.equal(rows.find((r) => r.guild_id === 'G2').name, null);
});

test('a campaign with no sessions is still listable, so it can be set up', async (t) => {
  const db = await freshDb(t);
  const id = db.createCampaign('G', 'Brand New', 'dm');

  const row = db.listCampaigns().find((c) => c.id === id);
  assert.equal(row.name, 'Brand New');
  assert.equal(row.sessions, 0, 'no sessions yet');
  assert.equal(row.channel_name, null, 'and nothing to fall back to');
});

test('each campaign in one server numbers its own sessions', async (t) => {
  const db = await freshDb(t);
  const first = db.createCampaign('G', 'Cipher', 'dm-a');
  const second = db.createCampaign('G', 'Strahd', 'dm-b');

  const one = db.createMeeting({ guildId: 'G', campaignId: first, channelId: 'C', channelName: 'a', startedAt: 'x', audioDir: '/a' });
  const two = db.createMeeting({ guildId: 'G', campaignId: second, channelId: 'C', channelName: 'b', startedAt: 'x', audioDir: '/a' });
  const three = db.createMeeting({ guildId: 'G', campaignId: first, channelId: 'C', channelName: 'a', startedAt: 'x', audioDir: '/a' });

  assert.equal(db.getMeeting(one).session_number, 1);
  assert.equal(db.getMeeting(two).session_number, 1, "the other table's first night is its session 1, not its session 2");
  assert.equal(db.getMeeting(three).session_number, 2);
});

// --- Drive destination mirrors the campaign folder ---

test('each campaign gets its own notes folder on Drive', async () => {
  const { noteRemoteDir } = await import('../src/sync/drive-sync.js');
  const cfg = { driveRemoteName: 'gdrive', driveRemotePath: 'DnDSessions', obsidianExportDir: '/data/obsidian' };

  assert.equal(
    noteRemoteDir('/data/obsidian/Cipher/Session 01.md', cfg),
    'gdrive:DnDSessions/notes/Cipher'
  );
  // Without this, both campaigns' "Session 01.md" land on the same remote
  // path and the second upload overwrites the first.
  assert.notEqual(
    noteRemoteDir('/data/obsidian/Cipher/Session 01.md', cfg),
    noteRemoteDir('/data/obsidian/Crack Animal Zoo/Session 01.md', cfg)
  );
});

test('a note in the export root keeps the old flat destination', async () => {
  const { noteRemoteDir } = await import('../src/sync/drive-sync.js');
  const cfg = { driveRemoteName: 'gdrive', driveRemotePath: 'DnDSessions', obsidianExportDir: '/data/obsidian' };
  assert.equal(noteRemoteDir('/data/obsidian/legacy.md', cfg), 'gdrive:DnDSessions/notes');
});

// --- how a session is referred to in Discord ---

test('the label leads with the vault’s number and keeps the id for commands', async () => {
  const { sessionLabel } = await import('../src/export/naming.js');
  // The note is "Session 02.md" but /summarise still takes meeting_id 16.
  // Showing only one of them made the DM say "Session #16" about a file
  // called "Session 02.md".
  assert.equal(sessionLabel({ id: 16, session_number: 2 }), 'Session 02 (#16)');
  assert.equal(sessionLabel({ id: 3, session_number: 11 }), 'Session 11 (#3)');
});

test('a session with no number falls back to the meeting id', async () => {
  const { sessionLabel } = await import('../src/export/naming.js');
  assert.equal(sessionLabel({ id: 7 }), 'Session #7');
  assert.equal(sessionLabel({ meeting_id: 7 }), 'Session #7', 'job rows name it differently');
});
