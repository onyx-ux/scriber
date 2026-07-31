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

export const config = {
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

  // Ollama on the PC, reachable over the LAN
  ollamaUrl: optional('OLLAMA_URL', 'http://127.0.0.1:11434'),
  ollamaModel: optional('OLLAMA_MODEL', 'qwen2.5:14b'),
  // Context window for summarisation. Ollama does NOT use the model's full
  // advertised context by default — it applies its own small default (4096)
  // and silently TRUNCATES anything longer, so a long session would be
  // summarised from only its tail. Transcripts longer than this are split
  // and summarised in slices (see pipeline/summarize-client.js), so this
  // doesn't cap session length; it only trades VRAM for fewer slices.
  // Raise it if your GPU has headroom beyond the model weights.
  // Sanitised rather than raw parseInt: a typo'd or absurdly small value
  // would otherwise propagate NaN into the chunk-size maths and collapse the
  // whole transcript back into one oversized (silently truncated) request.
  //
  // 9216 is the measured ceiling for a 12GB RTX 3080 Ti running qwen2.5:14b
  // Q4_K_M: at 9216 the model + KV cache occupy 9996 MiB and stay entirely on
  // the GPU; at 10240 Ollama spills to CPU and the same request went from
  // ~4s to ~176s. If summaries suddenly get drastically slower, the desktop
  // is probably using more VRAM than usual — drop this to 8192.
  ollamaNumCtx: (() => {
    const n = parseInt(optional('OLLAMA_NUM_CTX', '9216'), 10);
    return Number.isFinite(n) && n >= 2048 ? n : 9216;
  })(),

  // --- summarise-on-approval ---
  // With this on, finishing a session does NOT immediately hand the
  // transcript to Ollama; the job waits in 'awaiting_approval' and the owner
  // gets a DM with a button. Stops a summary firing on the PC mid-game.
  summaryRequireApproval: optional('SUMMARY_REQUIRE_APPROVAL', 'false') === 'true',
  // Discord user ID to DM for that approval (and for pipeline nudges).
  // Without it, approval still works via /pending, there's just no DM.
  ownerUserId: optional('OWNER_USER_ID', null),

  // Job queue / retry behavior for when the PC is off
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

  // Google Drive sync via rclone. Pi remains the source of truth for
  // /history and /export (fast, works offline) — this just pushes copies
  // out so your PC's Google Drive desktop app picks them up automatically.
  driveSyncEnabled: optional('DRIVE_SYNC_ENABLED', 'false') === 'true',
  driveSyncAudio: optional('DRIVE_SYNC_AUDIO', 'false') === 'true', // off by default: audio is large, opt in
  driveRemoteName: optional('DRIVE_REMOTE_NAME', 'gdrive'), // must match `rclone config` remote name
  driveRemotePath: optional('DRIVE_REMOTE_PATH', 'DnDSessions'),

  // Audio retention: auto-delete raw audio for successfully-completed
  // meetings after this many days, so the Pi's disk doesn't fill up over a
  // long campaign. 0 = keep forever. Only ever touches 'done' meetings —
  // anything still pending/failed/retrying is left alone.
  audioRetentionDays: parseInt(optional('AUDIO_RETENTION_DAYS', '14'), 10),
};
