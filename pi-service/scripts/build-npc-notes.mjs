#!/usr/bin/env node
// Builds one Obsidian note per NPC for a campaign, read from the FULL session
// transcripts rather than the per-session summaries.
//
//   node scripts/build-npc-notes.mjs <campaign|guildId> [--write] [--model <name>]
//                                    [--cache <file>] [--json]
//
// Dry run by default: prints what it found and what it would write. The
// transcripts are large, so each session costs a real API call either way —
// the dry run exists to check the extraction before it touches the vault, not
// to avoid the call. --cache saves the raw extraction so the notes can be
// rebuilt from it offline.
//
// The run itself is campaign/entity-notes.js, shared with the location and
// character builders. This file is the command line and nothing else.
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import { buildEntityNotes, subjectNamed, entityCachePathFor } from '../src/campaign/entity-notes.js';
import { rosterNames } from '../src/campaign/character-names.js';
import { pickCampaign } from './lib/pick-campaign.mjs';
import { renderEntityRun, commonArgs } from './lib/render-entity-run.mjs';

const { args, which, write, json, cachePath, model } = commonArgs(process.argv);

if (!which) {
  console.error('usage: node scripts/build-npc-notes.mjs <campaign|guildId> [--write] [--model <name>]');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'db.sqlite'));

// The argument used to be a guild id, back when a guild was a campaign.
// It still may be — pickCampaign takes an id, a guild or a name, and
// refuses to guess when a guild holds several.
const campaign = pickCampaign(db, which);
const subject = subjectNamed('npcs');

// With no --cache given, the campaign's own cache in the vault -- the same one
// the pipeline reads and writes. They used to be different places, so a vault
// built by hand left nothing behind for an automatic update to merge against.
const cache = cachePath ?? entityCachePathFor(db, config, campaign, subject);

const cfg = { ...config, summaryProvider: 'gemini', geminiModel: model };

const result = await buildEntityNotes({
  db,
  cfg,
  campaign,
  subject,
  // Who is NOT an NPC. A player whose character is named something other than
  // their Discord name was being written up as a stranger the party met.
  extras: { playerCharacters: rosterNames(db, campaign.id) },
  cachePath: cache,
  // --json dumps the merged records so the extraction can be reviewed before it
  // is turned into notes — the transcripts are read once, the vault is written
  // to separately.
  write: write && !json,
  onEvent: json ? () => {} : renderEntityRun({ noun: 'NPC', model }),
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

if (json) console.log(JSON.stringify(result.records, null, 2));
