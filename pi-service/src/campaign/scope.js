// Which campaign a read-only command is asking about.
//
// The campaign used to be "whatever server you typed this in", which needs no
// resolving. Once the app is USER-INSTALLED that stops working: a player can
// run /recap in any channel on Discord, and interaction.guildId is then some
// unrelated server that has no campaign at all.
//
// This is a privacy boundary, not just a lookup. Anyone on Discord can add a
// user-installed app to their own account, so "which campaign" cannot be
// answered from the command's arguments alone — otherwise a stranger could
// install Scriber and read another table's transcripts by naming their
// campaign. Outside the campaign's own server, the only campaigns offered are
// the ones the CALLER has actually spoken in.
//
// In the campaign's own server nothing changes: being in the server is the
// permission, exactly as before.
export const NOT_A_MEMBER =
  "I don't have you recorded in any campaign yet, so there's nothing for me to show you. " +
  'Once you have spoken in a session the bot recorded, these commands will work anywhere.';

export function resolveScope(interaction, db) {
  const asked = interaction.options?.getString?.('campaign') || null;

  // Run inside a server the bot records for: that is the campaign, and being
  // in the server is the permission.
  const here = interaction.guildId;
  if (here && db.listCampaigns().some((c) => c.guild_id === here)) {
    // An explicit campaign option still has to pass the membership check —
    // being in one table's server is not permission to read another's.
    if (!asked || asked === here) return { guildId: here };
  }

  const mine = db.listCampaignsForUser(interaction.user.id);
  if (mine.length === 0) return { error: NOT_A_MEMBER };

  if (asked) {
    const match = mine.find((c) => c.guild_id === asked);
    return match
      ? { guildId: match.guild_id, campaign: match, elsewhere: true }
      : { error: "That isn't a campaign you've played in, so I can't show you its records." };
  }

  if (mine.length === 1) return { guildId: mine[0].guild_id, campaign: mine[0], elsewhere: true };

  const list = mine.map((c) => `• **${c.campaign_name || c.channel_name}**`).join('\n');
  return {
    error: `You're in more than one campaign, so I don't know which you mean. Re-run with the \`campaign\` option:\n\n${list}`,
  };
}
