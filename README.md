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

Design: the **Pi stays the source of truth** — `/campaign history` and `/campaign export`
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

**Three, in Discord.** There used to be twenty-seven, and anyone opening the
picker saw the lot — including `approve`, `pause`, `import` and the rest of the
pipeline, which spends the owner's GPU and API budget and has nothing to do
with playing D&D. That tier lives on [the dashboard](#the-dashboard) now.

- **`/join [campaign:]`** — start recording the voice channel you're in
- **`/leave [campaign:]`** — stop recording and queue the session (see
  [Scheduling transcription](#scheduling-transcription) — it does not seize the
  GPU on the spot)
- **`/campaign <subcommand>`** — everything else

`/join` and `/leave` stay top-level because they are the only two that must be
run from inside the voice channel being recorded.

### `/campaign`

| | |
|---|---|
| `create name:` | start a campaign here — you become its DM |
| `list` | what's here, who runs it, where its notes go |
| `rename name:` | rename one you run (its notes folder moves with it) |
| `invite player: [name:]` | ask someone to join — **they** choose whether to be recorded |
| `remove player:` | take someone off; they can no longer be recorded in it |
| `output mode:` | where finished notes are posted |
| `setchar name:` | your character name, as it appears in transcripts and notes |
| `whoami` | what name you currently appear as |
| `recap` | last session's TL;DR again |
| `funny` | a random memorable moment from this campaign |
| `search query:` | search every transcript in the campaign |
| `ask question:` | a question answered from past sessions |
| `history [count:]` | recent sessions |
| `export session:` | a session's transcript as a file |
| `stats` | sessions, hours, lines, and who talks most |
| `npcs` / `locations` | everyone met and everywhere visited |
| `archive` | the browsable campaign archive as one HTML file |

Every subcommand that resolves a campaign takes an optional autocompleted
`campaign:` — only needed when you're in more than one. A test enforces that,
because six commands once shipped able to say "re-run with the `campaign`
option" while having no such option.

### Starting a recording

`/join` needs you to be on the campaign's roster. The roster is **the bot's
own**, not Discord's member list: in a server the bot was merely invited to,
being able to see a voice channel is not permission to record the game
happening in it.

You get on it by being added with `/campaign invite`, by being given a character with
the dashboard roster, by creating the campaign yourself, or by having already spoken
in a recorded session — speaking enrols you, and everyone the bot had already
heard was enrolled when this landed.

`/join campaign:` picks between tables when you're at more than one in the
same server. With one, which is the normal case, the option never has to be
touched.

### Stopping one

`/leave` also takes a `campaign:`, and in a server holding more than one table
it **insists** on it. That option is doing something different from every other
one: there is only ever one recording to stop, so it names the session rather
than finding it.

It is there because stopping cannot be taken back. `/join` afterwards opens a
*new* session with a new number, so a `/leave` fired at the wrong table splits
that game's evening in two and no command puts it back together. The condition
is the same one `/join` announces the campaign on — if `/join` told you which
game it was recording, `/leave` asks you to say it back. The picker offers
exactly one entry, the campaign actually being recorded, so it can never offer
a table that would then be refused.

Stopping also belongs to the table being recorded: anyone on that campaign's
roster can do it, plus the bot owner, so a session whose players have all left
can still be ended. The other group's DM cannot end this one's session
mid-scene.

### Several campaigns in one server

One Discord commonly hosts two groups playing different games in different
voice channels. `/campaign create name:...` starts each one; everything the bot
records, remembers and answers with is then keyed on the **campaign**, not the
server.

    /campaign create name:Cipher     -> you run Cipher, sessions read Cipher_01
    /campaign create name:Strahd     -> a different table, its own Session 01
    /campaign list                   -> what is here, who runs it, where notes go

Each campaign keeps its own session numbering, roster, character names,
transcript corrections, vault folder, ledger, archive page and notes
destination. A a correction for one table's NPC does not rewrite the other's
transcripts, and one person can play different characters in both.

Where a command needs to know which table you mean it asks, and never guesses:

- **reading** (`/campaign recap`, `/campaign stats`, the ledger) resolves to the campaign you
  actually play in, so a second table in the server does not make every read
  ambiguous for everyone else;
- **recording and naming yourself** (`/join`, `/campaign setchar`) resolves to a
  campaign you are on the roster for, here;
- **changing a campaign's records** (`/campaign`, a correction) resolves to one you
  run, and naming someone else's says who runs it.

Campaign names have to be unique across the whole bot, because the name *is*
the vault folder and the session-reference prefix — two campaigns sharing
either would interleave their notes or make `Cipher_02` ambiguous.

The one thing that stays per-server is recording itself: a bot can hold only
one voice connection per Discord, so two tables in one server cannot record at
the same time whatever the bookkeeping says.

### Referring to a session

Commands take `Cipher_02` — the campaign, then the session number — matching
what the vault calls the file.

It used to be the meeting's row id, a single integer counting every session on
every server the bot serves. That read as nonsense (a table's second night was
"#16") and, because it named no campaign, `/export 16` from any server returned
another table's full transcript: there was nothing in the identifier to check
against. A reference that carries its own campaign is refused when it isn't
one you're part of.

Old ids still work — every message the bot has posted quotes one and those are
in people's scrollback — but only within campaigns you can already reach.

`/campaign output:` sets where a campaign's finished notes go: a direct
message to whoever runs it, or a specific channel. `NOTES_TO_OWNER_DM` and
`NOTES_CHANNEL_ID` remain the bot-wide default for campaigns that have not
chosen, but they are one setting for every table the bot serves — two
campaigns wanting different destinations cannot both be expressed that way.

### Who can run what

Three tiers, and none of them is a Discord permission.

| Tier | Commands | Who |
|---|---|---|
| **The table** | `/join` `/leave`, and `/campaign` `create` `list` `setchar` `whoami` + the read subcommands | anyone in the server |
| **Campaign manager** | `/campaign` `rename` `invite` `remove` `output` | whoever created the campaign |
| **Bot owner** | the pipeline — approvals, pause/resume, re-summarise, import, transcripts | the dashboard, behind `STATUS_TOKEN` |

The tiers are per **subcommand** now. There is no owner tier left in Discord at
all: those commands spend the owner's GPU, API budget and disk, so nobody else
has a reason to reach them in any server — and a player opening the picker
never sees them.

"Anyone in the server" is the tier, not the whole check: the four commands that
touch a live recording or a player's own record — `/join`, `/leave`,
`/campaign setchar`, `/campaign whoami` — additionally need you on that campaign's roster,
since being able to see a voice channel is not permission to record the game in
it, or to end someone else's session.

**Creating a campaign claims it.** Whoever runs `/campaign create` becomes its
manager, and from then on only they can rename it, set the roster, or correct
its transcripts. Manage Server was the obvious gate and is the wrong one: the
person running the game is often not the person administering the Discord, and
in a server the bot was merely invited to the two have nothing to do with each
other. So the bot tracks it itself (`campaigns.manager_user_id`).

The tier is enforced by *resolution*, not by a separate check: a manager
command resolves only among campaigns you run, so a command that resolves is a
command you may run. There is no second gate to fall out of step with.

Creating is open to anyone, since that is how a table starts using the bot, but
capped (10 campaigns per server, 20 per person) so it is not a spam primitive
in a public server.

The bot owner can always act, so a campaign whose manager has left the server
can still be unstuck. Campaigns that predate this are adopted by the owner on
first boot — otherwise they would read as unclaimed and the next person to run
`/campaign` would take one over.

The owner tier is the pipeline: it spends the owner's GPU, API budget and
disk, so nobody else has a reason to reach it in any server. Those commands
stay in Discord as the away-from-home fallback; the dashboard is where they
belong day to day.

### Players can install the app themselves

Nine read-only commands are **user-installable**: a player adds Quill to
their own Discord account and can run them in any channel, on any server,
including ones the bot has never been in. Discord shows those replies only to
whoever ran them.

    /recap  /funny  /ask  /search  /history  /stats  /npcs  /locations  /archive

Everything else stays server-only. `/join` needs the bot present in the voice
channel it is being asked to record, and anything that changes the campaign
belongs to the table rather than to whoever installed the app.

**This is a permission boundary, so it is enforced rather than assumed.**
Anyone on Discord can add a user-installed app to their own account, so
"which campaign" cannot be answered from the command's arguments — otherwise
a stranger could install Quill and read another table's transcripts by
naming their campaign. Outside a campaign's own server, the only campaigns
reachable are the ones the CALLER has actually spoken in
(`campaign/resolve.js`). Inside the campaign's server nothing changes: being in
the server is the permission, exactly as before.

A player in more than one campaign gets asked which, via an autocompleted
`campaign` option that lists only their own.

**One manual step:** in the Discord Developer Portal, under
**Installation → Installation Contexts**, tick **User Install**. Without it
Discord ignores the `integration_types` the bot registers and the commands
stay server-only. The install link Discord generates there is what players
use.

### What each subcommand does

- **`setchar name:`** — your Discord account to your D&D character name;
  transcripts and notes use it from then on.
  This is worth doing for the whole table, not just for tidiness. The
  summariser is told the attendee list, which is Discord names — so a player
  whose character is called something else looks like a stranger the party met,
  and gets written up as an NPC. With a roster set, both names are sent and
  marked as the party. Sessions already recorded keep the speaker labels they
  were captured with, but the roster covers every label the campaign has ever
  used, so re-summarising an old session gets it right too. The DM can set one
  for someone else from the dashboard's roster.
- **`create name:`** — start a campaign here and become its DM. The name
  becomes the Obsidian folder its notes are filed in and the prefix of every
  session reference (`Cipher_01`), so it has to be unique across the bot.
- **`list`** — the campaigns here, who runs each, how many sessions, which
  folder, and where its notes go.
- **`rename name:`** — rename one you run; the vault folder moves with it,
  ledger included.
- **`invite player: [name:]`** — ask someone to join. They get a DM explaining
  what is recorded and choose for themselves; declining means their audio is
  never captured. This is the only route onto a roster.
- **`remove player:`** — take someone off. Their transcripts stay; this is
  about who can be recorded from now on.
- **`output mode:`** — where this campaign's finished notes are posted.
- **`recap`** — re-post the last completed session's TL;DR, handy at the start
  of the next one.
- **`funny`** — a random funny or memorable moment from any completed session
  (the summariser flags these as part of the normal per-session summary).
- **`search query:`** — search every transcript in the campaign for a word or
  phrase and get the matching lines with session number, timestamp and speaker.
  Answers "when did we first meet that guy?" without re-reading old notes.
- **`ask question:`** — a question answered only from past recaps and
  transcripts, with session numbers cited. Needs the summariser reachable.
- **`history [count:]`** — recent sessions, by the reference the vault uses.
- **`export session:`** — a session's transcript as a `.txt`.
- **`whoami`** — what name you currently appear as.
- **`stats`** — sessions, hours recorded, lines transcribed, who talks most.
- **`npcs`** / **`locations`** — everyone met and everywhere visited, straight
  from the campaign ledger, without opening Obsidian.
- **`archive`** — the browsable campaign archive (the same self-contained HTML
  page that syncs to Drive after every session) as a one-off attachment.

### And on the dashboard

The operator's half, which used to be another dozen slash commands:

- **approvals** — release a parked transcription (now / not yet / on the Pi) or
  a parked summary, choosing which model writes it
- **pause / resume** — either queue, without losing queued work
- **re-summarise** — write a session's notes again, after a correction landed
  or a recap came out badly
- **roster** — who is at the table, what they play, whether they agreed to be
  recorded, and setting or clearing a character name
- **corrections** — fix a name whisper keeps mishearing. Rewrites every past
  transcript in the campaign and is saved, so future sessions are corrected
  automatically. Removing one stops it applying; lines already rewritten stay
- **notes** — read any session's recap back
- **transcript** — download the raw text
- **import** — a recording made outside Discord (an in-person game, a phone
  recording), through the same transcribe → summarise → post pipeline. **Every
  line is attributed to one label** (default "Table") — a single microphone has
  no per-speaker channels, so voices cannot be told apart the way they can in a
  voice call

## Campaign vocabulary (whisper prompting)

Whisper's weak point on a D&D session isn't hearing — it's proper nouns.
"Kaelen", "Kaylen" and "Caelan" are all plausible English, and nothing in the
audio tells it which one this table means. So it guesses, differently each
time.

`WHISPER_PROMPT=true` (the default) fixes that at inference time: before
transcribing, the bot builds a short prompt from the campaign's own
vocabulary and hands it to whisper as decoding context. Sources, in priority
order:

1. **a correction targets** — words this campaign has already *proved* whisper
   mishears. Highest value, so they survive truncation first.
2. **Player character names** from `/campaign setchar` and the dashboard roster — said every session.
3. **Ledger NPCs, then locations**, most recent first, since last week's
   villain is likelier to come up than session one's.

The prompt is guild-scoped, so two campaigns on one bot can't leak names into
each other, and it's capped at whisper's 224-token window — truncation happens
at whole-name boundaries, never mid-name.

This attacks the same problem a correction exists to clean up afterwards, so the
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
"On the Pi" on the dashboard) when you actually want that. A snooze suppresses the
automatic window too, so "remind me tomorrow" genuinely means tomorrow. A
session interrupted by a crash or restart goes back through the same gate
rather than resuming pre-approved at whatever hour the bot came back up.

the dashboard lists everything waiting, and Pause holds the whole queue.

## Summarise on approval (optional)

Summarising is separate, and no longer touches the GPU at all — it sends the
finished transcript text to Gemini or Claude. The approval gate remains
because it's a paid API call on somebody else's servers, and because you may
want to look at a transcript before it leaves the network.

Set `SUMMARY_REQUIRE_APPROVAL=true` (plus `OWNER_USER_ID`) and the pipeline
stops one step short: the transcript is written, the job parks in
`awaiting_approval`, and you get a DM with a **Summarise now** button.
the dashboard shows everything waiting and the dashboard releases it if you'd rather
not use the button.

Pause goes further — it stops the queue entirely, so you can hold work back
outright. Queued sessions stay exactly where they are and resume on `/resume`.

## Browsable archive

Alongside the markdown, the bot writes `campaign-archive.html` into **the
campaign's own folder** after every session — a single self-contained page
listing every session with its recap, plus a campaign-wide NPC/location index,
the funny moments, and a live search box. No server and no open port on the
Pi: it's just a file, so it syncs to Drive with everything else and opens from
a phone, a laptop, or a USB stick. Full transcripts stay in the `.md` files
beside it.

It used to sit at the top of the export folder, one file for everything, which
was fine while a server meant a campaign — with two, each regeneration
overwrote the other's archive with its own sessions.

## Choosing the summariser

`SUMMARY_PROVIDER` decides which model writes the recap:

- `gemini` (default) — cheapest cloud option, with a free tier.
- `anthropic` — sends the finished **transcript text** to Claude for a
  noticeably better recap. Set `ANTHROPIC_API_KEY`; `ANTHROPIC_MODEL` defaults
  to `claude-opus-5`. Anthropic's API is paid-tier only (no free tier).
- `gemini` — sends the finished **transcript text** to Gemini. Set
  `GEMINI_API_KEY` (free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey));
  `GEMINI_MODEL` defaults to `gemini-3.6-flash` — pick this provider if the
  goal is a cloud recap at low cost rather than Claude's higher quality. Note
  that `gemini-3.6-flash` does not appear in Gemini's ListModels response even
  though it serves requests, so probe a model with a real call before
  concluding it is unavailable.

