// Who runs this install.
//
// There used to be exactly one answer — OWNER_USER_ID — and it was written
// inline at a dozen call sites in three spellings:
//
//   Boolean(cfg?.ownerUserId) && userId === cfg.ownerUserId
//   cfg?.ownerUserId && id === String(cfg.ownerUserId)
//   Boolean(cfg.ownerUserId) && userId === cfg.ownerUserId
//
// Twelve independent decisions about what an operator is, two of which
// compared a string to a number and would have answered "no" to the right
// person. web/authority.js already made this argument for actingUserId and
// won it: an install that changes its mind about who runs it should change it
// in ONE place. This is that place.
//
// OPERATOR_USER_IDS adds people to the answer. OWNER_USER_ID stays exactly
// what it was and keeps the things that only make sense for one person.
//
// WHAT A SECOND OPERATOR GETS
//   The `dev` level, which is the machinery: the queue, the models, the
//   servers, the gatehouse, and every action the dashboard can take.
//   Tier 9, unmetered, for the same reason the owner is — a ceiling exists to
//   stop somebody spending the operator's money, and an operator spending it
//   is the thing being protected rather than prevented.
//   A permanent place on the guest list, so a list nobody has added them to
//   cannot lock them out.
//
// WHAT IT DOES NOT GET
//   The owner's DMs. Approval notices, transcription notices and restore
//   requests still go to OWNER_USER_ID alone — delivery/ never asks this
//   module. Two people getting every notification is how both start ignoring
//   them, and "who should this bot talk to" is a different question from "who
//   may act", even when the same person answers both today.
//   Orphaned campaigns. index.js adopts unmanaged campaigns to OWNER_USER_ID;
//   a second operator arriving should not silently take ownership of games.
//   The console's identity. The STATUS_TOKEN path has no Discord session and
//   acts as OWNER_USER_ID, because a request that proves only "somebody holds
//   the token" cannot pick which operator it is.
//
// WHERE IT IS SET
//   pi-service/.env, and nowhere else. Not the gatehouse, not the database.
//   Appointing somebody who can spend your GPU and your API bill should cost
//   an SSH session and a restart, and it should survive anything that happens
//   to the database — which is the same argument DASHBOARD_ALLOWED_USERS makes
//   for the half of the guest list that lives in a file.

// Everybody who runs this install, primary first. Strings, always: an id read
// from JSON is a string and an id read from a config file is a string, but an
// id that has been through a number somewhere is not, and === does not care
// how reasonable the comparison looked.
export function operatorIds(cfg) {
  const ids = [];
  const add = (value) => {
    const id = String(value ?? '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };

  add(cfg?.ownerUserId);
  for (const extra of String(cfg?.operatorUserIds ?? '').split(',')) add(extra);

  return ids;
}

// Whether this person runs the install. The question almost every caller has.
export function isOperator(cfg, userId) {
  // Falsy BEFORE stringifying, which is not the same check: String(0 ?? '') is
  // "0", a non-empty string that sails past an emptiness test. The same trap
  // maySignIn documents, and the reason this is a function rather than a
  // one-liner people retype.
  if (!userId) return false;
  return operatorIds(cfg).includes(String(userId));
}

// Whether this person is THE owner rather than an operator.
//
// Kept separate and used sparingly. The distinction matters in exactly two
// places — the DMs and campaign adoption — and everywhere else treating them
// differently would be a second permission model growing quietly beside the
// first one.
export function isPrimaryOperator(cfg, userId) {
  if (!userId) return false;
  return Boolean(cfg?.ownerUserId) && String(userId) === String(cfg.ownerUserId);
}

// How many people can spend this install's money. The gatehouse says it out
// loud, because "there are two of you" is worth seeing on the page that
// decides who gets in.
export const operatorCount = (cfg) => operatorIds(cfg).length;
