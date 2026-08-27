# Feature requests

## Implemented (2026-07-31)

- [x] **Approval before summarising, with a DM** — `SUMMARY_REQUIRE_APPROVAL=true`
      (now set) parks the job in `awaiting_approval` the moment transcription
      finishes. You get a DM with a **Summarise now** / **Not yet** button, and
      nothing touches the GPU until you press it. `/approve` works as a
      fallback if the DM fails or you'd rather use a command.

- [x] **Fallback for killing Ollama** — `/pause` stops the queue worker
      entirely, so Ollama can be killed or the GPU freed with nothing left
      trying to reach it. Queued sessions stay put and pick up again on
      `/resume`. The pause flag is stored in the database, so it survives a
      bot restart. (Separately: a job that dies mid-summarise is now recovered
      on startup instead of being stranded in `running` forever.)

- [x] **`/pending`** — shows the whole pipeline in one place: which sessions
      are recording, transcribing, awaiting your approval, or queued for
      summarising, plus attempt counts, last error, whether Ollama is
      reachable, and whether the queue is paused.

- [x] **Summary noise removal** — two changes. Empty sections are now dropped
      entirely rather than printed as `_none_` under every heading. And NPCs
      or locations already recorded in the campaign ledger are omitted from
      the per-session recap, so the tavern you visit every week stops being
      re-listed as a "location visited". The full summary is still stored in
      the database and the ledger, so nothing is actually lost — it just
      stops crowding out "what happened".

<!--
Original notes, kept for reference:

Instead of automatically pushing to ollama. A command built in that messages ME directly advising that whisper has completed transcribing waiting for approval to proceed. I.E I would have Ollama running in the background but it auto summarieses while im in a game and it cooks my game.

Fall back option in-case i need to KILL Ollama for any reason.

a /pending (or status) command that outputs what is currently in the pipeling.

A validation on the summary output that if the output has no real content of value, this is removed to allow space for more "what happened" For instance, the D&D campaigns may only visit one location, we don't need to have that location noted every time.
-->

## Implemented (2026-08-01, overnight)

- [x] **`/correct` / `/uncorrect`** — fix a whisper-mangled fantasy name
      across every past transcript and all future ones; `/uncorrect` undoes it.
- [x] **Gemini as a third summariser option** — `SUMMARY_PROVIDER=gemini`,
      alongside Ollama and Claude.
- [x] **Transcription speed** — a real 235-utterance session was on pace for
      4-5 hours (whisper.cpp reloads its model per file). Utterances are now
      batched into one whisper call per group instead of one per utterance.
- [x] **Whole-session audio backup** — `DRIVE_SYNC_AUDIO=true` now uploads
      one compressed recording of the whole session instead of the raw
      per-utterance fragments.
- [x] **`/whoami`, `/stats`, `/npcs`, `/locations`, `/archive`** — campaign
      totals and the ledger, surfaced directly in Discord instead of only
      being visible in Obsidian.

## Implemented (2026-08-27)

