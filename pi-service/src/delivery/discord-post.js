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

// Where a finished session's notes go.
//
// The default is the server channel the session happened in, which is right
// when the whole table wants the recap. Setting NOTES_TO_OWNER_DM sends them
// to one person's DMs instead, so the bot can be used across several servers
// without each one needing a notes channel set up — the notes follow the
// owner rather than the guild.
//
// Falls back to the channel rather than failing: a DM can be refused by the
// recipient's privacy settings (Discord returns 50007, "cannot send messages
// to this user"), and losing a session's notes over that would be far worse
// than posting them where they would have gone anyway.
async function resolveDestination(discordClient, meeting, cfg) {
  if (cfg.notesToOwnerDm && cfg.ownerUserId) {
    const owner = await discordClient.users.fetch(cfg.ownerUserId).catch(() => null);
    const dm = owner ? await owner.createDM().catch(() => null) : null;
    if (dm) return { channel: dm, viaDm: true };
    console.warn(`[delivery] could not open a DM with ${cfg.ownerUserId} — falling back to the session channel`);
  }

  const channelId = cfg.notesChannelId || meeting.channel_id;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  return { channel, viaDm: false, channelId };
}

export async function postSessionNotes({ discordClient, meeting, notes, mdPath, cfg }) {
  const { channel, viaDm, channelId } = await resolveDestination(discordClient, meeting, cfg);
  if (!channel) {
    console.error(`[delivery] could not fetch channel ${channelId}, notes not posted`);
    return;
  }
  if (viaDm) console.log(`[delivery] meeting ${meeting.id}: notes sent to the owner's DMs`);

  const date = (meeting.started_at || '').slice(0, 10);
  const header = pick(POST_SESSION_HEADER, { channel: meeting.channel_name, date });
  const full = `${header}\n\n${buildSessionBody(notes)}`;

  for (const part of chunk(full)) {
    // eslint-disable-next-line no-await-in-loop
    await channel.send({ content: part });
  }

  // The transcript attachment is a convenience — the same markdown is already
  // in the Obsidian export and on Drive. Losing it must not fail the job,
  // because the notes above have ALREADY been posted by this point: a throw
  // here sends the whole summarise job back to the queue, which re-runs the
  // summariser (a real API cost) and re-posts these same notes on every
  // retry, forever, for a permission the retry cannot change.
  //
  // Seen in practice with "Missing Permissions": the bot had SendMessages but
  // not AttachFiles in the notes channel, so every attempt duplicated the
  // recap and then failed at the last step.
  try {
    const attachment = new AttachmentBuilder(mdPath, {
      name: mdPath.split('/').pop(),
    });
    await channel.send({
      content: pick(POST_SESSION_ATTACHMENT_CAPTION),
      files: [attachment],
    });
  } catch (err) {
    const hint =
      err.code === 50013 || /Missing Permissions/i.test(err.message)
        ? ' — the bot needs the "Attach Files" permission in this channel'
        : '';
    console.warn(
      `[delivery] meeting ${meeting.id}: notes posted, but the transcript file could not be attached (${err.message})${hint}. ` +
        `The markdown is still in the Obsidian export.`
    );
  }
}
