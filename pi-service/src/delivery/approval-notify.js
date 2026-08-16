import { pick, APPROVAL_REQUEST } from '../flavor.js';
import { configuredProviders, summariserLabel, withProvider } from '../pipeline/model-client.js';

// Kept only so the buttons already sitting in DM scrollback can be recognised
// and answered — nothing sends them any more. See handleApprovalButton.
export const APPROVE_PREFIX = 'scriber:approve:';
export const PARK_PREFIX = 'scriber:park:';

// Short label per provider — the full summariserLabel (with model name) is
// too long for a button and gets truncated.
function providerButtonLabel(provider) {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'anthropic') return 'Claude';
  return provider;
}

// buildApprovalRow lived here — the approve/park buttons on this DM. The
// decision moved to the dashboard, so nothing sends them any more; the
// prefixes stay only so the buttons already sitting in scrollback can be
// answered with a pointer instead of failing silently.

// Spells out what each provider will actually use, since the dashboard's
// buttons only have room for a provider name, not the model.
export function providerChoiceNote(cfg) {
  const providers = configuredProviders(cfg);
  if (providers.length <= 1) return '';
  const lines = providers.map((p) => `• **${providerButtonLabel(p)}** — ${summariserLabel(withProvider(cfg, p))}`);
  return `\n\nChoose who writes it:\n${lines.join('\n')}`;
}

// Where the decision is actually made. Appended to every operator DM.
//
// Without a DASHBOARD_URL the DM still tells you a session is waiting — that
// half is useful on its own — it just cannot say where to go, so it says that
// rather than pretending there is nowhere to go.
export function dashboardPointer(cfg) {
  return cfg.dashboardUrl
    ? `\n\n👉 Approve it on the dashboard: ${cfg.dashboardUrl}`
    : '\n\n👉 Approve it on the dashboard (set `DASHBOARD_URL` and I can link you straight to it).';
}

// DMs the owner that a transcript is ready and parked.
//
// A notification, not a control. It used to carry the approve/park buttons,
// which made Discord part of the pipeline: with Discord down, or the DM
// undelivered, there was no way to release a job except another Discord
// command. The decision now lives on the dashboard and this only says that
// there IS one to make — so the backend can be driven with Discord entirely
// absent.
//
// Still best-effort, and for the same reason as before: if there's no
// OWNER_USER_ID, or the user has DMs closed, the job sits safely in
// 'awaiting_approval' and the dashboard shows it regardless. A failed DM costs
// you knowing promptly, never the session.
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
        }) +
        providerChoiceNote(cfg) +
        dashboardPointer(cfg),
    });
    console.log(`[approval] DMed owner for meeting ${meeting.id} (job ${jobId})`);
  } catch (err) {
    console.error(
      `[approval] could not DM owner about meeting ${meeting.id} (${err.message}) — job is still parked and is waiting on the dashboard`
    );
  }
}
