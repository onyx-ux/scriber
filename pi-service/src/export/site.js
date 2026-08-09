import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionNotePath, sessionLabel } from './naming.js';

// A single self-contained HTML dashboard for the whole campaign, written
// alongside the markdown exports so it syncs to Drive/Obsidian like anything
// else. Deliberately NOT a server: no port to open on the Pi, no auth to get
// wrong, and it still works from a phone or a USB stick. Per-session detail
// lives in the .md files next to it; this is the index over them.

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function durationLabel(startedAt, endedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt ?? '').getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function list(items) {
  if (!items || items.length === 0) return '';
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function sessionCard(session, campaignName) {
  const { notes } = session;
  const date = (session.started_at || '').slice(0, 10);
  const duration = durationLabel(session.started_at, session.ended_at);
  // Matches export/naming.js — the note now lives at "<Campaign>/Session NN.md",
  // so a link built from the old flat pattern would 404 from the archive page.
  const { folder, filename } = sessionNotePath(session, campaignName);
  const mdName = `${folder}/${filename}`;

  const meta = [
    date,
    duration,
    session.lineCount ? `${session.lineCount} lines` : null,
  ]
    .filter(Boolean)
    .map((m) => `<span>${esc(m)}</span>`)
    .join('<i>·</i>');

  const sections = [
    notes.funnyMoments?.length ? `<h4>Moments worth remembering</h4>${list(notes.funnyMoments)}` : '',
    notes.partyDecisions?.length ? `<h4>Decisions</h4>${list(notes.partyDecisions)}` : '',
    notes.unresolvedThreads?.length ? `<h4>Unresolved</h4>${list(notes.unresolvedThreads)}` : '',
    notes.npcsIntroduced?.length ? `<h4>NPCs</h4>${list(notes.npcsIntroduced)}` : '',
    notes.locationsVisited?.length ? `<h4>Locations</h4>${list(notes.locationsVisited)}` : '',
    notes.lootAndRewards?.length ? `<h4>Loot</h4>${list(notes.lootAndRewards)}` : '',
  ]
    .filter(Boolean)
    .join('');

  // The searchable haystack is kept on the element so filtering is a plain
  // substring test — no index to build, no library to load.
  const haystack = [
    session.channel_name,
    date,
    notes.tldr,
    ...(notes.funnyMoments || []),
    ...(notes.npcsIntroduced || []),
    ...(notes.locationsVisited || []),
    ...(notes.partyDecisions || []),
    ...(notes.unresolvedThreads || []),
  ]
    .join(' ')
    .toLowerCase();

  return `<article class="session" data-search="${esc(haystack)}">
  <header>
    <h3>${esc(sessionLabel(session))} — ${esc(campaignName || session.channel_name)}</h3>
    <p class="meta">${meta}</p>
  </header>
  <p class="tldr">${esc(notes.tldr || 'No recap recorded.')}</p>
  ${sections ? `<details><summary>More detail</summary>${sections}</details>` : ''}
  <p class="file">Full transcript: <code>${esc(mdName)}</code></p>
</article>`;
}

// Same key the ledger dedupes on — the leading name, before any description.
function entityKey(item) {
  return String(item).toLowerCase().split(/\s+[—–-]\s+|,|\(/)[0].trim();
}

// Show an NPC or location on the session that actually introduced it, not on
// every session that happens to mention it again. Mirrors what the per-session
// recap does, so the archive doesn't re-list the same tavern fifty times.
function dropRepeats(sessions) {
  const seen = { npcsIntroduced: new Set(), locationsVisited: new Set() };
  const oldestFirst = [...sessions].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));

  return oldestFirst.map((session) => {
    const notes = { ...session.notes };
    for (const field of ['npcsIntroduced', 'locationsVisited']) {
      notes[field] = (session.notes[field] || []).filter((item) => {
        const key = entityKey(item);
        if (!key || seen[field].has(key)) return false;
        seen[field].add(key);
        return true;
      });
    }
    return { ...session, notes };
  });
}

