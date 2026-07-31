// MessageFlags.Ephemeral replaces the old `ephemeral: true` reply option,
// which discord.js deprecated and drops entirely in v15.
import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startCapture } from '../voice/capture.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
import { isOllamaReachable } from '../pipeline/summarize-client.js';
import { finishSession } from '../pipeline/finish-session.js';
import { resolveSpeakerName } from '../campaign/character-names.js';
import {
  pick,
  JOIN_NO_CHANNEL,
  JOIN_ALREADY_RECORDING,
  JOIN_STARTED,
  JOIN_FAILED,
  LEAVE_NOT_RECORDING,
  LEAVE_START,
  LEAVE_NOTHING_USABLE,
  LEAVE_SUMMARIZING_NOW,
  LEAVE_SUMMARY_QUEUED,
  HISTORY_EMPTY,
  SUMMARIZE_UNREACHABLE,
  SUMMARIZE_QUEUED,
  EXPORT_INTRO,
  SETCHARACTER_CONFIRM,
  STATUS_IDLE,
  STATUS_QUEUED_HEADER,
  RECAP_NONE,
  RECAP_HEADER,
  FUNNY_NONE,
  FUNNY_HEADER,
  SEARCH_NONE,
  SEARCH_HEADER,
  GENERIC_ERROR,
} from '../flavor.js';

// active sessions keyed by guildId, since one bot instance can only sensibly
// record one channel per guild at a time
export const activeSessions = new Map();

// Guilds with a /join currently in flight but not yet registered above.
// Guards the window between the "already recording?" check and the session
// actually landing in activeSessions (see handleJoin).
const startingGuilds = new Set();

export const commandDefs = [
  new SlashCommandBuilder().setName('join').setDescription('Start recording this voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop recording, transcribe, and queue the summary'),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('List recent sessions')
    .addIntegerOption((o) => o.setName('count').setDescription('How many to show').setRequired(false)),
  new SlashCommandBuilder()
    .setName('summarise')
    .setDescription('Retry summarisation now for a meeting (useful right after turning your PC on)')
    .addIntegerOption((o) => o.setName('meeting_id').setDescription('Meeting ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Get the raw audio + transcript for a meeting')
    .addIntegerOption((o) => o.setName('meeting_id').setDescription('Meeting ID').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setcharacter')
    .setDescription('Map your Discord account to your D&D character name for transcripts/notes')
    .addStringOption((o) => o.setName('name').setDescription('Character name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show what is currently queued/retrying (e.g. waiting on your PC)'),
  new SlashCommandBuilder()
    .setName('recap')
    .setDescription("Post last session's TL;DR again"),
  new SlashCommandBuilder()
    .setName('funny')
    .setDescription('Pull a random funny or memorable moment from this campaign\'s history'),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search every transcript in this campaign for a word or phrase')
    .addStringOption((o) =>
      o.setName('query').setDescription('Word or phrase to look for (e.g. an NPC name)').setRequired(true)
    ),
].map((c) => c.toJSON());

export function registerCommandHandlers(client, db, cfg) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      // Each handler must be awaited here, not just returned — "return
      // handleX(...)" hands back the promise without keeping this try block
      // on the stack, so a rejection later on (e.g. the voice connection
      // timing out well after the initial reply) would silently become an
      // unhandled rejection instead of being caught below.
      if (interaction.commandName === 'join') return await handleJoin(interaction, db, cfg);
      if (interaction.commandName === 'leave') return await handleLeave(interaction, db, cfg);
      if (interaction.commandName === 'history') return await handleHistory(interaction, db);
      if (interaction.commandName === 'summarise') return await handleSummarizeNow(interaction, db, cfg);
      if (interaction.commandName === 'export') return await handleExport(interaction, db, cfg);
      if (interaction.commandName === 'setcharacter') return await handleSetCharacter(interaction, db);
      if (interaction.commandName === 'status') return await handleStatus(interaction, db, cfg);
      if (interaction.commandName === 'recap') return await handleRecap(interaction, db);
      if (interaction.commandName === 'funny') return await handleFunny(interaction, db);
      if (interaction.commandName === 'search') return await handleSearch(interaction, db);
    } catch (err) {
      console.error(`[command:${interaction.commandName}] error:`, err);
      const reply = { content: pick(GENERIC_ERROR, { message: err.message }), flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  });
}

async function handleJoin(interaction, db, cfg) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: pick(JOIN_NO_CHANNEL), flags: MessageFlags.Ephemeral });
  }
  if (activeSessions.has(interaction.guildId) || startingGuilds.has(interaction.guildId)) {
    return interaction.reply({ content: pick(JOIN_ALREADY_RECORDING), flags: MessageFlags.Ephemeral });
  }

  // Claim the guild before the first await. Everything below is async — the
  // defer, then up to ~20s waiting on the voice connection — and the session
  // isn't registered in activeSessions until the very end, so two /join
  // commands issued close together would both clear the check above and both
  // start capturing, into two different directories.
  startingGuilds.add(interaction.guildId);
  try {
    // Defer instead of replying immediately — we don't actually know the join
    // succeeded until the voice connection reaches Ready (which can take up to
    // ~20s), and claiming "recording started" before that was confirmed is
    // exactly what caused a silent failure to look like a successful /join.
    await interaction.deferReply();

    const audioDir = join(cfg.dataDir, 'audio', `${interaction.guildId}-${Date.now()}`);
    await mkdir(audioDir, { recursive: true });

    const capturedUtterances = [];

    const handle = startCapture({
      channel: voiceChannel,
      guildId: interaction.guildId,
      audioDir,
      getDisplayName: async (userId) => {
        const m = await interaction.guild.members.fetch(userId).catch(() => null);
        const discordName = m?.displayName || userId;
        // Prefer the player's set D&D character name over their Discord name,
        // so transcripts/notes read like a session recap, not a Discord log.
        return resolveSpeakerName(db, interaction.guildId, userId, discordName);
      },
      onUtterance: (userId, displayName, wavPath, startMs, endMs) => {
        capturedUtterances.push({ userId, displayName, wavPath, startMs, endMs });
      },
    });

    try {
      await handle.waitUntilReady();
    } catch (err) {
      handle.disconnect();
      console.error('[join] voice connection failed:', err.message);
      return interaction.editReply(pick(JOIN_FAILED, { error: err.message }));
    }

    // Only now — once the connection is actually confirmed — do we create the
    // meeting row and register the session, so a failed /join never leaves a
    // dangling "recording" meeting behind for crash-recovery to trip over.
    const meetingId = db.createMeeting({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      channelName: voiceChannel.name,
      startedAt: new Date().toISOString(),
      audioDir,
    });

    activeSessions.set(interaction.guildId, { meetingId, handle, capturedUtterances, audioDir });
    await interaction.editReply(pick(JOIN_STARTED, { channel: voiceChannel.name }));
  } finally {
    // Must run even if startCapture/createMeeting throws, or the guild would
    // be permanently unable to start a new recording.
    startingGuilds.delete(interaction.guildId);
  }
}

