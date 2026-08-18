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
// What makes a correction dangerous, learned by doing it twice.
//
// A correction of "a" to "b" passes every other check here, and because the
// rewriter is word-boundary anchored it replaced every standalone "a" in 1,010
// of a campaign's 6,844 lines. There is no undoing that — afterwards there is
// no telling which "b" used to be an "a" — and it took restoring from a
// snapshot to get the transcripts back.
//
// The first attempt at this guard used a fraction alone, at a quarter, and did
// not fire: 1,010 of 6,844 is 14.8%. Which was the lesson. There are two
// independent signals and the fraction is the weaker one:
//
//   LENGTH is the strong signal. Word-boundary matching on one or two
//   characters hits articles, initials and stray letters, never a name. No
//   legitimate correction target is that short — the shortest real one at this
//   table is "Vex".
//
//   VOLUME catches the longer term that happens to be everywhere. A thousand
//   lines is a lot however big the campaign is, so the floor does the work and
//   the fraction only stops it firing on a tiny campaign where five lines is
//   most of it.
const MIN_TERM_LENGTH = 3;
const BLAST_FRACTION = 0.1;
const BLAST_FLOOR = 200;

export function addCorrection(db, { campaignId, wrong, right, rewrite, force = false } = {}) {
  const from = String(wrong ?? '').trim();
  const to = String(right ?? '').trim();

  if (!from || !to) return { ok: false, message: '⚠️ Both the wrong text and the correct text are required.' };
  if (from.toLowerCase() === to.toLowerCase()) {
    return { ok: false, message: '⚠️ Those are the same thing — nothing to correct.' };
  }

  // Counted before anything is written. The rewrite is not reversible, so the
  // only safe place to find out how big it is, is beforehand.
  const wouldChange = rewrite ? db.countRewrites(campaignId, (text) => rewrite(text, from, to)) : 0;
  const total = db.countUtterancesIn(campaignId);

  const tooShort = from.length < MIN_TERM_LENGTH;
  const tooBroad = wouldChange >= BLAST_FLOOR && wouldChange > total * BLAST_FRACTION;

  if (!force && (tooShort || tooBroad)) {
    return {
      ok: false,
      wouldChange,
      total,
      needsConfirming: true,
      message:
        (tooShort
          ? `⚠️ "${from}" is too short to correct safely — matching on ${from.length} character` +
            `${from.length === 1 ? '' : 's'} catches articles and initials rather than a name. `
          : `⚠️ "${from}" appears in ${wouldChange} of this campaign's ${total} lines. `) +
        `It would rewrite ${wouldChange} line${wouldChange === 1 ? '' : 's'}, and that cannot be undone — ` +
        'afterwards there is no telling which words were changed. ' +
        'Use a longer or more distinctive term, or confirm it if you really mean it.',
    };
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

// Run every saved correction back over the campaign's existing transcripts.
//
// addCorrection already replays the one rule it just saved, so this is for the
// case that rule cannot cover: a session transcribed while the correction list
// was shorter — an import, a session recovered from a crash, anything
// backfilled — which is on disk uncorrected and would stay that way until
// somebody re-typed a rule that is already saved.
export function replayCorrections(db, { campaignId, rewrite } = {}) {
  const rules = db.listCorrections(campaignId);
  if (rules.length === 0) {
    return { ok: false, message: '⚠️ This campaign has no corrections saved, so there is nothing to replay.' };
  }

  const changed = db.rewriteUtterances(campaignId, (text) => rewrite(text, rules));
  return {
    ok: true,
    rules: rules.length,
    changed,
    message:
      `✏️ Replayed ${rules.length} correction${rules.length === 1 ? '' : 's'} — ` +
      `${changed} line${changed === 1 ? '' : 's'} rewritten. ` +
      (changed > 0
        ? 'Summaries written before this still say the old names — re-summarise a session to regenerate one.'
        : 'Everything already read the right way.'),
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

// --- where a campaign's notes are delivered ---

// Two of the three destinations, on purpose.
//
// 'channel' needs a channel id, and picking one means listing the server's
// channels and knowing which ones the bot may post in — something only Discord
// can answer, and something /campaign output already does properly with a
// channel picker. What the dashboard can do without guessing is the choice
// between "wherever we played" and "privately, to me", which is the switch
// that actually gets flipped when a table has a guest.
export const OUTPUT_MODES = {
  default: 'the channel the campaign was set up in',
  dm: "a direct message to the campaign's manager",
};

export function setOutput(db, { campaignId, mode } = {}) {
  const wanted = String(mode ?? '').trim();
  if (!Object.hasOwn(OUTPUT_MODES, wanted)) {
    return {
      ok: false,
      message:
        `⚠️ Unknown destination "${wanted}". From here it is ${Object.keys(OUTPUT_MODES).join(' or ')} — ` +
        'to post into a specific channel, use `/campaign output` in Discord, where the channels can be listed.',
    };
  }

  const campaign = db.getCampaign(campaignId);
  if (!campaign) return { ok: false, message: '⚠️ No such campaign.' };
  if (wanted === 'dm' && !campaign.manager_user_id) {
    return {
      ok: false,
      message: '⚠️ Nobody manages this campaign yet, so there is no one to DM. Claim it with `/campaign create` first.',
    };
  }

  // null, not the string 'default': a null mode is what the delivery code
  // reads as "post where we played", and storing the word would make it fall
  // through to the unknown branch.
  db.setCampaignOutput(campaignId, wanted === 'default' ? null : wanted, null);
  return { ok: true, mode: wanted, message: `📮 Notes will go to ${OUTPUT_MODES[wanted]}.` };
}

// --- throwing away a session that never had anything in it ---

// A recording where nobody was recordable — everyone declined, or the bot sat
// in an empty channel — produces a meeting with no audio and no transcript.
// It then queues, fails with "transcription produced nothing usable", and
// retries on the schedule forever, because there is nothing that could ever
// make it succeed. Until now the only cure was surgery on the database.
//
// The guard is what makes this safe rather than a delete button: a session
// with even one transcribed line cannot be discarded here, whatever its
// status. So this can throw away an empty recording and can never throw away
// somebody's evening.
export function discardSession(db, { meetingId } = {}) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return { ok: false, message: '⚠️ No such session.' };

  const lines = db.countUtterances(meetingId);
  if (lines > 0) {
    return {
      ok: false,
      message:
        `⚠️ Session #${meetingId} has ${lines} transcribed line${lines === 1 ? '' : 's'}, so it is not empty. ` +
        'Only a session that never produced anything can be discarded.',
    };
  }

  const removed = db.discardEmptyMeeting(meetingId);
  if (!removed) {
    return { ok: false, message: `⚠️ Session #${meetingId} was not discarded — it is no longer empty.` };
  }

  return {
    ok: true,
    meetingId,
    message:
      `🗑️ Discarded empty session #${meetingId} and stopped it retrying. ` +
      'Its audio folder is left for the retention sweep to clear.',
  };
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
