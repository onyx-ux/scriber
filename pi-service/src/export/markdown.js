import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function fmtList(items, empty = '_none_') {
  if (!items || items.length === 0) return empty;
  return items.map((i) => `- ${i}`).join('\n');
}

function fmtFollowUps(items) {
  if (!items || items.length === 0) return '_none_';
  return items
    .map((f) => `- [ ] ${f.assignee ? `**${f.assignee}:** ` : ''}${f.task}`)
    .join('\n');
}

function fmtScenes(scenes) {
  if (!scenes || scenes.length === 0) return '_none_';
  return scenes
    .map((s) => `### ${s.title}\n${fmtList(s.points, '_no details_')}`)
    .join('\n\n');
}

export function renderMarkdown({ meeting, utterances, notes }) {
  const date = (meeting.started_at || '').slice(0, 10);
  const attendees = [...new Set(utterances.map((u) => u.display_name))];

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

  const funnySection =
    notes.funnyMoments && notes.funnyMoments.length > 0
      ? `\n\n## Moments Worth Remembering\n${fmtList(notes.funnyMoments)}`
      : '';

  const body = `# Session Recap — ${meeting.channel_name} (${date})

## TL;DR
${notes.tldr || '_none_'}${funnySection}

## Scenes
${fmtScenes(notes.scenes)}

## Party Decisions
${fmtList(notes.partyDecisions)}

## Unresolved Threads
${fmtList(notes.unresolvedThreads)}

## NPCs Introduced
${fmtList(notes.npcsIntroduced)}

## Locations Visited
${fmtList(notes.locationsVisited)}

## Loot & Rewards
${fmtList(notes.lootAndRewards)}

## Follow-ups Before Next Session
${fmtFollowUps(notes.followUps)}

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
  await writeFile(path, renderMarkdown({ meeting, utterances, notes }), 'utf8');
  return path;
}
