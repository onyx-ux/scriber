// Asking someone whether they may be recorded, and holding them to the
// answer.
//
// The bot captures people's voices. Until now the only gate on that was the
// roster, which the DM controls — so being added to a table was, in effect,
// somebody else agreeing on your behalf. This asks you.
//
// Three rules the rest of the code depends on:
//
//   * silence is not agreement. Pending, expired, declined and "never asked"
//     all mean do not record;
//   * the answer is per campaign. Agreeing to be recorded at one table is not
//     agreeing at every table you are ever invited to;
//   * the disclaimer is generated from the running configuration, never
//     hardcoded. A promise about how long audio is kept has to be a
//     description of what the bot actually does, or it is just a lie with a
//     nicer font.
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';

export const CONSENT_PREFIX = 'consent:';
export const INVITE_HOURS = 24;

export function inviteExpiry(now = new Date(), hours = INVITE_HOURS) {
  return new Date(now.getTime() + hours * 3600 * 1000);
}

// Discord renders <t:unix:f> in the reader's own timezone, which matters when
// the table is spread across several.
export function discordTime(date, style = 'f') {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

export function buildConsentButtons(campaignId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONSENT_PREFIX}yes:${campaignId}`)
      .setLabel('I agree — record me')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CONSENT_PREFIX}no:${campaignId}`)
      .setLabel('No — do not record me')
      .setStyle(ButtonStyle.Secondary)
  );
}

export function parseConsentButton(customId) {
  const match = /^consent:(yes|no):(\d+)$/.exec(String(customId ?? ''));
  if (!match) return null;
  return { granted: match[1] === 'yes', campaignId: Number(match[2]) };
}

// What the invited person is actually told.
//
// Deliberately short. A wall of text is not informed consent — it is a wall of
// text people click past. Four things they need: who is asking, what gets
// captured and when, how long it is kept, and where it goes.
//
// "and nothing else leaves your network" is load-bearing and true: the audio
// is transcribed on the DM's own hardware, and only the finished text is sent
// on to be summarised.
export function buildInviteMessage({ campaignName, inviterName, retentionDays, expiresAt }) {
  const kept =
    retentionDays > 0
      ? `Recordings are deleted after **${retentionDays} day${retentionDays === 1 ? '' : 's'}** — long enough to transcribe them and fix mistakes.`
      : 'Recordings are kept until the person running the bot deletes them.';

  return {
    content:
      `🪶 **${inviterName}** has invited you to **${campaignName}**.\n\n` +
      'Quill writes up your D&D sessions. If you accept, **your voice is recorded whenever Quill is in the voice channel** ' +
      "— it only listens while it's there, and it never speaks.\n\n" +
      '**What happens to it**\n' +
      `• Your audio is turned into text through a transcription Model.\n` +
      '• That text — not your audio — is then sent to an AI service to write the session summary.\n' +
      `• ${kept}\n` +
      '• Your recording is never sent anywhere else.\n\n' +
      "**You don't have to.** Decline and Quill will not record you at all: it skips your audio entirely rather than " +
      'recording and discarding it. You can still play — you just will not be in the transcript.\n\n' +
      `This invite expires ${discordTime(expiresAt)}.`,
    components: [buildConsentButtons(undefined)],
  };
}

// The full message including the buttons bound to this campaign.
export function buildInviteDm({ campaignId, campaignName, inviterName, retentionDays, expiresAt }) {
  const { content } = buildInviteMessage({ campaignName, inviterName, retentionDays, expiresAt });
  return { content, components: [buildConsentButtons(campaignId)] };
}

export function acceptedMessage(campaignName) {
  return (
    `✅ Thanks — you're on the roster for **${campaignName}** and Quill will include you in the transcripts.\n` +
    'Changed your mind? Tell whoever runs the game and they can take you back off.'
  );
}

export function declinedMessage(campaignName) {
  return (
    `🔇 Understood — Quill will **not** record you in **${campaignName}**.\n` +
    'Your audio is skipped entirely, so nothing of yours is captured or stored. You can still play; you just will not ' +
    'appear in the transcript or the notes.'
  );
}

export function expiredMessage(campaignName) {
  return `⌛ That invitation to **${campaignName}** has expired. Ask whoever runs the game to send a new one.`;
}

// Who in the voice channel the bot is about to ignore, so the DM finds out
// before the session rather than when the transcript comes back short.
export function describeUnrecorded(names) {
  if (names.length === 0) return '';
  const who = names.map((n) => `**${n}**`).join(', ');
  return (
    `\n\n🔇 Not being recorded: ${who} — ` +
    (names.length === 1 ? 'they have' : 'they have') +
    " not agreed to be recorded in this campaign. `/campaign invite` asks them."
  );
}
