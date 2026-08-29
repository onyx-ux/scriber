// Who is looking, and what that entitles them to see.
//
// Four levels, and every one of them DERIVES from a fact about Discord that the
// bot can check for itself. Nobody has to administer this and there is no table
// of permissions to drift out of step with reality:
//
//   dev      you run this bot — OWNER_USER_ID, OPERATOR_USER_IDS, or the house
//            tier. It is your hardware, your GPU and your API bill, so you see
//            the machinery. The house tier is the one route that can be handed
//            out from the page rather than a file, and only by somebody the
//            file already names; see access/operators.js and docs/adr/0003.
//   owner    you own a Discord the bot is in. You see what is happening on
//            your own server, and its numbers.
//   creator  you made a campaign. You see that campaign wherever it lives,
//            across every server, and you run it.
//   player   you are at somebody's table. You can read the notes from the
//            games you were actually in.
//
// The levels are ordered but the SCOPE is a union, not a ladder: someone who
// owns one server and plays at a table on another sees both, because both are
// true about them. The level only decides how much machinery is on screen.
//
// That last sentence is what lets the operator hold an opinion about a level
// without the whole model coming apart. They may hold somebody DOWN from what
// they have earned, and — since the Level column learned to go both ways — up
// from it as well. Neither touches the scope. A granted `creator` gets a
// creator's controls over exactly the campaigns they already had a claim on,
// which may be none; making somebody actually run a campaign is a different
// act with its own module, campaign/handover.js. Nothing here invents a fact.
//
// The rule for what gets stripped below `dev` is the user's own: anything that
// spends the owner's money or reveals which model wrote what. A player reading
// last week's recap has no business knowing whether Gemini or Claude wrote it,
// and no way to spend anything.

import { runsThisBot } from '../access/operators.js';

export const LEVELS = ['none', 'player', 'creator', 'owner', 'dev'];

const rank = (level) => LEVELS.indexOf(level);
export const atLeast = (viewer, level) => rank(viewer?.level ?? 'none') >= rank(level);

// What each level may do. Read as a table on purpose — this is the file
// somebody will open to answer "why can't they see that", and a list of ifs
// spread through the server would not answer it.
//
// `campaigns` is the only one that is not a boolean, because it is the only one
// that varies per person rather than per level.
const CAPABILITIES = {
  dev: {
    // The machinery. All of it costs the owner something: an API call, the
    // GPU, disk, or the ability to stop the queue mid-session.
    machinery: true,   // pause switches, transcribe scheduling, import, discard
    approvals: true,   // releasing a summary spends real money
    models: true,      // which summariser, which whisper server, health of both
    servers: true,     // every Discord the bot is in
    metrics: true,     // hours, lines, totals
    manage: true,      // roster, invites, corrections, campaign settings
    transcripts: true, // the verbatim record, not just the write-up
    everything: true,  // scope is not filtered at all
  },
  owner: {
    machinery: false,
    approvals: false,
    models: false,
    servers: true,
    metrics: true,
    manage: true,
    transcripts: true,
    everything: false,
  },
  creator: {
    machinery: false,
    approvals: false,
    models: false,
    servers: false,
    // A campaign creator asked for their campaign, not a dashboard of numbers.
    metrics: false,
    manage: true,
    transcripts: true,
    everything: false,
  },
  player: {
    machinery: false,
    approvals: false,
    models: false,
    servers: false,
    metrics: false,
    manage: false,
    // Notes, not transcripts. A recap is the table's shared account of an
    // evening; a transcript is every word five people said, and being at the
    // table is not the same as being handed that.
    transcripts: false,
    everything: false,
  },
  none: {
    machinery: false, approvals: false, models: false, servers: false,
    metrics: false, manage: false, transcripts: false, everything: false,
  },
};

