// Deleting a campaign, with thirty days to change your mind.
//
// A campaign holds every session anybody ever recorded at that table. Erasing
// that on the spot would be the single most destructive thing this bot can do,
// and it is also the one most likely to be done in a temper — after a bad
// session, an argument, a game that fell apart. So "delete" archives: the
// campaign disappears from every list immediately, and stays recoverable until
// the window closes.
//
// Nothing in this file removes a transcript, a session, or a line anybody
// spoke. Archiving sets a timestamp; restoring clears it. That is the whole
// mechanism, and it is deliberately the whole mechanism — see the note at the
// bottom about what does NOT happen on day thirty.

import { campaignLabel } from './resolve.js';

// Long enough to outlast the mood that caused it, and to survive somebody being
// away for a few weeks and coming back to find their table gone.
export const RESTORE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const restoreDeadline = (archivedAt) => new Date(Date.parse(archivedAt) + RESTORE_WINDOW_DAYS * DAY_MS);

export function daysLeftToRestore(archivedAt, now = Date.now()) {
  const left = restoreDeadline(archivedAt).getTime() - now;
  return left <= 0 ? 0 : Math.ceil(left / DAY_MS);
}

// Who may delete a campaign: the person who runs it, and the person whose
// hardware it all sits on. Nobody else -- not a player at the table, not
// another DM in the same Discord, not whoever happens to own the server.
export function mayDelete({ campaign, userId, cfg }) {
  if (!campaign || !userId) return false;
  return campaign.manager_user_id === userId || (Boolean(cfg?.ownerUserId) && userId === cfg.ownerUserId);
}

// Typing the name is the confirmation.
//
// Not a yes/no prompt: the whole point is to make the hand slow down and look
// at which campaign this is. Compared loosely on case and surrounding space,
// because insisting on exact capitalisation would only teach people to
// copy-paste it, which defeats the pause.
export const nameMatches = (typed, campaign) => {
  const wanted = String(campaign?.name ?? campaign?.channel_name ?? '').trim().toLowerCase();
  return wanted.length > 0 && String(typed ?? '').trim().toLowerCase() === wanted;
};

export function archiveCampaign({ db, cfg, campaignId, userId, typedName, now = new Date() }) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: 'missing', message: '⚠️ No such campaign.' };

  if (!mayDelete({ campaign, userId, cfg })) {
    return {
      ok: false,
      reason: 'not-yours',
      message: `⚠️ Only whoever runs **${campaignLabel(campaign)}** can delete it.`,
    };
  }

  if (!nameMatches(typedName, campaign)) {
    return {
      ok: false,
      reason: 'name-mismatch',
      message:
        `⚠️ That did not match. To delete **${campaignLabel(campaign)}**, type its name exactly: ` +
        `\`${campaign.name ?? campaign.channel_name}\`.`,
    };
  }

  const at = now.toISOString();
  if (!db.archiveCampaign(campaignId, userId, at)) {
    return { ok: false, reason: 'missing', message: '⚠️ No such campaign.' };
  }

  return {
    ok: true,
    campaignId,
    name: campaign.name ?? campaign.channel_name,
    archivedAt: at,
    daysLeft: RESTORE_WINDOW_DAYS,
    message:
      `🗑️ **${campaignLabel(campaign)}** is gone from every list. Nothing was erased — ` +
      `restore it within ${RESTORE_WINDOW_DAYS} days with \`/campaign restore\`, after which it stays ` +
      'archived and out of the way.',
  };
}

export function restoreArchivedCampaign({ db, cfg, campaignId, userId, now = Date.now() }) {
  const campaign = db.getCampaignIncludingArchived(campaignId);
  if (!campaign || !campaign.archived_at) {
    return { ok: false, reason: 'not-archived', message: '⚠️ That campaign is not deleted.' };
  }

  if (!mayDelete({ campaign, userId, cfg })) {
    return {
      ok: false,
      reason: 'not-yours',
      message: `⚠️ Only whoever ran **${campaignLabel(campaign)}** can bring it back.`,
    };
  }

  // Refused rather than quietly allowed, so "restorable for thirty days" means
  // something. The rows are all still there for whoever owns the Pi.
  if (daysLeftToRestore(campaign.archived_at, now) === 0) {
    return {
      ok: false,
      reason: 'expired',
      message:
        `⚠️ **${campaignLabel(campaign)}** was deleted more than ${RESTORE_WINDOW_DAYS} days ago, ` +
        'so it is past the window. Nothing has been erased — the bot owner can still bring it back by hand.',
    };
  }

  db.restoreCampaign(campaignId);
  return {
    ok: true,
    campaignId,
    name: campaign.name ?? campaign.channel_name,
    message: `📖 **${campaignLabel(campaign)}** is back, with every session it had.`,
  };
}

// What somebody may currently bring back.
export function restorableBy({ db, cfg, userId, now = Date.now() }) {
  const mine = Boolean(cfg?.ownerUserId) && userId === cfg.ownerUserId
    ? db.listArchivedCampaigns()
    : db.listArchivedCampaigns({ userId });

  return mine
    .map((c) => ({ ...c, daysLeft: daysLeftToRestore(c.archived_at, now) }))
    .filter((c) => c.daysLeft > 0);
}

// On day thirty, nothing happens.
//
// The window is what you may restore through this bot, not a countdown to a
// purge -- there is no timer in this codebase that erases a campaign, and this
// file did not add one. Losing an argument on a Tuesday should not be able to
// destroy four years of somebody's game, and a delete that quietly becomes
// permanent while nobody is looking is exactly how that happens.
//
// Erasing a campaign for real is therefore deliberately a thing a person has to
// do on purpose, with the database in front of them.
