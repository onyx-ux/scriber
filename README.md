# D&D Session Scribe — Pi + PC split architecture

A self-hosted Discord bot for recording D&D sessions, purpose-built to be
lighter than a faster-whisper/full-web-dashboard stack, and split across two
machines on your home network:

- **Raspberry Pi** (always-on): joins voice, captures per-speaker audio,
  transcribes locally with **whisper.cpp** (no Python, no CUDA deps, ARM-fast),
  stores history in SQLite, exports Markdown for Obsidian, posts to Discord.
- **Desktop PC** (only on sometimes): runs a **whisper.cpp GPU server**, which
  transcribes ~400x faster than the Pi's CPU. The Pi uses it when it's up and
  falls back to its own CPU when it isn't. Audio never leaves your LAN.

The AI summary is written by a cloud model (Gemini by default, Claude
optionally) from the finished transcript TEXT. The recordings themselves never
leave your network under any setting.

A local summariser (Ollama on the PC) used to fill that role and was removed:
on a 12GB card a 14B model took ~7.5 minutes per transcript slice — about an
hour for a session Gemini summarises in under a minute — and the results were
not as good. The trade-off is that summarising now needs the internet; when
it's unavailable, jobs queue and retry exactly as they did when the PC was off.

No Tailscale/VPN needed — this design assumes Pi and PC are on the same LAN.
If that ever changes, Tailscale would be the right add-on; you'd point
`WHISPER_SERVER_URL` at a Tailscale IP instead of a LAN IP.

## Status of this scaffold

This is a **working starting skeleton**, not a finished, battle-tested bot.
The pieces that are fully written and should work as-is:
- Job queue + retry logic (pure logic, unit-testable, no external deps to fail)
- Markdown/Obsidian export formatting
- D&D-themed summary prompt
- SQLite schema

The pieces that **will need iteration on real hardware** (I can't run a live
Discord voice connection or compile ARM binaries from here):
- Discord voice capture (`src/voice/capture.js`) — logic is modeled directly
  on the same `@discordjs/voice` receiver pattern Parley uses, but needs
  testing against a real voice channel
- whisper.cpp build step in the Pi Dockerfile — cross-compiling for
  `arm64` inside Docker buildx sometimes needs machine-specific flags
- End-to-end command wiring (`src/commands/`) — the four core commands are
  stubbed with real logic but not exhaustively tested against Discord's API

## Network setup (do this first)

1. Give your PC a static local IP via a DHCP reservation in your router admin
   page (search "[your router model] DHCP reservation" if unfamiliar) — e.g.
   `192.168.1.50`.
2. On the PC, start the whisper GPU server — see `pc-whisper/README.md`.
3. Windows Firewall: allow inbound TCP 8089 on your **Private** network
   profile only (not Public) — Windows will usually prompt for this the first
   time the Pi connects.
