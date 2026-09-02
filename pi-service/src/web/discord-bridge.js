// The few things a dashboard action needs Discord itself for.
//
// Everything else the dashboard does is a database write: approving a summary,
// saving a correction, pausing a queue. Inviting somebody is different — it is
// a message to a person, and the person is the point. It cannot be faked with a
// row.
//
// It used to be four functions wide. The other two — finding an account by the
// name somebody typed on the sign-in page, and DMing them six digits — went
// when signing in became Discord's own job rather than this bot's imitation of
// it. See web/discord-oauth.js.
//
// So this is the whole surface, and it stays short on purpose. It is passed
// into runAction as part of `ctx` rather than imported by it, for the same
// reason the rest of that context is: the list of what an action can reach
// stays short and visible, and the action layer stays testable without a
// logged-in bot.
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { buildInviteDm, inviteExpiry } from '../campaign/consent.js';

// Discord's member search is the one member lookup a bot can do without the
// privileged GUILD_MEMBERS intent. It matches on username and server nickname,
// which is exactly how somebody would type a name they know from the channel.
const MAX_MATCHES = 8;

// Where a write-up could be posted. Text and announcement channels, and
// nothing else.
//
// Voice channels carry a text chat now and the bot could technically post into
// one, but the voice channel is where the table PLAYS — a recap dropped into it
// lands in the middle of next week's session. Forums and categories cannot take
// a plain message at all. Threads are left out for a different reason: a thread
// is archived by Discord after a few days of quiet, and a destination that
// stops existing on its own is not a destination.
const POSTABLE_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

// Both halves are needed and neither implies the other: a channel the bot can
// see but not speak in reads as a perfectly good choice right up until the
// first write-up is silently dropped.
const MAY_POST = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

// How long "yes, they are in that server" is believed before asking again.
//
// This exists because of where the answer is needed. The server picker on the
// dashboard is built from /status, and /status is polled every five seconds by
// every open tab — so an uncached membership check would be one REST call per
// server per tab per five seconds, forever, to answer a question whose answer
// changes about once a year.
//
// Five minutes is picked from what being wrong costs in each direction. Stale
// yes: somebody who just left a Discord can still start a campaign in it for a
// few minutes, and createCampaign's own rules still apply. Stale no: somebody
// who just joined waits a few minutes before that server appears in the
// picker, which is annoying rather than harmful. Neither is worth a call every
// five seconds.
const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;

