import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Ledger-style entries look like "Vex the Bold — a smuggler from the docks".
// Split the leading name off the description so only the name becomes a
// wikilink; linking the whole sentence would create one useless note per
// phrasing variation.
function splitEntry(entry) {
  const s = String(entry).trim();
  const m = s.match(/^(.*?)(\s+[—–-]\s+|,\s+|\s+\()/);
  if (!m) return { name: s, rest: '' };
  return { name: m[1].trim(), rest: s.slice(m[1].length) };
}

function wikiEntry(entry, enabled) {
  if (!enabled) return entry;
  const { name, rest } = splitEntry(entry);
  // Guard against the model returning a whole sentence with no clear name —
  // a 200-character wikilink is worse than no wikilink.
  if (!name || name.length > 60 || !/[a-z]/i.test(name)) return entry;
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

export function renderMarkdown({ meeting, utterances, notes, cfg = {} }) {
  const date = (meeting.started_at || '').slice(0, 10);
  const attendees = [...new Set(utterances.map((u) => u.display_name))];
  const wikilinks = cfg.obsidianWikilinks !== false;

  const frontmatter = [
    '---',
    `title: "Session — ${meeting.channel_name} — ${date}"`,
    `date: ${date}`,
    `tags: [dnd-session, ${slugify(meeting.channel_name)}]`,
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
  const recap = sections.length
    ? sections.join('\n\n')
    : '_Nothing substantial to report from this session._';
  const stats = fmtSpeakerStats(utterances);
  const afterRecap = stats ? `${recap}\n\n## Who Talked\n${stats}` : recap;

  const body = `# Session Recap — ${meeting.channel_name} (${date})

${afterRecap}

---

## Full Transcript

${utterances.map((u) => `**[${u.start_ms}] ${u.display_name}:** ${u.text}`).join('\n\n')}
`;

  return frontmatter + body;
}

export async function exportMarkdown({ meeting, utterances, notes, cfg }) {
  await mkdir(cfg.obsidianExportDir, { recursive: true });
  const date = (meeting.started_at || '').slice(0, 10);
  const filename = `${date}-${slugify(meeting.channel_name)}-session-${meeting.id}.md`;
  const path = join(cfg.obsidianExportDir, filename);
  await writeFile(path, renderMarkdown({ meeting, utterances, notes, cfg }), 'utf8');
  return path;
}