**Audio and transcription are always local.** Recordings never leave the
network under any setting — a cloud option only ever sees text that has
already been transcribed on the Pi. Long transcripts are still sliced and
merged automatically, so session length isn't capped either way.

### Picking a summariser per session

`SUMMARY_PROVIDER` is only the *default*. Once a session finishes
transcribing you can send that one summary somewhere else, without changing
the config:

- **The dashboard** (with `SUMMARY_REQUIRE_APPROVAL=true`) shows one button per
  configured provider — **Gemini**, **Claude** — on each session waiting for
  you. Whichever you press is what writes that session, so the choice is made
  at the moment of approval rather than being fixed by `SUMMARY_PROVIDER` when
  the session ended.
- **Re-summarise**, on any session with a transcript, writes the notes again —
  for a recap produced before a a correction landed, or one that simply came out
  badly.

These used to be buttons in a Discord DM. They moved so that nothing in the
pipeline depends on a Discord interaction arriving; the DM is now a
notification with a link, and `DASHBOARD_URL` is what it links to. Buttons
still sitting in old DMs answer with a pointer rather than failing silently.

Only providers that are actually set up appear — each needs its API key
present. Asking for one that isn't configured gets a clear refusal rather than
a silent fallback to something you didn't choose. With just one provider set
up, the button stays a plain **Summarise now** instead of a pointless
one-item picker.

