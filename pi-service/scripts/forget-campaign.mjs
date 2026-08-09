// Removes everything the bot recorded for a campaign.
//
//   node scripts/forget-campaign.mjs <guildId> [<guildId>...]          # dry run
//   node scripts/forget-campaign.mjs <guildId> --write
//
// For a server that was only ever used to test the bot, or one the table has
// finished with. It clears the database rows, the campaign's folder in the
// vault, the raw audio still on disk, and the copies on Drive.
//
// Dry run by default, and it prints a full inventory before doing anything:
// there is no undo beyond the database snapshots in db-backups/, and a
// transcript is not something you can re-record.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { campaignFolder } from '../src/export/naming.js';
import { backupAndSyncDatabase } from '../src/sync/drive-sync.js';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const write = args.includes('--write');
const guilds = args.filter((a) => !a.startsWith('--'));

if (guilds.length === 0) {
  console.error('usage: node scripts/forget-campaign.mjs <guildId> [<guildId>...] [--write]');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'db.sqlite'));
const placeholders = guilds.map(() => '?').join(',');

const meetings = db.raw
  .prepare(`SELECT * FROM meetings WHERE guild_id IN (${placeholders}) ORDER BY id`)
  .all(...guilds);

if (meetings.length === 0) {
  console.error(`no meetings recorded for ${guilds.join(', ')} — nothing to forget`);
  process.exit(1);
}

const folders = new Set();
for (const guildId of guilds) {
  const meeting = meetings.find((m) => m.guild_id === guildId);
  if (meeting) folders.add(campaignFolder(meeting, db.getCampaignName(guildId)));
}

const counts = {
  utterances: db.raw
    .prepare(`SELECT COUNT(*) n FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE guild_id IN (${placeholders}))`)
    .get(...guilds).n,
  jobs: db.raw
    .prepare(`SELECT COUNT(*) n FROM jobs WHERE meeting_id IN (SELECT id FROM meetings WHERE guild_id IN (${placeholders}))`)
    .get(...guilds).n,
  characters: db.raw.prepare(`SELECT COUNT(*) n FROM characters WHERE guild_id IN (${placeholders})`).get(...guilds).n,
  corrections: db.raw.prepare(`SELECT COUNT(*) n FROM corrections WHERE guild_id IN (${placeholders})`).get(...guilds).n,
};

// Audio directories are named "<guildId>-<epoch>", so they can be matched
// without trusting the audio_dir column to still be accurate.
const audioRoot = join(config.dataDir, 'audio');
const audioDirs = (await readdir(audioRoot).catch(() => [])).filter((d) => guilds.some((g) => d.startsWith(`${g}-`)));

console.log('about to forget:');
for (const guildId of guilds) {
  const mine = meetings.filter((m) => m.guild_id === guildId);
  console.log(`  guild ${guildId} — ${db.getCampaignName(guildId) || '(unnamed)'}, ${mine.length} meeting(s): ${mine.map((m) => m.id).join(', ')}`);
}
console.log(`  rows      : ${meetings.length} meetings, ${counts.utterances} utterances, ${counts.jobs} jobs, ${counts.characters} characters, ${counts.corrections} corrections`);
console.log(`  vault     : ${[...folders].map((f) => `${f}/`).join(', ') || '(none)'}`);
console.log(`  audio     : ${audioDirs.length} director(ies) under ${audioRoot}`);
console.log(`  drive     : notes/<folder>/, audio/<meetingId>/ for each meeting above`);
console.log(write ? '\nWRITING\n' : '\ndry run — pass --write to actually delete\n');

if (!write) process.exit(0);

// A snapshot first. It goes to db-backups/ on Drive, which is the only way
// back if this turns out to have been the wrong guild id.
await backupAndSyncDatabase(db, config);

const removed = db.raw.transaction(() => ({
  utterances: db.raw
    .prepare(`DELETE FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE guild_id IN (${placeholders}))`)
    .run(...guilds).changes,
  jobs: db.raw
    .prepare(`DELETE FROM jobs WHERE meeting_id IN (SELECT id FROM meetings WHERE guild_id IN (${placeholders}))`)
    .run(...guilds).changes,
  characters: db.raw.prepare(`DELETE FROM characters WHERE guild_id IN (${placeholders})`).run(...guilds).changes,
  corrections: db.raw.prepare(`DELETE FROM corrections WHERE guild_id IN (${placeholders})`).run(...guilds).changes,
  meetings: db.raw.prepare(`DELETE FROM meetings WHERE guild_id IN (${placeholders})`).run(...guilds).changes,
  campaigns: db.raw.prepare(`DELETE FROM campaigns WHERE guild_id IN (${placeholders})`).run(...guilds).changes,
}))();
console.log(`database : ${Object.entries(removed).map(([k, v]) => `${v} ${k}`).join(', ')}`);

for (const folder of folders) {
  const path = join(config.obsidianExportDir, folder);
  if (await stat(path).catch(() => null)) {
    await rm(path, { recursive: true, force: true });
    console.log(`vault    : removed ${path}`);
  }
}

for (const dir of audioDirs) {
  await rm(join(audioRoot, dir), { recursive: true, force: true });
}
console.log(`audio    : removed ${audioDirs.length} director(ies)`);

if (config.driveSyncEnabled) {
  const purge = async (...parts) => {
    const remote = `${config.driveRemoteName}:${config.driveRemotePath}/${parts.join('/')}`;
    try {
      await execFileAsync('rclone', ['purge', remote, '--quiet'], { timeout: 10 * 60 * 1000 });
      console.log(`drive    : purged ${parts.join('/')}`);
    } catch (err) {
      // A path that was never uploaded is not an error worth stopping for.
      console.log(`drive    : ${parts.join('/')} — ${err.message.split('\n')[0]}`);
    }
  };

  for (const folder of folders) await purge('notes', folder);
  for (const meeting of meetings) await purge('audio', String(meeting.id));
}

console.log('\ndone');
