# ADR-0004 — Discord is the entryway, the dashboard is the powerhouse

**Status:** accepted · 2026-08-29
**Replaces:** the rule formerly enforced by `test/dashboard-optional.test.js`

## What this reverses

There used to be a contract, tested on every run:

> The dashboard has to stay optional. Not "nice to have" optional — genuinely
> skippable. The moment something can ONLY be done on the dashboard, the
> dashboard stops being a convenience and becomes a dependency.

In practice that meant: every action a viewer below `dev` could reach on the web
page had to have a slash command doing the same job, listed in that file, or the
suite failed.

It is retired. Discord is the **entryway** — quick access, small setup, and
everything a person at the table does for themselves. The dashboard is where
this bot is **operated**.

## Why

**It taxed the wrong thing.** The queue, the compendium, the transcript reader,
the gatehouse, the model bill, the channel picker — none of these has a sensible
slash-command shape, and none ever wanted one. The rule did not stop those
being built; it just meant every control near the line paid for itself twice, in
two vocabularies, with two sets of refusal messages to keep in step.

**It had run out of room, silently.** `/campaign` sits at Discord's hard ceiling
of 25 subcommands. Adding a 26th throws inside discord.js's builder at import
time and the whole bot fails to start, with a message (`Invalid Array length`)
that names neither the command nor the limit. So the rule had quietly stopped
being "add the command too" and become "delete one of these first", which is a
wall rather than a principle. Discovered while adding `/campaign handover`.

**The two surfaces are not peers and pretending otherwise blurred both.** A
slash command is typed mid-session, by somebody with a character sheet open, in
five seconds. The dashboard is opened deliberately, by whoever runs the thing,
to look at a queue or a bill or three hours of transcript. Designing every act
for both produced controls that suited neither.

## What survives, and it is the part that mattered

**The acts that make somebody a participant stay in Discord.** A player agreed
to play D&D. They did not agree to open a web page, hold a session, or be
administered. So these are a floor, asserted in `test/entryway.test.js`:

- `/join`, `/leave` — starting and stopping a recording
- `/campaign consent` — answering whether they may be recorded, and withdrawing
- `/campaign setchar` — naming their own character
- `/campaign recap` — reading what happened last time
- `/campaign whoami` — finding out what the bot thinks they are
- `/campaign create` — claiming a table that has none

Plus one that is not about participation and is kept anyway: **correcting a
misheard name**. It is the commonest thing a DM does with a transcription bot
and it happens mid-session. Making somebody open a browser for it would be
absurd even under this ADR.

Everything above that line — managing, correcting in bulk, approving, metering,
admitting, deciding who runs what — may live on the dashboard alone.

## The consequence taken deliberately

Somebody who refuses to open the dashboard can play in campaigns, consent,
withdraw, read their recaps and fix a name. They cannot run the install. That is
now the intended shape rather than a regression.

The one thing to watch: an act that a **player** needs and that exists only on
the web page would be a real break of the line above, not merely a preference.
`entryway.test.js` guards the known ones; a new player-facing act should be
added to that list when it appears.
