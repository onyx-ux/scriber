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
      // Said here, at the moment of agreeing, because it is the part somebody
      // would most reasonably feel misled about later. "You can change your
      // mind" is true and is not the whole truth: the switch is forward-only,
      // and a session you were recorded in stays recorded.
      '**You can change your mind any time** with `/campaign consent`, without asking anyone. That stops future ' +
      'recording — sessions already written up stay as they are, because they are the whole table’s record of an ' +
      'evening everyone played.\n\n' +
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
    'Changed your mind? `/campaign consent` turns it back off from that moment on, any time, without asking anyone.'
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

// ---------------------------------------------------------------------------
// Taking it back
//
// The operations are in campaign/withdrawal.js; this is only what the person
// reads. Every screen here is written for someone who is, at that moment,
// slightly uncomfortable — so it states facts and never argues. There is no
// "are you sure?" that implies they should not be, and no attempt to talk
// anyone out of anything.
// ---------------------------------------------------------------------------

export const WITHDRAW_PREFIX = 'withdraw:';

// Kept separate from parseConsentButton and its ids: those are live in DMs
// people received months ago, and a parser that got cleverer about one would
// have to stay right about the other forever.
export function parseWithdrawButton(customId) {
  const match = /^withdraw:(stop|resume):(\d+)$/.exec(String(customId ?? ''));
  return match ? { action: match[1], campaignId: Number(match[2]) } : null;
}

const button = (action, campaignId, label, style) =>
  new ButtonBuilder().setCustomId(`${WITHDRAW_PREFIX}${action}:${campaignId}`).setLabel(label).setStyle(style);

// Where you stand, and the one switch you control.
//
// The switch is forward-looking, and the message says so in the same breath as
// offering it. Somebody pressing "stop" who believes it also unwrites eleven
// sessions has not been told the truth by the interface, and would find out at
// the worst possible moment — reading a recap that still has them in it.
export function buildStandingMessage(standing, campaignName) {
  const { state, lines, sessions, characterName, displayName, decidedAt, retentionDays, hasRecord } = standing;

  const headline =
    state === 'granted' ? 'You are being recorded, and you said yes.'
    : state === 'declined' ? 'You are not being recorded.'
    : state === 'pending' ? 'You were asked, and have not answered.'
    : state === 'expired' ? 'You were asked, and the invitation ran out.'
    : 'Nobody has asked you yet.';

  const onFile = hasRecord
    ? `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} across ${sessions} transcript${sessions === 1 ? '' : 's'}`
    : 'nothing';

  const facts = [
    `**On file** — ${onFile}`,
    `**As** — ${characterName || displayName || 'your Discord name'}`,
    `**Audio** — ${
      retentionDays > 0
        ? `deleted after ${retentionDays} day${retentionDays === 1 ? '' : 's'}, once it has been transcribed`
        : 'kept until the person running the bot deletes it'
    }`,
  ];

  const granted = state === 'granted';
  const control = granted
    ? button('stop', standing.campaignId, 'Stop recording me from now on', ButtonStyle.Secondary)
    : button('resume', standing.campaignId, 'Record me from now on', ButtonStyle.Success);

  // Said before the button is pressed rather than after. The sessions on file
  // are a record several people agreed to and still want; this switch does not
  // reach into them, and pretending otherwise would be the one thing that could
  // make a consent screen dishonest.
  const scope = hasRecord
    ? `\nThe ${sessions} session${sessions === 1 ? '' : 's'} above ${sessions === 1 ? 'stays' : 'stay'} as ${sessions === 1 ? 'it is' : 'they are'} either way — ` +
      'you agreed to be recorded at the time, and they are the table\'s record of an evening everyone played. ' +
      'This only decides what happens next.\n'
    : '';

  return {
    content:
      `🪶 **${campaignName}** — ${headline}\n` +
      (decidedAt ? `You answered on ${discordTime(decidedAt, 'D')}.\n` : '') +
      `\n${facts.join('\n')}\n` +
      scope +
      '\n_Only you can see this. `/campaign consent` any time._',
    components: [new ActionRowBuilder().addComponents(control)],
  };
}

export function buildStoppedMessage(campaignName, { hasRecord, sessions = 0 }) {
  return (
    `🔇 **Quill will not record you** in **${campaignName}** from now on.\n` +
    'Your microphone is skipped rather than recorded and discarded, so nothing new of yours is captured. ' +
    'You can still play — I write down everyone else.\n\n' +
    (hasRecord
      ? `The ${sessions} session${sessions === 1 ? '' : 's'} already on file ${sessions === 1 ? 'stays' : 'stay'} as ${sessions === 1 ? 'it is' : 'they are'}.\n`
      : '') +
    'Changed your mind? `/campaign consent` turns it back on.'
  );
}

export function buildResumedMessage(campaignName) {
  return (
    `✅ **Quill will record you** in **${campaignName}** again, from the next session on.\n` +
    'You can stop again at any time with `/campaign consent`.'
  );
}

// What the person running the game is told.
//
// The fact, and named — the bot already announces who it is skipping every
// time it joins a channel, so pretending to anonymise it here would protect
// nobody and would leave the DM to work it out from a short transcript.
//
// Sent because it changes what the next transcript will contain, which is the
// DM's problem to plan around. Nothing that already exists has moved.
export function buildManagerNotice({ campaignName, who }) {
  return (
    `🪶 **${who}** has turned off recording in **${campaignName}**.\n\n` +
    'From the next session on, their microphone is skipped and everyone else is written down as normal. ' +
    'Every transcript and every set of notes you already have is unchanged.\n\n' +
    'There is no way for you to put them back. If they want to be recorded again they run `/campaign consent` ' +
    'themselves — asking on their behalf is a conversation, not a button.'
  );
}

// Who in the voice channel the bot is about to ignore, so the DM finds out
// before the session rather than when the transcript comes back short.
//
// Split by why, because the two halves need opposite things. Someone who has
// never been asked is waiting on an invite. Someone who used /campaign consent
// to turn recording off has already answered, and telling the DM to invite them
// turns a decision they made for themselves into something to be nagged about.
//
// Accepts a bare array too — it was one for a long time, and a DM's channel
// message is not worth breaking over a signature.
export function describeUnrecorded(who) {
  const { unasked = [], declined = [] } = Array.isArray(who) ? { unasked: who } : (who ?? {});
  if (unasked.length === 0 && declined.length === 0) return '';

  const list = (names) => names.map((n) => `**${n}**`).join(', ');
  const parts = [];

  if (unasked.length) {
    parts.push(
      `🔇 Not being recorded: ${list(unasked)} — they have not agreed to be recorded in this campaign. ` +
        '`/campaign invite` asks them.'
    );
  }
  if (declined.length) {
    parts.push(
      `🔇 Recording off by their own choice: ${list(declined)}. ` +
        'They can turn it back on themselves with `/campaign consent` — that one is theirs, not yours.'
    );
  }

  return `\n\n${parts.join('\n')}`;
}
