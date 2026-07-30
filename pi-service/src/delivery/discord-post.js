import { AttachmentBuilder } from 'discord.js';

function fmtList(items, empty = '_none_') {
  if (!items || items.length === 0) return empty;
  return items.map((i) => `- ${i}`).join('\n');
}

function fmtFollowUps(items) {
  if (!items || items.length === 0) return '_none_';
  return items.map((f) => `- ${f.assignee ? `**${f.assignee}:** ` : ''}${f.task}`).join('\n');
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

export async function postSessionNotes({ discordClient, meeting, notes, mdPath, cfg }) {
  const channelId = cfg.notesChannelId || meeting.channel_id;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[delivery] could not fetch channel ${channelId}, notes not posted`);
    return;
  }

  const date = (meeting.started_at || '').slice(0, 10);
  const header = `# 🐉 Session Recap — ${meeting.channel_name} (${date})`;

  const body = `## 📜 What Happened
${notes.tldr || '_none_'}

## ⚔️ Scenes & Encounters
${(notes.scenes || []).map((s) => `**${s.title}**\n${fmtList(s.points, '_no details_')}`).join('\n\n') || '_none_'}

## 🗺️ Party Decisions
${fmtList(notes.partyDecisions)}

## ❓ Unresolved Threads
${fmtList(notes.unresolvedThreads)}

## 🧙 NPCs Introduced
${fmtList(notes.npcsIntroduced)}

## 🗺️ Locations Visited
${fmtList(notes.locationsVisited)}

## 💰 Loot & Rewards
${fmtList(notes.lootAndRewards)}

## 📋 Before Next Session
${fmtFollowUps(notes.followUps)}`;

  const full = `${header}\n\n${body}`;

  for (const part of chunk(full)) {
    // eslint-disable-next-line no-await-in-loop
    await channel.send({ content: part });
  }

  const attachment = new AttachmentBuilder(mdPath, {
    name: mdPath.split('/').pop(),
  });
  await channel.send({
    content: '📎 Full session markdown (transcript + notes) — drop into Obsidian:',
    files: [attachment],
  });
}
