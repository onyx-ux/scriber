// dashboard/html/dash/app/02-names.js: Hover cards on names, and correcting a write-up.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// What is behind a name
// ==========================================================================

// A wikilink says there is more; this says what, without spending the reader
// their place in the sentence to find out. Everything in the card is already
// in memory — the compendium is what made the name a link in the first place —
// so hovering costs nothing and asks the bot for nothing.

let peekFor = null;      // the element the card is currently anchored to
let peekTimer = 0;

// The entry a wikilink points at, or nothing.
//
// A link only exists because vocabulary() found the name, and vocabulary()
// only answers when the compendium is loaded for this campaign — so in
// practice this always finds one. It still checks, because "the link exists
// therefore the entry does" is a fact about today’s wiki() rather than a
// promise, and the failure would be a card with a blank in it.
function peekEntry(ref) {
  const [kind, key] = String(ref ?? '').split(':');
  if (!compendium || compendium.campaignId !== view.campaignId) return null;
  return (compendium[kind] ?? []).find((e) => e.key === key) ?? null;
}

const PEEK_KIND = { npcs: 'Who', places: 'Where' };

function peekCard(entry, kind) {
  // The first thing the summariser wrote about them, which is the sentence
  // that introduced them. Later ones are what happened next, and a card is
  // not the place to catch up on a campaign.
  const what = entry.said[0]?.text ?? '';
  const nights = entry.seen.length;
  const first = entry.first ? sessionName(entry.first) : '';
  const word = kind === 'places' ? 'First gone to' : 'First met';
  return `
    <span class="peek-kind">${esc(PEEK_KIND[kind] ?? '')}</span>
    <span class="peek-name">${esc(entry.name)}</span>
    ${what ? `<span class="peek-what">${esc(what)}</span>` : ''}
    <span class="peek-foot">${first ? `${esc(word)} in ${esc(first)}` : ''}${
      nights > 1 ? ` &middot; in ${nights} nights` : ''}</span>`;
}

// Where the card goes. Under the name by preference, above it when there is
// no room below, and never off either side.
function peekPlace(anchor, card) {
  const a = anchor.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const GAP = 9;
  const EDGE = 12;

  let top = a.bottom + GAP;
  if (top + box.height > window.innerHeight - EDGE) {
    const above = a.top - box.height - GAP;
    // Only flip if flipping is actually better. On a short window both ends
    // are cramped, and a card half off the top is worse than one half off
    // the bottom, which at least starts at the name.
    if (above >= EDGE) top = above;
  }

  let left = a.left;
  const most = window.innerWidth - box.width - EDGE;
  if (left > most) left = most;
  if (left < EDGE) left = EDGE;

  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

function peekAt(anchor) {
  const entry = peekEntry(anchor.dataset.entry);
  if (!entry) return;
  const [kind] = String(anchor.dataset.entry).split(':');
  const card = $('peek');
  if (!card) return;

  peekFor = anchor;
  card.innerHTML = peekCard(entry, kind);
  card.hidden = false;
  // Measured after it has content and before it is shown, so the flip test
  // above is reading this card rather than the last one.
  peekPlace(anchor, card);
  card.classList.add('up');
}

function peekAway() {
  clearTimeout(peekTimer);
  peekTimer = 0;
  peekFor = null;
  const card = $('peek');
  if (!card) return;
  card.classList.remove('up');
  card.hidden = true;
}

// A pause before it appears, because a card that follows the pointer across a
// paragraph is a page that flickers. None on the way out.
const PEEK_WAIT = 320;

document.addEventListener('mouseover', (event) => {
  const link = event.target.closest?.('.wiki[data-entry]');
  if (!link) { if (peekFor) peekAway(); return; }
  if (link === peekFor) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => peekAt(link), PEEK_WAIT);
});

// Keyboard readers get it without the wait: tabbing to a link is already the
// deliberate act the delay exists to wait for.
document.addEventListener('focusin', (event) => {
  const link = event.target.closest?.('.wiki[data-entry]');
  if (link) peekAt(link); else if (peekFor) peekAway();
});
document.addEventListener('focusout', () => { if (peekFor) peekAway(); });

// A scroll moves the name out from under a card fixed to the viewport, and a
// click is going somewhere. Both are reasons to close rather than to chase.
window.addEventListener('scroll', () => { if (peekFor) peekAway(); }, true);
document.addEventListener('click', () => { if (peekFor) peekAway(); }, true);


