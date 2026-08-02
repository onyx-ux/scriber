import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Where a finished session gets transcribed, asked once at /leave.
//
//   PC — the GPU whisper server (~0.17s/clip): a session is done in minutes.
//   Pi — whisper on the Pi's own CPU (~65s per 30s encode window), which
//        takes hours for a full session but needs no other machine awake.
//
// This choice only affects transcription. Summarising is unaffected either
// way now that it runs in the cloud — it used to switch providers here,
// because the local summariser lived on the same PC as the GPU and choosing
// the Pi implied that PC was off.
//
// Audio never leaves the LAN under either choice.

export const TRANSCRIBE_PREFIX = 'scriber:tx:';

export const TARGET_PC = 'pc';
export const TARGET_PI = 'pi';

export function isValidTarget(target) {
  return target === TARGET_PC || target === TARGET_PI;
}

// Whether asking is even meaningful. With no server configured there is only
// one place transcription can happen, so a prompt would be a question with a
// single answer.
export function choiceAvailable(cfg) {
  return Boolean(cfg.whisperServerUrl);
}

// The cfg the rest of the pipeline should run under, given the answer.
// Returns a copy — the shared config object is never mutated, so one
// session's choice can't leak into the next.
export function applyTranscribeTarget(cfg, target) {
  if (target !== TARGET_PI) return cfg;
  // Forcing this to null is what actually pins transcription to the Pi:
  // stt/whisper.js goes straight to the local CLI when there's no server.
  return { ...cfg, whisperServerUrl: null };
}

export function buildTranscribeChoiceRow(meetingId, { serverReachable = true } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${meetingId}:${TARGET_PC}`)
      .setLabel(serverReachable ? 'PC — GPU, minutes' : 'PC — GPU (not responding)')
      .setStyle(serverReachable ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!serverReachable),
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${meetingId}:${TARGET_PI}`)
      .setLabel('Pi — CPU, hours')
      .setStyle(ButtonStyle.Secondary)
  );
}

export function parseTranscribeChoice(customId) {
  if (!customId?.startsWith(TRANSCRIBE_PREFIX)) return null;
  const [rawMeetingId, target] = customId.slice(TRANSCRIBE_PREFIX.length).split(':');
  const meetingId = parseInt(rawMeetingId, 10);
  if (!Number.isInteger(meetingId) || !isValidTarget(target)) return null;
  return { meetingId, target };
}

// What to do when nobody presses anything. The session is already recorded and
// waiting; defaulting to whichever machine can actually do the work beats
// leaving a transcript unmade because the prompt scrolled off screen.
export function defaultTarget({ serverReachable }) {
  return serverReachable ? TARGET_PC : TARGET_PI;
}

export function transcribeChoicePrompt(cfg, { serverReachable }) {
  return [
    '**Where should I transcribe this session?**',
    serverReachable ? '• **PC** — GPU, done in minutes.' : "• **PC** — not answering right now, so it's not an option.",
    '• **Pi** — its own CPU, which takes hours for a full session.',
    `_Defaulting to **${defaultTarget({ serverReachable }) === TARGET_PC ? 'PC' : 'Pi'}** if nobody picks._`,
  ].join('\n');
}

export function transcribeChosenNote(cfg, target) {
  return `Transcribing on ${target === TARGET_PI ? 'the Pi (CPU — this will take a while)' : 'the PC (GPU)'}.`;
}
