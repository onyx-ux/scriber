import { listTranscriptions, describeTranscription } from '../pipeline/progress.js';
import { nextAutoWindowStart } from '../pipeline/transcribe-schedule.js';
import { detectOpusBackend } from '../voice/opus-backend.js';
import { configuredProviders } from '../pipeline/model-client.js';

// The snapshot the dashboard renders.
//
// Deliberately built from data the bot already has rather than by probing
// anything: this is polled every few seconds, so it must be cheap and must
// never touch the whisper server or the summariser API. Reachability is
// passed IN, refreshed on a slow timer by the server (see web/server.js).
//
// Nothing secret goes in here. No tokens, no API keys, no file paths outside
// the data directory — it is served unauthenticated on the LAN by default.

// host:port from a configured URL, with any userinfo dropped. A malformed or
// absent URL becomes null rather than being echoed back verbatim — this is
// published, and the one thing that must never leak out of it is a credential
// someone embedded in a config value.
function hostOf(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host || null;
  } catch {
    return null;
  }
}

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
    // The dashboard acts on the JOB, not the meeting: a meeting can carry a
    // transcribe job and a summarise job in its lifetime, and "approve session
    // 12" is ambiguous between them. Absent before the dashboard could do
    // anything, which is why it was never needed.
    jobId: r.job_id ?? null,
    jobType: r.job_type ?? null,
    jobStatus: r.job_status ?? null,
    attempts: r.attempts ?? 0,
    nextAttemptAt: r.next_attempt_at ?? null,
    lastError: r.last_error ? String(r.last_error).slice(0, 200) : null,
  }));

  const nextWindow = nextAutoWindowStart(new Date(now), cfg);

  // One row per campaign, which is why this is here at all: the "Servers" card
  // answers "is the bot in this Discord", and with several tables in one
  // Discord that stopped being the same question as "what is it recording".
  //
  // No user ids and no channel ids — the dashboard can be exposed to a URL,
  // and who runs which game is not something to publish. Only whether it is
  // claimed at all, which is what an owner needs to spot a stranded campaign.
  const campaigns = db.campaignOverview().map((c) => ({
    id: c.id,
    name: c.name,
    channel: c.channel_name,
    guildId: c.guild_id,
    guildName: guilds.find((g) => g.id === c.guild_id)?.name ?? null,
    sessions: c.sessions,
    completed: c.completed,
    members: c.members,
    named: c.named,
    lines: c.lines,
    hours: c.total_ms ? c.total_ms / 3_600_000 : 0,
    lastSessionAt: c.last_session_at,
    claimed: Boolean(c.manager_user_id),
    output: c.output_mode ?? 'default',
    recording: activeSessions.has(c.guild_id),
    // Sessions of this campaign stopped waiting for a decision, so the
    // campaign list can say which table needs you without being opened.
    awaiting: c.awaiting ?? 0,
  }));

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
      campaigns: campaigns.filter((c) => c.guildId === g.id).length,
    })),
    campaigns,
    totals: {
      campaigns: campaigns.length,
      claimed: campaigns.filter((c) => c.claimed).length,
      players: new Set(
        db.raw.prepare('SELECT DISTINCT user_id FROM campaign_members').all().map((r) => r.user_id)
      ).size,
      sessions: campaigns.reduce((n, c) => n + c.sessions, 0),
      lines: campaigns.reduce((n, c) => n + c.lines, 0),
      hours: campaigns.reduce((n, c) => n + c.hours, 0),
    },
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
      // Where the transcriber is, so "unreachable" is actionable rather than
      // just alarming — the answer is nearly always that the machine at that
      // address is asleep. Host and port only: any credentials someone put in
      // the URL are stripped rather than published, and a private-range
      // address is not a secret worth hiding from its own operator.
      whisperServerHost: hostOf(cfg.whisperServerUrl),
      // When the dots were last true. A dashboard that says "reachable" is
      // making a claim about a minute ago, and on the screen that exists
      // because a machine went down, the age of the claim is the point.
      checkedAt: reachability.checkedAt ?? null,
    },
    // Which summarisers actually have a key, so the page can offer a choice at
    // the moment of approval instead of guessing — and can leave the choice
    // out entirely when there is only one. Names only; no keys.
    providers: configuredProviders(cfg),
    // Whether this bot will accept actions at all. Without it a dashboard with
    // no STATUS_TOKEN configured looks merely broken: every button returns 403
    // and the cause, one unset variable on the Pi, is invisible from the page.
    actionsEnabled: Boolean(cfg.statusToken),
  };
}
