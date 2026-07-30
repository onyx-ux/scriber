import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startCapture } from '../voice/capture.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
import { isOllamaReachable } from '../pipeline/summarize-client.js';
import { finishSession } from '../pipeline/finish-session.js';
import { resolveSpeakerName } from '../campaign/character-names.js';

// active sessions keyed by guildId, since one bot instance can only sensibly
// record one channel per guild at a time
export const activeSessions = new Map();

export const commandDefs = [
  new SlashCommandBuilder().setName('join').setDescription('Start recording this voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop recording, transcribe, and queue the summary'),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('List recent sessions')
    .addIntegerOption((o) => o.setName('count').setDescription('How many to show').setRequired(false)),
  new SlashCommandBuilder()
    .setName('summarize')
    .setDescription('Retry summarization now for a meeting (useful right after turning your PC on)')
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
].map((c) => c.toJSON());

export function registerCommandHandlers(client, db, cfg) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'join') return handleJoin(interaction, db, cfg);
      if (interaction.commandName === 'leave') return handleLeave(interaction, db, cfg);
      if (interaction.commandName === 'history') return handleHistory(interaction, db);
      if (interaction.commandName === 'summarize') return handleSummarizeNow(interaction, db, cfg);
      if (interaction.commandName === 'export') return handleExport(interaction, db, cfg);
      if (interaction.commandName === 'setcharacter') return handleSetCharacter(interaction, db);
      if (interaction.commandName === 'status') return handleStatus(interaction, db, cfg);
      if (interaction.commandName === 'recap') return handleRecap(interaction, db);
    } catch (err) {
      console.error(`[command:${interaction.commandName}] error:`, err);
      const reply = { content: `Something went wrong: ${err.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  });
}

async function handleJoin(interaction, db, cfg) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
  }
  if (activeSessions.has(interaction.guildId)) {
    return interaction.reply({ content: 'Already recording in this server.', ephemeral: true });
  }

  await interaction.reply(`🎙️ Recording started in **${voiceChannel.name}**.`);

  const startedAt = new Date().toISOString();
  const audioDir = join(cfg.dataDir, 'audio', `${interaction.guildId}-${Date.now()}`);
  await mkdir(audioDir, { recursive: true });

  const meetingId = db.createMeeting({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    channelName: voiceChannel.name,
    startedAt,
    audioDir,
  });

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

  await handle.waitUntilReady();
  activeSessions.set(interaction.guildId, { meetingId, handle, capturedUtterances, audioDir });
}

async function handleLeave(interaction, db, cfg) {
  const session = activeSessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: 'Not currently recording.', ephemeral: true });
  }
  activeSessions.delete(interaction.guildId);

  await interaction.reply('⏳ Stopping and transcribing — this can take a while for a long session...');
  session.handle.disconnect();
  db.endMeeting(session.meetingId, new Date().toISOString());

  const result = await finishSession(db, session.meetingId, session.capturedUtterances, session.audioDir, cfg);

  if (!result.ok) {
    return interaction.followUp(`Transcription produced nothing usable (${result.failures.length} failure(s)).`);
  }

  const reachable = await isOllamaReachable(cfg);
  await interaction.followUp(
    reachable
      ? `✅ Transcribed ${result.utteranceCount} lines. Summarizing now on your PC...`
      : `✅ Transcribed ${result.utteranceCount} lines. Your PC's Ollama isn't reachable right now — the summary is queued and will run automatically once it's back, or run \`/summarize meeting_id:${session.meetingId}\` after you turn it on.`
  );
}

async function handleHistory(interaction, db) {
  const count = interaction.options.getInteger('count') || 10;
  const meetings = db.listRecentMeetings(interaction.guildId, count);
  if (meetings.length === 0) {
    return interaction.reply({ content: 'No sessions recorded yet.', ephemeral: true });
  }
  const lines = meetings.map(
    (m) => `**#${m.id}** — ${m.channel_name} — ${(m.started_at || '').slice(0, 10)} — _${m.status}_`
  );
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleSummarizeNow(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return interaction.reply({ content: 'No such meeting.', ephemeral: true });

  const reachable = await isOllamaReachable(cfg);
  if (!reachable) {
    return interaction.reply({
      content: `Your PC's Ollama still isn't reachable at ${cfg.ollamaUrl}. It'll retry automatically in the background too.`,
      ephemeral: true,
    });
  }

  db.enqueueSummarizeJob(meetingId);
  await interaction.reply(`Queued meeting #${meetingId} for immediate retry — check back shortly.`);
}

async function handleExport(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return interaction.reply({ content: 'No such meeting.', ephemeral: true });

  const utterances = db.listUtterances(meetingId);
  const transcriptText = buildTranscriptText(utterances);
  const buf = Buffer.from(transcriptText, 'utf8');
  const attachment = new AttachmentBuilder(buf, { name: `meeting-${meetingId}-transcript.txt` });

  await interaction.reply({
    content: `Transcript for meeting #${meetingId} (${meeting.channel_name}, ${(meeting.started_at || '').slice(0, 10)}). Raw audio lives on the Pi at \`${meeting.audio_dir}\` if you need the source files (or \`null\` if it's already been cleaned up by the retention policy).`,
    files: [attachment],
    ephemeral: true,
  });
}

async function handleSetCharacter(interaction, db) {
  const name = interaction.options.getString('name').trim();
  db.setCharacterName(interaction.guildId, interaction.user.id, name);
  await interaction.reply({
    content: `Got it — you'll show up as **${name}** in transcripts and notes from now on.`,
    ephemeral: true,
  });
}

async function handleStatus(interaction, db, cfg) {
  const jobs = db.listPendingJobs();
  const reachable = await isOllamaReachable(cfg);

  if (jobs.length === 0) {
    return interaction.reply({
      content: `No sessions currently queued for summarization. Your PC's Ollama is currently ${reachable ? '✅ reachable' : '❌ not reachable'}.`,
      ephemeral: true,
    });
  }

  const lines = jobs.map((j) => {
    const age = Math.round((Date.now() - new Date(j.created_at).getTime()) / 60000);
    return `- Meeting #${j.meeting_id}: ${j.status}, ${j.attempts} attempt(s), waiting ~${age}m${j.last_error ? ` (last error: ${j.last_error.slice(0, 100)})` : ''}`;
  });

  await interaction.reply({
    content: `Your PC's Ollama is currently ${reachable ? '✅ reachable' : '❌ not reachable'}.\n\n**Queued:**\n${lines.join('\n')}`,
    ephemeral: true,
  });
}

async function handleRecap(interaction, db) {
  const meeting = db.getLastCompletedMeeting(interaction.guildId);
  if (!meeting) {
    return interaction.reply({ content: 'No completed sessions yet.', ephemeral: true });
  }
  const notes = JSON.parse(meeting.summary_json || '{}');
  const date = (meeting.started_at || '').slice(0, 10);
  await interaction.reply(
    `📜 **Recap — ${meeting.channel_name} (${date})**\n\n${notes.tldr || '_no recap available_'}`
  );
}
