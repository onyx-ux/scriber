import { AttachmentBuilder } from 'discord.js';
import { pick, POST_SESSION_HEADER, POST_SESSION_ATTACHMENT_CAPTION } from '../flavor.js';

// These return null rather than "_none_" so empty sections can be dropped
// entirely. A recap that lists eight headings with "_none_" under seven of
// them buries the one part anyone actually reads.
function fmtList(items) {
  if (!items || items.length === 0) return null;
  return items.map((i) => `- ${i}`).join('\n');
}

function fmtFollowUps(items) {
  if (!items || items.length === 0) return null;
  return items.map((f) => `- ${f.assignee ? `**${f.assignee}:** ` : ''}${f.task}`).join('\n');
}

function fmtScenes(scenes) {
  if (!scenes || scenes.length === 0) return null;
  return scenes
    .map((s) => `**${s.title}**\n${fmtList(s.points) || '_no details_'}`)
    .join('\n\n');
}

// Discord messages cap at 2000 chars — long D&D recaps will exceed that, so
// this posts several messages in sequence rather than one giant one. All of
// them land directly in the channel, no thread is created (per requirement).
function chunk(text, size = 1900) {
  const parts = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut <= 0) cut = size;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function buildSessionBody(notes) {
  const sections = [];
  const add = (heading, content) => {
    if (content && String(content).trim()) sections.push(`## ${heading}\n${content}`);
  };

  add('📜 What Happened', notes.tldr);
  add('😂 Moments Worth Remembering', fmtList(notes.funnyMoments));
  add('⚔️ Scenes & Encounters', fmtScenes(notes.scenes));
  add('🗺️ Party Decisions', fmtList(notes.partyDecisions));
  add('❓ Unresolved Threads', fmtList(notes.unresolvedThreads));
  add('🧙 NPCs Introduced', fmtList(notes.npcsIntroduced));
  add('🗺️ Locations Visited', fmtList(notes.locationsVisited));
  add('💰 Loot & Rewards', fmtList(notes.lootAndRewards));
  add('📋 Before Next Session', fmtFollowUps(notes.followUps));

  // Everything empty means the summariser judged there was no real gameplay
  // (bot testing, off-topic chat) — say so plainly rather than posting a
  // skeleton of empty headings.
  if (sections.length === 0) {
    return '_Nothing substantial to report from this session._';
  }
  return sections.join('\n\n');
}

export async function postSessionNotes({ discordClient, meeting, notes, mdPath, cfg }) {
  const channelId = cfg.notesChannelId || meeting.channel_id;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[delivery] could not fetch channel ${channelId}, notes not posted`);
    return;
  }

  const date = (meeting.started_at || '').slice(0, 10);
  const header = pick(POST_SESSION_HEADER, { channel: meeting.channel_name, date });
  const full = `${header}\n\n${buildSessionBody(notes)}`;

  for (const part of chunk(full)) {
    // eslint-disable-next-line no-await-in-loop
    await channel.send({ content: part });
  }

  const attachment = new AttachmentBuilder(mdPath, {
    name: mdPath.split('/').pop(),
  });
  await channel.send({
    content: pick(POST_SESSION_ATTACHMENT_CAPTION),
    files: [attachment],
  });
}
