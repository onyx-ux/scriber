// One word, looked for in every transcript a campaign has.
//
// `/campaign search` has done this in Discord for a long time, and the answer
// comes back as a message: twenty-five lines in a column four inches wide, gone
// up the channel by the next evening. The dashboard is where a search across
// twenty sessions can actually be read — grouped by night, each line a step
// from the transcript it came out of — and until 2026-11-14 it could only
// search one transcript at a time, after you had guessed which.
//
// Transcript lines only. The write-ups are searched by the page itself, out of
// the notes it has already read for the campaign's shelves, so a player — who
// may read every write-up and no transcript — gets a search that covers
// everything they are allowed to open without this route existing for them at
// all. See the gate on /search in web/server.js.
//
// A plain substring match, on purpose. The Discord command ranks, because it
// has room for a handful of lines and has to choose; this lists, newest night
// first and in the order things were said, because the question asked here is
// "where did that come up", and the answer to that is a place, not a score.

// Enough to fill a page, and few enough that a common word does not ship four
// hundred lines to a phone. Past it the page says so and asks for something
// narrower.
export const MAX_FOUND = 80;

// Two characters, the same floor the member search uses. One letter matches
// most of a campaign.
export const MIN_QUERY = 2;
const MAX_QUERY = 80;

export function cleanQuery(raw) {
  return String(raw ?? '').trim().slice(0, MAX_QUERY);
}

export function buildSearchView({ db, campaignId, query }) {
  const q = cleanQuery(query);

  // Character names, so a line reads the way the transcript it came from does.
  const characters = new Map(db.listCharacters(campaignId).map((c) => [c.user_id, c.character_name]));

  // One more than the page will show, which is the cheapest way to know whether
  // there were more.
  const rows = db.searchUtterances(campaignId, q, MAX_FOUND + 1);

  return {
    campaignId,
    query: q,
    truncated: rows.length > MAX_FOUND,
    lines: rows.slice(0, MAX_FOUND).map((r) => ({
      meetingId: r.meeting_id,
      sessionNumber: r.session_number,
      startedAt: r.started_at,
      ms: r.start_ms ?? 0,
      speaker: characters.get(r.user_id) || r.display_name || 'unknown',
      text: r.text ?? '',
    })),
  };
}
