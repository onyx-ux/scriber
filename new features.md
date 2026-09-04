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

## Implemented (2026-08-28)

- [x] **The desk** — signing in used to land on the ledger of campaigns, which
      answers "which table" and nothing else. That is the wrong first question
      for the person who runs the bot: on a given evening what they came for is
      as likely to be the night waiting to be released, or the bill, or a name
      at the gate, as it is a campaign.

      The first screen is now every place there is to go, drawn as one sheet of
      ledger paper ruled into squares — the cells share their borders rather
      than floating apart as cards, so it reads as a page divided up rather
      than six objects arranged on a background. Each square is written at the
      foot and the ruling shows in the space above the writing, so a square
      with little on it is mostly rule. The pen draws itself under whichever
      one you are about to open, and the two squares that are about tonight —
      something recording, something waiting on you — keep their rule drawn
      without being asked.

      Squares for things that are not happening are not drawn. There is no
      "nothing is recording" square, because a page of absences answers
      nothing. Nor is any square drawn that its viewer would be refused: the
      bill, the servers and the gatehouse are the operator's, and a player's
      desk has their own table on it and nothing else.

      The old shortcut — one campaign, so go straight into it, on the grounds
      that an index of one is a door with nothing behind it — did not survive
      this. The desk is not an index of campaigns, and even a one-table
      operator has three other doors on it. The table is still one click away,
      by name, in its own square.

- [x] **Wikilinks in the write-ups** — every NPC and every place a write-up has
      named already had a page of its own in the compendium, and no way to get
      to it from the recap that named it. Names in the prose are now links: a
      dotted pen underline at rest, the highlighter under the cursor, and
      clicking one opens that entry. **Copy for Obsidian** carries the same
      links as real `[[Name]]` brackets, so a recap pasted into a vault
      arrives already joined to the notes the exporter writes.

      Nothing is asked of the summariser for this, deliberately. Links written
      into the stored recap would exist only for sessions summarised after the
      prompt changed; every session already written would need re-summarising —
      real money, on the owner's bill — to gain one; and the model would be
      inventing link targets with no way of knowing which entries exist.
      Linking at the moment of reading, against the list the campaign actually
      has, is retrospective for nothing and cannot point at a page that is not
      there.

      The rules are the four `export/linkify.js` already used for the vault —
      first occurrence only, case-sensitive, whole words, longest name first —
      so a name is a link on this page if and only if it is one in Obsidian.

- [x] **Items are one list** — an item used to be a page. There was never more
      to put on it than the one sentence the summariser wrote on the night it
      was found, so the page was a click that led to that sentence in a larger
      font, and reading down the campaign's haul meant opening forty of them.
      The Items shelf is now a single ledger, grouped by the night each thing
      was found, and the column beside it lists those nights rather than a
      second copy of the same forty lines.

      **Coin and experience are left out of it.** They still appear in the
      session's own Loot and rewards, because that is what the night was worth
      — but a campaign-wide list of *things* with forty entries of gold in it
      is an accounts page, and the two actual items are lost in among them. The
      test is not the word "gold": "a golden idol" and "the Goldvein amulet"
      both name something. Money reads as a quantity — a number, then what it
      is counted in, and nothing else — and an item reads as a name, so a line
      is money only when every word in it is a number, a unit, or a word for
      joining those together.

- [x] **The pane reads first** — the tabs were The table, Corrections, Notes,
      Settings. Reading is what the pane is for and what nine visits in ten
      are, so it comes first; Corrections is second, because it is what you go
      and do having just read a name that came back wrong; the roster is third,
      being looked at when somebody joins or leaves rather than weekly.

      **Settings left the row entirely.** It is not a fourth thing to read — it
      is what the person who runs the campaign does *to* it, and everybody
      else's click on it landed on a screen of values they could not change. It
      now sits apart at the end of the strip, in the utility face, and only for
      whoever manages that campaign.

- [x] **Fixing a name where you notice it** — the corrections list is the right
      home for the rules and the wrong place to write one: nobody opens a list
      of corrections and remembers a name from it. **Fix a name** on a write-up
      opens the same two boxes under the recap that made you want them. The
      corrections screen also stopped naming the transcriber — that is the same
      rule the health line already follows below dev, and a correction is about
      the name rather than about which program mishears it.

- [x] **A session is "Session 4"** — everywhere a person reads about one. The
      bot's own reference is `Cipher_04` and has to be: it is typed into a
      slash command on a server that may run several campaigns, so it carries
      its campaign with it. Inside the dashboard the campaign is the thing you
      are already in, so the slug said nothing the header did not and read like
      a filename. The vault keeps the slug, because a note in a vault does have
      to say which campaign it belongs to.

      The session column was rearranged around the same point: the name of the
      night and its state have the first line to themselves, and the date and
      line count moved to their own line underneath. All three used to share
      one line and the name came third in the fight for it, which on a narrow
      column left "Session 12" wrapping under a word of its own date.

- [x] **The reading grows with the window** — the recap's prose was pinned at
      70ch, which is the right measure on a laptop and two thirds of a monitor
      left empty. It now grows with the window and stops at a line that can
      still be tracked back to its own left edge.

