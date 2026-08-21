// Asking for a campaign back, in Discord.
//
// A modal rather than three command options, because the questions want
// paragraphs and a slash command wants words. It also puts the three of them in
// front of somebody at the same time, which is the point: they are meant to be
// read together and answered honestly, not filled in one at a time to get past
// a gate.

import {
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';

import { QUESTIONS, requestRestore, wasAtTheTable } from '../campaign/restore-request.js';
import { campaignLabel } from '../campaign/resolve.js';
import { daysLeftToRestore } from '../campaign/archive.js';

export const RESTORE_MODAL_PREFIX = 'restore-ask:';

export const parseRestoreModal = (customId) => {
  const match = new RegExp(`^${RESTORE_MODAL_PREFIX}(\\d+)$`).exec(String(customId ?? ''));
  return match ? Number(match[1]) : null;
};

export function buildRestoreModal(campaign) {
  const modal = new ModalBuilder()
    .setCustomId(`${RESTORE_MODAL_PREFIX}${campaign.id}`)
    .setTitle(`Restore ${String(campaignLabel(campaign)).slice(0, 30)}`);

  const field = (id, label, style, required) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label.slice(0, 45))
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(style === TextInputStyle.Paragraph ? 900 : 200)
    );

  return modal.addComponents(
    field('reason', QUESTIONS.reason, TextInputStyle.Paragraph, true),
    field('whyDeleted', QUESTIONS.whyDeleted, TextInputStyle.Paragraph, true),
    field('takingOwnership', QUESTIONS.takingOwnership, TextInputStyle.Short, true)
  );
}

// Opening the form. Every refusal that can be known up front is made here, so
// nobody writes three paragraphs and is then told they were never eligible.
export async function openRestoreRequest(interaction, db, cfg, campaign) {
  const userId = interaction.user.id;

  if (!wasAtTheTable({ db, campaignId: campaign.id, userId })) {
    return interaction.reply({ content: '⚠️ That is not a table you were at.', flags: MessageFlags.Ephemeral });
  }

  if (daysLeftToRestore(campaign.archived_at) === 0) {
    return interaction.reply({
      content:
        `⚠️ **${campaignLabel(campaign)}** is past its window. Nothing has been erased — ` +
        'ask the bot owner directly.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const already = db.pendingRestoreRequest(campaign.id, userId);
  if (already) {
    return interaction.reply({
      content: `You have already asked about **${campaignLabel(campaign)}**. It is waiting on a decision.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.showModal(buildRestoreModal(campaign));
}

export async function handleRestoreModal(interaction, db, cfg, { notify } = {}) {
  const campaignId = parseRestoreModal(interaction.customId);
  if (!campaignId) return;

  const value = (id) => {
    try {
      return interaction.fields.getTextInputValue(id) ?? '';
    } catch {
      return '';
    }
  };

  const result = requestRestore({
    db,
    cfg,
    campaignId,
    userId: interaction.user.id,
    requesterName: interaction.user.username ?? null,
    reason: value('reason'),
    whyDeleted: value('whyDeleted'),
    takingOwnership: value('takingOwnership'),
  });

  // The DM to the operator is best-effort, exactly like the approval notice:
  // a request that was filed is filed whether or not Discord delivered the
  // note about it, and it is waiting on the dashboard regardless.
  if (result.ok && typeof notify === 'function') {
    try {
      await notify({ requestId: result.requestId });
    } catch (err) {
      console.error(`[restore] could not tell the owner about request ${result.requestId}: ${err.message}`);
    }
  }

  return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
}
