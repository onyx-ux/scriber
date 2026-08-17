// Taking consent back.
//
// campaign/consent.js asks the question. This is the other half, which was
// missing: until now a player who said yes could not say no again. The roster
// is the DM's to edit, so withdrawing meant asking the person recording you to
// stop recording you — which is not consent, it is a favour.
//
// Consent here is forward-looking, and only forward-looking. Withdrawing stops
// the microphone from the moment it is pressed; every session already recorded
// stays exactly as it is.
//
// That boundary is deliberate. A transcript is not one person's data — it is
// four or five people's record of an evening they all agreed to, and letting
// one of them reach back through it afterwards would quietly destroy something
// the others consented to and still want. What somebody agreed to at the time
// stays agreed to; what they have not agreed to yet is entirely theirs to
// refuse, for ever, without asking anyone.
//
// So there is nothing in this file that deletes anything. It cannot be misused
// because it cannot do that at all, and the standing screen says so plainly
// rather than leaving somebody to discover it.

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
    // Whether there is a past at all. Shown because it is the thing somebody
    // pressing "stop" most needs to understand about what stop does not do.
    hasRecord: lines > 0,
    retentionDays,
  };
}

// Stop from here on. Reversible, and says so.
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
