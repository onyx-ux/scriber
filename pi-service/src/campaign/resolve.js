// Which campaign a command is about.
//
// This used to be `interaction.guildId` — the campaign WAS the server. Two
// things broke that. A user-installed app runs in channels that have no
// campaign at all, and a server can now hold more than one table. So every
// command has to answer "which campaign", and the answer depends on what the
// command does:
//
//   READ    — campaigns you play in, or any campaign in the server you are
//             standing in. Being in the server is the permission it always was.
//   MEMBER  — campaigns you are on the roster for, here. /join records
//             people's voices, so the bot's own roster decides, not Discord's
//             member list.
//   MANAGE  — campaigns you run. Reshaping a campaign's records belongs to
//             whoever runs the game.
//
// Each tier is a different candidate list through the same three-way answer:
// none (refuse and say how to fix it), exactly one (use it), several (ask).
// Asking is the important case — silently picking one of a player's two
// campaigns would file a session under the wrong game, and that is only
// noticed weeks later when the notes are wrong.
import { refSlug } from './session-ref.js';
import { campaignFolder } from '../export/naming.js';

export function campaignLabel(campaign) {
  return campaign?.name || campaign?.channel_name || 'unnamed campaign';
}

// Whether a name can be used at all, before asking whether it is taken.
//
// A campaign's name has to survive two transformations: into a vault folder,
// and into the session reference people type. "🎲" survives neither —
// safeFolderName strips emoji and falls back to a generic "Campaign", and
// refSlug is left with nothing. Allowed through, that campaign could never
// refer to its own sessions (`/summarise`, `/export` and `/transcribe` all
// take a reference) and its notes would land in a folder that every other
// vanishing name also claims.
//
// Discord names are full of emoji, so this is not hypothetical: the channel
// this bot was built against is called "🎲Session".
export function nameIsUsable(name) {
  return refSlug(name).length > 0;
}

// Whether a name is already taken, and by whom.
//
// A campaign's name is not just a label: it is the vault folder its notes are
// filed in and the prefix of every session reference. Two campaigns that
// resolve to the same folder interleave their session notes AND their ledgers,
// so the next recap re-introduces the other game's NPCs; two that share a slug
// make `Cipher_02` ambiguous.
//
// Checked across ALL campaigns, not just one server's — the vault has one
// folder per name with no guild anywhere in the path, so colliding with
// another server's campaign is exactly as destructive as colliding here.
export function campaignNameClash(db, name, exceptId = null) {
  const folder = campaignFolder({ channel_name: name }, name);
  const slug = refSlug(name).toLowerCase();

  return (
    // Through the archive on purpose. An archived campaign still owns its
    // notes folder on disk, so letting a new campaign take the same name
    // would interleave the two the moment anything is written -- and worse,
    // would do it to a campaign nobody can currently see to notice.
    db.listCampaignsIncludingArchived().find((c) => {
      if (c.id === exceptId || !c.name) return false;
      return campaignFolder({ channel_name: c.name }, c.name) === folder || refSlug(c.name).toLowerCase() === slug;
    }) ?? null
  );
}

// Autocomplete sends the id, but people type names too — into the option box
// before the list loads, or from a message they were told to copy. Matching
// the slug as well means "Cipher", "cipher" and "Cipher_02"'s prefix all land.
function matches(campaign, asked) {
  const wanted = String(asked).trim().toLowerCase();
  if (!wanted) return false;
  if (String(campaign.id) === wanted) return true;
  if ((campaign.name || '').toLowerCase() === wanted) return true;
  return Boolean(campaign.name) && refSlug(campaign.name).toLowerCase() === wanted.replace(/\s+/g, '');
}

export function findCampaign(candidates, asked) {
  return candidates.find((c) => matches(c, asked)) ?? null;
}

export function listFor(candidates) {
  return candidates.map((c) => `• **${campaignLabel(c)}**`).join('\n');
}

