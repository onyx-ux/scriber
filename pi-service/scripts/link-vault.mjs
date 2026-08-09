// Links every name the vault knows about, everywhere it is mentioned.
//
//   node scripts/link-vault.mjs <guildId|folder>          # dry run
//   node scripts/link-vault.mjs <guildId|folder> --write
//
// The exporter links a session recap as it writes it, but only against the
// names the ledger held AT THAT MOMENT. The per-entity notes under NPCs/ and
// Locations/ came later and carry the alias lists — so notes written before
// them mention "Yusdrayl" and "Kaltrix" as plain text with nothing to click.
// This pass fixes that across the whole campaign, and can be re-run whenever
// the entity notes are rebuilt. campaign/vault-linker.js does the editing and
// documents what it refuses to touch; this script decides which files to feed
// it and prints the diff.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { config } from '../src/config/env.js';
import { openDb } from '../src/store/db.js';
import { campaignFolder } from '../src/export/naming.js';
import { readVaultEntities, buildNameIndex, addPlainNames } from '../src/campaign/vault-index.js';
import { linkifyNote } from '../src/campaign/vault-linker.js';
import { readKnownEntityNames } from '../src/campaign/ledger.js';

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('link-vault.mjs')) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const which = args.find((a) => !a.startsWith('--'));
  if (!which) {
    console.error('usage: node scripts/link-vault.mjs <guildId|folder> [--write]');
    process.exit(1);
  }

  // A bare guild id resolves through the database; anything else is taken as
  // the campaign folder name directly, so the script still works on a vault
  // copied off the Pi.
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
  const entities = await readVaultEntities(config, folder);

  // Ledger entries with no note of their own are folded in as well. The
  // ambiguous ones stay out: "Talgan and Sharwin" is a single ledger entry
  // naming two people, and both their notes claim it as an alias, so a link
  // would resolve to whichever Obsidian happened to index first. Left
  // unlinked, the two individual names in the same sentence get linked
  // instead — which is what was wanted anyway.
  const ledger = await readKnownEntityNames(config, folder);
  const { targets, ambiguous } = addPlainNames(buildNameIndex(entities), [...ledger.npcs, ...ledger.locations]);

  console.log(`campaign : ${folder}`);
  console.log(`entities : ${entities.length} note(s), ${targets.size} linkable name(s)`);
  for (const { alias, owners } of ambiguous) {
    console.log(`  skipped ambiguous "${alias}" — claimed by ${owners.join(' and ')}`);
  }
  console.log(write ? 'mode     : WRITING\n' : 'mode     : dry run (pass --write to apply)\n');

  const files = [];
  for (const f of await readdir(root, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith('.md')) files.push({ path: join(root, f.name), mode: 'section' });
  }
  for (const sub of ['NPCs', 'Locations', 'Ledger']) {
    const dir = join(root, sub);
    const listing = await readdir(dir).catch(() => []);
    for (const name of listing.filter((n) => n.endsWith('.md'))) {
      files.push({ path: join(dir, name), mode: sub === 'Ledger' ? 'item' : 'section' });
    }
  }

  let changedFiles = 0;
  let changedLinks = 0;

  for (const { path, mode } of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const original = await readFile(path, 'utf8');

    // Never link a note to itself, and never link its own aliases inside it.
    const self = basename(path, '.md');
    const own = new Set([self, ...(entities.find((e) => e.name === self)?.aliases ?? [])]);
    const names = [...targets.keys()].filter((n) => !own.has(n));

    const updated = linkifyNote(original, { names, targets, mode });
    if (updated === original) continue;

    const added = (updated.match(/\[\[/g) || []).length - (original.match(/\[\[/g) || []).length;
    changedFiles++;
    changedLinks += added;
    console.log(`  ${String(added).padStart(3)} link(s)  ${path.slice(config.obsidianExportDir.length + 1)}`);

    const before = original.split('\n');
    for (const [i, line] of updated.split('\n').entries()) {
      if (before[i] !== undefined && before[i] !== line) console.log(`        - ${before[i]}\n        + ${line}`);
    }

    if (write) await writeFile(path, updated, 'utf8');
  }

  console.log(`\n${changedLinks} link(s) across ${changedFiles} file(s)${write ? ' — written' : ' — dry run'}`);
}
