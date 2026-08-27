# Session context / handoff

This file exists so a fresh Claude session (e.g. Claude Code in VS Code)
can pick this project up without Matthew having to re-explain everything
from scratch. It covers what happened in the Cowork session that got this
repo to its current state, what's confirmed working, and what's still
open. Read this before doing anything else.

## Who you're working with

Matthew is a **newbie** to this stack — Docker, GitHub Actions, Linux
networking, and self-hosted services are all fairly new territory for
him. Practical implications for how to work with him:

- Don't assume familiarity with CLI conventions, Docker concepts, or
  networking jargon. Explain *why* a command does something, not just
  what to type.
- Give exact, copy-pasteable commands rather than "run the usual build
  command" style shorthand.
- He's on **Windows**, using **PowerShell**, with **VS Code** as his
  editor, **Docker Desktop + WSL2** installed, and **Bitdefender Total
  Security** as a third-party firewall/AV layer *on top of* Windows
  Firewall — both need matching rules for anything network-related, and
  this has already caused confusion once (see "Networking" below).
- He will often paste screenshots of errors (terminal output, GitHub
  Actions logs) rather than raw text. Ask for the actual expanded log
  text when a screenshot is truncated/summarized — don't guess from a
  short annotation.
- He's capable of following precise multi-step instructions (firewall
  rules, PATH edits, PowerShell admin elevation) once told exactly what
  to click/type — the gap is unfamiliarity, not capability.

## The words this codebase uses

Added 2026-08-21, because this file was a session handoff with no glossary in
it and an architecture review needed names for things. These are the terms the
code actually uses — use them rather than inventing synonyms.

- **Campaign** — one table's ongoing game. The unit everything is filed under:
  a vault folder, a ledger, a roster, a session numbering. Not a Discord
  server; one server can hold several, and one campaign can be read from
  anywhere. Claimed by whoever ran `/campaign create`, who is its **manager**.
- **Session** — one recorded evening. Stored as a `meeting` row, numbered per
  campaign (`Cipher_02`), and made of **utterances** — one row per speaking
  turn, per person.
- **Ledger** — the campaign's flat index: `NPCs.md`, `Locations.md`, one line
  per name. Written by the pipeline after every session, synced to Drive.
- **Entity note** — a PAGE per NPC, place or player character, read from the
  full transcripts rather than the recaps. Distinct from a ledger entry: the
  ledger says a name exists, the note says who they are and carries the
  **aliases** that make `[[Yusdrayl]]` resolve when whisper spelled it three
  ways. Lives under `NPCs/`, `Locations/`, `Characters/` in the vault.
- **Subject** — which of those three an extraction run is about. A subject is
  a description — prompt, merge rule, renderer, folder — handed to one shared
  run in `campaign/entity-notes.js`, not a copy of it.
- **Vault** — the Obsidian directory the notes are written into.
- **Viewer** — who is looking at the dashboard, and what that entitles them
  to. Four **levels** (dev, owner, creator, player), each derived from a fact
  about Discord the bot can check rather than a role anybody grants.
- **Authority** — whether a request may do a thing, and as whom. One module,
  `web/authority.js`: the door, the name, the act, the acting id, the cut.
- **Correction** — a rename rule scoped to one campaign, for names whisper
  mishears. Rewriting transcripts with one cannot be undone, hence the
  blast-radius guard in `pipeline/job-actions.js`.
- **Job** — a queued piece of work against a session: transcribe or summarise.
  The **queue** is the list of them, and it is **machinery** — it spends the
  owner's GPU or API budget, so every control over it is theirs.

Architecture decisions that should not be re-litigated live in `docs/adr/`.

## What this project is

Self-hosted Discord bot ("Scriber") that records a D&D group's voice
session, transcribes it locally, and produces AI-generated session notes.
Split across two home-LAN machines:

- **Raspberry Pi** (always-on): Discord bot, voice capture, whisper.cpp
  transcription, SQLite, job queue, Obsidian markdown export, campaign
  ledger, optional Google Drive sync via rclone.
- **PC** (sometimes on): runs Ollama with a larger model for the actual
  AI summary step. Pi calls it over the LAN and queues/retries if the PC
  is off.

Full architecture, design decisions, and rationale are in `README.md` in
this same folder — that doc is thorough and was written before this
session started. Don't duplicate it here; read it for the "why" behind
the design.