## Implemented (2026-08-29)

Deployed to the Pi the same day — commits `27d6dc1` and `978cde4`. All three
entries that stood under "Known faults" below are in here; the section is empty
for the first time.

- [x] **A channel to post in** — the destination switch had three options and
      the middle one, "A chosen channel", was drawn disabled from the day it
      existed, pointing at `/campaign output` in Discord. The page had never
      been told which channels the bot may post in, and only Discord can say.
      It is told now: `web/discord-bridge.js` gained `listChannels`, and the
      switch opens a dropdown grouped under each category in the order
      Discord's own sidebar draws them.

      Text and announcement channels only. Voice channels carry a text chat and
      the bot could post in one, but that is where the table *plays* — a recap
      dropped there lands in the middle of next week's session. Threads are out
      for a different reason: Discord archives them after a few days of quiet,
      and a destination that stops existing on its own is not a destination.

      **Nothing is typed, and the id is not taken on trust.** A channel id is
      eighteen digits with no check digit, so a box to paste one into is a box
      to mistype one into, and the mistake surfaces weeks later as a write-up
      nobody received. `setOutput` is handed Discord's own answer to "where may
      I speak" and refuses anything not on it. "Discord said no" and "nobody
      managed to ask Discord" are kept apart, because only the second means
      leave the setting alone.

      Which closed the open question the old note ended on. A campaign pointed
      at a deleted channel already fell back to the recording channel silently —
      `scopeCampaign` had never sent `outputChannelId` at all, so nobody could
      even see which channel was set. The page now says the channel has gone and
      what is happening in the meantime.

- [x] **Tier 9 means the house** — setting it makes that account an operator.
      Not by deriving a level from a number somebody typed, which is the thing
      `access/tiers.js` refused and was right to refuse, but the other way
      round: tier 9 is a **fourth way of *being*** an operator, alongside
      `OWNER_USER_ID`, `OPERATOR_USER_IDS` and the console token, and the level
      then derives from that honestly through the same line it always did.
      `runsThisBot` replaced `isOperator` at every call site that asks about
      authority; `isOperator` stays wherever the question is really "which line
      of the config file names you".

      The question the other routes answer with an SSH session is answered
      twice here: only `dev` may set any tier at all, and **only an operator
      named in the file may hand out or take back tier 9** — both directions,
      because an operator who could not appoint another but could remove one
      would still leave "who runs this bot" answerable from a web page. So an
      operator appointed from the page cannot mint another. See
      `docs/adr/0003`, which also states the cost plainly: who can spend the
      owner's money is no longer purely a fact about a file.

- [x] **The Level column goes both ways** — it could only ever hold somebody
      down. It raises them now, and the argument it used to protect survives
      intact, because a level and a scope are different things and `viewer.js`
      already said so: the level decides how much machinery is on screen.

      **A grant moves controls, never scope.** Which campaigns somebody sees
      stays the union of three checkable claims, untouched. Granting `creator`
      to somebody who runs nothing gives them a creator's controls over nothing
      at all — so the action's own message says "adds controls, not campaigns"
      and names the act that would actually give them one, rather than leaving
      that to a help panel nobody opens.

      A floor and a ceiling, and only ever one of them: the store clears the
      opposite column on every write, so a floor of `creator` under a ceiling of
      `player` is unreachable rather than something `buildViewer` picks between
      while the page draws the other. The rule for the derived level overtaking
      a grant is that **the grant goes quiet and the row survives** — deleting
      it the moment it was redundant would take the decision away for good, and
      the fact that overtook it can go away again.

      `dev` is off that menu entirely. One way to appoint an operator, next
      door in the Tier column, rather than two things to remember to take away.

- [x] **A campaign can be handed on** — a campaign acquired a manager exactly
      once, whoever typed `/campaign create`, and that was permanent. There was
      no answer to "the person who set this up has stopped running the game"
      except an operator with SSH, while `HOW_TO_RAISE` had spent months telling
      people to "hand them one from that campaign's settings" — describing a
      control that did not exist. It exists.

      Recipients come from the roster and nowhere else, so "invite them first"
      is the whole prerequisite and a mistyped id cannot become the person who
      runs a table. It grants nothing: it changes who runs the campaign, and
      `buildViewer` derives `creator` from that the next time it is asked.

      **The operator's alone**, and deliberately tighter than deleting, which a
      manager may do. Throwing a campaign away disposes of something already
      yours; handing one on decides who somebody *is* on this bot, and that
      belongs with the Level and Tier columns rather than inside one campaign's
      settings. A manager keeps everything else on that screen — the roster,
      the corrections, where the notes go.

      One consequence, met head-on rather than papered over: a `player` claim is
      having *spoken* at a table, not being listed on it, so a DM who set a
      campaign up, handed it on and never recorded a session keeps no read
      access. The message says "stays on the roster" rather than "still sees
      it", because the roster is what a handover can actually promise.

