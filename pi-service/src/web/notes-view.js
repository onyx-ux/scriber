// One session's notes, for reading.
//
// The recap the summariser wrote is stored as a JSON blob on the meeting and,
// until now, could only be read where it was originally posted — a Discord
// message that scrolls away — or by opening the exported markdown in Obsidian
// on whichever machine the vault syncs to. Neither is a way to look something
// up.
//
// This reads it back out. Deliberately tolerant, because the blob is written
// by a language model and has been through several prompt revisions: fields
// get added, a model occasionally returns a string where the schema said array
// (or the reverse), and a session summarised a year ago must still open. So
// nothing here assumes a shape — every field is coerced to what the page
// expects, and anything missing becomes empty rather than undefined.
import { sessionRef } from '../campaign/session-ref.js';
import { campaignLabel } from '../campaign/resolve.js';

// A model told to return an array of strings will sometimes return one string,
// or an array of objects with a single key. Take what is usable and drop the
// rest rather than rendering "[object Object]" into somebody's session notes.
function asLines(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        // The one shaped field: followUps are { assignee, task }.
        if (item.task) return item.assignee ? `${item.assignee}: ${item.task}` : String(item.task);
        const only = Object.values(item).filter((v) => typeof v === 'string');
        return only.length === 1 ? only[0].trim() : '';
      }
      return '';
    })
    .filter(Boolean);
}

function asScenes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((scene) => ({
      title: typeof scene?.title === 'string' ? scene.title.trim() : '',
      points: asLines(scene?.points),
    }))
    .filter((scene) => scene.title || scene.points.length);
}

export function buildNotesView({ db, meetingId }) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting) return null;

  const campaign = meeting.campaign_id ? db.getCampaign(meeting.campaign_id) : null;
  const label = campaign ? campaignLabel(campaign) : meeting.channel_name;

  // Written by a model and stored verbatim, so a malformed blob is a thing
  // that can genuinely be on disk. Say the notes are unreadable rather than
  // taking the whole request down with it.
  let notes = null;
  if (meeting.summary_json) {
    try {
      notes = JSON.parse(meeting.summary_json);
    } catch {
      return {
        meetingId,
        ref: sessionRef(label, meeting.session_number),
        campaignId: meeting.campaign_id ?? null,
        campaign: label,
        startedAt: meeting.started_at,
        unreadable: true,
      };
    }
  }

  return {
    meetingId,
    ref: sessionRef(label, meeting.session_number),
    campaignId: meeting.campaign_id ?? null,
    campaign: label,
    channel: meeting.channel_name,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    status: meeting.status,
    lines: db.countUtterances(meetingId),
    // No notes yet is an ordinary state, not an error: the session may still
    // be waiting to transcribe, or waiting on you to approve the summary.
    written: Boolean(notes),
    tldr: typeof notes?.tldr === 'string' ? notes.tldr.trim() : '',
    scenes: asScenes(notes?.scenes),
    partyDecisions: asLines(notes?.partyDecisions),
    unresolvedThreads: asLines(notes?.unresolvedThreads),
    followUps: asLines(notes?.followUps),
    npcsIntroduced: asLines(notes?.npcsIntroduced),
    locationsVisited: asLines(notes?.locationsVisited),
    lootAndRewards: asLines(notes?.lootAndRewards),
    funnyMoments: asLines(notes?.funnyMoments),
  };
}