async function handleLeave(interaction, db, cfg) {
  const session = activeSessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: pick(LEAVE_NOT_RECORDING), flags: MessageFlags.Ephemeral });
  }
  activeSessions.delete(interaction.guildId);

  await interaction.reply(pick(LEAVE_START));
  session.handle.disconnect();
  db.endMeeting(session.meetingId, new Date().toISOString());

  const result = await finishSession(db, session.meetingId, session.capturedUtterances, session.audioDir, cfg);

  if (!result.ok) {
    return interaction.followUp(pick(LEAVE_NOTHING_USABLE, { failCount: result.failures.length }));
  }

  // Post the raw transcript right away rather than waiting on the AI
  // summary — that step can be delayed indefinitely if the PC is off, but
  // the transcript itself is already fully available at this point.
  const utterances = db.listUtterances(session.meetingId);
  const transcriptText = buildTranscriptText(utterances);
  const attachment = new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), {
    name: `meeting-${session.meetingId}-transcript.txt`,
  });

  const reachable = await isOllamaReachable(cfg);
  await interaction.followUp({
    content: reachable
      ? pick(LEAVE_SUMMARIZING_NOW, { count: result.utteranceCount })
      : pick(LEAVE_SUMMARY_QUEUED, { count: result.utteranceCount, meetingId: session.meetingId }),
    files: [attachment],
  });
}