- [x] **The summariser asks the other provider** — the model ladder already
      stepped down within one provider when it said it was out of quota. The
      level above that was missing: every model of theirs exhausted, or nothing
      answering at the other end, failed the job and left a recorded evening
      unwritten while a second configured key sat idle.

      Three kinds of failure now. Out of quota walks down that provider's
      ladder, as before. **Unreachable does not walk down at all** — a cheaper
      model of theirs is the same host over the same dead link, so stepping down
      is three more ways to fail identically, and the only move that could work
      is the other provider. Anything else throws: a refusal or a malformed
      response is the request's fault and would fail the same way twice, at
      twice the price.

      Summaries only. `/campaign ask` never crosses over, on the same argument
      its ladder already makes for not climbing — a question asked in passing is
      not worth quietly reaching for a second bill, and "ask me again in a bit"
      is a fine answer to one and not to an evening somebody already recorded.
      `SUMMARY_PROVIDER_FALLBACK` turns it off for an operator who keeps the
      second key for choosing per job rather than for spending unasked. With one
      key configured it changes nothing.

      **Inert on this install today** — `pi-service/.env` has no
      `ANTHROPIC_API_KEY`. It starts working the day one is added.

- [x] **Discord is the entryway, the dashboard is the powerhouse** — recorded
      as `docs/adr/0004`, because it reverses a rule that was tested on every
      run. `test/dashboard-optional.test.js` required every dashboard action a
      non-dev could reach to have a slash command doing the same job, so that
      the web page stayed genuinely skippable.

      Retired. It taxed the wrong thing — the queue, the compendium, the
      transcripts and the gatehouse have no sensible slash-command shape and
      never wanted one — and it had quietly run out of room, because
      `/campaign` sits at **Discord's hard ceiling of 25 subcommands** and a
      26th throws inside the builder at import time, taking the whole bot down
      with a message that names neither the command nor the limit. Found the
      hard way. That ceiling is now a test with a readable message rather than
      a boot failure.

      What survives is the half that was load-bearing, in
      `test/entryway.test.js`: **the acts that make somebody a participant stay
      in Discord.** A player agreed to play D&D, not to open a web page.
      Joining, leaving, consenting, naming a character, reading a recap and
      claiming an unclaimed table are theirs and happen where they are — as is
      correcting a misheard name, which is not about participation but takes
      five seconds mid-session.

- [x] **The chain was read end to end** — `CONTEXT.md` had one box left
      unticked: nobody had actually queried the `meetings` and `summaries`
      tables to say the whole pipeline had run. Done, against the live
      database. `markJobDone` only runs after `postSessionNotes`,
      `updateCampaignLedger` and `pushLedgerToDrive` have all returned, so a
      summarize job sitting at `done` is the one row that proves the whole
      chain rather than just the summary. Three real Cipher sessions, ~3h15m
      each, six speakers, 2027/2377/2440 lines, every job `done`. Corroborated
      on disk by the vault's 17 NPC notes and by `DnDSessions/notes/Cipher` on
      Drive. (There is no `summaries` table — the recap lives in
      `meetings.summary_json`.)

## Implemented (2026-08-31)

- [x] **A cloud voice for the nights the PC is dark** — `GEMINI_TRANSCRIBE=true`
      adds `gemini-3.5-transcribe-live` between the PC's GPU and the Pi's CPU.
      One continuous stream **per speaker**, so Discord's attribution survives
      by construction and diarization stays off; six concurrent sockets were
      measured working, which is a table's worth.

      **Ships OFF and is the one setting that sends recordings off the
      network.** Every other step, both summarisers included, only ever handles
      text.

      Three limits are undocumented and all three were found by walking into
      them: the API meters how *fast* audio arrives (4x realtime fine, 16x
      returns "Resource has been exhausted" while accepting every byte and
      transcribing almost none — an unpaced run came back with 0-6 words per
      NINE MINUTES and looked like a model that could not hear); the 10-minute
      session cap is **wall clock, not audio**, announced ~50s ahead by
      `goAway`; and `custom_vocabulary` is mutually exclusive with timestamps
      AND diarization. Two earlier shapes were measured and abandoned — one
      clip at a time cost 13.1s per clip and lost 19% of them (~9h/session),
      and pipelining the activity blocks killed the socket outright.

      Measured against whisper on a real 191-minute session: **2.2x more
      correctly-spelled proper nouns** (220 vs 100 — whisper writes "Ben 10"
      for BenTen 37 times out of 40, and "Cypher" for Cipher 19 times out of
      26), 1 silence hallucination against whisper's 7. See "Known faults" for
      why it is still off.

- [x] **The clip that had no length** — `recovery.js` gave every rebuilt
      utterance `endMs: startMs`, reasoning that the real end was unknowable
      after a crash and that nothing read it. Both halves were wrong. The
      duration was already being read one line above to decide whether the clip
      was long enough to keep, and two things read the result: `markdown.js`
      builds a per-speaker **Talk time** column and hides it when every duration
      is zero — so that column had never once printed — and
      `session-recording.js` sizes the whole-session archive from the largest
      `endMs`, so the archive declared a length short by the final clip and
      players cut it off. This is the path **every scheduled session** takes,
      not a crash corner: all 2,440 rows of session 3 had `end_ms == start_ms`.

