// Deleting and restoring a campaign, from Discord.
//
// Both call the same functions the dashboard's buttons call, including the
// rule that makes this safe: the campaign's name has to be typed out. Discord
// has no modal to type it into from a slash command, so the name is a required
// option — which has the same effect, because you cannot submit the command
// without having looked at what you are naming.

import { MessageFlags } from 'discord.js';

import {
  archiveCampaign, restoreArchivedCampaign, restorableBy, RESTORE_WINDOW_DAYS,
} from '../campaign/archive.js';
import { campaignLabel } from '../campaign/resolve.js';

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

export async function handleCampaignDelete(interaction, db, cfg, target) {
  const result = archiveCampaign({
    db,
    cfg,
    campaignId: target.id,
    userId: interaction.user.id,
    typedName: interaction.options.getString('confirm'),
  });
  return say(interaction, result.message);
}

export async function handleCampaignRestore(interaction, db, cfg) {
  const userId = interaction.user.id;
  const waiting = restorableBy({ db, cfg, userId });

  if (waiting.length === 0) {
    return say(
      interaction,
      `You have nothing to restore. Campaigns deleted in the last ${RESTORE_WINDOW_DAYS} days appear here.`
    );
  }

  // Naming one restores it; naming none lists what is waiting, because the
  // whole point of the window is that somebody can come back later and find
  // out what they still have.
  const wanted = interaction.options.getString('campaign');
  if (!wanted) {
    const lines = waiting.map(
      (c) => `• **${campaignLabel(c)}** — ${c.sessions} session${c.sessions === 1 ? '' : 's'}, ` +
        `${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left`
    );
    return say(
      interaction,
      `Deleted, and still restorable:\n${lines.join('\n')}\n\n` +
        'Bring one back with `/campaign restore campaign:<name>`.'
    );
  }

  const asked = String(wanted).trim().toLowerCase();
  const found = waiting.find(
    (c) => String(c.id) === asked || String(c.name ?? c.channel_name ?? '').trim().toLowerCase() === asked
  );
  if (!found) {
    return say(interaction, `⚠️ Nothing deleted by that name is waiting to be restored.`);
  }

  const result = restoreArchivedCampaign({ db, cfg, campaignId: found.id, userId });
  return say(interaction, result.message);
}
