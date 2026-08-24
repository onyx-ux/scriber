// Whether this request may do this thing, and as whom.
//
// Every question about authority on the dashboard is answered here. Before
// this file existed the answer was spread across six places — the door check
// and the action gate were private to web/server.js, the levels were in
// viewer.js, the payload cut was in scope.js, and each action re-derived for
// itself whose id the operator console acts as. Nothing forced them to agree,
// and the gate that stands between a player and the owner's GPU could only be
// reached by standing an HTTP server up, so it was never tested directly.
//
// So this module is the one front door. viewer.js still owns the table of
// what each level may do and scope.js still owns the cutting — both are
// genuinely different jobs and both are deep — but nothing outside this file
// imports them any more. A caller asks here, or it does not ask.
//
// The order of the questions matters and is unchanged:
//
//   1. the door   — is there a credential at all (checkDoor)
//   2. the name   — who is walking through it (identify)
//   3. the act    — does that person's level cover this (mayAct)
//   4. the id     — whose name does the act happen under (actingUserId)
//   5. the answer — what of the reply is theirs to see (scopeStatus/Campaign)
import { cookieFrom, readSession } from './auth.js';
import { buildViewer, OPERATOR, maySee, mayManage, atLeast, LEVELS, LEVEL_WORDS } from './viewer.js';
import { scopeStatus, scopeCampaign } from './scope.js';

// The read-side surface, re-exported so a caller needs one import rather than
// three. These are not re-implemented here — they are the same functions.
export { maySee, mayManage, atLeast, LEVELS, LEVEL_WORDS, OPERATOR, buildViewer, scopeStatus, scopeCampaign };

// --- 1. the door ---

// Reads and writes are authenticated differently, on purpose.
//
// While this API was read-only, "no STATUS_TOKEN set" meaning "open" was a
// reasonable default on a home LAN: the worst it leaked was how many sessions
// had been recorded. Writes end that. An unauthenticated POST can spend the
// owner's API budget, seize the PC's GPU mid-evening, or stop the queue.
//
// So writes fail CLOSED: with no token configured there is no correct
// credential to present, and rather than treat that as "open to everyone" the
// server refuses every action and says why. Turning the dashboard from a
// window into a control panel has to be something the operator did on purpose.
export function checkDoor({ req, url, cfg, mutating }) {
  if (!mutating) {
    if (!cfg.statusToken) return null;
    const given = url.searchParams.get('token') || req.headers['x-status-token'];
    return given === cfg.statusToken ? null : { status: 401, message: 'bad token' };
  }

  if (!cfg.statusToken) {
    return {
      status: 403,
      message:
        'This bot has no STATUS_TOKEN set, so it will not accept actions from the dashboard. ' +
        'Set STATUS_TOKEN in pi-service/.env (and in the dashboard) to enable them.',
    };
  }
  const given = url.searchParams.get('token') || req.headers['x-status-token'];
  return given === cfg.statusToken ? null : { status: 401, message: 'bad token' };
}

// --- 2. the name ---

// WHO is asking, which is a different question from whether they may ask.
//
// The token above is a door key shared by everyone who can reach the dashboard;
// this is the name on the person walking through it. Both exist because they
// answer different things, and the order matters:
//
//   1. a signed-in Discord account, if there is one. Its level comes from what
//      that account owns, runs and plays in — see web/viewer.js.
//   2. otherwise the operator's own console, which is what the token has always
//      meant and still does.
//
// Sign-in therefore NARROWS what a request can see rather than widening it,
// which is the safe direction: a bug here shows somebody too little.
//
// DASHBOARD_REQUIRE_LOGIN flips (2) off, so an install that has invited its
// players in stops handing anyone with the token the keys to the machinery. It
// is off by default on purpose — turning it on before you have signed in once
// would lock you out of your own Pi.
export function identify({ req, db, cfg, client }) {
  const token = cookieFrom(req.headers.cookie);
  const session = token ? readSession(db, cfg, token) : null;

  if (session) {
    const guildsOwned = [...(client?.guilds?.cache?.values?.() ?? [])]
      .filter((g) => g.ownerId === session.userId)
      .map((g) => g.id);
    return buildViewer({ db, cfg, userId: session.userId, username: session.username, guildsOwned });
  }

  return cfg.dashboardRequireLogin ? buildViewer({ db, cfg, userId: null }) : OPERATOR;
}

// --- 3. the act ---