## Repo structure note

The git repo root is **this folder** (`scriber/`), not the parent
`dnd-bot` folder. `README.md`, `.github/`, `.gitignore`, and
`pi-service/` all live directly here. (Early in this session, README.md
and a missing GitHub Actions workflow were sitting one level up outside
the repo entirely — already fixed, see history below.)

- GitHub remote: `https://github.com/onyx-ux/scriber.git`, branch `main`
- As of the last check in this session, local `main` is a clean working
  tree and up to date with `origin/main` — all commits below are pushed.

## What happened this session (chronological)

Matthew uploaded a handoff doc from a prior planning session plus the
original scaffold zip. The scaffold had already been extracted into this
`scriber/` folder with git initialized, but several real bugs and one
structural problem surfaced when reviewing it closely and then running
it through GitHub Actions:

1. **Structural bug**: `README.md` and (what should have been) the
   GitHub Actions workflow lived one directory above the actual git repo
   root, so they'd never have been pushed. Moved both into `scriber/`.
2. **Missing entirely**: `.github/workflows/docker-publish.yml` — the
   README describes a multi-arch build workflow as already existing, but
   it didn't exist anywhere (not in the zip, not in the extracted repo).
   Wrote it from scratch: buildx + QEMU, builds `linux/amd64` +
   `linux/arm64`, pushes to GHCR using `${{ github.repository }}` so the
   image name can't drift from the real repo.
3. **Typo**: `pi-service/docker-compose.yml` referenced
   `ghcr.io/onyx_ux/scriber` (underscore) but the actual GitHub username
   is `onyx-ux` (hyphen) — would have pulled a nonexistent image. Fixed.
4. **Missing `.gitignore`**: nothing excluded `.env`, `rclone.conf`
   (holds Google Drive OAuth secrets), or runtime data
   (`data/`, `models/`, `*.db`, `*.wav`). Added one before the first
   commit/push — this mattered because those files hold real secrets
   once populated.
5. **`.env.example` gap**: `env.js` already supported
   `DRIVE_SYNC_ENABLED`, `DRIVE_SYNC_AUDIO`, `DRIVE_REMOTE_NAME`,
   `DRIVE_REMOTE_PATH`, `OBSIDIAN_EXPORT_DIR`, but `.env.example` didn't
   document them. Added.
6. A stale `.git/index.lock` was blocking all git operations — turned
   out to be a Cowork sandbox restriction on deleting files in the
   mounted workspace folder, not a real process lock. Resolved via the
   `allow_cowork_file_delete` tool, then made the initial commit.

Then Matthew pushed to GitHub himself (the Cowork sandbox has no GitHub
credentials, so pushes always had to happen from his own machine) and
GitHub Actions ran, surfacing three **real, sequential** build bugs —
each one only visible after fixing the previous one:

