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
    'Changed your mind? `/campaign consent` turns it back off, any time, without asking anyone.'
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
  const match = /^withdraw:(stop|erase|confirm|cancel|resume):(\d+)$/.exec(String(customId ?? ''));
  return match ? { action: match[1], campaignId: Number(match[2]) } : null;
}

const button = (action, campaignId, label, style) =>
  new ButtonBuilder().setCustomId(`${WITHDRAW_PREFIX}${action}:${campaignId}`).setLabel(label).setStyle(style);

// Where you stand, and the three things you can do about it.
//
// The order is deliberate and is the opposite of a dark pattern: the option
// that changes nothing comes first and is the one you land on, and the
// irreversible one is last and is the only one styled as dangerous.
export function buildStandingMessage(standing, campaignName) {
  const { state, lines, sessions, characterName, displayName, decidedAt, retentionDays, hasRecord } = standing;

  const headline =
    state === 'granted' ? 'You are being recorded, and you said yes.'
    : state === 'declined' ? 'You are not being recorded.'
    : state === 'pending' ? 'You were asked, and have not answered.'
    : state === 'expired' ? 'You were asked, and the invitation ran out.'
    : 'Nobody has asked you yet.';

  const facts = [
    `**On file** — ${hasRecord ? `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} across ${sessions} transcript${sessions === 1 ? '' : 's'}` : 'nothing'}`,
    `**As** — ${characterName || displayName || 'your Discord name'}`,
    `**Audio** — ${
      retentionDays > 0
        ? `deleted after ${retentionDays} day${retentionDays === 1 ? '' : 's'}, once it has been transcribed`
        : 'kept until the person running the bot deletes it'
    }`,
  ];

  const rows = [];
  if (state === 'granted') {
    rows.push(button('stop', standing.campaignId, 'Stop recording me from now on', ButtonStyle.Secondary));
    if (hasRecord) {
      rows.push(button('erase', standing.campaignId, 'Stop, and take out what you have', ButtonStyle.Danger));
    }
  } else {
    rows.push(button('resume', standing.campaignId, 'Record me from now on', ButtonStyle.Success));
    if (hasRecord) {
      rows.push(button('erase', standing.campaignId, 'Take out what you already have', ButtonStyle.Danger));
    }
  }

  return {
    content:
      `🪶 **${campaignName}** — ${headline}\n` +
      (decidedAt ? `You answered on ${discordTime(decidedAt, 'D')}.\n` : '') +
      `\n${facts.join('\n')}\n\n` +
      '_Only you can see this. `/campaign consent` any time._',
    components: [new ActionRowBuilder().addComponents(...rows)],
  };
}

// Exactly what erasing does, before it happens.
//
// The `cannot` line is not a disclaimer at the bottom in small print — it is
// part of the list, in the same voice as the rest, because it is the thing
// somebody would most reasonably be angry about discovering afterwards.
export function buildErasePlan(plan, campaignName) {
  const names = plan.names.length ? plan.names.map((n) => `**${n}**`).join(' and ') : 'your name';

  return {
    content:
      `⚠️ **This cannot be undone.** Here is exactly what I will do in **${campaignName}**:\n\n` +
      `**Remove** — ${plan.lines.toLocaleString()} of your line${plan.lines === 1 ? '' : 's'}, from all ` +
      `${plan.sessions} transcript${plan.sessions === 1 ? '' : 's'}\n` +
      (plan.notes
        ? `**Remove** — ${names} from ${plan.notes} set${plan.notes === 1 ? '' : 's'} of notes, replaced with "${plan.replacement}"\n`
        : '**Remove** — your character name from this campaign\n') +
      `**Keep** — ${plan.keeps}\n` +
      plan.cannot.map((c) => `**Cannot** — ${c}`).join('\n') +
      '\n\nWhoever runs the game will be told that you left the record, not why.',
    components: [
      new ActionRowBuilder().addComponents(
        button('confirm', plan.campaignId, 'Take me out', ButtonStyle.Danger),
        button('cancel', plan.campaignId, 'Keep me in', ButtonStyle.Secondary)
      ),
    ],
  };
}

export function buildErasedMessage(result, campaignName) {
  return (
    `✅ **You are out of the record** in **${campaignName}**.\n\n` +
    `**Lines removed** — ${result.lines.toLocaleString()}\n` +
    `**Transcripts rewritten** — ${result.sessions}\n` +
    `**Notes edited** — ${result.notes}\n` +
    '**Audio** — was already deleted\n\n' +
    'I will not record you again. You can still play — I skip your microphone and write down everyone else.\n' +
    'Changed your mind? `/campaign consent` turns it back on.'
  );
}

export function buildStoppedMessage(campaignName, { hasRecord }) {
  return (
    `🔇 **Quill will not record you** in **${campaignName}** from now on.\n` +
    'Your microphone is skipped rather than recorded and discarded, so nothing new of yours is captured.\n\n' +
    (hasRecord
      ? 'What you said before is still on file. `/campaign consent` again if you want that taken out too.\n'
      : '') +
    'Changed your mind? `/campaign consent` turns it back on.'
  );
}

export function buildResumedMessage(campaignName) {
  return (
    `✅ **Quill will record you** in **${campaignName}** again, from the next session on.\n` +
    'Nothing that was taken out comes back — that was permanent.\n' +
    'You can stop again at any time with `/campaign consent`.'
  );
}

// What the person running the game is told.
//
// The fact, not the reason. They need to know their transcripts changed under
// them — a recap that no longer matches what they remember is otherwise a bug
// they will spend an evening chasing — and they are owed nothing beyond that.
export function buildManagerNotice({ campaignName, result }) {
  return (
    `🪶 Someone has left the record in **${campaignName}**.\n\n` +
    `${result.lines.toLocaleString()} line${result.lines === 1 ? '' : 's'} came out of ${result.sessions} ` +
    `transcript${result.sessions === 1 ? '' : 's'}, and ${result.notes} set${result.notes === 1 ? '' : 's'} of ` +
    'notes were rewritten to take their name out. Everything everyone else said is untouched, and your session ' +
    'count and hours are unchanged — the games happened, one voice just came out of them.\n\n' +
    'There is no way for you to put them back. If they want to be recorded again they run `/campaign consent` ' +
    'themselves — asking on their behalf is a conversation, not a button.'
  );
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
