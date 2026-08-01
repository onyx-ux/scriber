import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { pick, APPROVAL_REQUEST } from '../flavor.js';
import { configuredProviders, summariserLabel, withProvider } from '../pipeline/model-client.js';

export const APPROVE_PREFIX = 'scriber:approve:';
export const PARK_PREFIX = 'scriber:park:';

// Buttons are per-provider so the choice of WHICH summariser runs is made at
// the moment of approval, rather than being fixed by SUMMARY_PROVIDER when
// the session ended. Encoded as approve:<jobId>:<provider> — the plain
// approve:<jobId> form (no provider) still works and means "use the default",
// so approval DMs sent before this existed keep working after an upgrade.
const PROVIDER_BUTTON_STYLE = {
  ollama: ButtonStyle.Primary,
  gemini: ButtonStyle.Success,
  anthropic: ButtonStyle.Success,
};

// Short label per provider — the full summariserLabel (with model name) is
// too long for a button and gets truncated by Discord.
function providerButtonLabel(provider) {
  if (provider === 'ollama') return 'Ollama (local)';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'anthropic') return 'Claude';
  return provider;
}

export function buildApprovalRow(jobId, cfg) {
  // Without cfg (older callers) fall back to the single generic button.
  const providers = cfg ? configuredProviders(cfg) : [];

  const row = new ActionRowBuilder();
  if (providers.length <= 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPROVE_PREFIX}${jobId}`)
        .setLabel('Summarise now')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
    );
  } else {
    // Discord allows 5 components per row; there are at most 3 providers
    // plus "Not yet", so this always fits.
    for (const provider of providers) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${APPROVE_PREFIX}${jobId}:${provider}`)
          .setLabel(providerButtonLabel(provider))
          .setStyle(PROVIDER_BUTTON_STYLE[provider] ?? ButtonStyle.Secondary)
      );
    }
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${PARK_PREFIX}${jobId}`)
      .setLabel('Not yet')
      .setEmoji('💤')
      .setStyle(ButtonStyle.Secondary)
  );
  return row;
}

// Spells out what each button will actually use, since the buttons only have
// room for a provider name, not the model.
export function providerChoiceNote(cfg) {
  const providers = configuredProviders(cfg);
  if (providers.length <= 1) return '';
  const lines = providers.map((p) => `• **${providerButtonLabel(p)}** — ${summariserLabel(withProvider(cfg, p))}`);
  return `\n\nChoose who writes it:\n${lines.join('\n')}`;
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
      content:
        pick(APPROVAL_REQUEST, {
          meetingId: meeting.id,
          channel: meeting.channel_name,
          date: (meeting.started_at || '').slice(0, 10),
          count: utteranceCount,
        }) + providerChoiceNote(cfg),
      components: [buildApprovalRow(jobId, cfg)],
    });
    console.log(`[approval] DMed owner for meeting ${meeting.id} (job ${jobId})`);
  } catch (err) {
    console.error(
      `[approval] could not DM owner about meeting ${meeting.id} (${err.message}) — job is still parked and can be released with /pending`
    );
  }
}
