// The things you can DO to a job, with no Discord in them.
//
// These used to live inside commands/index.js as handlers, which was fine
// while Discord was the only way to reach them. It is about to stop being: the
// dashboard needs the same operations, and two implementations of "approve
// this summary" would drift the first time one of them learned something the
// other didn't — a provider check, a guard against double-approval — and the
// bug would only show up on whichever surface was used less.
//
// So the rule is that neither surface owns the behaviour. Both call these.
// Discord wraps the result in its own flavour text; the dashboard renders it
// as a toast. Nothing here knows which asked.
//
// Every function returns { ok, message, ...detail } rather than throwing.
// A refusal ("that job is already running") is an ordinary outcome that the
// caller has to show the user either way, and making it an exception means
// each surface has to remember to catch it.
import {
  configuredProviders,
  isValidProvider,
  summariserLabel,
  withProvider,
} from './model-client.js';
import { snoozeUntil, ACTION_LATER, ACTION_PI, ACTION_NOW } from './transcribe-schedule.js';

// A provider the caller explicitly asked for but that isn't set up (no API
// key) should say so plainly, rather than silently falling back to the default
// and producing a summary from something they didn't choose.
export function providerUnusableReason(cfg, requested) {
  if (!requested) return null;
  if (!isValidProvider(requested)) return `⚠️ Unknown provider "${requested}".`;
  if (!configuredProviders(cfg).includes(requested)) {
    return (
      `⚠️ **${requested}** isn't set up on this bot — its API key is missing. ` +
      `Configured right now: ${configuredProviders(cfg).join(', ')}.`
    );
  }
  return null;
}

// --- summaries ---

export function approveSummary(db, cfg, { jobId, provider = null } = {}) {
  const unusable = providerUnusableReason(cfg, provider);
  if (unusable) return { ok: false, message: unusable };

  const job = db.getJob(jobId);
  if (!job) return { ok: false, message: '⚠️ That job no longer exists.' };
  if (job.type !== 'summarize') {
    return { ok: false, message: '⚠️ That job is a transcription, not a summary.' };
  }

  const released = db.approveJob(jobId, provider);
  if (!released) {
    return {
      ok: false,
      message: `⚠️ Session #${job.meeting_id} was already released (currently: ${job.status}).`,
      meetingId: job.meeting_id,
    };
  }

  return {
    ok: true,
    meetingId: job.meeting_id,
    provider: provider ?? job.provider ?? null,
    message: `✅ Released session #${job.meeting_id} — summarising with ${summariserLabel(withProvider(cfg, provider))}.`,
  };
}

// Summaries only, deliberately.
//
// db.approveAllWaiting() matches every parked job of any type, so this used to
// release parked TRANSCRIPTIONS too — jobs that were sitting there precisely
// because nobody had agreed to spend the GPU yet. It then reported the count
// as "summaries released", so the one action that could seize the PC in the
// middle of the evening was also the one that didn't say it had.
export function approveAllSummaries(db, cfg, { provider = null } = {}) {
  const unusable = providerUnusableReason(cfg, provider);
  if (unusable) return { ok: false, message: unusable };

  const waiting = db
    .listPendingJobs()
    .filter((j) => j.type === 'summarize' && j.status === 'awaiting_approval');

  if (waiting.length === 0) {
    return { ok: true, released: 0, message: 'Nothing is waiting for approval.' };
  }

  let released = 0;
  for (const job of waiting) if (db.approveJob(job.id, provider)) released += 1;

  return {
    ok: true,
    released,
    message:
      `✅ Released ${released} summar${released === 1 ? 'y' : 'ies'} — ` +
      `${summariserLabel(withProvider(cfg, provider))} will write ${released === 1 ? 'it' : 'them'}.`,
  };
}

// Re-run a summary that already exists — the /summarise case. Distinct from
// approving: this one is for a session that was summarised badly, or before a
// correction landed, and wants writing again.
export function resummarise(db, cfg, { meetingId, provider = null } = {}) {
  const unusable = providerUnusableReason(cfg, provider);
  if (unusable) return { ok: false, message: unusable };

  const meeting = db.getMeeting(meetingId);
  if (!meeting) return { ok: false, message: '⚠️ No such session.' };
  if (!db.countUtterances(meetingId)) {
    return {
      ok: false,
      message: '⚠️ That session has no transcript yet, so there is nothing to summarise. Transcribe it first.',
    };
  }

  db.requeueSummarizeNow(meetingId, provider);
  return {
    ok: true,
    meetingId,
    message: `📝 Queued session #${meetingId} to be written again by ${summariserLabel(withProvider(cfg, provider))}.`,
  };
}

export function parkSummary(db, { jobId } = {}) {
  const job = db.getJob(jobId);
  if (!job) return { ok: false, message: '⚠️ That job no longer exists.' };
  return {
    ok: true,
    meetingId: job.meeting_id,
    message: `💤 Left session #${job.meeting_id} parked. It will wait here until you release it.`,
  };
}

// --- transcriptions ---

