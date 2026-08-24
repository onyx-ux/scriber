#!/usr/bin/env node
// Builds one Obsidian note per PLAYER CHARACTER, read from the FULL session
// transcripts rather than the per-session summaries.
//
//   node scripts/build-character-notes.mjs <campaign|guildId> --dm "Old Dad" \
//     --pc "Brett=BenTen" --pc Aurion --pc Tad [--write]
//
// The roster comes from /dm character unless it is given on the command line.
// That command is where the DM already records who plays what, and having two
// places to keep it in step is how they drift. A --pc with no "=" means the
// speaker label and the character name are the same.
//
// The transcript only knows the DISCORD SPEAKER. "Brett" is a person; "BenTen"
// is who they play; and no amount of reading the transcript tells you reliably
// which speaker is the DM — hence --dm.
//
// Dry run by default. The run itself is campaign/entity-notes.js; this file is
// the command line and nothing else.
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import { buildEntityNotes, subjectNamed, entityCachePathFor } from '../src/campaign/entity-notes.js';
import { pickCampaign } from './lib/pick-campaign.mjs';
import { renderEntityRun, commonArgs } from './lib/render-entity-run.mjs';

const { flag, flagAll, which, write, json, cachePath, model } = commonArgs(process.argv);
const dm = flag('--dm');

if (!which) {
  console.error(
    'usage: node scripts/build-character-notes.mjs <campaign|guildId> [--pc <speaker>[=<character>] ...] [--dm <speaker>] [--write]'
  );
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'db.sqlite'));
const campaign = pickCampaign(db, which);
const subject = subjectNamed('characters');

// With no --cache given, the campaign's own cache in the vault -- the same one
// the pipeline reads and writes. They used to be different places, so a vault
// built by hand left nothing behind for an automatic update to merge against.
const cache = cachePath ?? entityCachePathFor(db, config, campaign, subject);


const roster = flagAll('--pc').length
  ? flagAll('--pc').map((entry) => {
      const [player, character] = entry.split('=');
      return { player: player.trim(), character: (character || '').trim() || null };
    })
  : db
      .listRoster(campaign.id)
      .filter((r) => r.characterName)
      .map((r) => ({ player: r.displayName, character: r.characterName }));

if (roster.length === 0) {
  console.error(
    'no roster: set one with /dm character in Discord, or pass --pc <speaker>[=<character>] for each player'
  );
  process.exit(1);
}

const cfg = { ...config, summaryProvider: 'gemini', geminiModel: model };

if (!json) {
  console.log(`roster   : ${roster.map((r) => (r.character ? `${r.player} as ${r.character}` : r.player)).join(', ')}`);
  if (dm) console.log(`dm       : ${dm}`);
}

const result = await buildEntityNotes({
  db,
  cfg,
  campaign,
  subject,
  extras: { roster, dm },
  cachePath: cache,
  write: write && !json,
  onEvent: json ? () => {} : renderEntityRun({ noun: 'character', model }),
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

if (json) console.log(JSON.stringify(result.records, null, 2));