- [x] **The gatehouse** — a page of its own at `/gatehouse/` for the one thing
      the dashboard could not do: change who may sign in. The guest list used
      to be `DASHBOARD_ALLOWED_USERS` alone, so editing it cost an SSH session,
      a text editor and a container restart. It is now that variable *and* a
      table, unioned, with the page showing which half admitted each name — and
      refusing to offer a Remove button for the half it cannot delete.

      The roster is a real table now — five columns, a search box over name and
      id, and filter chips for everyone / on the list / turned away / signed in
      / held down — with a **Level** column beside each name.

      That column only goes **down**, and the reason is the whole design. Each
      level rests on a different fact: `dev` is `OWNER_USER_ID` in a file,
      `owner` is Discord saying they own a server, `creator` is a campaign
      naming them as its manager, `player` is having actually spoken at a
      table. Not one of those becomes true because this page wrote a row, so
      the rungs above somebody are disabled in the dropdown and carry the thing
      that would really raise them. Picking a lower rung sets a ceiling —
      stored in `dashboard_access.cap`, applied in `buildViewer`, and it
      narrows their scope rather than merely greying their buttons. Picking
      their own level back lifts it. The operator can never be capped, for the
      same reason they are always on their own guest list: the only way back
      would be SSH.

      A **Tier** column sits beside Level — 0, then 1 to 4, then 9 — and it is
      the one control here that goes *up*. Tier 0 is free and is where everybody
      starts; tier 9 is the house, always the owner's and never metered. There
      is deliberately no 5 to 8: a tier between the paid band and the house is
      the one most likely to be wanted later, and the gap means adding one is a
      new number rather than a renumbering of every row. That is not an inconsistency: a level answers "what
      may they see" and is derivable, so granting one would mean inventing a
      fact — while a tier answers "how much of the owner's GPU and API bill may
      they spend", which no fact in the world answers. It is the person paying
      deciding what they will pay, which is exactly what a list is for. See
      `src/access/tiers.js`, which carries the argument in full.

      The tier already governs something real rather than sitting there as a
      number: `/campaign ask` was the bot's only spending ceiling, one global
      `ASK_DAILY_LIMIT` for everybody, and it now reads the asker's tier. With
      `TIER_ASK_LIMITS` unset every tier is worth exactly what the bot allowed
      before, so no install changes behaviour until somebody writes a number.
      Transcription minutes and a token budget are the ceilings the operator
      has in mind next; they read their allowance from the same place, in the
      same shape, and the enforcement goes at the point that spends. The
      gatehouse shows what each person has spent today and turns it red at the
      ceiling.

      Two things worth knowing, both of which the page says out loud:
      **Remove ends that account's sessions**, because the list is only
      consulted when a session is made and a name struck off would otherwise
      keep working for a month. And **removing the last name opens the door to
      everyone**, since no list means no list — so the reply to the removal
      that empties it says so in capitals.

      The Access screen left the dashboard entirely, along with its nav button,
      which every player could see and none could use. The roster left `/status`
      with it, onto `GET /access`: building it is the most expensive question
      this server answers and the dashboard was polling for it twelve times a
      minute to throw it away.

- [x] **The dashboard stops stealing your caret** — every panel used to be
      rebuilt with `innerHTML` on the five-second poll, which destroys and
      recreates every node underneath it. The page worked around that three
      times, and the widest one was a bug: focus in **any** field froze the
      **whole** dashboard — recording state, job progress, the session list —
      until you clicked away, with nothing on screen saying so.

      `dashboard/html/dash/morph.js` patches a panel instead of replacing it:
      rows that are still wanted keep their nodes, so the caret, the selection,
      the scroll offset and any half-typed word stay put, and the rest of the
      page carries on updating around them. About eighty lines, no
      dependencies, no build step, and the deploy is still a file copy.

      All three workarounds are gone. See
      [ADR-0002](docs/adr/0002-the-dashboard-stays-one-file-and-patches-its-own-dom.md),
      which also records why this is not React and why the page was not split
      into modules.

- [x] **A second operator** — `OPERATOR_USER_IDS` in `pi-service/.env`, comma
      separated, empty by default. Those accounts get the `dev` level, tier 9
      and a permanent place on the guest list: the machinery, unmetered, and
      no list can lock them out.

      They deliberately do **not** get your DMs — approval, transcription and
      restore notices still go to `OWNER_USER_ID` alone, because two people
      receiving every notification is how both start ignoring them — and they
      do not adopt orphaned campaigns on startup. Both are asserted
      structurally, so a notifier written next year that reaches for the
      operator list fails the suite on the day it is written.

      It lives in `.env` rather than on the gatehouse on purpose: handing
      somebody your GPU, your API bill and your transcripts should cost an SSH
      session and a restart, and should survive whatever happens to the
      database — the same argument `DASHBOARD_ALLOWED_USERS` makes for its half
      of the guest list. The gatehouse shows them tagged `operator` with the
      level and tier controls disabled and pointed back at that line.

      Along the way this closed a real hazard. `isOperator` existed in two
      modules with **reversed argument orders** — `(cfg, userId)` and
      `(userId, cfg)` — and `web/actions.js` imported one while calling the
      other's order three lines apart. It compiled. Now there is one function,
      in `access/operators.js`, and it is the only thing that answers "who runs
      this".

