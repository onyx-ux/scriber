// dashboard/html/dash/app/09-paint.js: Painting and loading.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// Painting
// ==========================================================================

// Which page the column is currently showing, as far as the DOM is concerned.
// null when there is no column on screen.
let paintedPicking = null;

function settleColumn() {
  const slider = document.querySelector('.shelf-slider');
  if (!slider) { paintedPicking = null; return; }

  const want = Boolean(view.shelfPicking);
  if (paintedPicking === null || paintedPicking === want) {
    paintedPicking = want;   // first sight of it, or nothing moved
    return;
  }

  const face = (picking) => {
    slider.classList.toggle('picking', picking);
    slider.classList.toggle('picked', !picking);
  };

  // Synchronously, inside this same paint: a rAF here would be stranded by
  // the next render, which replaces these elements out from under it.
  face(paintedPicking);                                  // where it was
  slider.querySelectorAll('.shelf-page')
    .forEach((page) => getComputedStyle(page).transform); // make it believe that
  face(want);                                            // where it goes
  paintedPicking = want;
}

// How long the screen being painted still counts as arriving.
//
// A deadline rather than a one-shot flag, because opening a campaign paints
// twice — once on the click and again when its detail lands — and a flag spent
// on the first paint would have the second one strip the class off half way
// through the animation. Holding the class across both keeps it running: the
// element itself is never replaced, only its contents, so nothing restarts.
let entersUntil = 0;
const entering = () => { entersUntil = Date.now() + 340; };

// How much chrome sits above the split, in pixels, onto --above.
//
// The two sticky columns are a window tall minus whatever is over them. That
// is the top bar on most paints and the top bar plus the degraded banner on
// the rest, and the banner's height is not a number this file can know: it is
// two lines wide on a laptop and six on a phone. So it is measured off the
// laid-out page rather than assumed.
//
// Read before the write, and written only when it changes, so this cannot
// start a layout/paint loop with the very rule it is feeding.
function measureChrome() {
  const split = $('screen');
  if (!split) return;
  const above = Math.max(0, Math.round(split.getBoundingClientRect().top + window.scrollY));
  const root = document.documentElement;
  const next = `${above}px`;
  if (root.style.getPropertyValue('--above') !== next) root.style.setProperty('--above', next);
  // The top bar alone, which is what the ribbon sticks under. 76px on a
  // laptop; shorter on a phone, where it is one row with less padding.
  const bar = $('top');
  const tall = bar?.getBoundingClientRect ? `${Math.round(bar.getBoundingClientRect().height)}px` : null;
  if (tall && tall !== '0px' && root.style.getPropertyValue('--top-h') !== tall) root.style.setProperty('--top-h', tall);
}

function paint() {
  renderTop();
  renderBanner();
  // After renderScreen, which is what sets body.gate-open — the sheet reads it.
  renderScreen();
  renderSheet();
  settleColumn();
  renderModal();
  // Last, because it measures what everything above has just drawn.
  measureChrome();

  // The card is anchored to a node inside a panel the patcher may have just
  // rebuilt. Reused nodes survive, so this almost never fires — but a name
  // that has genuinely gone leaves a card hanging over the page pointing at
  // nothing at all.
  if (peekFor && !document.contains(peekFor)) peekAway();

  // Which part of the write-up is on screen is a fact about the scroll
  // position, not about the state this page just drew from — so it is put
  // back after the draw rather than baked into it, the same way the
  // threshold puts its torch back. The index itself comes first: marking a
  // row is only meaningful once the rows are the right ones.
  syncParts();
  markPart();

  const rec = status?.recording?.length;
  const needs = (status?.campaigns ?? []).reduce((sum, c) => sum + (c.awaiting || 0), 0);
  document.title = rec ? '● Recording — Quill' : needs ? `(${needs}) Quill` : 'Quill';
}

// ==========================================================================
// Loading
// ==========================================================================

