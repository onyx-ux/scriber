// Who may run what.
//
// Two tiers in Discord, and neither of them is a Discord permission:
//
//   THE TABLE   — /campaign join, leave, setchar, whoami, consent, plus the
//                 reads. These are the people playing, using the bot.
//   MANAGER     — the person who named the campaign. Renaming it and setting
//                 its roster reshape that campaign's records, so they belong
//                 to whoever runs the game.
//
// There used to be a third, BOT OWNER, holding the pipeline: transcribing,
// summarising, importing and pausing all spend the owner's GPU, API budget and
// disk. It is empty now rather than deleted, and that is worth saying plainly
// — every one of those moved to the dashboard under ADR-0004, and no slash
// command reaches any of them. isOwner below survives because the owner still
// WIDENS things rather than gating them: they resolve every campaign, and they
// can stop a session whose table has all left the server.
//
// Manage Server was the obvious gate and is the wrong one: the person running
// the game is often not the person administering the Discord, and in a server
// the bot was merely invited to, the two have nothing to do with each other.
// So the bot tracks who claimed each campaign itself.
//
// The owner is always allowed. There has to be someone who can unstick a
// campaign whose manager has left the server.
import { runsThisBot } from '../access/operators.js';

// `db` because the house tier is one of the ways of being an operator now, and
// it lives in a row rather than in the config file. Passing it is not optional:
// a call site that left it out would quietly answer "no" to somebody who runs
// this bot, which is the failure this whole module exists to stop happening in
// twelve places at once.
export function isOwner(userId, cfg, db) {
  return runsThisBot(db, cfg, userId);
}

export function isManager(userId, db, campaignId, cfg) {
  if (isOwner(userId, cfg, db)) return true;
  const manager = campaignId ? db.getCampaignManager(campaignId) : null;
  return Boolean(manager) && manager === userId;
}

// Both return null when allowed, or the message to reply with when not.
export function refuseUnlessOwner(userId, cfg, db) {
  if (isOwner(userId, cfg, db)) return null;
  return (
    "🔒 That one belongs to the bot owner — it spends the machine that does the transcribing and " +
    'summarising. Ask them to run it, or use the dashboard.'
  );
}

export function refuseUnlessManager(userId, db, campaignId, cfg) {
  if (isManager(userId, db, campaignId, cfg)) return null;

  const manager = campaignId ? db.getCampaignManager(campaignId) : null;
  return manager
    ? `🔒 <@${manager}> runs this campaign, so only they can change its records.`
    : "🔒 Nobody has claimed this campaign yet. Whoever runs the game should set it up with `/campaign create` — that claims it.";
}
