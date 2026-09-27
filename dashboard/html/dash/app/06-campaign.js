// dashboard/html/dash/app/06-campaign.js: The session column, the pane and the session reader, and the compendium shelves.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// The session column
// ==========================================================================

// --- folded, drawn over the page, and the ribbon that brings it back ---------
//
// Below 1181px the column used to be laid out above the pane with its pages
// absolutely positioned inside a frame of no height, so on a phone or a
// half-screen window it was simply not there: no sessions, no NPCs, no way to
// another night. It is a drawer there now, opened from the ribbon's menu
// button. On a wide window it is the column it always was, and the same
// button folds it away for a wider read; folded, the ribbon takes its place.
//
// Folded is this browser's preference, kept like the theme. The drawer is not
// kept at all: a phone reopening the page wants the write-up, not the menu.

const RAIL_KEY = 'quill-rail';
const RAIL_WIDE = '(min-width: 1181px)';
const railWide = () => window.matchMedia?.(RAIL_WIDE)?.matches ?? true;
function railFolded() {
  try { return localStorage.getItem(RAIL_KEY) === 'folded'; } catch (e) { return false; }
}
function setRailFolded(folded) {
  try {
    if (folded) localStorage.setItem(RAIL_KEY, 'folded');
    else localStorage.removeItem(RAIL_KEY);
  } catch (e) {}
}

const MENU_GLYPH = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const SHUT_GLYPH = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="m6.5 6.5 11 11m0-11-11 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// The top of the column: the same button in the same place as the ribbon's,
// so folding and unfolding is one spot on the screen, and the campaign's name,
// which on a phone is otherwise only in the top bar behind the drawer.
function columnBar(wide) {
  const c = campaign();
  const name = c?.name || detail?.name || c?.channel || 'This campaign';
  return `
    <div class="col-bar">
      <button type="button" class="menu-btn" data-rail aria-controls="campaign-column" aria-expanded="true"
              aria-label="${wide ? 'Fold the campaign column away' : 'Close the campaign menu'}"
              title="${wide ? 'Fold away' : 'Close'}">${wide ? MENU_GLYPH : SHUT_GLYPH}</button>
      <span class="col-name">${esc(name)}</span>
    </div>`;
}

// The ribbon over the pane, drawn whenever the column is not: the menu button,
// and the night being read as the largest thing on it. On a shelf that is not
// a night, the shelf is the name.
function ribbon(wide, folded, drawer) {
  const c = campaign();
  const s = view.shelf === 'sessions' ? selected() : null;
  const list = view.shelf === 'sessions' ? sessions() : [];
  const at = s ? list.findIndex((x) => x.meetingId === s.meetingId) : -1;
  const hero = s ? sessionName(s) : SHELVES.find(([id]) => id === view.shelf)?.[1] ?? 'Sessions';
  const kicker = s
    ? [longDate(s.startedAt), list.length > 1 ? `${list.length - at} of ${list.length}` : ''].filter(Boolean).join('  ·  ')
    : c?.name || c?.channel || '';
  const state = s && s.state !== 'posted' ? s.state : '';
  return `
    <div class="ribbon">
      <button type="button" class="menu-btn" data-rail aria-controls="campaign-column"
              aria-expanded="${wide ? !folded : drawer}"
              aria-label="${wide ? 'Show the campaign column' : 'Open the campaign menu'}"
              title="${wide ? 'Show the column' : 'Sessions, people, places'}">${MENU_GLYPH}</button>
      <div class="ribbon-hero">
        ${kicker ? `<div class="ribbon-kicker">${esc(kicker)}</div>` : ''}
        <div class="ribbon-name">${esc(hero)}</div>
      </div>
      ${state ? `<span class="pill ${state}">${esc(PILL_WORD[state] || state)}</span>` : ''}
    </div>`;
}

// Folds or unfolds on a wide window; opens or closes the drawer on a narrow
// one. Focus follows the button to wherever it now is, so a keyboard reader
// is never left on an element that has just been hidden.
function railToggle() {
  const wide = railWide();
  if (wide) setRailFolded(!railFolded());
  else view.drawer = !view.drawer;
  paint();
  const into = wide ? !railFolded() : view.drawer;
  document.querySelector(into ? '.col-bar .menu-btn' : '.ribbon .menu-btn')?.focus?.();
}

function drawerClose() {
  if (!view.drawer) return false;
  view.drawer = false;
  paint();
  document.querySelector('.ribbon .menu-btn')?.focus?.();
  return true;
}

const PILL_WORD = { posted: 'posted', approval: 'approval', failed: 'failed',
                    recording: 'recording', queued: 'queued', working: 'working' };

const SHELVES = [
  ['sessions', 'Sessions'],
  ['npcs', 'NPCs'],
  ['places', 'Places'],
  ['items', 'Items'],
  ['threads', 'Threads'],
];

const shelfCount = (id) => {
  if (id === 'sessions') return detail?.sessions?.length ?? 0;
  if (id === 'threads') return (detail?.threads ?? []).filter((t) => t.status === 'open').length;
  if (!compendium || compendium.campaignId !== view.campaignId || compendium.loading) return null;
  const list = id === 'npcs' ? compendium.npcs : id === 'places' ? compendium.places : compendium.items;
  return (list ?? []).length;
};

// Four ways into the same campaign, in the column that used to only ever hold
// sessions. Picking one collapses the other three sideways to nothing and
// leaves the choice sitting where the row was; clicking it again brings them
// back. The same gesture as the campaign rail, one level in.
// The column, one level in from the campaign rail and behaving the same way.
// It holds two pages side by side in a clipped frame: the list of the four
// things this campaign has, and whichever of them you picked. Choosing slides
// the chooser off to the left and the list in behind it; the header it leaves
// is the way back.

function shelfChooser() {
  const meta = {
    sessions: 'every night written up',
    npcs: 'everyone the party met',
    places: 'everywhere they went',
    items: 'what they came away with',
    threads: 'what is still unanswered',
  };
  return `
    <div class="head"><div class="cap">This campaign</div></div>
    <div class="sess-list">
      ${SHELVES.map(([id, name]) => {
        const count = shelfCount(id);
        return `<button type="button" class="shelf-row${view.shelf === id ? ' on' : ''}" data-shelf="${id}">
          <div class="l1">
            <span class="nm">${esc(name)}</span>
            ${count == null ? '' : `<span class="n">${count}</span>`}
          </div>
          <div class="meta">${meta[id]}</div>
        </button>`;
      }).join('')}
    </div>`;
}

function shelfHeader() {
  const name = SHELVES.find(([id]) => id === view.shelf)?.[1] ?? '';
  const count = shelfCount(view.shelf);
  const order = view.shelf === 'sessions' ? 'newest first' : view.shelf === 'threads' ? 'open first' : 'first seen first';
  return `
    <div class="head">
      <button type="button" class="shelf-back" data-shelf-back
              aria-label="Back to what this campaign holds">
        <span class="arw" aria-hidden="true">←</span>${esc(name)}${
          count == null ? '' : `<span class="n">${count}</span>`}
      </button>
      ${count ? `<span class="hint" style="margin-left:auto">${order}</span>` : ''}
    </div>`;
}