// Which campaigns this person may see at all, and why.
//
// Union of three claims, each independently checkable:
//   * it is in a Discord they own;
//   * they created it;
//   * they have actually spoken at that table.
//
// The last one is deliberately "has spoken" rather than "is on the roster":
// being added to a roster is something somebody else did, and it is the same
// membership test the user-installed read commands already use.
export function buildViewer({ db, cfg, userId, username = null, guildsOwned = [] }) {
  if (!userId) {
    return {
      level: 'none', derivedLevel: 'none', cap: null, granted: null,
      userId: null, username: null, guildIds: [], campaignIds: [],
      manageableCampaignIds: [], can: CAPABILITIES.none,
    };
  }

  const isDev = runsThisBot(db, cfg, userId);
  const owned = new Set(guildsOwned);

  const managed = db.listCampaigns().filter((c) => c.manager_user_id === userId);
  const played = db.listCampaignsForUser(userId);
  const inOwnedGuild = owned.size ? db.listCampaigns().filter((c) => owned.has(c.guild_id)) : [];

  // What is TRUE of them, before anybody has an opinion about it.
  const derivedLevel =
    isDev ? 'dev'
    : owned.size ? 'owner'
    : managed.length ? 'creator'
    : played.length ? 'player'
    : 'none';

  // And the operator's opinion about it, which now goes both ways.
  //
  // It used to go one way — a ceiling, never a raise — on the grounds that a
  // level somebody could be awarded is a level somebody could be awarded by
  // mistake. That argument is still right about SCOPE and has not been given
  // up: read on.
  //
  // What changed is the recognition that a level and a scope are two different
  // things, and this file already said so ("the level only decides how much
  // machinery is on screen"). Which campaigns somebody may see stays the union
  // of three checkable claims, untouched below. A GRANT ONLY CHANGES HOW MUCH
  // MACHINERY IS ON SCREEN FOR THE CLAIMS THEY ALREADY HAVE — granting
  // `creator` to somebody who runs no campaign gives them a creator's controls
  // over nothing at all, and the way to make them run one is to hand them one.
  // See campaign/handover.js, which is the honest version of that act.
  //
  // A grant is a FLOOR and a cap is a CEILING, applied in that order. Only one
  // is ever set — the store clears the other — so they cannot fight; the order
  // is fixed anyway so that a future pair could only ever narrow, not widen.
  //
  // Neither is applied to the operator themselves. A ceiling on OWNER_USER_ID
  // is reachable in one careless click and unreachable afterwards except over
  // SSH, which is the same trap maySignIn refuses to set in authority.js.
  const cap = isDev ? null : levelOf(db?.capFor, db, userId);
  const granted = isDev ? null : levelOf(db?.grantFor, db, userId);

  // A grant that the world has caught up with is a grant doing nothing. Left
  // in place rather than deleted: the fact that raised them can go away again,
  // and quietly dropping the operator's decision because it was briefly
  // redundant would take it away for good.
  const raised = granted && rank(granted) > rank(derivedLevel) ? granted : derivedLevel;
  const level = cap && rank(cap) < rank(raised) ? cap : raised;

  // A cap is not a blindfold over a level they still hold — it decides which
  // of their claims count at all. Capped to `player`, a server owner sees the
  // tables they actually sat at and not the rest of their own Discord;
  // otherwise "capped" would mean the same rows with fewer buttons.
  const claims = [
    ...(rank(level) >= rank('owner') ? inOwnedGuild : []),
    ...(rank(level) >= rank('creator') ? managed : []),
    ...(rank(level) >= rank('player') ? played : []),
  ];
  const manageable = [
    ...(rank(level) >= rank('owner') ? inOwnedGuild : []),
    ...(rank(level) >= rank('creator') ? managed : []),
  ];

  return {
    level,
    // Both halves are reported, because "owner, held down to player" and
    // "player" are different facts and the gatehouse has to draw them
    // differently — one of them has a ceiling somebody can lift.
    derivedLevel,
    cap: level === derivedLevel ? null : cap,
    // Reported the same way and for the same reason: "creator, because they
    // run one" and "creator, because somebody said so" are different facts,
    // and only one of them is a row the gatehouse can take back.
    //
    // Null once the derived level has caught up, so a spent grant does not
    // draw a caption claiming credit for something that is now simply true —
    // the row itself is kept, see above.
    granted: granted && rank(granted) > rank(derivedLevel) ? granted : null,
    userId,
    username,
    guildIds: rank(level) >= rank('owner') ? [...owned] : [],
    campaignIds: [...new Set(claims.map((c) => c.id))],
    // Which campaigns they may act ON, as opposed to merely read. Playing at a
    // table does not make its roster yours to edit.
    manageableCampaignIds: [...new Set(manageable.map((c) => c.id))],
    can: CAPABILITIES[level],
  };
}

// A level the store has never heard of is not a level. Anything unrecognised
// is ignored rather than guessed at — a typo in either column must not silently
// become "none" and lock somebody out of a dashboard they earned, nor become
// "dev" and hand them one they never had.
//
// One function for both columns, taking the reader: the two are the same shape
// and the same failure, and two copies of this would be two places for the
// LEVELS check to be forgotten.
function levelOf(read, db, userId) {
  const level = read?.call(db, userId) ?? null;
  return level && LEVELS.includes(level) ? level : null;
}

// The one the operator's own console gets: everything, no Discord account
// needed. This is the STATUS_TOKEN path that existed before sign-in did, and
// it stays because locking the operator out of their own Pi over a Discord
// outage would be a worse failure than any it prevents.
export const OPERATOR = {
  level: 'dev',
  derivedLevel: 'dev',
  cap: null,
  granted: null,
  userId: null,
  username: 'operator',
  guildIds: [],
  campaignIds: [],
  manageableCampaignIds: [],
  can: CAPABILITIES.dev,
};

export const maySee = (viewer, campaignId) =>
  Boolean(viewer?.can?.everything) || (viewer?.campaignIds ?? []).includes(campaignId);

export const mayManage = (viewer, campaignId) =>
  Boolean(viewer?.can?.everything) ||
  (Boolean(viewer?.can?.manage) && (viewer?.manageableCampaignIds ?? []).includes(campaignId));

// What each rung actually rests on, and what raising somebody to it does and
// does not buy.
//
// This used to be a list of refusals — the Level column could only go down, so
// each entry named the real-world act that would make the fact true instead. It
// goes both ways now, so these are captions rather than apologies. The point
// they all make is the same one: a grant changes the CONTROLS somebody is
// shown, never the campaigns they can see.
export const HOW_TO_RAISE = {
  dev: "dev is whoever runs this bot — OWNER_USER_ID or OPERATOR_USER_IDS in pi-service/.env, or the house tier in the Tier column beside this one. Not something the Level column hands out, so that there is one way to appoint an operator rather than two.",
  owner: 'owner adds the servers list and the numbers. It does not add a server: which Discords they see is still the ones Discord says they own.',
  creator: "creator adds a campaign's own controls — the roster, the corrections, the transcripts. It does not add a campaign. To make somebody actually run one, hand it to them from that campaign's settings, and they resolve to creator on their own.",
  player: 'player is the floor for somebody who has spoken at a table. Granting it to somebody who never has shows them the same nothing, more politely.',
  none: 'none is what somebody with no claim on this bot already resolves to.',
};

// How a viewer is described to themselves, in the dashboard's own words.
export const LEVEL_WORDS = {
  dev: 'everything on this bot',
  owner: 'your server',
  creator: 'the campaigns you run',
  player: 'the games you play in',
  none: 'nothing yet',
};
