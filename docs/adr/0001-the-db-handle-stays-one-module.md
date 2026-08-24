# ADR-0001 — The db handle stays one module

**Status:** accepted · 2026-08-21

## The suggestion this exists to stop

`pi-service/src/store/db.js` is 1,994 lines and exposes 100 methods on one
object, passed to roughly thirty modules. It is the largest file in the repo
and it catches the eye of everyone who reviews this codebase. The obvious
suggestion is to split it — per-concern stores over one connection: campaigns,
meetings and utterances, jobs, auth, model usage.

An architecture review raised it, examined it, and decided against.

## Why not

Apply the deletion test. If `db.js` were deleted, its complexity would not
concentrate somewhere better — it would spread. SQL would appear in thirty
modules that currently contain none, and the schema would stop having one
place where it is written down.

The module is **wide, not shallow**. Its interface is large, but each method
hides a real query and the implementation is far bigger than the interface.
Width alone is not a reason to split a module that passes.

Splitting it would also buy less than it looks. The handle is threaded through
the whole bot by `src/index.js`; per-concern stores would either be threaded
the same way — five parameters instead of one, at every call site — or bundled
back into one object, which is what exists now with more files.

## What was done instead

The one cluster with a real case was the credential tables. Nine `*Auth*`
methods existed for `web/auth.js`, which owns the hashing and is the only
module that can look a code up — but three others reached past it straight into
the store: `auth-routes.js` dropped a code, `actions.js` ended a person's
sessions, `server.js` swept expired ones.

That was the seam leaking rather than the store being too big: "where do
sessions get destroyed" had four answers, and a rule about credentials added in
`auth.js` would not have covered three of them. `auth.js` grew `abandonCode`,
`revokeAllSessions` and `sweepExpired`, and the auth tables are now reached from
exactly one module.

`db.js` itself was left alone.

## When to revisit

- If a second storage backend ever appears, the interface has to become a port
  and this decision is void.
- If a concern grows methods that genuinely nothing else touches — the way auth
  did — lift that cluster behind the module that owns it, as above. That is a
  narrowing of a seam, not a split of the store.
- Sheer line count is not a reason. Come back with a deletion test that says
  "concentrates".