The choice is stored on the job, so it survives a bot restart and is still
honoured when a queued session is retried later.

## Campaign ledger (Obsidian)

Alongside each session's own markdown file, the bot maintains **persistent,
cross-session files** per campaign, in a `Ledger/` folder inside the campaign:
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
- **Manual transcript correction** — a a correction command to fix a
  whisper.cpp misheard fantasy name after the fact, since STT reliably
  mangles invented words.
- **Session digest/reminder** — a scheduled message a day before your usual
  game night, auto-posting `/campaign recap` so everyone's refreshed without needing
  to run the command manually.
- **XP/loot ledger with running totals** — beyond just listing loot per
  session, tally running totals per character over the campaign.
- **Summariser fallback** — if the primary provider errors, fall back
  to a smaller one automatically rather than failing the job outright.
- **Audio clip attachments** — clip and attach the actual audio for a
  specific dramatic moment, rather than only text.

## The dashboard

Where the bot is operated from. It shows what's happening right now — which
servers it's in, what it's recording, what it's transcribing, what's queued —
and it's where you **approve** things, manage a campaign's roster and
corrections, and pull a transcript.

Two pieces, deliberately:

- **the bot** serves JSON on `STATUS_PORT` (8090). This is the only inbound
  port it opens — everything else it does is outbound-only. The status payload
  is operational data with no tokens, keys or user ids in it, and a test
  asserts that.
