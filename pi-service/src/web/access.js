// Who can get into this bot.
//
// The access screen used to describe the security model: whether a token was
// set, that audio stays local, that nginx asks for a password. All true, and
// none of it answers the question somebody actually opens that page to ask,
// which is "who can see my campaigns, and at what level".
//
// So this builds a roster of people rather than a statement of posture. Every
// person the bot knows, the level they resolve to, whether they are signed in
// right now, and -- the part that matters most -- whether the front door is
// even asking for a name yet.

// Through web/authority.js rather than straight at viewer.js: "what would this
// person's level be" is an authority question, and there is one module that
// answers those now.
import { buildViewer, LEVEL_WORDS, LEVELS, HOW_TO_RAISE, admissionOf } from './authority.js';
import { TIERS, tierOf, askLimitFor } from '../access/tiers.js';
import { operatorIds } from '../access/operators.js';

const ORDER = { dev: 0, owner: 1, creator: 2, player: 3, none: 4 };

// Guild ownership comes from Discord, not the database, so it is the one part
// of a person's level that cannot be derived offline.
function guildsByOwner(client) {
  const owns = new Map();
  for (const g of client?.guilds?.cache?.values?.() ?? []) {
    if (!g?.ownerId) continue;
    owns.set(g.ownerId, [...(owns.get(g.ownerId) ?? []), { id: g.id, name: g.name ?? g.id }]);
  }
  return owns;
}

export function accessRoster({ db, cfg, client = null }) {
  const owns = guildsByOwner(client);
  const known = new Map(db.listKnownPeople().map((p) => [p.userId, p]));
  // Keyed by id so a row can carry when they were admitted and why, which is
  // the difference between a guest list and a set of strings.
  const opinions = new Map((db.listAccessRows?.() ?? []).map((r) => [r.userId, r]));
  const envList = String(cfg?.dashboardAllowedUsers ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  // Some people hold access by role and may never have spoken or signed in --
  // a server owner who has only ever watched, or an operator on a fresh
  // install. Leaving them off the page would understate who can get in. Every
  // operator, not just the primary: a second one who has never opened the
  // dashboard still holds the keys to it.
  const blank = (userId) => ({ userId, name: null, sessions: 0, lastSeen: null, lines: 0 });
  for (const id of [...operatorIds(cfg), ...owns.keys(), ...envList, ...opinions.keys()]) {
    if (id && !known.has(id)) known.set(id, blank(id));
  }

  const people = [...known.values()]
    .map((p) => {
      const guilds = owns.get(p.userId) ?? [];
      const viewer = buildViewer({
        db, cfg, userId: p.userId, username: p.name,
        guildsOwned: guilds.map((g) => g.id),
      });
      const admission = admissionOf(cfg, p.userId, db);
      const said = opinions.get(p.userId) ?? null;
      return {
        userId: p.userId,
        // What is true of them, and what the operator has said about it. Both,
        // because "owner, held at player" and "player" want different rows:
        // one of them has a ceiling somebody can lift.
        derivedLevel: viewer.derivedLevel,
        cap: viewer.cap,
        // What they may spend, what that currently buys, and what they have
        // spent of it today. All three, because a tier on its own is a number
        // with no units and tells the operator nothing they can act on.
        tier: tierOf(db, cfg, p.userId),
        askLimit: askLimitFor(cfg, tierOf(db, cfg, p.userId)),
        asksToday: db.countAsksToday?.(p.userId) ?? 0,
        // A name we already hold beats a Discord lookup, and the cache beats a
        // fetch. Nobody should be nameless just because they never spoke.
        name: p.name ?? client?.users?.cache?.get?.(p.userId)?.username ?? null,
        level: viewer.level,
        sees: LEVEL_WORDS[viewer.level],
        campaigns: viewer.campaignIds.length,
        manages: viewer.manageableCampaignIds?.length ?? 0,
        guilds: guilds.map((g) => g.name),
        signedIn: p.sessions > 0,
        sessions: p.sessions,
        lastSeen: p.lastSeen,
        lines: p.lines,
        // Whether the front door opens for them, and which of the three lists
        // said so. The gatehouse needs the reason as well as the answer: only
        // one of them is a row it can delete.
        admission,
        invited: admission !== null && admission !== 'open',
        admittedAt: said?.setAt ?? null,
        note: said?.note ?? null,
      };
    })
    // Somebody with no level and no history is not a person with access; they
    // are a row in a table. Keep them only if they have actually been seen --
    // or if somebody deliberately put them on the list, which is the one case
    // where a person with no history at all is the most important row here.
    .filter(
      (p) =>
        p.level !== 'none' || p.lines > 0 || p.signedIn ||
        p.admission === 'list' || p.admission === 'env' || p.cap
    )
    .sort(
      (a, b) =>
        ORDER[a.level] - ORDER[b.level] ||
        Number(b.signedIn) - Number(a.signedIn) ||
        String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) ||
        String(a.name ?? a.userId).localeCompare(String(b.name ?? b.userId))
    );

  const byLevel = {};
  for (const p of people) byLevel[p.level] = (byLevel[p.level] ?? 0) + 1;

  return {
    // The headline fact. With login off, the roster below describes who WOULD
    // resolve to what -- but anyone who reaches the page is the operator
    // regardless, so saying otherwise would be a comforting lie.
    requireLogin: cfg?.dashboardRequireLogin === true,
    actionsEnabled: Boolean(cfg?.statusToken),
    // Whether a guest list is in force at all. With none, everybody who can
    // reach the sign-in button may hold a session -- the state a fresh install
    // is in, and fine right up until the dashboard gets a hostname.
    //
    // Asked of the two lists rather than derived from the rows above: the
    // operator's own admission reads 'owner' whether or not a list exists, so
    // "somebody is not open" would be true on every install ever made.
    listInUse: envList.length > 0 || [...opinions.values()].some((r) => r.invited),
    // Who runs this install. The page says it out loud, because "there are two
    // of you" belongs on the screen that decides who gets in.
    operators: operatorIds(cfg),
    // What the environment's half holds, including ids nobody has ever seen.
    // Shown so a name admitted in .env and never used is not simply missing.
    envList,
    // The vocabulary the page needs, sent rather than restated: the order of
    // the levels, and why each one cannot simply be handed out. A dropdown
    // that disagrees with the action behind it is worse than no dropdown.
    levels: LEVELS,
    howToRaise: HOW_TO_RAISE,
    tiers: TIERS,
    // Whether the tiers are worth different amounts yet. Unset, they are all
    // the same number and the page says so rather than drawing four buttons
    // that quietly do nothing.
    tiersDiffer: Object.keys(cfg?.tierAskLimits ?? {}).length > 0,
    // Only the rows this page can actually delete. The environment's half of
    // the list is shown alongside and marked as somebody else's to change.
    onList: people.filter((p) => p.admission === 'list').length,
    people,
    total: people.length,
    signedIn: people.filter((p) => p.signedIn).length,
    byLevel,
  };
}