function columnList() {
  if (view.shelf === 'sessions') return sessionColumn();
  if (view.shelf === 'threads') return threadColumn();

  if (!compendium || compendium.campaignId !== view.campaignId) {
    buildCompendium();
    return '<div class="empty"><div class="quiet">Reading back through the campaign…</div></div>';
  }
  if (compendium.loading) {
    return '<div class="empty"><div class="quiet">Reading back through the campaign…</div></div>';
  }
  if (compendium.error) {
    return `<div class="empty">
      <div class="say">That did not read back.</div>
      <div class="quiet">${esc(compendium.error)}</div>
      <button type="button" class="btn sm" data-rebuild-compendium>Try again</button>
    </div>`;
  }

  // Items are one list, and the list is in the pane. So the column is the
  // way into it rather than a second copy of it: one row per night that
  // produced something, and picking one puts that night at the top of the
  // list. Two columns showing the same forty lines would have been a choice
  // between two identical things.
  if (view.shelf === 'items') {
    const items = compendium.items ?? [];
    if (!items.length) return `<div class="empty"><div class="say">Nothing found yet.</div>
      <div class="quiet">Anything a write-up names as loot collects here.</div></div>`;
    return `<div class="sess-list">${itemNights(items).map(({ session, rows }) => `
      <button class="sess" data-jump="night-${session.meetingId}" data-key="night-${session.meetingId}">
        <div class="l1">
          <span class="ref">${esc(sessionName(session))}</span>
          <span class="pill">${esc(plural(rows.length, 'item'))}</span>
        </div>
        <span class="when">${esc(longDate(session.startedAt))}</span>
      </button>`).join('')}</div>`;
  }

  const list = compendium[view.shelf] ?? [];
  if (!list.length) {
    const say = view.shelf === 'npcs'
      ? ['Nobody yet.', 'Everyone a write-up names collects here.']
      : ['Nowhere yet.', 'Everywhere a write-up names collects here.'];
    return `<div class="empty"><div class="say">${say[0]}</div><div class="quiet">${say[1]}</div></div>`;
  }

  // An index, not a second copy. The list itself is in the pane now, so the
  // column keeps the two things you scan a cast for — the name and the night
  // it walked on — and picking one lands on that name in the list. The rest
  // of what these rows used to carry, the opening line of what the write-ups
  // say, was the same sentence the pane was already showing.
  return `<div class="sess-list index">${list.map((e) => `
    <button class="sess thin${view.entry === `${view.shelf}:${e.key}` ? ' on' : ''}"
            data-key="entry-${esc(String(e.key))}"
            data-entry="${view.shelf}:${esc(e.key)}">
      <span class="ref">${esc(e.name)}</span>
      <span class="when">${esc(sessionName(e.first))}</span>
    </button>`).join('')}</div>`;
}

// --- Threads ---------------------------------------------------------------
//
// The campaign's open questions, and what became of them. Every write-up lists
// the threads a session left open, and nothing used to close one, so "still
// unresolved" only ever grew. They are rows with a status now (see
// pi-service/src/campaign/threads.js). The summariser may suggest a session
// settled one; the person running the table decides, here.

const THREAD_WORD = { open: 'open', resolved: 'resolved', dropped: 'dropped' };

// The column is an index into the pane, like the cast: one row per thread,
// open ones first, and a mark on any the summariser thinks were settled.
function threadColumn() {
  const list = detail?.threads ?? [];
  if (!list.length) {
    return `<div class="empty"><div class="say">Nothing open.</div>
      <div class="quiet">Every question a write-up leaves open collects here.</div></div>`;
  }
  return `<div class="sess-list index">${list.map((th) => `
    <button class="sess thin" data-jump="thread-${th.id}" data-key="thread-row-${th.id}">
      <span class="ref">${esc(th.text)}</span>
      <span class="when">${th.proposal && canManage() ? 'maybe settled' : esc(THREAD_WORD[th.status] ?? th.status)}</span>
    </button>`).join('')}</div>`;
}

function threadsPane() {
  const list = detail?.threads ?? [];
  const manage = canManage();
  const open = list.filter((t) => t.status === 'open');
  const suggested = manage ? open.filter((t) => t.proposal) : [];
  const stillOpen = open.filter((t) => !(manage && t.proposal));
  const closed = list.filter((t) => t.status !== 'open');
  const night = (n) => (n ? `Session ${n}` : 'an earlier session');

  const card = (th, body, buttons) => `
    <div class="card" id="thread-${th.id}" data-key="thread-${th.id}" style="margin-top:12px">
      <div class="big">${wiki(th.text)}</div>
      <div class="quiet" style="margin-top:6px">${body}</div>
      ${manage && buttons ? `<div class="row-btns" style="margin-top:12px">${buttons}</div>` : ''}
    </div>`;
  const setBtn = (th, status, label, cls = '') =>
    `<button type="button" class="btn sm ${cls}" data-act="threads/set" data-campaign="${detail.id}"
             data-thread="${th.id}" data-thread-status="${status}">${label}</button>`;

  return `
    ${ledgerHead('Threads', open.length ? `${plural(open.length, 'thread')} still open` : 'Nothing left open',
      'Every question a write-up leaves open, from the night it was raised. When a later session seems to answer one, Quill suggests closing it, and whoever runs the table decides.')}

    ${suggested.length ? `
      <div class="cap" style="margin-top:30px;color:var(--amber)">Maybe settled</div>
      ${suggested.map((th) => card(th,
        `Raised in ${night(th.openedSession)}. ${esc(night(th.proposal.session))} may have answered it: ${wiki(th.proposal.evidence || 'no reason given')}`,
        setBtn(th, 'resolved', 'Mark resolved', 'go') +
        `<button type="button" class="btn sm" data-act="threads/keep-open" data-campaign="${detail.id}" data-thread="${th.id}">Keep it open</button>`
      )).join('')}` : ''}

    ${stillOpen.length ? `
      <div class="cap" style="margin-top:30px">Open</div>
      ${stillOpen.map((th) => card(th, `Raised in ${night(th.openedSession)}.`,
        setBtn(th, 'resolved', 'Resolved') + setBtn(th, 'dropped', 'Drop it'))).join('')}` : ''}

    ${closed.length ? `
      <div class="cap" style="margin-top:30px">Closed</div>
      ${closed.map((th) => card(th,
        `${th.status === 'resolved' ? 'Resolved' : 'Dropped'}${th.closedSession ? ` in Session ${th.closedSession}` : ''}. Raised in ${night(th.openedSession)}.`,
        setBtn(th, 'open', 'Open it again'))).join('')}` : ''}

    ${!list.length ? '<div class="quiet" style="margin-top:24px">No write-up has left a question open yet.</div>' : ''}`;
}

// The shelf, as one document.
//
// Items, people and places are the same shape now: a list, read down the page,
// grouped under the night that put each line on it. A person used to be a
// page — a name, a date, and the sentence the summariser wrote on the night
// they walked on — so reading everyone the party met meant opening forty
// pages to collect what one list could hold, and reading down the cast is the
// thing anybody actually wants from this shelf.
function shelfPane() {
  if (view.shelf === 'threads') return threadsPane();
  if (!compendium || compendium.campaignId !== view.campaignId || compendium.loading) {
    return '<div class="quiet" style="padding-top:30px">Reading back through the campaign…</div>';
  }
  if (compendium.error) {
    return `<div style="padding-top:30px">
      <div class="say-2">That did not read back — ${esc(compendium.error)}</div>
      <button type="button" class="btn sm" style="margin-top:16px" data-rebuild-compendium>Try again</button>
    </div>`;
  }
  return view.shelf === 'items' ? itemLedger() : castLedger();
}

// What a ledger opens with, and the rule that divides it. Written once for all
// three shelves so they cannot drift into three slightly different pages.
function ledgerHead(kicker, head, say) {
  return `
    <div class="kicker" style="margin-top:26px">${esc(kicker)}</div>
    <h1 class="display sm" style="margin-top:12px">${esc(head)}</h1>
    <div class="say-2 measure">${say}</div>`;
}

function nightRule(session) {
  return `
    <div class="ledger-night" id="night-${session.meetingId}" data-key="night-${session.meetingId}">
      <span class="n">${esc(sessionName(session))}</span>
      <span class="d">${esc(longDate(session.startedAt))}</span>
      <button type="button" class="btn sm ghost" data-session="${session.meetingId}">Open</button>
    </div>`;
}

// The nights that produced something, each with what it produced. Built the
// same way for the column and for the pane, so the two can never disagree
// about which night an item belongs to.
function itemNights(items) {
  const nights = [];
  for (const row of items ?? []) {
    const at = nights.find((x) => x.session.meetingId === row.session.meetingId);
    if (at) at.rows.push(row);
    else nights.push({ session: row.session, rows: [row] });
  }
  return nights;
}

// The cast, under the night each name turned up. Grouped on `first` and not on
// every night a name appears in: an item belongs to one evening, but a person
// recurs, and printing them again under each return would make the list longer
// than the campaign.
function castNights(list) {
  const nights = [];
  for (const e of list ?? []) {
    const at = nights.find((x) => x.session.meetingId === e.first.meetingId);
    if (at) at.rows.push(e);
    else nights.push({ session: e.first, rows: [e] });
  }
  return nights;
}

// A folded key is lowercase words with spaces between them, and an id may not
// carry a space. One function, so the row that gets written and the row that
// gets scrolled to can only ever be the same row.
const entryId = (kind, key) => `entry-${kind}-${String(key ?? '').replace(/\s+/g, '-')}`;

