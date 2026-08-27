// Asking for a deleted campaign back.
//
// Deleting is the creator's decision. Restoring is not — and those are not the
// same act reversed, because the two decisions have different people standing
// behind them. A campaign belongs to whoever runs it, but the sessions inside
// it belong to everyone who sat at that table: their voices, their characters,
// four years of somebody's Thursday nights. A table deleted in a temper should
// not be restorable by the same temper twenty minutes later, and it should not
// be unrecoverable just because the person holding it is still angry.
//
// So anyone who was at the table may ask, the three answers are recorded, and
// the operator decides one at a time. The questions are not paperwork: "why was
// it deleted in the first place" and "are you taking ownership" are exactly what
// separates a rage-delete somebody regrets from a table that ended on purpose
// and should stay ended.

import { campaignLabel } from './resolve.js';
import { daysLeftToRestore } from './archive.js';
import { isOperator } from '../access/operators.js';

export const QUESTIONS = {
  reason: 'What is the reason for requesting the restore?',
  whyDeleted: 'Why was the campaign deleted in the first place?',
  takingOwnership: 'Are you intending to take ownership of the campaign?',
};

// isOperator used to live here, spelled (userId, cfg) -- the reverse of the
// one in access/operators.js. web/actions.js imported this one and called the
// other's argument order three lines apart, which compiled and would have
// answered the wrong question about the wrong person. Gone; callers import
// from access/operators.js, which is the only module that answers this now.

// Anyone who was actually at the table. Not the whole Discord — a campaign
// somebody never played in is not theirs to petition about, and the deleted
// campaign's existence is not something to advertise to a server.
export function wasAtTheTable({ db, campaignId, userId }) {
  if (!userId) return false;

  const campaign = db.getCampaignIncludingArchived(campaignId);
  if (!campaign) return false;
  if (campaign.manager_user_id === userId) return true;

  if (db.isCampaignMember?.(campaignId, userId)) return true;
  if (db.getConsent?.(campaignId, userId)?.state === 'granted') return true;

  // Last resort: they spoke in it. Somebody can have been at a table for a year
  // without appearing on a roster that predates rosters. Asked directly rather
  // than through listCampaignsForUser, which cannot see an archived campaign —
  // that being the entire point of archiving it.
  return spokeIn(db, campaignId, userId);
}

function spokeIn(db, campaignId, userId) {
  return Boolean(
    db.raw
      .prepare(
        `SELECT 1 FROM utterances u JOIN meetings m ON m.id = u.meeting_id
          WHERE m.campaign_id = ? AND u.user_id = ? LIMIT 1`
      )
      .get(campaignId, userId)
  );
}

export function requestRestore({
  db, cfg, campaignId, userId, requesterName = null,
  reason, whyDeleted = null, takingOwnership = null, now = Date.now(),
}) {
  const campaign = db.getCampaignIncludingArchived(campaignId);
  if (!campaign || !campaign.archived_at) {
    return { ok: false, reason: 'not-archived', message: '⚠️ That campaign is not deleted.' };
  }

  if (!wasAtTheTable({ db, campaignId, userId })) {
    return { ok: false, reason: 'not-yours', message: '⚠️ That is not a table you were at.' };
  }

  if (daysLeftToRestore(campaign.archived_at, now) === 0) {
    return {
      ok: false,
      reason: 'expired',
      message:
        `⚠️ **${campaignLabel(campaign)}** is past its window. Nothing has been erased — ` +
        'the bot owner can still bring it back by hand, so ask them directly.',
    };
  }

  const answer = String(reason ?? '').trim();
  if (!answer) {
    return { ok: false, reason: 'no-reason', message: `⚠️ ${QUESTIONS.reason}` };
  }

  const already = db.pendingRestoreRequest(campaignId, userId);
  if (already) {
    return {
      ok: false,
      reason: 'already-pending',
      requestId: already.id,
      message: `You have already asked about **${campaignLabel(campaign)}**. It is waiting on a decision.`,
    };
  }

  const id = db.createRestoreRequest({
    campaignId,
    requestedBy: userId,
    requesterName,
    reason: answer,
    whyDeleted: String(whyDeleted ?? '').trim() || null,
    takingOwnership: String(takingOwnership ?? '').trim() || null,
  });

  return {
    ok: true,
    requestId: id,
    campaignId,
    name: campaign.name ?? campaign.channel_name,
    message:
      `📨 Asked about **${campaignLabel(campaign)}**. What you wrote goes to the bot owner, who decides ` +
      'these one at a time — you will get a DM either way.',
  };
}

// Approving is the only thing that actually restores. Deliberately the only
// thing: there is no path where a ticket is filed and the campaign comes back
// without somebody having read it.
export function decideRestoreRequest({ db, cfg, requestId, decidedBy, approve, note = null }) {
  if (!isOperator(cfg, decidedBy)) {
    return { ok: false, reason: 'not-yours', message: '⚠️ Only the bot owner decides these.' };
  }

  const request = db.getRestoreRequest(requestId);
  if (!request) return { ok: false, reason: 'missing', message: '⚠️ No such request.' };
  if (request.state !== 'pending') {
    return { ok: false, reason: 'already-decided', message: `⚠️ That request was already ${request.state}.` };
  }

  const campaign = db.getCampaignIncludingArchived(request.campaign_id);
  const label = campaign ? campaignLabel(campaign) : `campaign ${request.campaign_id}`;

  db.decideRestoreRequest(requestId, { state: approve ? 'approved' : 'denied', decidedBy, note });

  // Turning one down is a decision that succeeded, not a failure. Reporting it
  // as ok:false would make "no" indistinguishable from "the button broke".
  if (!approve) {
    return {
      ok: true,
      approved: false,
      request,
      campaignId: request.campaign_id,
      name: label,
      message: `Turned down the request for **${label}**. It stays deleted, and nothing has been erased.`,
    };
  }

  // The campaign may have been restored by the operator directly while the
  // ticket sat there, which is not a failure — the answer is still yes.
  if (campaign?.archived_at) db.restoreCampaign(request.campaign_id);

  return {
    ok: true,
    approved: true,
    request,
    campaignId: request.campaign_id,
    name: label,
    message: `📖 **${label}** is back, with every session it had.`,
  };
}

// What the operator has waiting, with enough of the campaign attached to decide
// without going and looking it up.
export function pendingRestoreRequests({ db, now = Date.now() }) {
  return db.listRestoreRequests({ state: 'pending' }).map((r) => {
    const campaign = db.getCampaignIncludingArchived(r.campaign_id);
    return {
      id: r.id,
      campaignId: r.campaign_id,
      name: campaign ? campaignLabel(campaign) : `campaign ${r.campaign_id}`,
      sessions: campaign?.sessions ?? 0,
      requestedBy: r.requested_by,
      requesterName: r.requester_name,
      isTheCreator: campaign?.manager_user_id === r.requested_by,
      reason: r.reason,
      whyDeleted: r.why_deleted,
      takingOwnership: r.taking_ownership,
      askedAt: r.created_at,
      daysLeft: campaign?.archived_at ? daysLeftToRestore(campaign.archived_at, now) : 0,
    };
  });
}
