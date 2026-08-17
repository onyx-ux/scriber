// Taking consent back.
//
// campaign/consent.js asks the question. This is the other half, which was
// missing: until now a player who said yes could not say no again. The roster
// is the DM's to edit, so withdrawing meant asking the person recording you to
// stop recording you — which is not consent, it is a favour.
//
// Two different things, deliberately separated, because they have very
// different costs and only one of them is reversible:
//
//   * STOP — from this moment on, your microphone is skipped. Nothing that
//     already exists is touched. Reversible: say yes again and recording
//     resumes.
//   * ERASE — everything you have already said is deleted from this campaign's
//     transcripts, and your names come out of the recaps written from them.
//     Not reversible by anything, including the bot.
//
// The third thing the design asked for — editing the notes already posted to
// Discord — cannot be done and is not pretended: the bot has never stored the
// ids of the messages it posted, so there is nothing to edit. Saying so before
// somebody presses the button is the whole point of describePlan().
import { correctionRegex } from './corrections.js';

// What a redacted name is replaced with. Not "[REDACTED]" — these are session
// notes people read for pleasure, and a recap studded with black bars reads as
// an incident report. "a player" keeps the sentence working: "a player paid the
// queue-jumping fee out of party funds unasked" is still the thing that
// happened, minus who did it.
export const ANONYMOUS = 'a player';

// Whether a match sits where a sentence begins, so the replacement can be
// capitalised. "a player paid the fee." reads as a typo, and a recap full of
// typos is one nobody trusts — which quietly punishes the person who withdrew
// by making their absence look like damage.
function atSentenceStart(text, offset) {
  return /(^|[.!?…]["'’)\]]?\s+|\n\s*|^\s*[-•*]\s*)$/.test(text.slice(0, offset));
}

const anonymise = (text, offset) => (atSentenceStart(text, offset) ? 'A player' : ANONYMOUS);

// Where this person stands right now, in facts rather than adjectives.
export function standing(db, { campaignId, userId, retentionDays = null } = {}) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return null;

  const consent = db.getConsent(campaignId, userId) ?? null;
  const { lines, sessions, displayName } = db.contributionOf(campaignId, userId);

  return {
    campaignId,
    state: consent?.state ?? 'unasked',
    mayRecord: consent?.state === 'granted',
    decidedAt: consent?.decided_at ?? null,
    lines,
    sessions,
    displayName,
    characterName: db.getCharacterName(campaignId, userId) ?? null,
    // Both halves of "is there anything to take out": a person who declined
    // before ever speaking has nothing, and should not be offered a delete
    // button that would do nothing.
    hasRecord: lines > 0,
    retentionDays,
  };
}

// Stop from now on. Reversible, and says so.
export function stopRecording(db, { campaignId, userId } = {}) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return { ok: false, message: '⚠️ That campaign no longer exists.' };

  const before = db.getConsent(campaignId, userId);
  if (before?.state === 'declined') {
    return { ok: true, alreadyStopped: true, message: 'You were already not being recorded here.' };
  }

  // decideConsent answers an OPEN invitation, so it declines to act on a
  // person who has already accepted — the case this whole file exists for.
  // Withdrawal is a different act and overwrites the standing answer.
  db.setConsent(campaignId, userId, false);

  return {
    ok: true,
    alreadyStopped: false,
    message: 'From now on your microphone is skipped rather than recorded and discarded.',
  };
}

// Turn recording back on for yourself. The same door, in the other direction —
// nobody else can push someone back through it.
export function resumeRecording(db, { campaignId, userId } = {}) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return { ok: false, message: '⚠️ That campaign no longer exists.' };

  db.setConsent(campaignId, userId, true);
  return { ok: true, message: 'You are being recorded again, from now on.' };
}

// Exactly what erasing would do, before it is done.
//
// Every number here is counted from the database rather than estimated, because
// the whole value of the confirmation is that it is not a guess. The `cannot`
// list is as important as the rest: a promise to remove something from
// somewhere the bot cannot reach would be a lie told at the worst moment.
export function describePlan(db, { campaignId, userId } = {}) {
  const now = standing(db, { campaignId, userId });
  if (!now) return null;

  const names = redactableNames(now);
  const meetings = db
    .listRecentMeetings(campaignId, 10_000)
    .filter((m) => m.summary_json)
    .map((m) => m.id);

  // Only count the recaps that actually name them. "12 sets of notes rewritten"
  // when nine of them never mentioned you is a scarier number than the truth.
  const affected = meetings.filter((id) => {
    const meeting = db.getMeeting(id);
    return names.some((name) => new RegExp(correctionRegex(name)).test(meeting.summary_json ?? ''));
  });

  return {
    campaignId,
    lines: now.lines,
    sessions: now.sessions,
    notes: affected.length,
    names,
    replacement: ANONYMOUS,
    // Kept, and worth saying out loud: erasing one voice must not erase the
    // evening. Everyone else agreed to be recorded and did not ask for this.
    keeps: 'what everyone else said, and the sessions themselves',
    cannot: [
      'unsend the notes already posted in Discord — the bot never stored their message ids, so there is nothing for it to edit',
      'reach anything anyone has already read, copied or exported',
    ],
  };
}

// The names a recap might refer to them by. Both, where both exist: notes are
// written from a transcript labelled with the display name, and the summariser
// rewrites it to the character name where it knows one.
function redactableNames({ displayName, characterName }) {
  return [characterName, displayName]
    .map((n) => String(n ?? '').trim())
    // A one or two character "name" would match half the words in the recap.
    // Refusing to redact it is safer than shredding the notes.
    .filter((n) => n.length >= 3)
    // Longest first, so "Kaelen Zyrthax" is replaced before "Kaelen" can leave
    // a dangling surname behind.
    .sort((a, b) => b.length - a.length);
}

// Do it.
//
// Order matters: the recaps are redacted BEFORE the lines go, because the plan
// that was shown to the person was counted from the state as it is now, and
// because a half-finished erasure that deleted the evidence but left the names
// is the worst of the possible outcomes.
export function erase(db, { campaignId, userId } = {}) {
  const now = standing(db, { campaignId, userId });
  if (!now) return { ok: false, message: '⚠️ That campaign no longer exists.' };
  if (!now.hasRecord) {
    return { ok: true, lines: 0, sessions: 0, notes: 0, message: 'There was nothing of yours on file to remove.' };
  }

  const names = redactableNames(now);
  const withNotes = db
    .listRecentMeetings(campaignId, 10_000)
    .filter((m) => m.summary_json)
    .map((m) => m.id);

  const notes = names.length
    ? db.redactSummaries(withNotes, (text) =>
        names.reduce(
          // The replacement is a function so that "$&" and friends inside a
          // name are literal, and so the sentence position is available.
          (out, name) => out.replace(correctionRegex(name), (_match, offset) => anonymise(out, offset)),
          text
        )
      )
    : 0;

  const { lines, meetings } = db.eraseSpeaker(campaignId, userId);

  // Their character name goes too. It is a mapping from their Discord account
  // to a name in this campaign's records, which is precisely the link they
  // asked to have removed.
  db.forgetCharacterName(campaignId, userId);

  return {
    ok: true,
    lines,
    sessions: meetings.length,
    notes,
    names,
    message: `Removed ${lines} line${lines === 1 ? '' : 's'} from ${meetings.length} transcript${meetings.length === 1 ? '' : 's'}.`,
  };
}
