import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Where a finished session gets transcribed, asked once at /leave.
//
// The two answers are not just "fast" and "slow" — they imply completely
// different machines being awake, and that cascades into which summariser can
// possibly work:
//
//   PC — the GPU whisper server (~0.17s/clip). The PC is on, so Ollama is
//        reachable too and the normal summariser applies.
//   Pi — whisper on the Pi's own CPU (~65s per 30s encode window; a session
//        takes hours). Choosing this generally MEANS the PC is off, and
//        Ollama lives on that same PC — so leaving the summariser pointed at
//        Ollama would queue a job that cannot run until the PC comes back.
//        Gemini is the summariser that doesn't need the PC at all, so it
//        becomes the default and the session actually completes unattended.
//
// Audio never leaves the LAN under either choice; picking Pi only changes
// where the finished TRANSCRIPT TEXT is summarised.

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

  const next = {
    // Forcing this to null is what actually pins transcription to the Pi:
    // stt/whisper.js goes straight to the local CLI when there's no server.
    ...cfg,
    whisperServerUrl: null,
  };

  // Only redirect the summariser if Gemini is actually configured. Without a
  // key, switching would swap a job that's merely delayed for one that can
  // never run at all.
  if (cfg.geminiApiKey) next.summaryProvider = 'gemini';
  return next;
}

// What the summary provider will end up being, for telling the user what they
// just chose. Kept separate from applyTranscribeTarget so the message and the
// behaviour cannot drift apart.
export function targetSummary(cfg, target) {
  const resolved = applyTranscribeTarget(cfg, target);
  return {
    onPi: target === TARGET_PI,
    provider: resolved.summaryProvider,
    providerSwitched: resolved.summaryProvider !== cfg.summaryProvider,
  };
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
      .setLabel('Pi — CPU, hours (+ Gemini summary)')
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

const PROVIDER_LABEL = { ollama: 'Ollama', gemini: 'Gemini', anthropic: 'Claude' };
const providerName = (p) => PROVIDER_LABEL[p] ?? p;

export function transcribeChoicePrompt(cfg, { serverReachable }) {
  const lines = ['**Where should I transcribe this session?**'];

  lines.push(
    serverReachable
      ? '• **PC** — GPU, done in minutes. Summary stays on ' + `${providerName(cfg.summaryProvider)}.`
      : "• **PC** — not answering right now, so it's not an option."
  );

  const onPi = targetSummary(cfg, TARGET_PI);
  lines.push(
    `• **Pi** — its own CPU, which takes hours for a full session.` +
      (onPi.providerSwitched
        ? ` Summary switches to **${providerName(onPi.provider)}**, since the PC being off means Ollama can't run either.`
        : ` Summary stays on ${providerName(onPi.provider)}.`)
  );

  lines.push(`_Defaulting to **${defaultTarget({ serverReachable }) === TARGET_PC ? 'PC' : 'Pi'}** if nobody picks._`);
  return lines.join('\n');
}

export function transcribeChosenNote(cfg, target) {
  const { onPi, provider, providerSwitched } = targetSummary(cfg, target);
  const where = onPi ? 'the Pi (CPU — this will take a while)' : 'the PC (GPU)';
  return `Transcribing on ${where}. Summary: **${providerName(provider)}**${
    providerSwitched ? ' _(switched — the PC is off)_' : ''
  }.`;
}