- **nginx** serves one static HTML file and proxies `/api` to the bot, adding
  the token server-side. It runs **on the Pi**, as a second service in
  `pi-service/docker-compose.yml`.

```bash
cd pi-service && docker compose up -d     # http://pihouse.local:8095
```

### Why it lives on the Pi

It used to run on the PC, which was fine while it was a *window*: with the PC
off you lost a status page describing the PC's own GPU, which you couldn't have
used anyway.

That stopped being true when it became the *control surface*. Approving a
**summary** needs nothing but the internet — the PC is irrelevant to it — so a
dashboard only up when the PC is up meant a session recorded on Friday couldn't
be released until someone booted a gaming rig. And since the operator buttons
left Discord, there'd be no other way to do it.

Sharing a compose project with the bot means nginx reaches it as `bot:8090` by
service name: no host IP, no mDNS from inside a container, nothing to re-point
when the Pi's address changes. `dashboard/docker-compose.yml` still exists for
running a second copy on the PC, which is useful when working on the page.

### Reads are open. Actions are not.

`STATUS_TOKEN` does two different jobs, and the asymmetry is deliberate:

| | without `STATUS_TOKEN` | with it |
|---|---|---|
| **reads** (`/status`, `/campaign`, `/transcript`) | open | token required |
| **actions** (`POST /actions/*`) | **all refused** | token required |

