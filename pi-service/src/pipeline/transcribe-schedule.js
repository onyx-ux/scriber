import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// WHEN a finished recording is allowed to use the PC's GPU.
//
// Transcription is the only step that reaches into another machine's
// hardware, and that machine is also the one being used for games. Firing it
// the moment a session ends means competing for the GPU at exactly the time
// someone is most likely to be on it — a 3-hour session is minutes of GPU,
// but it also parks ~2GB of VRAM, which is enough to push a game into
// swapping GPU memory over PCIe and tank the frame rate.
//
// So a finished session waits, and runs when one of these is true:
//
//   approved   — the owner pressed "Transcribe now". Runs as soon as the
//                whisper server answers, whatever the time.
//   in-window  — inside the automatic window (weekdays 08:00-16:00 by
//                default), when the PC is on but nobody is playing on it.
//
// Snoozing pushes the job's eligibility forward and suppresses both, so
// "remind me tomorrow" genuinely means tomorrow.
//
// Nothing here ever falls back to transcribing on the Pi. That was a
// deliberate choice: an unattended fallback would quietly spend hours of CPU
// and produce a worse transcript, and waiting costs nothing but time.

export const TRANSCRIBE_PREFIX = 'scriber:tsched:';

export const ACTION_NOW = 'now';
export const ACTION_LATER = 'later';
export const ACTION_PI = 'pi';

// The container runs in UTC; the person does not. Every hour/day decision
// here is made in an explicit IANA zone so "8am" means 8am where the PC is,
// regardless of how the container is configured or whether the zone observes
// daylight saving.
export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    // Intl renders midnight as "24" in some environments; normalise to 0.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: get('weekday'), // Mon, Tue, ...
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

export function isWeekend(date, timeZone) {
  return WEEKEND.has(zonedParts(date, timeZone).weekday);
}

// Inside the automatic window: the hours when the PC is typically on but
// nobody is using it.
export function withinAutoWindow(date, cfg) {
  const { hour, weekday } = zonedParts(date, cfg.scheduleTimeZone);
  if (cfg.transcribeWeekdaysOnly && WEEKEND.has(weekday)) return false;

  const { transcribeWindowStartHour: start, transcribeWindowEndHour: end } = cfg;
  // A window that wraps past midnight (e.g. 22->6) is still meaningful, so
  // handle it rather than silently returning nothing for the whole night.
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

// The single decision the worker acts on, kept pure so every branch can be
// tested without a database, a clock, or a whisper server.
//
//   run     — start transcribing now
//   remind  — nothing to do yet, but the owner is due a nudge
//   wait    — nothing to do, stay quiet
export function decideTranscribeAction({ job, now, serverReachable, cfg }) {
  const dueAt = new Date(job.next_attempt_at).getTime();
  if (Number.isFinite(dueAt) && dueAt > now.getTime()) {
    return { action: 'wait', reason: 'snoozed' };
  }

  const approved = job.status === 'pending';
  const inWindow = withinAutoWindow(now, cfg);

  if (!approved && !inWindow) {
    // Outside the window and never approved. Nudge once per snooze period so
    // a session can't be forgotten, but don't repeat on every tick.
    return needsReminder(job, now, cfg)
      ? { action: 'remind', reason: isWeekend(now, cfg.scheduleTimeZone) ? 'weekend' : 'outside-window' }
      : { action: 'wait', reason: 'outside-window' };
  }

  if (!serverReachable) {
    // Waiting for the PC is the whole point — never quietly divert to the Pi.
    return { action: 'wait', reason: 'pc-unreachable' };
  }

  return { action: 'run', reason: approved ? 'approved' : 'auto-window' };
}

// At most one nudge per snooze period, so an ignored session is a daily
// reminder rather than a message every minute.
function needsReminder(job, now, cfg) {
  if (!job.notified_at) return true;
  const last = new Date(job.notified_at).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= cfg.transcribeSnoozeHours * 3600_000;
}

export function snoozeUntil(now, cfg) {
  return new Date(now.getTime() + cfg.transcribeSnoozeHours * 3600_000);
}

export function buildTranscribeRow(jobId, { serverReachable = true } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${jobId}:${ACTION_NOW}`)
      .setLabel(serverReachable ? 'Transcribe now (PC)' : 'Transcribe when PC is up')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${jobId}:${ACTION_LATER}`)
      .setLabel('Remind me later')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${jobId}:${ACTION_PI}`)
      .setLabel('Use the Pi instead (slow)')
      .setStyle(ButtonStyle.Secondary)
  );
}

export function parseTranscribeAction(customId) {
  if (!customId?.startsWith(TRANSCRIBE_PREFIX)) return null;
  const [rawJobId, action] = customId.slice(TRANSCRIBE_PREFIX.length).split(':');
  const jobId = parseInt(rawJobId, 10);
  if (!Number.isInteger(jobId)) return null;
  if (![ACTION_NOW, ACTION_LATER, ACTION_PI].includes(action)) return null;
  return { jobId, action };
}

function windowDescription(cfg) {
  const pad = (h) => String(h).padStart(2, '0');
  const days = cfg.transcribeWeekdaysOnly ? 'weekdays' : 'every day';
  return `${days} ${pad(cfg.transcribeWindowStartHour)}:00–${pad(cfg.transcribeWindowEndHour)}:00`;
}

// The message the owner actually receives. It has to answer "why is nothing
// happening yet?" without them having to remember how any of this works.
export function transcribeRequestMessage({ meetingId, utteranceCount, now, cfg, serverReachable }) {
  const lines = [
    `🎙️ **Session #${meetingId}** is recorded and ready to transcribe — ${utteranceCount} clips.`,
    '',
    `It needs your PC's GPU, so it hasn't started. It will run by itself during **${windowDescription(cfg)}** (${cfg.scheduleTimeZone}) whenever the PC is on.`,
  ];

  if (cfg.transcribeWeekdaysOnly && isWeekend(now, cfg.scheduleTimeZone)) {
    lines.push('', "_It's the weekend, so the automatic window won't run — approve below if you want it done before Monday._");
  }
  if (!serverReachable) {
    lines.push('', "_Your PC isn't answering right now, so it'll wait for it either way._");
  }

  lines.push('', `Audio stays on the Pi until it's transcribed, so nothing is lost by waiting.`);
  return lines.join('\n');
}

export function reminderMessage({ meetingId, waitingSinceIso, cfg, now }) {
  const days = Math.max(1, Math.round((now.getTime() - new Date(waitingSinceIso).getTime()) / 86_400_000));
  const weekend = cfg.transcribeWeekdaysOnly && isWeekend(now, cfg.scheduleTimeZone);
  return (
    `⏰ **Session #${meetingId}** is still waiting to be transcribed (${days} day${days === 1 ? '' : 's'}).` +
    (weekend
      ? " It's the weekend, so the automatic window is off — approve below to run it now."
      : ` It'll go automatically during ${windowDescription(cfg)} if the PC is on.`)
  );
}
