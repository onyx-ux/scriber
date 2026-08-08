import { listTranscriptions, describeTranscription } from '../pipeline/progress.js';
import { nextAutoWindowStart } from '../pipeline/transcribe-schedule.js';
import { detectOpusBackend } from '../voice/opus-backend.js';

// The snapshot the dashboard renders.
//
// Deliberately built from data the bot already has rather than by probing
// anything: this is polled every few seconds, so it must be cheap and must
// never touch the whisper server or the summariser API. Reachability is
// passed IN, refreshed on a slow timer by the server (see web/server.js).
//
// Nothing secret goes in here. No tokens, no API keys, no file paths outside
// the data directory — it is served unauthenticated on the LAN by default.

function sessionView(guildId, session, guildName, now) {
  const startedMs = session.startedAtMs ?? null;
  return {
    guildId,
    guildName,
    meetingId: session.meetingId,
    channel: session.channelName ?? null,
    // capturedUtterances is the live array the capture callback pushes into,
    // so this is the true clip count at this instant.
    clips: session.capturedUtterances?.length ?? 0,
    speakers: new Set((session.capturedUtterances ?? []).map((u) => u.userId)).size,
    recordingForMs: startedMs ? now - startedMs : null,
  };
}

export function buildStatus({
  db,
  cfg,
  client = null,
  activeSessions = new Map(),
  reachability = {},
  now = Date.now(),
  startedAtMs = now,
}) {
  const guilds = client?.guilds?.cache
    ? [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }))
    : [];

  const recording = [...activeSessions.entries()].map(([guildId, session]) =>
    sessionView(guildId, session, guilds.find((g) => g.id === guildId)?.name ?? guildId, now)
  );

  const transcribing = listTranscriptions().map((entry) => ({
    meetingId: entry.meetingId,
    done: entry.done,
    total: entry.total,
    description: describeTranscription(entry, now),
  }));

  const pipeline = db.listPipeline();
  const queue = pipeline.map((r) => ({
    meetingId: r.id,
    channel: r.channel_name,
    startedAt: r.started_at,
    sessionStatus: r.meeting_status,
    utterances: r.utterance_count ?? 0,
    jobType: r.job_type ?? null,
    jobStatus: r.job_status ?? null,
    attempts: r.attempts ?? 0,
    nextAttemptAt: r.next_attempt_at ?? null,
    lastError: r.last_error ? String(r.last_error).slice(0, 200) : null,
  }));

  const nextWindow = nextAutoWindowStart(new Date(now), cfg);

  return {
    generatedAt: new Date(now).toISOString(),
    bot: {
      user: client?.user?.tag ?? null,
      online: Boolean(client?.user),
      uptimeMs: now - startedAtMs,
      opus: detectOpusBackend(),
    },
    servers: guilds.map((g) => ({
      ...g,
      recording: activeSessions.has(g.id),
    })),
    recording,
    working: {
      transcribing,
      // A job flipped to 'running' is the one actually being worked on now.
      summarising: queue.filter((q) => q.jobType === 'summarize' && q.jobStatus === 'running'),
    },
    queue: {
      awaitingTranscribe: queue.filter((q) => q.jobType === 'transcribe' && q.jobStatus === 'awaiting_approval'),
      queuedTranscribe: queue.filter((q) => q.jobType === 'transcribe' && q.jobStatus === 'pending'),
      awaitingSummary: queue.filter((q) => q.jobType === 'summarize' && q.jobStatus === 'awaiting_approval'),
      queuedSummary: queue.filter((q) => q.jobType === 'summarize' && q.jobStatus === 'pending'),
    },
    schedule: {
      timeZone: cfg.scheduleTimeZone,
      windowStartHour: cfg.transcribeWindowStartHour,
      windowEndHour: cfg.transcribeWindowEndHour,
      weekdaysOnly: cfg.transcribeWeekdaysOnly,
      requireApproval: cfg.transcribeRequireApproval,
      nextAutoWindowAt: nextWindow ? nextWindow.toISOString() : null,
      inWindowNow: Boolean(nextWindow && nextWindow.getTime() <= now),
    },
    health: {
      whisperServer: reachability.whisperServer ?? null,
      summariser: reachability.summariser ?? null,
      summariserName: cfg.summaryProvider,
      summarisePaused: db.getSetting('summarize_paused') === 'true',
      transcribePaused: db.getSetting('transcribe_paused') === 'true',
    },
  };
}
