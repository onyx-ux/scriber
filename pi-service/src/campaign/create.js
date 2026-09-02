// Making a campaign, once, for both front doors.
//
// This used to live inside the slash command, which was fine while the slash
// command was the only way to do it. The dashboard needs the same act, and a
// second copy of these rules would drift: the folder-clash check in particular
// is not obvious, and a dashboard that skipped it would let two campaigns share
// a directory and interleave their notes.
//
// So the rules live here and both surfaces call in. Each writes its own success
// message — Discord's is a paragraph of next steps, the dashboard just opens the
// campaign — but no surface gets to decide who may create what, or under which
// name.

import { campaignFolder } from '../export/naming.js';
import { campaignNameClash, nameIsUsable } from './resolve.js';
import { isOwner } from './permissions.js';
import { campaignAllowance } from '../access/tiers.js';

// The ceilings are on other people, not on the operator. They exist so a shared
// bot cannot be filled up by one person, which is not a risk the owner poses to
// their own Pi.
export const MAX_CAMPAIGNS_PER_GUILD = 10;
export const MAX_CAMPAIGNS_PER_MANAGER = 20;


export function createCampaign({ db, cfg, guildId, userId, name }) {
  const wanted = String(name ?? '').trim();

  if (!guildId) {
    return { ok: false, reason: 'no-guild', message: '⚠️ A campaign has to belong to a server.' };
  }
  if (!wanted) {
    return { ok: false, reason: 'no-name', message: '⚠️ Give the campaign a name.' };
  }

  // A name that survives emoji and path stripping, or there is nothing left to
  // file the notes under.
  if (!nameIsUsable(wanted)) {
    return {
      ok: false,
      reason: 'unusable',
      message:
        `⚠️ I can't file anything under \`${wanted}\`. A campaign's name becomes the folder its notes live in ` +
        'and the start of every session reference (`Cipher_02`), and that one leaves nothing behind once emoji ' +
        'and path characters are stripped. Give it at least one letter or number.',
    };
  }

  const clash = campaignNameClash(db, wanted);
  if (clash) {
    return {
      ok: false,
      reason: 'clash',
      clashId: clash.id,
      message:
        `⚠️ There's already a campaign called **${clash.name || clash.channel_name}**` +
        `${clash.guild_id === guildId ? ' in this server' : ' on this bot'}, ` +
        `and its notes are filed in \`${campaignFolder({ channel_name: clash.name }, clash.name)}/\`. ` +
        'Two campaigns sharing a folder would interleave their session notes, so pick a different name.',
    };
  }

  if (!isOwner(userId, cfg, db)) {
    if (db.countCampaignsInGuild(guildId) >= MAX_CAMPAIGNS_PER_GUILD) {
      return {
        ok: false,
        reason: 'guild-full',
        message: `⚠️ This server already has ${MAX_CAMPAIGNS_PER_GUILD} campaigns, which is as many as I'll track for one Discord.`,
      };
    }

    // What their tier is worth, checked before the flat ceiling below because
    // it is the one that will actually bite: the free tier is five and the
    // flat ceiling is twenty, so a refusal that named twenty would be telling
    // somebody about a limit they are nowhere near.
    //
    // Only campaigns they RUN count. Playing at somebody else's table is
    // unlimited on every tier — it costs the person running that table, not
    // the person sitting at it — so this must never start counting membership.
    const purse = campaignAllowance(db, cfg, userId);
    if (purse.full) {
      return {
        ok: false,
        reason: 'tier-full',
        tier: purse.tier,
        limit: purse.limit,
        message:
          `⚠️ You already run ${purse.held} campaigns, which is all your tier allows. ` +
          'Deleting one you have finished with frees a place immediately, and joining ' +
          "somebody else's table has never counted against this — it is only the ones you run.",
      };
    }

    if (db.countCampaignsManagedBy(userId) >= MAX_CAMPAIGNS_PER_MANAGER) {
      return {
        ok: false,
        reason: 'manager-full',
        message: `⚠️ You already run ${MAX_CAMPAIGNS_PER_MANAGER} campaigns, which is as many as I'll let one person hold.`,
      };
    }
  }

  const id = db.createCampaign(guildId, wanted, userId);

  return {
    ok: true,
    id,
    name: wanted,
    guildId,
    folder: campaignFolder({ channel_name: wanted }, wanted),
  };
}

// Which servers this person may start a campaign in.
//
// Deliberately narrower than the slash command, which lets any member of a
// Discord create there. Claiming a table is an entryway act and stays one —
// anybody this list turns away can still type `/campaign create` — so the web
// page can afford to offer only the servers somebody already has standing in,
// rather than asking Discord to confirm membership on every poll. See
// docs/adr/0004 for which side of that line each act sits on.
// Which servers this person may start a campaign in.
//
// The rule used to be `can.manage` plus a guild they own or already run a
// campaign in, and it was wrong in a way nobody noticed until somebody who was
// not the operator opened the page: it made starting a FIRST campaign
// impossible. You needed to already manage one to be offered the chance to
// make one, unless you happened to own the Discord outright. A new DM saw an
// empty picker and no explanation.
//
// Meanwhile `/campaign create` in Discord has never had a gate on it at all.
// The two surfaces were answering the same question differently, and the slash
// command was the one that was right — ADR-0004 puts "claiming a table that has
// none" among the acts that belong to whoever is at the table, not to whoever
// administers the bot.
//
// So the rule is now the one Discord already enforces by geometry: you can
// start a campaign in a server you are IN. Typing the command in a channel is
// proof of membership; a web page has no such proof, so it asks Discord —
// see isMemberOf in web/discord-bridge.js.
//
// `isMember` is injected rather than imported so this stays a rule rather than
// a Discord call, and so the tests can state a membership without a logged-in
// bot. Async because the honest answer is a REST read.
//
// What still stands between somebody and an unlimited number of campaigns is
// createCampaign itself: the name rules, the folder-clash check, and the two
// ceilings. Those are per-guild and per-manager and they did not move.
export async function guildsCreatableBy({ viewer, guilds = [], isMember }) {
  // Not signed in is the one no that needs no asking. The operator's own
  // console has no Discord session and every capability, and it keeps the run
  // of the house.
  if (viewer?.can?.everything) return guilds;
  if (!viewer?.userId) return [];

  const mine = [];
  for (const g of guilds) {
    if (await isMember?.(g.id, viewer.userId)) mine.push(g);
  }
  return mine;
}
