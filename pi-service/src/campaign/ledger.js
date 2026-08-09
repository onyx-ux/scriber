import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { splitEntryName, isUsableName } from './entry-name.js';
import { LEDGER_SUBFOLDER } from '../export/naming.js';
import { join } from 'node:path';

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Where the ledger used to live: "campaign/<guildId>-<slugified-channel>".
// Correct but unreadable — the vault showed a folder called
// "1341529060836380703-session" next to one called "Cipher", both belonging
// to the same campaign. Kept only so campaign/vault-migrate.js can find the
// old directories and move them; nothing writes here any more.
export function legacyCampaignDir(cfg, guildId, channelName) {
  return join(cfg.obsidianExportDir, 'campaign', `${guildId}-${slugify(channelName)}`);
}

// `folder` is the campaign's folder name — what export/naming.js
// campaignFolder() returns, i.e. the /campaign name or the channel it was
// recorded in. Taking it as a plain string rather than deriving it from a
// guild id keeps one rule for where a campaign's files go: session notes,
// per-NPC notes and the ledger all hang off the same folder.
function campaignDir(cfg, folder) {
  return join(cfg.obsidianExportDir, folder, LEDGER_SUBFOLDER);
}

// The remote mirrors the vault, so a campaign is one folder on Drive too.
export function campaignDirInfo(cfg, folder) {
  return {
    localDir: campaignDir(cfg, folder),
    remoteSubpath: `notes/${folder}/${LEDGER_SUBFOLDER}`,
  };
}

// Ledger entries are written as "Name — one-line description", but the model
// rephrases the description freely between sessions ("Vex the Bold, a
// smuggler" vs "Vex the Bold — smuggler from the docks"). Comparing whole
// lines therefore treats the same NPC as new every time. Key on the leading
// name only — everything before the first dash, comma or bracket — so
// re-mentions actually match.
function leadingName(line) {
  const bare = String(line)
    .replace(/^-\s*/, '')
    .replace(/\s*_\([^)]*\)_\s*$/, '');
  // Shared with the markdown exporter so the wikilink and the dedupe key can
  // never disagree about where a name ends — see campaign/entry-name.js.
  return splitEntryName(bare).name;
}

// The name as written, with any wikilink brackets removed. Stored entries
// legitimately contain them — the exporter links NPC and location names, and
// a repaired ledger has "- [[Bob]]: a merchant" on disk.
export function entryName(line) {
  return leadingName(line).replace(/\[\[|\]\]/g, '').trim();
}

// Brackets MUST be stripped here too, not just in entryName: a stored
// "[[Bob]]" would otherwise key as "[[bob]]" and never match an incoming
// "Bob", so every linked NPC would be re-appended to the ledger every single
// session — the exact duplication this key exists to prevent.
export function entryKey(line) {
  return entryName(line).toLowerCase();
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

// The same entries as readKnownEntities, but as names in the order and
// capitalisation they were written, newest last. Used to build the whisper
// vocabulary prompt, which is about spelling proper nouns correctly rather
// than about set membership.
async function readEntryNames(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().startsWith('-'))
      .map(entryName)
      .filter(Boolean);
  } catch {
    return []; // no ledger file yet
  }
}

export async function readKnownEntityNames(cfg, folder) {
  const dir = campaignDir(cfg, folder);
  const [npcs, locations] = await Promise.all([
    readEntryNames(join(dir, 'NPCs.md')),
    readEntryNames(join(dir, 'Locations.md')),
  ]);
  return { npcs, locations };
}

// What this campaign already knows about, so a session recap can omit
// NPCs/locations that were introduced in an earlier session rather than
// repeating the same entries every single week.
export async function readKnownEntities(cfg, folder) {
  const dir = campaignDir(cfg, folder);
  const [npcs, locations] = await Promise.all([
    readEntryKeys(join(dir, 'NPCs.md')),
    readEntryKeys(join(dir, 'Locations.md')),
  ]);
  return { npcs, locations };
}

// The ledger is the campaign's index, so its entries are linked the same way
// the session notes link them — otherwise NPCs.md is a dead list and the two
// files disagree about what an entry looks like. Only the leading name is
// wrapped; entryKey strips the brackets again so dedupe is unaffected.
//
// Not applied to Party-Decisions.md or Unresolved-Threads.md: those hold
// sentences, and linking "How the strange creatures were created." would make
// a note per plot point.
function ledgerEntry(item, wikilinks) {
  if (!wikilinks) return item;
  const { name, rest } = splitEntryName(item);
  return isUsableName(name) ? `[[${name}]]${rest}` : item;
}

async function appendUnique(filePath, title, newItems, sessionLabel, { wikilinks = false } = {}) {
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

  const additions = toAdd.map((item) => `- ${ledgerEntry(item, wikilinks)} _(${sessionLabel})_`).join('\n');
  const updated = existing.endsWith('\n') ? `${existing}${additions}\n` : `${existing}\n${additions}\n`;
  await writeFile(filePath, updated, 'utf8');
}

// Raw contents of one ledger file (e.g. NPCs.md), for commands that want to
// show the campaign's running list directly in Discord rather than making
// someone open Obsidian mid-session. Returns null rather than throwing when
// nothing's been recorded yet.
export async function readLedgerFile(cfg, folder, filename) {
  try {
    return await readFile(join(campaignDir(cfg, folder), filename), 'utf8');
  } catch {
    return null;
  }
}

export async function updateCampaignLedger({ meeting, notes, cfg, folder }) {
  const dir = campaignDir(cfg, folder);
  await mkdir(dir, { recursive: true });

  const sessionLabel = `session #${meeting.id}, ${(meeting.started_at || '').slice(0, 10)}`;

  // NPCs and locations are entities and get linked; decisions and threads are
  // sentences and do not.
  const linked = { wikilinks: cfg.obsidianWikilinks !== false };

  await Promise.all([
    appendUnique(join(dir, 'NPCs.md'), 'NPCs', notes.npcsIntroduced, sessionLabel, linked),
    appendUnique(join(dir, 'Locations.md'), 'Locations', notes.locationsVisited, sessionLabel, linked),
    appendUnique(join(dir, 'Party-Decisions.md'), 'Party Decisions', notes.partyDecisions, sessionLabel),
    appendUnique(join(dir, 'Unresolved-Threads.md'), 'Unresolved Threads', notes.unresolvedThreads, sessionLabel),
  ]);

  return dir;
}