- [x] **The bot says why it fell over** — there was no `unhandledRejection`
      handler, no `uncaughtException` handler and nothing listening for a
      signal. Node terminates on an unhandled rejection by default, so one
      stray promise in a fire-and-forget path took the bot down **mid-session**
      and left nothing in the log naming it. The audio always survived, so what
      was lost was never the recording — it was the ability to find out.

      The two cases now get opposite answers on purpose. A rejection logs its
      whole stack and **stays up**: it is more often weather than damage, and
      dying for one in the middle of somebody's evening is the worse outcome.
      An uncaught exception logs and **exits non-zero**, because the stack it
      happened on is gone and the state is unknown. SIGTERM/SIGINT close the
      Discord clients (the voice connection closes rather than timing out) then
      the database (WAL checkpointed rather than recovered next boot), with a
      7s deadline under Docker's SIGKILL, and are idempotent under a double
      signal. See `src/lifecycle.js`.

- [x] **What happened last time, told to the table** — `/campaign recap` gains
      `style:`. The default is unchanged and still reposts the stored tldr,
      which is written for the vault: past tense, third person, a record for
      somebody reading back through a campaign. **For the table** retells it as
      a spoken "previously on" — three to five sentences, the party addressed
      as *you*, character names rather than Discord ones, ending on whatever is
      still unfinished, which is the sentence the table actually needs before
      they start.

      It reads **only the last session's finished notes** — never the
      transcript, never other sessions. The notes record what the table
      witnessed, so a recap built from them cannot leak what the DM has not
      shown; the transcript would widen that to every aside made with a mic
      open. It goes through `/ask`'s gate rather than a second one of its own —
      same pause check, same reachability check, same per-person allowance, same
      cheap model — and falls back to the stored note on any failure, because
      the question has a good answer in the database either way.

## Implemented (2026-09-03)

- [x] **The pressed chip lights up now** — clicking a speaker in the transcript
      took the highlight off `everyone` and never put it on the name you
      pressed, so the bar came back with nothing lit at all. Waiting did not
      help: the five-second poll skipped it for the same reason, and the
      highlight only appeared once you clicked somewhere else, which is why it
      read as lag. The campaign tabs had it too.

      The cause was one line in `dashboard/html/dash/morph.js`. The patcher
      leaves the focused element alone so a poll cannot take a caret or a
      half-typed word, and it was sparing **every** focused node — but on
      Windows and Linux a click leaves focus sitting on the button it landed
      on, so the one element that had just changed appearance was the one
      element the repaint refused to touch. Focus was never the thing worth
      protecting; unsent state is, and a button holds none. The guard now asks
      for `INPUT`/`TEXTAREA`/`SELECT` or a caret in editable text.

      Reproduced in headless Chrome against the real `morph.js` before it was
      touched, and two of the three new tests in `pi-service/test/morph.test.js`
      fail against the old guard.

- [x] **The rulebook switch was refusing the person it was drawn for** — the
      new setting went into the action table without a line in `ACTION_NEEDS`,
      and an unlisted action falls through to `machinery`: the tier that means
      *this spends the owner’s GPU or their API budget*. Choosing which wiki a
      spell name links to spends neither. So a DM pressing the switch on their
      own campaign got told it was somebody else’s hardware to decide about,
      while the page drew the buttons enabled for them, because the page asks
      `canManage()` and the server asked something stricter.

      Found by asking, not by clicking: the browser walk ran as the operator,
      who passes every gate, so it went green over the top of it. The test that
      should have caught it was asserting `ACTION_NEEDS[name] ?? 'machinery'`
      **equals** `'machinery'` for every unlisted action — a restatement of the
      `??`, which cannot fail. It now names the ten actions that are allowed to
      fall through, so the eleventh is a failing test rather than a default.

- [x] **The write-up index caught up a session late** — it is built by reading
      the prose, and the prose is drawn by the same paint that draws the rail,
      so what the template could put there had been read from the PREVIOUS
      page. On a page nobody is touching those are the same write-up. Opening a
      different session they are not: the index went blank until the
      five-second poll came round, and on slightly different timing it listed
      the last night’s scenes under ids that were no longer on the page.

      Put right immediately after the morph instead, against the prose that is
      actually there — and only when it disagrees, because rewriting it every
      five seconds would take the focus out of the index for anybody reading by
      keyboard, which is a worse fault than the one being fixed.
- [x] **What is behind a name, without going to look** — every NPC and place a
      write-up names is already a link. Hovering one now opens a card with who
      they are, the night they walked on, and how many nights they appear in.

      Nothing is fetched for it: the compendium is what made the name a link in
      the first place, so the card is already in memory. It is
      `pointer-events: none` on purpose — a thing to read rather than a thing to
      visit, which means there is no state where the pointer is on the card and
      not on the name, and no code to handle one. Following the link is what the
      link is for.

      It lives outside every panel the patcher touches, because it is anchored
      to a node inside one and would otherwise be thrown away by the first poll
      that landed while somebody was reading it.

