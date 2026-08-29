// How much of the owner's money a person may spend.
//
// This is the third opinion the operator holds about somebody, alongside the
// guest list and the level ceiling, and it is worth being clear about why it
// is allowed to be an opinion at all when web/viewer.js goes to such lengths
// to make sure nothing else is.
//
// A LEVEL answers "what may they see", and the answer is derivable: Discord
// knows who owns that server, the campaigns table knows who runs that game,
// the transcript knows who spoke at that table. Nobody has to decide, so
// nobody does — and a level that could be granted would be a level that could
// be granted by mistake.
//
// A TIER answers "how much of somebody else's GPU, API bill and disk may they
// use". There is no fact in the world that answers that. It is the person
// paying the bill deciding what they are willing to pay, which is exactly the
// kind of question a list is for. So tiers are granted, they go up as well as
// down, and none of that threatens the model next door.
//
// Six of them: 0, then 1 to 4, then 9. What each one actually buys is set by
// the operator and nothing here invents a number -- with nothing configured,
// every tier buys precisely what the bot allowed before tiers existed, so
// turning this on changes nobody's day until somebody says otherwise.
//
// 0 is free. It is the tier everybody starts on, and the one somebody is on
// when nobody has thought about them, so it has to be the tier that is safe to
// leave people on rather than the tier that is generous.
//
// 9 is the house. The owner is always on it and it is the one to hand to
// anybody who should not be metered at all.
//
// It is also the ONE TIER THAT IS NOT ONLY A CEILING. Putting somebody on it
// makes them an operator — the machinery, every campaign, the whole dashboard
// — because "the house" was always what it read as and pretending otherwise
// was a control that lied. That is a fact about tier 9 specifically and it
// changes nothing about the argument above for 0 to 4: those still answer only
// "how much may they spend", and none of them touches a level. See
// access/operators.js `runsThisBot` and docs/adr/0003 for why it goes that way
// round — a fourth way of BEING an operator, rather than a level derived from
// a number somebody typed.
//
// 5 to 8 DO NOT EXIST, and the hole is the point. Tiers between the paid band
// and the house are the ones most likely to be wanted later, and a gap means
// adding one is a new number rather than a renumbering of everybody's row.
// TIER_ASK_LIMITS is keyed by tier for the same reason: a positional list
// would silently change meaning the day tier 5 appeared.
//
// Today the only thing a tier governs is /campaign ask, because that is the
// only ceiling this bot has ever had. Transcription minutes and a token budget
// are the ones the operator has in mind next; they read their allowance from
// here, in the same shape, and the enforcement goes at the point that spends.

import { isOperator, HOUSE_TIER } from './operators.js';

export const TIERS = [0, 1, 2, 3, 4, 9];
export const FREE_TIER = 0;
// Borrowed from operators.js rather than written again here. Tier 9 stopped
// being only a spending ceiling the day it started making somebody an operator,
// and the two files must not be able to disagree about which number it is.
export const TOP_TIER = HOUSE_TIER;

// A tier that came from somewhere untrustworthy -- a column written by hand, a
// body posted at the actions endpoint -- is not a tier. Anything unrecognised
// is discarded rather than clamped, because clamping a typo silently picks a
// tier for somebody and the whole point of the column is that a person chose.
//
// The type check is doing real work and is not belt-and-braces. Number('') is
// 0, Number(null) is 0, Number([]) is 0 and Number(false) is 0 -- so the
// moment 0 became a real tier, `TIERS.includes(Number(value))` started
// answering "yes, tier 0" to an empty body, a missing column and a stray
// boolean. That reads as free rather than as nothing, which is the wrong
// answer in a quiet way: it is a person on the free tier instead of a person
// nobody has decided about, and a default of 3 would silently become 0.
export function isTier(value) {
  const n =
    typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value)
    : NaN;

  return Number.isInteger(n) && TIERS.includes(n);
}

// What tier this person is on.
//
// Every operator is always on the top one -- OPERATOR_USER_IDS as well as
// OWNER_USER_ID, because somebody trusted to run the machinery and then
// rate-limited out of it is worse than either decision on its own. Not a convenience: every limit here
// exists to stop somebody spending the owner's money, and the owner spending
// their own money is the thing being protected, not the thing being prevented.
// A bot that can rate-limit its owner out of their own API key is a bot with a
// trap in it, and this is the same trap maySignIn and the level ceiling both
// refuse to set.
export function tierOf(db, cfg, userId) {
  // `|| FREE_TIER` would be wrong here and wrong in a way that hides: tier 0
  // is falsy, so a configured default of 0 would fall through to whatever came
  // after the ||. Asked properly, every time.
  const fallback = isTier(cfg?.defaultTier) ? Number(cfg.defaultTier) : FREE_TIER;

  if (!userId) return fallback;
  if (isOperator(cfg, userId)) return TOP_TIER;

  const set = db?.tierOf?.(String(userId));
  return isTier(set) ? Number(set) : fallback;
}

// How many questions a day this tier buys. 0 is unlimited, which is what
// ASK_DAILY_LIMIT has always meant and is kept rather than reinvented.
//
// TIER_ASK_LIMITS is keyed by tier -- `0:5,2:40,9:0` -- because the tiers have
// a hole in them and a positional list would quietly re-point itself the day
// something filled it.
//
// A tier nobody wrote a number for INHERITS FROM THE TIER BELOW IT rather than
// falling back to the old global. An operator who writes "0:5,4:0" has said
// the free tier is worth five and the top of the paid band is unmetered; the
// honest reading of the three they skipped is "same as the one under you",
// which is the only reading that cannot hand somebody more than was written.
export function askLimitFor(cfg, tier) {
  const perTier = cfg?.tierAskLimits;
  const fallback = Number(cfg?.askDailyLimit ?? 0) || 0;

  if (!perTier || Object.keys(perTier).length === 0) return fallback;

  const want = isTier(tier) ? Number(tier) : FREE_TIER;
  for (const step of [...TIERS].filter((t) => t <= want).reverse()) {
    const written = perTier[step];
    if (Number.isFinite(written) && written >= 0) return written;
  }

  // Nothing at or below them was written, so nobody has said anything that
  // applies. The bot's own default is the answer, not zero -- zero is
  // unlimited here, and guessing "unlimited" is the wrong way to be wrong.
  return fallback;
}

// The whole allowance for one person, which is the shape the enforcement
// points want: what tier, what it buys, and nothing about how much they have
// used -- that is the caller's own counter to keep.
export function allowanceFor(db, cfg, userId) {
  const tier = tierOf(db, cfg, userId);
  return { tier, askLimit: askLimitFor(cfg, tier) };
}
