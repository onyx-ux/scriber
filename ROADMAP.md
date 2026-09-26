# Roadmap

What is half-built, what is known to be wrong, and what is planned, with the
reasoning for each. What already shipped is in [CHANGELOG.md](CHANGELOG.md).

## Work in progress


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

The note this section is kept under is worth keeping, for the next time it has
anything in it: these are the operator’s own reports, written down before they
are argued with, and some of them will collide with a design decision recorded
on purpose. Whoever picks one up should read the argument before deciding
against it.

- **The privacy wording is fixed text, and some settings make it false**
  (found in the 2026-09-27 review, not yet fixed). The consent DM says "Your
  recording is never sent anywhere else" whatever the config says, and
  `GEMINI_TRANSCRIBE` or `DRIVE_SYNC_AUDIO` send audio to Google. The
  dashboard's Settings card says audio is "deleted once transcribed ... not
  kept, and this cannot be turned off", while `AUDIO_RETENTION_DAYS` keeps it
  14 days by default and `AUDIO_OFFLOAD_DIR` keeps a copy on the PC. The status
  payload already carries `cloudTranscribe`; neither the DM nor the card reads
  it. The fix is to build both from config, and to ask for consent again when
  the privacy terms change. See `campaign/consent.js` and the Audio card in
  `dashboard/html/dash/app/07-tabs.js`.

(The section was empty from 2026-09-06 until the entry above.)

Three of them had been sitting here long enough to be worth a note about the
shape they turned out to have. Not one was a broken feature. Two were invisible
in every rendered page and every test — line endings, and control bytes that
made whole files invisible to the tools looking for line endings. One was a
layout that only failed in a 200px band nobody develops at. And the fourth was
a decision written down as a fault: the Gemini rung was not inaccurate, it was
unlabelled, and the batched whisper path had been shipping the identical trade
unlabelled for months without anyone minding.

Which is an argument for how this section gets used rather than for anything in
particular: the entries that sit longest are the ones where nothing looks wrong
on screen.

## Ideas not built yet

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

- **Auto-join on voice activity** — deliberately skipped so far, since it
  risks recording casual chatter that wasn't meant to be a session. (The other
  half, ending a session when the channel empties, shipped 2026-09-27; see
  `VOICE_EMPTY_CLOSE_MINUTES`.)

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
- **Session digest/reminder** — auto-post `/campaign recap` the day before game night.
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

- **`/ready` — the question asked at 7pm on a Friday** — is the GPU server up,
  is the summariser answering, how much room is left on the Pi's card, is any
  job stuck, how many voices are free. Every probe already exists
  (`isWhisperServerReachable`, `isSummariserReachable`, the pool, the job
  queue); this is assembling them into one reply. Today, discovering the PC is
  off happens *after* three hours of recording, and the cost of that discovery
  is a session that waits until Monday.