4. On the Pi, set `WHISPER_SERVER_URL=http://192.168.1.50:8089` in `.env`, and
   put a `GEMINI_API_KEY` in there too (https://aistudio.google.com/apikey).

## Folder layout

```
pi-service/          # everything that runs on the Raspberry Pi
  src/
    config/env.js         # env var loading + validation
    voice/capture.js      # per-speaker PCM capture from Discord voice
    stt/whisper.js         # spawns whisper.cpp, parses output
    store/db.js            # SQLite: meetings, utterances, job queue
    pipeline/
      transcribe.js         # orchestrates capture -> whisper.cpp -> text
      summarize-client.js    # slice/reduce a transcript into a summary
      queue-worker.js         # background job processor (handles PC-off case)
    export/markdown.js      # Obsidian-formatted .md export
    delivery/discord-post.js  # posts to channel (no thread) + attaches files
    prompts/dnd-summary-prompt.js
    commands/                 # /join /leave /history /summarise /export /search /funny
  Dockerfile
  docker-compose.yml
  .env.example
```

There is no `pc-service/` folder — the PC side is just the whisper GPU
server (`pc-whisper/`), no
custom code needed there. See "Network setup" above.

## Google Drive sync (optional, off by default)

Design: the **Pi stays the source of truth** — `/history` and `/export`
never depend on the internet or on Drive being reachable. Drive sync is a
one-way, best-effort push of finished markdown (and optionally audio) so
your PC picks it up automatically via the normal Google Drive desktop app —
no custom code needed on the PC side at all.

**One-time setup — the tricky part is that the Pi has no browser for
Google's OAuth login, so you authorize on your PC and copy the resulting
config over:**

1. Install rclone on your **PC** (not the Pi): https://rclone.org/downloads/
2. Run `rclone config` on the PC:
   - `n` for new remote, name it exactly `gdrive` (must match `DRIVE_REMOTE_NAME`)
   - choose `drive` (Google Drive) as the storage type
   - leave client_id/client_secret blank (use rclone's defaults) unless you
     want your own Google API project
   - scope: `drive` (full access) or `drive.file` (rclone can only see
     files it creates — more private, recommended)
   - when it asks to auto-open a browser, say yes — this is the step that
     needs a real browser, which is why we're doing this on the PC
   - decline "team drive" (unless you actually use Workspace Shared Drives)
3. This creates a config file on the PC, typically at
   `%APPDATA%\rclone\rclone.conf` (Windows) — open it and copy the whole
   `[gdrive]` section.
4. On the **Pi**, create `pi-service/rclone/rclone.conf` with just that
   section pasted in (it's mounted as a directory, not a single file, so
   rclone can rewrite it in place when it refreshes the OAuth token).
5. In `.env` on the Pi, set `DRIVE_SYNC_ENABLED=true` (and
   `DRIVE_SYNC_AUDIO=true` if you also want a copy of each session's audio
   uploaded — off by default, since even compressed it's tens of MB per
   session).
6. Restart: `docker compose up -d --build`

**On the PC:** install Google Drive for Desktop, and either point it at the
same `DnDSessions` folder to sync locally, or use Drive's "Stream" mode and
just browse to it — either way, no bot-side code involved, it's just
Google's own sync client doing its job.

**What gets uploaded where** (all under `DnDSessions/` in your Drive):
- `notes/` — finished markdown (after summary, so it's the complete version)
- `audio/<meeting_id>/` — only if `DRIVE_SYNC_AUDIO=true`. **One** ~64kbps
  mono MP3 for the whole session, not the raw per-utterance fragments —
  Discord gives one short audio clip per speaking turn per person (hundreds
  per session), which transcription needs but nobody wants to back up or
  listen back to individually. The MP3 is reconstructed from those same
  clips, each placed at its real point in the session, so it plays back like
  the session actually happened (silences included) rather than every line
  squashed end-to-end. This upload is independent of `AUDIO_RETENTION_DAYS`
  — the raw fragments still get deleted locally on that schedule either way;
  the Drive copy is what survives long-term if you want one.
- `db-backups/` — periodic consistent SQLite snapshots (never the live
  actively-written database file, to avoid uploading a corrupted mid-write
  copy)

## Publish to GitHub + pull prebuilt images on both machines

This uses **GitHub Container Registry (GHCR)** — GitHub Actions builds both
`linux/amd64` (your PC) and `linux/arm64` (the Pi) on every push, so neither
machine ever compiles whisper.cpp itself; they just `docker pull` a
ready-made image.

**1. Create the GitHub repo** — go to github.com, "New repository." Private
is fine (and recommended, since even though secrets are gitignored, no
reason to make the setup public unless you want to).

**2. Push this project to it:**
```powershell
cd dnd-bot
git init
git add .
git commit -m "Initial scaffold"
git branch -M master
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin master
```

**3. Update the image name** in `pi-service/docker-compose.yml` — replace
`YOUR_GITHUB_USERNAME/YOUR_REPO_NAME` with your actual values, commit, push
again:
```powershell
git add pi-service/docker-compose.yml
git commit -m "Set image name"
git push
```

**4. Watch it build** — on GitHub, go to your repo's **Actions** tab. The
"Build and publish Docker image" workflow runs automatically on push.
Multi-arch builds are slower than native ones (the arm64 build runs under
QEMU emulation on GitHub's amd64 runners) — expect 10-20 minutes, mostly
spent compiling whisper.cpp for arm64. Only needs to happen once per code
change, not per machine.

**5. If the repo (and therefore the package) is private**, both the Pi and
PC need to authenticate to pull:
```bash
# on both the Pi and the PC
export CR_PAT=<a GitHub Personal Access Token with read:packages scope>
echo $CR_PAT | docker login ghcr.io -u <your-github-username> --password-stdin
```
Create the token at github.com → Settings → Developer settings → Personal
access tokens → generate one with just the `read:packages` scope. If you
made the repo public instead, this login step isn't needed.

**6. On the Pi and on your PC, day-to-day:**
```bash
cd dnd-bot/pi-service
docker compose pull
docker compose up -d
```
No `--build` needed anymore — that's the whole point. When you push a code
change, GitHub Actions rebuilds automatically; just re-run `docker compose
pull && docker compose up -d` on whichever machine(s) you're actually
running the bot on to pick up the new image.

*(Note: only the Pi is meant to actually run this bot day-to-day per the
architecture above — the PC's role is the whisper server, not this container. Being
able to `docker compose pull` it on the PC too is mainly useful for testing
changes locally before they reach the Pi, or if you ever want to run the
whole stack on one machine for debugging.)*

## Commands

- `/join` — start recording the voice channel you're in
- `/leave` — stop recording and queue the session for transcription (see [Scheduling transcription](#scheduling-transcription) — it does not seize the GPU on the spot)
- `/history [count]` — list recent sessions
- `/transcribe meeting_id:<id> [when:<now|later|pi>]` — control when a queued session transcribes: `now` runs it on the PC as soon as the whisper server answers, `later` pushes it back a day, `pi` transcribes it locally on the Pi instead (slower, no GPU needed). Same three actions as the DM buttons
- `/summarise meeting_id:<id> [provider:<gemini|anthropic>]` — force an immediate summarise retry. `provider:` picks who writes *this one* summary, overriding `SUMMARY_PROVIDER` without changing it
- `/export meeting_id:<id>` — get the raw transcript as a `.txt` file
- `/setcharacter name:<name>` — map your Discord account to your D&D character name; transcripts and notes use this instead of your Discord display name from then on
- `/funny` — pull a random funny/memorable moment from any completed session in this campaign's history (the AI summariser flags these, if any, as part of the normal per-session summary)
- `/search query:<text>` — search every transcript in the campaign for a word or phrase (an NPC name, an item, a place) and get back the matching lines with the session number, timestamp and speaker. Answers "when did we first meet that guy?" without re-reading old notes
- `/import [file:<attachment>] [url:<link>] [speaker:<label>]` — import a recording made outside Discord (an in-person game, a phone recording). Runs through the same transcribe → summarise → post pipeline. Use `url:` for anything over Discord's ~25MB attachment cap. **Every line is attributed to one label** (default "Table") — a single microphone has no per-speaker channels, so voices can't be told apart the way they can in a voice call
- `/correct wrong:<text> right:<text>` — fix a name whisper keeps mishearing. Rewrites every past transcript in the campaign **and** is saved, so future sessions are corrected automatically
- `/corrections` — list the saved corrections
- `/uncorrect wrong:<text>` — remove a saved correction (undoes `/correct`; past transcripts already rewritten stay as they are)
- `/ask question:<text>` — ask a question about the campaign ("who was the smuggler at the docks?") and get an answer drawn only from past session recaps and transcripts, with session numbers cited. Needs the configured summariser (Gemini or Claude) reachable
- `/status` — see what's currently queued/retrying, and whether the configured summariser is reachable right now
- `/pending` — everything currently in the pipeline: recording, transcribing, awaiting approval, or queued for summarising
- `/approve [meeting_id] [provider:<gemini|anthropic>]` — release a session parked awaiting approval (omit the ID to approve everything waiting; `provider:` works the same as on `/summarise`)
- `/pause` / `/resume` — stop and restart summarising without losing queued work
- `/recap` — re-post the last completed session's TL;DR (handy at the start of the next session)
- `/campaign [name] [campaign]` — name the campaign. That name becomes the Obsidian folder its session notes are filed in. **Works in a DM**, since naming a campaign is housekeeping the table doesn't need to watch; a DM has no server to infer the campaign from, so the `campaign:` option picks one (autocompleted by name, with session counts). Omit `name:` to see the current one
- `/whoami` — show what name you currently appear as in transcripts and notes
- `/stats` — campaign-wide totals: sessions, hours recorded, lines transcribed, and who talks the most
- `/npcs` / `/locations` — list everyone met / everywhere visited so far, straight from the campaign ledger, without opening Obsidian
- `/archive` — get the browsable campaign archive (the same self-contained HTML page that syncs to Drive after every session) as a one-off attachment

## Campaign vocabulary (whisper prompting)

Whisper's weak point on a D&D session isn't hearing — it's proper nouns.
"Kaelen", "Kaylen" and "Caelan" are all plausible English, and nothing in the
audio tells it which one this table means. So it guesses, differently each
time.

`WHISPER_PROMPT=true` (the default) fixes that at inference time: before
transcribing, the bot builds a short prompt from the campaign's own
vocabulary and hands it to whisper as decoding context. Sources, in priority
order:

1. **`/correct` targets** — words this campaign has already *proved* whisper
   mishears. Highest value, so they survive truncation first.
2. **Player character names** from `/setcharacter` — said every session.
3. **Ledger NPCs, then locations**, most recent first, since last week's
   villain is likelier to come up than session one's.

The prompt is guild-scoped, so two campaigns on one bot can't leak names into
each other, and it's capped at whisper's 224-token window — truncation happens
at whole-name boundaries, never mid-name.

This attacks the same problem `/correct` exists to clean up afterwards, so the
two compound: every correction you add makes future sessions less likely to
need it.

**The trade-off, and it's a real one.** On near-silent audio whisper will
sometimes transcribe the *prompt* instead of the sound. Reproduced against
this exact setup: five seconds of low noise returned `"."` unprompted, and
`"Kaelen Zyrthax, Thoras, Thoras, Thoras."` once the vocabulary was supplied.
Left alone that puts invented dialogue in the transcript and feeds it to the
summariser.

So a clip that comes back as *nothing but* campaign names — matched loosely,
since echoes mangle them — is dropped and logged. A single name on its own is
kept: "Kaelen!" is an ordinary thing to shout at a table, and losing real
speech is worse than the occasional fabrication. Set `WHISPER_PROMPT=false` to
turn the whole thing off without a redeploy.

## Silence hallucinations

Whisper doesn't return nothing for silence — it invents the same handful of
phrases, "Thank you.", "Thanks for watching!", "Bye.", learned from subtitle
data. Discord capture hands it a great many very short, very quiet clips, so
this lands hard.

Measured on a real 3117-clip session with `large-v3-turbo`: **478 utterances
of "Thank you." — 17% of the entire transcript**, none of it spoken, all of it
passed to the summariser as dialogue. The same audio on `medium.en` produced
62, so the multilingual turbo model is considerably worse at this. That's the
hidden cost of the accuracy it buys elsewhere.

`WHISPER_DROP_FILLER=true` (the default) removes them. The rule is
deliberately narrow: the text must match one of those phrases *exactly* as the
whole utterance, **and** whisper's own language confidence for the clip must
be below 0.95. On the sampled session, hallucinated clips scored at most 0.899
while three quarters of real speech scored 0.993 or better — so someone
genuinely saying "thank you" is kept, while noise rendered as "Thank you." is
not. A line that merely *contains* those words is never touched.

The server's own `suppress_nst` and `no_speech_thold` were measured across 120
clips and removed none of it; `no_speech_prob` reports ~1e-08 for these clips,
meaning whisper is confident the noise was speech. Hence filtering here rather
than at the server.

## Scheduling transcription

Transcription is the only part of the pipeline that reaches into another
machine's hardware — and that machine is usually also the one being played on.
A three-hour session is only minutes of GPU time, but it also parks ~2GB of
VRAM, which is enough to push a game into paging GPU memory over PCIe and tank
the frame rate.

So `/leave` records, queues, and stops. The session then transcribes when
either of these is true:

- **you approve it** — `TRANSCRIBE_REQUIRE_APPROVAL=true` (the default) DMs you
  when a recording is ready, with **Transcribe now**, **Remind me later**
  (default a day), and **Use the Pi instead**. "Now" runs whatever the hour, as
  soon as the whisper server answers.
- **it falls inside the automatic window** — `TRANSCRIBE_WINDOW_START_HOUR` to
  `TRANSCRIBE_WINDOW_END_HOUR` (default 08:00–16:00) on weekdays, when the PC
  is typically on but nobody is using it. Weekends are excluded by default
  (`TRANSCRIBE_WEEKDAYS_ONLY`); you still get the DM, and the button still
  works, so a Saturday session just waits for you rather than going quiet.

Every hour and weekday is read in `SCHEDULE_TIMEZONE`, **not** the container's
clock. The container runs in UTC, so leaving this unset would silently shift
the whole window.

**If the PC is off, the session waits — indefinitely, and on purpose.** It
never quietly falls back to the Pi: that would spend hours of Pi CPU to produce
a worse transcript, unasked. Use **Use the Pi instead** (or
`/transcribe when:pi`) when you actually want that. A snooze suppresses the
automatic window too, so "remind me tomorrow" genuinely means tomorrow. A
session interrupted by a crash or restart goes back through the same gate
rather than resuming pre-approved at whatever hour the bot came back up.

`/pending` lists everything waiting, and `/pause` holds the whole queue.

## Summarise on approval (optional)

Summarising is separate, and no longer touches the GPU at all — it sends the
finished transcript text to Gemini or Claude. The approval gate remains
because it's a paid API call on somebody else's servers, and because you may
want to look at a transcript before it leaves the network.

Set `SUMMARY_REQUIRE_APPROVAL=true` (plus `OWNER_USER_ID`) and the pipeline
stops one step short: the transcript is written, the job parks in
`awaiting_approval`, and you get a DM with a **Summarise now** button.
`/pending` shows everything waiting and `/approve` releases it if you'd rather
not use the button.

`/pause` goes further — it stops the queue entirely, so you can hold work back
outright. Queued sessions stay exactly where they are and resume on `/resume`.

## Browsable archive

Alongside the markdown, the bot writes `campaign-archive.html` into the export
folder after every session — a single self-contained page listing every
session with its recap, plus a campaign-wide NPC/location index, the funny
moments, and a live search box. No server and no open port on the Pi: it's
just a file, so it syncs to Drive with everything else and opens from a phone,
a laptop, or a USB stick. Full transcripts stay in the `.md` files beside it.

## Choosing the summariser

`SUMMARY_PROVIDER` decides which model writes the recap:

- `gemini` (default) — cheapest cloud option, with a free tier.
- `anthropic` — sends the finished **transcript text** to Claude for a
  noticeably better recap. Set `ANTHROPIC_API_KEY`; `ANTHROPIC_MODEL` defaults
  to `claude-opus-5`. Anthropic's API is paid-tier only (no free tier).
- `gemini` — sends the finished **transcript text** to Gemini. Set
  `GEMINI_API_KEY` (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey));
  `GEMINI_MODEL` defaults to `gemini-3.1-flash-lite`, Gemini's budget tier —
  pick this provider if the goal is a cloud recap at minimal cost rather than
  Claude's higher quality.

**Audio and transcription are always local.** Recordings never leave the
network under any setting — a cloud option only ever sees text that has
already been transcribed on the Pi. Long transcripts are still sliced and
merged automatically, so session length isn't capped either way.

### Picking a summariser per session

`SUMMARY_PROVIDER` is only the *default*. Once a session finishes
transcribing you can send that one summary somewhere else, without changing
the config:

- **The approval DM** (with `SUMMARY_REQUIRE_APPROVAL=true`) shows one button
  per configured provider — **Gemini**, **Claude** — plus
  **Not yet**. Whichever you press is what writes that session. The message
  lists which model sits behind each button, since a button label only has
  room for the provider name.
- **`/summarise meeting_id:<id> provider:<...>`** and
  **`/approve [meeting_id] provider:<...>`** do the same thing from a command.

Only providers that are actually set up appear — each needs its API key
present. Asking for one that isn't configured gets a clear refusal rather than
a silent fallback to something you didn't choose. With just one provider set
up, the button stays a plain **Summarise now** instead of a pointless
one-item picker.

The choice is stored on the job, so it survives a bot restart and is still
honoured when a queued session is retried later.

## Campaign ledger (Obsidian)

Alongside each session's own markdown file, the bot maintains **persistent,
cross-session files** per campaign (one folder per Discord channel):
`NPCs.md`, `Locations.md`, `Party-Decisions.md`, `Unresolved-Threads.md`.
Each session appends only genuinely new entries (deduped case-insensitively
against what's already there) tagged with which session introduced them —
so over a long campaign these become an actual running reference doc, not
just a pile of isolated session logs.

**Because you'll edit these directly in Obsidian** (fixing a typo, merging
two NPCs that turned out to be the same person, adding your own notes), the
bot pulls the current Drive version down before appending anything, then
pushes the merged result back up — so a session finishing while you're
mid-edit in Obsidian won't clobber your changes. This isn't full two-way
sync with conflict resolution, just "always start from the latest before
writing," which is enough for a home game's normal cadence (edits happen
days apart from sessions finishing, not simultaneously).

## Audio retention

`AUDIO_RETENTION_DAYS` (default 14) auto-deletes raw audio for
successfully-completed sessions after that many days, so the Pi's disk
doesn't fill up over a long campaign. Set to `0` to keep audio forever
(only do this if you also have plenty of SD card / external storage — audio
adds up fast over dozens of sessions). Only ever touches meetings that
finished successfully; anything still pending, failed, or being retried is
left alone regardless of age.

## Offloading recordings to the PC

The Pi's card is the tightest storage in the system, and a campaign's
recordings outgrow it long before anything else does. Set `AUDIO_OFFLOAD_DIR`
(default `/data/audio-outbox`) and a session's compressed recording is moved
there once it has been transcribed and archived; the PC collects and deletes
it on a schedule (see `pc-sync/`, every 6 hours by default).

Two things make this safe. The move happens **only after the transcript is
committed to the database**, so the Pi never hands over its only copy of
something it hasn't transcribed yet. And the outbox is a handover point, not
storage — `AUDIO_RETENTION_DAYS` still ages it out if the PC never collects,
so a PC that's been off for a fortnight can't fill the card either.

Leave `AUDIO_OFFLOAD_DIR` blank to keep recordings on the Pi.

## Crash/reboot recovery

If the Pi loses power or the container restarts mid-session, nothing is
lost: audio is written directly to disk as it's captured (never only held
in memory), so on the next startup the bot scans for any meeting left in an
unfinished state and reconstructs the utterance list straight from the `.wav`
files already on disk.

Recovered sessions are then **queued**, not transcribed on the spot — a
restart at 9pm would otherwise seize the GPU the moment the bot came back,
which is exactly what [the schedule](#scheduling-transcription) exists to
prevent. The audio is already safe on disk; it transcribes when it's allowed
to, and you're DM'd about it as normal.

## Ideas not built yet (worth considering later)

- **Auto-join/leave on voice activity** — start recording automatically when
  players join the voice channel, stop when it empties. Skipped for now
  since it risks recording casual chatter that wasn't meant to be a
  session; manual `/join`/`/leave` keeps that intentional.
- **Manual transcript correction** — a `/correct` command to fix a
  whisper.cpp misheard fantasy name after the fact, since STT reliably
  mangles invented words.
- **Session digest/reminder** — a scheduled message a day before your usual
  game night, auto-posting `/recap` so everyone's refreshed without needing
  to run the command manually.
- **XP/loot ledger with running totals** — beyond just listing loot per
  session, tally running totals per character over the campaign.
- **Summariser fallback** — if the primary provider errors, fall back
  to a smaller one automatically rather than failing the job outright.
- **Audio clip attachments** — clip and attach the actual audio for a
  specific dramatic moment, rather than only text.

## Status dashboard

A single page showing what the bot is doing right now: which servers it's in,
what it's recording, what it's transcribing (with progress), and what's queued
waiting on you.

Two pieces, deliberately:

- **the bot** serves a read-only JSON snapshot on `STATUS_PORT` (8090). This is
  the only inbound port it opens — everything else it does is outbound-only.
  The payload is operational data with no tokens or keys in it, and a test
  asserts that.
- **`dashboard/`** runs on the PC: nginx serving one static HTML file. There is
  no backend. The browser polls the Pi directly, so the dashboard container is
  stateless, restartable, and cannot affect a recording in progress.

```bash
cd dashboard && docker compose up -d      # http://localhost:8095
```

Point it at a different host without rebuilding:
`http://localhost:8095/?api=http://other-host:8090`

Reachability (whisper server, summariser) is refreshed on the bot's own
60-second timer rather than per request — the page polls every 5 seconds, and
probing the GPU box at that rate would put a permanent trickle of traffic on
the LAN for no reason.

`STATUS_TOKEN` adds a shared secret if the port is ever reachable from beyond
the LAN; unset is fine at home. `STATUS_PORT=0` disables the API entirely.

## How notes are filed

```
<Obsidian export>/
  Cipher/
    Session 01.md
    Session 02.md
    NPCs/          one note per character
    Locations/     one note per place
  campaign/
    <guild>-<channel>/   NPCs.md, Locations.md, ...  (the running ledger)
```

Sessions are numbered **per campaign**, not by meeting id. The meeting id is a
counter shared across every server the bot serves, so one table's second night
was previously filed as "session 16". The number is stored on the meeting when
it is created and never changes: a number derived by counting rows would shift
under its own notes the first time a session was deleted, renaming files that
are already synced to Drive and linked from the ledger.

`/campaign name:...` sets the folder. Without one it falls back to the channel
name with emoji and path-breaking characters stripped. Renaming a campaign only
affects notes exported *after* the rename — earlier ones stay where they are.

Discord messages say `Session 02 (#16)`: the number matching the vault, and the
meeting id that `/summarise`, `/transcribe` and `/export` actually take.

## Character and location notes

The per-session recap lists NPCs one line at a time, and only in the session
that introduced them. A character recurring over six months ends up as six
scattered one-liners with no page of their own.

```bash
node scripts/build-npc-notes.mjs <guildId> --write
node scripts/build-location-notes.mjs <guildId> --write
```

Both read the **full transcripts** rather than the summaries, which recovers
what a recap discards: how someone speaks, what they wanted, verbatim quotes,
and the threads left hanging. Frontmatter is what a DM would filter on — race,
status, party standing, affiliation, danger, first seen, sessions — and every
entry links back to the session it came from.

Aliases matter more than they look. Speech-to-text mangles names, so a note
carries `aliases: ["Meepo", "Mepo", "Nebo"]`, and Obsidian resolves links
against those. That is also what keeps older links working when the extraction
recovers a fuller name — the vault links `[[Kerowyn]]`, the transcript says
"Kerowyn Hucrele". The prompt asks for existing spellings to be preserved, and
the code enforces it afterwards, because a model doing it *most* of the time
fails silently.

Useful flags: `--cache <file>` saves the extraction so notes can be re-rendered
without paying for the transcripts again, `--model <name>` overrides the model,
and both refuse quietly if the ledger isn't present locally — pull it from
Drive first, or aliases won't be reconciled.

**These regenerate notes wholesale.** Anything hand-edited in `NPCs/` or
`Locations/` is overwritten.
