#!/usr/bin/env node
// One Obsidian note per place, built from the FULL session transcripts.
//
//   node scripts/build-location-notes.mjs <campaign|guildId> [--write]
//                                         [--model <name>] [--cache <file>] [--json]
//
// Run this AFTER build-npc-notes.mjs: a place's note names who lives there, and
// those link to real pages only if the NPC notes already exist.
//
// Dry run by default, same as the other builders. The run itself is
// campaign/entity-notes.js; this file is the command line and nothing else.
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import { buildEntityNotes, subjectNamed, entityCachePathFor } from '../src/campaign/entity-notes.js';
import { pickCampaign } from './lib/pick-campaign.mjs';
import { renderEntityRun, commonArgs } from './lib/render-entity-run.mjs';

const { which, write, json, cachePath, model } = commonArgs(process.argv);

if (!which) {
  console.error('usage: node scripts/build-location-notes.mjs <campaign|guildId> [--write] [--model <name>]');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'db.sqlite'));
const campaign = pickCampaign(db, which);
const subject = subjectNamed('locations');

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
  cachePath: cache,
  write: write && !json,
  onEvent: json ? () => {} : renderEntityRun({ noun: 'place', model }),
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

if (json) console.log(JSON.stringify(result.records, null, 2));
