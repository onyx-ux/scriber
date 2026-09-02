// Asking for a deleted campaign back, from Discord.
//
// Deleting itself is the dashboard's now. It wants a typed-name confirmation
// and a screen that shows what is about to go — a slash command can demand the
// typed name but cannot show you the thing you are typing it about.
//
// Restoring stayed, and the asymmetry is deliberate rather than left over.
// Deleting is the creator's decision; restoring is not. The sessions in a
// campaign belong to everybody who sat at that table, so a table deleted in a
// temper should not be restorable by that same temper — and should not be lost
// forever because the person holding it is still angry. That makes restoring
// something a PLAYER needs to be able to start, and a player has no reason to
// have been admitted to the dashboard at all.

import { MessageFlags } from 'discord.js';

import { restoreArchivedCampaign, RESTORE_WINDOW_DAYS, daysLeftToRestore } from '../campaign/archive.js';
import { pendingRestoreRequests } from '../campaign/restore-request.js';
import { runsThisBot } from '../access/operators.js';
import { openRestoreRequest } from './restore-request.js';
import { campaignLabel } from '../campaign/resolve.js';

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

// Everything this person could ask about: campaigns they were at the table for,
// still inside the window. Not the whole archive — a campaign somebody never
// played in is not theirs to petition about, and its existence is not something
// to advertise.
function askableBy(db, cfg, userId) {
  const all = db.listArchivedCampaigns();
  return all
    .map((c) => ({ ...c, daysLeft: daysLeftToRestore(c.archived_at) }))
    .filter((c) => c.daysLeft > 0)
    .filter((c) => runsThisBot(db, cfg, userId) || c.manager_user_id === userId || db.isCampaignMember?.(c.id, userId));
}

export async function handleCampaignRestore(interaction, db, cfg) {
  const userId = interaction.user.id;
  const operator = runsThisBot(db, cfg, userId);
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