// What each action costs, and therefore who may fire it.
//
// Grouped by what is actually at stake rather than by what it is called:
//
//   machinery — spends the owner's GPU, API budget or disk, or stops the queue
//               for everybody. The owner's hardware, so the owner's decision.
//   manage    — reshapes one campaign's records. Whoever runs that table.
//
// Anything not listed is machinery. That default is the point: a new action
// added later is locked to dev until somebody deliberately decides otherwise,
// which is the failure direction that does not hand a player the pause button.
export const ACTION_NEEDS = {
  'roster/search': 'manage',
  'roster/invite': 'manage',
  'roster/character': 'manage',
  'roster/forget': 'manage',
  'corrections/add': 'manage',
  'corrections/remove': 'manage',
  'corrections/replay': 'manage',
  'campaign/output': 'manage',
  'campaign/create': 'manage',
  'campaign/delete': 'manage',
  // Restoring cannot go through the manage check: that check ends in
  // db.getCampaign(), and an archived campaign is invisible to it -- which
  // is the entire point of archiving. Ownership is checked instead by
  // campaign/archive.js, against the archived row itself.
  'campaign/restore': 'restore',
  // Deciding a request is the operator's, and only theirs.
  'campaign/restore-review': 'everything',
  // Ending somebody else's session is the operator's alone. A server owner
  // has `servers` too, so gating on that would hand it to them as well.
  'access/revoke': 'everything',
};

// The two actions you may aim at yourself wherever you are welcome.
//
// /campaign setchar has always let a player name their own character, and it
// is obviously theirs to name — the dashboard being stricter than the slash
// command for the same act was an accident of grouping it with the rest of the
// roster, not a decision.
export const OWN_BUSINESS = new Set(['roster/character', 'roster/forget']);

export function mayAct({ pathname, body, viewer, db }) {
  const name = /^\/actions\/(.+?)\/?$/.exec(pathname)?.[1];
  if (!name) return null; // unknown path — runAction 404s it properly

  if (OWN_BUSINESS.has(name) && viewer.userId && body?.userId === viewer.userId) {
    return maySee(viewer, Number(body?.campaignId))
      ? null
      : { status: 403, message: 'That is not a table you play at.' };
  }

  const needs = ACTION_NEEDS[name] ?? 'machinery';

  if (needs === 'restore') {
    return viewer.can.manage
      ? null
      : { status: 403, message: 'You can read this campaign, but not change it.' };
  }

  if (needs === 'everything') {
    return viewer.can.everything
      ? null
      : { status: 403, message: 'Only the bot owner can change who has access.' };
  }

  if (needs === 'machinery') {
    return viewer.can.machinery && viewer.can.approvals
      ? null
      : { status: 403, message: 'That is the bot owner\'s to decide — it spends their hardware or their API budget.' };
  }

  if (!viewer.can.manage) {
    return { status: 403, message: 'You can read this campaign, but not change it.' };
  }

  // Manage actions name a campaign, and a campaign you may manage is not the
  // same set as a campaign you may see. Resolved from the body rather than
  // trusted from it: an id you cannot manage is refused whatever else is true.
  const id = Number(body?.campaignId);
  if (!Number.isInteger(id) || id <= 0) return null; // the action's own validator will say so better

  // A campaign that does not exist is refused here too, rather than waved
  // through for the action to sort out. It used to defer, on the reasoning
  // that the action would validate — and corrections/add did not, so a made-up
  // id wrote a correction row belonging to no campaign. "Not a campaign you
  // run" is true of one that does not exist, and answering it here means every
  // future manage action inherits the check instead of having to remember it.
  return mayManage(viewer, id) && db.getCampaign(id)
    ? null
    : { status: 403, message: 'That is not a campaign you run.' };
}

// --- 4. the id ---

// Whose name the act happens under.
//
// A signed-in viewer acts as themselves. The operator's own console has no
// Discord session at all — it is the STATUS_TOKEN path — so it acts as the id
// the bot calls its owner, and if nothing is configured it acts as nobody and
// the caller has to refuse.
//
// This used to be written inline at six call sites in two spellings, which
// meant six independent decisions about what the operator console is. It is
// one decision, so it is one function: an install that changes its mind about
// the console's identity changes it here.
export function actingUserId(viewer, cfg) {
  return viewer?.userId || (viewer?.can?.everything ? cfg?.ownerUserId : null) || null;
}
