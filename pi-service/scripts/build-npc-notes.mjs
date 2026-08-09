#!/usr/bin/env node
// Builds one Obsidian note per NPC for a campaign, read from the FULL session
// transcripts rather than the per-session summaries.
//
//   node scripts/build-npc-notes.mjs <guildId> [--write] [--model <name>]
//
// Dry run by default: prints what it found and what it would write. The
// transcripts are large, so each session costs a real API call either way —
// the dry run exists to check the extraction before it touches the vault, not
// to avoid the call.
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import { buildTranscriptText } from '../src/pipeline/transcribe.js';
import { callModel } from '../src/pipeline/model-client.js';
import { campaignFolder } from '../src/export/naming.js';
import { readKnownEntityNames } from '../src/campaign/ledger.js';
import {
  NPC_SYSTEM_PROMPT,
  buildNpcUserMessage,
  parseNpcResponse,
  mergeNpcs,
  reconcileAliases,
  renderNpcNote,
  npcFileName,
} from '../src/campaign/npc-extract.js';

const args = process.argv.slice(2);
const guildId = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
const modelFlag = args.indexOf('--model');
// The configured summariser is a budget model chosen for cheap recaps.
// Reading 4,000 lines of raw transcript for character detail is a different
// job, so this defaults to a stronger one without touching SUMMARY_PROVIDER.
//
// Flash rather than Pro deliberately: every Pro model returns
// "limit: 0 ... free_tier" on this key, so Pro is not merely throttled, it is
// unavailable. Note also that gemini-3.6-flash is NOT in the ListModels
// response but does serve requests — don't trust that listing to decide what
// exists.
const model = modelFlag !== -1 ? args[modelFlag + 1] : 'gemini-3.6-flash';

if (!guildId) {
  console.error('usage: node scripts/build-npc-notes.mjs <guildId> [--write] [--model <name>]');
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
console.log(`sessions : ${meetings.map((m) => m.session_number ?? m.id).join(', ')}\n`);

// The spellings the vault's existing [[links]] use. Handed to the model so it
// carries them into aliases rather than orphaning links the ledger and the
// session recaps already contain.
const ledgerNames = await readKnownEntityNames(config, folder);
const existingNames = [...ledgerNames.npcs, ...ledgerNames.locations];
if (existingNames.length) console.log(`existing : ${existingNames.join(', ')}\n`);

// Reading the transcripts costs a real API call per session, and rendering
// the notes is fiddly enough to want several attempts. --cache saves the
// extraction so the notes can be rebuilt from it offline.
const cacheFlag = args.indexOf('--cache');
const cachePath = cacheFlag !== -1 ? args[cacheFlag + 1] : null;

const perSession = [];
let cached = null;
if (cachePath) {
  cached = await readFile(cachePath, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  if (cached) console.log(`cache    : reusing ${cachePath} (no API calls)\n`);
}

for (const meeting of cached ? [] : meetings) {
  const utterances = db.listUtterances(meeting.id);
  if (utterances.length === 0) {
    console.log(`session ${meeting.session_number}: no transcript, skipped`);
    continue;
  }

  const transcript = buildTranscriptText(utterances);
  const players = [...new Set(utterances.map((u) => u.display_name))];
  const sessionNumber = meeting.session_number ?? meeting.id;

  process.stdout.write(
    `session ${sessionNumber}: ${utterances.length} lines (${Math.round(transcript.length / 1024)}KB) … `
  );

  const started = Date.now();
  let text;
  try {
    text = await callModel(
      NPC_SYSTEM_PROMPT,
      buildNpcUserMessage({
        transcript,
        sessionNumber,
        date: (meeting.started_at || '').slice(0, 10),
        playerCharacters: players,
        existingNames,
      }),
      cfg,
      20 * 60 * 1000
    );
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    continue;
  }

  const npcs = parseNpcResponse(text);
  console.log(`${npcs.length} NPC(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  if (npcs.length === 0 && text.trim()) {
    console.log(`  (unparsed response began: ${text.trim().slice(0, 120).replace(/\s+/g, ' ')}…)`);
  }
  perSession.push({ sessionNumber, npcs });
}

if (cachePath && !cached && perSession.length) {
  await writeFile(cachePath, JSON.stringify(perSession, null, 2), 'utf8');
  console.log(`cache    : saved raw extraction to ${cachePath}`);
}

const merged = mergeNpcs(cached ?? perSession);

// Enforce what the prompt asks for. A model that carries existing spellings
// into aliases MOST of the time still silently orphans the links it misses.
const { unresolved } = reconcileAliases(merged, existingNames);
if (unresolved.length) {
  console.log(
    `\n⚠️  ${unresolved.length} existing name(s) could not be matched to exactly one NPC, so ` +
      `links to them will not resolve:\n   ${unresolved.join(', ')}`
  );
}

// --json dumps the merged records so the extraction can be reviewed before it
// is turned into notes — the transcripts are read once, the vault is written
// to separately.
if (args.includes('--json')) {
  console.log(JSON.stringify(merged, null, 2));
  process.exit(0);
}

console.log(`\n${merged.length} distinct NPC(s) after merging across sessions:\n`);

// Anything already in the ledger can be linked; anything else stays plain text
// so the vault doesn't fill with links to notes that will never exist.
const ledger = ledgerNames;
const knownEntities = [...ledger.npcs, ...ledger.locations, ...merged.map((n) => n.name)];

const outDir = join(config.obsidianExportDir, folder, 'NPCs');
for (const npc of merged) {
  const filename = npcFileName(npc.name);
  if (!filename) {
    console.log(`  (skipped an NPC whose name produced no usable filename: ${JSON.stringify(npc.name)})`);
    continue;
  }

  const detail = [
    npc.race,
    npc.status !== 'unknown' ? npc.status : null,
    `sessions ${npc.sessions.join(', ')}`,
    npc.quotes.length ? `${npc.quotes.length} quote(s)` : null,
    npc.hooks.length ? `${npc.hooks.length} open thread(s)` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  console.log(`  ${npc.name.padEnd(24)} ${detail}`);

  if (WRITE) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, filename), renderNpcNote(npc, { campaign: campaignName, knownEntities }), 'utf8');
  }
}

if (WRITE) {
  const written = await readdir(outDir).catch(() => []);
  console.log(`\nWrote ${written.length} note(s) to ${outDir}`);
} else {
  console.log('\nDry run — re-run with --write to create the notes.');
}