// --- the rules a write-up names ---------------------------------------------
//
// Fetched rather than carried: the table is 26KB of spell names and would sit
// in this page whether or not anybody opened a write-up. One request per
// edition, kept for the life of the tab.
//
// Two editions and they are different lists — 2024 dropped spells the 2014
// books had — so what is linked depends on which rulebook the campaign says it
// plays out of. A link to a page that 404s is worse than no link.

let rules = null;   // { edition, by: Map<name, url>, re: RegExp }

async function loadRules(edition) {
  const want = String(edition || '2024');
  if (rules && rules.edition === want) return;
  try {
    const got = await get(`/rules?edition=${encodeURIComponent(want)}`);
    const by = new Map(got.spells.map((s) => [s.name, s.url]));

    // ONE regex for the whole list rather than one per name. The campaign
    // vocabulary is a dozen entries and can afford a pass each; this is three
    // hundred and sixty, against every passage, on a page that repaints every
    // five seconds.
    //
    // Longest first, because alternation takes the first branch that matches
    // at a position: without it, a two-word spell whose first word is also a
    // spell would be claimed by the shorter one and point at the wrong page.
    const names = [...by.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    rules = {
      edition: got.edition,
      label: got.label,
      by,
      re: names.length
        ? new RegExp(`(^|[^A-Za-z0-9'’])(${names.join('|')})(?![A-Za-z0-9])`, 'g')
        : null,
    };
  } catch (err) {
    // A write-up with no rules links reads exactly as it did last week. Not
    // worth a toast, and definitely not worth stopping the page for.
    rules = null;
  }
}

// Where each rule name falls in a passage, skipping anything the campaign’s
// own names have already claimed.
//
// First occurrence only, per name, per passage — the same rule the wikilinker
// uses next door, and for the same reason: the fourth Fireball in a paragraph
// connects nothing the first did not.
function ruleSpans(raw, taken) {
  if (!rules?.re) return [];
  const spans = [];
  const seen = new Set();
  rules.re.lastIndex = 0;
  let m;
  while ((m = rules.re.exec(raw))) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    rules.re.lastIndex = end;
    if (seen.has(m[2]) || taken(start, end)) continue;
    seen.add(m[2]);
    spans.push({ start, end, url: rules.by.get(m[2]) });
  }
  return spans;
}
// ==========================================================================
// Correcting a write-up
// ==========================================================================
//
// The summariser writes what it heard, and what it heard is sometimes wrong.
// A correction is a LAYER over the write-up and never a change to it: the
// original stays underneath exactly as written, a correction strikes one line
// through and says what it should say instead, and taking the correction away
// brings the original line straight back. Nothing here can delete anything,
// which is what makes it safe to hand to a whole table rather than to whoever
// runs it.
//
// Two states, and being in the second one is meant to be obvious — see
// .writeup.marking. Reading draws the corrected text and nothing else: one
// document, one truth, the same words /recap and the vault export give you.
// Correcting draws the argument as well.

// How long after the last keystroke the correction goes to the Pi.
//
// There is no Save button on purpose. A correction is one sentence typed in
// the middle of reading, and asking somebody to press a button afterwards is
// asking them to lose one. Long enough not to send a request per letter,
// short enough that stopping to think means it is already saved.
const MARK_WAIT = 700;

// What is being typed, and whether it is on disk. Module state rather than
// view state: the five-second poll rebuilds `notes` under the box, and a
// half-typed sentence must not be part of what gets rebuilt.
const markDraft = { part: null, index: 0, text: '', saved: '', noteId: null, timer: 0, say: '' };

// Correcting is for people the bot can name. Everything a correction is —
// somebody’s words, in their colour, that only they may change — needs an
// account behind it, so the switch is simply not there for a reader who has
// not signed in.
const mayMark = () => Boolean(me?.signedIn && notes?.written && !notes?.unreadable);
const marking = () => Boolean(view.marking && mayMark());

