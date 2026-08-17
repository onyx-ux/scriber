// The few things a dashboard action needs Discord itself for.
//
// Everything else the dashboard does is a database write: approving a summary,
// saving a correction, pausing a queue. Inviting somebody is different — it is
// a message to a person, and the person is the point. It cannot be faked with a
// row.
//
// So this is the whole surface, deliberately two functions wide. It is passed
// into runAction as part of `ctx` rather than imported by it, for the same
// reason the rest of that context is: the list of what an action can reach
// stays short and visible, and the action layer stays testable without a
// logged-in bot.
import { buildInviteDm, inviteExpiry } from '../campaign/consent.js';

// Discord's member search is the one member lookup a bot can do without the
// privileged GUILD_MEMBERS intent. It matches on username and server nickname,
// which is exactly how somebody would type a name they know from the channel.
const MAX_MATCHES = 8;

export function createDiscordBridge({ client, db, cfg }) {
  return {
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

    // Ask somebody whether they may be recorded.
    //
    // The DM is sent BEFORE the invite is recorded, exactly as /campaign invite
    // does it: a DM can be refused outright by the recipient's privacy
    // settings, and a pending invite nobody can see is worse than none — it
    // sits in the roster looking like the question has been asked.
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

    // Find the one account a sign-in name refers to. See findAcrossGuilds.
    findKnownMember: ({ query }) => findAcrossGuilds(client, query),

    // Deliver a sign-in code.
    //
    // The DM says what it is for and that nobody asked them for a password,
    // because an unexpected six-digit code is exactly the shape of a phishing
    // message and the honest version has to look different from one.
    async sendCode({ userId, code, username }) {
      const user = await client?.users?.fetch?.(userId).catch(() => null);
      if (!user) return { ok: false };

      const channel = await user.createDM().catch(() => null);
      const sent = channel
        ? await channel
            .send(
              `🪶 **${code}** is your code for the Quill dashboard.\n\n` +
                'It lasts ten minutes and works once. Type it on the sign-in page along with the name ' +
                `**${username}**.\n\n` +
                '_If you did not just try to sign in, ignore this — nothing has happened to your account, and ' +
                'Quill will never ask you for a password._'
            )
            .catch(() => null)
        : null;

      return { ok: Boolean(sent) };
    },
  };
}

// --- signing in ---

// One person, found across every server the bot is in.
//
// Used only by the sign-in flow, and scoped hard on purpose: a name that
// matches nobody the bot shares a server with resolves to nothing, so this
// cannot become a way to make the bot DM a stranger. An exact username match
// wins over a nickname, and an ambiguous match resolves to nothing rather than
// guessing — sending somebody else's sign-in code to the wrong account is the
// one outcome worth refusing over.
async function findAcrossGuilds(client, query) {
  const term = String(query ?? '').trim().toLowerCase();
  if (term.length < 2) return null;

  const hits = new Map();
  for (const guild of client?.guilds?.cache?.values?.() ?? []) {
    let found;
    try {
      found = await guild.members.search({ query: term, limit: 8 });
    } catch {
      continue;
    }
    for (const member of found.values()) {
      if (member.user.bot) continue;
      hits.set(member.id, { userId: member.id, username: member.user.username, nick: member.displayName });
    }
  }

  const people = [...hits.values()];
  const exact = people.filter((p) => p.username.toLowerCase() === term);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const byNick = people.filter((p) => (p.nick ?? '').toLowerCase() === term);
  if (byNick.length === 1) return byNick[0];

  return people.length === 1 ? people[0] : null;
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
