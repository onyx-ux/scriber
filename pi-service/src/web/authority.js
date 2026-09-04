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
// The order of the questions matters:
//
//   0. the guest list — may this account sign in at all (maySignIn)
//   1. the door   — is there a credential at all (checkDoor)
//   2. the name   — who is walking through it (identify)
//   3. the act    — does that person's level cover this (mayAct)
//   4. the id     — whose name does the act happen under (actingUserId)
//   5. the answer — what of the reply is theirs to see (scopeStatus/Campaign)
import { cookieFrom, readSession } from './auth.js';
import { buildViewer, OPERATOR, maySee, mayManage, atLeast, LEVELS, LEVEL_WORDS, HOW_TO_RAISE } from './viewer.js';
import { scopeStatus, scopeCampaign } from './scope.js';
import { isOperator, isPrimaryOperator, runsThisBot } from '../access/operators.js';

// The read-side surface, re-exported so a caller needs one import rather than
// three. These are not re-implemented here — they are the same functions.
export { maySee, mayManage, atLeast, LEVELS, LEVEL_WORDS, HOW_TO_RAISE, OPERATOR, buildViewer, scopeStatus, scopeCampaign };

// --- 0. the guest list ---

// Who may open a session at all, asked once at sign-in rather than on every
// request.
//
// This is the odd one out in this file, and worth saying why. Every other
// question here is answered from something the bot can check for itself — what
// a Discord account owns, runs or plays in — so nobody administers it and
// nothing drifts out of step with reality. This one is a list somebody typed.
//
// It exists because "derived from reality" and "shut for now" are different
// needs. An account with no claim on this bot already signs in and sees
// nothing, which is the right answer forever; it is not the right answer on
// the afternoon the dashboard first gets a public hostname and you would
// rather it simply refused strangers outright.
//
// So: unset, it is empty and everybody is welcome to a session that grants
// them nothing. Set, it is the whole guest list.
const fromEnv = (cfg) =>
  new Set(
    String(cfg?.dashboardAllowedUsers ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );

// Two halves of one list, and the page at /gatehouse/ shows them as two halves
// on purpose.
//
// DASHBOARD_ALLOWED_USERS is typed into a file and survives anything that
// happens to the database, but changing it costs an SSH session and a restart.
// dashboard_invites is a row somebody added from a browser in the ten seconds
// before their friend tried to sign in. Both are the guest list; neither is
// allowed to quietly overrule the other, so this is a union and the gatehouse
// refuses to offer a Remove button for a name it cannot actually remove.
function guestList(cfg, db) {
  const invited = fromEnv(cfg);
  for (const row of db?.listAccessRows?.() ?? []) {
    if (row?.invited && row.userId) invited.add(String(row.userId));
  }
  return invited;
}

export function maySignIn(cfg, userId, db = null) {
  // Falsy BEFORE stringifying, which is not the same check. `String(0 ?? '')`
  // is "0" -- a perfectly non-empty string that would sail past an emptiness
  // test and, with no list configured, be admitted as somebody.
  if (!userId) return false;
  const id = String(userId);

  const invited = guestList(cfg, db);
  if (invited.size === 0) return true;
  if (invited.has(id)) return true;

  // An operator is always on their own guest list.
  //
  // A list that can lock the people who run this out of their own dashboard is
  // a list that eventually will, and the only way back is an SSH session and a
  // text editor. Every other permission here is derived rather than granted;
  // this line is the one exception, and it exists so that the exception cannot
  // become a trap. It covers OPERATOR_USER_IDS as well as OWNER_USER_ID —
  // appointing a second operator and then locking them out with a list would
  // be the same trap wearing a different name. The house tier counts here too:
  // it is a way of running this bot, and being shut out of the dashboard by the
  // very page that grants it would be the trap at its most circular.
  return runsThisBot(db, cfg, id);
}

// Whether a guest list exists at all.
//
// Worth its own name because of what happens at the boundary: taking the last
// name off the list does not tighten anything, it opens the door to every
// Discord account. That is the correct reading of "no list" and it is the state
// every install starts in, but it is the opposite of what somebody pressing
// Remove expects, so the two callers that could cause it say so out loud.
export const listInForce = (cfg, db) => guestList(cfg, db).size > 0;

// Why a given id is admitted, which the gatehouse needs and maySignIn does
// not: the difference between a name it can strike off and a name it can only
// point at a config file about.
//
//   'owner'  OWNER_USER_ID, admitted unconditionally and not removable here
//   'op'     OPERATOR_USER_IDS, the same but not the primary owner
//   'house'  on tier 9, which makes them an operator — and unlike the two
//            above this one IS removable on the page, by moving them off it
//   'env'    DASHBOARD_ALLOWED_USERS, removable only in pi-service/.env
//   'list'   a row in dashboard_invites, removable on the page
//   'open'   no list is in use, so everybody is welcome
//   null     not admitted
//
// Ordered by which fact would survive the others being taken away, so a person
// who is both on the house tier and on the guest list is described by the one
// that would still let them in tomorrow.
export function admissionOf(cfg, userId, db = null) {
  if (!userId) return null;
  const id = String(userId);

  if (isPrimaryOperator(cfg, id)) return 'owner';
  if (isOperator(cfg, id)) return 'op';
  if (runsThisBot(db, cfg, id)) return 'house';
  if (db?.isInvited?.(id)) return 'list';
  if (fromEnv(cfg).has(id)) return 'env';
  return guestList(cfg, db).size === 0 ? 'open' : null;
}

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
// The header first, the query string second.
//
// Both are accepted because the test suite reaches this server without an
// nginx in front of it and `?token=` is how it knocks — eight files and some
// dozens of call sites, which is a lot of churn to buy a property the browser
// never exercises. What the order buys instead is cheap: nginx's own header is
// the credential in production, so a token that has leaked into somewhere URLs
// end up — a log line, browser history, a Referer — can no longer take
// precedence over it on a request that already carried the real one.
//
// The query string remains the worse habit of the two. Prefer the header
// anywhere new.
const tokenFrom = (req, url) => req.headers['x-status-token'] || url.searchParams.get('token');

export function checkDoor({ req, url, cfg, mutating }) {
  if (!mutating) {
    if (!cfg.statusToken) return null;
    const given = tokenFrom(req, url);
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
  const given = tokenFrom(req, url);
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
//
// WHICH USED TO MEAN the flag was the only thing standing between the internet
// and `dev`. /api/ has no gate on it — it cannot have one, the sign-in flow
// lives inside it — and nginx attaches a valid X-Status-Token to every request
// that reaches it, so checkDoor above always passes. With the flag off, "can
// reach this server" and "is the operator" were the same sentence, and the
// repo ships the flag off in three places (config/env.js, .env.example, and
// the pre-oauth ROLLBACK.md). One restored .env was the distance between a
// private bot and an open one.
//
// So the fallback now asks WHERE as well as WHETHER. nginx sets X-Quill-Local
// from `geo $local_console` — the visitor's own address after realip has
// rewritten it — and overwrites the field on every proxied request, so it
// cannot be sent in from outside. A request down the tunnel carries "0" no
// matter what its sender wrote.
//
// The console keeps working: an operator is on the LAN, so their request is
// local and the fallback still hands them `dev` with no Discord account, which
// is the whole reason the fallback exists. What ends is a stranger inheriting
// it because a config file was restored from a backup.
//
// TWO SIGNALS, and the order between them is the whole design.
//
// If nginx spoke, believe nginx. It sets the field on every proxied request
// from `geo $local_console`, so it is always present and always overwritten —
// "1" for the house, "0" for a visitor down the tunnel — and a client cannot
// smuggle its own past it.
//
// If nothing set it, the request did not come through nginx at all, and the
// only honest thing left to ask is who is on the other end of the socket.
// Loopback means the caller is inside this container: a health check, a test
// harness on 127.0.0.1. That is a fact about the connection rather than
// something a client asserts, and nginx can never look like it — it reaches
// this bot across the compose bridge as 172.21.0.x, so a tunnel request cannot
// arrive by this door even if it somehow arrived without the header.
//
// The two together are why the test suite needed no rewriting for this: it
// calls the server on 127.0.0.1 with no proxy in front, which is genuinely
// local and genuinely says so. Sending X-Quill-Local: 0 is how a test asks
// for the tunnel's answer instead — see no-session.test.js.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const isLocalConsole = (req) => {
  const said = req.headers['x-quill-local'];
  if (said !== undefined) return said === '1';
  return LOOPBACK.has(req.socket?.remoteAddress ?? '');
};

export function identify({ req, db, cfg, client }) {
  const token = cookieFrom(req.headers.cookie);
  const session = token ? readSession(db, cfg, token) : null;

  if (session) {
    const guildsOwned = [...(client?.guilds?.cache?.values?.() ?? [])]
      .filter((g) => g.ownerId === session.userId)
      .map((g) => g.id);
    return buildViewer({ db, cfg, userId: session.userId, username: session.username, guildsOwned });
  }

  if (cfg.dashboardRequireLogin) return buildViewer({ db, cfg, userId: null });
  return isLocalConsole(req) ? OPERATOR : buildViewer({ db, cfg, userId: null });
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
  // Handing out a way into your table, and taking it back. Both are the
  // manager's, on the same reasoning as roster/invite: deciding who may be
  // asked is running the campaign.
  'invite/link': 'manage',
  'invite/revoke': 'manage',
  // The other two are the invited person's, and they are not on this table's
  // terms at all — somebody arriving by link is by definition not yet at the
  // table, so every level here would refuse them and the feature could only
  // ever work for people who did not need it.
  //
  // What actually gates them is the token, checked in the action against a
  // stored row that can be revoked and expires. `signed-in` is the second half
  // of that: consent has to be recorded against a real Discord account, and
  // invite/accept reads it from the session rather than the body.
  'invite/peek': 'signed-in',
  'invite/accept': 'signed-in',
  'roster/character': 'manage',
  'roster/forget': 'manage',
  // Aimed at yourself it is OWN_BUSINESS below and needs only a seat at the
  // table. Aimed at anybody else it is refused twice: here, because a player
  // may not reach for another player's row, and again inside the action,
  // which refuses the manager too. Two layers saying the same no, because
  // this one moved — it used to be a thing the DM could do to the table.
  'roster/colour': 'manage',
  // Correcting a write-up: the first thing on this dashboard a player can
  // change that another player reads, and deliberately not the manager's.
  //
  // The people who can tell the summariser it misheard are the ones who were
  // in the room, and most of them do not run the campaign. Restricting this to
  // `manage` would leave the correction of a four-hour night to one person and
  // make the feature not worth having.
  //
  // What makes that safe is that none of these three can destroy anything. A
  // correction is a layer over the write-up; the summariser's text stays
  // underneath, unedited, and removing the correction brings the original line
  // straight back. The worst a table can do to itself is strike every line
  // through, which is visibly a redline rather than a deletion. Acting on
  // somebody else's correction is refused inside the actions, which also carry
  // the manager's override for taking one down.
  'recap/note': 'table',
  'recap/note-edit': 'table',
  'recap/note-remove': 'table',
  'corrections/add': 'manage',
  'corrections/remove': 'manage',
  'corrections/replay': 'manage',
  'campaign/output': 'manage',
  // Which rulebook the table plays out of, which decides nothing but where a
  // spell name in a write-up links to. Listed here rather than left to the
  // default on purpose: an unlisted action is `machinery`, and machinery is
  // the owner's hardware and the owner's API bill. This spends neither. It
  // was unlisted for exactly as long as it took to ask a DM to press it — the
  // page drew the buttons enabled for anyone who may manage the campaign, and
  // the answer that came back was about somebody else's GPU.
  'campaign/edition': 'manage',
  // Not 'manage', and the odd one out on this table for a reason.
  //
  // Every other entry here names an act ON something — a roster, a correction,
  // a campaign that already exists — so "may you manage that thing" is the
  // right question. Creating names nothing. There is no campaign yet to run,
  // which made `manage` a requirement to already run one before you could make
  // your first, and that is not a rule anybody chose: it is what you get from
  // filing a create next to eight updates.
  //
  // The real gate is being in the server, and it is enforced where it can
  // actually be checked — guildsCreatableBy, against Discord. See there.
  'campaign/create': 'signed-in',
  // Deciding who runs a campaign, which is a question about WHO SOMEBODY IS
  // rather than about what a campaign does — the person it lands on resolves to
  // `creator` afterwards. Assigning that belongs with the Level and Tier
  // columns, in one pair of hands.
  //
  // Deliberately tighter than campaign/delete, which a manager passes: throwing
  // away a campaign disposes of something already yours, and handing one on
  // makes somebody else into something. See campaign/handover.js.
  'campaign/manager': 'everything',
  'campaign/delete': 'manage',
  // Restoring cannot go through the manage check: that check ends in
  // db.getCampaign(), and an archived campaign is invisible to it -- which
  // is the entire point of archiving. Ownership is checked instead by
  // campaign/archive.js, against the archived row itself.
  'campaign/restore': 'restore',
  // Deciding a request is the operator's, and only theirs.
  'campaign/restore-review': 'everything',
  // Ending somebody else's session is the operator's alone. A server owner
  // has `servers` too, so gating on that would hand it to them as well. The
  // same goes for the guest list either side of it: who may hold a session on
  // this bot is one person's decision, and it is the person whose Pi it is.
  'access/revoke': 'everything',
  'access/invite': 'everything',
  'access/uninvite': 'everything',
  'access/level': 'everything',
  'access/tier': 'everything',
  'access/dismiss': 'everything',
};

// The three acts you may aim at yourself wherever you are welcome.
//
// /campaign setchar has always let a player name their own character, and it
// is obviously theirs to name — the dashboard being stricter than the slash
// command for the same act was an accident of grouping it with the rest of the
// roster, not a decision.
//
// The colour of your own name is the same kind of thing, only more so: it
// changes nothing but how you are written down, and the person it describes
// is the only one with an opinion worth having about it.
export const OWN_BUSINESS = new Set(['roster/character', 'roster/forget', 'roster/colour']);

export function mayAct({ pathname, body, viewer, db }) {
  const name = /^\/actions\/(.+?)\/?$/.exec(pathname)?.[1];
  if (!name) return null; // unknown path — runAction 404s it properly

  if (OWN_BUSINESS.has(name) && viewer.userId && body?.userId === viewer.userId) {
    return maySee(viewer, Number(body?.campaignId))
      ? null
      : { status: 403, message: 'That is not a table you play at.' };
  }

  const needs = ACTION_NEEDS[name] ?? 'machinery';

  // Having a name is the whole of this one. Not a level — a level answers what
  // somebody may see of what already exists, and this act brings a thing into
  // being that nobody could have a claim on yet.
  //
  // It is not a hole. What may actually be created, and where, is settled by
  // guildsCreatableBy against Discord's own answer to "are they in that
  // server", and then by createCampaign's name rules and ceilings. This line
  // only refuses the one case those cannot: nobody at all.
  //
  // The operator's console has no Discord session and passes on can.everything,
  // acting as the id in actingUserId — the same way it does everywhere else.
  if (needs === 'signed-in') {
    return viewer.userId || viewer.can.everything
      ? null
      : { status: 403, message: 'Sign in first — a campaign has to belong to somebody.' };
  }

  // Being at the table, which is a weaker claim than running it and a
  // stronger one than being signed in.
  //
  // `maySee` rather than `mayManage`, and a campaign id that has to be there:
  // an act at a table has to name which table, and one you cannot see is not
  // one you are at. The campaign is resolved from the body and then checked,
  // never trusted — the same rule the manage branch below follows, for the
  // same reason.
  if (needs === 'table') {
    // Who before which, and that order is the whole of this branch being
    // safe. Written the other way round once — resolve the campaign, and let
    // a missing id fall through to the action's own validator, which says
    // which field is wrong far better than this can. It does, and a request
    // with no session and no campaign id then got a 400 out of the validator
    // instead of a 403 out of the gate: the one shape where nothing had asked
    // who was calling. Everything else on this table fails closed on the
    // level first, so this does too.
    if (!viewer.userId && !viewer.can.everything) {
      return { status: 403, message: 'Sign in first — a correction has to be somebody\'s.' };
    }

    const at = Number(body?.campaignId);
    if (!Number.isInteger(at) || at <= 0) return null; // now the action says which field
    if (!db.getCampaign(at)) return { status: 403, message: 'That is not a table you play at.' };
    return maySee(viewer, at)
      ? null
      : { status: 403, message: 'That is not a table you play at.' };
  }

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