function byId(campaigns) {
  const seen = new Map();
  for (const c of campaigns) if (c && !seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

// The shared three-way answer. `messages.many` is a lead-in; the campaign list
// is appended, because "pick one" without saying which ones is useless.
export function pickCampaign(candidates, asked, messages) {
  if (candidates.length === 0) return { error: messages.none };

  if (asked) {
    const match = findCampaign(candidates, asked);
    return match ? { campaign: match } : { error: messages.unknown };
  }

  if (candidates.length === 1) return { campaign: candidates[0] };
  return { error: `${messages.many}\n\n${listFor(candidates)}` };
}

export const NOT_A_MEMBER =
  "I don't have you recorded in any campaign yet, so there's nothing for me to show you. " +
  'Once you have spoken in a session the bot recorded, these commands will work anywhere.';

// READ tier. Used by the user-installable commands, so it is a privacy
// boundary as much as a lookup: anyone can add a user-installed app to their
// own account, and without the membership half a stranger could read another
// table's transcripts just by naming their campaign.
export function resolveReadableCampaign(interaction, db) {
  const asked = interaction.options?.getString?.('campaign') || null;
  const here = interaction.guildId ? db.listCampaignsInGuild(interaction.guildId) : [];
  const mine = db.listCampaignsForUser(interaction.user.id);
  const mineIds = new Set(mine.map((c) => c.id));

  const reachable = byId([...here, ...mine]);
  if (reachable.length === 0) return { error: NOT_A_MEMBER };

  // Flagged so a reply can say WHICH campaign answered — a /recap run three
  // servers away from the game silently returning one table's notes is
  // confusing without it.
  const found = (c) => ({ campaign: c, elsewhere: c.guild_id !== interaction.guildId });

  if (asked) {
    const match = findCampaign(reachable, asked);
    return match
      ? found(match)
      : { error: "That isn't a campaign you've played in, so I can't show you its records." };
  }

  // Narrow before asking, in two steps. A player standing in a server with two
  // tables should get THEIR table without being interrogated about it, and
  // someone who plays in three campaigns elsewhere should still get this
  // server's when they run a command here.
  const played = reachable.filter((c) => mineIds.has(c.id));
  const preferred = played.length ? played : reachable;
  if (preferred.length === 1) return found(preferred[0]);

  const inGuild = preferred.filter((c) => c.guild_id === interaction.guildId);
  if (inGuild.length === 1) return found(inGuild[0]);

  const choices = inGuild.length > 1 ? inGuild : preferred;
  return {
    error: `You're in more than one campaign, so I don't know which you mean. Re-run with the \`campaign\` option:\n\n${listFor(choices)}`,
  };
}

// MEMBER tier — /join, /setcharacter, /whoami. Always scoped to the server the
// command was run in: these act on a table that is playing right now, and the
// bot has to be in that server for any of them to mean anything.
export function resolveMemberCampaign(interaction, db) {
  const asked = interaction.options?.getString?.('campaign') || null;
  if (!interaction.guildId) {
    return { error: 'Run this in the server the campaign is played in — a DM has no table to attach it to.' };
  }

  const mine = db.listCampaignsForMember(interaction.user.id).filter((c) => c.guild_id === interaction.guildId);

  return pickCampaign(mine, asked, {
    none:
      "🎲 You're not on the roster for a campaign in this server, so I can't do that for you.\n" +
      'Whoever runs the game adds you with `/dm add` — or claims a campaign with `/campaign create` if nobody has yet.',
    unknown: "That isn't a campaign you're on the roster for here.",
    many: "You're at more than one table in this server, so I don't know which this is. Re-run with the `campaign` option:",
  });
}

// MANAGE tier. The owner reaches every campaign — there has to be someone who
// can unstick one whose manager has left the server.
export function resolveManagedCampaign(interaction, db, cfg) {
  const asked = interaction.options?.getString?.('campaign') || null;
  const owner = Boolean(cfg?.ownerUserId) && interaction.user.id === cfg.ownerUserId;

  const all = interaction.guildId ? db.listCampaignsInGuild(interaction.guildId) : db.listCampaigns();
  const mine = owner ? all : all.filter((c) => c.manager_user_id === interaction.user.id);

  // Naming a campaign you don't run should say who does, rather than pretend
  // it doesn't exist — you are in their server and can see the game happening.
  // Checked before the pick, so it answers whether you run one campaign here,
  // several, or none.
  if (asked && !findCampaign(mine, asked)) {
    const theirs = findCampaign(all, asked);
    if (theirs?.manager_user_id) {
      return {
        error: `🔒 <@${theirs.manager_user_id}> runs **${campaignLabel(theirs)}**, so only they can change its records.`,
      };
    }
  }

  return pickCampaign(mine, asked, {
    none: all.length
      ? "🔒 You don't run a campaign here. Whoever does can set the roster and corrections; if nobody has claimed it yet, `/campaign create` claims one."
      : "There's no campaign here yet — `/campaign create name:...` starts one and makes you its DM.",
    unknown: "That isn't a campaign you run.",
    many: "You run more than one campaign here, so I don't know which you mean. Re-run with the `campaign` option:",
  });
}