- [x] **Where you are in a write-up** — a recap of a four-hour night runs to
      seven or eight sections, and past the fold there was no way to tell how
      much was left. The facts rail now opens with the write-up read as its own
      shape: the opening, every scene by its own title, the decisions and the
      follow-ups, with the one on screen marked and a click back to any of them.

      Built by reading the prose rather than the notes object, so the index can
      only list what is actually on the page. A scroll handler rather than an
      IntersectionObserver, for the same reason the margin is floats rather than
      positioning: the pane is rebuilt every five seconds, and an observer would
      have to be re-attached to the new nodes each time.

      Below three parts there is no index — a table of contents for a page you
      can see the end of is furniture — and below 1300px there is no rail to put
      it in, which is the same answer.

      **The >1200px in the original note is not reachable.** The margin already
      has its own derived threshold: 326 for the session list + 320 for the rail
      + 112 of pane padding + 720 of measure + 58 of gutter + 340 of note =
      1876, so 1900 is where a sidenote first fits rather than a taste. At 1200
      there is about 500px of pane, and a 340px margin note would run under the
      rail. The index goes in the rail instead, which exists from 1301 up.

- [x] **A spell in a write-up links to the rules for it** — 506 spell names,
      linking out to the wikidot for the edition the campaign says it plays.
      Nothing of the rules text is reproduced: this is a list of NAMES and the
      address of a page somebody else wrote.

      **Generated from each wiki own spell index**, so a slug is right by
      construction rather than by 506 chances to mistype one. The two editions
      are genuinely different lists — 2014 has 424 of these and 2024 has 363 —
      and every entry carries which wikis have it, so a campaign only links what
      its own edition can answer. A link to a 404 is worse than no link.

      Seventeen spells appear twice under one name and two slugs, which is not a
      duplicate: the wikis slugify an apostrophe differently, `bigbys-hand`
      against `bigby-s-hand`, so each edition needs its own row to have an
      address that resolves.

      **The one failure this must not have** is linking "the light was failing"
      to a cantrip. So a single-word spell name is linked only if it is on a
      hand-made keep-list of coined words — Fireball, Counterspell,
      Prestidigitation — and the 99 that are also ordinary English are left
      alone. Multi-word names are all fine. The campaign own names win over the
      rules everywhere they overlap: a table with an NPC called Sanctuary means
      the person.

      Served from `/rules` rather than shipped in the page — 26KB that most
      visits never need, and one copy rather than the palette two.

      **What is NOT linked, and why.** Conditions, monsters, skills and classes
      are the terms a recap says most, and neither wiki has a page for any of
      them: `/conditions`, `/grappled`, `/monster:goblin`, `/class:wizard` and
      every variation tried are 404 on both. Checked 2026-09-04, not assumed.

      `dnd2024.wikidot.com` answers a 301 from https to http — it has no working
      certificate — so a reader following a 2024 link lands on plain HTTP
      whatever we write. The links say https anyway: asking for the secure one
      and being refused is different from writing the insecure one down, and the
      day they fix it these are already right.
- [x] **Everyone gets a colour** — a speaker picks one of twenty-four and their
      name is written in it, in transcripts and nowhere else. Twelve families
      of two shades: the ten dragons, plus an eldritch purple and an ocean blue
      that no dragon covers.

      **Forty-eight values, not twenty-four.** The dashboard has a dark theme
      and a light one, and a colour tuned for parchment is invisible on slate.
      Both halves of every colour were measured rather than picked: each one
      clears 4.5:1 as text on the LIGHTEST surface its own theme ever puts text
      on — `--raise` on the dark theme, `--card` on the light one — so a name
      stays legible on a selected row as well as on the page. The worst of the
      forty-eight sits at 4.503:1.

      The stylesheet holds them as `light-dark(light, dark)` rather than as
      three copies of the palette. Every theme block on this page already
      declares its own `color-scheme`, which is exactly what `light-dark()`
      resolves against, so 24 rules do the work of 72 and the two themes cannot
      drift apart by hand. A plain value in front of each is the fallback for a
      browser without it, and it is the DARK one, because dark is the default.

      What is stored is the **slug**, never a hex — `pi-service/src/web/palette.js`
      says why at length. A stored colour outlives a retune; a stored hex would
      freeze one theme into the database and let a client write any string it
      liked into a class attribute.

      Yours to set for yourself wherever you play, and the manager can set one
      for a player who never opens the dashboard — the same rule as the
      character name beside it, for the same reason. Unlike a character name it
      does **not** enrol anybody: picking a colour is a claim about nothing, and
      putting somebody on the roster as a side effect of a preference would add
      a name to the list a DM reads as "these are my players".

      `?` The picker marks colours already spoken for at this table by name and
      dims them, rather than refusing them. Two people can share brass if they
      want to — it is their table — but nobody should arrive there by accident,
      and four warm metals in one palette is the part of this that crowds.

      The switch is per browser, next to the theme, and it turns off the REST
      of the table rather than everybody: finding your own line in four hours of
      talk is the reason somebody picked a colour in the first place. It only
      appears where somebody other than the reader has chosen one, so it is
      never a control that visibly does nothing.

      `test/palette.test.js` reads the stylesheet and the module and fails if
      they disagree — on any of the forty-eight values, on the twelve family
      names, or on their order. It re-measures every contrast ratio against the
      theme tokens as they are on the day it runs, so retuning a theme is what
      breaks it, which is the moment the palette does need looking at again.

      Verified end to end in Chrome against a real status server: 24 coloured
      names, the computed colours matching the palette exactly in both themes,
      the picker, the switch, and no console errors.