// One list, holding every item the campaign has come away with.
function itemLedger() {
  const items = compendium.items ?? [];
  if (!items.length) {
    return ledgerHead('Items', 'Nothing found yet.', `
      Anything a write-up names as loot collects here, under the night the party came away with it.
      Coin and experience are left out — those are what a night was worth rather than something to carry.`);
  }

  const nights = itemNights(items);

  return `
    ${ledgerHead('Items', `${plural(items.length, 'item')}, in the order they were found.`, `
      Nothing here was written for this page — every line is what the summariser said at the time,
      gathered out of ${esc(plural(nights.length, 'write-up'))}. Coin and experience are left out.`)}
    <div class="ledger measure">
      ${nights.map(({ session, rows }) => `
        ${nightRule(session)}
        ${rows.map((row) => `<div class="ledger-row"><span class="thing">${wiki(row.text)}</span></div>`).join('')}`).join('')}
    </div>`;
}

// What each of the two cast shelves calls itself. They differ in every
// sentence — you meet people and you go places — and the one word that would
// have covered both is "entries", which is what the software calls them and
// not what they are.
const CAST_WORDS = {
  npcs: {
    kicker: 'NPCs',
    unit: 'name',
    none: 'Nobody yet.',
    order: 'in the order the party met them',
    fills: 'Everyone a write-up names collects here, under the night the party met them.',
  },
  places: {
    kicker: 'Places',
    unit: 'place',
    none: 'Nowhere yet.',
    order: 'in the order the party found them',
    fills: 'Everywhere a write-up names collects here, under the night the party first went there.',
  },
};

// Everyone the party met, or everywhere it went, as one list.
function castLedger() {
  const w = CAST_WORDS[view.shelf];
  const list = compendium[view.shelf] ?? [];
  const read = compendium.story?.length ?? 0;

  if (!list.length) {
    return ledgerHead(w.kicker, w.none, read
      ? `Quill has read ${esc(plural(read, 'write-up'))} for this campaign and none of them named
         one worth keeping. ${esc(w.fills)}`
      : `Nothing is written up yet. ${esc(w.fills)}`);
  }

  const nights = castNights(list);
  // Every night that named somebody — which is where these lines came from,
  // and not the same as the nights in the headings: a name introduced on the
  // first night collects sentences from every night it comes back in.
  const heard = new Set(list.flatMap((e) => e.seen.map((s) => s.meetingId))).size;

  return `
    ${ledgerHead(w.kicker, `${plural(list.length, w.unit)}, ${w.order}.`, `
      Nothing here was written for this page — every line is what the summariser said at the time,
      gathered out of ${esc(plural(heard, 'write-up'))}.`)}
    <div class="ledger measure">
      ${nights.map(({ session, rows }) => `
        ${nightRule(session)}
        ${rows.map(castRow).join('')}`).join('')}
    </div>`;
}

// One name in the ledger: the name, the nights it came back in, whatever the
// write-ups have said about it, and the aside that belongs to it.
//
// The return run leaves out the night in the heading above rather than the
// first night in the list, and those are the same night only while a name is
// sorted under the night it walked on. Matched on the meeting rather than
// sliced off the front, so it stays true if that ever stops being the case.
function castRow(e) {
  const here = `${view.shelf}:${e.key}`;
  const back = e.seen
    .filter((s) => s.meetingId !== e.first.meetingId)
    .map((s) => s.sessionNumber)
    .filter((no) => no != null)
    .sort((a, b) => a - b);
  const shown = back.slice(0, 6);
  const id = entryId(view.shelf, e.key);

  return `
    <div class="cast-row" id="${id}" data-key="${id}">
      <div class="nm">${esc(e.name)}</div>
      ${shown.length ? `<div class="again">back in <b>${
        shown.map((no) => esc(String(no))).join(' · ')
      }</b>${back.length > shown.length ? ` +${back.length - shown.length}` : ''}</div>` : ''}
      ${e.said.length || e.asides.length ? `<div class="cast-said">
        ${e.said.map((pt) => `<p>${wiki(pt.text, here)}</p>`).join('')}
        ${e.asides.map((a) => `<div class="entry-aside">${wiki(a.text, here)}</div>`).join('')}
      </div>` : ''}
    </div>`;
}

function sessionColumn() {
  const list = sessions();
  if (!list.length) {
    return `
      <div class="empty">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="opacity:.5" aria-hidden="true">
          <path d="M20.5 2.6c-7 .9-11.8 5-14 11.4l-1.7 4.9 4.8-1.7C16 15 20 10.2 20.5 2.6Z" stroke="#8A8578" stroke-width="1.2" stroke-linejoin="round"/>
          <path d="M5.1 19.6 2.6 22.2" stroke="#8A8578" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        <div class="say">Nothing here until you play.</div>
        <div class="quiet">
          Two of you in <span class="mono" style="color:var(--text-2)">${esc(detail?.channel || 'the voice channel')}</span>
          is enough — Quill joins on its own and this fills in.
        </div>
      </div>`;
  }
  return `<div class="sess-list">${list.map(sessionCard).join('')}</div>`;
}