- [x] **Request an invite** — being turned away used to be a line of red text
      under a Continue with Discord button, which reads as a fault and offers a
      loop: press the button again and be refused again. It is now its own
      screen. **Quill is not open yet** — pre-alpha, the list is short, and here
      is the one thing you can do about it.

      The button puts their Discord name in a queue. The gatehouse shows the
      queue above everything else on the page, because it is the only thing
      there that is somebody waiting on you rather than a list you keep at your
      own pace: **Let them in** or **Not now**, and an *Asked to join* chip.
      Dismissing is not a ban — it clears the ask, leaves no row behind, and
      they can ask again.

      The awkward part is that somebody turned away has **no session**, by
      design: `auth-routes` checks the guest list before it writes any row. So a
      button that posted its own user id would let anybody put any name in front
      of the operator. Instead the callback hands back a short-lived signed note
      saying only *"Discord confirmed this is user X, called Y"* — thirty
      minutes, spent on use, and the single thing it can do is create a request
      row. It is not a session and cannot become one.

      Nothing is written until the button is pressed, so somebody who reads the
      screen and closes the tab costs the database exactly what they always did:
      one log line. Asking twice does not refresh the date — a queue sorted by
      impatience is not a queue — and admitting somebody keeps the date they
      asked on, which is the only record of how long they waited.

## Ideas not built yet

- **Limits behind the tiers** — the tier is set, stored and visible, and it
  governs exactly one ceiling: the daily `/campaign ask` allowance, via
  `TIER_ASK_LIMITS`. The two the operator actually has in mind are not built:

  * **A token budget.** The blocker is attribution, not accounting. `model_usage`
    already records input/output/total tokens per call, but against a
    `meeting_id` and not a person — so "how many tokens has Fenwick spent" has
    no answer today. Deciding *whose* spend a summary is counts as a real
    design question rather than an implementation detail: the session belongs
    to a table, the campaign belongs to its manager, and the approval that
    released it was the operator's. A player's `/campaign ask` is the one case
    where the answer is obvious, and it is also the only case with a per-user
    counter (`ask_quota`).
  * **Transcription minutes.** Nothing meters GPU time per person at all. The
    natural unit is audio seconds attributed to whoever spoke them, which
    `utterances` already holds — but the cost is the whisper run over the whole
    session, not one person's share of it.

  Both read their allowance from `access/tiers.js`, in the same shape as
  `askLimitFor`, and the enforcement goes at the point that spends rather than
  at the point that asks. Whatever gets built, two properties have to hold:
  **the owner is never locked out** (tier 9 is unmetered, same as every other
  ceiling in this codebase), and **an unconfigured install behaves exactly as
  it did before** — a limit nobody set is not a limit of zero.

  Worth deciding before building: what the bot does when somebody hits a
  ceiling mid-session. Refusing a `/campaign ask` is easy and already works.
  Refusing to transcribe a session that has already been recorded is a
  different kind of no, and "we recorded your evening and will not write it up"
  needs a better answer than an error.

- **Thread resolution tracking** — `unresolvedThreads` only ever grows; nothing
  marks one resolved once a later session answers it.
- **Auto-join/leave on voice activity** — deliberately skipped so far, since it
  risks recording casual chatter that wasn't meant to be a session.
- **Session digest/reminder** — auto-post `/recap` the day before game night.
  Needs a "when is game night" concept that doesn't exist yet (a fixed
  day/time config, most likely) — a design question worth confirming before
  building, not something to guess at.
