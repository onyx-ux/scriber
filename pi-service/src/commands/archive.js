// Deleting and restoring a campaign, from Discord.
//
// Deleting calls the same function the dashboard's button calls, including the
// rule that makes it safe: the campaign's name has to be typed out. A slash
// command has no dialog to type it into, so the name is a required option —
// which has the same effect, because you cannot submit the command without
// having looked at what you are naming.
//
// Restoring does NOT do the reverse. It opens a ticket. Deleting is the
// creator's decision, restoring is not, and the difference is the whole point:
// the sessions in a campaign belong to everybody who sat at that table, so a
// table deleted in a temper should not be restorable by that same temper, and
// should not be lost forever because the person holding it is still angry.

import { MessageFlags } from 'discord.js';

import { archiveCampaign, restoreArchivedCampaign, RESTORE_WINDOW_DAYS, daysLeftToRestore } from '../campaign/archive.js';
import { isOperator, pendingRestoreRequests } from '../campaign/restore-request.js';
import { openRestoreRequest } from './restore-request.js';
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

// Everything this person could ask about: campaigns they were at the table for,
// still inside the window. Not the whole archive — a campaign somebody never
// played in is not theirs to petition about, and its existence is not something
// to advertise.
function askableBy(db, cfg, userId) {
  const all = db.listArchivedCampaigns();
  return all
    .map((c) => ({ ...c, daysLeft: daysLeftToRestore(c.archived_at) }))
    .filter((c) => c.daysLeft > 0)
    .filter((c) => isOperator(userId, cfg) || c.manager_user_id === userId || db.isCampaignMember?.(c.id, userId));
}

export async function handleCampaignRestore(interaction, db, cfg) {
  const userId = interaction.user.id;
  const operator = isOperator(userId, cfg);
  const waiting = askableBy(db, cfg, userId);

  const wanted = interaction.options.getString('campaign');

  // No campaign named: say what could be asked about, and — for the operator —
  // what is currently waiting on them.
  if (!wanted) {
    const lines = waiting.map(
      (c) => `• **${campaignLabel(c)}** — ${c.sessions} session${c.sessions === 1 ? '' : 's'}, ` +
        `${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left`
    );

    const queue = operator ? pendingRestoreRequests({ db }) : [];
    const queueNote = queue.length
      ? `\n\n**${queue.length} request${queue.length === 1 ? '' : 's'} waiting on you** — ` +
        `${queue.map((r) => r.name).join(', ')}. The answers are on the dashboard.`
      : '';

    if (waiting.length === 0) {
      return say(
        interaction,
        `Nothing you were at the table for has been deleted in the last ${RESTORE_WINDOW_DAYS} days.${queueNote}`
      );
    }

    return say(
      interaction,
      `Deleted, and still inside the window:\n${lines.join('\n')}\n\n` +
        (operator
          ? 'Bring one back with `/campaign restore campaign:<name>`.'
          : 'Ask about one with `/campaign restore campaign:<name>` — it goes to the bot owner to decide.') +
        queueNote
    );
  }

  const asked = String(wanted).trim().toLowerCase();
  const found = waiting.find(
    (c) => String(c.id) === asked || String(c.name ?? c.channel_name ?? '').trim().toLowerCase() === asked
  );
  if (!found) {
    return say(interaction, '⚠️ Nothing deleted by that name is waiting, or it is not a table you were at.');
  }

  // The operator is the person who decides these, so asking themselves for
  // permission would be theatre.
  if (operator) {
    return say(interaction, restoreArchivedCampaign({ db, cfg, campaignId: found.id, userId }).message);
  }

  return openRestoreRequest(interaction, db, cfg, found);
}
