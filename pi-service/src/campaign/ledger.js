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

// Ledger entries are written as "Name — one-line description", but the model
// rephrases the description freely between sessions ("Vex the Bold, a
// smuggler" vs "Vex the Bold — smuggler from the docks"). Comparing whole
// lines therefore treats the same NPC as new every time. Key on the leading
// name only — everything before the first dash, comma or bracket — so
// re-mentions actually match.
export function entryKey(line) {
  return String(line)
    .replace(/^-\s*/, '')
    .replace(/\s*_\([^)]*\)_\s*$/, '')
    .split(/\s+[—–-]\s+|,|\(/)[0]
    .trim()
    .toLowerCase();
}

// The set of entries already recorded in one ledger file.
async function readEntryKeys(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return new Set(
      raw
        .split('\n')
        .filter((l) => l.trim().startsWith('-'))
        .map(entryKey)
        .filter(Boolean)
    );
  } catch {
    return new Set(); // no ledger file yet
  }
}

// What this campaign already knows about, so a session recap can omit
// NPCs/locations that were introduced in an earlier session rather than
// repeating the same entries every single week.
export async function readKnownEntities(cfg, guildId, channelName) {
  const dir = campaignDir(cfg, guildId, channelName);
  const [npcs, locations] = await Promise.all([
    readEntryKeys(join(dir, 'NPCs.md')),
    readEntryKeys(join(dir, 'Locations.md')),
  ]);
  return { npcs, locations };
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
  const existingKeys = new Set(
    existing
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
      .map(entryKey)
      .filter(Boolean)
  );

  const toAdd = newItems.filter((item) => !existingKeys.has(entryKey(item)));
  if (toAdd.length === 0) return;

  const additions = toAdd.map((item) => `- ${item} _(${sessionLabel})_`).join('\n');
  const updated = existing.endsWith('\n') ? `${existing}${additions}\n` : `${existing}\n${additions}\n`;
  await writeFile(filePath, updated, 'utf8');
}

// Raw contents of one ledger file (e.g. NPCs.md), for commands that want to
// show the campaign's running list directly in Discord rather than making
// someone open Obsidian mid-session. Returns null rather than throwing when
// nothing's been recorded yet.
export async function readLedgerFile(cfg, guildId, channelName, filename) {
  try {
    return await readFile(join(campaignDir(cfg, guildId, channelName), filename), 'utf8');
  } catch {
    return null;
  }
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