// The lines of one part of the write-up, as the page draws them.
//
// `notes.marks` is the whole truth — the summariser’s line, the corrections
// on it, and what it reads as now — indexed exactly as a correction is
// anchored. Reading drops the lines that were struck out with nothing put
// back; correcting keeps them, because putting one back is a thing you come
// in here to do.
function partLines(part) {
  const found = (notes?.marks ?? []).find((p) => p.part === part);
  if (found) return marking() ? found.lines : found.lines.filter((l) => !l.gone);

  // A bot that has not caught up. The dashboard is a bind mount and the API
  // is a container, so for a few seconds during a deploy they are not the
  // same age — and a write-up that will not draw is a worse answer than one
  // drawn without its marks.
  const scene = /^scene:(\d+)(:title)?$/.exec(part);
  const from = scene
    ? (scene[2] ? notes?.scenes?.[Number(scene[1])]?.title : notes?.scenes?.[Number(scene[1])]?.points)
    : notes?.[part];
  const list = Array.isArray(from) ? from : from ? [from] : [];
  return list.map((base, index) => ({ index, base, reading: base, marks: [], struck: false, gone: false }));
}

// Who wrote a correction, in their own colour. The colour is an affordance
// for reading a redline at a glance and not the identity — somebody who has
// never picked one is written in the page’s own ink and named just the same.
function markVoice(mark) {
  return voiceClass(mark?.userId, notes?.colours?.[mark?.userId]);
}

// One line, in whichever of the two states the page is in.
function drawLine(part, e) {
  if (!marking()) return wiki(e.reading);

  const at = `${part} ${e.index}`;
  const open = view.markAt === at;
  const last = e.marks[e.marks.length - 1] ?? null;

  const said = e.gone
    ? '<span class="mgone">struck out</span>'
    : `<span class="mnew${last ? markVoice(last) : ''}">${wiki(e.reading)}</span>`;

  return `<span class="mline${open ? ' open' : ''}${last ? ' marked' : ''}"`
    + ` data-mark-line="${esc(at)}">`
    + (last ? `<span class="mstruck">${wiki(e.base)}</span> ` : '')
    + (last ? said : wiki(e.base))
    + (last ? `<span class="mwho">${esc(markNames(e))}</span>` : '')
    + (open ? markBox(e) : '')
    + '</span>';
}

// Whose correction it is, said once however many times they changed it.
function markNames(e) {
  const who = [...new Set(e.marks.map((m) => nameOf(m.userId)))];
  return who.length === 1 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
}

// A display name for a Discord id, from whatever the page already knows —
// the roster first, because that is where a character name lives.
function nameOf(userId) {
  // The roster's own words, which is where a character name lives — somebody
  // who has told the table they play Kaelen Vance is Kaelen Vance in a
  // margin, not their Discord handle.
  const row = (detail?.roster ?? []).find((r) => String(r.userId) === String(userId));
  if (row) return row.characterName || row.displayName || 'somebody at the table';
  if (me?.signedIn && String(me.userId) === String(userId)) return 'you';
  return 'somebody at the table';
}

// The box, which is the same box whether it is making a correction or
// changing one. data-key so the patcher keeps the very node being typed in
// when the poll rebuilds the pane around it — that, and morph’s rule about
// never touching a focused field, is what lets this stay open for as long as
// somebody takes to write a sentence.
function markBox(e) {
  const last = e.marks[e.marks.length - 1] ?? null;
  const mine = last && me?.signedIn && String(last.userId) === String(me.userId);
  return `
    <span class="mark-edit" data-key="mark-edit" data-mark-keep>
      <textarea class="mark-box" id="mark-box" rows="2" spellcheck="true"
        aria-label="What this line should say"
        placeholder="What it should say instead">${esc(markDraft.text)}</textarea>
      <span class="mark-row">
        <span class="mark-say" id="mark-say" data-key="mark-say" role="status">${esc(markDraft.say)}</span>
        <button type="button" class="btn xs" data-mark-strike>Strike this line out</button>
        ${last && mine ? '<button type="button" class="btn xs ghost" data-mark-undo>Restore the original</button>'
          : last && canManage() ? '<button type="button" class="btn xs ghost" data-mark-undo>Take this correction down</button>' : ''}
      </span>
    </span>`;
}

// --- opening, typing, saving, closing -------------------------------------

function markSay(word, how = '') {
  markDraft.say = word;
  // Poked straight into the node rather than painted. This has to keep up
  // with typing, and a repaint per keystroke would be the one thing on this
  // page that fights the person using it.
  const node = $('mark-say');
  if (node) { node.textContent = word; node.className = `mark-say ${how}`; }
}

function markOpen(part, e) {
  markFlush();
  const last = e.marks[e.marks.length - 1] ?? null;
  const mine = last && me?.signedIn && String(last.userId) === String(me.userId);
  markDraft.part = part;
  markDraft.index = e.index;
  // Somebody else’s correction is not yours to change, so you start from
  // what the line reads as and write your own on top of theirs.
  markDraft.noteId = mine ? last.id : null;
  markDraft.text = e.gone ? '' : String(e.reading ?? '');
  markDraft.saved = mine ? String(last.body ?? '') : null;
  markDraft.say = '';
  view.markAt = `${part} ${e.index}`;
  paint();
  const box = $('mark-box');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}

