import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { pick, APPROVAL_REQUEST } from '../flavor.js';

export const APPROVE_PREFIX = 'scriber:approve:';
export const PARK_PREFIX = 'scriber:park:';

export function buildApprovalRow(jobId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPROVE_PREFIX}${jobId}`)
      .setLabel('Summarise now')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PARK_PREFIX}${jobId}`)
      .setLabel('Not yet')
      .setEmoji('💤')
      .setStyle(ButtonStyle.Secondary)
  );
}

// DMs the owner that a transcript is ready and parked, with a button to
// release it. Deliberately best-effort: if there's no OWNER_USER_ID, or the
// user has DMs closed, the job still sits safely in 'awaiting_approval' and
// can be released with /pending or /summarise, so nothing is ever lost.
export async function notifyApprovalNeeded({ discordClient, cfg, meeting, jobId, utteranceCount }) {
  if (!cfg.ownerUserId) {
    console.log(
      `[approval] meeting ${meeting.id} parked awaiting approval (no OWNER_USER_ID set, so no DM sent)`
    );
    return;
  }

  try {
    const user = await discordClient.users.fetch(cfg.ownerUserId);
    await user.send({
      content: pick(APPROVAL_REQUEST, {
        meetingId: meeting.id,
        channel: meeting.channel_name,
        date: (meeting.started_at || '').slice(0, 10),
        count: utteranceCount,
      }),
      components: [buildApprovalRow(jobId)],
    });
    console.log(`[approval] DMed owner for meeting ${meeting.id} (job ${jobId})`);
  } catch (err) {
    console.error(
      `[approval] could not DM owner about meeting ${meeting.id} (${err.message}) — job is still parked and can be released with /pending`
    );
  }
}
