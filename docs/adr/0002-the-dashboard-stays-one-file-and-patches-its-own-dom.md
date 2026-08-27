# ADR-0002 — The dashboard stays one file, and patches its own DOM

**Status:** accepted · 2026-08-27

## The question this exists to answer

> Is the code base designed in the most efficient way and in the most efficient
> code language? Could we be more efficient with a different language like
> React or Node.js or any other coding language?

It comes up on every review of this repo, because `dashboard/html/index.html`
is 4,400 lines with 3,300 lines of JavaScript inside it and no build step
anywhere. That looks like something nobody got around to modernising.

It was examined properly. The answer is no to the rewrite and yes to one
specific thing React would have provided, which has been built instead.

## Where the work actually happens

The premise needs correcting first: this **is** Node. `pi-service` is ESM
throughout, `node src/index.js` to start, `node --test` to test.

More to the point, the expensive work is already not in JavaScript:

| Work | Runs in | Language |
| --- | --- | --- |
| Transcription | `ghcr.io/ggml-org/whisper.cpp:main-cuda` | C++ / CUDA |
| Resample, merge, compress | `ffmpeg`, via `spawn` | C |
| Opus decode | `@discordjs/opus` | C++ native |
| Every query | `better-sqlite3` | C++ |
| Deciding what to do | `pi-service/src` | JavaScript |

A three-hour session costs minutes of GPU and minutes of CPU. Node's share is
parsing JSON, running prepared statements and spawning processes — milliseconds
against minutes. A rewrite in Rust or Go would save microseconds on an
operation dominated by GPU seconds, and would cost `discord.js`, which has no
equivalent of comparable maturity in either language.

The division is already the right one: native code where the work is, a
scripting language where the decisions are.

## What the discipline is worth

Ten direct dependencies. 132 packages in `node_modules`. No bundler, no
transpiler, no build. `node:http` rather than Express, with the reason written
at the top of `web/server.js`. The dashboard deploys by copying a file.

That is the property most likely to be destroyed by modernising, and the
hardest to get back. React's smallest honest footprint is a build step, a
bundler, a lockfile with three digits in it, and a deploy that produces
artifacts rather than files.

## The real finding

The dashboard rebuilt every panel with `innerHTML` on a five-second poll.
`innerHTML` destroys and recreates every node underneath it, so a poll landing
while somebody was typing took the caret, the selection, the scroll offset and
any text the server had not heard about yet.

The page had worked around this three times:

1. `index.html` refused to refresh a pane at all while a field had focus,
   because "rebuilding the pane under them would throw the text away and move
   the caret".
2. The transcript search saved `selectionStart` and put it back by hand after
   re-rendering.
3. `gatehouse.html` redrew only its `#rows` element so the search box above it
   would survive.

The first was a functional bug rather than an annoyance:

```js
const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
if (typing()) { renderTop(); renderBanner(); return; }
```

Focus in **any** field froze the **whole** dashboard — recording state, job
progress, the session list — until the person clicked away. The cure for a
stolen caret was a dashboard that quietly stopped telling the truth, and
nothing said so on screen.

Three hand-rolled workarounds for one missing capability is a virtual DOM being
reinvented one site at a time. That is a real argument for React, and it is the
only one this review found.

## What was done instead

`dashboard/html/dash/morph.js` — about eighty lines, no dependencies. It
replaces `el.innerHTML = html` with `morph(el, html)`: parse the new markup into
a detached `<template>`, match its children against the ones already on screen,
patch what survived and only build what is genuinely new. Nodes that are still
wanted are never replaced, so everything the browser hangs off a node stays
with it.

Matching is by `data-key`, then `id`, then position **within the same tag** —
weaker than plain position on purpose, so a heading appearing above a list does
not shunt every row onto its neighbour's key. `data-key` is set on the six
lists that actually move: the gatehouse roster, session cards, campaign cards,
transcript lines, corrections and compendium entries.