## Work in progress


### Correcting a write-up — the foundation is in, the page is not (2026-09-04)

The summariser writes what it heard, and what it heard is sometimes wrong.
A correction is a **layer over** the write-up and never a change to it: the
summariser’s text stays underneath exactly as written, a correction strikes
one line of it through and says what it should say instead, and removing the
correction brings the original line straight back. That is the whole safety
claim, and it is what makes this safe to hand to a table rather than to
whoever runs it — **"delete everything" is not a gesture that exists here.**

**The five questions are settled.**

- **Who may correct.** Anybody at the table, which is a new tier in
  `ACTION_NEEDS` called `table` — weaker than running the campaign, stronger
  than being signed in. The people who can tell the model it misheard are the
  ones who were in the room, and most of them are not the DM.
- **What the other three audiences show.** The corrected reading, everywhere.
  `/recap`, the Obsidian export and the Discord post all render what the table
  says the night was; one document, one truth. The marks show in one place
  only: the dashboard, with the switch set to edit.
- **What Re-summarise does.** Keeps the old write-up **and its corrections**
  as a previous version you can still open and read; the new one starts clean
  with a line saying how many corrections belong to the old one. Nothing is
  re-anchored onto the new text — a correction is somebody’s words about a
  sentence, and guessing which new sentence they meant would be inventing
  their opinion. This was the sharp one: re-summarising is the only act that
  genuinely destroys what a correction was written about.
