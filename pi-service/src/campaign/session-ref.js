// How a session is referred to in a command: "Cipher_02".
//
// It used to be the meeting's row id — a single integer counting every
// session on every server the bot serves. That had two problems. It reads as
// nonsense (a table's second night was "#16"), and because it names no
// campaign, /export 16 from any server returned another table's full
// transcript. There was nothing in the identifier to check against.
//
// A reference that carries its own campaign fixes both: it matches what the
// vault calls the file, and resolving it can refuse a campaign the caller has
// no business reading.
import { safeFolderName, formatSessionNumber } from '../export/naming.js';

// The same shape as the folder name, minus spaces — a reference is typed and
// autocompleted, so "Curse of Strahd_02" would be tedious and easy to mangle.
export function refSlug(campaignName) {
  return safeFolderName(campaignName || '', '').replace(/\s+/g, '');
}

export function sessionRef(campaignName, sessionNumber) {
  const slug = refSlug(campaignName);
  const number = formatSessionNumber(sessionNumber);
  if (!slug || !number) return null;
  return `${slug}_${number}`;
}

// Splits "Cipher_02" into its parts. Deliberately tolerant of case and of a
// trailing session number typed without its leading zero, since both are what
// people actually type.
export function parseSessionRef(ref) {
  const match = /^(.*)[_-](\d{1,4})$/.exec(String(ref ?? '').trim());
  if (!match) return null;
  const [, slug, number] = match;
  if (!slug) return null;
  return { slug: slug.replace(/\s+/g, '').toLowerCase(), sessionNumber: Number(number) };
}

// Turns a typed reference into a meeting, or explains why it can't.
//
// `reachable` is the campaigns this caller may look at — the membership check
// lives with the caller, not here, so this stays a pure lookup that can be
// tested without a Discord interaction.
export function resolveSessionRef(ref, reachable, db) {
  // A bare number is still accepted, because every message the bot has ever
  // posted about a session quotes one and those are still in people's
  // scrollback. It resolves only within the campaigns the caller can reach.
  const bare = /^#?(\d+)$/.exec(String(ref ?? '').trim());
  if (bare) {
    const meeting = db.getMeeting(Number(bare[1]));
    if (!meeting) return { error: `There's no session #${bare[1]}.` };
    const campaign = reachable.find((c) => c.guild_id === meeting.guild_id);
    if (!campaign) {
      return { error: `Session #${bare[1]} belongs to a campaign you're not part of.` };
    }
    return { meeting, campaign };
  }

  const parsed = parseSessionRef(ref);
  if (!parsed) {
    return {
      error:
        `I don't recognise \`${ref}\` as a session. They look like \`Cipher_02\` — ` +
        'the campaign, then the session number.',
    };
  }

  const campaign = reachable.find(
    (c) => refSlug(c.campaign_name || c.channel_name).toLowerCase() === parsed.slug
  );
  if (!campaign) {
    return { error: `\`${ref}\` isn't a campaign you're part of.` };
  }

  const meeting = db
    .listCompletedMeetings(campaign.guild_id)
    .concat(db.listRecentMeetings(campaign.guild_id, 200))
    .find((m) => m.session_number === parsed.sessionNumber);

  if (!meeting) {
    return { error: `${campaign.campaign_name || campaign.channel_name} has no session ${parsed.sessionNumber}.` };
  }
  return { meeting, campaign };
}
