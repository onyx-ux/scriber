// One campaign, in enough detail to manage it.
//
// Deliberately NOT part of the status snapshot. That is polled every few
// seconds by anyone with the page open, and a roster, a correction list and a
// session history for every campaign the bot serves would make each poll grow
// with the size of the whole install — for data that changes a few times a
// month. This is fetched when you open a campaign, and not before.
//
// The other reason it is separate: status.js is deliberately free of user ids,
// because the snapshot can be published. This is not — a roster IS a list of
// Discord accounts, and managing one without them is impossible. So this
// endpoint is for the operator, and the split keeps that boundary visible
// rather than leaving it to whoever next edits the payload.
import { sessionRef } from '../campaign/session-ref.js';
import { campaignLabel } from '../campaign/resolve.js';

// Consent, per person, in the words the operator needs.
//
// 'no answer on file' rather than 'none' because the distinction that matters
// is not database state: pending, expired, declined and never-asked all mean
// the same thing to the capture path — do not record — and showing four
// different words for one outcome invites the reader to think one of them is
// permissive.
const CONSENT_WORDS = {
  granted: 'agreed to be recorded',
  declined: 'declined — never recorded',
  pending: 'asked, no answer yet',
  expired: 'invitation expired',
};

function consentFor(row) {
  if (!row) return { state: 'unasked', label: 'never asked', mayRecord: false };
  return {
    state: row.state,
    label: CONSENT_WORDS[row.state] ?? row.state,
    mayRecord: row.state === 'granted',
    decidedAt: row.decided_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

// What a session looks like in a list: one line of what happened, and the
// shape of what was found. Read from the stored recap rather than recomputed,
// and tolerant in the same way notes-view.js is — the blob is model output
// that has been through several prompt revisions, so a session summarised a
// year ago must still produce a row.
function facetsOf(summaryJson) {
  if (!summaryJson) return { tldr: '', npcs: 0, locations: 0, threads: 0 };
  let notes;
  try {
    notes = JSON.parse(summaryJson);
  } catch {
    return { tldr: '', npcs: 0, locations: 0, threads: 0, unreadable: true };
  }
  const count = (v) => (Array.isArray(v) ? v.length : v ? 1 : 0);
  return {
    tldr: typeof notes?.tldr === 'string' ? notes.tldr.trim() : '',
    npcs: count(notes?.npcsIntroduced),
    locations: count(notes?.locationsVisited),
    threads: count(notes?.unresolvedThreads),
  };
}

// The one word for where a session has got to.
//
// Derived from the meeting AND its live job together, because neither answers
// it alone: a meeting sitting at 'awaiting_summary' is waiting for the owner
// or waiting for the queue depending entirely on the job beside it, and those
// are opposite things to show someone.
function stateOf(meeting, job) {
  if (meeting.status === 'recording') return 'recording';
  if (meeting.status?.endsWith('_failed')) return 'failed';
  if (job?.status === 'awaiting_approval') return 'approval';
  if (job?.status === 'running') return 'working';
  if (job) return 'queued';
  if (meeting.status === 'done') return 'posted';
  return meeting.status ?? 'unknown';
}

export function buildCampaignView({ db, campaignId }) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return null;

  const consent = new Map(db.listConsent(campaignId).map((row) => [row.user_id, row]));
  const label = campaignLabel(campaign);

  // One query for every live job rather than one per session: a campaign with
  // forty sessions would otherwise mean forty round trips to answer a question
  // about the two that are actually moving.
  const jobs = new Map(db.listPendingJobs().map((j) => [j.meeting_id, j]));

  return {
    id: campaign.id,
    name: campaign.name,
    label,
    guildId: campaign.guild_id,
    channel: campaign.channel_name,
    claimed: Boolean(campaign.manager_user_id),
    output: campaign.output_mode ?? 'default',
    outputChannelId: campaign.output_channel_id ?? null,

    // listRoster is already the union of "on the roster", "has a character"
    // and "has actually spoken", which is the right list to manage: someone
    // the bot has recorded but nobody ever added is exactly the person whose
    // name needs setting.
    roster: db.listRoster(campaignId).map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      characterName: r.characterName,
      lines: r.lines ?? 0,
      enrolled: Boolean(r.enrolled),
      consent: consentFor(consent.get(r.userId)),
    })),

    corrections: db.listCorrections(campaignId).map((c) => ({
      wrong: c.wrong_text,
      right: c.correct_text,
      // How many lines in this campaign currently read the corrected way —
      // see db.countUtterancesContaining for why this counts the RIGHT text.
      // It answers "is this rule doing anything", which is the only reason to
      // look at a list of corrections at all.
      lines: db.countUtterancesContaining(campaignId, c.correct_text),
    })),

    sessions: db.listRecentMeetings(campaignId, 40).map((m) => {
      // A failed session's job is no longer pending, so the reason it failed
      // is not in the map above. Fetched only for the failures — one extra
      // query per broken session, none at all for a healthy campaign.
      const job = jobs.get(m.id) ?? (m.status?.endsWith('_failed') ? db.lastJobForMeeting(m.id) : null);
      const lines = db.countUtterances(m.id);
      return {
        meetingId: m.id,
        sessionNumber: m.session_number,
        // What every other surface calls this session, and what the vault
        // names the file. A bare meeting id is an implementation detail nobody
        // has to learn twice.
        ref: sessionRef(label, m.session_number),
        channel: m.channel_name,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        // How long the table actually played. Carried so the reader can say
        // "3:22 recorded" beside the line count — a 400-line session that ran
        // four hours and one that ran twenty minutes are different problems.
        durationMs:
          m.started_at && m.ended_at
            ? Math.max(0, new Date(m.ended_at).getTime() - new Date(m.started_at).getTime())
            : null,
        status: m.status,
        lines,
        state: stateOf(m, job),
        // The job carried alongside, so the session list can offer the
        // decision on the session it belongs to rather than making you find
        // the same session again in a separate queue.
        job: job
          ? {
              id: job.id,
              type: job.type,
              status: job.status,
              lastError: job.last_error ?? null,
              // Four attempts that all failed the same way is the difference
              // between "try again" and "this can never work" — the failure
              // screen offers to discard on the strength of it.
              attempts: job.attempts ?? 0,
              nextAttemptAt: job.next_attempt_at ?? null,
              provider: job.provider ?? null,
            }
          : null,
        // Whether there is anything to READ, which is not the same as whether
        // the session finished: a summary can fail, or be waiting for
        // approval, long after the transcript exists. The notes button is
        // offered on this rather than on status, so it is never offered for a
        // session that would open empty.
        hasNotes: Boolean(m.summary_json),
        // Empty and failed is the one state with no way forward, so the list
        // can offer to throw it away — see discardSession.
        discardable: lines === 0 && m.status !== 'recording',
        ...facetsOf(m.summary_json),
      };
    }),
  };
}