- **How a correction is anchored.** To a LINE — one bullet, one paragraph,
  one scene title — by part and index, never a character offset. A line has
  an identity the write-up already gives it ("the third point of the second
  scene"), which survives its neighbours changing. The exact text struck
  through is stored with it, so a line that has MOVED is found again and a
  line that has genuinely gone is shown apart rather than dropped.
- **A commenter with no colour.** Falls back to the page’s own ink. The
  colour is an affordance for reading a redline at a glance; the name is the
  identity, and one is not missing because the other is.

**Built and tested (27 new tests, 1494 passing):**

- `src/notes/redline.js` — the whole of the reading logic, pure, knowing
  nothing about the database or the page. `linesOf()` says what is there to
  correct, `readingOf()` says what the write-up says once the corrections are
  applied, `redlineOf()` says what it looks like with the marks showing.
- `recap_versions` and `recap_notes` in the store, with `setSummary()` now
  retiring a corrected write-up rather than overwriting it. A night
  re-summarised with nobody having touched it leaves no version behind: the
  value kept here is the redlines, not the model’s earlier drafts.
- `recap/note`, `recap/note-edit`, `recap/note-remove`, and the `table` tier
  in `authority.js`.

**Two faults caught while writing it, both in the new code:**

- `recap/note-remove` was deleting first and judging afterwards, so the
  `null` that means *the manager’s override* was being handed over by anybody
  whose id simply did not match — which is exactly the case it has to refuse.
- The `table` tier resolved the campaign before asking who was calling, so a
  request with no session and no campaign id fell through to the action’s own
  validator and came back 400. Every other tier fails closed on the level
  first; this one does now too. Caught by `no-session.test.js`, which
  enumerates `ACTIONS` rather than listing them — it covered an action
  written a year after it was.

**Still to build:** the page. The view/edit switch, the strike-through drawn
in the commenter’s own voice colour, the line offering the corrections on a
previous version, and making `readingOf()` the text that `/recap`, the
Obsidian export and the Discord post actually render — the decision is made
and the function exists, but nothing calls it outside the tests yet.

Not deployed. The migration is additive and harmless, but there is no reason
to put half a feature on the Pi.
- [ ] **The threshold — the first-time landing page** (started 2026-09-02) — the
      screen somebody gets once, on the first sign-in their account has ever
      made. White writing in the dark that appears a character at a time, asks
      only what the bot cannot already look up, and burns the page away from the
      torch you pick. It is `welcomeScreen()` and the `.thr` block in
      `dashboard/html/index.html`, and it says WIP on screen because it is.

      Two roads out of the first question, because two entirely different
      people press it.

      **Create the Story.** The book asks what the story is called, which
      Discord it is told in, and who else is at the table — `campaign/create`,
      `roster/search` and `roster/invite`, the dashboard's own actions, asked
      for in the book's own voice. Nobody is sent off to find a button.

      **Join the Story.** A joiner has no table to make and no server to pick,
      so walking them through the maker's questions would be four screens of
      "not me". They are asked for an invitation instead, and the link does the
      rest: it names the table, the table asks whether Quill may write them
      down, and only then does it ask what to call them. See
      **The invitation link** below.

      Whether somebody is new comes from `db.countSignIns()` — the gatehouse's
      sign-on log, asked about one account. Open it without a fresh account by
      going to `/app/#welcome`.

      **To finish it:**

      - The four endings need their copy settled with a real first-time reader.
        Two of them (the player with no table, the DM whose Discord has no Quill
        in it) are written from the outside and have never been read by anyone
        arriving cold.
      - **Add Quill to a Discord** points at `/` because there is no install URL
        anywhere yet — the same blank as `QUILL_INVITE` in `quill-landing.html`.
        One value, two pages.
      - `firstVisit` is derived from a log that `pruneAuthEvents` keeps to the
        last 300 events across everybody, so an account that signed in a year
        and three hundred events ago is greeted as new a second time. A
        `first_seen_at` on `dashboard_access`, written once, would settle it.
      - It is remembered as got-through in `localStorage`, so the same person on
        a second machine sees it again. Same fix as above.
      - There is no way back a step. Every move burns the page, and a burnt
        page has nowhere to return to — a DM who mistypes the name of their
        campaign has to finish and rename it from the dashboard.
      - The roster step searches the one server the campaign was just made in,
        which is right, but it says so nowhere. A DM who types the name of
        somebody in a different Discord is told only that nobody matches.
      - Asking somebody is fire-and-forget: the torch lights when the Pi
        accepts it, and whether they ever answer the DM is only visible later,
        on the campaign's own table tab.
      - The consent block on the joining screen is the one place the screen's
        own no-subtext rule is broken. It is broken on purpose — see the note on
        `.thr-terms` — but it has never been read by somebody deciding for real,
        and it is the paragraph that most needs to be.

- [ ] **The invitation link** (started 2026-09-02) — one address per table,
      handed round however the table already talks to each other, replacing
      "find each player in a Discord member list first" as the only way onto a
      roster. `/app/?join=<token>`, made by the `invite/link` action and opened
      by the threshold's joining road.

      The token is the whole of the authority, so it is treated like a password:
      18 random bytes, revocable with `invite/revoke`, and dead after 14 days. A
      token that was never one is refused in exactly the same words as a revoked
      one, because telling them apart tells a stranger which guesses were warm.

      It is not a way past consent. `invite/accept` records the answer under the
      **session's** user id and never one from the body, anything but a literal
      `true` is recorded as a decline. A player who declines is still asked what
      to call them and still named, which does put them on the roster — being at
      a table and being recorded at one are separate facts in this schema, and
      `mayRecord()` is the only gate the capture path asks. It still answers no.

      **To finish it:**

      - The link is only offered on the threshold's roster step, which somebody
        sees once. A table that gains a player in month four has nowhere to go
        and ask for it — it belongs on the campaign's own table tab too.
      - Nothing shows the manager who has come in through the link, or that a
        live link exists at all. `invite/revoke` is written and tested and has
        no button anywhere.
      - `/app/?join=<token>` is the address because nginx serves the dashboard
        from an exact `location = /app/`, which a query does not disturb. A
        prettier `/join/<token>` needs a location block in
        `dashboard/templates/default.conf.template` first.
      - The token rides in `sessionStorage` across the Discord sign-in bounce,
        so an invitation opened in one tab and signed into in another is lost.
      - There is no rate limit on `invite/peek`. The token space makes guessing
        hopeless, but a bot could still hammer it.

## Known faults, not fixed yet

The note this section was kept under is worth keeping: these are the operator's
own reports, written down before they are argued with, and some of them will
collide with a design decision recorded on purpose. Whoever picks one up should
read the argument before deciding against it.

- [ ] **The page scrolls sideways between 821px and 1023px wide** — the top
      bar’s min-content is 1018px: the campaign name, the health readings, two
      pause buttons and the theme switch. There is a wrap rule for exactly this
      and it is filed under the phone breakpoint, on the reasonable-sounding
      assumption that a bar this wide could only fail on a phone. Below 820 it
      wraps and is fine; above 1024 it fits. The band between is a laptop
      window docked to half the screen — which is where a DM reads a write-up
      beside Discord, so it is not a rare width.

      **Not a regression** — measured identically against `HEAD` before and
      after the write-up work, and it has nothing to do with either job.

      Left alone on purpose, having tried it twice. Moving the wrap rule out to
      1024 makes the second row spill two pixels through a bar pinned to 76px,
      and the pause buttons come out sliced along the top; letting the bar grow
      as well fixes that but then `.right` stops shrinking and starts wrapping
      at 1100, where today it fits. What gives way in that band — the health
      readings, the word on the pause buttons, the campaign name — is a
      decision about the bar, not a bug fix, and it belongs to whoever wants to
      make it.
- [ ] **The Gemini rung is off because its line breaks are wrong** — attribution
      is exact (validated 229/229 on 396 real clips, zero failures) and it runs
      at 1.74x realtime against the Pi's 0.38x. What is not right is *when*
      each line was said: alignment drifts by about one clip, and roughly 4 in
      10 clips come back with no text at all, because the model segments its own
      stream by its own voice detection rather than on the clip boundaries.

      This is the ceiling of continuous streaming, not a tuning knob — per-clip
      text needs per-clip boundaries, and both ways of giving it those were
      measured and failed. It is also, for what it is worth, **the same trade
      the whisper batching note already describes** ("a word can land on the
      neighbouring clip"), and that path ships. So the honest framing is that
      this competes with the Pi's batched CPU path, not the GPU's clean one.

      Worth deciding before turning it on: whether ragged line breaks matter
      for a transcript whose main consumer is a summariser that reads the whole
      thing anyway.

- [ ] **The working tree writes CRLF into an all-LF repo** — `HEAD` is LF
      throughout, but files come back from an edit with CRLF: `commands/index.js`
      was sitting at **1,863** CRLF lines on 2026-08-31. It is invisible until
      something matches on exact text, and then it fails on strings that look
      identical — it broke two patch attempts in one session before the cause
      was spotted, and it silently turned `dashboard/html/index.html`
      mixed-ending once before that.

      The fix is a `.gitattributes` with `* text=auto eol=lf`, which is a
      one-line change that touches how git handles every file in the repo —
      left for the operator to agree to rather than slipped in. Until then:
      sweep `git diff --name-only` for `\r\n` before committing.

- [ ] **The two-tables work is not written down here** — `DISCORD_VOICE_TOKENS`
      and the voice pool landed in `61880fc` on 2026-08-30 and this file has no
      section for that date. Not a fault in the code; a gap in the record, and
      this file is the record.

## Ideas not built yet

- **The table can correct its own write-up, without being able to erase it**
  (asked for 2026-09-04) — moved to Work in progress below; the five open
  questions are answered there and the half of it that is not the page is
  built.
- **Limits behind the tiers** — the tier is set, stored and visible, and it
  governs exactly one ceiling: the daily `/campaign ask` allowance, via
  `TIER_ASK_LIMITS`. The two the operator actually has in mind are not built.

  One thing changed under this since it was written: **tier 9 is no longer only
  a ceiling** — it makes an operator, as of 2026-08-29. Nothing below it moved,
  so 0 to 4 are still purely about money and the plan below is unaffected; but
  whatever meters spend has to keep treating 9 as unmetered for the same reason
  it already did, and now for a second one as well.

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

  Still the biggest real-world gap, because the failure it addresses is the
  night everybody forgot to type `/join` — and that is the one failure no
  amount of transcription quality helps with. Two things have moved under it
  since it was written. The consent machinery now exists (`campaign_consent`,
  and the invite flow that goes with it), so "recorded chatter nobody agreed
  to" has an answer that is not just "don't build it". And the voice pool
  exists, so a bot joining on its own no longer risks stealing the connection
  from a table that is genuinely recording.

  The shape that seems right: opt-in per campaign, a threshold rather than a
  trigger (N people in the channel for M minutes), and the bot **asks in the
  channel and waits** rather than joining silently — a recording that begins
  without anyone noticing is exactly what the original objection was about.
- **Session digest/reminder** — auto-post `/recap` the day before game night.
  Needs a "when is game night" concept that doesn't exist yet (a fixed
  day/time config, most likely) — a design question worth confirming before
  building, not something to guess at.

- **Talk time and the quiet player** — the durations start being recorded as of
  2026-08-31 (see the `endMs` fix above), so the data will exist from the next
  session onward. `markdown.js` already computes a per-speaker Talk time column
  and `transcript-view.js` already wanted one and worked around its absence, so
  the per-session half is nearly free. The part worth actually designing is the
  campaign-wide view: the player who has not spoken much in three sessions is
  the thing a DM most wants surfaced and least reliably notices themselves.

  Worth deciding first: who sees it. "Brett has spoken least three weeks
  running" is useful to a DM in private and unkind in a channel, so this is
  probably DM-only by default, and possibly opt-in per campaign.

- **Corrections that reach backwards** — `/correct` fixes a name from the next
  session on. Everything already written keeps the wrong spelling, and the
  vault's wikilinks stay broken for it, which is exactly where the cost lands:
  a name the graph cannot resolve is a name the campaign has effectively
  forgotten. The measured scale of this is not small — whisper wrote "Ben 10"
  for BenTen 37 times out of 40 across one session.

  The pieces exist (`corrections`, `linkify.js`, the transcripts in the
  database, the vault on disk); what is missing is the sweep and, more
  importantly, its safety. Rewriting stored transcripts is the most destructive
  thing this bot could be asked to do, so: dry-run diff first, a backup taken
  before the write, and never a silent bulk edit. Whole-word matching only —
  "Nick" as a correction target would otherwise eat every ordinary use of the
  word.

- **`/ready` — the question asked at 7pm on a Friday** — is the GPU server up,
  is the summariser answering, how much room is left on the Pi's card, is any
  job stuck, how many voices are free. Every probe already exists
  (`isWhisperServerReachable`, `isSummariserReachable`, the pool, the job
  queue); this is assembling them into one reply. Today, discovering the PC is
  off happens *after* three hours of recording, and the cost of that discovery
  is a session that waits until Monday.