function markClose() {
  markFlush();
  markDraft.part = null;
  markDraft.noteId = null;
  markDraft.text = '';
  markDraft.say = '';
  view.markAt = null;
}

// Whatever is pending, now rather than in 700ms. Called on the way out of a
// line, because leaving is a stronger signal that you have finished than
// stopping typing is.
function markFlush() {
  if (!markDraft.timer) return;
  clearTimeout(markDraft.timer);
  markDraft.timer = 0;
  markStore();
}

function markTyped(value) {
  markDraft.text = value;
  markSay('unsaved');
  clearTimeout(markDraft.timer);
  markDraft.timer = setTimeout(() => { markDraft.timer = 0; markStore(); }, MARK_WAIT);
}

// The one that talks to the Pi.
//
// Deliberately not send(): that toasts and re-reads the whole world, which is
// right for a button and wrong for something that happens while you are still
// typing the next word. This says so in the box instead.
async function markStore({ striking = false } = {}) {
  const part = markDraft.part;
  if (!part || !notes || !view.campaignId) return;

  const text = striking ? '' : String(markDraft.text ?? '').trim();

  // An empty box on a line nobody has corrected is how you arrive, not a
  // decision. Striking a line out is a decision, and it has its own button.
  if (!text && !striking && markDraft.noteId === null) { markSay(''); return; }
  if (markDraft.noteId !== null && text === markDraft.saved) { markSay('saved', 'saved'); return; }

  markSay('saving…');
  const at = { campaignId: view.campaignId, meetingId: notes.meetingId };
  let res;
  try {
    res = markDraft.noteId !== null
      ? await post('/actions/recap/note-edit', { ...at, noteId: markDraft.noteId, body: text })
      : await post('/actions/recap/note', { ...at, part, index: markDraft.index, body: text });
  } catch (err) {
    markSay('not saved — the bot did not answer', 'failed');
    return;
  }
  if (!res.ok || res.payload?.ok === false) {
    markSay(res.payload?.message || 'not saved', 'failed');
    return;
  }

  if (res.payload?.note?.id) markDraft.noteId = res.payload.note.id;
  markDraft.saved = text;
  markSay('saved', 'saved');
  await reReadNotes();
  paint();
}

// Taking a correction down. The only destructive act here, and what it
// destroys is a correction rather than a write-up: the summariser’s line is
// back on the page the moment it goes.
async function markUndo() {
  clearTimeout(markDraft.timer);
  markDraft.timer = 0;
  const e = markLineAt(view.markAt);
  const last = e?.marks?.[e.marks.length - 1];
  if (!last) { markClose(); return paint(); }

  markSay('putting it back…');
  const res = await post('/actions/recap/note-remove',
    { campaignId: view.campaignId, noteId: last.id });
  if (!res.ok || res.payload?.ok === false) {
    markSay(res.payload?.message || 'not removed', 'failed');
    return;
  }
  markClose();
  await reReadNotes();
  paint();
}

// The line an anchor points at, read back out of what the page last drew.
function markLineAt(at) {
  const cut = String(at ?? '').lastIndexOf(' ');
  if (cut < 0) return null;
  const part = at.slice(0, cut);
  const index = Number(at.slice(cut + 1));
  return partLines(part).find((l) => l.index === index) ?? null;
}

// syncNotes() is keyed on the session and its job, and a correction changes
// neither — so it would keep handing back the copy it already had. This is
// the way to say "no, really, again".
async function reReadNotes() {
  if (!notes?.meetingId) return;
  const fresh = await get(`/notes?meeting=${notes.meetingId}`).catch(() => null);
  if (fresh) notes = fresh;
}

