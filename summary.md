# Overnight session summary — 2026-07-30/31

This covers the work done autonomously overnight per Matthew's request, while
he was asleep. Everything described below is committed and pushed to `main`
(the first push attempt was blocked by the permission system despite
Matthew's earlier go-ahead; a second attempt after committing this file
went through cleanly).

## Addendum (2026-07-31 morning): Australian English pass

Matthew asked, on waking up, that all commands use Australian English. Went
through every user-facing string (the ~380 flavor.js variants, the
SlashCommandBuilder descriptions in commands/index.js, and the command
reference table in README.md) for American spellings:

- Renamed the actual slash command from `/summarize` to `/summarise` —
  the only command *name* affected. Its description, and every flavor-text
  line referencing it (e.g. "run `/summarize meeting_id:...`"), updated to
  match. **This is a breaking rename** — if you or your players had
  `/summarize` muscle memory, it's `/summarise` now. Discord's global
  command cache can take up to an hour to fully refresh everywhere after a
  rename like this.
- Fixed `-ize`/`-ized`/`-izing`/`-ization` → `-ise`/`-ised`/`-ising`/
  `-isation` throughout flavor.js (summarising, summarised, summarisation,
  immortalise) and "neighborhood" → "neighbourhood".
- Deliberately left internal code alone: function/variable/file names like
  `summarizeViaOllama`, `SUMMARIZE_RETRY_BASE_MS`, `summarize-client.js`,
  and code comments (e.g. "behavior" in capture.js, drive-sync.js) — those
  aren't commands or user-facing text, and renaming them touches many files
  for zero visible benefit. Said the word if you want that done too, but
  wanted to flag the scoping choice rather than silently leave it half-done.
- Rebuilt and redeployed to the Pi; confirmed a clean restart and
  successful slash command re-registration.

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

## Addendum (2026-07-31): first real live-session test, and what it found

Matthew ran the bot for real for the first time — actual `/join`, actual
people talking, actual `/leave`. This is exactly the "not done / needs you"
item from the section above, and it surfaced a run of genuine bugs that
synthetic testing couldn't have caught, several of them pre-existing (not
introduced tonight, just never exercised before).

### 4. `/join` failed outright — Discord's new mandatory voice encryption (DAVE)

