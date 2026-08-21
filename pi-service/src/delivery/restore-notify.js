// Telling the operator somebody has asked for a campaign back.
//
// A notification, not a control — the same decision made for the approval DM,
// and for the same reason. Buttons here would put Discord inside the loop: with
// the DM undelivered, or Discord down, a request would have nowhere to be
// decided. The answers travel in the message so it can be read on a phone, and
// the decision lives where it cannot get stuck.

import { pendingRestoreRequests } from '../campaign/restore-request.js';
import { QUESTIONS } from '../campaign/restore-request.js';

const trim = (text, max = 400) => {
  const value = String(text ?? '').trim();
  if (!value) return '_(left blank)_';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export function buildRestoreRequestDm(request) {
  const who = request.requesterName ? `**${request.requesterName}**` : `<@${request.requestedBy}>`;
  const standing = request.isTheCreator
    ? 'They are the person who deleted it.'
    : 'They played at this table — they are not the person who deleted it.';

  return [
    `📨 ${who} is asking for **${request.name}** back.`,
    `${standing} ${request.sessions} session${request.sessions === 1 ? '' : 's'}, ` +
      `${request.daysLeft} day${request.daysLeft === 1 ? '' : 's'} left in the window.`,
    '',
    `**${QUESTIONS.reason}**`,
    trim(request.reason),
    '',
    `**${QUESTIONS.whyDeleted}**`,
    trim(request.whyDeleted),
    '',
    `**${QUESTIONS.takingOwnership}**`,
    trim(request.takingOwnership, 200),
    '',
    'Approve or turn it down on the dashboard, under the campaign rail.',
  ].join('\n');
}

export async function notifyRestoreRequested({ discordClient, db, cfg, requestId }) {
  const request = pendingRestoreRequests({ db }).find((r) => r.id === requestId);
  if (!request) return false;

  if (!cfg?.ownerUserId) {
    console.log(`[restore] request ${requestId} filed (no OWNER_USER_ID set, so no DM sent)`);
    return false;
  }

  try {
    const user = await discordClient.users.fetch(cfg.ownerUserId);
    await user.send({ content: buildRestoreRequestDm(request) });
    console.log(`[restore] DMed owner about request ${requestId} (${request.name})`);
    return true;
  } catch (err) {
    console.error(
      `[restore] could not DM owner about request ${requestId} (${err.message}) — it is still waiting on the dashboard`
    );
    return false;
  }
}

// And telling the person who asked what was decided. Also best-effort: a
// decision that was made is made whether or not the DM lands.
export async function notifyRestoreDecided({ discordClient, cfg, request, approved, name }) {
  if (!request?.requested_by || !discordClient) return false;

  const content = approved
    ? `📖 **${name}** is back. Everything it had is where it was.`
    : `Your request for **${name}** was not approved this time. Nothing has been erased — ` +
      'if the situation changes, talk to the bot owner.';

  try {
    const user = await discordClient.users.fetch(request.requested_by);
    await user.send({ content });
    return true;
  } catch (err) {
    console.error(`[restore] could not DM the requester about ${request.id}: ${err.message}`);
    return false;
  }
}
