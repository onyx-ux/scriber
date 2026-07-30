import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function campaignDir(cfg, guildId, channelName) {
  return join(cfg.obsidianExportDir, 'campaign', `${guildId}-${slugify(channelName)}`);
}

export function campaignDirInfo(cfg, guildId, channelName) {
  const slug = `${guildId}-${slugify(channelName)}`;
  return { localDir: campaignDir(cfg, guildId, channelName), remoteSubpath: `campaign/${slug}` };
}

async function appendUnique(filePath, title, newItems, sessionLabel) {
  if (!newItems || newItems.length === 0) return;

  let existing = '';
  try {
    existing = await readFile(filePath, 'utf8');
  } catch {
    existing = `# ${title}\n\n`;
  }

  // Dedupe against existing lines (case-insensitive, trimmed) so re-running
  // a session's summary or mentioning the same NPC twice doesn't pile up
  // duplicate entries over a long campaign. Every stored line carries a
  // trailing "_(session #N, date)_" annotation that a fresh incoming item
  // never has — that suffix has to be stripped before comparing, otherwise
  // nothing ever matches and every re-mention (which is the whole point of
  // deduping — NPCs/locations recur across sessions) piles up as a "new"
  // duplicate entry instead of being recognized as one.
  const existingLower = new Set(
    existing
      .split('\n')
      .map((l) =>
        l
          .replace(/^-\s*/, '')
          .replace(/\s*_\([^)]*\)_\s*$/, '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );

  const toAdd = newItems.filter((item) => !existingLower.has(item.trim().toLowerCase()));
  if (toAdd.length === 0) return;

  const additions = toAdd.map((item) => `- ${item} _(${sessionLabel})_`).join('\n');
  const updated = existing.endsWith('\n') ? `${existing}${additions}\n` : `${existing}\n${additions}\n`;
  await writeFile(filePath, updated, 'utf8');
}

export async function updateCampaignLedger({ meeting, notes, cfg }) {
  const dir = campaignDir(cfg, meeting.guild_id, meeting.channel_name);
  await mkdir(dir, { recursive: true });

  const sessionLabel = `session #${meeting.id}, ${(meeting.started_at || '').slice(0, 10)}`;

  await Promise.all([
    appendUnique(join(dir, 'NPCs.md'), 'NPCs', notes.npcsIntroduced, sessionLabel),
    appendUnique(join(dir, 'Locations.md'), 'Locations', notes.locationsVisited, sessionLabel),
    appendUnique(join(dir, 'Party-Decisions.md'), 'Party Decisions', notes.partyDecisions, sessionLabel),
    appendUnique(join(dir, 'Unresolved-Threads.md'), 'Unresolved Threads', notes.unresolvedThreads, sessionLabel),
  ]);

  return dir;
}
