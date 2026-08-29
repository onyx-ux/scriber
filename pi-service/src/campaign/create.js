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
export function guildsCreatableBy({ db, viewer, guilds = [] }) {
  if (!viewer?.can?.manage) return [];
  if (viewer.can.everything) return guilds;

  const mine = new Set(viewer.guildIds ?? []);
  const manageable = new Set(viewer.manageableCampaignIds ?? []);
  for (const c of db.listCampaigns()) {
    if (manageable.has(c.id)) mine.add(c.guild_id);
  }

  return guilds.filter((g) => mine.has(g.id));
}
