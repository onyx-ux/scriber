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

**Current status: the fix for bug #9 was just pushed
(commit `15bb2fe`) and the GitHub Actions build was running when this
session ended — not yet confirmed green.** First thing to check: the
Actions tab for the `onyx-ux/scriber` repo. If it's still failing, it'll
be a new/different error than the three above (those were each
confirmed root-caused, not guesses).

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

Carried over from the original handoff's "immediate next steps," updated
for what's actually confirmed vs. still open:

- [ ] Confirm the current GitHub Actions build (commit `15bb2fe`) is
      green.
- [ ] `.env` on the Pi is **not yet created** (not present in this
      workspace copy as of end of session) — needs `DISCORD_TOKEN`,
      `DISCORD_CLIENT_ID` from the Discord Developer Portal (this step
      itself was never done this session either), plus `OLLAMA_URL`
      pointing at the PC's real LAN IP.
- [ ] Confirm `rclone.conf` / Drive OAuth actually completed (see above).
- [ ] `docker compose pull && docker compose up -d` on the Pi — not done.
- [ ] Test `/join` against a real voice channel — not done. This is the
      big unknown: the voice capture pipeline
      (`pi-service/src/voice/capture.js`, especially its naive
      48kHz→16kHz downsampler) has never been run against real Discord
      infrastructure.
- [ ] Full end-to-end chain (`/join` → capture → `/leave` → transcribe →
      queue → summarize → Discord post → ledger update → Drive sync) —
      never run start-to-finish.

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