async function get(path) {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// The poll, sent with the tag of the snapshot already held. Most polls find
// nothing new, and the bot then answers 304 with no body instead of the whole
// snapshot again. The only fields that move without anything happening are the
// clocks, which the tag leaves out, so they are advanced here by the time since
// the snapshot arrived. See statusEtag in pi-service/src/web/status.js.
let statusTag = null;
async function getStatus() {
  const headers = statusTag && status ? { 'If-None-Match': statusTag } : {};
  const res = await fetch(`${API}/status`, { cache: 'no-store', headers });
  if (res.status === 304 && status) {
    const moved = lastSeen ? Date.now() - lastSeen : 0;
    if (status.bot?.uptimeMs != null) status.bot.uptimeMs += moved;
    for (const r of status.recording ?? []) {
      if (r.recordingForMs != null) r.recordingForMs += moved;
    }
    return status;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  statusTag = res.headers?.get?.('etag') ?? null;
  return res.json();
}

async function loadCampaign(id, { keepScreen = false } = {}) {
  // Set before the fetch so the campaign opens on the click rather than
  // whenever the network gets back.
  view.campaignId = id;
  view.sheet = null;
  view.drawer = false;
  if (!keepScreen) {
    view.screen = 'campaign';
    entering();
  }
  // Opening a campaign lands on what it holds, not on one of the four. The
  // column offers Sessions, NPCs, Places and Items; picking one is the next
  // move, the same shape as picking the campaign was.
  view.shelf = 'sessions';
  view.shelfPicking = true;
  view.entry = null;
  compendium = null;
  view.meetingId = null;
  view.editing = null;
  view.fixing = false;
  // The channel list belongs to one server. Carried across it would offer the
  // last campaign's channels for this one.
  view.outputPicking = false;
  // And an heir chosen for one table is not an heir for the next.
  view.heir = null;
  notes = null;
  notesKey = null;
  script = null;
  // A search is scoped to one server; carrying its results to the next
  // campaign would offer to invite people who are not in that Discord.
  people.query = ''; people.results = null; people.error = '';

  paint();

  try {
    detail = await get(`/campaign?id=${id}`);
    // Which rulebook this table plays out of decides which spell names in its
    // write-ups become links. Not awaited: a recap reads perfectly well for the
    // moment before the list lands, and the next paint picks it up.
    loadRules(detail?.edition);
  } catch (err) {
    detail = null;
    toast(`Couldn't load that campaign — ${err.message}`, false);
  }
  // Land on something worth reading rather than an empty pane: whatever is
  // waiting on a decision, else the most recent session that has notes.
  const list = sessions();
  const pick = list.find((s) => s.state === 'recording')
    || list.find((s) => s.job?.status === 'awaiting_approval')
    || list.find((s) => s.hasNotes)
    || list[0];
  if (pick) await openSession(pick.meetingId, { quiet: true });
  else paint();

  // Those four rows carry counts, and the counts need the whole campaign read
  // back. It is the first thing on screen now, so the read starts here rather
  // than waiting to be asked for — un-awaited, so the page is not held up by
  // it and the numbers arrive when they arrive.
  buildCompendium();
}

async function openSession(meetingId, { quiet = false } = {}) {
  view.meetingId = meetingId;
  view.tab = 'notes';
  view.fixing = false;
  notes = null;
  notesKey = null;
  if (!quiet) paint();
  await syncNotes();
  paint();
}

// Fetch whatever the open session's reader needs, and only what it needs.
//
// Called after every action and every poll as well as on open, because the
// thing being watched is a session moving: approve a summary and a few seconds
// later it has notes, which nothing would have gone back for otherwise.
async function syncNotes() {
  const s = selected();
  // A correction being typed belongs to the session it was typed in, so it
  // goes to the Pi before the page moves anywhere else.
  if (markDraft.part && (!s || s.meetingId !== notes?.meetingId)) markClose();
  if (!s) { notes = null; notesKey = null; return; }

  // Keyed on the session AND its live job, so a re-summarise is picked up:
  // the notes on disk do not change when you press the button, they change a
  // minute later when the job that button queued disappears again.
  const key = `${s.meetingId}:${s.job?.id ?? ''}:${s.job?.status ?? ''}`;

  try {
    if (s.hasNotes && notesKey !== key) {
      notes = await get(`/notes?meeting=${s.meetingId}`);
      notesKey = key;
    } else if (!s.hasNotes) {
      notes = null;
      notesKey = null;
    }

    // The approval screen shows the first few lines, so the decision is made
    // looking at the session rather than at its line count.
    const peeking = s.job?.status === 'awaiting_approval' && s.job.type === 'summarize' && s.lines;
    if (peeking && script?.meetingId !== s.meetingId) {
      script = await get(`/transcript?meeting=${s.meetingId}&format=json`);
    }
  } catch (err) {
    toast(`Couldn't open that session — ${err.message}`, false);
  }
}

async function openTranscript(meetingId) {
  view.screen = 'transcript';
  view.search = '';
  view.speaker = null;
  if (script?.meetingId !== Number(meetingId)) script = null;
  paint();
  try {
    script = await get(`/transcript?meeting=${meetingId}&format=json`);
  } catch (err) {
    toast(`Couldn't open that transcript — ${err.message}`, false);
    view.screen = 'campaign';
  }
  paint();
}

const countAwaiting = () =>
  (detail?.sessions ?? []).filter((s) => s.job?.status === 'awaiting_approval').length;

async function tick() {
  try {
    // Who the bot thinks is asking, before anything else — it decides both
    // what the rest of the payloads will contain and whether there is an app
    // to draw at all. A bot too old to answer it leaves `me` null, and cap()
    // then defaults to the behaviour that existed before levels did.
    me = await get('/me').catch(() => me);

    if (me?.loginRequired && !me.signedIn) {
      lastSeen = Date.now();
      document.body.classList.remove('stale');
      status = null;
      paint();
      return;
    }

    status = await getStatus();
    lastSeen = Date.now();
    document.body.classList.remove('stale');

    // Where the page opens is now settled by view.screen alone, which starts
    // on the desk. The old shortcut — one campaign, so go straight in, on the
    // grounds that an index of one is a door with nothing behind it — does not
    // survive the desk, which is not an index of campaigns. Even a one-table
    // operator has the bill, the servers and the gatehouse on it, and the one
    // table is still a single click away, by name, in its own square.

    // The open campaign's detail does not come from the poll, so refresh it
    // when the poll says something about it changed.
    const mine = status.campaigns?.find((c) => c.id === view.campaignId);
    if (mine && detail && (mine.sessions !== detail.sessions.length || mine.awaiting !== countAwaiting())) {
      detail = await get(`/campaign?id=${view.campaignId}`).catch(() => detail);
      // The session on screen may have just grown notes.
      if (view.screen === 'campaign') await syncNotes();
    }

    // Checked here rather than on the first /me, because what the threshold
    // asks depends on whether it can already see a table for this person.
    maybeWelcome();

    paint();
  } catch (err) {
    // The bot being unreachable is itself information. The page dims as well as
    // saying so: a dashboard confidently showing "not recording" while it has
    // no idea is worse than one that admits it lost contact.
    document.body.classList.add('stale');
    document.title = 'Quill — offline';
    toastOffline(err.message);
  }
}

let offlineShown = 0;
function toastOffline(message) {
  if (Date.now() - offlineShown < 30000) return;
  offlineShown = Date.now();
  toast(`Can't reach the bot at ${API} — ${message}. Showing what it last said, ${since(lastSeen)}.`, false);
}