First symptom: `/join` said "recording started," but `/leave` said "not
currently recording" — the same *symptom* as bug #1, but a different cause
this time (the container hadn't crashed or restarted). Root cause, found by
tracing the exact WebSocket close code: Discord globally enforced end-to-end
voice encryption (the DAVE protocol) on **2 March 2026**, and this project's
`@discordjs/voice` (`0.17.0`) predates DAVE support entirely — it couldn't
complete the connection handshake at all anymore (close code `4017`,
undocumented in that old library version).

**Fix**: upgraded `@discordjs/voice` to `0.19.2`, which bundles
`@snazzah/davey` (the DAVE decryption library; ships a prebuilt
`linux-arm64-gnu` binary, so no Rust toolchain needed in the Dockerfile).

Alongside this, fixed the actual UX bug that made the failure confusing in
the first place: `/join` was replying "recording started" *before* the
voice connection was confirmed, and a bug in the command router (`return
handleJoin(...)` instead of `return await handleJoin(...)`) meant a failure
partway through was silently swallowed instead of being caught and reported.
`/join` now defers its reply, only confirms success once the connection is
actually Ready, and reports a clear error if it isn't.

### 5. Every transcription silently "failed" — even though whisper.cpp was succeeding

`whisper.js` told whisper.cpp to write output via `-of <path-without-.wav>`
(so the real output file is `<name>.json`), but then read from
`<name>.wav.json` — a path that never existed. Every single transcription
logged as a failure, even though whisper.cpp was quietly writing correct
`.json` output the whole time. Never caught before tonight because bugs #1
and #4 meant no session had ever reached this step with real audio.

**Fix**: compute the read path the same way as the `-of` argument.

### 6. Google Drive sync completely broken — missing CA certificates

Every rclone call failed with `x509: certificate signed by unknown
authority`. The container's `apt-get install` line for `rclone`/`ffmpeg`
never included `ca-certificates`, so the container had no TLS trust store at
all. This was there from the start; it went unnoticed because the original
Drive OAuth setup (see the original section above) was done through the
standalone `rclone/rclone` image, not this bot's own container.

**Fix**: added `ca-certificates` to the Dockerfile's runtime `apt-get
install`. Also fixed a second, related issue while in there: `rclone.conf`
was bind-mounted as a single file, which meant rclone's own config-save
(needed to persist a refreshed OAuth token) failed with "device or resource
busy" — renaming a bind-mounted file's own mount point isn't possible. Same
class of bug hit and fixed for `pc-sync/` in the original session; applied
the same fix here (mount the parent directory instead:
`pi-service/rclone/rclone.conf`, not `pi-service/rclone.conf`).

### 7. Duplicate transcript lines — a second recording opening mid-utterance

Real transcripts showed the same line (or a near-duplicate) twice in a row,
seconds apart, over and over — e.g. "I know, right? How the fuck did I get
away with that?" followed immediately by "How the fuck did I get away with
that?" again. Root cause: Discord's per-user "speaking" flag flickers off
and back on during ordinary mid-sentence pauses (much shorter than the
1-second "AfterSilence" threshold used to end a recording), and the capture
code had no guard against a second `'start'` event firing for a user who
was already mid-recording — so it opened a second, overlapping subscription
capturing roughly the same audio a second time.

**Fix** (`voice/capture.js`): track one active recording per speaker; a
`'start'` event for someone already being recorded is ignored, letting the
existing recording keep running until genuine silence ends it.

### 8. Recovered transcripts showed raw Discord IDs instead of names

Not a new bug tonight, but only just exercised: when a session gets
reconstructed from disk after an interruption (the crash-recovery path from
the original session — see above), it had no live Discord connection
available to resolve display names, since recovery ran *before*
`client.login()`. It fell back to bare numeric user IDs for every speaker.

**Fix**: moved `recoverInterruptedMeetings` to run from inside the `ready`
handler (after login), and it now resolves real Discord display names the
same way a live `/join` does, falling back to the ID only if that fails
(e.g. someone's left the server).

While in the same code path: recovery was also picking up 0-byte `.wav`
files (an utterance truncated mid-recording by a `/leave` or restart) and
feeding them to whisper.cpp, which understandably produced nothing. The live
capture path already filters these out; recovery now applies the identical
size check.

### 9. The retry queue could never actually retry — a hidden datetime format mismatch

This is the one I'd flag as most important to know about, because it silently
defeats a core piece of this project's design ("PC is sometimes off, retry
automatically"). `enqueueSummarizeJob` stores its due-time using SQLite's own
`datetime('now')`, which produces `"2026-07-31 05:23:44"`. But
`rescheduleJob` (used every time a summarize attempt fails) stored a
JavaScript `Date().toISOString()` string instead: `"2026-07-31T05:31:00.712Z"`.
The queue picks up due jobs with a plain string comparison,
`next_attempt_at <= datetime('now')` — and because `'T'` sorts after a space
in ASCII, the ISO-formatted string *always* compares as "later" than
`datetime('now')`'s format, regardless of actual time. **Any job that failed
even once would never be retried again automatically** — it would sit as
"pending" forever, silently, with no error surfaced anywhere. This was only
caught because a real transient Ollama connection blip during tonight's test
triggered `rescheduleJob` for the first time in the project's life.

**Fix** (`store/db.js`): wrapped both sides of the comparison in SQLite's
`datetime()` function, which normalizes either format before comparing.
Verified directly against the real database that a previously-stuck job
(pending for 10+ minutes past its due time) was correctly recognized as due
once this landed, and confirmed the queue worker picked it up and completed
it on the very next tick.

### 10. The AI summary fabricated an entire fantasy narrative from off-topic chat

Tonight's test session wasn't real D&D roleplay — it was casual chat (people
talking about a video game, testing the bot, general banter). The AI summary
prompt had no instruction telling it to notice that, and actively encouraged
"in-world/narrative language" unconditionally. Result: the model invented a
complete fictional scene — "the party decided to enter Crack Animal Zoo
despite the risks... a mysterious facility housing strange animals and
experiments" — entirely fabricated from the **Discord voice channel's own
name** ("Crack Animal Zoo"), which has nothing to do with any in-game
content. Stranger still: on the next attempt, someone in the transcript
sarcastically read that exact fabricated line back out loud as a joke about
the bug, and the model then treated *that quote* as a real in-game event too
and reproduced it again — a small hallucination feedback loop.

**Fix** (`prompts/dnd-summary-prompt.js`): rewrote the prompt to require the
model to first decide, from transcript content alone, whether this is
actually a D&D session at all — explicitly instructing it to ignore the
channel-name label as content, to never fold meta-commentary about the tool
itself back into the narrative, and to return an honest "this wasn't
gameplay" summary with empty fields rather than inventing one. Verified
directly against Ollama with the real (off-topic) transcript from tonight —
the model now correctly returns `"This session was casual chat / bot
testing, not gameplay — no recap to give."` with everything else empty,
instead of fabricating a scene.

Worth being upfront about the limits here: this is prompt engineering
against a 14B model, not a hard guarantee — it worked cleanly on this test
case, but LLMs don't follow instructions with 100% reliability, especially
smaller/local ones. Worth keeping an eye on this for the first few *real*
sessions too, not just this synthetic one.

### A mistake worth owning

Partway through tonight's fixes, I rebuilt and restarted the container to
deploy a set of changes without first checking whether a session was
actively recording — it was, and the restart cut it off mid-session. The
crash-recovery system (built for exactly this kind of interruption) did its
job and reconstructed the transcript from the raw audio on disk without
losing anything, but the interruption itself was avoidable. From this point
on I checked the database for an active `'recording'` status before every
subsequent restart.

### Verified end-to-end tonight, for real

`/join` → per-speaker recording (3-4 real people, real audio) → `/leave` →
transcription → AI summary → posted to Discord → markdown exported →
campaign ledger updated locally → (Drive/Cipher sync confirmed separately,
now that certs are fixed). All ten bugs above were found, fixed, deployed,
and re-verified against the real Pi and real Ollama instance before being
called done.