export function createDiscordBridge({ client, db, cfg }) {
  // key: `${guildId}:${userId}` -> { at, member }
  const membership = new Map();

  return {
    // Is this account actually in that Discord?
    //
    // The dashboard needs this because creating a campaign is now allowed to
    // anyone in the server, which is what /campaign create has always allowed
    // — being able to type it in a channel IS being in the server. The web
    // page has no such proof, so it has to ask.
    //
    // A single member fetched by id, which is a plain REST read and needs no
    // privileged intent. `guild.members.cache` is deliberately not trusted as
    // a negative: without GUILD_MEMBERS this bot never receives the member
    // list, so a cache miss means "not asked yet", not "not a member". It is
    // trusted as a positive, because a member in the cache got there by being
    // seen.
    //
    // A failed lookup is cached as false like any other no. Discord being
    // briefly unreachable should not turn into a retry per poll.
    // `fresh` skips the cache, and the two callers split on it deliberately.
    // The server picker on /status is polled and takes the cached answer; the
    // create action itself is one click and asks Discord outright, so the
    // check that actually decides is never a five-minute-old memory. It also
    // means somebody refused because they had not joined yet can join and
    // press the button again, rather than being told no until a timer expires.
    async isMemberOf(guildId, userId, { fresh = false } = {}) {
      if (!guildId || !userId) return false;

      const key = `${guildId}:${userId}`;
      const seen = membership.get(key);
      if (!fresh && seen && Date.now() - seen.at < MEMBERSHIP_TTL_MS) return seen.member;

      const guild = client?.guilds?.cache?.get(guildId);
      if (!guild) {
        // Not a server this bot is in at all. Nothing to be a member of, and
        // no call worth making.
        membership.set(key, { at: Date.now(), member: false });
        return false;
      }

      let member = !fresh && (guild.members?.cache?.has?.(userId) ?? false);
      if (!member) {
        member = Boolean(await guild.members?.fetch?.(userId).catch(() => null));
      }
      membership.set(key, { at: Date.now(), member });
      return member;
    },

    // Who in this campaign's server matches what was typed.
    //
    // Returns people, not accounts: a Discord id on its own is unusable in a
    // roster screen, and the whole reason this exists is that the operator
    // knows their table by name and not by snowflake.
    async findPeople({ guildId, query }) {
      const guild = await client?.guilds?.fetch?.(guildId).catch(() => null);
      if (!guild) return { ok: false, message: '⚠️ I am not in that server any more.' };

      const term = String(query ?? '').trim();
      if (term.length < 2) return { ok: false, message: 'Type at least two characters.' };

      // A pasted user id resolves directly. It is the escape hatch for a name
      // the search cannot match — a nickname changed since, or somebody who
      // has never spoken in a channel the bot can see.
      if (/^\d{15,25}$/.test(term)) {
        const member = await guild.members.fetch(term).catch(() => null);
        if (!member) return { ok: true, people: [] };
        return { ok: true, people: [describe(member)] };
      }

      let found;
      try {
        found = await guild.members.search({ query: term, limit: MAX_MATCHES });
      } catch (err) {
        // The endpoint is available without the privileged intent on every
        // install seen so far, but if that ever changes the operator should be
        // told what to do rather than shown an empty list that looks like
        // "nobody by that name".
        console.warn(`[invite] member search failed in ${guildId}: ${err.message}`);
        return {
          ok: false,
          message:
            'Discord would not let me search this server for members. Paste the person’s user id instead — ' +
            'right-click them in Discord and choose Copy User ID.',
        };
      }

      return { ok: true, people: [...found.values()].filter((m) => !m.user.bot).map(describe) };
    },

    // Which channels in this server the bot could actually post a write-up in.
    //
    // The dashboard's destination switch had "A chosen channel" disabled from
    // the day it was drawn, on the honest grounds that only Discord knows the
    // answer and the page had never been given it. This is the page being given
    // it. Nothing here is typed: a channel id is eighteen digits with no check
    // digit, so a box to paste one into is a box to mistype one into, and the
    // mistake surfaces weeks later as a recap that went nowhere.
    //
    // Read from the cache rather than fetched. The Guilds intent fills
    // `channels.cache` at startup and the gateway keeps it current, so the
    // cache IS the live answer — a REST round trip on every campaign open would
    // buy nothing but latency. The fetch is kept as a fallback for the one case
    // the cache cannot cover: a guild the bot has only just joined.
    //
    // Answering `ok: false` rather than an empty list matters. "I could not ask
    // Discord" and "you have no channels I may post in" are different facts,
    // and only one of them is worth changing a permission over.
    async listChannels({ guildId }) {
      const guild = await client?.guilds?.fetch?.(guildId).catch(() => null);
      if (!guild) return { ok: false, message: '⚠️ I am not in that server any more.' };

      // Every permission below is asked ABOUT this member. Without it there is
      // no question to ask, and guessing yes would offer channels the first
      // write-up then fails to reach.
      const me = guild.members?.me ?? (await guild.members?.fetchMe?.().catch(() => null));
      if (!me) return { ok: false, message: '⚠️ I could not work out my own permissions in that server.' };

      let all = guild.channels?.cache;
      if (!all?.size) all = await guild.channels?.fetch?.().catch(() => null);
      if (!all) return { ok: false, message: '⚠️ Discord would not list that server’s channels.' };

      const channels = [...all.values()]
        .filter((c) => c && POSTABLE_TYPES.has(c.type))
        .filter((c) => {
          const perms = c.permissionsFor?.(me);
          return Boolean(perms && MAY_POST.every((flag) => perms.has(flag)));
        })
        // Sorted the way Discord itself draws the sidebar — uncategorised
        // channels first, then each category in its own order — so the person
        // choosing is reading the list they already know rather than a
        // re-sorted one they have to search.
        .sort((a, b) =>
          (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) ||
          (a.rawPosition ?? 0) - (b.rawPosition ?? 0) ||
          String(a.name).localeCompare(String(b.name)))
        .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }));

      return { ok: true, channels };
    },

    // Ask somebody whether they may be recorded.
    //
    // The DM is sent BEFORE the invite is recorded, exactly as /campaign invite
    // does it: a DM can be refused outright by the recipient's privacy
    // settings, and a pending invite nobody can see is worse than none — it
    // sits in the roster looking like the question has been asked.
    // Does this id belong to anybody, and what are they called.
    //
    // The gatehouse asks before writing a row. A Discord id is eighteen digits
    // with no check digit, so a typo is a perfectly well-formed id belonging
    // to nobody -- and an admitted account that does not exist is a line on a
    // guest list that can never be explained later.
    async lookUp({ userId }) {
      const user = await client?.users?.fetch?.(userId).catch(() => null);
      if (!user) return { ok: false, message: 'Discord does not know that account.' };
      if (user.bot) return { ok: false, message: 'That is a bot account.' };
      return { ok: true, userId: user.id, username: user.username ?? null };
    },

    async invite({ campaignId, userId, characterName, inviterName }) {
      const campaign = db.getCampaign(campaignId);
      if (!campaign) return { ok: false, message: '⚠️ No such campaign.' };

      const user = await client?.users?.fetch?.(userId).catch(() => null);
      if (!user) return { ok: false, message: '⚠️ Discord does not know that account.' };
      if (user.bot) {
        return { ok: false, message: "Bots don't play D&D, and can't consent to anything." };
      }

      const existing = db.getConsent(campaignId, userId);
      if (existing?.state === 'granted') {
        return { ok: false, message: `**${user.username}** has already agreed to be recorded here.` };
      }

      const expiresAt = inviteExpiry();
      const dm = buildInviteDm({
        campaignId,
        campaignName: campaign.name || campaign.channel_name || 'this campaign',
        inviterName,
        retentionDays: cfg.audioRetentionDays,
        expiresAt,
      });

      const channel = await user.createDM().catch(() => null);
      const sent = channel ? await channel.send(dm).catch(() => null) : null;
      if (!sent) {
        return {
          ok: false,
          message:
            `📪 I couldn't DM **${user.username}** — their privacy settings block messages from this server, ` +
            'so I cannot ask them. They can turn DMs on for this server and you can invite them again.',
        };
      }

      db.inviteToCampaign(campaignId, userId, inviterName ?? 'dashboard', expiresAt.toISOString());
      // A character name given now is held until they accept — naming somebody
      // does not put them at the table, answering does.
      if (characterName) db.setCharacterName(campaignId, userId, characterName);

      return {
        ok: true,
        userId,
        username: user.username,
        expiresAt: expiresAt.toISOString(),
        message:
          `📨 Asked **${user.username}** whether Quill may record them` +
          `${characterName ? `, as **${characterName}**` : ''}. Nothing of theirs is captured until they say yes.`,
      };
    },
  };
}

// What the dashboard needs to show a row: who they are, what the table calls
// them, and their avatar. No email, no roles, no join date — a roster screen
// needs a face and a name.
function describe(member) {
  return {
    userId: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.displayName || member.user.username,
    avatar: member.user.displayAvatarURL?.({ size: 64, extension: 'png' }) ?? null,
  };
}
