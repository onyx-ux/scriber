// Who may run what.
//
// Three tiers, and none of them is a Discord permission:
//
//   ANYONE      — /join, /leave, /setcharacter, /whoami, and the read-only
//                 player commands. These are the table using the bot.
//   MANAGER     — the person who named the campaign. Renaming it, setting the
//                 roster, and correcting transcripts all reshape that
//                 campaign's records, so they belong to whoever runs the game.
//   BOT OWNER   — the pipeline. Transcribing, summarising, importing and
//                 pausing spend the owner's GPU, API budget and disk. Nobody
//                 else has a reason to touch them, in any server.
//
// Manage Server was the obvious gate and is the wrong one: the person running
// the game is often not the person administering the Discord, and in a server
// the bot was merely invited to, the two have nothing to do with each other.
// So the bot tracks who claimed each campaign itself.
//
// The owner is always allowed. There has to be someone who can unstick a
// campaign whose manager has left the server.
export function isOwner(userId, cfg) {
  return Boolean(cfg.ownerUserId) && userId === cfg.ownerUserId;
}

export function isManager(userId, db, guildId, cfg) {
  if (isOwner(userId, cfg)) return true;
  const manager = guildId ? db.getCampaignManager(guildId) : null;
  return Boolean(manager) && manager === userId;
}

// Both return null when allowed, or the message to reply with when not.
export function refuseUnlessOwner(userId, cfg) {
  if (isOwner(userId, cfg)) return null;
  return (
    "🔒 That one belongs to the bot owner — it spends the machine that does the transcribing and " +
    'summarising. Ask them to run it, or use the dashboard.'
  );
}

export function refuseUnlessManager(userId, db, guildId, cfg) {
  if (isManager(userId, db, guildId, cfg)) return null;

  const manager = guildId ? db.getCampaignManager(guildId) : null;
  return manager
    ? `🔒 <@${manager}> runs this campaign, so only they can change its records.`
    : "🔒 Nobody has claimed this campaign yet. Whoever runs the game should set it up with `/campaign name:...` — that claims it.";
}