// --- wikilinks -------------------------------------------------------------
//
// Every NPC and every place a write-up has named already has somewhere to be
// on this page. So a recap that names one should be a way of getting there,
// and this is what makes it one: the campaign's own compendium is the
// vocabulary, and any name in it that turns up in the prose becomes a link to
// that entry.
//
// The rules are deliberately the four the Obsidian exporter already uses, in
// export/linkify.js, so a name is a link in the vault if and only if it is a
// link here:
//
//   * FIRST OCCURRENCE ONLY, per name, per passage. A link either exists or
//     it does not; the fourth "Kerowyn" in a paragraph adds nothing to what
//     is connected and costs the sentence its rhythm.
//   * CASE-SENSITIVE. These are proper nouns, and matching loosely would put
//     a link on "the citadel" in ordinary prose.
//   * WHOLE WORDS, with a trailing possessive left outside the link, so
//     "Kerowyn's" links Kerowyn rather than something called "Kerowyn's".
//   * LONGEST FIRST, so "Sunless Citadel" is linked whole instead of having
//     "Citadel" claimed out from under it.
//
// Nothing is asked of the summariser for this, on purpose. Links written into
// the stored recap would exist only for sessions summarised after the prompt
// changed; every session already written would need re-summarising — real
// money, on the owner's bill — to gain one; and the model would be inventing
// link targets with no way of knowing which entries exist. Linking at the
// moment of reading, against the list the campaign actually has, is
// retrospective for nothing and cannot point at a page that is not there.

const MIN_LINK_WORD = 3;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A name worth matching on. Proper nouns start with a capital, and a short
// single word — an NPC called "Al" — would fire on any stray occurrence.
const matchable = (name) =>
  /^[A-Z]/.test(name) && (name.includes(' ') || name.length >= MIN_LINK_WORD);

