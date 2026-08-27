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

// `0:5,2:40` -> { 0: 5, 2: 40 }. Anything that is not a pair of whole numbers
// is dropped rather than guessed at: a malformed entry that became tier 0 or
// limit 0 would silently be the most permissive possible reading of a typo.
function tierMap(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(',')) {
    if (!part.trim()) continue;
    const [tier, limit] = part.split(':').map((x) => parseInt(String(x).trim(), 10));
    if (Number.isInteger(tier) && tier >= 0 && Number.isInteger(limit) && limit >= 0) {
      out[tier] = limit;
    } else {
      console.warn(`[config] TIER_ASK_LIMITS: ignoring "${part.trim()}" — expected tier:limit`);
    }
  }
  return out;
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

  // The other half of the application's credentials, from the same page of the
  // Discord developer portal — OAuth2 → Client Secret.
  //
  // Optional, because the BOT does not need it: a bot token is what logs the
  // gateway in, and everything this thing does in Discord goes through that.
  // This is only spent signing people in to the dashboard, so an install that
  // never opens the dashboard to anybody but its operator can leave it unset
  // and simply not offer sign-in. See web/discord-oauth.js.
  discordClientSecret: optional('DISCORD_CLIENT_SECRET', null),

  // Where Discord sends somebody back to after they have been asked.
  //
  // Must match a redirect registered in the developer portal EXACTLY — scheme,
  // host, port and path — so it is stated rather than sniffed from the request:
  // a Host header is whatever the client said it was, and building a redirect
  // out of one is how open redirects happen.
  //
  // Unset, it is derived from DASHBOARD_URL as <origin>/api/auth/callback,
  // which is where the dashboard's nginx already proxies this API. Set it for
  // anything that is not that layout.
  discordRedirectUri: optional('DISCORD_REDIRECT_URI', null),

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

  // --- which model does which job ---
  //
  // Writing up three hours of transcript deserves the best model available.
  // Answering "who was the notary again" is a lookup over recaps that have
  // already been written, and does not.
  //
  // Measured against a live key on 2026-08-18: a seven-token prompt costs 109
  // total tokens on gemini-3.6-flash and 8 on gemini-3.1-flash-lite, because
  // the flash models emit thinking tokens whether the question needs any or
  // not. Thirteen times the spend, for a lookup — which is why /ask has its own
  // model rather than borrowing the summariser's.
  //
  // The fallbacks are walked ONLY when the provider says it is out of quota,
  // never on an ordinary failure: a refusal or a timeout is the request's
  // fault and would fail again, one model cheaper. Probed on the same date;
  // gemini-3.7-flash is deliberately absent because it was answering 503
  // ("high demand"), and gemini-3.1-flash does not exist — only the lite.
  geminiModelFallbacks: optional('GEMINI_MODEL_FALLBACKS', 'gemini-3.5-flash,gemini-3.1-flash-lite'),
  geminiAskModel: optional('GEMINI_ASK_MODEL', 'gemini-3.1-flash-lite'),
  anthropicModelFallbacks: optional('ANTHROPIC_MODEL_FALLBACKS', 'claude-sonnet-5'),
  anthropicAskModel: optional('ANTHROPIC_ASK_MODEL', 'claude-haiku-4-5'),

  // What one person may spend of yours in a day.
  //
  // /campaign ask is the only place in the bot where somebody who is not the
  // owner can spend the owner's API budget, and it had no ceiling at all.
  // Twenty is far above what a curious table uses in an evening and far below
  // what a bored one could run up. 0 removes the limit.
  askDailyLimit: parseInt(optional('ASK_DAILY_LIMIT', '20'), 10),

  // Which tier somebody is on before anybody has said otherwise. 0 is free,
  // and free is the right thing to be on when nobody has thought about you.
  defaultTier: parseInt(optional('DEFAULT_TIER', '0'), 10),

  // What each tier buys, as a daily /ask allowance keyed by tier:
  //
  //   TIER_ASK_LIMITS=0:5,1:20,2:60,3:200,4:0
  //
  // Keyed rather than positional because the tiers have a deliberate hole in
  // them (0, 1-4, 9) and a list would re-point itself the day something filled
  // it. 0 is unlimited. Unset means every tier gets ASK_DAILY_LIMIT, so tiers
  // change nothing until this is written -- the only honest default for a
  // setting whose numbers only the operator can know. See access/tiers.js for
  // how a tier nobody wrote a number for is answered.
  tierAskLimits: tierMap(optional('TIER_ASK_LIMITS', '')),

  // A daily token ceiling, for the dashboard's gauge only — nothing refuses a
  // call because of it. Neither provider reports how much allowance is left
  // (Anthropic sends a header, Google sends nothing), so a bar needs a number
  // to be a fraction of, and only the operator knows what theirs is. 0 shows
  // the count without a ceiling.
  modelDailyTokenBudget: parseInt(optional('MODEL_DAILY_TOKEN_BUDGET', '0'), 10),

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

  // The key session cookies are hashed with.
  //
  // Defaults to STATUS_TOKEN, because an install that has one already has a
  // secret the operator chose and keeps out of git — and adding a second thing
  // to configure is how people end up running with whatever the default was.
  // Set this only to keep the two separate.
  //
  // A bot with neither cannot sign anybody in and says so. There is
  // deliberately no fallback constant: a hardcoded key here would mean every
  // Quill install in the world could mint sessions for every other one.
  authSecret: optional('AUTH_SECRET', null),

  // Whether the dashboard demands a Discord sign-in before showing anything.
  //
  // Off by default, and that default is load-bearing rather than lazy: with it
  // off, reaching the dashboard means what it has always meant — you are the
  // operator, on your own LAN, behind nginx. With it on, the shared token stops
  // being an identity and everybody is only what their own Discord account
  // entitles them to be (see web/viewer.js).
  //
  // Turn it on AFTER signing in successfully once. Turning it on first is how
  // you lock yourself out of your own Pi.
  dashboardRequireLogin: optional('DASHBOARD_REQUIRE_LOGIN', 'false') === 'true',

  // Who may sign in at all — Discord user ids, comma separated.
  //
  // Empty by default, which means anybody Discord vouches for may hold a
  // session. That is far less open than it sounds: signing in grants nothing
  // on its own, and what somebody can see is still derived entirely from what
  // their account owns, runs and plays in, so an account with no claim on this
  // bot signs in and is shown nothing at all. See web/viewer.js.
  //
  // Set it when you want a shorter answer than "nothing at all" — while the
  // dashboard is newly reachable from outside the house, say, or before the
  // table has been invited. It is the ONE place in this bot where access is a
  // hand-written list rather than a fact checked against Discord, which is why
  // it is opt-in and deliberately small: a list is a thing that goes stale,
  // and everything else here cannot.
  dashboardAllowedUsers: optional('DASHBOARD_ALLOWED_USERS', null),

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

  // Whether a finished session also updates the vault's per-entity notes —
  // one page per NPC, place and player character, read from the transcript.
  //
  // OFF by default, and deliberately so. It is three extra model calls after
  // every session, on top of the summary, and it reads the whole transcript
  // rather than the recap — which is the most expensive thing this bot can be
  // asked to do. Turning that on is the owner's decision about their own API
  // budget, exactly as transcription scheduling is a decision about their GPU.
  //
  // With it off, the notes are built by hand:
  //   node scripts/build-npc-notes.mjs <campaign> --write
  //
  // The cost is bounded either way: the extraction is cached per session, so
  // this reads ONE transcript per subject after a session however many
  // sessions the campaign already has.
  entityNotesAfterSession: optional('ENTITY_NOTES_AFTER_SESSION', 'false') === 'true',

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

  // Anybody else who runs this install, comma separated. Empty is the normal
  // case and means one operator.
  //
  // These accounts get the `dev` level, tier 9 and a permanent place on the
  // guest list -- the machinery, unmetered. They do NOT get the owner's DMs or
  // adopt orphaned campaigns; see access/operators.js, which is the only place
  // that answers "who runs this".
  //
  // Here rather than on the gatehouse on purpose: handing somebody your GPU
  // and your API bill should cost an SSH session and a restart, and it should
  // survive whatever happens to the database.
  operatorUserIds: optional('OPERATOR_USER_IDS', null),

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