Open reads are a reasonable default for operational data on a home LAN. Writes
are not: an unauthenticated POST can spend the API budget, seize the PC's GPU
mid-evening, or stop the queue. So with no token configured there is no correct
credential to present, and rather than read that as "everyone is welcome" the
bot refuses every action and says so — at boot, and in the page, which shows an
explanation instead of buttons. `STATUS_PORT=0` disables the API entirely.

The nginx container is deliberately given **only** `STATUS_TOKEN` and `PI_API`,
not the bot's `env_file` — a web server has no use for `DISCORD_TOKEN` or
`GEMINI_API_KEY`, and one careless `${...}` in a template is all it would take
to serve one to a browser.

Reachability (whisper server, summariser) is refreshed on the bot's own
60-second timer rather than per request — the page polls every 5 seconds, and
probing the GPU box at that rate would put a permanent trickle of traffic on
the LAN for no reason. The per-campaign detail is fetched only when you open a
campaign: it changes a few times a month, and polling a roster, a correction
list and a session history for every campaign would grow each request with the
size of the whole install.

**The dashboard is the only thing meant to face a URL.** nginx proxies `/api`
to the Pi and adds the token server-side, so the Pi's port can stay on the LAN
even if the dashboard is published, and the token never reaches a browser. The
page used to fetch the Pi directly, which meant every viewer needed to reach
port 8090 themselves and any token would have sat in the page source.

