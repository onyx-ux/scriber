// Which Discords this bot is still in, and what happens to the tables in the
// ones it is not.
//
// The bot had no idea it could be removed from a server. There was no
// guildDelete handler anywhere, so a campaign whose Discord was deleted — or
// which the bot was simply kicked out of — stayed in the campaign list forever,
// looking exactly like a live table. Every control on it was already broken:
// /join has no channel to sit in, the roster names members of a server the bot
// cannot read, and a finished write-up has nowhere to be posted. It just said
// none of that.
//
// Two ways in, because one of them is not enough on its own:
//
//   * the EVENT, which is instant but only fires while the bot is running. A
//     server removed while the Pi was off is never announced; discord.js does
//     not replay it on the next connect.
//   * the RECONCILIATION on boot, which is what actually catches those. It
//     compares what the database has campaigns filed under against what Discord
//     will admit to, and it is the reason an install that has been in this
//     state for weeks sorts itself out on the next restart rather than needing
//     somebody to notice.
//
// Nothing here deletes anything, and that is the whole design. A stranded
// campaign keeps its sessions, its transcripts, its roster and its vault
// notes; it is hidden from the campaign list and listed in the gatehouse
// instead. If the bot is added back, guildCreate clears the flag and every one
// of its tables returns on its own — see rememberGuild in store/db.js. Being
// removed from a Discord is frequently an accident, and an accident should not
// cost anybody a decision.

// Discord's own word for "this server is having an outage", not "you were
// removed". discord.js sets `available: false` on the guild it hands to
// guildDelete when the guild is merely unreachable, and during a Discord
// incident that can arrive for every server at once. Treating those as
// departures would empty the entire campaign list during somebody else's
// outage, then quietly refill it — with the left_at dates all wrong.
export function isRealDeparture(guild) {
  return Boolean(guild?.id) && guild?.available !== false;
}

// Everything the bot can see right now, written down.
//
// Runs on `ready`, before the reconciliation below, because that one decides
// what is missing by asking this table what is present.
export function rememberVisibleGuilds(db, client) {
  const guilds = [...(client?.guilds?.cache?.values?.() ?? [])];
  for (const g of guilds) db.rememberGuild(g.id, g.name ?? null);
  return guilds.length;
}

// The catch-up pass: campaigns filed under a Discord the bot can no longer see.
//
// Deliberately driven from the CAMPAIGNS rather than from the guilds table. A
// guild the bot left before this code existed has no row at all, so a sweep of
// `guilds` would find nothing to mark — which is precisely the install this is
// written for.
//
// Guarded on the client actually being ready. `client.guilds.cache` is empty
// between login and the first GUILD_CREATE burst, and running this then would
// declare every server on the install departed at once. Called from the ready
// handler for that reason, and it double-checks rather than trusting the
// caller: an empty cache with campaigns on the books is not a believable
// answer, so it does nothing and says so.
export function reconcileGuilds(db, client, { log = console.log } = {}) {
  const live = new Set([...(client?.guilds?.cache?.keys?.() ?? [])]);
  const filed = db.guildIdsWithCampaigns();

  if (!filed.length) return { marked: 0, live: live.size };

  if (!live.size) {
    log('[guilds] Discord reported no servers at all — not marking anything as gone.');
    return { marked: 0, live: 0, skipped: true };
  }

  let marked = 0;
  for (const guildId of filed) {
    if (live.has(guildId)) continue;
    // COALESCE in markGuildLeft keeps the original date, so a guild already
    // known to be gone is not re-dated by this restart.
    if (db.markGuildLeft(guildId)) marked += 1;
  }

  if (marked) {
    log(`[guilds] ${marked} server(s) the bot is no longer in — their campaigns are in the gatehouse.`);
  }
  return { marked, live: live.size };
}

// The two events, installed once. Separated from index.js so the rules above
// can be tested against a fake client rather than a logged-in bot.
export function installGuildPresence(db, client, { log = console.log } = {}) {
  client.on('guildCreate', (guild) => {
    db.rememberGuild(guild.id, guild.name ?? null);
    log(`[guilds] added to ${guild.name ?? guild.id} — any campaigns filed there are back.`);
  });

  client.on('guildDelete', (guild) => {
    if (!isRealDeparture(guild)) {
      log(`[guilds] ${guild?.name ?? guild?.id} is unavailable (a Discord outage, not a removal) — leaving it alone.`);
      return;
    }
    db.markGuildLeft(guild.id);
    log(`[guilds] no longer in ${guild.name ?? guild.id} — its campaigns move to the gatehouse.`);
  });
}