7. **`git clone` failing with exit 128** on the arm64 leg. Root cause:
   running `git clone` under QEMU emulation is a known `docker/buildx`
   flakiness issue (buildx#528) — git's process/spawn syscalls don't
   emulate reliably. Fix: split the whisper.cpp clone into its own
   `--platform=$BUILDPLATFORM` stage (always runs natively, since
   cloning is just network I/O and doesn't need target-arch emulation),
   then `COPY` the source into the arch-specific compile stage.
8. **Invalid `COPY ... 2>/dev/null || true` syntax.** `COPY` has no
   shell, so those trailing tokens were parsed as a literal extra source
   path, which made buildkit hunt for a nonexistent path and fail to
   compute the cache key. Fix: moved the "copy these optional .so files
   if they exist" logic into a `RUN` step (real shell, `|| true` works
   there), staging into a fixed `/out` layout, then made the
   runtime-stage `COPY`s plain and unconditional.
9. **ggml `-march=native` producing a self-contradictory flag string**
   under QEMU (adds `dotprod`/`i8mm`/`sve` then immediately un-adds the
   same ones — assembler rejects it). This is a known,
   maintainer-acknowledged bug (`ggml-org/llama.cpp#10933`). Fix:
   `-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8-a` in the cmake configure
   line, pinning a safe generic arm64 target instead of relying on
   broken autodetection.

**Update (2026-07-30, from Claude Code on Matthew's PC): confirmed
green.** Run #4 (commit `15bb2fe`) completed with `conclusion: success`
— checked directly via the GitHub Actions API
(`api.github.com/repos/onyx-ux/scriber/actions/runs`). The multi-arch
(`linux/amd64` + `linux/arm64`) image is published to GHCR. All three
sequential build bugs are resolved; no new failures surfaced after the
ggml fix.

## Networking — confirmed working

Separately from the Docker build, Matthew set up LAN connectivity
between the Pi and PC for Ollama:

- PC's current LAN IP observed during this session: `192.168.0.153`
  (note: the README/`.env.example` use `192.168.1.50` as a placeholder —
  a DHCP reservation for the PC's real IP was recommended but not
  confirmed done).
- Windows Firewall: inbound rule for TCP 11434, Private profile.
- **Bitdefender Total Security also needed its own separate firewall
  rule** for the same port (11434, TCP, inbound, Home/Office network) —
  Bitdefender runs its own firewall on top of Windows Firewall and will
  silently block traffic Windows Firewall already allows. Both are
  required.
- Confirmed working: `curl http://192.168.0.153:11434/api/tags` from the
  Pi successfully reached Ollama once Ollama was actually running (the
  first failed attempt was simply because Ollama wasn't open — not a
  networking bug).
- Also resolved earlier: a Windows port-bind error during
  `rclone config`'s OAuth flow (`bind: An attempt was made to access a
  socket in a way forbidden by its access permissions` on port 53682) —
  classic WSL2/Hyper-V dynamic port exclusion range conflict. Fix was
  `net stop winnat && net start winnat` in an elevated PowerShell.
  **Not confirmed whether the rclone OAuth flow was completed
  successfully after that fix** — worth checking `rclone.conf` exists
  and `rclone listremotes` shows `gdrive:` before assuming Drive sync is
  ready.

## What's NOT done yet

Rewritten 2026-08-28. Everything the original handoff listed here has
since been done. It was checked against the Pi over ssh rather than
against this workspace, because the Pi's own git checkout is not the
thing that runs: the bot runs from a CI-built image and the dashboard
runs from a bind-mounted copy of `dashboard/html`.

Confirmed on the Pi, 2026-08-28:

- [x] GitHub Actions build green — confirmed 2026-07-30, run #4.
- [x] `pi-service/.env` exists and is populated. It does **not** want
      `OLLAMA_URL`. The Ollama summariser was deliberately removed in
      `d7a4486` and summarising runs through Gemini/Anthropic now. The
      old wording of this section still asked for it, which is exactly
      how a stale doc talks a fresh session into re-adding something
      that was taken out on purpose.
- [x] `pi-service/rclone/rclone.conf` exists, so the Drive OAuth flow
      did complete after the winnat fix described above.
- [x] `docker compose up -d` — running, as the `pi-service` project:
      `pi-service-bot-1` from `ghcr.io/onyx-ux/scriber:latest`,
      `pi-service-dashboard-1` on `nginx:alpine`, and
      `pi-service-tunnel-1` on `cloudflare/cloudflared:latest`.

One item is left open rather than ticked, because it was not re-checked:

- [ ] The full chain (`/join` → capture → `/leave` → transcribe → queue
      → summarize → Discord post → ledger update → Drive sync) was not
      queried end to end on 2026-08-28. It is near-certainly long since
      done — the bot has been up continuously and the campaign, consent,
      correction and compendium features listed in `new features.md`
      were built against real recorded games — but nobody read the
      `meetings` and `summaries` tables to say so out loud. Read them if
      it matters.

Open work is no longer tracked in this file. It lives in
`new features.md`, under "Known faults, not fixed yet" and "Ideas not
built yet".

## Why this session used Cowork instead of Claude Code

Worth knowing if Matthew asks: this session ran in Cowork, a sandboxed
cloud environment with only mounted folder access — no real Docker, no
outbound internet from its shell (confirmed: couldn't `apt install` or
`pip install` anything to try reproducing the arm64 build locally), and
no GitHub credentials (every push had to happen from Matthew's own
terminal). That's why the three Dockerfile bugs above were root-caused
by reading GitHub Actions logs Matthew pasted in, rather than by
reproducing them directly. If you're reading this from Claude Code
running on Matthew's actual PC, you likely have real Docker, real
network access, and real git credentials — use them; there's no reason
to relay-debug through pasted logs anymore.
