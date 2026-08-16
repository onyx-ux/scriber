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

export function buildCampaignView({ db, campaignId }) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return null;

  const consent = new Map(db.listConsent(campaignId).map((row) => [row.user_id, row]));
  const label = campaignLabel(campaign);

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
    })),

    sessions: db.listRecentMeetings(campaignId, 40).map((m) => ({
      meetingId: m.id,
      sessionNumber: m.session_number,
      // What every other surface calls this session, and what the vault names
      // the file. A bare meeting id is an implementation detail nobody has to
      // learn twice.
      ref: sessionRef(label, m.session_number),
      channel: m.channel_name,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      status: m.status,
      lines: db.countUtterances(m.id),
      // Whether there is anything to READ, which is not the same as whether
      // the session finished: a summary can fail, or be waiting for approval,
      // long after the transcript exists. The notes button is offered on this
      // rather than on status, so it is never offered for a session that would
      // open empty.
      hasNotes: Boolean(m.summary_json),
    })),
  };
}
