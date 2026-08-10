#!/usr/bin/env node
// Builds one Obsidian note per PLAYER CHARACTER, read from the FULL session
// transcripts rather than the per-session summaries.
//
//   node scripts/build-character-notes.mjs <guildId> --dm "Old Dad" \
//     --pc "Brett=BenTen" --pc Aurion --pc Tad [--write]
//
// The roster is given on the command line rather than guessed, because the
// transcript only knows the DISCORD SPEAKER. "Brett" is a person; "BenTen" is
// who they play; and no amount of reading the transcript tells you reliably
// which speaker is the DM. A --pc with no "=" means the speaker label and the
// character name are the same.
//
// Dry run by default. The transcripts are large, so each session costs a real
// API call either way — the dry run exists to check the extraction before it
// touches the vault, not to avoid the call.
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
  CHARACTER_SYSTEM_PROMPT,
  buildCharacterUserMessage,
  parseCharacterResponse,
  mergeCharacters,
  applyRoster,
  renderCharacterNote,
} from '../src/campaign/character-extract.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const flagAll = (name) => args.map((a, i) => (a === name ? args[i + 1] : null)).filter(Boolean);

const guildId = args.find((a) => !a.startsWith('--') && !args.includes(`--${a}`) && /^\d{15,}$/.test(a));
const WRITE = args.includes('--write');
// Same reasoning as the NPC builder: the configured summariser is a budget
// model for cheap recaps, and reading thousands of lines of raw transcript
// for character detail is a different job.
const model = flag('--model', 'gemini-3.6-flash');
const dm = flag('--dm');

const roster = flagAll('--pc').map((entry) => {
  const [player, character] = entry.split('=');
  return { player: player.trim(), character: (character || '').trim() || null };
});

if (!guildId || roster.length === 0) {
  console.error(
    'usage: node scripts/build-character-notes.mjs <guildId> --pc <speaker>[=<character>] ... [--dm <speaker>] [--write]'
  );
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
console.log(`roster   : ${roster.map((r) => (r.character ? `${r.player} as ${r.character}` : r.player)).join(', ')}`);
if (dm) console.log(`dm       : ${dm}`);
console.log(`sessions : ${meetings.map((m) => m.session_number ?? m.id).join(', ')}\n`);

// The spellings the vault already links. Handed to the model so it carries
// them into aliases rather than orphaning links the notes already contain.
const ledger = await readKnownEntityNames(config, folder);
const existingNames = [...ledger.npcs, ...ledger.locations];

const cachePath = flag('--cache');
let cached = null;
if (cachePath) {
  cached = await readFile(cachePath, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  if (cached) console.log(`cache    : reusing ${cachePath} (no API calls)\n`);
}

const perSession = [];
for (const meeting of cached ? [] : meetings) {
  const utterances = db.listUtterances(meeting.id);
  if (utterances.length === 0) {
    console.log(`session ${meeting.session_number}: no transcript, skipped`);
    continue;
  }

  const transcript = buildTranscriptText(utterances);
  const sessionNumber = meeting.session_number ?? meeting.id;
  process.stdout.write(
    `session ${sessionNumber}: ${utterances.length} lines (${Math.round(transcript.length / 1024)}KB) … `
  );

  const started = Date.now();
  let text;
  try {
    text = await callModel(
      CHARACTER_SYSTEM_PROMPT,
      buildCharacterUserMessage({
        transcript,
        sessionNumber,
        date: (meeting.started_at || '').slice(0, 10),
        roster,
        dm,
        existingNames,
      }),
      cfg,
      20 * 60 * 1000
    );
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    continue;
  }

  const characters = parseCharacterResponse(text);
  console.log(`${characters.length} character(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  if (characters.length === 0 && text.trim()) {
    console.log(`  (unparsed response began: ${text.trim().slice(0, 120).replace(/\s+/g, ' ')}…)`);
  }
  perSession.push({ sessionNumber, characters });
}

if (cachePath && !cached && perSession.length) {
  await writeFile(cachePath, JSON.stringify(perSession, null, 2), 'utf8');
  console.log(`cache    : saved raw extraction to ${cachePath}`);
}

const merged = applyRoster(mergeCharacters(cached ?? perSession, roster), roster);

if (merged.unmatched?.length) {
  const ignored = merged.unmatched.map((u) => `${u.name} (s${u.sessionNumber})`).join(', ');
  console.log(`
ignored (matched nobody on the roster): ${ignored}`);
}

const missing = roster.filter(
  (r) => !merged.some((c) => c.player?.toLowerCase() === r.player.toLowerCase())
);
if (missing.length) {
  console.log(`\n⚠️  no note built for: ${missing.map((m) => m.player).join(', ')} — nothing found in the transcripts`);
}

if (args.includes('--json')) {
  console.log(JSON.stringify(merged, null, 2));
  process.exit(0);
}

console.log(`\n${merged.length} character(s):\n`);

// Anything the vault already knows about can be linked; anything else stays
// plain text so the vault doesn't fill with links to notes that never exist.
const knownEntities = [...ledger.npcs, ...ledger.locations, ...merged.map((c) => c.name)];
const outDir = join(config.obsidianExportDir, folder, 'Characters');

for (const pc of merged) {
  const filename = npcFileName(pc.name);
  if (!filename) {
    console.log(`  (skipped a character whose name produced no usable filename: ${JSON.stringify(pc.name)})`);
    continue;
  }

  const detail = [
    [pc.race, pc.class].filter(Boolean).join(' '),
    pc.player ? `played by ${pc.player}` : null,
    `sessions ${pc.sessions.join(', ')}`,
    pc.aliases.length ? `${pc.aliases.length} alias(es)` : null,
    pc.quotes.length ? `${pc.quotes.length} quote(s)` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  console.log(`  ${pc.name.padEnd(22)} ${detail}`);
  if (pc.aliases.length) console.log(`  ${''.padEnd(22)} aliases: ${pc.aliases.join(', ')}`);

  if (WRITE) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, filename), renderCharacterNote(pc, { campaign: campaignName, knownEntities }), 'utf8');
  }
}

if (WRITE) {
  const written = await readdir(outDir).catch(() => []);
  console.log(`\nWrote ${written.length} note(s) to ${outDir}`);
} else {
  console.log('\nDry run — re-run with --write to create the notes.');
}
