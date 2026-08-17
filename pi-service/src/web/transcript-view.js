// One session's transcript, structured for reading rather than for saving.
//
// /transcript already served the plain text — the same bytes /export attached
// to a Discord message — and that stays, because a file you can keep is a
// different job from a page you can search. This is the page: every line with
// its clock, who said it, and enough about the session around it to answer
// "who talked most" and "what did corrections change here" without a second
// request.
//
// Not part of the campaign view for the same reason the campaign view is not
// part of the status snapshot: a four-hour session is thousands of lines, and
// nothing else on the page needs them.
import { sessionRef } from '../campaign/session-ref.js';
import { campaignLabel } from '../campaign/resolve.js';

// A transcript long enough to hit this is a transcript nobody is reading in a
// browser — it is a bug or a bad import. The count still reports the truth, so
// the page can say it is showing part of it.
const MAX_LINES = 20_000;

export function buildTranscriptView({ db, meetingId }) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return null;

  const campaign = meeting.campaign_id ? db.getCampaign(meeting.campaign_id) : null;
  const label = campaign ? campaignLabel(campaign) : meeting.channel_name;

  // Character names, so the transcript reads the way the notes do. Whisper
  // labels a clip with the Discord display name it was captured under, which
  // is the one name nobody at the table uses.
  const characters = new Map(
    (meeting.campaign_id ? db.listCharacters(meeting.campaign_id) : []).map((c) => [
      c.user_id,
      c.character_name,
    ])
  );

  const rows = db.listUtterances(meetingId);
  const lines = rows.slice(0, MAX_LINES).map((u) => ({
    ms: u.start_ms ?? 0,
    userId: u.user_id,
    speaker: characters.get(u.user_id) || u.display_name || 'unknown',
    text: u.text ?? '',
  }));

  // Who spoke, by line count. Not by duration: end_ms is the end of the clip
  // whisper was handed, which includes the silence either side of a short
  // answer, so seconds would flatter whoever pauses most.
  const tally = new Map();
  for (const u of rows) {
    const entry = tally.get(u.user_id) ?? { userId: u.user_id, lines: 0, displayName: u.display_name };
    entry.lines += 1;
    entry.displayName = u.display_name || entry.displayName;
    tally.set(u.user_id, entry);
  }
  const total = rows.length || 1;
  const speakers = [...tally.values()]
    .map((s) => ({
      userId: s.userId,
      name: characters.get(s.userId) || s.displayName || 'unknown',
      lines: s.lines,
      share: Math.round((s.lines / total) * 100),
      // Whose account owns this campaign — the person /campaign create was run
      // by. Deliberately not "the DM": on a real table those turn out to be
      // different accounts often enough that inferring one from the other
      // would be wrong on screen, and the loudest voice is not it either.
      // A fact, marked; nothing is concluded from it.
      manager: Boolean(campaign?.manager_user_id) && s.userId === campaign.manager_user_id,
    }))
    .sort((a, b) => b.lines - a.lines);

  return {
    meetingId,
    ref: sessionRef(label, meeting.session_number),
    sessionNumber: meeting.session_number,
    campaignId: meeting.campaign_id ?? null,
    campaign: label,
    channel: meeting.channel_name,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    status: meeting.status,
    hasNotes: Boolean(meeting.summary_json),
    total: rows.length,
    truncated: rows.length > MAX_LINES,
    lines,
    speakers,
    // What was rewritten on the way in. The transcript on disk is already
    // corrected, so this is the list of rules that were in force — not a diff.
    corrections: meeting.campaign_id
      ? db.listCorrections(meeting.campaign_id).map((c) => ({ wrong: c.wrong_text, right: c.correct_text }))
      : [],
  };
}