// Shared by the DM buttons, /transcribe and the dashboard, so all three
// behave identically.
export function transcribeAction(db, cfg, { jobId, action = ACTION_NOW } = {}) {
  const job = db.raw.prepare(`SELECT * FROM jobs WHERE id = ? AND type = 'transcribe'`).get(jobId);
  if (!job) return { ok: false, message: '⚠️ That transcription job no longer exists.' };
  if (job.status === 'done') return { ok: false, message: '✅ That session is already transcribed.' };
  if (job.status === 'running') {
    return { ok: false, message: '⏳ That session is being transcribed right now.' };
  }

  if (action === ACTION_LATER) {
    const until = snoozeUntil(new Date(), cfg);
    db.snoozeTranscribeJob(job.id, until.toISOString());
    return {
      ok: true,
      meetingId: job.meeting_id,
      until: until.toISOString(),
      message:
        `⏰ Put off for ${cfg.transcribeSnoozeHours}h — I'll ask again after ` +
        `<t:${Math.floor(until.getTime() / 1000)}:f>. The automatic window is suppressed until then, ` +
        'so nothing will touch the PC.',
    };
  }

  if (action === ACTION_PI) {
    // Explicitly asked for the slow path, so bypass the whole GPU schedule.
    db.approveTranscribeNow(job.id);
    db.setSetting(`transcribe_target_${job.id}`, 'pi');
    return {
      ok: true,
      meetingId: job.meeting_id,
      message: '🐌 Queued on the Pi instead — no GPU needed, but expect hours rather than minutes.',
    };
  }

  db.approveTranscribeNow(job.id);
  return {
    ok: true,
    meetingId: job.meeting_id,
    message: "▶️ Approved — it'll start within a minute, as soon as the PC answers.",
  };
}

// --- a campaign's records ---
//
// The /correct and /dm side of the house. Same rule as above: the dashboard
// and the Discord commands both call these, so a guard added for one is a
// guard the other gets.

// A correction is a fact about ONE game's invented names. Scoping is not a
// nicety — rewriting another table's transcripts with it is silent corruption
// that nobody would notice until a recap named the wrong NPC.
export function addCorrection(db, { campaignId, wrong, right, rewrite } = {}) {
  const from = String(wrong ?? '').trim();
  const to = String(right ?? '').trim();

  if (!from || !to) return { ok: false, message: '⚠️ Both the wrong text and the correct text are required.' };
  if (from.toLowerCase() === to.toLowerCase()) {
    return { ok: false, message: '⚠️ Those are the same thing — nothing to correct.' };
  }

  // Saved first so it applies to every future session, then replayed over
  // everything already transcribed.
  db.addCorrection(campaignId, from, to);
  const changed = rewrite ? db.rewriteUtterances(campaignId, (text) => rewrite(text, from, to)) : 0;

  return {
    ok: true,
    wrong: from,
    right: to,
    changed,
    message:
      `✏️ "${from}" → "${to}". ${changed} existing line${changed === 1 ? '' : 's'} rewritten.` +
      (changed > 0
        ? ' Summaries written before this still say the old name — re-summarise a session to regenerate one.'
        : ''),
  };
}

export function removeCorrection(db, { campaignId, wrong } = {}) {
  const from = String(wrong ?? '').trim();
  if (!from) return { ok: false, message: '⚠️ Which correction? Name the wrong text.' };

  const removed = db.removeCorrection(campaignId, from);
  return removed
    ? {
        ok: true,
        message:
          `🗑️ Dropped the correction for "${from}". Lines already rewritten stay rewritten — ` +
          'this only stops it applying to new transcripts.',
      }
    : { ok: false, message: `⚠️ No saved correction for "${from}" — check the exact text.` };
}

// Naming someone also puts them on the roster, which is deliberate and worth
// being clear about: it does NOT grant consent to be recorded. Enrolment and
// consent are separate on purpose — being added to a table by someone else is
// exactly the thing consent exists to stop standing in for.
export function setCharacter(db, { campaignId, userId, name } = {}) {
  const character = String(name ?? '').trim();
  if (!userId) return { ok: false, message: '⚠️ Which player?' };
  if (!character) return { ok: false, message: '⚠️ Give the character a name.' };

  db.setCharacterName(campaignId, userId, character);
  const mayRecord = db.mayRecord(campaignId, userId);

  return {
    ok: true,
    userId,
    name: character,
    mayRecord,
    message:
      `🎭 Set to **${character}**.` +
      (mayRecord ? '' : ' They still have not agreed to be recorded, so nothing of theirs is captured.'),
  };
}

export function forgetCharacter(db, { campaignId, userId } = {}) {
  if (!userId) return { ok: false, message: '⚠️ Which player?' };
  const cleared = db.forgetCharacterName(campaignId, userId);
  return cleared
    ? { ok: true, userId, message: '🎭 Character name cleared. They stay on the roster.' }
    : { ok: false, message: '⚠️ They had no character name set.' };
}

// --- the two pause switches ---

// Named as they are stored, so the caller cannot invent a third queue by
// typo and have it silently accepted into settings forever.
export const PAUSABLE = { summarize: 'summarize_paused', transcribe: 'transcribe_paused' };

export function setPaused(db, { queue, paused } = {}) {
  const key = PAUSABLE[queue];
  if (!key) {
    return { ok: false, message: `⚠️ Unknown queue "${queue}". Expected one of: ${Object.keys(PAUSABLE).join(', ')}.` };
  }
  db.setSetting(key, paused ? 'true' : 'false');
  const what = queue === 'summarize' ? 'Summarising' : 'Transcription';
  return {
    ok: true,
    queue,
    paused: Boolean(paused),
    message: paused
      ? `⏸️ ${what} paused. Nothing new will start; anything mid-flight finishes.`
      : `▶️ ${what} resumed.`,
  };
}
