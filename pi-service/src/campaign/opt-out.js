// Whether a player at this table may choose not to be recorded.
//
// Until 2026-11-14 the answer was always yes, and campaign/consent.js is the
// whole of how: each player is asked in a DM, silence is not agreement, and
// anybody can take it back with /campaign consent. That is still what a
// campaign does unless whoever makes it says otherwise.
//
// The other answer exists because the operator asked for it: a table of
// friends who have all already said, out loud, that the game is recorded, and
// for whom six DMs and six buttons is ceremony. For that table the question is
// asked once, of the person making the campaign, and their answer stands for
// the table:
//
//   * inviting somebody puts them on the roster as recorded, there and then;
//   * the bot sends them nothing — no DM, no buttons, no expiry;
//   * /campaign consent shows where they stand and offers no switch.
//
// What does NOT change is the capture path. db.mayRecord() is still the only
// question it asks, and it still answers yes only for a `granted` row — so
// somebody who wanders into the voice channel without having been added is
// skipped here exactly as they are anywhere else. The difference is who wrote
// the row, not whether one is needed.
//
// The bot telling nobody means the person running the table is the one who
// has to, and every surface that turns this on says so in as many words. In
// some places recording a conversation needs everyone in it to have agreed;
// that agreement is now something the DM holds rather than something this
// database does, and it is theirs to be able to show.

// Absent reads as "may" — a row from before the column existed, or an object
// built by a test that never mentions it, is an ordinary campaign.
export const canOptOut = (campaign) => campaign?.opt_out !== 0;

// What a body or a slash option said about it. Only an explicit no turns the
// opt-out off: this is the loose direction to be loose in, because the failure
// mode of misreading it is a table that asks when it need not have, never one
// that records somebody who was owed a question.
export function readsAsNoOptOut(value) {
  return value === false || value === 'no' || value === 'false' || value === 0 || value === '0';
}

// Put somebody on the roster as recorded, without asking them.
//
// Only ever called for a campaign where canOptOut() is false, by the two
// places an invitation is made. The same row /campaign invite would have
// ended in had they pressed yes, so nothing downstream can tell the two apart
// — which is the point, and also why the note above matters.
export function addWithoutAsking(db, { campaignId, userId }) {
  db.setConsent(campaignId, userId, true);
}

// Said to whoever turned it off, at the moment they did.
export const NO_OPT_OUT_DUTY =
  'Quill will not message your players about this, so telling them the game is recorded is yours to do.';

// Said to a player who runs /campaign consent, or presses an old Stop button,
// at a table like this.
export function noSwitchMessage(campaignName) {
  return (
    `🪶 **${campaignName}** records everyone at the table. Whoever runs it set it up that way, ` +
    'so there is no switch here for you to turn off.\n' +
    'If you would rather not be recorded, talk to them — they can take you off the roster with ' +
    '`/campaign remove`, and from that moment your microphone is skipped.'
  );
}
