# D&D Session Scribe — Pi + PC split architecture

A self-hosted Discord bot for recording D&D sessions, purpose-built to be
lighter than a faster-whisper/full-web-dashboard stack, and split across two
machines on your home network:

- **Raspberry Pi** (always-on): joins voice, captures per-speaker audio,
  transcribes locally with **whisper.cpp** (no Python, no CUDA deps, ARM-fast),
  stores history in SQLite, exports Markdown for Obsidian, posts to Discord.
- **Desktop PC** (only on sometimes): runs **Ollama** with a large model for
  the actual AI summary. The Pi calls it over your LAN and queues/retries if
  the PC is off.

No Tailscale/VPN needed — this design assumes Pi and PC are always on the
same LAN, per your setup. If that ever changes (e.g. you want this working
away from home), Tailscale would be the right add-on later; nothing here
needs to change to support that, you'd just point `OLLAMA_URL` at a Tailscale
IP instead of a LAN IP.

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
2. On the PC, set Ollama to listen on the LAN, not just localhost (same as
   we did for Parley):
   ```powershell
   [System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0', 'User')
   ```
   Restart Ollama fully (tray icon → Quit → relaunch) after setting this.
3. Windows Firewall: allow inbound TCP 11434 on your **Private** network
   profile only (not Public) — Windows will usually prompt for this the first
   time the Pi connects.
4. On the Pi, set `OLLAMA_URL=http://192.168.1.50:11434` in `.env`.

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
      summarize-client.js    # HTTP call to PC's Ollama, with retries
      queue-worker.js         # background job processor (handles PC-off case)
    export/markdown.js      # Obsidian-formatted .md export
    delivery/discord-post.js  # posts to channel (no thread) + attaches files
    prompts/dnd-summary-prompt.js
    commands/                 # /join /leave /history /summarise /export
  Dockerfile
  docker-compose.yml
  .env.example
```

There is no `pc-service/` folder — the PC side is just Ollama itself, no
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
4. On the **Pi**, create `pi-service/rclone.conf` with just that section
   pasted in.
5. In `.env` on the Pi, set `DRIVE_SYNC_ENABLED=true` (and
   `DRIVE_SYNC_AUDIO=true` if you also want raw audio uploaded — off by
   default since audio is large and normally deleted after processing
   anyway; only turn this on if you're keeping audio around, per the
   earlier decision to disable auto-delete).
6. Restart: `docker compose up -d --build`

**On the PC:** install Google Drive for Desktop, and either point it at the
same `DnDSessions` folder to sync locally, or use Drive's "Stream" mode and
just browse to it — either way, no bot-side code involved, it's just
Google's own sync client doing its job.

**What gets uploaded where** (all under `DnDSessions/` in your Drive):
- `notes/` — finished markdown (after summary, so it's the complete version)
- `audio/<meeting_id>/` — only if `DRIVE_SYNC_AUDIO=true`
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
architecture above — the PC's role is Ollama, not this container. Being
able to `docker compose pull` it on the PC too is mainly useful for testing
changes locally before they reach the Pi, or if you ever want to run the
whole stack on one machine for debugging.)*

## Commands

- `/join` — start recording the voice channel you're in
- `/leave` — stop recording, transcribe, queue the AI summary
- `/history [count]` — list recent sessions
- `/summarise meeting_id:<id>` — force an immediate summarise retry (useful right after turning your PC on)
- `/export meeting_id:<id>` — get the raw transcript as a `.txt` file
- `/setcharacter name:<name>` — map your Discord account to your D&D character name; transcripts and notes use this instead of your Discord display name from then on
- `/funny` — pull a random funny/memorable moment from any completed session in this campaign's history (the AI summariser flags these, if any, as part of the normal per-session summary)
- `/status` — see what's currently queued/retrying, and whether your PC's Ollama is reachable right now
- `/recap` — re-post the last completed session's TL;DR (handy at the start of the next session)

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

## Crash/reboot recovery

If the Pi loses power or the container restarts mid-session, nothing is
lost: audio is written directly to disk as it's captured (never only held
in memory), so on the next startup the bot scans for any meeting left in an
unfinished state, reconstructs the utterance list straight from the `.wav`
files already on disk, and runs it through the normal transcribe → queue →
summarise pipeline automatically — no manual intervention needed.

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
- **Ollama model fallback** — if your primary model is slow/OOMs, fall back
  to a smaller one automatically rather than failing the job outright.
- **Audio clip attachments** — clip and attach the actual audio for a
  specific dramatic moment, rather than only text.
