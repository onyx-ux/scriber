// A campaign's open threads, and how they get closed.
//
// Every write-up lists the threads a session left open, and until 2026-09-27
// nothing ever closed one: "still unresolved" was the sum of every mystery the
// campaign had ever had. Threads are now rows in campaign_threads with a
// status, opened by the session that first raised them.
//
// Closing is the table's decision, not the model's. The summariser is shown
// the open threads (meta.openThreads) and may name ones a session settled, with
// a sentence of evidence. That becomes a PROPOSAL on the thread, and whoever
// runs the campaign accepts it, turns it down, or closes threads by hand from
// the dashboard's Threads shelf. A model that confidently closes the wrong
// mystery would quietly delete a plot hook the DM was saving.

export const THREAD_STATUSES = ['open', 'resolved', 'dropped'];

// What the summariser is shown: the open threads' wording, oldest first.
export function openThreadTexts(db, campaignId) {
  if (!campaignId) return [];
  return db
    .listThreads(campaignId)
    .filter((t) => t.status === 'open')
    .map((t) => t.text);
}

// After a session is summarised: open the threads it raised, and turn any it
// says it settled into proposals. A "settled" thread that is not open on this
// campaign is ignored rather than invented.
export function recordSessionThreads(db, { campaignId, meetingId, notes }) {
  if (!campaignId) return { opened: 0, proposed: 0 };
  let opened = 0;
  let proposed = 0;

  for (const text of notes?.unresolvedThreads ?? []) {
    if (typeof text === 'string' && db.openThread(campaignId, text, meetingId)) opened += 1;
  }

  for (const r of notes?.resolvedThreads ?? []) {
    const thread = r?.thread ? db.findOpenThread(campaignId, r.thread) : null;
    // A thread this very session opened cannot also be the one it settled.
    if (!thread || thread.openedMeetingId === meetingId) continue;
    proposed += db.proposeThreadClose(thread.id, meetingId, r.evidence);
  }

  return { opened, proposed };
}
