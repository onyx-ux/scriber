# Overnight session summary — 2026-07-30/31

This covers the work done autonomously overnight per Matthew's request, while
he was asleep. Everything described below is committed and pushed to `main`
(the first push attempt was blocked by the permission system despite
Matthew's earlier go-ahead; a second attempt after committing this file
went through cleanly).

## Bugs found and fixed

These weren't introduced tonight — they were latent in the original scaffold
and only surfaced because tonight involved actually exercising the bot for
the first time.

### 1. Bot crashed on/around `/join`, making `/leave` say "not currently recording"

This is what Matthew reported ("its not leaving" / "when i /leave its
advising that its not currently recording"). Root cause, found in the
container logs: `@discordjs/voice` threw an `AbortError` from an internal
timeout during the voice connection lifecycle, emitted as an `'error'` event
on the Discord `Client`. Node throws an unhandled exception when an
`EventEmitter` emits `'error'` with no listener attached — and `src/index.js`
had no `client.on('error', ...)` handler at all. That crashed the whole
process. Docker's `restart: unless-stopped` policy silently restarted the
container, which wiped the in-memory `activeSessions` map, so the *next*
`/leave` call (on the new process) correctly said "not currently recording" —
it genuinely had no memory of the session. The bot itself was likely still
sitting in the voice channel as an orphaned connection, since nothing ever
told Discord to gracefully drop it.

**Fix** (`src/index.js`, `src/voice/capture.js`): added `client.on('error', ...)`
and `connection.on('error', ...)` handlers that log instead of crashing.

### 2. whisper-cli was missing its own shared libraries — every transcription would have failed

Found while testing the audio pipeline directly. `whisper-cli` inside the
container errored with `libwhisper.so.1: cannot open shared object file`.
The Dockerfile's build stage copied `.so` files from `build/src/*.so*` and
`build/ggml/src/*.so*`, but the whisper.cpp version this pulls (`ggerganov/whisper.cpp`,
latest as of tonight) actually puts all its shared libraries directly in
`build/bin/` alongside the binary. The glob paths were simply wrong for this
version, so `libwhisper.so.1`, `libggml.so.0`, `libggml-base.so.0`, and
`libggml-cpu.so.0` never made it into the runtime image at all. **No session
had ever completed a real transcription before tonight** — the previous
crash (bug #1) meant every attempted session ended before reaching the
transcription step, which is why this had never surfaced.

**Fix** (`pi-service/Dockerfile`): the build stage now collects `*.so*` files
with `find build -name '*.so*'` instead of guessing a fixed path, and the
runtime stage sets `LD_LIBRARY_PATH=/app/whisper.cpp/build/lib` explicitly
rather than relying on the binary's RPATH.

**Verified**: ran a synthetic 440Hz tone through the exact same
resample-then-transcribe path the bot uses in production (ffmpeg 48kHz
stereo → 16kHz mono, then `whisper-cli`) and got back a valid transcription
result. Full pipeline confirmed working end to end, minus real human speech.

### 3. Campaign ledger dedup never actually matched anything

Found during a second review pass after the main task list was done.
`campaign/ledger.js`'s `appendUnique()` is supposed to stop the same NPC
being appended to `NPCs.md` (and similarly for `Locations.md`,
`Party-Decisions.md`, `Unresolved-Threads.md`) every time they're mentioned
across multiple sessions — the code comment says exactly this. But every
line already written to those files carries a trailing
`_(session #N, date)_` annotation, and the dedup check compared a freshly
incoming item (e.g. `"Gorak the Blacksmith"`) against those *already
annotated* lines (`"gorak the blacksmith _(session #3, 2026-07-15)_"`)
without stripping the annotation first — so the set lookup could never
match, and every re-mention of an existing NPC/location/decision/thread was
silently added again as a "new" entry. Confirmed by reproducing it directly
(`existingLower.has(...)` returned `false` for an item that should have been
recognized as already present), then fixed by stripping the trailing
`_(...)_ ` annotation before the comparison, and reconfirmed the fix with
the same reproduction (now returns `true` for a genuine repeat, `true` for
"still lets a genuinely new item through" too).

One caveat this fix doesn't and can't solve: the AI writes each NPC/location
entry as "name + a one-line description" combined into a single string, and
if the model phrases that description even slightly differently between two
sessions, the two strings still won't match exactly. That's inherent to
matching free-text LLM output, not a mechanical bug — fixing it properly
would need fuzzy/semantic matching, which felt like overkill for a home
campaign's ledger. Worth knowing if you notice near-duplicate NPC entries
that differ only in wording.

## Additions

- **Bot personality** (`pi-service/src/flavor.js`, new file): ~20
  D&D/scribe-themed, randomly-cycled variants for every message the bot
  sends — `/join`, `/leave` (all its states: starting, nothing usable,
  summarizing now, summary queued), `/history`, `/summarize`, `/export`,
  `/setcharacter`, `/status`, `/recap`, the automatic post-session Discord
  message, and the generic error handler. All ~380 lines were verified
  programmatically (every variant, in every category, checked for leftover
  unsubstituted `{placeholders}` — zero found).
- **Self-mute on join** (`voice/capture.js`): `joinVoiceChannel` now passes
  `selfMute: true`. The bot only ever listens; it was previously joining
  unmuted for no reason.
- **Better audio quality** (`voice/capture.js`): replaced the old "average
  both channels, keep every 3rd sample" downsampler (no anti-aliasing, and
  already flagged in the old code's own comments as "the first thing to try"
  if transcription accuracy seemed off) with a real ffmpeg resample
  (48kHz stereo → 16kHz mono via `libswresample`). This also let me delete
  the hand-rolled WAV-header-write-then-patch code entirely — ffmpeg just
  writes a correct WAV directly. Added `ffmpeg` to the Dockerfile's apt
  install alongside `rclone`.
- **Per-user recording**: already implemented — not new tonight, just
  verified. Discord's voice receiver already hands back one Opus stream per
  speaking user (`receiver.subscribe(userId, ...)`), and each utterance is
  written under `audioDir/<userId>/`. No diarization needed; Discord does it
  for free. Nothing to change here, confirmed it's solid.
- **Transcript auto-upload** (`commands/index.js`): `/leave` now attaches
  the raw transcript `.txt` immediately after transcription finishes,
  instead of only being available later via manual `/export`. This matters
  because the AI summary step can be delayed indefinitely if the PC/Ollama
  is off — the transcript itself doesn't need to wait on that.
- **PC-side sync to your Cipher vault** (`pc-sync/`, new directory): a small
  Docker Compose service that runs on your PC (not the Pi), using `rclone`
  over SFTP (reusing the SSH key already set up for Pi access) to **move**
  completed sessions' Obsidian markdown from the Pi's `obsidian-export`
  folder into `C:\Users\Matthew\Desktop\D&D\New Game\Cipher`, on a 5-minute
  loop. "Move" (not copy) is safe here because Google Drive already has its
  own permanent copy of the same file by the time this runs (that upload
  happens earlier in `queue-worker.js`), so deleting the Pi's local copy
  after a successful transfer doesn't lose anything.
  - Verified end-to-end with a real test file: dropped a `.md` on the Pi,
    confirmed it appeared in the actual Cipher folder and was removed from
    the Pi side, then cleaned up the test artifact.
  - Requires Docker Desktop running on your PC to actually sync — if it's
    off, files just queue up on the Pi until the PC/Docker come back, same
    pattern as the existing Ollama-availability handling elsewhere in this
    project.
  - **Assumption flagged**: I don't know of any existing Syncthing/Obsidian
    Sync pointed at the Pi's `obsidian-export` folder. If you set one up
    later, don't point it at the same folder this service drains — pick one
    mechanism, not both, or they'll race.

## Design decisions worth knowing about

- The Cipher-folder sync intentionally does **not** try to sync the instant
  a session ends — your PC isn't always on, so it's a periodic pull instead.
  This matches how the rest of the project already treats "PC might be off"
  (the summarize retry queue works the same way).
- I did not fabricate a fake test session (fake meeting + fake AI summary)
  to test the full `/leave` → summarize → post-to-Discord path, even though
  Ollama was reachable and I could have. That would have posted a synthetic
  "session recap" into your real Discord channel, visible to anyone else in
  the server, and I'd rather not do that without asking. Everything up to
  that point (capture → resample → transcribe) is verified for real; the
  summarize → Discord-post → Drive-sync → Cipher-sync chain is verified by
  code review plus each piece's own component (Ollama reachability check
  succeeded, Drive upload code unchanged from before, Cipher sync tested
  directly) but not as one continuous real run.

## Not done / needs you

- **A real `/join` test with actual speech** hasn't happened. Tonight's
  testing was all synthetic (tones, direct pipeline calls) specifically to
  avoid posting fake content into your real Discord server. The one thing
  only you can do is actually talk in a voice channel and run the full
  `/join` → talk → `/leave` cycle for real.
- Two command error paths I deliberately left plain rather than giving them
  full flavor-text treatment: "no such meeting" in `/summarize` and
  `/export`. These are rare admin/typo paths (wrong meeting ID), not core
  to the D&D theming — happy to add flavor there too if you want full
  coverage.
- The rclone shared Google Drive client ID warning from earlier tonight
  (rclone's built-in client is being retired sometime in 2026) is still
  unaddressed — separate from anything above, carried over from before this
  session.
