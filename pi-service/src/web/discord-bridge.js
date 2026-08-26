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
