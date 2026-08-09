import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { splitEntryName, isUsableName } from '../campaign/entry-name.js';
import { linkifyEntities } from './linkify.js';
import { sessionNotePath, formatSessionNumber } from './naming.js';

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Only the leading name becomes a wikilink — see campaign/entry-name.js for
// why the split lives there and is shared with the ledger's dedupe key.
function wikiEntry(entry, enabled) {
  if (!enabled) return entry;
  const { name, rest } = splitEntryName(entry);
  if (!isUsableName(name)) return entry;
  return `[[${name}]]${rest}`;
}

function fmtList(items, { wikilinks = false } = {}) {
  if (!items || items.length === 0) return null;
  return items.map((i) => `- ${wikiEntry(i, wikilinks)}`).join('\n');
}

function fmtFollowUps(items) {
  if (!items || items.length === 0) return null;
  return items.map((f) => `- [ ] ${f.assignee ? `**${f.assignee}:** ` : ''}${f.task}`).join('\n');
}

function fmtScenes(scenes) {
  if (!scenes || scenes.length === 0) return null;
  return scenes.map((s) => `### ${s.title}\n${fmtList(s.points) || '_no details_'}`).join('\n\n');
}

function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Who actually talked. Word share is the primary measure because it always
// works; talk time is only shown when the durations are real (a session
// rebuilt by crash-recovery has no end timestamps, so every duration is 0).
export function fmtSpeakerStats(utterances) {
  if (!utterances || utterances.length === 0) return null;

  const byName = new Map();
  for (const u of utterances) {
    const name = u.display_name ?? u.displayName ?? 'unknown';
    const words = String(u.text || '').trim().split(/\s+/).filter(Boolean).length;
    const start = u.start_ms ?? u.startMs ?? 0;
    const end = u.end_ms ?? u.endMs ?? 0;
    const stat = byName.get(name) || { lines: 0, words: 0, ms: 0 };
    stat.lines += 1;
    stat.words += words;
    stat.ms += Math.max(0, end - start);
    byName.set(name, stat);
  }

  const rows = [...byName.entries()].sort((a, b) => b[1].words - a[1].words);
  const totalWords = rows.reduce((sum, [, s]) => sum + s.words, 0);
  const hasTiming = rows.some(([, s]) => s.ms > 0);
  if (totalWords === 0) return null;

  const header = hasTiming
    ? '| Speaker | Lines | Words | Share | Talk time |\n|---|---:|---:|---:|---:|'
    : '| Speaker | Lines | Words | Share |\n|---|---:|---:|---:|';

  const body = rows
    .map(([name, s]) => {
      const share = `${Math.round((s.words / totalWords) * 100)}%`;
      return hasTiming
        ? `| ${name} | ${s.lines} | ${s.words} | ${share} | ${fmtDuration(s.ms)} |`
        : `| ${name} | ${s.lines} | ${s.words} | ${share} |`;
    })
    .join('\n');

  return `${header}\n${body}`;
}

export function renderMarkdown({ meeting, utterances, notes, cfg = {}, entities = [], entityTargets = null, campaignName = null }) {
  const date = (meeting.started_at || '').slice(0, 10);
  const attendees = [...new Set(utterances.map((u) => u.display_name))];
  const wikilinks = cfg.obsidianWikilinks !== false;

  const campaign = campaignName || meeting.channel_name;
  // The per-campaign number, which is what the filename uses. meeting_id is
  // kept too: it is what /summarise, /export and the logs refer to, and the
  // two are no longer the same thing.
  const sessionNo = formatSessionNumber(meeting.session_number ?? meeting.id) ?? '00';

  const frontmatter = [
    '---',
    `title: "Session ${sessionNo} — ${campaign} — ${date}"`,
    `date: ${date}`,
    `campaign: "${campaign}"`,
    `session: ${sessionNo}`,
    `tags: [dnd-session, ${slugify(campaign)}]`,
    `attendees: [${attendees.map((a) => `"${a}"`).join(', ')}]`,
    `meeting_id: ${meeting.id}`,
    '---',
    '',
  ].join('\n');

  // Sections with nothing in them are omitted rather than printed as
  // "_none_" — a page of empty headings buries the parts worth reading.
  const sections = [];
  const add = (heading, content) => {
    if (content && String(content).trim()) sections.push(`## ${heading}\n${content}`);
  };

  add('TL;DR', notes.tldr);
  add('Moments Worth Remembering', fmtList(notes.funnyMoments));
  add('Scenes', fmtScenes(notes.scenes));
  add('Party Decisions', fmtList(notes.partyDecisions));
  add('Unresolved Threads', fmtList(notes.unresolvedThreads));
  add('NPCs Introduced', fmtList(notes.npcsIntroduced, { wikilinks }));
  add('Locations Visited', fmtList(notes.locationsVisited, { wikilinks }));
  add('Loot & Rewards', fmtList(notes.lootAndRewards));
  add('Follow-ups Before Next Session', fmtFollowUps(notes.followUps));

  // Kept apart from the summary sections above: speaker stats are derived
  // from the audio, not from the AI, so they're present even when the
  // summariser found nothing. Counting them as content would mask an empty
  // summary behind a table nobody asked about.
  const recapText = sections.length
    ? sections.join('\n\n')
    : '_Nothing substantial to report from this session._';

  // Link known NPCs/locations where they're MENTIONED, not just where they're
  // listed — that's what actually connects a session to the rest of the
  // campaign in Obsidian's graph. Applied to the recap only: the transcript
  // below is thousands of lines and linking through it would bury the prose
  // and make the note enormous for no benefit.
  const recap = wikilinks ? linkifyEntities(recapText, entities, { targets: entityTargets }) : recapText;

  const stats = fmtSpeakerStats(utterances);
  const afterRecap = stats ? `${recap}\n\n## Who Talked\n${stats}` : recap;

  const body = `# Session ${sessionNo} — ${campaign} (${date})

${afterRecap}

---

## Full Transcript

${utterances.map((u) => `**[${u.start_ms}] ${u.display_name}:** ${u.text}`).join('\n\n')}
`;

  return frontmatter + body;
}

// campaignName comes from /campaign; without one the channel name is used.
// See export/naming.js for why the old flat "<date>-<channel>-session-<id>.md"
// was replaced by "<Campaign>/Session 02.md".
export async function exportMarkdown({ meeting, utterances, notes, cfg, entities = [], entityTargets = null, campaignName = null }) {
  const { folder, filename } = sessionNotePath(meeting, campaignName);
  const dir = join(cfg.obsidianExportDir, folder);
  await mkdir(dir, { recursive: true });

  const path = join(dir, filename);
  await writeFile(path, renderMarkdown({ meeting, utterances, notes, cfg, entities, entityTargets, campaignName }), 'utf8');
  return path;
}
