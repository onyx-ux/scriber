import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Where a finished session gets transcribed, asked once at /leave.
//
//   PC     — the GPU whisper server (~0.17s/clip): a session is done in
//            minutes, costs nothing, and the audio stays on the LAN.
//   Gemini — Gemini 3.5 Transcribe Live, over the internet. Minutes rather
//            than hours when the PC is off, but it is the one option that
//            sends the RECORDINGS out of the house. Off unless the operator
//            turned on GEMINI_TRANSCRIBE; see stt/gemini-live.js.
//   Pi     — whisper on the Pi's own CPU (~65s per 30s encode window), which
//            takes hours for a full session but needs nothing else at all.
//
// This choice only affects transcription. Summarising is unaffected either
// way now that it runs in the cloud — it used to switch providers here,
// because the local summariser lived on the same PC as the GPU and choosing
// the Pi implied that PC was off.

export const TRANSCRIBE_PREFIX = 'scriber:tx:';

export const TARGET_PC = 'pc';
export const TARGET_PI = 'pi';
export const TARGET_GEMINI = 'gemini';

export function isValidTarget(target) {
  return target === TARGET_PC || target === TARGET_PI || target === TARGET_GEMINI;
}

// Whether the cloud option is on the table at all. Kept next to the targets
// rather than imported from stt/gemini-live.js so this module stays a
// description of the CHOICE — what the buttons are and what they mean.
export function geminiAvailable(cfg) {
  return Boolean(cfg.geminiTranscribe && cfg.geminiApiKey);
}

// Whether asking is even meaningful. With no GPU server and no cloud option
// there is only one place transcription can happen, so a prompt would be a
// question with a single answer.
export function choiceAvailable(cfg) {
  return Boolean(cfg.whisperServerUrl) || geminiAvailable(cfg);
}

// The cfg the rest of the pipeline should run under, given the answer.
// Returns a copy — the shared config object is never mutated, so one
// session's choice can't leak into the next.
export function applyTranscribeTarget(cfg, target) {
  // transcribeVia is what pipeline/transcribe.js reads to tell an explicit
  // answer apart from the automatic ladder.
  if (target === TARGET_GEMINI) return { ...cfg, transcribeVia: TARGET_GEMINI };
  if (target === TARGET_PI) {
    // Forcing the URL to null is what actually pins transcription to the Pi:
    // stt/whisper.js goes straight to the local CLI when there's no server.
    // transcribeVia is set alongside it because with GEMINI_TRANSCRIBE on, a
    // missing server URL is exactly what the automatic ladder reads as "use
    // the cloud" — so without this, choosing the Pi would reach Gemini.
    return { ...cfg, whisperServerUrl: null, transcribeVia: TARGET_PI };
  }
  // PC is deliberately not pinned. The scheduler in transcribe-worker.js
  // passes it to mean "not the Pi" for every ordinary job, not "the operator
  // chose the GPU" — marking those would switch the automatic fallback off
  // for every session that nobody pressed a button on.
  return cfg;
}

export function buildTranscribeChoiceRow(meetingId, cfg, { serverReachable = true } = {}) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${meetingId}:${TARGET_PC}`)
      .setLabel(serverReachable ? 'PC — GPU, minutes' : 'PC — GPU (not responding)')
      .setStyle(serverReachable ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!serverReachable),
  ];

  // Offered second, and never styled as the recommended answer even when the
  // PC is down: it is the only button that sends the table's recording to
  // somebody else's computer, and that should read as a deliberate choice
  // rather than the obvious one.
  if (geminiAvailable(cfg)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${TRANSCRIBE_PREFIX}${meetingId}:${TARGET_GEMINI}`)
        .setLabel('Gemini — cloud, minutes')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`${TRANSCRIBE_PREFIX}${meetingId}:${TARGET_PI}`)
      .setLabel('Pi — CPU, hours')
      .setStyle(ButtonStyle.Secondary)
  );

  return new ActionRowBuilder().addComponents(...buttons);
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
//
// The cloud is deliberately NOT the silent default. It is the fastest thing
// available with the PC off, but defaulting to it would mean a recording
// leaves the network because nobody was looking at Discord — so an unanswered
// prompt still falls to the Pi, and GEMINI_TRANSCRIBE is what makes the
// automatic ladder in pipeline/transcribe.js reach for Gemini instead.
export function defaultTarget({ serverReachable }) {
  return serverReachable ? TARGET_PC : TARGET_PI;
}

const NAMES = {
  [TARGET_PC]: 'PC',
  [TARGET_PI]: 'Pi',
  [TARGET_GEMINI]: 'Gemini',
};

export function transcribeChoicePrompt(cfg, { serverReachable }) {
  const lines = [
    '**Where should I transcribe this session?**',
    serverReachable ? '• **PC** — GPU, done in minutes.' : "• **PC** — not answering right now, so it's not an option.",
  ];

  // Says what it costs on the button's own line. Somebody choosing this is
  // choosing to send the table's recording to Google, and they should not
  // have to have read the README to know that.
  if (geminiAvailable(cfg)) {
    lines.push('• **Gemini** — cloud, done in minutes. Sends the recording to Google.');
  }

  lines.push('• **Pi** — its own CPU, which takes hours for a full session.');
  lines.push(`_Defaulting to **${NAMES[defaultTarget({ serverReachable })]}** if nobody picks._`);
  return lines.join('\n');
}

export function transcribeChosenNote(cfg, target) {
  if (target === TARGET_PI) return 'Transcribing on the Pi (CPU — this will take a while).';
  if (target === TARGET_GEMINI) return 'Transcribing with Gemini (the recording is being sent to Google).';
  return 'Transcribing on the PC (GPU).';
}
