// Moves vault folders when the naming rules change underneath them.
//
// Two things can strand a campaign's files:
//
//   * the ledger used to be filed under "campaign/<guildId>-<channel-slug>",
//     which is unreadable and unrelated to the "<Campaign>/" folder the
//     session notes go in;
//   * /campaign renames the campaign, and everything exported under the old
//     name stays behind under the old name.
//
// Both are handled here rather than by leaving the old files where they are
// and reading from two places: a ledger that is half in one folder and half
// in another silently stops deduplicating, and re-introduces every NPC the
// campaign has ever met on the next session.
import { mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { campaignFolder } from '../export/naming.js';
import { campaignDirInfo } from './ledger.js';

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Moves every file out of `from` into `to`. A file that already exists at the
// destination is LEFT WHERE IT IS rather than overwritten — the destination
// is the newer copy by definition (nothing wrote there before this
// migration), and losing a hand-edited ledger to an automatic move at
// startup is a much worse outcome than leaving one stray file behind.
async function mergeInto(from, to, { apply }) {
  const entries = await readdir(from, { withFileTypes: true });
  const moved = [];
  const skipped = [];

  if (apply) await mkdir(to, { recursive: true });

  for (const entry of entries) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (await exists(dest)) {
      skipped.push(entry.name);
      continue;
    }
    if (apply) await rename(src, dest);
    moved.push(entry.name);
  }

  // Only tidy up the old directory when nothing was left behind in it.
  // rmdir, deliberately: it refuses on a non-empty directory, so a file this
  // migration didn't account for stops the delete instead of being erased.
  if (apply && skipped.length === 0) {
    await rmdir(from).catch(() => {});
  }

  return { moved, skipped };
}

// campaign/1341529060836380703-session -> Cipher/Ledger
//
// The guild id is the part before the first dash. It is the only piece of
// that name that identifies anything, which is the whole reason for the
// rename: the slug half was the Discord channel, so a campaign spanning a
// renamed channel could produce two ledger folders for one campaign.
export async function planLedgerMigration({ db, cfg }) {
  const legacyRoot = join(cfg.obsidianExportDir, 'campaign');
  if (!(await isDirectory(legacyRoot))) return [];

  const campaigns = db.listCampaigns();
  const plan = [];

  for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const guildId = entry.name.split('-')[0];
    const campaign = campaigns.find((c) => c.guild_id === guildId);
    if (!campaign) {
      // A ledger for a server the database has no sessions for. Renaming it
      // would be a guess, so say so and leave it alone.
      plan.push({ from: join(legacyRoot, entry.name), to: null, reason: 'no campaign matches this guild id' });
      continue;
    }

    const folder = campaignFolder(
      { guild_id: campaign.guild_id, channel_name: campaign.channel_name },
      campaign.name
    );
    plan.push({ from: join(legacyRoot, entry.name), to: campaignDirInfo(cfg, folder).localDir, folder });
  }

  return plan;
}

export async function migrateLedgerFolders({ db, cfg, apply = true }) {
  const plan = await planLedgerMigration({ db, cfg });
  const results = [];

  for (const step of plan) {
    if (!step.to) {
      results.push({ ...step, moved: [], skipped: [] });
      continue;
    }
    // A legacy dir that was already migrated (and left behind because a file
    // clashed) shouldn't be re-reported as work every boot.
    const { moved, skipped } = await mergeInto(step.from, step.to, { apply });
    if (moved.length || skipped.length) results.push({ ...step, moved, skipped });
  }

  // The old "campaign/" root has no purpose once it's empty.
  if (apply) {
    await rmdir(join(cfg.obsidianExportDir, 'campaign')).catch(() => {});
  }

  return results;
}

// Follows a /campaign rename: "Crack Animal Zoo/" -> "testhouse2/", session
// notes, per-NPC notes, Ledger and all. Without this the old folder is
// orphaned — the notes are still readable, but the next session starts a
// fresh folder and the ledger starts a fresh (empty) NPC list.
export async function moveCampaignFolder({ cfg, from, to, apply = true }) {
  if (!from || !to || from === to) return { moved: false, reason: 'nothing to move' };

  const src = join(cfg.obsidianExportDir, from);
  const dest = join(cfg.obsidianExportDir, to);
  if (!(await isDirectory(src))) return { moved: false, reason: 'no folder under the old name' };

  if (!(await exists(dest))) {
    if (apply) await rename(src, dest);
    return { moved: true, from, to, whole: true };
  }

  // Renaming onto a folder that already exists (e.g. renaming back to a name
  // used before) merges rather than clobbers.
  const { moved, skipped } = await mergeInto(src, dest, { apply });
  return { moved: moved.length > 0, from, to, files: moved, skipped };
}