async function handleHistory(interaction, db) {
  const count = interaction.options.getInteger('count') || 10;
  const meetings = db.listRecentMeetings(interaction.guildId, count);
  if (meetings.length === 0) {
    return interaction.reply({ content: pick(HISTORY_EMPTY), flags: MessageFlags.Ephemeral });
  }
  const lines = meetings.map(
    (m) => `**#${m.id}** — ${m.channel_name} — ${(m.started_at || '').slice(0, 10)} — _${m.status}_`
  );
  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handleSummarizeNow(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return interaction.reply({ content: 'No such meeting.', flags: MessageFlags.Ephemeral });

  const reachable = await isOllamaReachable(cfg);
  if (!reachable) {
    return interaction.reply({
      content: pick(SUMMARIZE_UNREACHABLE, { url: cfg.ollamaUrl }),
      flags: MessageFlags.Ephemeral,
    });
  }

  db.requeueSummarizeNow(meetingId);
  await interaction.reply(pick(SUMMARIZE_QUEUED, { meetingId }));
}

async function handleExport(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return interaction.reply({ content: 'No such meeting.', flags: MessageFlags.Ephemeral });

  const utterances = db.listUtterances(meetingId);
  const transcriptText = buildTranscriptText(utterances);
  const buf = Buffer.from(transcriptText, 'utf8');
  const attachment = new AttachmentBuilder(buf, { name: `meeting-${meetingId}-transcript.txt` });

  const intro = pick(EXPORT_INTRO, {
    meetingId,
    channel: meeting.channel_name,
    date: (meeting.started_at || '').slice(0, 10),
  });
  await interaction.reply({
    content: `${intro} Raw audio lives on the Pi at \`${meeting.audio_dir}\` if you need the source files (or \`null\` if it's already been cleaned up by the retention policy).`,
    files: [attachment],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetCharacter(interaction, db) {
  const name = interaction.options.getString('name').trim();
  db.setCharacterName(interaction.guildId, interaction.user.id, name);
  await interaction.reply({
    content: pick(SETCHARACTER_CONFIRM, { name }),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction, db, cfg) {
  const jobs = db.listPendingJobs();
  const reachable = await isOllamaReachable(cfg);
  const reachableText = reachable ? '✅ reachable' : '❌ not reachable';

  if (jobs.length === 0) {
    return interaction.reply({
      content: pick(STATUS_IDLE, { reachable: reachableText }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = jobs.map((j) => {
    const age = Math.round((Date.now() - new Date(j.created_at).getTime()) / 60000);
    return `- Meeting #${j.meeting_id}: ${j.status}, ${j.attempts} attempt(s), waiting ~${age}m${j.last_error ? ` (last error: ${j.last_error.slice(0, 100)})` : ''}`;
  });

  await interaction.reply({
    content: `${pick(STATUS_QUEUED_HEADER, { reachable: reachableText })}\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRecap(interaction, db) {
  const meeting = db.getLastCompletedMeeting(interaction.guildId);
  if (!meeting) {
    return interaction.reply({ content: pick(RECAP_NONE), flags: MessageFlags.Ephemeral });
  }
  const notes = JSON.parse(meeting.summary_json || '{}');
  const date = (meeting.started_at || '').slice(0, 10);
  const header = pick(RECAP_HEADER, { channel: meeting.channel_name, date });
  await interaction.reply(`${header}\n\n${notes.tldr || '_no recap available_'}`);
}

function timestamp(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}`;
}

async function handleSearch(interaction, db) {
  const query = interaction.options.getString('query').trim();
  if (!query) {
    return interaction.reply({ content: pick(SEARCH_NONE, { query }), flags: MessageFlags.Ephemeral });
  }

  const rows = db.searchUtterances(interaction.guildId, query, 25);
  if (rows.length === 0) {
    return interaction.reply({ content: pick(SEARCH_NONE, { query }), flags: MessageFlags.Ephemeral });
  }

  // Group hits under the session they came from, so the answer reads like
  // "this happened in session #3" rather than a flat wall of quotes.
  const byMeeting = new Map();
  for (const row of rows) {
    if (!byMeeting.has(row.meeting_id)) byMeeting.set(row.meeting_id, []);
    byMeeting.get(row.meeting_id).push(row);
  }

  const blocks = [];
  for (const [meetingId, hits] of byMeeting) {
    const date = (hits[0].started_at || '').slice(0, 10);
    const lines = hits.map((h) => {
      const text = h.text.length > 160 ? `${h.text.slice(0, 157)}…` : h.text;
      return `\`[${timestamp(h.start_ms)}]\` **${h.display_name}:** ${text}`;
    });
    blocks.push(`**#${meetingId} — ${hits[0].channel_name} (${date})**\n${lines.join('\n')}`);
  }

  let content = `${pick(SEARCH_HEADER, { query, count: rows.length })}\n\n${blocks.join('\n\n')}`;
  if (content.length > 1900) {
    // Cut back to a line boundary so we never truncate mid-markdown.
    const trimmed = content.slice(0, 1900);
    content = `${trimmed.slice(0, trimmed.lastIndexOf('\n'))}\n… _(more matches — try a narrower search)_`;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleFunny(interaction, db) {
  const meetings = db.listCompletedMeetings(interaction.guildId);

  // Every funny moment from every completed session, paired with which
  // session it came from — the pool /funny picks randomly out of.
  const pool = [];
  for (const meeting of meetings) {
    const notes = JSON.parse(meeting.summary_json || '{}');
    for (const moment of notes.funnyMoments || []) {
      pool.push({ moment, channel: meeting.channel_name, date: (meeting.started_at || '').slice(0, 10) });
    }
  }

  if (pool.length === 0) {
    return interaction.reply({ content: pick(FUNNY_NONE), flags: MessageFlags.Ephemeral });
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  await interaction.reply(pick(FUNNY_HEADER, chosen));
}