function sessionCard(s) {
  const facets = [
    s.npcs ? plural(s.npcs, 'NPC') : '',
    s.locations ? plural(s.locations, 'location') : '',
    s.threads ? `${plural(s.threads, 'thread')} open` : '',
  ].filter(Boolean);

  const when = [
    shortDate(s.startedAt),
    s.lines ? `${n(s.lines)} lines` : s.state === 'recording' ? 'recording' : 'no audio',
  ].filter(Boolean).join(' · ');

  // One line about the session, in the summariser's own words where they
  // exist. Where they do not, the state is the sentence — which is the whole
  // reason the column is readable at a glance.
  const say = s.tldr
    ? `<div class="say">${esc(trim(s.tldr, 190))}</div>`
    : s.state === 'failed'   ? '<div class="plain">No usable audio in this session.</div>'
    : s.state === 'approval' && s.job?.type === 'summarize'
      ? '<div class="plain">Transcript is ready. Nothing has been summarised or posted yet.</div>'
    : s.state === 'approval' ? '<div class="plain">Waiting for you to say when it may transcribe.</div>'
    : s.state === 'working'  ? '<div class="plain">Being worked on now.</div>'
    : s.state === 'queued'   ? '<div class="plain">In the queue.</div>'
    : '';

  const flags = [
    view.meetingId === s.meetingId ? 'on' : '',
    s.state === 'failed' ? 'failed dead' : '',
    s.state === 'approval' ? 'needs' : '',
  ].filter(Boolean).join(' ');

  // The name of the night, its state, and then — on a line of its own — when
  // it was and how much of it there is. Those three used to share one line and
  // the name came third in the fight for it, which on a narrow column left
  // "Session 12" wrapping underneath a word of its own date.
  return `
    <button class="sess ${flags}" data-session="${s.meetingId}" data-key="sess-${s.meetingId}">
      <div class="l1">
        <span class="ref">${esc(sessionName(s))}</span>
        <span class="pill ${s.state}">${esc(PILL_WORD[s.state] || s.state)}</span>
      </div>
      <span class="when">${esc(when)}</span>
      ${say}
      ${facets.length ? `<div class="facets">${facets.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
    </button>`;
}

const trim = (s, max) =>
  s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, '')}…` : s;

// ==========================================================================
// The pane: four tabs, and the session reader under "Notes"
// ==========================================================================

// Reading comes first, because reading is what this pane is for and it is
// what nine visits in ten are. Corrections is second: it is the thing you go
// and do having just read a name that came back wrong, so it sits next to
// where you noticed. The table is third — a roster is looked at when somebody
// joins or leaves, which is not weekly.
//
// Settings is not a fourth thing to read, so it does not stand in the row of
// things that are. It is what the person who runs this campaign does TO it,
// and everybody else's click on it landed on a page of values they could not
// change — so it is pushed to the far end of the strip, in the utility face
// this page gives its controls, and drawn only for them.
// The first tab keeps its name whatever is being read under it.
//
// It used to take the shelf's name — Notes, then NPC, then Place — which made
// three of the four labels fixed and one of them move, so the strip could not
// be aimed at from memory. It also said the word twice: the kicker at the top
// of an NPC page already reads NPC, forty pixels below a tab reading NPC.
// The tab is where the reading lives; the kicker is what kind of reading it
// is. One name each.
function tabsBar() {
  if (!detail) return '';
  const tabs = [
    ['notes', 'Notes', 0],
    ['corrections', 'Corrections', detail.corrections.length],
    ['table', 'The table', detail.roster.length],
  ];
  return `<div class="tabs">${tabs.map(([id, name, count]) => `
    <button class="tab${view.tab === id ? ' on' : ''}" data-tab="${id}">
      ${esc(name)}${count ? `<span class="n">${count}</span>` : ''}
    </button>`).join('')}${canManage() ? `
    <button class="tab apart${view.tab === 'settings' ? ' on' : ''}" data-tab="settings">
      Settings
    </button>` : ''}</div>`;
}

function paneBody() {
  if (!detail) return '<div class="quiet" style="padding-top:30px">Loading…</div>';
  if (view.tab === 'table') return rosterTab();
  if (view.tab === 'corrections') return correctionsTab();
  // Settings belongs to whoever runs this campaign. Anybody else — including
  // somebody who was managing it a moment ago and is not now — gets the
  // reading rather than a screen of values they cannot move.
  if (view.tab === 'settings') return canManage() ? settingsTab() : sessionReader();
  if (view.shelf !== 'sessions') return shelfPane();
  return sessionReader();
}

// --- Notes: whatever this session actually is ------------------------------

function sessionReader() {
  const s = selected();
  if (!s) {
    const list = sessions();
    return `<div style="padding-top:60px;max-width:60ch">
      <div class="display sm">${list.length ? 'Pick a session.' : 'Nothing to read yet.'}</div>
      <div class="say-2">${list.length
        ? 'The list on the left is every session this campaign has. Anything waiting on a decision says so.'
        : 'When Quill records a session, its notes land here as soon as the summariser has written them.'}</div>
    </div>`;
  }

  if (s.state === 'recording') return recordingPane(s);
  if (s.state === 'failed') return failedPane(s);
  if (s.job?.status === 'awaiting_approval' && s.job.type === 'summarize') return approvalPane(s);
  if (s.job?.status === 'awaiting_approval' && s.job.type === 'transcribe') return transcribePane(s);
  if (s.job && !s.hasNotes) return queuedPane(s);
  return notesPane(s);
}

// Which session this is, what is in it, and — when the caller has any — what
// can be done to it, pushed to the far end of the same line.
function sessionKicker(s, tone = '', doings = '') {
  const bits = [
    s.lines ? `${n(s.lines)} lines` : null,
    runtime(s.durationMs) ? `${runtime(s.durationMs)} recorded` : null,
    s.job?.provider ? providerName(s.job.provider) : null,
  ].filter(Boolean);
  return `
    <div class="session-line">
      <div class="kicker ${tone}">${esc(sessionName(s))} · ${esc(longDate(s.startedAt))}</div>
      ${bits.length ? `<span class="mono" style="font-size:11.5px;color:var(--dim)">${esc(bits.join(' · '))}</span>` : ''}
      ${doings ? `<div class="doings">${doings}</div>` : ''}
    </div>`;
}

// The notes, read as a document.
//
// The headline is the first scene's own title. Nothing in the stored recap is
// a title for the whole session — the schema has never had one — so rather
// than inventing a phrase, this borrows the one the summariser actually wrote
// for where the session opens, and falls back to the session's ref.
function notesPane(s) {
  if (!notes || notes.meetingId !== s.meetingId) {
    return `${sessionKicker(s, 'done')}<div class="say-2">Opening…</div>`;
  }
  if (notes.unreadable) {
    return `
      ${sessionKicker(s, 'broken')}
      <h1 class="display" style="margin-top:12px">These notes will not open.</h1>
      <div class="say-2">
        The summary is on disk but is not valid JSON, so nothing can read it — not this page, not the
        Obsidian export, not <code>/recap</code>. Writing them again fixes it; the transcript is untouched.
      </div>
      <div class="row-btns" style="margin-top:22px">
        ${can() ? `<button type="button" class="btn go" data-act="summary/again" data-meeting="${s.meetingId}">Write them again</button>` : ''}
        ${cap('transcripts') ? `<button class="btn" data-transcript="${s.meetingId}">Read the transcript</button>` : ''}
      </div>`;
  }
  if (!notes.written) {
    return `
      ${sessionKicker(s)}
      <h1 class="display" style="margin-top:12px">Not written up yet.</h1>
      <div class="say-2">This session has a transcript but no notes. Summarising posts them the usual way.</div>
      <div class="row-btns" style="margin-top:22px">
        ${can() ? `<button type="button" class="btn go" data-act="summary/again" data-meeting="${s.meetingId}">Summarise it</button>` : ''}
        ${cap('transcripts') ? `<button class="btn" data-transcript="${s.meetingId}">Read the transcript</button>` : ''}
      </div>`;
  }

  const heading = notes.scenes[0]?.title && notes.scenes[0].title !== 'Untitled scene'
    ? notes.scenes[0].title
    : sessionName(s);

  // What you can do to this write-up, on the line that says which write-up it
  // is — above the headline rather than between the headline and the first
  // sentence, where it made you read past a toolbar to get into the prose.
  // It also used to share a wrapping flex row with the headline, so a long
  // title put the buttons on their own line and a short one did not: the same
  // four controls moved between two places depending on the words above them.
  // Here they have one home.
  // Reading or correcting, and it goes first because it changes what every
  // other control on this line is for. The words are the two things you can
  // be doing rather than two things you can press: a switch labelled Edit
  // says what will happen, and a switch labelled Correcting says where you
  // are, which is the question somebody halfway down a paragraph is asking.
  const doings = `
    <div class="row-btns">
      ${mayMark() ? `
        <div class="seg" data-seg="marking">
          <button type="button" class="${marking() ? '' : 'on'}" data-mark="read">Reading</button>
          <button type="button" class="${marking() ? 'on' : ''}" data-mark="correct">Correcting</button>
        </div>` : ''}
      ${cap('transcripts') ? `<button class="btn sm" data-transcript="${s.meetingId}">Transcript</button>` : ''}
      ${canManage() ? `<button type="button" class="btn sm" data-fix-name>Fix a name</button>` : ''}
      ${can() ? `<button type="button" class="btn sm" data-act="summary/again" data-meeting="${s.meetingId}"
           data-confirm="Write the notes for ${esc(sessionName(s))} again?">Re-summarise</button>` : ''}
      <button class="btn sm ghost" data-copy-notes>Copy for Obsidian</button>
    </div>`;

  // Who and where, for the margin — see .sidenote.
  //
  // Each entry is claimed by the first scene that names it, using the same
  // word-boundary rule the wikilinker uses, so a note stands beside the very
  // sentence its name is underlined in. Matched case-insensitively, unlike
  // the wikilinker: a summary lists a place as "The Ashen Vaults" and the
  // prose then writes "the stair into the Ashen Vaults", and an article that
  // lost its capital is not a different place. Anything the scenes never name — a
  // person mentioned only in the summary above, or one the summariser listed
  // without writing about — falls to the foot of the margin rather than being
  // dropped.
  const marginalia = [
    ...notes.npcsIntroduced.map((e) => ({ ...splitEntry(e), kind: 'Who' })),
    ...notes.locationsVisited.map((e) => ({ ...splitEntry(e), kind: 'Where' })),
  ].filter((m) => m.name);

  const unclaimed = new Set(marginalia.map((m) => m.name));

  const sidenote = (m) => `
    <aside class="sidenote">
      <span class="sidenote-kind">${esc(m.kind)}</span>
      <span class="sidenote-name">${esc(m.name)}</span>
      ${m.rest ? `<span class="sidenote-what">${wiki(m.rest)}</span>` : ''}
    </aside>`;

  const marginFor = (passage) => marginalia
    .filter((m) => unclaimed.has(m.name) && new RegExp(
      `(^|[^A-Za-z0-9'\u2019])${escapeRe(m.name).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`,
      'i',
    ).test(passage))
    .map((m) => { unclaimed.delete(m.name); return sidenote(m); })
    .join('');

  // Called after the scenes have had their pick, so the set is final.
  const marginRest = () =>
    marginalia.filter((m) => unclaimed.has(m.name)).map(sidenote).join('');

  // A band that does not scroll away, so nobody types into a page they have
  // forgotten they are correcting. It says the one thing that makes this
  // safe to be in — the original is kept — and carries the way out.
  const band = marking() ? `
    <div class="mark-band">
      <svg class="nib" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 14l1.2-3.4L11 2.8a1.4 1.4 0 012 2L5.4 12.8 2 14z"
              stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      </svg>
      <span class="what">
        <b>You are correcting this write-up.</b>
        <span>Click any line to change it, or strike it out.</span>
        <span>What the summariser wrote is kept underneath &mdash; nothing here can delete it,
        and taking a correction away puts the original line straight back.</span>
      </span>
      ${notes.corrections ? `<span class="tally">${notes.corrections} correction${notes.corrections === 1 ? '' : 's'}</span>` : ''}
      <button type="button" class="btn sm" data-mark="read">Done</button>
    </div>` : '';

  return `
    <div class="writeup${marking() ? ' marking' : ''}">
    ${sessionKicker(s, 'done', doings)}
    ${band}
    <h1 class="display" style="margin-top:14px">${esc(heading)}</h1>

    ${nameFixer()}

    ${partLines('tldr').length ? `<div class="lede measure" id="part-0" data-part="How it opens">
      ${partLines('tldr').map((e) => drawLine('tldr', e)).join(' ')}</div>` : ''}

    ${notes.scenes.length ? `
      <div class="cap" style="margin:32px 0 4px">What happened</div>
      <div class="measure">
        ${notes.scenes.map((scene, i) => `
          <div class="scene" id="part-${i + 1}" data-part="${esc(scene.title)}">
            ${marginFor([scene.title, ...scene.points].join(' '))}
            ${i === 0 && scene.title === heading ? '' : `<h4>${partLines(`scene:${i}:title`)
              .map((e) => drawLine(`scene:${i}:title`, e)).join(' ') || esc(scene.title)}</h4>`}
            <p>${partLines(`scene:${i}`).map((e) => drawLine(`scene:${i}`, e)).join(' ')}</p>
          </div>`).join('')}
        ${marginRest()}
      </div>` : ''}

    ${partLines('partyDecisions').length ? `
      <div id="part-decisions" data-part="Party decisions">
        <div class="cap" style="margin:32px 0 10px">Party decisions</div>
        ${numberedList('partyDecisions')}
      </div>` : ''}

    ${partLines('followUps').length ? `
      <div id="part-followups" data-part="Follow-ups">
        <div class="cap" style="margin:32px 0 10px">Follow-ups</div>
        ${numberedList('followUps')}
      </div>` : ''}

    ${previousVersions()}
    ${orphanedMarks()}

    <div class="recap-extras measure">${recapSections(notes)}</div>
    </div>`;
}

// Corrections whose line is not in the write-up any more.
//
// Never dropped and never hidden. A correction is somebody’s own words about
// their own game, and losing one quietly is the failure this whole feature is
// a defence against — so when the text it was written about has gone, it is
// shown apart, with the line it used to strike through.
function orphanedMarks() {
  const lost = notes?.orphaned ?? [];
  if (!marking() || !lost.length) return '';
  return `
    <div class="measure" style="margin-top:34px">
      <div class="cap" style="margin-bottom:10px">Corrections with nowhere left to sit</div>
      <div class="quiet" style="max-width:62ch;margin-bottom:14px">
        The lines these were written about are not in this write-up any more. They are kept
        because they are somebody&rsquo;s own account of their own game, and nothing here throws
        one of those away.
      </div>
      <div class="stack">
        ${lost.map((m) => `
          <div>
            <div class="what"><span class="mstruck">${wiki(m.quoted)}</span></div>
            <div class="who"><span class="mnew${markVoice(m)}">${m.body ? wiki(m.body) : 'struck out'}</span>
              <span class="mwho">${esc(nameOf(m.userId))}</span></div>
          </div>`).join('')}
      </div>
    </div>`;
}

// Where the corrections on an earlier write-up went.
//
// Re-summarising is the one act that genuinely destroys what a correction was
// written about, so the old write-up and its redlines are kept whole rather
// than re-anchored onto text nobody wrote them about. This is the line that
// says so, and it is shown in both states: somebody reading needs to know the
// table said something about the version before this one.
function previousVersions() {
  const had = (notes?.previous ?? []).filter((v) => v.notes > 0);
  if (!had.length) return '';
  const total = had.reduce((sum, v) => sum + v.notes, 0);
  return `
    <div class="quiet measure" style="margin-top:30px">
      ${total} correction${total === 1 ? '' : 's'} ${total === 1 ? 'belongs' : 'belong'} to an earlier
      write-up of this night, kept with it. Re-summarising never takes them with it.
    </div>`;
}

// A list of things the table decided, or has still to do.
//
// Numbered only from two upwards. A number is a claim that the order matters
// and that there is something to come after this one; "01" over a single line
// makes both claims and neither is true. One decision is a decision, and it
// gets the same hanging indent so it still lines up with the list it would be
// part of if there were more of them.
// Takes the part rather than the lines, because the numbers have to survive
// one of them being struck out: a list of three whose second is gone reads 01
// and 02 to somebody reading and 01, 02, 03 to somebody correcting, and only
// the part knows which of those it is.
function numberedList(part) {
  const lines = partLines(part);
  const numbered = lines.length > 1;
  return `<div class="numbered measure">
    ${lines.map((e, i) => `
      <div><span class="i">${numbered ? String(i + 1).padStart(2, '0') : '·'}</span>
        <span>${drawLine(part, e)}</span></div>`).join('')}
  </div>`;
}

// Fixing a misheard name, on the page where you notice it.
//
// The correction list lives on its own tab, which is the right home for the
// rules but the wrong place to write one: nobody opens a list of corrections
// and remembers a name from there. You meet the mangled name in the middle of
// a recap, and that is where the fix belongs — the same two boxes, opened
// under the write-up that made you want them.
function nameFixer() {
  if (!view.fixing || !canManage() || !detail) return '';
  return `
    <form class="pair" data-act="corrections/add" data-campaign="${detail.id}" style="margin-top:26px">
      <label>Written as
        <input class="in" name="wrong" placeholder="the name as these notes have it" required>
      </label>
      <span class="pair-arrow" aria-hidden="true">→</span>
      <label>Should read
        <input class="in" name="right" placeholder="what it should say" required>
      </label>
      <button class="btn go" type="submit">Fix it everywhere</button>
      <button type="button" class="btn ghost" data-fix-cancel>Cancel</button>
    </form>
    <div class="quiet measure" style="margin-top:12px">
      Every transcript and write-up in the campaign reads it the right way, past sessions included.
      What was heard is kept underneath, so removing the correction puts it back.
    </div>`;
}

// The session that is waiting for you to spend money on it. The whole point of
// moving approvals off Discord: the decision, and the thing it is about, on
// one screen.
function approvalPane(s) {
  const providers = status?.providers ?? [];

  return `
    ${sessionKicker(s, 'wait')}
    <h1 class="display" style="margin-top:12px">Not written up yet</h1>
    <div class="say-2">
      The transcript is on file — ${plural(s.lines, 'line')}${runtime(s.durationMs) ? ` over ${runtime(s.durationMs)}` : ''},
      corrections already applied. Nothing has been summarised and nothing has been posted.
      ${providers.length > 1 ? 'Pick who writes the notes.' : ''}
    </div>
    ${can() ? `
      <div class="row-btns" style="margin-top:22px">
        ${providers.length
          ? providers.map((p, i) => `
              <button type="button" class="btn ${i === 0 ? 'go big' : 'big'}" data-act="summary/approve"
                      data-job="${s.job.id}" data-provider="${esc(p)}">
                ${i === 0 ? `Summarise with ${esc(providerName(p))}` : esc(providerName(p))}
              </button>`).join('')
          : `<button type="button" class="btn go big" data-act="summary/approve" data-job="${s.job.id}">Summarise now</button>`}
        <button type="button" class="btn big" data-act="summary/park" data-job="${s.job.id}">Leave it parked</button>
        <span class="mono" style="font-size:11.5px;color:var(--dim);margin-left:6px">
          notes post to ${esc(destination())} when they are ready
        </span>
      </div>` : disabledNote()}
    ${transcriptPeek(s)}`;
}

function transcribePane(s) {
  return `
    ${sessionKicker(s, 'wait')}
    <h1 class="display" style="margin-top:12px">Waiting to transcribe</h1>
    <div class="say-2">
      This session is recorded and sitting on the Pi. Transcribing it uses the GPU on your PC, so Quill
      asks first rather than seizing the machine in the middle of your evening.
    </div>
    ${can() ? `
      <div class="row-btns" style="margin-top:22px">
        <button type="button" class="btn go big" data-act="transcribe" data-job="${s.job.id}" data-action="now">Transcribe now</button>
        <button type="button" class="btn big" data-act="transcribe" data-job="${s.job.id}" data-action="later">Not yet</button>
        <button type="button" class="btn big" data-act="transcribe" data-job="${s.job.id}" data-action="pi">On the Pi instead</button>
        ${status?.health?.cloudTranscribe ? `
          <button type="button" class="btn big" data-act="transcribe" data-job="${s.job.id}" data-action="gemini"
                  data-confirm="Transcribe this session with Gemini? The recording itself is uploaded to Google — this is the only part of Quill that does that.">Send to Gemini</button>` : ''}
      </div>
      ${status?.health?.cloudTranscribe ? `
        <div class="quiet" style="margin-top:14px;color:var(--brass-lit)">
          “Send to Gemini” uploads the recording to Google. Minutes rather than hours,
          and better on names — but the line breaks and times come back approximate,
          and the transcript will say so.
        </div>` : ''}
      <div class="quiet" style="margin-top:14px">
        “On the Pi” needs no GPU at all, and takes hours rather than minutes.
        ${status?.schedule?.nextAutoWindowAt
          ? `Left alone, the next automatic window opens ${esc(longDate(status.schedule.nextAutoWindowAt))} at ${esc(hhmm(status.schedule.nextAutoWindowAt))}.`
          : ''}
      </div>` : disabledNote()}`;
}

function queuedPane(s) {
  const live = (status?.working?.transcribing ?? []).find((t) => t.meetingId === s.meetingId);
  const done = live?.done ?? 0;
  const total = live?.total ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return `
    ${sessionKicker(s)}
    <h1 class="display" style="margin-top:12px">${live ? 'Working on it now' : 'Waiting its turn'}</h1>
    <div class="say-2">${esc(live?.description || 'Queued behind whatever is in front of it. Nothing here needs you.')}</div>
    <div class="steps" style="margin-top:30px;max-width:820px">
      <div>
        <span class="mark done">✓</span>
        <div style="flex:1"><div class="what">Recorded</div>
          <div class="sub">${esc(longDate(s.startedAt))}${runtime(s.durationMs) ? ` · ${runtime(s.durationMs)}` : ''}</div></div>
      </div>
      <div class="${live ? 'now' : ''}">
        <span class="mark ${live ? 'live' : ''}">${live ? '' : '2'}</span>
        <div style="flex:1">
          <div class="what" style="${live ? 'font-weight:500' : 'color:var(--dim)'}">Transcribing</div>
          ${live ? `<div class="sub">${esc(live.description)}</div><div class="bar"><i style="width:${pct}%"></i></div>`
                 : '<div class="sub">on the PC, inside the transcribe window</div>'}
        </div>
      </div>
      <div>
        <span class="mark">3</span>
        <div style="flex:1"><div class="what" style="color:var(--dim)">Summarising</div>
          <div class="sub">${status?.schedule?.requireApproval ? 'you will be asked before this starts' : 'starts on its own once the transcript exists'}</div></div>
      </div>
      <div>
        <span class="mark">4</span>
        <div style="flex:1"><div class="what" style="color:var(--dim)">Notes posted to ${esc(destination())}</div></div>
      </div>
    </div>`;
}

function recordingPane(s) {
  const live = (status?.recording ?? []).find((r) => r.meetingId === s.meetingId);
  return `
    <div class="kicker broken"><span class="dot live"></span> Recording · session ${s.sessionNumber ?? s.meetingId}</div>
    <div style="display:flex;align-items:flex-end;gap:24px;margin-top:14px;flex-wrap:wrap">
      <div class="mono" id="timer" style="font-size:52px;font-weight:500;letter-spacing:-1px;line-height:1">
        ${hhmmss(live?.recordingForMs)}
      </div>
      <div class="mono" style="font-size:12.5px;color:var(--dim);line-height:1.8;padding-bottom:6px">
        ${esc(live?.channel || s.channel || '')}<br>
        ${n(live?.clips ?? 0)} clips · ${plural(live?.speakers ?? 0, 'speaker')}
      </div>
    </div>
    ${quietWarning(live)}
    <div class="say-2">
      Audio is being written to the Pi. Transcription is queued when the session ends${status?.schedule?.requireApproval ? ', and Quill will ask before it uses the PC' : ''}.
    </div>
    <div class="quiet" style="margin-top:20px">
      End it from Discord with <code>/campaign leave</code>.${live?.emptyCloseMinutes > 0
        ? ` If everyone leaves the channel, it ends on its own after ${plural(live.emptyCloseMinutes, 'minute')}.`
        : ''}
    </div>`;
}

// A live session that has heard nothing for a long while. From the inside this
// is what a bot dropped out of voice looks like, so it is said on the page as
// well as in the owner's DM. The threshold is the bot's own
// VOICE_SILENCE_ALERT_MINUTES, sent with the session.
function quietWarning(live) {
  const limit = live?.silenceAlertMinutes;
  if (!live || !(limit > 0)) return '';
  const heard = live.lastAudioAt ?? (lastSeen ? lastSeen - (live.recordingForMs ?? 0) : null);
  if (!heard) return '';
  const quietMin = Math.floor((Date.now() - heard) / 60000);
  if (quietMin < limit) return '';
  return `
    <div class="card" role="status" style="margin-top:18px;border-color:var(--amber)">
      <div class="cap" style="color:var(--amber)">Nothing heard for ${plural(quietMin, 'minute')}</div>
      <div class="quiet" style="margin-top:8px">
        If the table is talking, Quill may have dropped out of voice. <code>/campaign leave</code> then
        <code>/campaign join</code> starts a fresh session; everything recorded so far is kept.
      </div>
    </div>`;
}

function failedPane(s) {
  const job = s.job;
  // The log the design draws by hand, built from what is actually recorded:
  // when the session ran, how many clips survived, and every attempt the job
  // made before it gave up.
  const events = [
    [hhmm(s.startedAt), `joined ${s.channel || 'the voice channel'}`],
    s.endedAt ? [hhmm(s.endedAt), `last voice left · ${runtime(s.durationMs) ?? '0:00'} recorded`] : null,
    [hhmm(s.endedAt || s.startedAt), s.lines ? `${n(s.lines)} lines transcribed` : '0 clips written to disk'],
    job?.attempts ? [null, `${plural(job.attempts, 'attempt')} · ${esc(job.lastError || 'nothing to read')}`] : null,
  ].filter(Boolean);

  return `
    ${sessionKicker(s, 'broken')}
    <h1 class="display" style="margin-top:14px">
      ${s.lines ? 'This session did not finish.' : 'There is nothing to transcribe.'}
    </h1>
    <div class="say-2">
      ${s.lines
        ? `The transcript exists — ${plural(s.lines, 'line')} — but the step after it failed. Trying again is worth a go.`
        : 'Quill joined the channel but no clips survived, so there is no audio to retry. Every attempt fails for the same reason.'}
    </div>
    <div class="card" style="margin-top:30px;max-width:760px">
      <div class="cap" style="margin-bottom:14px">What Quill saw</div>
      <div class="mono" style="display:flex;flex-direction:column;gap:11px;font-size:12.5px;color:var(--text-2)">
        ${events.map(([t, what]) => `
          <div style="display:flex;gap:16px">
            <span style="color:var(--dim);width:64px;flex:0 0 64px">${esc(t || '')}</span>
            <span style="${what.startsWith('0 clips') ? 'color:var(--red-lit)' : ''}">${esc(what)}</span>
          </div>`).join('')}
      </div>
    </div>
    ${can() ? `
      <div class="row-btns" style="margin-top:26px">
        ${s.discardable ? `<button type="button" class="btn warn big" data-act="session/discard" data-meeting="${s.meetingId}"
            data-confirm="Discard ${esc(sessionName(s))}? It has no transcript, and this stops it retrying.">Discard this session</button>` : ''}
        ${s.lines ? `<button type="button" class="btn go big" data-act="summary/again" data-meeting="${s.meetingId}">Try summarising again</button>` : ''}
        <button class="btn big" data-import>Import a recording instead</button>
      </div>
      <div class="quiet" style="margin-top:20px">
        Discarding removes it from the queue and from the session count. Nothing was ever posted to the channel.
      </div>` : disabledNote()}`;
}

// The first few lines, so the approval decision is made looking at the thing
// rather than at its line count.
function transcriptPeek(s) {
  if (!s.lines) return '';
  const peek = script?.meetingId === s.meetingId ? script.lines.slice(0, 6) : null;

  return `
    <div class="cap" style="margin:34px 0 14px">The transcript, from the top</div>
    <div class="card" style="max-width:none">
      ${peek ? peek.map((l) => `
        <div style="display:grid;grid-template-columns:74px 132px 1fr;gap:16px;align-items:baseline;padding:7px 0">
          <span class="mono" style="font-size:11.5px;color:var(--dim)">${esc(clock(l.ms))}</span>
          <span style="font-size:14px;color:var(--text-2)">${esc(l.speaker)}</span>
          <span style="font-size:14.5px;line-height:1.6;color:var(--text-2)">${esc(l.text)}</span>
        </div>`).join('')
        : '<div class="quiet">Loading the first lines…</div>'}
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:14px;border-top:1px solid var(--line)">
        <span class="mono" style="font-size:11.5px;color:var(--dim)">
          ${peek ? `${n(Math.max(0, (script.total || 0) - peek.length))} more lines` : `${n(s.lines)} lines`}
        </span>
        <button class="btn sm" data-transcript="${s.meetingId}">Open the full transcript</button>
      </div>
    </div>`;
}

// --- the facts rail --------------------------------------------------------

// The five sections of a write-up that are lists rather than prose: who turned
// up, where they went, what they came away with, what is still open, and the
// line worth reading out.
//
// Built once and drawn twice, because where they belong depends on how wide
// the window is and CSS is what knows that. On a wide screen they are the
// facts rail beside the recap; under 1300px there is no rail, and they go
// under the prose instead. Whichever copy is not wanted is display:none, which
// also takes it out of the accessibility tree, so nothing is said twice.
//
// They used to exist only in the rail, with a comment here claiming they were
// "also in the notes body". They were not. Below 1300px — an ordinary laptop
// window — five of a write-up's nine sections simply were not on the page.
function recapSections(notes) {
  // `anchored` marks a section the margin takes over past 1560px — see
  // .facts .rail-anchored. Both are always rendered; CSS draws one.
  const block = (title, lines, anchored = false) =>
    lines?.length ? `<div${anchored ? ' class="rail-anchored"' : ''}><div class="cap" style="margin-bottom:12px">${title}</div>
      <div class="plainlist">${lines.map((line) => wiki(line)).join('<br>')}</div></div>` : '';

  const named = (title, lines, anchored = false) =>
    lines?.length ? `<div${anchored ? ' class="rail-anchored"' : ''}><div class="cap" style="margin-bottom:12px">${title}</div>
      <div class="stack">${lines.map((entry) => {
        const { name, rest } = splitEntry(entry);
        return `<div><div class="who">${wiki(name)}</div>${rest ? `<div class="what">${wiki(rest)}</div>` : ''}</div>`;
      }).join('')}</div></div>` : '';

  return [
    notes.unresolvedThreads.length
      ? `<div><div class="cap" style="margin-bottom:12px">Still unresolved</div>
           <div class="stack">${notes.unresolvedThreads.map((t) => `<div class="big">${wiki(t)}</div>`).join('')}</div></div>`
      : '',
    named('NPCs introduced', notes.npcsIntroduced, true),
    block('Locations', notes.locationsVisited, true),
    block('Loot and rewards', notes.lootAndRewards),
    // The highlighter's one job on this page: the line somebody will want to
    // read out loud. It is the only thing here Quill kept rather than counted.
    notes.funnyMoments.length
      ? `<div class="keep"><div class="cap">Worth remembering</div>
           ${notes.funnyMoments.map((f) => `<p>${wiki(f)}</p>`).join('')}</div>`
      : '',
  ].filter(Boolean).join('');
}

// The write-up read as its own shape — see .parts.
//
// Built from the prose rather than from the notes object, so the rail can
// only ever list what is actually on the page: the two are the same list by
// construction instead of by two people remembering to change both. It is
// also why this is one line of DOM reading in a file that otherwise builds
// everything from state.
//
// Below three parts there is nothing to index. Two headings and a place
// marker is a table of contents for a page you can already see all of.
function partsRail() {
  const found = [...document.querySelectorAll('[data-part]')];
  if (found.length < 3) return '';
  return `
    <div>
      <div class="cap" style="margin-bottom:12px">This write-up</div>
      <nav class="parts" aria-label="Sections of this write-up">
        ${found.map((el, i) => `
          <button type="button" class="parts-row" data-part-to="${esc(el.id)}">
            <span class="n">${String(i + 1).padStart(2, '0')}</span>
            <span class="t">${esc(el.dataset.part)}</span>
          </button>`).join('')}
      </nav>
    </div>`;
}

function factsRail() {
  const s = selected();
  if (!s || !notes || notes.meetingId !== s.meetingId || notes.unreadable || !notes.written) return '';

  // The index first: it is where you are, and the rest of the rail is what
  // the night held.
  //
  // It goes in a slot of its own because it is the one thing here built by
  // reading the page rather than the state — so what this template can put in
  // it was read from the PREVIOUS draw. syncParts() puts it right immediately
  // after the morph, when the prose it describes is actually on the page.
  const parts = partsRail();
  const rest = recapSections(notes);
  // Optional: the rail is the wide-window home for these. The narrow one is
  // .recap-extras, at the foot of the prose.
  return parts || rest
    ? `<aside class="facts optional"><div class="parts-slot" data-key="parts-slot">${parts}</div>${rest}</aside>`
    : '';
}

// The index, rebuilt against the prose that is on the page now.
//
// Everything else on this dashboard is drawn from state, so one pass is
// enough. This one reads the DOM, which means the copy the template made was
// a description of the write-up that was open a moment ago. On a page nobody
// is touching those are the same write-up. On the paint that opens a
// different session they are not, and the index either went blank until the
// five-second poll came round or — with the timing a shade different — listed
// the previous night's scenes under ids that were no longer on the page.
//
// Rewritten only when it disagrees. Doing it unconditionally would take the
// focus out of the index every five seconds for anybody reading by keyboard,
// which is a worse fault than the one being fixed.
function syncParts() {
  const slot = document.querySelector('.parts-slot');
  if (!slot) return;

  // Joined on a separator that cannot occur in either half, so "Scene 1" in
  // one part and "1" in the next cannot compare equal by accident. Written as
  // the ESCAPE and not as the byte: a raw NUL in the file makes every text
  // tool call this an 8,000-line binary and skip it silently, which is how it
  // sat out a repo-wide line-ending sweep that was looking for exactly this
  // kind of invisible byte.
  const want = [...document.querySelectorAll('[data-part]')].map((el) => `${el.id}\u0000${el.dataset.part}`);
  const have = [...slot.querySelectorAll('[data-part-to]')]
    .map((b) => `${b.dataset.partTo}\u0000${b.querySelector('.t')?.textContent ?? ''}`);
  if (have.length === want.length && have.every((row, i) => row === want[i])) return;

  slot.innerHTML = partsRail();
}

// Which part is on screen, marked in the rail.
//
// A scroll handler rather than an IntersectionObserver, for the same reason
// the margin is floats rather than positioning: the pane is rebuilt by a
// poll every five seconds, and an observer would have to be torn down and
// re-attached to the new nodes each time. Reading positions on demand has no
// lifecycle to get wrong.
//
// "On screen" is the last part whose top has passed a line a third of the
// way down the window — not the topmost visible one. The difference matters
// at the end of a long scroll, where three short sections share the window
// and the honest answer is the one you are reading rather than the one whose
// heading happens to still be above the fold.
function markPart() {
  const rows = [...document.querySelectorAll('[data-part-to]')];
  if (!rows.length) return;

  const line = window.innerHeight * 0.34;
  let here = 0;
  rows.forEach((row, i) => {
    const part = document.getElementById(row.dataset.partTo);
    if (part && part.getBoundingClientRect().top <= line) here = i;
  });

  // At the foot of the page the last part wins, whatever the line says. The
  // final sections of a write-up are two or three lines each and can never
  // reach a third of the way up the window, so without this the index stops
  // moving a screen before the reader does — and the one place a reader is
  // most sure where they are is the end.
  const doc = document.documentElement;
  if (window.scrollY + window.innerHeight >= doc.scrollHeight - 4) here = rows.length - 1;
  rows.forEach((row, i) => row.classList.toggle('here', i === here));
}

// Throttled to a frame. A scroll fires far more often than a page can be
// painted, and this reads layout, which is the one thing worth not doing
// sixty times between two frames.
let partTick = 0;
function partsFollow() {
  if (partTick) return;
  partTick = requestAnimationFrame(() => { partTick = 0; markPart(); });
}
window.addEventListener('scroll', partsFollow, { passive: true });
window.addEventListener('resize', partsFollow, { passive: true });

// ==========================================================================
// Who and where — the campaign read down instead of across
// ==========================================================================
//
// Nothing new is summarised for this. Every session's notes already carry the
// NPCs it introduced and the places it visited, written at the time by the
// summariser; this reads all of them in one go and lines the repeats up under
// one name. So an entry is not a fresh opinion about a character — it is the
// same sentences that were posted to Discord, in the order they were said.
//
// Cached per campaign, because it is one request per session and the answer
// only changes when a session is summarised again.

let compendium = null;   // see blankCompendium for the shape

// One shape for all three states it can be in — loading, failed, built — so a
// reader never has to work out which one it got.
//
// The three used to be written out by hand at their three call sites, and two
// of them left out `items` and `story`. Every reader but one defends itself
// with `?? []`; shelfCount does not, so a single failed /notes request threw on
// the very next paint and took the whole page down with it.
const blankCompendium = (id, patch = {}) => ({
  campaignId: id, loading: false, error: '',
  story: [], npcs: [], places: [], items: [],
  ...patch,
});

// What counts as a thing, as against what a night was worth.
//
// "lootAndRewards" is the summariser's one field for everything the party came
// away with, and most of what lands in it is money or experience: "450 gold
// pieces", "1,200 XP each", "2,000 gp split between the party". Every one of
// those belongs in the session's own loot line, which is why the facts rail
// still prints them — but a campaign-wide list of THINGS with forty entries of
// gold in it is not a list of things, it is an accounts page nobody asked for,
// and the two items in among them cannot be found.
//
// The test is not the word "gold". "A golden idol of Vecna" and "the Goldvein
// amulet" both name something, and a filter that read the letters g-o-l-d
// would throw both away. Money reads as a QUANTITY — a number, then what it is
// counted in, then nothing else — and an item reads as a name. So a line is
// money when every word in it is a number, a unit, or a word for joining them
// together, and it is an item the moment one word is left over that names
// something.
const CURRENCY =
  /\b(?:gp|sp|cp|pp|ep|gold|silver|copper|platinum|electrum|coins?|xp|exp|experience)\b/i;

const COUNTING = new Set([
  'a', 'an', 'the', 'and', 'of', 'for', 'in', 'to', 'from', 'plus', 'each', 'per', 'total',
  'worth', 'split', 'shared', 'divided', 'between', 'among', 'amongst', 'party', 'person',
  'people', 'character', 'characters', 'player', 'players', 'about', 'around', 'roughly',
  'approximately', 'approx', 'piece', 'pieces', 'point', 'points', 'coin', 'coins', 'coinage',
  'currency', 'money', 'funds', 'gold', 'silver', 'copper', 'platinum', 'electrum',
  'gp', 'sp', 'cp', 'pp', 'ep', 'xp', 'exp', 'experience', 'level', 'levels', 'up',
  'gain', 'gains', 'gained', 'award', 'awards', 'awarded', 'reward', 'rewards', 'rewarded',
  'receive', 'receives', 'received', 'earn', 'earns', 'earned', 'loot', 'treasure', 'haul',
  'stash', 'purse', 'pouch', 'bag', 'sack', 'chest', 'some', 'several', 'few', 'handful',
  'also', 'each', 'apiece', 'total', 'altogether', 'roughly',
]);

function isMoney(text) {
  if (!CURRENCY.test(text)) return false;
  const words = String(text)
    // "30gp" is a number and a unit written together, and has to be two words
    // before either can be recognised.
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => /^\d+$/.test(w) || COUNTING.has(w));
}

// "Warden Ilse — runs the Greyhollow toll" and "Warden Ilse, who keeps two
// books" are the same person on two different nights. Match on a folded name
// so they land in one entry without needing the summariser to be consistent.
const foldName = (s) => s.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

function collect(list, entries, session) {
  for (const raw of list ?? []) {
    const { name, rest } = splitEntry(raw);
    const trimmed = (name || '').trim();
    if (!trimmed) continue;
    const key = foldName(trimmed);
    if (!key) continue;

    let entry = entries.get(key);
    if (!entry) {
      entry = { key, name: trimmed, first: session, seen: [], said: [], asides: [] };
      entries.set(key, entry);
    }
    // Sessions arrive newest first, so the last one seen is the earliest.
    entry.first = session;
    if (!entry.seen.some((x) => x.meetingId === session.meetingId)) entry.seen.push(session);
    // The summariser writes "Name — what they are". Its remainder starts
    // mid-sentence, so it gets a capital before it is shown as one.
    if (rest) entry.said.push({ session, text: rest[0].toUpperCase() + rest.slice(1) });
  }
}

async function buildCompendium() {
  const id = view.campaignId;
  compendium = blankCompendium(id, { loading: true });
  paint();

  const withNotes = sessions().filter((s) => s.hasNotes);
  const npcs = new Map();
  const places = new Map();
  const items = [];
  const asides = [];

  // One request per session. Strictly in series a long campaign would take a
  // noticeable few seconds; all at once would put forty requests on a
  // Raspberry Pi in one breath. Six at a time is neither.
  const LANES = 6;

  let read = [];
  try {
    const fetched = [];
    for (let i = 0; i < withNotes.length; i += LANES) {
      const batch = withNotes.slice(i, i + LANES);
      const got = await Promise.all(batch.map((s) => get(`/notes?meeting=${s.meetingId}`)));
      if (view.campaignId !== id) return;           // they moved on mid-read
      batch.forEach((s, j) => fetched.push({ s, n: got[j] }));
    }

    // Collected in the order the sessions are listed — newest first — because
    // collect() leans on that to work out which night was the first.
    for (const { s, n } of fetched) {
      if (!n?.written || n.unreadable) continue;
      collect(n.npcsIntroduced, npcs, s);
      collect(n.locationsVisited, places, s);
      for (const line of n.lootAndRewards ?? []) {
        const text = String(line ?? '').trim();
        if (text && !isMoney(text)) items.push({ session: s, text });
      }
      for (const line of n.funnyMoments ?? []) asides.push({ session: s, text: line });
    }
    read = fetched;
  } catch (err) {
    compendium = blankCompendium(id, { error: err.message });
    return paint();
  }

  // An aside belongs to whoever it is about. The ones that name nobody stay
  // with the campaign rather than being filed under a guess.
  const attach = (map) => {
    for (const entry of map.values()) {
      const needle = entry.name.toLowerCase();
      for (const aside of asides) {
        if (aside.text.toLowerCase().includes(needle)) entry.asides.push(aside);
      }
    }
  };
  attach(npcs);
  attach(places);

  // Everything above is collected newest-first, because the session list is
  // newest-first and collect() leans on that to find the night a name walked
  // on. Read back, an entry runs the other way: it sits under that night, so
  // its first line has to be the one that night wrote and the rest have to
  // follow in the order the campaign added them. Sorted here rather than at
  // the point of reading, so the list and the run of nights beside it can
  // only ever agree.
  const byNight = (a, b) => (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0);
  const chronological = (map) => {
    for (const entry of map.values()) {
      entry.seen.sort(byNight);
      entry.said.sort((a, b) => byNight(a.session, b.session));
      entry.asides.sort((a, b) => byNight(a.session, b.session));
    }
  };
  chronological(npcs);
  chronological(places);

  // Oldest first. The session column is newest-first because you want the
  // last night you played; a cast list is the opposite — you meet people in
  // the order the campaign met them, and session one is where most of them
  // are. Sorted newest-first, the founding cast sat at the bottom of the page.
  const order = (a, b) => (a.first.sessionNumber ?? 0) - (b.first.sessionNumber ?? 0);
  // The story in order, one entry per night, with what that night added.
  const story = read
    .filter(({ n }) => n?.written && !n.unreadable)
    .map(({ s, n }) => ({ session: s, notes: n }))
    .sort((a, b) => (a.session.sessionNumber ?? 0) - (b.session.sessionNumber ?? 0));

  compendium = blankCompendium(id, {
    story,
    npcs: [...npcs.values()].sort(order),
    places: [...places.values()].sort(order),
    items: items.sort((a, b) => (a.session.sessionNumber ?? 0) - (b.session.sessionNumber ?? 0)),
  });
  paint();
}

// The word each kind of entry uses for the night it turned up.
const FIRST_WORD = {
  people: 'first met',
  places: 'first gone to',
  items:  'found in',
};

