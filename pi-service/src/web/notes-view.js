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
import { readingOf, redlineOf } from '../notes/redline.js';

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

// The write-up as a document: the prose fields, tidied, and nothing else.
//
// Pulled out of buildNotesView because it is now needed in three places that
// are not this page — the action that anchors a correction, the exporter, and
// /recap — and all four have to agree about what the lines of a write-up ARE.
// A correction is anchored to "the third point of the second scene", and if
// one caller counts a blank line and another does not, the third point is a
// different sentence depending on who is asking.
//
// So this is the one definition of the document, and everything that indexes
// into it starts here.
export function readable(notes) {
  return {
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

// The write-up as the table has corrected it, from the blob on the meeting.
// Null when there is nothing to read, so a caller can tell "no notes" from
// "notes that say nothing".
export function correctedWriteUp(db, meetingId) {
  const meeting = db.getMeeting(meetingId);
  if (!meeting?.summary_json) return null;
  let raw = null;
  try { raw = JSON.parse(meeting.summary_json); } catch { return null; }
  return readingOf(readable(raw), db.listRecapNotes(meetingId));
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

  // The document, the corrections on it, and the two readings of it.
  const written = readable(notes);
  const comments = db.listRecapNotes(meetingId);
  const reading = readingOf(written, comments);
  const redline = redlineOf(written, comments);

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
    // The write-up as the table has corrected it. The page draws these fields
    // exactly as it always did and never has to know corrections exist —
    // which is also why /recap, the export and the Discord post are all
    // correct without a line of their own: they read the same reading.
    ...reading,

    // And the same document with its marks showing, which is the only thing
    // on this page that knows. `base` is the summariser's own line, `marks`
    // are the corrections on it in the order they were made. The page draws
    // this instead of the fields above when the switch is set to correcting.
    //
    // Indexed against `written` — the tidied write-up, not the raw blob —
    // because that is the document a correction was anchored to. See
    // readable().
    marks: redline.parts,
    // Corrections whose line is not in the write-up any more. Never dropped:
    // somebody's own words about their own game, and losing one quietly is
    // the failure this whole feature is a defence against.
    orphaned: redline.orphaned,
    corrections: redline.count,
    // Write-ups this night had before this one, each with how many
    // corrections went with it. Offered as "6 corrections on the previous
    // version" rather than as a version history: the point is the
    // corrections, not the drafts.
    previous: db.listRecapVersions(meetingId),
    colours: meeting.campaign_id ? db.listVoiceColours(meeting.campaign_id) : {},
  };
}
