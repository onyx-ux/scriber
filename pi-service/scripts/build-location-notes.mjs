#!/usr/bin/env node
// Builds one Obsidian note per place for a campaign, read from the FULL
// session transcripts. The counterpart to build-npc-notes.mjs.
//
//   node scripts/build-location-notes.mjs <guildId> [--write] [--model <name>] [--cache <file>]
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import { buildTranscriptText } from '../src/pipeline/transcribe.js';
import { callModel } from '../src/pipeline/model-client.js';
import { campaignFolder } from '../src/export/naming.js';
import { readKnownEntityNames } from '../src/campaign/ledger.js';
import { npcFileName } from '../src/campaign/npc-extract.js';
import {
  LOCATION_SYSTEM_PROMPT,
  buildLocationUserMessage,
  parseLocationResponse,
  mergeLocations,
  reconcileAliases,
  renderLocationNote,
} from '../src/campaign/location-extract.js';

const args = process.argv.slice(2);
const guildId = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
// See build-npc-notes.mjs: Pro is unavailable on this key's free tier, and
// gemini-3.6-flash serves requests despite being absent from ListModels.
const model = flag('--model', 'gemini-3.6-flash');
const cachePath = flag('--cache');

if (!guildId) {
  console.error('usage: node scripts/build-location-notes.mjs <guildId> [--write] [--model <name>] [--cache <file>]');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'db.sqlite'));
const cfg = { ...config, summaryProvider: 'gemini', geminiModel: model };

const meetings = db
  .listCompletedMeetings(guildId)
  .slice()
  .sort((a, b) => (a.session_number ?? a.id) - (b.session_number ?? b.id));

if (meetings.length === 0) {
  console.error(`no completed sessions for guild ${guildId}`);
  process.exit(1);
}

const campaignName = db.getCampaignName(guildId);
const folder = campaignFolder(meetings[0], campaignName);
console.log(`campaign : ${campaignName || meetings[0].channel_name} -> ${folder}/`);
console.log(`model    : ${model}`);

// The ledger lives on Drive between sessions — rclone moves the local copy
// out to the vault — so it may be absent here. An empty list silently skips
// alias reconciliation, which is how [[Kerowyn]] nearly got orphaned, so say
// so rather than carrying on quietly.
const ledger = await readKnownEntityNames(config, folder);
const npcNotes = await readdir(join(config.obsidianExportDir, folder, 'NPCs'))
  .then((files) => files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')))
  .catch(() => []);

const existingNames = [...ledger.npcs, ...ledger.locations];
console.log(
  existingNames.length
    ? `existing : ${existingNames.join(', ')}\n`
    : '⚠️  ledger is empty here — pull it from Drive first or aliases will not be reconciled\n'
);

const perSession = [];
let cached = cachePath
  ? await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null)
  : null;
if (cached) console.log(`cache    : reusing ${cachePath} (no API calls)\n`);

for (const meeting of cached ? [] : meetings) {
  const utterances = db.listUtterances(meeting.id);
  if (utterances.length === 0) continue;

  const sessionNumber = meeting.session_number ?? meeting.id;
  const transcript = buildTranscriptText(utterances);
  process.stdout.write(`session ${sessionNumber}: ${utterances.length} lines … `);

  let text;
  try {
    text = await callModel(
      LOCATION_SYSTEM_PROMPT,
      buildLocationUserMessage({
        transcript,
        sessionNumber,
        date: (meeting.started_at || '').slice(0, 10),
        existingNames,
      }),
      cfg,
      20 * 60 * 1000
    );
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    continue;
  }

  const locations = parseLocationResponse(text);
  console.log(`${locations.length} place(s)`);
  perSession.push({ sessionNumber, locations });
}

if (cachePath && !cached && perSession.length) {
  await writeFile(cachePath, JSON.stringify(perSession, null, 2), 'utf8');
  console.log(`cache    : saved to ${cachePath}`);
}

const merged = mergeLocations(cached ?? perSession);
const { unresolved } = reconcileAliases(merged, ledger.locations);
if (unresolved.length) {
  console.log(`\n⚠️  unmatched existing name(s): ${unresolved.join(', ')}`);
}

console.log(`\n${merged.length} distinct place(s):\n`);

// NPC notes already exist, so inhabitants can be linked to real pages.
const knownEntities = [...ledger.npcs, ...ledger.locations, ...npcNotes, ...merged.map((l) => l.name)];

const outDir = join(config.obsidianExportDir, folder, 'Locations');
for (const loc of merged) {
  const filename = npcFileName(loc.name);
  if (!filename) continue;

  const detail = [loc.kind, loc.status, `danger ${loc.danger}`, `sessions ${loc.sessions.join(', ')}`]
    .filter(Boolean)
    .join(' · ');
  console.log(`  ${loc.name.padEnd(26)} ${detail}`);

  if (WRITE) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, filename), renderLocationNote(loc, { campaign: campaignName, knownEntities }), 'utf8');
  }
}

console.log(WRITE ? `\nWrote ${merged.length} note(s) to ${outDir}` : '\nDry run — re-run with --write.');