function vocabulary() {
  if (!compendium || compendium.campaignId !== view.campaignId) return [];
  const out = [];
  for (const kind of ['npcs', 'places']) {
    for (const e of compendium[kind] ?? []) {
      if (matchable(e.name)) out.push({ name: e.name, kind, key: e.key });
    }
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

// Where in a passage each name falls, once. Shared by the two things that
// need it — the reader, which wraps a name in a button, and the clipboard,
// which wraps it in brackets — so a link is in one if and only if it is in the
// other.
//
// `except` is the entry currently being read, so an NPC's own page does not
// fill up with links back to itself.
function wikiSpans(raw, except) {
  const vocab = vocabulary().filter((v) => `${v.kind}:${v.key}` !== except);
  if (!raw || !vocab.length) return [];

  const spans = [];
  const clash = (start, end) => spans.some((sp) => start < sp.end && end > sp.start);

  for (const v of vocab) {
    // The apostrophe is excluded BEFORE the name and allowed after it. Before,
    // it stops "Malley" matching inside "O'Malley"; after, allowing it is what
    // makes a possessive link at all. Whitespace inside a name matches any run
    // of it, because a name copied out of a transcript really does sometimes
    // carry two spaces.
    const re = new RegExp(
      `(^|[^A-Za-z0-9'\u2019])(${escapeRe(v.name).replace(/\s+/g, '\\s+')})(?![A-Za-z0-9])`,
      'g'
    );
    let m;
    while ((m = re.exec(raw))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      // The first occurrence that is still free. A longer name having claimed
      // this one does not mean this name goes unlinked in the passage.
      if (!clash(start, end)) { spans.push({ start, end, v }); break; }
      re.lastIndex = end;
    }
  }

  // The rules go in after the campaign’s own names and never over them. A
  // table that has an NPC called Sanctuary means the person, and the one
  // thing this must not do is send a reader out of the product to read about
  // somebody they know.
  spans.push(...ruleSpans(raw, clash));
  return spans.sort((a, b) => a.start - b.start);
}

// Escaping and linking happen in one pass. Two passes would mean either
// matching names inside text that is already escaped — where "&amp;" is
// something a name could be found in the middle of — or building a tag into a
// string that is escaped afterwards, which prints the tag.
function wiki(text, except = null) {
  const raw = String(text ?? '');
  const spans = wikiSpans(raw, except);
  if (!spans.length) return esc(raw);

  let out = '';
  let at = 0;
  for (const sp of spans) {
    const word = esc(raw.slice(sp.start, sp.end));
    out += esc(raw.slice(at, sp.start));
    out += sp.url
      ? `<a class="rule" href="${esc(sp.url)}" target="_blank" rel="noopener noreferrer"`
        + ` title="Read ${word} on the ${esc(rules?.label ?? 'rules')} wiki">${word}</a>`
      : `<button type="button" class="wiki" data-entry="${sp.v.kind}:${esc(sp.v.key)}">${word}</button>`;
    at = sp.end;
  }
  return out + esc(raw.slice(at));
}

// The same links, written the way a vault writes them. What this page draws as
// an underline is [[Wren Halloway]] in a file, and a recap pasted into Obsidian
// ought to arrive already joined to the notes the exporter makes.
function wikiText(text) {
  const raw = String(text ?? '');
  const spans = wikiSpans(raw, null);
  if (!spans.length) return raw;

  let out = '';
  let at = 0;
  for (const sp of spans) {
    const word = raw.slice(sp.start, sp.end);
    // A rules link is left as plain words. [[Fireball]] in a vault means a
    // note called Fireball, which the exporter does not write and the reader
    // does not have — so bracketing it would fill their graph with dead ends.
    // The address is on the page they copied it from.
    out += raw.slice(at, sp.start) + (sp.url ? word : `[[${word}]]`);
    at = sp.end;
  }
  return out + raw.slice(at);
}

const dotFor = (state) => `<span class="dot ${state === true ? 'ok' : state === false ? 'bad' : ''}"></span>`;

// What this viewer may do.
//
// The server has already cut the payload to match — see web/scope.js — so
// nothing here is a security control. It is what stops the page rendering a
// row of buttons that would all answer 403, which is a worse way to learn what
// you are allowed to do than not being offered it.
//
// Defaults to true against a bot too old to answer /me, so an out-of-step
// deploy degrades to the behaviour that existed before levels did.
const cap = (name) => (me?.can ? Boolean(me.can[name]) : true);

// Starting a campaign needs somewhere to put it. The bot works out which
// servers those are and sends the list; an empty list means the button would
// only ever open a dialog with nothing to pick, so it is not drawn at all.
const canCreate = () => status?.actionsEnabled !== false && (status?.canCreateIn?.length ?? 0) > 0;

// Deleting is not the same authority as managing. A server owner can manage a
// campaign in their Discord; only whoever actually runs it can delete it. The
// bot decides — this only mirrors the answer so the button is not drawn for
// somebody who would be refused.
const RESTORE_DAYS = 30;
const canDelete = () =>
  status?.actionsEnabled !== false && Boolean(detail?.viewerCan?.delete);

// Whether actions are possible at all: the bot must accept them, and this
// viewer must be allowed to make them.
const can = () => status?.actionsEnabled !== false && cap('approvals');

// Managing one campaign is a different question from the machinery — a
// campaign's own creator may edit its roster without being able to pause a
// queue that belongs to somebody else's hardware.
const canManage = () => status?.actionsEnabled !== false && (detail?.viewerCan?.manage ?? cap('manage'));
// Renaming is narrower than managing: the campaign's DM and the bot owner.
// Answered by the bot on /campaign (viewerCan.rename), so the pencil is drawn
// for exactly the people campaign/rename would accept.
const canRename = () => status?.actionsEnabled !== false && Boolean(detail?.viewerCan?.rename);

// Handing a campaign to somebody else. Narrower than managing it: who runs a
// campaign is a question about who somebody IS on this bot, and assigning that
// sits with the Level and Tier columns rather than inside one campaign's own
// settings. A manager keeps everything else on this screen.
const canHandOver = () => status?.actionsEnabled !== false && cap('everything');

// Where this campaign's notes end up, in words.
//
// Not a channel name with a # in front of it: a campaign's `channel` is the
// last VOICE channel it recorded in, and the default destination is that
// channel's own text feed — or NOTES_CHANNEL_ID, if the Pi sets one. Naming a
// channel here would be a guess, and it would be wrong on exactly the installs
// that configured something.
const destination = () =>
  detail?.output === 'dm' ? 'you, as a DM'
  : detail?.output === 'channel' ? "this campaign's notes channel"
  : 'the channel you played in';

const campaign = () => status?.campaigns?.find((c) => c.id === view.campaignId) ?? null;
const sessions = () => (detail?.sessions ?? []).map(normalise);
const selected = () => sessions().find((s) => s.meetingId === view.meetingId) ?? null;

// A bot older than this page does not send `state`, `job` or the recap facets.
// Deriving what can be derived keeps the page useful against it rather than
// printing "undefined" in every pill — the two are deployed from different
// places (this file from a bind mount, the fields from an image), so they are
// routinely a few minutes out of step.
function normalise(s) {
  if (s.state) return s;
  const st = s.status ?? '';
  return {
    ...s,
    state: st === 'done' ? 'posted' : st.endsWith('_failed') ? 'failed' : st === 'recording' ? 'recording' : 'queued',
    npcs: 0, locations: 0, threads: 0, tldr: '',
    discardable: s.lines === 0 && st !== 'recording',
  };
}