A focused element is not touched at all. Not its value, not its class — writing
an identical attribute is cheap, but writing `class` on a focused element is
enough to interrupt a composition in some IMEs, and nothing this page has to
say to a field is urgent enough to be worth that.

All three workarounds are gone, including the freeze.

### Why not React, given that is exactly what React does

Because the cost is the whole build story and the benefit is one file. The page
has around twenty panels, a five-second poll and lists in the low hundreds;
what it needed was node identity across a redraw, not a component model, not
hooks, not a scheduler. Eighty lines with no dependencies buys the one thing
that was missing and keeps `cp index.html` as the deploy.

### Why the page was not split into modules

This was the other half of the original recommendation, and it was dropped
after looking at what it would actually cost.

The three page harnesses — `dashboard-render`, `dashboard-controls`,
`gatehouse-render` — extract `<script>` blocks from the HTML and run them in a
`vm` context against the real server. That is the safety net under every
dashboard change, and 32 tests depend on it. ES modules are not runnable in
`vm.runInContext` without `--experimental-vm-modules`; classic scripts split
across files share global scope and would buy navigable files while adding
round trips, a deploy tree and no encapsulation at all.

ADR-0001 already settled the general form of this question for `db.js`: *width
alone is not a reason to split a module that passes*. The dashboard is wide for
the same reason — many screens, one shared state — and the deletion test gives
the same answer. Splitting it would spread it, not concentrate it.

One file **was** extracted, and it earns the boundary the rest do not: two
pages need `morph`, and one copy of subtle code is worth a fetch where two
copies are not.

## Serving it

`/dash/morph.js`, absolute rather than relative, because the dashboard and the
gatehouse are served from different prefixes and a relative `src` would resolve
under each of them. It matches the existing convention for the `/api` constant.

**No nginx change was needed.** The file is not under `/app/`, so the catch-all
`location /` answers it, with the same five gate lines and the same document
root. The template's warning that a split "has to become a prefix location"
holds only for files added under `/app/` itself, and has been rewritten to say
so.

Verified against a real `nginx:alpine` with the real template: through the
tunnel from an address off the allow list, `/dash/morph.js` answers **401**
exactly as `/app/` and `/gatehouse/` do; from the LAN it answers **200** as
`application/javascript`.

## How it is tested

`test/morph.test.js` — 23 tests. The matching core is a pure function over two
lists of keys, separated from every DOM call precisely so it can be tested
without a browser. The patcher is exercised against a small hand-written DOM
that keeps the two rules this class of bug depends on: removing a node updates
the tree, and a field's `value` property stops tracking its attribute the
moment somebody types into it. There is no HTML parser in the fake and no need
for one — every tree is built by hand.

The one line the node suite cannot reach is `template.innerHTML = html`, where
a real parser turns markup into nodes. That, real focus and a real caret were
checked against headless Chrome over CDP: 16 assertions in isolation, then 10
more driving the real page against a real `startStatusServer` — type `ledg`
into the transcript search, put the caret at offset 2, let two polls land, and
confirm the field is the same node, still focused, still holding `ledg` with
the caret at 2, the filtered list still filtered, and the rest of the page
still updating.

The control walk in `dashboard-controls` was taught that `data-key` is identity
rather than a control, so a keyed row is not reported as a dead button.

## What this does not settle

**`better-sqlite3` is synchronous**, and all 165 prepared statements block the
event loop. WAL is on, and point lookups on a Pi are fine. A query scanning
`utterances` across a three-hour session is not obviously fine, and nothing has
measured it. That is a profiling question and the only place in this review
where a real stall is likely to be hiding.

**The page is still 4,400 lines.** This ADR argues that splitting it costs more
than it returns *today*, on the strength of the harness it would break and the
deletion test it fails. Neither is permanent. What would change the answer is a
second consumer for one of its screens, or a harness that no longer needs to
regex `<script>` out of the HTML.
