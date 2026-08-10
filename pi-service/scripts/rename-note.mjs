#!/usr/bin/env node
// Renames an entity note and repoints every link in the campaign at it.
//
//   node scripts/rename-note.mjs <guildId|folder> "Seth" "Saf"          # dry run
//   node scripts/rename-note.mjs <guildId|folder> "Seth" "Saf" --write
//
// For when the extractor named a character from what the transcript sounded
// like and the table knows better. The old name is kept as an alias, so
// anything written before the rename keeps resolving.
import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { campaignFolder } from '../src/export/naming.js';
import { renameInNote, renameLinks } from '../src/campaign/rename-entity.js';
import { npcFileName } from '../src/campaign/npc-extract.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const [which, from, to] = args.filter((a) => !a.startsWith('--'));

if (!which || !from || !to) {
  console.error('usage: node scripts/rename-note.mjs <guildId|folder> <old name> <new name> [--write]');
  process.exit(1);
}

let folder = which;
if (/^\d{15,}$/.test(which)) {
  const db = openDb(join(config.dataDir, 'db.sqlite'));
  const campaign = db.listCampaigns().find((c) => c.guild_id === which);
  if (!campaign) {
    console.error(`no campaign recorded for guild ${which}`);
    process.exit(1);
  }
  folder = campaignFolder({ channel_name: campaign.channel_name }, campaign.campaign_name);
}

const root = join(config.obsidianExportDir, folder);

const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.md')) files.push(path);
  }
}
await walk(root);

const source = files.find((f) => basename(f, '.md') === from);
if (!source) {
  console.error(`no note called "${from}" under ${root}`);
  process.exit(1);
}

const filename = npcFileName(to);
if (!filename) {
  console.error(`"${to}" does not produce a usable filename`);
  process.exit(1);
}
const dest = join(source.slice(0, source.lastIndexOf(basename(source))), filename);

if (await stat(dest).catch(() => null)) {
  console.error(`${dest} already exists — merge it by hand rather than overwriting`);
  process.exit(1);
}

console.log(`campaign : ${folder}`);
console.log(`rename   : ${source.slice(root.length + 1)} -> ${dest.slice(root.length + 1)}`);
console.log(write ? 'mode     : WRITING\n' : 'mode     : dry run (pass --write to apply)\n');

let changed = 0;
for (const file of files) {
  const before = await readFile(file, 'utf8');
  const after = file === source ? renameLinks(renameInNote(before, from, to), from, to) : renameLinks(before, from, to);
  if (after === before) continue;

  changed++;
  console.log(`  ${file.slice(root.length + 1)}`);
  const lines = before.split('\n');
  for (const [i, line] of after.split('\n').entries()) {
    if (lines[i] !== undefined && lines[i] !== line) console.log(`      - ${lines[i]}\n      + ${line}`);
  }
  if (write) await writeFile(file, after, 'utf8');
}

if (write) await rename(source, dest);
console.log(`\n${changed} file(s)${write ? ' updated, note renamed' : ' would change — dry run'}`);
