// Handing a campaign to somebody else, and taking one nobody runs.
//
// Until now a campaign had exactly one way of acquiring a manager: whoever
// typed `/campaign create` got it, and that was permanent. Which is fine right
// up until the person who set the table up stops running the game — a DM hands
// the campaign to a player, somebody leaves the group, a table swaps who
// writes the notes. There was no answer to that except an operator with SSH
// and a text editor, and `viewer.js` has been telling people the answer exists
// for as long as HOW_TO_RAISE has said "hand them one from that campaign's
// settings and they will resolve to creator on their own".
//
// This is that. It is also, deliberately, the ONLY thing on this bot that
// creates a `creator` — and it does it the honest way round. Nothing here
// grants a level. It changes a fact in the world — who runs this campaign —
// and buildViewer derives the level from that fact the next time it is asked,
// exactly as it does for everybody else.
//
// WHO MAY HAND ONE OVER — the operator, and nobody else.
//
//   This is narrower than mayDelete, which a campaign's own manager passes, and
//   the difference is the point. Deleting a campaign disposes of something that
//   is already yours. Handing one over decides WHO SOMEBODY IS on this bot: the
//   person it lands on resolves to `creator` afterwards, with a creator's
//   controls over a table they did not have before.
//
//   Assigning who somebody is belongs to whoever runs the bot, in one place,
//   alongside the Level and Tier columns in the gatehouse. A manager who could
//   hand their campaign to a player would be a second way of minting a creator,
//   sitting inside a screen that is otherwise entirely about one campaign's own
//   records — and it would be reachable by every manager of every campaign on
//   the install. So: the operator.
//
//   What a manager keeps is everything about the campaign ITSELF. Inviting
//   players, naming characters, corrections, where the notes go — all still
//   theirs, all still gated at `manage`. Only the question of who runs it moved.
//
// WHO MAY RECEIVE ONE
//   Somebody already at the table. The roster is the union of everyone
//   enrolled, everyone with a character name, and everyone the bot has
//   actually heard — so "invite them first" is the whole prerequisite, and a
//   campaign cannot be handed to an id somebody typed wrong.
//
// AN UNCLAIMED ONE is the same act with nobody on the other side of it, and the
//   same person may do it. There is no looser rule for it: a table cannot vote
//   itself a DM, and in practice the case barely arises — src/index.js adopts
//   every unmanaged campaign to OWNER_USER_ID on boot, and `/campaign create`
//   claims the ones made after that.
import { campaignLabel } from './resolve.js';
import { runsThisBot } from '../access/operators.js';

// Whether this person may decide who runs this campaign. One answer, whether or
// not the campaign currently has a manager.
export function mayHandOver({ db, cfg, userId }) {
  return runsThisBot(db, cfg, userId);
}

const onRoster = (db, campaignId, userId) =>
  (db.listRoster?.(campaignId) ?? []).some((p) => p.userId === userId);

// Who this campaign could be handed to, for the picker.
//
// The current manager is left off rather than shown as the selected option: a
// list you pick your way back to the state you are already in is a list with a
// no-op in it, and the row above the picker already says who runs it.
export function handoverCandidates({ db, campaign }) {
  if (!campaign) return [];
  return (db.listRoster?.(campaign.id) ?? [])
    .filter((p) => p.userId && p.userId !== campaign.manager_user_id)
    .map((p) => ({
      userId: p.userId,
      displayName: p.displayName || p.characterName || p.userId,
      characterName: p.characterName ?? null,
      lines: p.lines ?? 0,
      // Somebody enrolled who has never spoken is a perfectly good next DM —
      // said out loud so the picker can draw the difference rather than
      // showing two identical-looking names.
      spoken: (p.lines ?? 0) > 0,
    }));
}

export function handOverCampaign({ db, cfg, campaignId, userId, toUserId }) {
  // getCampaign reads the view that excludes archived rows, so a deleted
  // campaign arrives here as "no such campaign" rather than as a row with a
  // timestamp on it. That is the right answer and not an accident worth
  // working around: a campaign nobody can see is not one to hand over, and
  // restoring it is the step that comes first.
  const campaign = db.getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: 'missing', message: '⚠️ No such campaign.' };

  // Named as what it is rather than as "not yours". A manager reading this runs
  // the campaign and would reasonably read a refusal as a mistake, so the
  // message says which question this is — who somebody IS, rather than what
  // this campaign does — and points at the half that is still theirs.
  if (!mayHandOver({ db, cfg, userId })) {
    return {
      ok: false,
      reason: 'not-yours',
      message:
        `⚠️ Who runs **${campaignLabel(campaign)}** is the bot owner's to set, alongside everybody's ` +
        'level and tier. Everything else about this campaign is still yours — the roster, the ' +
        'corrections, where the notes go.',
    };
  }

  const to = String(toUserId ?? '').trim();
  if (!to) return { ok: false, reason: 'nobody', message: '⚠️ Hand it to whom?' };

  if (to === campaign.manager_user_id) {
    return {
      ok: false,
      reason: 'no-change',
      message: `<@${to}> already runs **${campaignLabel(campaign)}**.`,
    };
  }

  // The roster, not a snowflake regex. An id that is merely well formed is an
  // id somebody could mistype into a campaign nobody at the table can reach.
  if (!onRoster(db, campaign.id, to)) {
    return {
      ok: false,
      reason: 'not-at-the-table',
      message:
        '⚠️ They are not at that table. Invite them to the campaign first — a campaign can only be ' +
        'handed to somebody already on its roster, so it cannot be handed to a mistyped id.',
    };
  }

  const from = campaign.manager_user_id;
  // setCampaignManager also enrols them, which matters for the unclaimed case:
  // somebody the bot has only ever HEARD is on the roster without a
  // campaign_members row, and the person running a campaign should have one.
  db.setCampaignManager(campaign.id, to);

  // Where the write-ups go, if it follows the manager. `dm` means "to whoever
  // runs this", so this quietly redirects every future recap to a different
  // person's inbox — which is worth saying rather than discovering.
  const dmFollows = campaign.output_mode === 'dm';

  // Taking one on yourself is not the same sentence as handing one to somebody
  // else, and the operator does both — settling an unclaimed table onto their
  // own name, or moving one between players. The message follows what happened.
  const taken = to === String(userId);
  const label = campaignLabel(campaign);
  const who = taken ? 'You' : `<@${to}>`;

  return {
    ok: true,
    campaignId: campaign.id,
    from: from ?? null,
    to,
    message:
      `📜 ${taken ? `You have taken on **${label}**.` : `<@${to}> now runs **${label}**.`} ` +
      `${who} can invite players, fix names and change where the notes go.` +
      // The old manager does not lose the table, only the running of it. Worth
      // saying: "handed it over" reads to some people as "removed".
      //
      // "On the roster" and not "still sees it", which would overclaim.
      // buildViewer's `player` claim is having SPOKEN at the table, not being
      // listed on it — so a DM who set a campaign up, handed it on and never
      // recorded a session has no claim left. Anybody who has actually played
      // keeps reading it, which is every real case and not all of them.
      (from && from !== String(userId) ? ` <@${from}> stays on the roster.` : '') +
      (from === String(userId) ? ' You stay on the roster.' : '') +
      (dmFollows
        ? ` The write-ups are set to go to whoever runs it, so they now go to ${taken ? 'you' : 'them'}.`
        : ''),
  };
}