Access uses nginx's `satisfy any`: an address on `dashboard/config/allowed-ips.conf`
passes straight through, anything else is asked for the username and password
in `dashboard/config/.htpasswd`. Either is enough — without `satisfy any` the
two would be ANDed and the house would be asked for a password as well.

    docker run --rm httpd:alpine htpasswd -nbB matt 'CHOOSE-A-LONG-ONE' > dashboard/config/.htpasswd

**Run it — don't write the file by hand.** The file wants
`user:$2y$05$<53 more characters>`; a line with the password in it instead of a
hash is a password stored in the clear. And a password copied out of this
README is a password every reader of this README already has: `-nbB` is what
turns one into the other.

Both `.htpasswd` and `dashboard/.env` are gitignored.

## How notes are filed

```
<Obsidian export>/
  Cipher/
    Session 01.md
    Session 02.md
    Characters/    one note per player character
    NPCs/          one note per NPC
    Locations/     one note per place
    Ledger/        NPCs.md, Locations.md, Party-Decisions.md,
                   Unresolved-Threads.md  (the running ledger)
```

Everything a campaign produces hangs off **one folder**, named by `/campaign`.
The ledger used to live in a separate `campaign/<guildId>-<channel-slug>/` at
the vault root — correct, but unreadable, and it meant one campaign appeared
twice in the vault under two unrelated names. Old ledgers are moved into place
automatically the first time the bot starts after this change; a file that
would overwrite something already at the destination is left where it is and
logged rather than merged blindly.

`Ledger/` is a subfolder rather than four files beside the session notes for
two reasons: `NPCs.md` would sit next to the `NPCs/` folder of per-character
notes, and the ledger is the one thing pulled *down* from Drive before each
append — aiming that rclone copy at the campaign folder itself would sweep the
session notes up with it.

Renaming a campaign with `/campaign` moves the existing folder to the new
name, session notes and ledger included. Leaving it behind would not just look
untidy: the ledger is what tells the next session which NPCs the campaign
already knows, so an orphaned folder means every NPC met so far gets
re-introduced in the next recap as though they were new.

Sessions are numbered **per campaign**, not by meeting id. The meeting id is a
counter shared across every server the bot serves, so one table's second night
was previously filed as "session 16". The number is stored on the meeting when
it is created and never changes: a number derived by counting rows would shift
under its own notes the first time a session was deleted, renaming files that
are already synced to Drive and linked from the ledger.

`/campaign create name:...` sets the folder. Without one it falls back to the channel
name with emoji and path-breaking characters stripped. Renaming a campaign only
affects notes exported *after* the rename — earlier ones stay where they are.

Discord messages say `Session 02 (#16)`: the number matching the vault, and the
meeting id that Re-summarise on the dashboard, the dashboard and `/campaign export` actually take.

## Character and location notes

The per-session recap lists NPCs one line at a time, and only in the session
that introduced them. A character recurring over six months ends up as six
scattered one-liners with no page of their own.

```bash
node scripts/build-npc-notes.mjs <guildId> --write
node scripts/build-location-notes.mjs <guildId> --write

# The party. The roster has to be given: the transcript is labelled with the
# DISCORD SPEAKER, so "Brett" is a person and "BenTen" is who they play, and
# nothing in the transcript reliably says which speaker is the DM.
# The roster comes from /dm character (see below) unless you override it:
node scripts/build-character-notes.mjs <guildId> --dm "Old Dad" --write

# "Speaker=Character" pins the character's name. A bare "--pc Speaker" leaves
# it to the model, which reads it off the transcript and can hear it
# differently in different sessions ("Saf" as "Seth"). Pin it once you know
# it, or fix it afterwards with rename-note.mjs, which keeps the old name as
# an alias so nothing written earlier stops resolving.
node scripts/build-character-notes.mjs <guildId> --pc "Brett=BenTen" --write
node scripts/rename-note.mjs <guildId> "Seth" "Saf" --write

# Link every name the vault knows, everywhere it is mentioned. Re-run after
# any of the above; it is idempotent, and dry-run by default.
node scripts/link-vault.mjs <guildId> --write
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
