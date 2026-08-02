import 'dotenv/config';

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

  // Gemini: pinned to the cheapest current model by default rather than a
  // frontier one — the whole point of choosing Gemini here was cost, since
  // Anthropic's API is a paid-tier-only product. gemini-2.5-flash-lite was
  // the budget pick until Google cut new API keys off from it (returns HTTP
  // 404 "no longer available to new users"); gemini-3.1-flash-lite is its
  // live replacement, verified against a real key on 2026-07-31.
  geminiApiKey: optional('GEMINI_API_KEY', null),
  geminiModel: optional('GEMINI_MODEL', 'gemini-3.1-flash-lite'),

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
