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
import { buildViewer, LEVEL_WORDS } from './authority.js';

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

  // Some people hold access by role and may never have spoken or signed in --
  // a server owner who has only ever watched, or the operator on a fresh
  // install. Leaving them off the page would understate who can get in.
  const blank = (userId) => ({ userId, name: null, sessions: 0, lastSeen: null, lines: 0 });
  for (const id of [cfg?.ownerUserId, ...owns.keys()]) {
    if (id && !known.has(id)) known.set(id, blank(id));
  }

  const people = [...known.values()]
    .map((p) => {
      const guilds = owns.get(p.userId) ?? [];
      const viewer = buildViewer({
        db, cfg, userId: p.userId, username: p.name,
        guildsOwned: guilds.map((g) => g.id),
      });
      return {
        userId: p.userId,
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
      };
    })
    // Somebody with no level and no history is not a person with access; they
    // are a row in a table. Keep them only if they have actually been seen.
    .filter((p) => p.level !== 'none' || p.lines > 0 || p.signedIn)
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
    people,
    total: people.length,
    signedIn: people.filter((p) => p.signedIn).length,
    byLevel,
  };
}
