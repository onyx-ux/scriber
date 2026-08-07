// MessageFlags.Ephemeral replaces the old `ephemeral: true` reply option,
// which discord.js deprecated and drops entirely in v15.
import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startCapture } from '../voice/capture.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
import {
  isSummariserReachable,
  summariserLabel,
  withProvider,
  isValidProvider,
  configuredProviders,
} from '../pipeline/model-client.js';
import { askCampaign, gatherContext } from '../pipeline/ask-client.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { listTranscriptions, describeTranscription, formatDuration } from '../pipeline/progress.js';
import {
  parseTranscribeAction,
  snoozeUntil,
  withinAutoWindow,
  ACTION_LATER,
  ACTION_PI,
  TRANSCRIBE_PREFIX,
} from '../pipeline/transcribe-schedule.js';
import { notifyTranscribeReady } from '../delivery/transcribe-notify.js';
import { resolveSpeakerName } from '../campaign/character-names.js';
import { applyCorrections } from '../campaign/corrections.js';
import { importAudio } from '../pipeline/import-audio.js';
import { readLedgerFile } from '../campaign/ledger.js';
import { exportCampaignSite } from '../export/site.js';
import {
  notifyApprovalNeeded,
  buildApprovalRow,
  APPROVE_PREFIX,
  PARK_PREFIX,
} from '../delivery/approval-notify.js';
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
  LEAVE_AWAITING_APPROVAL,
  APPROVED_CONFIRM,
  PARKED_CONFIRM,
  QUEUE_PAUSED,
  QUEUE_RESUMED,
  PENDING_EMPTY,
  CORRECT_APPLIED,
  UNCORRECT_APPLIED,
  WHOAMI_SET,
  WHOAMI_UNSET,
  STATS_HEADER,
  STATS_EMPTY,
  NPCS_EMPTY,
  NPCS_HEADER,
  LOCATIONS_EMPTY,
  LOCATIONS_HEADER,
  ARCHIVE_SENT,
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
    .addIntegerOption((o) => o.setName('meeting_id').setDescription('Meeting ID').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('provider')
        .setDescription('Who writes it (default: whatever SUMMARY_PROVIDER is set to)')
        .setRequired(false)
        .addChoices(
          { name: 'Gemini', value: 'gemini' },
          { name: 'Claude', value: 'anthropic' }
        )
    ),
  new SlashCommandBuilder()
    .setName('transcribe')
    .setDescription('Control when a recorded session may use the PC to transcribe')
    .addIntegerOption((o) => o.setName('meeting_id').setDescription('Meeting ID').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('when')
        .setDescription('Default: start now')
        .setRequired(false)
        .addChoices(
          { name: 'Now (needs the PC)', value: 'now' },
          { name: 'Remind me later', value: 'later' },
          { name: 'On the Pi instead (slow, no GPU)', value: 'pi' }
        )
    ),
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
  new SlashCommandBuilder()
    .setName('correct')
    .setDescription('Fix a name whisper keeps mishearing — across all past sessions and all future ones')
    .addStringOption((o) =>
      o.setName('wrong').setDescription('What it hears (e.g. "Vecks")').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('right').setDescription('What it should be (e.g. "Vex")').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('corrections')
    .setDescription('List the saved transcript corrections for this campaign'),
  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Show everything currently in the pipeline (recording, transcribing, awaiting approval)'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause summarising — queued sessions wait rather than being sent out'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume summarising after a /pause'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a question about this campaign, answered from past sessions')
    .addStringOption((o) =>
      o.setName('question').setDescription('e.g. "who was the smuggler we met at the docks?"').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('import')
    .setDescription('Import a recording made outside Discord (in-person game, phone recording)')
    .addAttachmentOption((o) =>
      o.setName('file').setDescription('Audio or video file (Discord caps this at ~25MB)').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('url').setDescription('Direct download link — use this for files too big for Discord').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('speaker').setDescription('Label for the speakers (default "Table")').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Release a session that is parked awaiting approval')
    .addIntegerOption((o) =>
      o.setName('meeting_id').setDescription('Meeting ID (omit to approve everything waiting)').setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName('provider')
        .setDescription('Who writes it (default: whatever SUMMARY_PROVIDER is set to)')
        .setRequired(false)
        .addChoices(
          { name: 'Gemini', value: 'gemini' },
          { name: 'Claude', value: 'anthropic' }
        )
    ),
  new SlashCommandBuilder()
    .setName('uncorrect')
    .setDescription('Remove a saved transcript correction')
    .addStringOption((o) =>
      o.setName('wrong').setDescription('The mangled text to stop correcting (must match /correct exactly)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('whoami')
    .setDescription('Show what name you currently appear as in transcripts and notes'),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Campaign-wide totals: sessions, hours, lines, and who talks the most'),
  new SlashCommandBuilder()
    .setName('npcs')
    .setDescription('List every NPC the campaign has met so far'),
  new SlashCommandBuilder()
    .setName('locations')
    .setDescription('List every location the campaign has visited so far'),
  new SlashCommandBuilder()
    .setName('archive')
    .setDescription('Get the browsable campaign archive (a single HTML file) right now'),
].map((c) => c.toJSON());

export function registerCommandHandlers(client, db, cfg) {
  client.on('interactionCreate', async (interaction) => {
    // Approval buttons arrive as component interactions, not commands.
    if (interaction.isButton()) {
      try {
        return await handleApprovalButton(interaction, db, cfg);
      } catch (err) {
        console.error('[button] error:', err);
        return;
      }
    }

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
      if (interaction.commandName === 'transcribe') return await handleTranscribe(interaction, db, cfg);
      if (interaction.commandName === 'recap') return await handleRecap(interaction, db);
      if (interaction.commandName === 'funny') return await handleFunny(interaction, db);
      if (interaction.commandName === 'search') return await handleSearch(interaction, db);
      if (interaction.commandName === 'pending') return await handlePending(interaction, db, cfg);
      if (interaction.commandName === 'pause') return await handlePause(interaction, db);
      if (interaction.commandName === 'resume') return await handleResume(interaction, db);
      if (interaction.commandName === 'approve') return await handleApprove(interaction, db, cfg);
      if (interaction.commandName === 'ask') return await handleAsk(interaction, db, cfg);
      if (interaction.commandName === 'import') return await handleImport(interaction, db, cfg);
      if (interaction.commandName === 'correct') return await handleCorrect(interaction, db);
      if (interaction.commandName === 'corrections') return await handleCorrections(interaction, db);
      if (interaction.commandName === 'uncorrect') return await handleUncorrect(interaction, db);
      if (interaction.commandName === 'whoami') return await handleWhoAmI(interaction, db);
      if (interaction.commandName === 'stats') return await handleStats(interaction, db);
      if (interaction.commandName === 'npcs') return await handleNpcs(interaction, db, cfg);
      if (interaction.commandName === 'locations') return await handleLocations(interaction, db, cfg);
      if (interaction.commandName === 'archive') return await handleArchive(interaction, db, cfg);
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

  // Transcription is NOT started here any more. It needs the PC's GPU, and a
  // session usually ends in the evening — precisely when someone is most
  // likely to be using that PC. So the recording is queued, the owner is
  // asked, and transcribe-worker.js runs it when approved or inside the
  // automatic window. See pipeline/transcribe-schedule.js.
  db.setMeetingStatus(session.meetingId, 'awaiting_transcription');
  const job = db.enqueueTranscribeJob(session.meetingId, {
    requireApproval: cfg.transcribeRequireApproval,
  });

  const clipCount = session.capturedUtterances.length;
  const serverReachable = await isWhisperServerReachable(cfg);
  const meeting = db.getMeeting(session.meetingId);

  await interaction.followUp({
    content:
      `📼 Recorded **${clipCount}** clips for session #${session.meetingId}.\n` +
      (cfg.transcribeRequireApproval
        ? `Transcription is queued — I've DMed you to ask when it can use the PC. Nothing touches the GPU until then.`
        : `Transcription is queued and will start when the PC is available.`),
  });

  if (cfg.transcribeRequireApproval) {
    await notifyTranscribeReady({
      discordClient: interaction.client,
      cfg,
      meeting,
      jobId: job.id,
      utteranceCount: clipCount,
      serverReachable,
    });
  }
}

// Shared by the DM buttons and /transcribe, so both routes behave identically.
async function applyTranscribeAction(db, cfg, jobId, action) {
  const job = db.raw.prepare(`SELECT * FROM jobs WHERE id = ? AND type = 'transcribe'`).get(jobId);
  if (!job) return { ok: false, message: '⚠️ That transcription job no longer exists.' };
  if (job.status === 'done') return { ok: false, message: '✅ That session is already transcribed.' };
  if (job.status === 'running') return { ok: false, message: '⏳ That session is being transcribed right now.' };

  if (action === ACTION_LATER) {
    const until = snoozeUntil(new Date(), cfg);
    db.snoozeTranscribeJob(job.id, until.toISOString());
    return {
      ok: true,
      message: `⏰ Put off for ${cfg.transcribeSnoozeHours}h — I'll ask again after <t:${Math.floor(until.getTime() / 1000)}:f>. The automatic window is suppressed until then, so nothing will touch the PC.`,
    };
  }

  if (action === ACTION_PI) {
    // Explicitly asked for the slow path, so bypass the whole GPU schedule.
    db.approveTranscribeNow(job.id);
    db.setSetting(`transcribe_target_${job.id}`, 'pi');
    return { ok: true, message: '🐌 Queued on the Pi instead — no GPU needed, but expect hours rather than minutes.' };
  }

  db.approveTranscribeNow(job.id);
  return { ok: true, message: "▶️ Approved — it'll start within a minute, as soon as the PC answers." };
}

async function handleTranscribe(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const when = interaction.options.getString('when') || 'now';

  const job = db.getTranscribeJobForMeeting(meetingId);
  if (!job) {
    return interaction.reply({
      content: `⚠️ No transcription job for meeting #${meetingId}. It may already be transcribed — check \`/status\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const { message } = await applyTranscribeAction(db, cfg, job.id, when);
  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
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
  const provider = interaction.options.getString('provider');
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return interaction.reply({ content: 'No such meeting.', flags: MessageFlags.Ephemeral });

  // Check the provider actually being used, not the configured default, so
  // asking for one that is set up isn't refused because the other isn't.
  const effectiveCfg = withProvider(cfg, provider);
  const unusable = providerUnusableReason(effectiveCfg, provider);
  if (unusable) return interaction.reply({ content: unusable, flags: MessageFlags.Ephemeral });

  if (!(await isSummariserReachable(effectiveCfg))) {
    return interaction.reply({
      content: pick(SUMMARIZE_UNREACHABLE, { label: summariserLabel(effectiveCfg) }),
      flags: MessageFlags.Ephemeral,
    });
  }

  db.requeueSummarizeNow(meetingId, provider);
  const note = provider ? `\n_Summarising with ${summariserLabel(effectiveCfg)}._` : '';
  await interaction.reply(pick(SUMMARIZE_QUEUED, { meetingId }) + note);
}

// A provider the user explicitly asked for but that isn't set up (no API key)
// should say so plainly, rather than silently falling back to the default and
// producing a summary from something they didn't choose.
function providerUnusableReason(cfg, requested) {
  if (!requested) return null;
  if (!isValidProvider(requested)) return `⚠️ Unknown provider "${requested}".`;
  if (!configuredProviders(cfg).includes(requested)) {
    return `⚠️ **${requested}** isn't set up on this bot — its API key is missing. Configured right now: ${configuredProviders(
      cfg
    ).join(', ')}.`;
  }
  return null;
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
  const reachable = await isSummariserReachable(cfg);
  const reachableText = reachable ? '✅ reachable' : '❌ not reachable';
  const label = summariserLabel(cfg);

  // Transcription runs before a summarise job exists, so a session being
  // ground through on the Pi shows up here and nowhere else — this is the
  // one that can legitimately take hours and prompt "is it stuck?".
  const now = Date.now();
  const transcribing = listTranscriptions().map((entry) => `- Meeting #${entry.meetingId}: ${describeTranscription(entry, now)}`);

  if (jobs.length === 0 && transcribing.length === 0) {
    return interaction.reply({
      content: pick(STATUS_IDLE, { reachable: reachableText, label }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = jobs.map((j) => {
    const age = Math.round((now - new Date(j.created_at).getTime()) / 60000);
    // For a job that failed and is backing off, when it next tries is more
    // useful than how long it has already been waiting.
    const dueMs = j.next_attempt_at ? new Date(j.next_attempt_at).getTime() - now : null;
    const retry =
      j.status === 'pending' && dueMs !== null && Number.isFinite(dueMs) && dueMs > 0
        ? `, retry in ~${formatDuration(dueMs)}`
        : '';
    return `- Meeting #${j.meeting_id}: ${j.status}, ${j.attempts} attempt(s), waiting ~${age}m${retry}${j.last_error ? ` (last error: ${j.last_error.slice(0, 100)})` : ''}`;
  });

  const sections = [pick(STATUS_QUEUED_HEADER, { reachable: reachableText, label })];
  if (transcribing.length > 0) sections.push(transcribing.join('\n'));
  if (lines.length > 0) sections.push(lines.join('\n'));

  await interaction.reply({ content: sections.join('\n'), flags: MessageFlags.Ephemeral });
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

async function handleImport(interaction, db, cfg) {
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');
  const speakerLabel = (interaction.options.getString('speaker') || 'Table').trim() || 'Table';

  const source = attachment?.url || url;
  if (!source) {
    return interaction.reply({
      content: '⚠️ Attach a `file:` or give a `url:` — one of the two is needed.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (activeSessions.has(interaction.guildId)) {
    return interaction.reply({
      content: "⚠️ I'm recording right now — `/leave` first, then import.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Transcribing an hours-long recording on a Pi takes far longer than
  // Discord's 15-minute interaction window, so acknowledge, then report back
  // by editing the original reply as each phase completes.
  await interaction.deferReply();
  await interaction.editReply('📥 Downloading the recording…');

  const stages = {
    downloading: '📥 Downloading the recording…',
    converting: '🎛️ Converting the audio…',
    transcribing: `🎧 Transcribing with whisper — this takes a while for a long recording. I'll post the result here when it's done.`,
  };

  try {
    const result = await importAudio({
      db,
      cfg,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      channelName: interaction.channel?.name || 'imported',
      url: source,
      filename: attachment?.name,
      speakerLabel,
      onProgress: (stage) => {
        if (stages[stage]) interaction.editReply(stages[stage]).catch(() => {});
      },
    });

    const parked = result.job?.status === 'awaiting_approval';
    const note = parked
      ? `Parked awaiting your approval — \`/approve meeting_id:${result.meetingId}\`.`
      : 'Summarising now.';

    await interaction.editReply(
      `✅ Imported as session #${result.meetingId} — ${result.utteranceCount} lines transcribed. ${note}\n` +
        `_Every line is attributed to **${speakerLabel}**: a single recording has no per-speaker channels, so I can't tell voices apart the way I can in a voice call._`
    );

    if (parked) {
      await notifyApprovalNeeded({
        discordClient: interaction.client,
        cfg,
        meeting: db.getMeeting(result.meetingId),
        jobId: result.job.id,
        utteranceCount: result.utteranceCount,
      });
    }
  } catch (err) {
    console.error('[import] failed:', err);
    await interaction.editReply(`❌ Import failed: ${err.message}`);
  }
}

async function handleCorrect(interaction, db) {
  const wrong = interaction.options.getString('wrong').trim();
  const right = interaction.options.getString('right').trim();

  if (!wrong || !right) {
    return interaction.reply({ content: '⚠️ Both values are required.', flags: MessageFlags.Ephemeral });
  }
  if (wrong.toLowerCase() === right.toLowerCase()) {
    return interaction.reply({
      content: '⚠️ Those are the same thing — nothing to correct.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Save first so it applies to every future session, then replay it over
  // everything already transcribed.
  db.addCorrection(interaction.guildId, wrong, right);
  const changed = db.rewriteUtterances(interaction.guildId, (text) =>
    applyCorrections(text, [{ wrong_text: wrong, correct_text: right }])
  );

  const note =
    changed > 0
      ? '\n\n_Existing summaries were generated before this fix — run `/summarise meeting_id:<id>` on a session to regenerate one with the corrected name._'
      : '';

  await interaction.reply({
    content: pick(CORRECT_APPLIED, { wrong, right, count: changed }) + note,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCorrections(interaction, db) {
  const rows = db.listCorrections(interaction.guildId);
  if (rows.length === 0) {
    return interaction.reply({
      content: '📭 No corrections saved yet. Use `/correct` when whisper mangles a name.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const lines = rows.map((r) => `- "${r.wrong_text}" → **${r.correct_text}**`);
  await interaction.reply({
    content: `✏️ **Saved corrections** (applied automatically to every new transcript):\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleUncorrect(interaction, db) {
  const wrong = interaction.options.getString('wrong').trim();
  const removed = db.removeCorrection(interaction.guildId, wrong);
  if (removed === 0) {
    return interaction.reply({
      content: `⚠️ No saved correction for "${wrong}" — check \`/corrections\` for the exact text.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.reply({ content: pick(UNCORRECT_APPLIED, { wrong }), flags: MessageFlags.Ephemeral });
}

async function handleWhoAmI(interaction, db) {
  const characterName = db.getCharacterName(interaction.guildId, interaction.user.id);
  const content = characterName
    ? pick(WHOAMI_SET, { name: characterName })
    : pick(WHOAMI_UNSET, { discordName: interaction.member?.displayName || interaction.user.username });
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleStats(interaction, db) {
  const stats = db.campaignStats(interaction.guildId);
  if (stats.totalSessions === 0) {
    return interaction.reply({ content: pick(STATS_EMPTY), flags: MessageFlags.Ephemeral });
  }

  const hours = (stats.totalMs / 3_600_000).toFixed(1);
  const header = pick(STATS_HEADER, { sessions: stats.totalSessions, hours, lines: stats.totalLines });

  const talkLines = stats.talkative.map((t, i) => `${i + 1}. **${t.display_name}** — ${t.lines} lines`).join('\n');
  const longest =
    stats.longestMeetingId !== null
      ? `${(stats.longestMs / 3_600_000).toFixed(1)}h (session #${stats.longestMeetingId})`
      : 'unknown';

  const content = [header, '', '**Most talkative:**', talkLines, '', `**Longest session:** ${longest}`].join('\n');
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// Both /npcs and /locations pull from whatever campaign this guild's last
// completed session belonged to — same one-campaign-per-guild assumption
// /recap, /ask, /history etc. already make; there's no per-command way to
// pick a specific campaign if a guild ever ran more than one.
async function ledgerEntries(db, cfg, guildId, filename) {
  const meeting = db.getLastCompletedMeeting(guildId);
  if (!meeting) return null;
  const raw = await readLedgerFile(cfg, guildId, meeting.channel_name, filename);
  return (raw || '').split('\n').filter((l) => l.trim().startsWith('-'));
}

function ledgerReply(entries, emptyPick, headerPick) {
  if (!entries || entries.length === 0) {
    return { content: pick(emptyPick), flags: MessageFlags.Ephemeral };
  }
  let content = pick(headerPick, { list: entries.join('\n') });
  if (content.length > 1900) {
    content = `${content.slice(0, 1900)}\n… _(truncated — see the full ledger in Obsidian)_`;
  }
  return { content, flags: MessageFlags.Ephemeral };
}

async function handleNpcs(interaction, db, cfg) {
  const entries = await ledgerEntries(db, cfg, interaction.guildId, 'NPCs.md');
  await interaction.reply(ledgerReply(entries, NPCS_EMPTY, NPCS_HEADER));
}

async function handleLocations(interaction, db, cfg) {
  const entries = await ledgerEntries(db, cfg, interaction.guildId, 'Locations.md');
  await interaction.reply(ledgerReply(entries, LOCATIONS_EMPTY, LOCATIONS_HEADER));
}

async function handleArchive(interaction, db, cfg) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const path = await exportCampaignSite(db, interaction.guildId, cfg);
  const attachment = new AttachmentBuilder(path, { name: 'campaign-archive.html' });
  await interaction.editReply({ content: pick(ARCHIVE_SENT), files: [attachment] });
}

async function handleAsk(interaction, db, cfg) {
  const question = interaction.options.getString('question').trim();

  if (db.getSetting('summarize_paused') === 'true') {
    return interaction.reply({
      content: `⏸️ Summarising is paused, so I'm not calling ${summariserLabel(cfg)}. Run \`/resume\` first.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!(await isSummariserReachable(cfg))) {
    // Not the SUMMARIZE_UNREACHABLE text — that promises a background retry,
    // and there's no queue behind /ask to retry with.
    return interaction.reply({
      content: `🔮 The oracle is dark — ${summariserLabel(cfg)} isn't reachable right now. Try again shortly.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Answering means a full model round-trip; Discord needs the ack inside 3s.
  await interaction.deferReply();

  const { summaries, excerpts } = gatherContext(db, interaction.guildId, question, cfg);
  if (summaries.length === 0 && excerpts.length === 0) {
    return interaction.editReply(
      "📭 There's nothing in the campaign records yet — I need at least one completed session to answer questions."
    );
  }

  const answer = await askCampaign({ question, summaries, excerpts, cfg });
  const body = `🔮 **${question}**\n\n${answer}`;
  await interaction.editReply(body.length > 1990 ? `${body.slice(0, 1980)}…` : body);
}

async function handleApprovalButton(interaction, db, cfg) {
  const { customId } = interaction;

  // Scheduling buttons from the "ready to transcribe" DM.
  if (customId.startsWith(TRANSCRIBE_PREFIX)) {
    const parsed = parseTranscribeAction(customId);
    if (!parsed) {
      return interaction.update({ content: '⚠️ Unrecognised button.', components: [] });
    }
    const { ok, message } = await applyTranscribeAction(db, cfg, parsed.jobId, parsed.action);
    // Keep the buttons when nothing changed (e.g. already running), drop them
    // once a choice has been applied so it can't be double-clicked.
    return interaction.update({ content: message, components: ok ? [] : interaction.message.components });
  }

  if (customId.startsWith(APPROVE_PREFIX)) {
    // "<jobId>" (use the configured default) or "<jobId>:<provider>".
    const [rawJobId, provider = null] = customId.slice(APPROVE_PREFIX.length).split(':');
    const jobId = parseInt(rawJobId, 10);
    const job = db.getJob(jobId);
    if (!job) {
      return interaction.update({ content: '⚠️ That job no longer exists.', components: [] });
    }
    const released = db.approveJob(jobId, provider);
    const label = summariserLabel(withProvider(cfg, provider));
    // Dropping the buttons on success stops a second click re-queueing a job
    // that has already moved on.
    return interaction.update({
      content: released
        ? `${pick(APPROVED_CONFIRM, { meetingId: job.meeting_id })}\n_Summarising with ${label}._`
        : `⚠️ Session #${job.meeting_id} was already released (currently: ${job.status}).`,
      components: [],
    });
  }

  if (customId.startsWith(PARK_PREFIX)) {
    const jobId = parseInt(customId.slice(PARK_PREFIX.length), 10);
    const job = db.getJob(jobId);
    // Keep the buttons — the whole point is that they can approve it later
    // from this same DM.
    return interaction.update({
      content: pick(PARKED_CONFIRM, { meetingId: job ? job.meeting_id : '?' }),
      components: [buildApprovalRow(jobId, cfg)],
    });
  }
}

async function handlePause(interaction, db) {
  db.setSetting('summarize_paused', 'true');
  await interaction.reply({ content: pick(QUEUE_PAUSED), flags: MessageFlags.Ephemeral });
}

async function handleResume(interaction, db) {
  db.setSetting('summarize_paused', 'false');
  await interaction.reply({ content: pick(QUEUE_RESUMED), flags: MessageFlags.Ephemeral });
}

async function handleApprove(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const provider = interaction.options.getString('provider');

  const effectiveCfg = withProvider(cfg, provider);
  const unusable = providerUnusableReason(effectiveCfg, provider);
  if (unusable) return interaction.reply({ content: unusable, flags: MessageFlags.Ephemeral });
  const note = provider ? `\n_Summarising with ${summariserLabel(effectiveCfg)}._` : '';

  if (meetingId === null) {
    const count = db.approveAllWaiting(provider);
    return interaction.reply({
      content:
        count === 0
          ? '📭 Nothing was awaiting approval.'
          : `✅ Released ${count} parked session(s) for summarising.${note}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const job = db.listPendingJobs().find((j) => j.meeting_id === meetingId && j.status === 'awaiting_approval');
  if (!job) {
    return interaction.reply({
      content: `⚠️ Session #${meetingId} isn't awaiting approval — check \`/pending\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  db.approveJob(job.id, provider);
  await interaction.reply({
    content: pick(APPROVED_CONFIRM, { meetingId }) + note,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePending(interaction, db, cfg) {
  const rows = db.listPipeline();
  const paused = db.getSetting('summarize_paused') === 'true';
  const pausedNote = paused ? '\n\n⏸️ _Summarising is paused — run `/resume` to continue._' : '';

  if (rows.length === 0) {
    return interaction.reply({
      content: `${pick(PENDING_EMPTY)}${pausedNote}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const reachable = await isSummariserReachable(cfg);
  const lines = rows.map((r) => {
    const date = (r.started_at || '').slice(0, 10);
    const parts = [`**#${r.id} — ${r.channel_name} (${date})**`];
    parts.push(`  • session: \`${r.meeting_status}\`${r.utterance_count ? ` — ${r.utterance_count} lines` : ''}`);

    if (r.job_status === 'awaiting_approval') {
      parts.push(`  • summary: ⏸️ **awaiting your approval** — \`/approve meeting_id:${r.id}\``);
    } else if (r.job_status === 'running') {
      parts.push('  • summary: ⚙️ running now');
    } else if (r.job_status === 'pending') {
      const age = Math.round((Date.now() - new Date(r.next_attempt_at).getTime()) / 60000);
      const when = age >= 0 ? 'due now' : `retry in ~${Math.abs(age)}m`;
      parts.push(
        `  • summary: 🕒 queued (${when}, ${r.attempts} attempt(s))${r.last_error ? `\n    last error: _${String(r.last_error).slice(0, 120)}_` : ''}`
      );
    }
    return parts.join('\n');
  });

  let content = `🔧 **Pipeline** — ${summariserLabel(cfg)} is ${reachable ? '✅ reachable' : '❌ not reachable'}\n\n${lines.join('\n\n')}${pausedNote}`;
  if (content.length > 1900) {
    const trimmed = content.slice(0, 1900);
    content = `${trimmed.slice(0, trimmed.lastIndexOf('\n'))}\n… _(truncated)_`;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
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
