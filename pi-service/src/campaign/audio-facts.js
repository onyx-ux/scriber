// What this install actually does with a recording, in sentences.
//
// The consent DM used to say "Your recording is never sent anywhere else" and
// the dashboard's Audio card used to say the recording "never leaves your
// network and is not kept, and this cannot be turned off" — both as fixed
// text, whatever the configuration. GEMINI_TRANSCRIBE uploads audio to Google,
// DRIVE_SYNC_AUDIO puts a copy on Google Drive, AUDIO_OFFLOAD_DIR keeps one on
// the operator's PC, and AUDIO_RETENTION_DAYS=0 keeps the raw clips for ever.
// Any of those made the promise false, and it was made at the one moment
// somebody was deciding whether to trust the thing. Found in the 2026-09-27
// review; fixed 2026-11-14.
//
// So the promise is built here, from the same config the behaviour is driven
// by, and every surface that describes audio reads these lines rather than
// writing its own: the invitation DM, /campaign consent, the join screen, and
// the Settings card. One place to be wrong in, and it is the place that knows.

export function audioFacts(cfg) {
  const days = Number.parseInt(cfg?.audioRetentionDays, 10);
  return {
    // 0 is "kept until somebody deletes it", which is also what a missing or
    // unreadable value means: the retention sweep does nothing without a number.
    retentionDays: Number.isFinite(days) && days > 0 ? days : 0,
    // Whether a session CAN be sent to Google to be transcribed. It is offered
    // per session and chosen by whoever runs the bot, so this is a "may".
    cloudTranscribe: Boolean(cfg?.geminiTranscribe && cfg?.geminiApiKey),
    // A compressed copy of each session, pushed to Google Drive.
    driveAudio: Boolean(cfg?.driveSyncEnabled && cfg?.driveSyncAudio),
    // The mixed recording, moved to the operator's own PC once transcribed.
    offload: Boolean(cfg?.audioOffloadDir),
  };
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// The sentences, in the order somebody asks them: how it becomes text, what
// is sent on, how long it is kept, and where else it goes. Plain text — each
// surface adds its own bullets and emphasis.
export function audioLines(facts = {}) {
  const lines = [];

  lines.push(
    facts.cloudTranscribe
      ? 'Your audio is turned into text on the machine running this bot. Whoever runs it can instead ' +
        'send a session’s recording to Google (Gemini) to be transcribed, and chooses that session by session.'
      : 'Your audio is turned into text on the machine running this bot. It is not uploaded anywhere to be transcribed.'
  );

  lines.push('That text — not your audio — is then sent to an AI service to write the session summary.');

  lines.push(
    facts.retentionDays > 0
      ? `The recording on the bot is deleted after ${days(facts.retentionDays)} — long enough to transcribe it and fix mistakes.`
      : 'The recording on the bot is kept until the person running it deletes it.'
  );

  if (facts.offload) {
    lines.push(
      'Once a session is transcribed, one mixed recording of it is moved to the computer of whoever runs this bot, and kept there.'
    );
  }
  if (facts.driveAudio) {
    lines.push('A compressed copy of each session’s recording is also saved to their Google Drive.');
  }
  if (!facts.cloudTranscribe && !facts.offload && !facts.driveAudio) {
    lines.push('Your recording is never sent anywhere else.');
  }

  return lines;
}

// Both at once, for a payload.
export function audioSummary(cfg) {
  const facts = audioFacts(cfg);
  return { ...facts, lines: audioLines(facts) };
}
