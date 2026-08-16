// Removes everything the bot recorded for a campaign.
//
//   node scripts/forget-campaign.mjs <campaign> [<campaign>...]         # dry run
//   node scripts/forget-campaign.mjs <campaign> --write
//
// <campaign> is a campaign id, a campaign name, or a guild id (which still
// works when that server holds exactly one campaign). For a server that was
// only ever used to test the bot, or a table that has finished. It clears the
// database rows, the campaign's folder in the vault, the raw audio still on
// disk, and the copies on Drive.
//
// Named campaigns rather than guilds because one Discord can hold several: the
// old version deleted a whole server's rows, which would now take the other
// table's game with it.
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
import { pickCampaign } from './lib/pick-campaign.mjs';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const write = args.includes('--write');
const wanted = args.filter((a) => !a.startsWith('--'));

if (wanted.length === 0) {
  console.error('usage: node scripts/forget-campaign.mjs <campaign> [<campaign>...] [--write]');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'db.sqlite'));

let campaigns;
try {
  campaigns = wanted.map((which) => pickCampaign(db, which));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const ids = campaigns.map((c) => c.id);
const placeholders = ids.map(() => '?').join(',');

const meetings = db.raw
  .prepare(`SELECT * FROM meetings WHERE campaign_id IN (${placeholders}) ORDER BY id`)
  .all(...ids);

const folders = new Set(campaigns.map((c) => campaignFolder({ channel_name: c.channel_name }, c.name)));

const count = (sql) => db.raw.prepare(sql).get(...ids).n;
const counts = {
  utterances: count(
    `SELECT COUNT(*) n FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE campaign_id IN (${placeholders}))`
  ),
  jobs: count(
    `SELECT COUNT(*) n FROM jobs WHERE meeting_id IN (SELECT id FROM meetings WHERE campaign_id IN (${placeholders}))`
  ),
  characters: count(`SELECT COUNT(*) n FROM characters WHERE campaign_id IN (${placeholders})`),
  corrections: count(`SELECT COUNT(*) n FROM corrections WHERE campaign_id IN (${placeholders})`),
  members: count(`SELECT COUNT(*) n FROM campaign_members WHERE campaign_id IN (${placeholders})`),
};

// Audio directories are named "<guildId>-<epoch>", so they cannot be told
// apart per campaign — a directory belongs to a SERVER. Only sweep them when
// every campaign in that server is being forgotten, or a second table's raw
// audio would go with the first's.
const audioRoot = join(config.dataDir, 'audio');
const wholeGuilds = [...new Set(campaigns.map((c) => c.guild_id))].filter(
  (g) => db.listCampaignsInGuild(g).every((c) => ids.includes(c.id))
);
const partialGuilds = [...new Set(campaigns.map((c) => c.guild_id))].filter((g) => !wholeGuilds.includes(g));
const audioDirs = (await readdir(audioRoot).catch(() => [])).filter((d) =>
  wholeGuilds.some((g) => d.startsWith(`${g}-`))
);

console.log('about to forget:');
for (const c of campaigns) {
  const mine = meetings.filter((m) => m.campaign_id === c.id);
  console.log(
    `  campaign ${c.id} — ${c.name || '(unnamed)'}, guild ${c.guild_id}, ` +
      `${mine.length} meeting(s)${mine.length ? `: ${mine.map((m) => m.id).join(', ')}` : ''}`
  );
}
console.log(
  `  rows      : ${meetings.length} meetings, ${counts.utterances} utterances, ${counts.jobs} jobs, ` +
    `${counts.characters} characters, ${counts.corrections} corrections, ${counts.members} members`
);
console.log(`  vault     : ${[...folders].map((f) => `${f}/`).join(', ') || '(none)'}`);
console.log(`  audio     : ${audioDirs.length} director(ies) under ${audioRoot}`);
if (partialGuilds.length) {
  console.log(
    `  audio kept: ${partialGuilds.join(', ')} still ${partialGuilds.length === 1 ? 'has' : 'have'} another campaign — ` +
      'raw audio is per server, so it is left alone'
  );
}
console.log(`  drive     : notes/<folder>/, audio/<meetingId>/ for each meeting above`);
console.log(write ? '\nWRITING\n' : '\ndry run — pass --write to actually delete\n');

if (!write) process.exit(0);

// A snapshot first. It goes to db-backups/ on Drive, which is the only way
// back if this turns out to have been the wrong campaign.
await backupAndSyncDatabase(db, config);

const removed = db.raw.transaction(() => ({
  utterances: db.raw
    .prepare(
      `DELETE FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE campaign_id IN (${placeholders}))`
    )
    .run(...ids).changes,
  jobs: db.raw
    .prepare(`DELETE FROM jobs WHERE meeting_id IN (SELECT id FROM meetings WHERE campaign_id IN (${placeholders}))`)
    .run(...ids).changes,
  characters: db.raw.prepare(`DELETE FROM characters WHERE campaign_id IN (${placeholders})`).run(...ids).changes,
  corrections: db.raw.prepare(`DELETE FROM corrections WHERE campaign_id IN (${placeholders})`).run(...ids).changes,
  members: db.raw.prepare(`DELETE FROM campaign_members WHERE campaign_id IN (${placeholders})`).run(...ids).changes,
  meetings: db.raw.prepare(`DELETE FROM meetings WHERE campaign_id IN (${placeholders})`).run(...ids).changes,
  campaigns: db.raw.prepare(`DELETE FROM campaigns WHERE id IN (${placeholders})`).run(...ids).changes,
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