export function renderCampaignSite(sessions, campaignName = null) {
  const ordered = dropRepeats(sessions).sort((a, b) =>
    String(b.started_at).localeCompare(String(a.started_at))
  );

  // Campaign-wide tallies, deduped case-insensitively the same way the
  // ledger does, so the counts match the ledger files.
  const uniq = (key) => {
    const seen = new Map();
    for (const s of ordered) {
      for (const item of s.notes[key] || []) {
        const k = entityKey(item);
        if (k && !seen.has(k)) seen.set(k, item);
      }
    }
    return [...seen.values()];
  };

  const npcs = uniq('npcsIntroduced');
  const locations = uniq('locationsVisited');
  const funny = ordered.flatMap((s) => (s.notes.funnyMoments || []).map((m) => ({ m, id: s.id })));
  const totalLines = ordered.reduce((sum, s) => sum + (s.lineCount || 0), 0);

  const stats = [
    [ordered.length, 'sessions'],
    [npcs.length, 'NPCs'],
    [locations.length, 'locations'],
    [totalLines, 'lines transcribed'],
  ]
    .map(([n, label]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(label)}</span></div>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campaign Archive — Scriber</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #faf8f4; --card: #fff; --ink: #22201d; --muted: #6b6560;
    --line: #e5ded4; --accent: #8a5a2b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #171513; --card: #201d1a; --ink: #ece7e1; --muted: #9a938b;
            --line: #322c26; --accent: #d9a066; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--ink);
         font: 16px/1.6 Georgia, 'Iowan Old Style', serif; }
  .wrap { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 2rem; font-size: .95rem; }
  .stats { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 2rem; }
  .stat { flex: 1 1 7rem; background: var(--card); border: 1px solid var(--line);
          border-radius: .6rem; padding: .8rem; text-align: center; }
  .stat b { display: block; font-size: 1.5rem; color: var(--accent); }
  .stat span { font-size: .8rem; color: var(--muted); }
  input[type=search] { width: 100%; padding: .7rem .9rem; font: inherit; font-size: .95rem;
                       border: 1px solid var(--line); border-radius: .6rem;
                       background: var(--card); color: var(--ink); margin-bottom: 1.5rem; }
  .session { background: var(--card); border: 1px solid var(--line); border-radius: .7rem;
             padding: 1.1rem 1.25rem; margin-bottom: 1rem; }
  .session h3 { margin: 0; font-size: 1.15rem; }
  .meta { margin: .2rem 0 .8rem; color: var(--muted); font-size: .85rem; }
  .meta i { margin: 0 .5rem; font-style: normal; opacity: .5; }
  .tldr { margin: 0 0 .6rem; }
  details summary { cursor: pointer; color: var(--accent); font-size: .9rem; }
  details h4 { margin: 1rem 0 .3rem; font-size: .85rem; text-transform: uppercase;
               letter-spacing: .05em; color: var(--muted); }
  details ul { margin: 0; padding-left: 1.2rem; }
  .file { margin: .8rem 0 0; font-size: .8rem; color: var(--muted); }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85em; }
  h2 { font-size: 1.2rem; margin: 2.5rem 0 .75rem; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
  .cols section { background: var(--card); border: 1px solid var(--line);
                  border-radius: .7rem; padding: 1rem 1.25rem; }
  .cols ul { margin: .3rem 0 0; padding-left: 1.1rem; font-size: .9rem; }
  .empty { color: var(--muted); font-style: italic; }
  footer { margin-top: 3rem; color: var(--muted); font-size: .8rem; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Campaign Archive</h1>
  <p class="sub">Generated by Scriber — ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}</p>

  <div class="stats">${stats}</div>

  <input type="search" id="q" placeholder="Search sessions, NPCs, locations…" autocomplete="off">

  <div id="sessions">
    ${ordered.length ? ordered.map((s) => sessionCard(s, campaignName)).join('\n') : '<p class="empty">No completed sessions yet.</p>'}
  </div>
  <p class="empty" id="noresults" hidden>Nothing matches that search.</p>

  ${
    funny.length
      ? `<h2>Moments worth remembering</h2><section class="cols"><section><ul>${funny
          .map((f) => `<li>${esc(f.m)} <small>(#${esc(f.id)})</small></li>`)
          .join('')}</ul></section></section>`
      : ''
  }

  <h2>Campaign index</h2>
  <div class="cols">
    <section><h4>NPCs</h4>${npcs.length ? list(npcs) : '<p class="empty">None recorded.</p>'}</section>
    <section><h4>Locations</h4>${locations.length ? list(locations) : '<p class="empty">None recorded.</p>'}</section>
  </div>

  <footer>Read-only snapshot. Full transcripts live in the .md files beside this page.</footer>
</div>
<script>
  const q = document.getElementById('q');
  const cards = [...document.querySelectorAll('.session')];
  const noResults = document.getElementById('noresults');
  q.addEventListener('input', () => {
    const term = q.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      const hit = !term || card.dataset.search.includes(term);
      card.hidden = !hit;
      if (hit) shown++;
    }
    noResults.hidden = shown > 0;
  });
</script>
</body>
</html>`;
}

export async function exportCampaignSite(db, guildId, cfg) {
  const meetings = db.listCompletedMeetings(guildId);
  const sessions = meetings.map((m) => {
    let notes = {};
    try {
      notes = JSON.parse(m.summary_json || '{}');
    } catch {
      notes = {};
    }
    return {
      id: m.id,
      // Carried so the link to the markdown uses the per-campaign session
      // number the file is actually named after, not the global meeting id.
      session_number: m.session_number,
      channel_name: m.channel_name,
      started_at: m.started_at,
      ended_at: m.ended_at,
      notes,
      lineCount: db.countUtterances(m.id),
    };
  });

  await mkdir(cfg.obsidianExportDir, { recursive: true });
  const path = join(cfg.obsidianExportDir, 'campaign-archive.html');
  await writeFile(path, renderCampaignSite(sessions, db.getCampaignName(guildId)), 'utf8');
  return path;
}
