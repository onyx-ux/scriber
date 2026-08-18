import { listTranscriptions, describeTranscription } from '../pipeline/progress.js';
import { nextAutoWindowStart } from '../pipeline/transcribe-schedule.js';
import { detectOpusBackend } from '../voice/opus-backend.js';
import { configuredProviders } from '../pipeline/model-client.js';
import { topModel, ladderFor, knownModels } from '../pipeline/model-choice.js';
import { lastBackupCheck } from '../maintenance/backup-check.js';
import { accessRoster } from './access.js';

// The snapshot the dashboard renders.
//
// Deliberately built from data the bot already has rather than by probing
// anything: this is polled every few seconds, so it must be cheap and must
// never touch the whisper server or the summariser API. Reachability is
// passed IN, refreshed on a slow timer by the server (see web/server.js).
//
// Nothing secret goes in here. No tokens, no API keys, no file paths outside
// the data directory — it is served unauthenticated on the LAN by default.

// What the models have cost, and what is doing what.
//
// The honest framing matters here. Neither provider will tell you how much of
// your allowance is left — Anthropic sends a header on each response, Google
// sends nothing at all — so every number below is what THIS bot counted as it
// spent it. It is not a reading off Google's meter and must not be shown as
// one, because the difference matters the day they disagree.
function modelReport({ db, cfg }) {
  try {
    const today = db.modelUsageToday();
    const budget = Number(cfg.modelDailyTokenBudget ?? 0);

    return {
      // Which model actually runs for each job, after the operator's own
      // choice on the dashboard beats the env file.
      roles: {
        summary: { model: topModel(cfg, 'summary', db), ladder: ladderFor(cfg, 'summary', db) },
        ask: { model: topModel(cfg, 'ask', db), ladder: ladderFor(cfg, 'ask', db) },
      },
      choices: knownModels(cfg, db),
      today: {
        tokens: today.tokens ?? 0,
        calls: today.calls ?? 0,
        rateLimited: today.limited ?? 0,
        budget,
        // Only a fraction when there is something to be a fraction of.
        fraction: budget > 0 ? Math.min(1, (today.tokens ?? 0) / budget) : null,
      },
      byModel: db.modelUsage(7),
      byDay: db.modelUsageByDay(14),
      askLimit: Number(cfg.askDailyLimit ?? 0),
      // Said out loud in the payload so the page cannot forget to say it.
      counted: 'by this bot, as it spent them — neither provider reports a remaining balance',
    };
  } catch (err) {
    // A metering failure must never take the status snapshot down with it.
    console.warn('[status] model usage unavailable:', err.message);
    return null;
  }
}

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

// What Quill is allowed to do on one server.
//
// The failure this exists to catch is silent: a bot that cannot post in the
// channel it recorded in finishes the whole pipeline — records, transcribes,
// pays for a summary — and then drops the notes on the floor with a line in a
// log nobody reads. Discord shows permissions per role, per channel, on a
// screen you have to go looking for.
//
// Guild level, not channel level, on purpose: a channel override can still bite
// after this says yes, and claiming otherwise would be worse than being clear
// about what was checked. Everything is guarded — a client shape without a
// cached member answers null, meaning "not checked", which the page renders as
// nothing rather than as a problem.
const NEEDED = [
  ['Connect', 'Join voice channels'],
  ['Speak', 'Stay in voice while recording'],
  ['ViewChannel', 'See the channels it records in'],
  ['SendMessages', 'Post the notes'],
  ['AttachFiles', 'Attach a transcript'],
];

function permissionsOf(guild) {
  const held = guild?.members?.me?.permissions;
  if (!held || typeof held.has !== 'function') return null;
  try {
    return NEEDED.map(([flag, what]) => ({ what, ok: held.has(flag) }));
  } catch {
    // A permission name this discord.js does not know is not worth a 500.
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
    ? [...client.guilds.cache.values()].map((g) => ({
        id: g.id,
        name: g.name,
        permissions: permissionsOf(g),
      }))
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

    // What the models have cost, and which one does which job.
    //
    // Stripped for everyone below dev by web/scope.js along with the rest of
    // the machinery — this is the API bill, and it is one person's business.
    models: modelReport({ db, cfg }),

    // Whether the newest snapshot has ever been opened, and what it said.
    // Machinery, so dev only — and null until something has checked, which
    // the page must render as "unknown" rather than as "fine".
    // Who can get into this bot, at what level, and who is signed in now.
    // Sits behind `everything`, because a roster of everyone the bot knows
    // is exactly the thing a player should not be handed.
    access: accessRoster({ db, cfg, client }),
    backup: lastBackupCheck(db),
    // Whether this bot will accept actions at all. Without it a dashboard with
    // no STATUS_TOKEN configured looks merely broken: every button returns 403
    // and the cause, one unset variable on the Pi, is invisible from the page.
    actionsEnabled: Boolean(cfg.statusToken),
  };
}
