import 'dotenv/config';

// The bot runs as root inside the container, but the files it writes are
// collected over SFTP by an ordinary user on the host. Deleting a file needs
// write permission on its DIRECTORY, so with the default 022 umask every
// directory came out root:root 755 and the collector could copy files but
// never remove them — `rclone move` silently degraded to `rclone copy` and
// nothing was ever freed from the Pi. 002 makes new files and directories
// group-writable, which (with the setgid bit on the export roots) lets the
// collector clean up after itself.
//
// This lives HERE, in the module every entry point already imports for its
// configuration, rather than in src/index.js where it started. The bot had it
// and the vault scripts did not, so scripts/build-npc-notes.mjs and friends
// created NPCs/ and Characters/ at 755 and the sync failed on every file
// inside them — a split that is invisible until something 4,000 lines away
// reports "permission denied". A new script cannot forget this.
process.umask(0o002);

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing or empty required env: ${name}`);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function validate(cfg) {
  if (cfg.summaryProvider === 'anthropic' && !cfg.anthropicApiKey) {
    throw new Error(
      'SUMMARY_PROVIDER=anthropic requires ANTHROPIC_API_KEY.'
    );
  }
  if (cfg.summaryProvider === 'gemini' && !cfg.geminiApiKey) {
    throw new Error(
      'SUMMARY_PROVIDER=gemini requires GEMINI_API_KEY. Get one from https://aistudio.google.com/apikey'
    );
  }
  return cfg;
}

export const config = validate({
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),

  dataDir: optional('DATA_DIR', '/data'),

  // whisper.cpp — WHISPER_MODEL_PATH defaults from WHISPER_MODEL_NAME rather
  // than a fixed literal, so changing just the model name (e.g. base.en ->
  // medium.en) can't silently leave the path pointing at a differently-named
  // file; set WHISPER_MODEL_PATH explicitly only if you want a custom path.
  whisperBin: optional('WHISPER_BIN', '/app/whisper.cpp/build/bin/whisper-cli'),
  whisperModelPath: optional('WHISPER_MODEL_PATH', `/models/ggml-${optional('WHISPER_MODEL_NAME', 'base.en')}.bin`),
  whisperThreads: parseInt(optional('WHISPER_THREADS', '4'), 10),
  // Pinned rather than auto-detected. A multilingual model (large-v3-turbo,
  // large-v3) will sometimes decide a short, noisy clip is another language
  // and transcribe it that way; a session is hundreds of such clips, so it
  // only has to be wrong occasionally to corrupt the transcript. English-only
  // models (*.en) ignore this setting entirely.
  whisperLanguage: optional('WHISPER_LANGUAGE', 'en'),
  // Feed the campaign's proper nouns to whisper as a decoding prompt. On by
  // default; set false to turn it off without a redeploy if a session ever
  // comes back with prompt text echoed into the transcript (a known whisper
  // failure mode on near-silent clips).
  whisperPrompt: optional('WHISPER_PROMPT', 'true') !== 'false',
  // Drop whisper's stock silence hallucinations ("Thank you.", "Bye.") when
  // its language confidence says the clip was not really speech. Measured at
  // 17% of a real session's transcript before this existed.
  whisperDropFiller: optional('WHISPER_DROP_FILLER', 'true') !== 'false',
  // Loudness below which a clip is transcribed WITHOUT the vocabulary prompt.
  // Measured: prompting a near-silent clip costs 5.7x the inference time (and
  // is where prompt echoes come from), while on real speech it is free. 0 sends
  // the prompt on everything, which is ~4x slower overall for no extra benefit.
  whisperPromptMinRms: parseFloat(optional('WHISPER_PROMPT_MIN_RMS', '0.03')),

  // Where transcription actually runs. Unset = on the Pi's CPU, which does
  // neural inference at roughly 10x slower than realtime (a 30-minute session
  // took ~4.5 hours). Set to a whisper.cpp HTTP server on a machine with a
  // GPU — in this setup, the Windows PC on the LAN — and the same work
  // takes seconds. Audio still never leaves the LAN either way.
  whisperServerUrl: optional('WHISPER_SERVER_URL', null),
  // A long session is a lot of audio; the per-request cap is generous so a
  // big /import doesn't fail halfway.
  whisperServerTimeoutMs: parseInt(optional('WHISPER_SERVER_TIMEOUT_MS', '600000'), 10),
  // If the GPU machine is off, fall back to transcribing on the Pi. Slow, but
  // a session is never lost. Set false to fail instead, so it can be retried
  // later on the GPU rather than grinding through it on CPU.
  whisperLocalFallback: optional('WHISPER_LOCAL_FALLBACK', 'true') !== 'false',

  // whisper.cpp encodes a fixed 30-second window however short the clip is,
  // so transcribing hundreds of one-second Discord clips one at a time wastes
  // almost all of it (a real 235-clip session measured at ~4.5 hours).
  // Batching merges clips from the SAME speaker to fill those windows: ~5x
  // faster, speakers still exactly right, but line breaks get ragged and
  // per-line timestamps drift by a few seconds. See pipeline/transcribe.js.
  //
  // 'auto' (the default) spends that accuracy only where it buys something.
  // On the GPU server a clip costs ~0.17s, so a whole session is over in a
  // couple of minutes unbatched — there is nothing to buy, so it stays clean.
  // On the Pi's CPU the same session is measured in HOURS, and 5x is the
  // difference between "overnight" and "next week", so batching turns on.
  // true/false force it either way regardless of where transcription runs.
  transcribeBatching: (() => {
    const v = optional('TRANSCRIBE_BATCHING', 'auto').toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return 'auto';
  })(),

  // Which model writes the summary. Both send the finished TRANSCRIPT TEXT to
  // a cloud provider; audio and transcription always stay local, so the
  // recordings never leave the network under any setting.
  //
  // There is no local option any more — see pipeline/model-client.js for why
  // Ollama was dropped. The practical consequence is that summarising needs
  // the internet: when it's unavailable, jobs queue and retry.
  summaryProvider: (() => {
    const v = optional('SUMMARY_PROVIDER', 'gemini').toLowerCase();
    return v === 'anthropic' ? v : 'gemini';
  })(),
  anthropicApiKey: optional('ANTHROPIC_API_KEY', null),
  anthropicModel: optional('ANTHROPIC_MODEL', 'claude-opus-5'),

  // Gemini's cheap tier moves under you: gemini-2.5-flash-lite was the budget
  // pick until Google cut new API keys off from it (HTTP 404, "no longer
  // available to new users"), then gemini-3.1-flash-lite replaced it.
  //
  // gemini-3.6-flash is the current default — a full flash model rather than
  // a lite one, because at 3.6 there IS no lite: gemini-3.6-flash-lite and
  // gemini-3.6-pro both 404 on a free key, and 3.6-flash is what the NPC and
  // location note builders already use to read whole transcripts. Verified
  // against a real key on 2026-08-09.
  //
  // Note that 3.6-flash is missing from ListModels even though it serves
  // requests, so "not in the list" is not evidence a model is unavailable —
  // probe it with a real generateContent call before believing otherwise.
  geminiApiKey: optional('GEMINI_API_KEY', null),
  geminiModel: optional('GEMINI_MODEL', 'gemini-3.6-flash'),

  // --- the dashboard's API ---
  // The bot otherwise makes only outbound connections, so this is the one
  // inbound port it opens. Serves operational data only — no tokens, no keys.
  // Empty/0 disables it entirely.
  statusPort: parseInt(optional('STATUS_PORT', '8090'), 10) || 0,
  statusHost: optional('STATUS_HOST', '0.0.0.0'),
  // Shared secret. Reads are open without it, which is a reasonable default
  // for operational data on a home LAN. ACTIONS are not: approving a summary
  // spends the API budget and approving a transcription seizes the PC's GPU,
  // so with this unset the server refuses every action rather than treating
  // "no credential configured" as "everyone is welcome". See web/server.js.
  statusToken: optional('STATUS_TOKEN', null),

  // Where to find the dashboard, for the notification DMs to link to.
  //
  // The owner's DMs used to carry the approve/park buttons themselves. They
  // are now a notification — the decision is made on the dashboard — so a DM
  // that can't say WHERE is a DM telling you to go somewhere unspecified.
  // Unset just omits the link.
  dashboardUrl: optional('DASHBOARD_URL', null),

  // --- when transcription is allowed to use the PC's GPU ---
  // Transcription is the only step that reaches into another machine, and
  // that machine is also the gaming PC. Rather than firing the moment a
  // session ends, a finished recording waits and runs either when the owner
  // approves it or inside the automatic window below.
  //
  // The container runs in UTC, so this timezone is what makes "8am" mean 8am
  // where the PC actually is. Getting it wrong doesn't error — it just runs
  // at the wrong time of day — so it is stated explicitly rather than
  // inferred from the host.
  scheduleTimeZone: optional('SCHEDULE_TIMEZONE', 'Australia/Brisbane'),
  transcribeRequireApproval: optional('TRANSCRIBE_REQUIRE_APPROVAL', 'true') !== 'false',
  transcribeWindowStartHour: parseInt(optional('TRANSCRIBE_WINDOW_START_HOUR', '8'), 10),
  transcribeWindowEndHour: parseInt(optional('TRANSCRIBE_WINDOW_END_HOUR', '16'), 10),
  // Weekends are when the PC is most likely to be in use, so the automatic
  // window is weekdays-only by default; a weekend session waits for Monday
  // unless it is approved by hand.
  transcribeWeekdaysOnly: optional('TRANSCRIBE_WEEKDAYS_ONLY', 'true') !== 'false',
  // "Remind me later" pushes a job out by this long, and also rate-limits the
  // nudges for a job nobody has actioned.
  transcribeSnoozeHours: parseInt(optional('TRANSCRIBE_SNOOZE_HOURS', '24'), 10),
  // How often the transcribe worker looks for due work.
  transcribePollMs: parseInt(optional('TRANSCRIBE_POLL_MS', '60000'), 10),

  // Once a session is transcribed its archive is moved here, for the PC to
  // collect (scriber-pc-sync already pulls from the Pi over rclone and
  // deletes what it takes). Keeps long campaigns off the Pi's card.
  // Empty disables the offload and leaves the archive in the audio directory.
  audioOffloadDir: optional('AUDIO_OFFLOAD_DIR', '/data/audio-outbox'),

  // --- summarise-on-approval ---
  // With this on, finishing a session does NOT immediately summarise; the
  // job waits in 'awaiting_approval' and the owner gets a DM with a button,
  // so nothing is sent to a cloud model until someone says so.
  summaryRequireApproval: optional('SUMMARY_REQUIRE_APPROVAL', 'false') === 'true',
  // Discord user ID to DM for that approval (and for pipeline nudges).
  // Without it, approval still works via /pending, there's just no DM.
  ownerUserId: optional('OWNER_USER_ID', null),

  // Job queue / retry behaviour for when the summariser can't be reached
  summarizeRetryBaseMs: parseInt(optional('SUMMARIZE_RETRY_BASE_MS', '60000'), 10), // 1 min
  summarizeRetryMaxMs: parseInt(optional('SUMMARIZE_RETRY_MAX_MS', '1800000'), 10), // 30 min cap
  summarizeMaxAttempts: parseInt(optional('SUMMARIZE_MAX_ATTEMPTS', '0'), 10), // 0 = retry forever

  // Where Obsidian-ready markdown gets written (bind-mount this to your vault sync folder)
  obsidianExportDir: optional('OBSIDIAN_EXPORT_DIR', '/data/obsidian'),
  // Render NPC/location names as [[wikilinks]] so Obsidian's graph view
  // connects sessions to the campaign ledger. Set false for plain text.
  obsidianWikilinks: optional('OBSIDIAN_WIKILINKS', 'true') !== 'false',

  // Discord delivery
  notesChannelId: optional('NOTES_CHANNEL_ID', null), // falls back to the voice session's text channel
  // Send finished notes to OWNER_USER_ID's DMs instead of a server channel,
  // so one bot can serve several servers without each needing its own notes
  // channel. Requires OWNER_USER_ID; falls back to the channel if the DM
  // can't be opened (Discord lets people refuse DMs from bots).
  notesToOwnerDm: optional('NOTES_TO_OWNER_DM', 'false') === 'true',

  // Google Drive sync via rclone. Pi remains the source of truth for
  // /history and /export (fast, works offline) — this just pushes copies
  // out so your PC's Google Drive desktop app picks them up automatically.
  driveSyncEnabled: optional('DRIVE_SYNC_ENABLED', 'false') === 'true',
  // Off by default: even compressed, a long session is still tens of MB.
  // When on, uploads one compressed whole-session recording (built by
  // pipeline/session-recording.js) rather than the raw per-utterance
  // fragment directory.
  driveSyncAudio: optional('DRIVE_SYNC_AUDIO', 'false') === 'true',
  driveRemoteName: optional('DRIVE_REMOTE_NAME', 'gdrive'), // must match `rclone config` remote name
  driveRemotePath: optional('DRIVE_REMOTE_PATH', 'DnDSessions'),

  // Audio retention: auto-delete raw audio for successfully-completed
  // meetings after this many days, so the Pi's disk doesn't fill up over a
  // long campaign. 0 = keep forever. Only ever touches 'done' meetings —
  // anything still pending/failed/retrying is left alone.
  audioRetentionDays: parseInt(optional('AUDIO_RETENTION_DAYS', '14'), 10),

  // What happens to a session's audio once its transcript is stored.
  //
  // With this on (the default), the hundreds of per-utterance WAV fragments
  // are collapsed into ONE compressed recording of the whole session and the
  // fragments are deleted. That archive is a fraction of the size, is
  // actually listenable (the fragments never were — they're a directory of
  // one-second clips), and is then aged out by AUDIO_RETENTION_DAYS above.
  //
  // The trade-off is per-speaker separation: the archive is a single mixed
  // timeline, so re-transcribing it later recovers the words but not
  // reliably who said them. Set AUDIO_ARCHIVE=false to keep the raw
  // fragments instead, which stays re-transcribable at ~4x the disk.
  //
  // Either way the archive is only built after the transcript is committed,
  // and never at the cost of the fragments if the build fails.
  audioArchive: optional('AUDIO_ARCHIVE', 'true') !== 'false',
});
