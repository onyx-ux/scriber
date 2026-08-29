# ADR-0003 — Tier 9 is a fourth way of being an operator, not a grantable level

**Status:** accepted · 2026-08-29

## The problem

The gatehouse offered tier 9 and called it "the house". Setting it did not make
that account an operator, and everybody who used the page expected it to.

That was not an oversight. `pi-service/src/access/tiers.js` and
`pi-service/src/web/viewer.js` between them make a specific argument:

- A **level** answers *what may they see*, and every one of them is derived
  from a fact the bot can check — `OWNER_USER_ID` names you, Discord says you
  own that server, a campaign names you as its manager, you actually spoke at
  that table. Nobody administers it, so nobody can be promoted by mistake.
- A **tier** answers *how much of the owner's GPU and API bill may they spend*.
  No fact in the world answers that. It is the person paying deciding what they
  are willing to pay, so it is granted, and it goes up as well as down.

Deriving a level from a tier would have broken the first half of that: a level
would become a thing somebody was awarded, which is exactly what `viewer.js`
exists to prevent. So the control looked broken and the alternative looked
worse.

## The decision

Tier 9 does not become a level. **It becomes a fourth way of *being* an
operator**, alongside `OWNER_USER_ID`, `OPERATOR_USER_IDS`, and — already —
the `STATUS_TOKEN` console.

The level then derives from that honestly, through the same line it always
did. `buildViewer` asks "does this person run this bot"; the answer now has
three sources instead of two; `dev` follows from it exactly as before. Nothing
in `viewer.js` grants anything, and the rule that levels are derived rather
than awarded survives intact.

Concretely: `access/operators.js` gains `runsThisBot(db, cfg, userId)`, and
every call site that asked `isOperator` **for authority** now asks that
instead. `isOperator` stays, unchanged, for the places that mean "which line of
the config file names you" — the gatehouse's own captions, and
`isPrimaryOperator`'s two uses.

## What stops somebody promoting themselves

The other two routes answer this with an SSH session. This one has to answer it
too, and it does, twice:

1. Only `dev` may set any tier at all. `ACTION_NEEDS` has gated `access/tier`
   on `everything` since tiers existed.
2. **Only an operator named in the file may hand out or take back tier 9** —
   `mayGrantHouseTier`, which asks `isOperator` and deliberately not
   `runsThisBot`. A tier-9 operator gets the machinery and cannot mint another
   one.

The second rule is enforced in both directions. If a house-tier operator could
not appoint another but could *remove* one, "who runs this bot" would still be
a question the dashboard could answer on its own.

## What this does not change

- **Tiers 0 to 4 are untouched.** They still answer only "how much may they
  spend", and none of them touches a level. Tier 9 is special because it always
  read as special.
- **The owner's DMs.** Approval, transcription and restore notices still go to
  `OWNER_USER_ID` alone. `delivery/` does not ask this module — see the note in
  `access/operators.js`.
- **Campaign adoption.** Unmanaged campaigns still go to `OWNER_USER_ID` on
  boot. A new operator arriving should not silently take ownership of games.
- **`tierOf`.** It still asks `isOperator`, not `runsThisBot`. A file-named
  operator is forced to tier 9; somebody on tier 9 already has it stored. Using
  the union there would be a question answering itself.

## The cost, stated plainly

Before this, the set of people who could spend the owner's money was fixed in a
file and survived anything that happened to the database. It no longer entirely
does: a row now confers it too.

That is a real reduction in what the file guarantees, taken deliberately,
because the alternative was a control that lied about what it did. The blast
radius is bounded by rule 2 above — the set of people who can *widen* that set
is still exactly the set the file names.
