// Who is looking, and what that entitles them to see.
//
// Four levels, and none of them is a role somebody was granted — every one is
// derived from a fact about Discord that the bot can check for itself. Nobody
// administers this, nobody can be promoted by mistake, and there is no table of
// permissions to drift out of step with reality:
//
//   dev      you are OWNER_USER_ID. It is your hardware, your GPU and your API
//            bill, so you see the machinery.
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
// The rule for what gets stripped below `dev` is the user's own: anything that
// spends the owner's money or reveals which model wrote what. A player reading
// last week's recap has no business knowing whether Gemini or Claude wrote it,
// and no way to spend anything.

import { isOperator } from '../access/operators.js';

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
      level: 'none', derivedLevel: 'none', cap: null,
      userId: null, username: null, guildIds: [], campaignIds: [],
      manageableCampaignIds: [], can: CAPABILITIES.none,
    };
  }

  const isDev = isOperator(cfg, userId);
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

  // And the one opinion the operator is allowed to hold: a ceiling.
  //
  // Only ever downward. Reading it as "set their level" and letting it raise
  // would make every level below dev a thing somebody was awarded, and the
  // whole point of this file is that none of them is. Lowering breaks nothing:
  // it says "show this person less than they have earned", which is an opinion
  // the owner of the hardware is entitled to.
  //
  // Never applied to the operator themselves. A ceiling on OWNER_USER_ID is
  // reachable in one careless click and unreachable afterwards except over
  // SSH, which is the same trap maySignIn refuses to set in authority.js.
  const cap = isDev ? null : capOf(db, userId);
  const level = cap && rank(cap) < rank(derivedLevel) ? cap : derivedLevel;

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

// A cap the store has never heard of is not a cap. Anything unrecognised is
// ignored rather than guessed at — a typo in that column must not silently
// become "none" and lock somebody out of a dashboard they earned.
function capOf(db, userId) {
  const cap = db?.capFor?.(userId) ?? null;
  return cap && LEVELS.includes(cap) ? cap : null;
}

// The one the operator's own console gets: everything, no Discord account
// needed. This is the STATUS_TOKEN path that existed before sign-in did, and
// it stays because locking the operator out of their own Pi over a Discord
// outage would be a worse failure than any it prevents.
export const OPERATOR = {
  level: 'dev',
  derivedLevel: 'dev',
  cap: null,
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

// What each rung actually rests on, for the answer to "make them an owner".
//
// Not one of these is a row this bot could write. That is the design and not a
// missing feature, so the refusal names the real act rather than apologising.
export const HOW_TO_RAISE = {
  dev: "dev is whoever OWNER_USER_ID names in pi-service/.env — one person, because it is one person’s GPU and API bill.",
  owner: 'owner means Discord says they own a server this bot is in. Only Discord can change that.',
  creator: "creator means running a campaign. Hand them one from that campaign’s settings and they will resolve to creator on their own.",
  player: 'player means having spoken at a table while the bot was recording. It is a thing that happened, not a thing to grant.',
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
