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

## Ideas not built yet

- **Thread resolution tracking** — `unresolvedThreads` only ever grows; nothing
  marks one resolved once a later session answers it.
- **Auto-join/leave on voice activity** — deliberately skipped so far, since it
  risks recording casual chatter that wasn't meant to be a session.
- **`/correct`** — fix a whisper-mangled fantasy name after the fact.
- **Session digest/reminder** — auto-post `/recap` the day before game night.
