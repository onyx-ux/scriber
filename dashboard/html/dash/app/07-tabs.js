// dashboard/html/dash/app/07-tabs.js: The table, Search, Corrections and Settings tabs, stepping between nights, and the voice colours.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// The table
// ==========================================================================

const CONSENT_CLASS = { granted: 'agreed', declined: 'declined', pending: 'waiting', expired: 'waiting' };

// Where somebody stands on being recorded, in one column of a table.
//
// The withdrawn case is the only label with two things in it — "stopped —
// earlier lines kept" is a state and a caveat — and at 190px it wrapped
// mid-phrase and left "kept" hanging on its own under a right-aligned cell,
// which broke the row rhythm of every table it appeared in. Split at the dash,
// the state takes the line and the caveat sits under it as the quiet note it
// always was. Every other label is a single phrase and is unchanged.
function consentCell(p) {
  const tone = p.consent.withdrawn ? 'declined' : CONSENT_CLASS[p.consent.state] || 'never';
  const [state, ...rest] = String(p.consent.label ?? '').split('—');
  const note = rest.join('—').trim();
  return `
    <span class="as-stack">
      <span class="as-val ${tone}">${esc(state.trim())}</span>
      ${note ? `<span class="as-note">${esc(note)}</span>` : ''}
    </span>`;
}

function rosterTab() {
  const roster = detail.roster;
  const waiting = roster.filter((p) => !p.consent.mayRecord);
  const total = roster.reduce((sum, p) => sum + p.lines, 0) || 1;

  // A table set up to record everyone on its roster — see campaign/opt-out.js
  // on the bot. Nobody here was asked anything, so none of the words about
  // agreeing, answering or DMs are true of it, and it gets its own.
  const asks = detail.optOut !== false;

  const heading = asks
    ? (waiting.length
      ? `${waiting.length === 1 ? 'One person' : `${waiting.length} people`} still to hear from`
      : 'Everyone at this table has agreed')
    : (waiting.length
      ? `${waiting.length === 1 ? 'One person here is' : `${waiting.length} people here are`} not being recorded`
      : 'Everyone at this table is recorded');

  return `
    <div class="pane-wide" style="padding-top:30px">
      <h1 class="display sm">${esc(heading)}</h1>
      <div class="say-2" style="font-size:15px;max-width:64ch">
        ${!asks
          ? `This campaign was set up to record everyone on its roster, without asking each of them. ${waiting.length
              ? `${esc(listNames(waiting))} ${waiting.length === 1 ? 'has' : 'have'} been heard in the channel but ${waiting.length === 1 ? 'is' : 'are'} not on it, so ${waiting.length === 1 ? 'their microphone is' : 'their microphones are'} skipped until you add them.`
              : 'Quill has not messaged any of them about it; telling the table the game is recorded is yours to do.'}
             Taking somebody off with <code>/campaign remove</code> stops their microphone from that moment.`
          : waiting.length
          ? `Quill records nobody who has not agreed. Until ${esc(listNames(waiting))} ${waiting.length === 1 ? 'answers' : 'answer'}, their microphones are skipped and the rest of the table is recorded as normal.`
          : 'Everyone here has said yes in a DM. Anyone who changes their mind can be removed with <code>/campaign remove</code>, and nothing of theirs is captured from that moment on.'}
      </div>

      <div class="grid roster${waiting.length ? '' : ' settled'}" style="margin-top:30px">
        <div class="hd">
          <div>Player</div><div>Character</div>
          <div class="r">Lines</div><div class="r">Share</div>
          ${waiting.length ? `<div class="r">${asks ? 'Consent' : 'Recorded'}</div>` : ''}
        </div>
        ${roster.map((p) => {
          const pct = Math.round((p.lines / total) * 100);
          const who = whoIs(p);
          return `<div class="tr">
            <div>${esc(who)}</div>
            <div>${characterCell(p, who)}</div>
            <div class="r mono">${p.lines ? n(p.lines) : '—'}</div>
            <div class="r"><span class="share">
              <i class="${p.lines ? '' : 'quiet'}"><b style="width:${p.lines ? pct : 0}%"></b></i>
              <span class="mono" style="font-size:12px;color:var(--dim);width:34px;text-align:right">${p.lines ? `${pct}%` : ''}</span>
            </span></div>
            ${waiting.length ? `
            <div class="r" style="display:flex;justify-content:flex-end;align-items:center;gap:10px">
              ${asks ? consentCell(p) : `<span class="as-val ${p.consent.mayRecord ? 'agreed' : 'never'}">${p.consent.mayRecord ? 'recorded' : 'not on the roster'}</span>`}
              ${(asks ? askable(p) : canManage() && !p.consent.mayRecord) ? `<button type="button" class="btn sm" data-act="roster/invite" data-campaign="${detail.id}"
                data-user="${esc(p.userId)}">${!asks ? 'Add' : p.consent.state === 'pending' ? 'Ask again' : 'Invite'}</button>` : ''}
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${roster.length ? '' : '<div class="quiet" style="padding:20px 0">Nobody at this table yet.</div>'}
      ${canManage() ? invitePanel() + inviteLinkPanel() : ''}
      ${asks && roster.some((p) => p.consent.withdrawn) ? `
        <div style="border-left:2px solid var(--edge);padding-left:16px;margin-top:26px;max-width:70ch">
          <div class="quiet">
            There is no control here to put someone back. If they want to be recorded again they run
            <code>/campaign consent</code> themselves — asking on their behalf is a conversation, not a button.
          </div>
        </div>` : ''}
      ${canManage() ? '' : disabledNote()}
    </div>`;
}

// Who it makes sense to ask.
//
// Not someone who already agreed, and never someone who turned recording off
// themselves — re-asking them is the one thing this screen must not offer,
// because it turns their own decision into something to be nagged about.
const askable = (p) => canManage() && !p.consent.mayRecord && !p.consent.withdrawn && p.consent.state !== 'declined';

const listNames = (people) => {
  const names = people.map(whoIs);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

// Ask somebody who is not on the roster yet.
//
// Typed, not pasted: the operator knows their table by the name in the channel,
// and a screen that demanded a Discord snowflake would send them back to the
// client to right-click somebody — which is exactly the errand this page exists
// to save. A pasted id still works, for a nickname the search cannot match.
function invitePanel() {
  const found = people.results;
  const asks = detail.optOut !== false;

  return `
    <div style="margin-top:34px;max-width:760px">
      <div class="cap" style="margin-bottom:12px">${asks ? 'Ask someone new' : 'Add someone new'}</div>
      <form class="row-btns" data-people-search>
        <input class="in" id="people-q" name="query" style="flex:0 0 280px"
               placeholder="a Discord name, or a pasted user id" value="${esc(people.query)}"
               aria-label="Search this server for a person">
        <button class="btn go" type="submit" ${people.busy ? 'disabled' : ''}>
          ${people.busy ? 'Looking…' : 'Search'}</button>
        ${people.query || found ? '<button class="btn ghost" type="button" data-people-clear>Clear</button>' : ''}
      </form>

      ${people.error ? `<div class="quiet" style="margin-top:12px;color:var(--brass-lit)">${esc(people.error)}</div>` : ''}

      ${found ? (found.length ? `
        <div class="grid" style="margin-top:18px">
          ${found.map((m) => {
            const already = detail.roster.find((p) => p.userId === m.userId);
            return `<div class="tr" style="grid-template-columns:36px 1fr 1fr auto">
              <div>${m.avatar
                ? `<img src="${esc(m.avatar)}" alt="" width="28" height="28" style="border-radius:50%">`
                : '<span class="dot" style="width:28px;height:28px;border-radius:50%"></span>'}</div>
              <div>
                <div style="font-size:14.5px">${esc(m.displayName)}</div>
                <div class="mono" style="font-size:11px;color:var(--dim);margin-top:2px">@${esc(m.username)}</div>
              </div>
              <div class="quiet">${already
                ? (already.consent.mayRecord ? (asks ? 'already agreed' : 'already on the roster')
                   : !asks ? 'heard here, not on the roster'
                   : already.consent.withdrawn ? 'turned recording off themselves'
                   : already.consent.state === 'pending' ? 'asked, waiting'
                   : 'on the roster, not asked')
                : 'not at this table yet'}</div>
              <div class="r">${already?.consent.mayRecord || (asks && already?.consent.withdrawn)
                ? ''
                : `<button type="button" class="btn sm go" data-act="roster/invite" data-campaign="${detail.id}"
                     data-user="${esc(m.userId)}">${asks ? 'Ask them' : 'Add them'}</button>`}</div>
            </div>`;
          }).join('')}
        </div>` : `<div class="quiet" style="margin-top:14px">
          Nobody in this server matches “${esc(people.query)}”. Discord matches on username and server nickname —
          or paste their user id (right-click them in Discord, Copy User ID).
        </div>`) : ''}

      <div class="quiet" style="margin-top:16px;max-width:70ch">
        ${asks
          ? `They get a DM explaining what is recorded, where it goes and how long it is kept, with the buttons to
             agree or refuse. Nothing of theirs is captured until they say yes.`
          : `They go straight onto the roster and are recorded from the next session. Quill sends them
             nothing, so letting them know is yours to do.`}
      </div>
    </div>`;
}

// Click the name to change it, rather than a form under every row. A roster of
// six players was six always-open text boxes, which read as a data-entry
// screen for something you set once.
function characterCell(p, who) {
  // Your own character is yours to name wherever you are welcome, which is
  // what /campaign setchar has always done. Anybody else's needs the table.
  const mine = me?.signedIn && p.userId && p.userId === me.userId;
  if (!canManage() && !mine) {
    return p.characterName ? esc(p.characterName) : '<span class="unset">not set</span>';
  }
  if (view.editing === p.userId) {
    return `<form class="row-btns" data-act="roster/character" data-campaign="${detail.id}" data-user="${esc(p.userId)}">
      <input class="in" name="name" style="width:140px" value="${esc(p.characterName || '')}"
             placeholder="character" aria-label="Character for ${esc(who)}" autofocus>
      <button class="btn sm go" type="submit">Save</button>
      <button class="btn sm ghost" type="button" data-cancel-edit>Cancel</button>
    </form>`;
  }
  return `<button class="charbtn" data-edit="${esc(p.userId)}"
            title="Click to set the character name">${
    p.characterName ? esc(p.characterName) : '<span class="unset">not set</span>'
  }</button>`;
}

// The roster used to carry a Voice column, and it is gone from here on
// purpose — twice over.
//
// It was in the wrong place: a colour only ever shows in a transcript, and a
// control lives where the thing it changes can be seen. Picking one from a
// table of names meant choosing blind and then going to look.
//
// And it was the wrong person’s: the column let whoever ran the campaign
// colour in the whole table. That reads as helpful and is not. This is the
// one setting on this bot purely about how a person is depicted, and the
// only opinion worth having about it belongs to the person it depicts. The
// picker is in the transcript legend now, on your own name and no other.

// The other way onto a roster: one address for the whole table.
//
// It was only ever offered on the first-run screen, which a manager sees once.
// A table that gained a player in month four had nowhere to ask for it, and
// nothing anywhere said that a link was live or let anybody pull one — the
// revoke action was written and tested and had no button. This is the button.
//
// `detail.inviteLink` is null when none is out and absent when the bot is too
// old to say, and those are different panels: against an old bot there is
// nothing true this could draw, so it draws nothing.
function inviteLinkPanel() {
  if (!detail || detail.inviteLink === undefined) return '';
  const link = detail.inviteLink;
  const table = detail.name || detail.label || 'this table';
  const until = link?.expiresAt
    ? new Date(link.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
    : '';
  const pull = `<button type="button" class="btn sm" data-act="invite/revoke" data-campaign="${detail.id}"
    data-confirm="Revoke the invite link for ${esc(table)}? Anyone still holding it gets nothing.">Revoke</button>`;

  return `
    <div style="margin-top:34px;max-width:760px">
      <div class="cap" style="margin-bottom:12px">Or hand out a link</div>
      ${!link ? `
        <button type="button" class="btn" data-act="invite/link" data-campaign="${detail.id}">Make an invite link</button>
        <div class="quiet" style="margin-top:12px;max-width:70ch">
          One address for the whole table, to paste wherever you already talk to each other. ${detail.optOut !== false
            ? 'Each person who opens it is asked, for themselves, whether Quill may record them.'
            : 'Each person who opens it is told this table records everyone, and joins on those terms or not at all.'}
          It stops working after two weeks, or when you revoke it.
        </div>` : link.url ? `
        <div class="invite-live">
          <code class="invite-link" data-key="invite-link">${esc(link.url)}</code>
          <button type="button" class="btn sm go" data-copy-invite>Copy link</button>
          ${pull}
        </div>
        <div class="quiet" style="margin-top:12px;max-width:70ch">
          <span class="dot ok"></span> Live${until ? ` until ${esc(until)}` : ''}. Anyone holding it can join
          ${esc(table)}${detail.optOut !== false
            ? ', and each of them is asked for themselves whether Quill may record them.'
            : '. They are told it records everyone at the table before they do.'}
        </div>` : `
        <div class="quiet" style="max-width:70ch;color:var(--amber)">
          A link is live, but this bot has no web address set (<code>DASHBOARD_URL</code> in
          <code>pi-service/.env</code>), so there is no address to show you.
        </div>
        <div class="row-btns" style="margin-top:12px">${pull}</div>`}
    </div>`;
}

// ==========================================================================
// From one night to the next
// ==========================================================================
//
// The phone's ribbon said "3 of 4" and offered no way to reach 2 or 4 short of
// opening the drawer and finding the night in a list. Two places now: a pair of
// arrows on the ribbon, for wherever the column is not on screen, and a line at
// the foot of the write-up, because the end of one night is exactly where
// somebody reading back through a campaign wants the next.
//
// The list is newest first, so the EARLIER night is the one after this in it.
// Earlier is on the left and later on the right, the way a book turns.

const STEP_BACK = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STEP_ON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function nightSteps(list, at) {
  const one = (to, word, glyph) => `
    <button type="button" class="menu-btn step" ${to ? `data-step-session="${to.meetingId}"` : 'disabled'}
            aria-label="${to ? `${word} night: ${esc(sessionName(to))}` : `No ${word.toLowerCase()} night`}"
            title="${to ? `${esc(sessionName(to))}${to.title ? ` · ${esc(to.title)}` : ''}` : `No ${word.toLowerCase()} night`}">${glyph}</button>`;
  return `<div class="ribbon-steps">${one(list[at + 1], 'Earlier', STEP_BACK)}${one(list[at - 1], 'Later', STEP_ON)}</div>`;
}

function nightTurn(s) {
  const list = sessions();
  const at = list.findIndex((x) => x.meetingId === s.meetingId);
  if (at < 0 || list.length < 2) return '';
  const one = (to, word, side) => (to ? `
    <button type="button" class="turn ${side}" data-step-session="${to.meetingId}">
      <span class="k">${word}</span>
      <span class="t">${esc(sessionName(to))}${to.title ? ` · ${esc(to.title)}` : ''}</span>
    </button>` : '<span></span>');
  return `<nav class="night-turn measure" aria-label="Other sessions">
    ${one(list[at + 1], '← Earlier', 'back')}${one(list[at - 1], 'Later →', 'on')}
  </nav>`;
}

// A name the campaign met three times was written up three times, and the
// summariser is told to describe who somebody is — so "The notary's clerk" came
// back word for word under every night she appeared, and the shelf read as a
// stutter. The first telling is kept, in the place it was first told; the run
// of nights beside the name already says she came back.
//
// Folded the way names are, so a full stop or a capital the summariser dropped
// on the second night does not make it a different sentence.
function sameOnce(list) {
  const seen = new Set();
  return list.filter((x) => {
    const key = foldName(String(x?.text ?? ''));
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==========================================================================
// Search
// ==========================================================================
//
// One word, looked for in everything this campaign has. The transcript reader
// could always search the transcript it had open, which is only useful once
// you know which night it was — and "which night was it" is the question.
//
// Two halves, and who gets which is the same line the rest of the page draws.
// The write-ups are searched here, in the browser, out of the notes already
// read back for the shelves: anybody who can open the campaign can read all of
// them, so searching them asks the bot for nothing. The transcripts are
// searched by the bot (/search) and only for somebody who may open one.

const hunt = {
  query: '',        // what is in the box
  asked: '',        // what the results on screen are for
  busy: false,      // the transcripts are being searched
  error: '',
  lines: null,      // transcript lines; null is "not searched", [] is "nobody said it"
  truncated: false,
};

function huntReset() {
  hunt.query = ''; hunt.asked = ''; hunt.busy = false;
  hunt.error = ''; hunt.lines = null; hunt.truncated = false;
}

const FIND_GLYPH = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/>
  <path d="m10.6 10.6 3.4 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// The tab. A glyph with its word beside it, and on a phone the glyph alone:
// a fifth word would put the strip on two rows for whoever runs the campaign.
const findTab = () => `
    <button class="tab find${view.tab === 'search' ? ' on' : ''}" data-tab="search"
            aria-label="Search this campaign" title="Search this campaign">${FIND_GLYPH}<span class="lbl">Search</span>
    </button>`;

// The lists of a write-up, and what a line found in each is called.
const HUNT_PARTS = [
  ['partyDecisions', 'Decision'], ['unresolvedThreads', 'Thread'], ['followUps', 'Follow-up'],
  ['npcsIntroduced', 'NPC'], ['locationsVisited', 'Place'], ['lootAndRewards', 'Loot'],
  ['funnyMoments', 'Worth remembering'],
];

// Every line of every write-up that has the word in it, newest night first.
function notesMatching(q) {
  const needle = q.toLowerCase();
  const nights = [];
  for (const { session, notes: n } of [...(compendium?.story ?? [])].reverse()) {
    const hits = [];
    const look = (where, text) => {
      const s = String(text ?? '');
      if (s.toLowerCase().includes(needle)) hits.push({ where, text: s });
    };
    look('How it opens', n.tldr);
    for (const scene of n.scenes ?? []) {
      look('Scene', scene.title);
      for (const point of scene.points ?? []) look(scene.title || 'Scene', point);
    }
    for (const [part, word] of HUNT_PARTS) for (const line of n[part] ?? []) look(word, line);
    if (hits.length) nights.push({ session, hits });
  }
  return nights;
}

// The words either side of the one that was found. A summary can run to a
// paragraph, and the whole of it with one word lit is a paragraph to read
// again; this is the sentence it was in.
function snippet(text, needle, span = 110) {
  const s = String(text ?? '');
  const at = s.toLowerCase().indexOf(needle);
  if (at < 0) return esc(s);
  const end = at + needle.length;
  let from = Math.max(0, at - span);
  let to = Math.min(s.length, end + span);
  // Cut at a space, so the edges are whole words.
  if (from > 0) { const gap = s.indexOf(' ', from); if (gap > -1 && gap < at) from = gap + 1; }
  if (to < s.length) { const gap = s.lastIndexOf(' ', to); if (gap > end) to = gap; }
  return `${from > 0 ? '…' : ''}${esc(s.slice(from, at))}<mark>${esc(s.slice(at, end))}</mark>${esc(s.slice(end, to))}${to < s.length ? '…' : ''}`;
}

const HUNT_SHOWN = 6;   // lines of one write-up before "and N more"

function searchTab() {
  const q = hunt.asked;
  const needle = q.toLowerCase();
  const scripts = cap('transcripts');
  const reading = !compendium || compendium.campaignId !== view.campaignId || compendium.loading;
  const nights = q && !reading && !compendium.error ? notesMatching(q) : [];
  const written = nights.reduce((sum, x) => sum + x.hits.length, 0);

  // Transcript lines arrive newest night first and in the order they were
  // said, so consecutive runs are the nights.
  const heard = [];
  for (const line of hunt.lines ?? []) {
    const last = heard[heard.length - 1];
    if (last && last.meetingId === line.meetingId) last.lines.push(line);
    else heard.push({ meetingId: line.meetingId, sessionNumber: line.sessionNumber, startedAt: line.startedAt, lines: [line] });
  }

  const row = (where, html) => `
    <div class="ledger-row found"><span class="where">${esc(where)}</span><span class="thing">${html}</span></div>`;

  const inNotes = !q ? '' : `
    <div class="cap" style="margin-top:36px">In the write-ups${reading || !written ? '' : ` · ${plural(written, 'line')}`}</div>
    ${reading ? '<div class="quiet" style="margin-top:12px">Reading back through the campaign…</div>'
      : compendium.error ? `<div class="quiet" style="margin-top:12px">The write-ups did not read back — ${esc(compendium.error)}</div>`
      : nights.length ? `<div class="ledger hunt">${nights.map(({ session, hits }) => `
          ${nightRule(session)}
          ${hits.slice(0, HUNT_SHOWN).map((h) => row(h.where, snippet(h.text, needle))).join('')}
          ${hits.length > HUNT_SHOWN ? `<div class="quiet" style="padding:10px 0 2px 2px">and ${
            n(hits.length - HUNT_SHOWN)} more in this write-up</div>` : ''}`).join('')}</div>`
      : `<div class="quiet" style="margin-top:12px">No write-up mentions “${esc(q)}”.</div>`}`;

  const inScripts = !q || !scripts ? '' : `
    <div class="cap" style="margin-top:36px">In the transcripts${hunt.lines?.length
      ? ` · ${hunt.truncated ? `the first ${n(hunt.lines.length)} lines` : plural(hunt.lines.length, 'line')}` : ''}</div>
    ${hunt.busy ? '<div class="quiet" style="margin-top:12px">Looking through every transcript…</div>'
      : hunt.error ? `<div class="quiet" style="margin-top:12px;color:var(--amber)">${esc(hunt.error)}</div>`
      : heard.length ? `<div class="ledger hunt">${heard.map((g) => `
          <div class="ledger-night" data-key="heard-${g.meetingId}">
            <span class="n">${esc(sessionName(g))}</span>
            <span class="d">${esc(longDate(g.startedAt))}</span>
            <button type="button" class="btn sm ghost" data-transcript="${g.meetingId}"
                    data-find="${esc(q)}">Open transcript</button>
          </div>
          ${g.lines.map((l) => row(`${clock(l.ms)} · ${l.speaker}`, snippet(l.text, needle, 150))).join('')}`).join('')}</div>
          ${hunt.truncated ? `<div class="quiet" style="margin-top:14px">
            There are more than these. Add a word to narrow it down.</div>` : ''}`
      : hunt.lines ? `<div class="quiet" style="margin-top:12px">Nobody said “${esc(q)}” on the record.</div>`
      : ''}`;

  return `
    <div class="pane-wide" style="padding-top:30px">
      <h1 class="display sm">Find it in ${esc(detail.name || detail.label || 'this campaign')}</h1>
      <div class="say-2" style="font-size:15px;max-width:64ch">
        A name, a place, something somebody said. Quill looks through every write-up
        ${scripts ? 'and every transcript ' : ''}this campaign has.
      </div>
      <form class="row-btns hunt-form" data-campaign-search style="margin-top:22px" role="search">
        <input class="in" id="hunt-q" name="q" type="search" autocomplete="off" maxlength="80"
               placeholder="what are you looking for?" value="${esc(hunt.query)}"
               aria-label="Search this campaign">
        <button class="btn go" type="submit" ${hunt.busy ? 'disabled' : ''}>${hunt.busy ? 'Looking…' : 'Search'}</button>
        ${q ? '<button class="btn ghost" type="button" data-hunt-clear>Clear</button>' : ''}
      </form>
      ${!q && hunt.error ? `<div class="quiet" style="margin-top:12px;color:var(--brass-lit)">${esc(hunt.error)}</div>` : ''}
      ${inNotes}
      ${inScripts}
    </div>`;
}

async function runHunt(raw) {
  const q = String(raw ?? '').trim();
  hunt.query = q;
  hunt.error = '';
  hunt.lines = null;
  hunt.truncated = false;

  if (q.length < 2) {
    hunt.asked = '';
    // Said even for an empty box: a Search button that does nothing at all
    // when pressed reads as a broken one.
    hunt.error = 'Type two letters or more.';
    return paint();
  }
  hunt.asked = q;

  // The write-ups come out of the same read the shelves use. Normally it has
  // already happened, on opening the campaign; started here if it has not.
  if (!compendium || compendium.campaignId !== view.campaignId) buildCompendium();
  if (!cap('transcripts')) return paint();

  const id = view.campaignId;
  hunt.busy = true;
  paint();
  try {
    const got = await get(`/search?campaign=${id}&q=${encodeURIComponent(q)}`);
    // They searched again, or left, while this one was out.
    if (view.campaignId !== id || hunt.asked !== q) return;
    hunt.lines = got.lines ?? [];
    hunt.truncated = Boolean(got.truncated);
  } catch (err) {
    if (view.campaignId !== id || hunt.asked !== q) return;
    // A bot older than this page has no such route. The write-ups above are
    // still a real answer, so say what is missing rather than calling it broken.
    hunt.error = err.message === 'HTTP 404'
      ? 'This bot is a version behind the page and cannot search transcripts yet. The write-ups above are everything it could look through.'
      : `The transcripts could not be searched — ${err.message}.`;
  }
  hunt.busy = false;
  paint();
}

// "brass-deep" as somebody would say it out loud.
function voiceName(slug) {
  const [family, shade] = String(slug ?? '').split('-');
  const found = VOICE_FAMILIES.find(([id]) => id === family);
  return found ? `${shade === 'deep' ? 'Deep' : 'Bright'} ${found[1].toLowerCase()}` : '';
}

// ==========================================================================
// Corrections
// ==========================================================================

function correctionsTab() {
  const list = detail.corrections;
  return `
    <div style="display:flex;gap:40px;padding-top:30px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:0;max-width:900px">
        <h1 class="display sm">Names that come back wrong</h1>
        <div class="say-2 measure" style="font-size:15px">
          Fantasy names come out of a recording mangled. Write the fix once and Quill applies it to
          every future transcript, then replays it over the ones this campaign already has. You can
          also start one from a write-up, under <b>Fix a name</b>, which is usually where you notice.
        </div>

        ${list.length ? `
        <div class="grid corr" style="margin-top:30px">
          <div class="hd">
            <div>Heard as</div><div>Should read</div>
            <div class="r">In transcripts</div><div></div>
          </div>
          ${list.map((c) => `
            <div class="tr" data-key="fix-${esc(c.wrong)}">
              <div class="mono" style="font-size:14px;color:var(--text-2)">“${esc(c.wrong)}”</div>
              <div style="font-size:15px;font-weight:500">${esc(c.right)}</div>
              <div class="r mono" style="font-size:13px;color:var(--dim)">${c.lines == null ? '—' : `${n(c.lines)} lines`}</div>
              <div class="r">${canManage() ? `<button type="button" class="btn sm" data-act="corrections/remove"
                data-campaign="${detail.id}" data-wrong="${esc(c.wrong)}">Remove</button>` : ''}</div>
            </div>`).join('')}
          ${canManage() ? `
            <form class="tr" data-act="corrections/add" data-campaign="${detail.id}" style="border-bottom:0;padding-top:18px">
              <input class="in" name="wrong" placeholder="what it heard" required aria-label="Misheard text">
              <input class="in" name="right" placeholder="what it should say" required aria-label="Correct text">
              <div></div>
              <div class="r"><button class="btn go" type="submit">Add</button></div>
            </form>` : ''}
        </div>` : canManage() ? `
        <div class="cap" style="margin:34px 0 16px">Write the first one</div>
        <form class="pair" data-act="corrections/add" data-campaign="${detail.id}">
          <label>Heard as
            <input class="in" name="wrong" placeholder="what it heard" required>
          </label>
          <span class="pair-arrow" aria-hidden="true">→</span>
          <label>Should read
            <input class="in" name="right" placeholder="what it should say" required>
          </label>
          <button class="btn go" type="submit">Add the fix</button>
        </form>` : '<div class="quiet" style="padding-top:24px">No corrections saved yet.</div>'}
        ${canManage() ? '' : disabledNote()}
      </div>

      <div class="aside">
        <div class="card">
          <div class="cap">Replay</div>
          <h4>${list.length ? plural(list.length, 'rule') : 'Nothing saved'}</h4>
          <div class="quiet" style="margin-top:8px">
            Adding or removing a correction already works every transcript out again. Replay is for sessions
            that arrived from somewhere else — an import, or anything recovered from a crash.
          </div>
          ${canManage() && list.length ? `<button type="button" class="btn wide" style="margin-top:16px" data-act="corrections/replay"
            data-campaign="${detail.id}"
            data-confirm="Replay every correction over this campaign's transcripts?">Replay over everything again</button>` : ''}
        </div>
        <div class="card">
          <div class="cap">Taking one back</div>
          <div class="quiet" style="margin-top:10px">
            Write-ups are corrected as they are read and never rewritten, and transcripts keep what was
            heard underneath. Remove a correction and every line it changed goes back. Lines corrected
            before 27 September 2026 were rewritten in place and keep their fix.
          </div>
        </div>
      </div>
    </div>`;
}

// ==========================================================================
// Settings
// ==========================================================================

// What to call somebody on the roster.
//
// The display name is what the table calls them and is the right answer when
// there is one — but listRoster leaves it null for anybody the bot has never
// actually heard, which is exactly the person a DM enrolled last week and is
// about to hand the campaign to. Their character name is the next best thing
// they have been called, and the id is what is left.
const personName = (p) => p?.displayName || p?.characterName || p?.userId || '';

// The channels, grouped under their categories the way Discord's own sidebar
// draws them.
//
// The list arrives already in that order, so consecutive runs are the groups —
// no sorting here, and no second opinion about the order to disagree with the
// bot's. Uncategorised channels sit at the top with no heading, which is again
// what Discord does.
function channelOptions(channels, selectedId) {
  const groups = [];
  for (const c of channels ?? []) {
    const key = c.category ?? '';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(c);
    else groups.push({ key, items: [c] });
  }

  return groups
    .map((g) => {
      const opts = g.items
        .map((c) => `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>#${esc(c.name)}</option>`)
        .join('');
      return g.key ? `<optgroup label="${esc(g.key)}">${opts}</optgroup>` : opts;
    })
    .join('');
}

function settingsTab() {
  const s = status?.schedule ?? {};
  const roster = detail.roster;
  const agreed = roster.filter((p) => p.consent.mayRecord).length;
  const asked = roster.filter((p) => p.consent.state === 'pending' || p.consent.state === 'expired').length;
  const never = roster.filter((p) => p.consent.state === 'unasked' || p.consent.state === 'declined').length;
  const providers = status?.providers ?? [];
  const mode = detail.output === 'dm' ? 'dm' : detail.output === 'channel' ? 'channel' : 'default';
  const edition = detail.edition === '2014' ? '2014' : '2024';

  // What Discord said this bot may post in, when it was asked. Absent is not
  // empty: the list only rides along for somebody who may change the
  // destination, and only when the bot could reach Discord to draw it up.
  const channels = detail.postableChannels ?? null;
  const canPick = canManage() && Array.isArray(channels) && channels.length > 0;
  const chosenId = detail.outputChannelId ?? null;
  const chosen = chosenId ? channels?.find((c) => c.id === chosenId) ?? null : null;
  // Set to a channel that is not on the list any more. Said out loud rather
  // than drawn as "no channel chosen", because the campaign IS still pointed at
  // it — the delivery falls back to the channel you played in and nobody is
  // ever told, which is exactly how this goes unnoticed for a month.
  const strayChannel = mode === 'channel' && chosenId && Array.isArray(channels) && !chosen;
  const picking = mode === 'channel' || view.outputPicking;

  // Who runs this campaign, and who else at the table could. The manager is
  // left out of the list of heirs deliberately: an option that hands it to the
  // person who already has it is a no-op wearing a name.
  const manager = detail.managerUserId ?? null;
  const managerRow = manager ? roster.find((p) => p.userId === manager) : null;
  const managerName = manager ? personName(managerRow) || manager : 'unclaimed';
  const heirs = roster.filter((p) => p.userId && p.userId !== manager);

  const row = (what, sub, control) => `
    <div class="set-row">
      <div><div class="what">${what}</div><div class="sub">${sub}</div></div>
      <div>${control}</div>
    </div>`;

  return `
    <div style="display:flex;gap:40px;padding-top:30px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:0;max-width:820px">
        <h1 class="display sm">How this campaign runs</h1>

        <div class="cap" style="margin:28px 0 6px">What it is called</div>
        ${row('Name', 'Also the folder its notes are filed in, and the start of every session reference',
          `<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap">
             <span class="val">${esc(detail.name || detail.label || '')}</span>${canRename()
               ? '<button type="button" class="btn sm" data-rename>Rename</button>' : ''}</div>`)}

        <div class="cap" style="margin:28px 0 6px">Which rules you play</div>
        ${row('Rulebook', 'Only decides where a spell named in a write-up links to',
          `<div class="seg" data-seg="edition">
             <button type="button" class="${edition === '2014' ? 'on' : ''}" data-act="campaign/edition"
                     data-campaign="${detail.id}" data-edition="2014"
                     ${canManage() ? '' : 'disabled'}>2014</button>
             <button type="button" class="${edition === '2024' ? 'on' : ''}" data-act="campaign/edition"
                     data-campaign="${detail.id}" data-edition="2024"
                     ${canManage() ? '' : 'disabled'}>2024</button>
           </div>`)}
        <div class="quiet" style="margin-top:-6px;padding-bottom:14px;max-width:62ch">
          Spell names in a write-up link out to the D&amp;D wiki for this edition. Nothing else
          changes: Quill records, transcribes and summarises the same either way, and the two
          books do not have all the same spells — a name the chosen edition has no page for is
          left as plain words rather than sent to a dead link.
        </div>

        <div class="cap" style="margin:28px 0 6px">Where the notes go</div>
        ${row('Destination', 'Everyone in the channel sees the write-up, or only you do',
          // The middle option opens the picker rather than sending anything.
          // Choosing a channel is two facts — that it is a channel, and which
          // one — and a button that could only ever state the first would have
          // to guess the second.
          `<div class="seg" data-seg="output">
             <button type="button" class="${mode === 'default' ? 'on' : ''}" data-act="campaign/output" data-campaign="${detail.id}"
                     data-mode="default" ${canManage() ? '' : 'disabled'}>Where we played</button>
             <button type="button" class="${mode === 'channel' ? 'on' : ''}" data-pick-channel
                     ${canPick ? '' : 'disabled'}
                     ${canPick ? '' : `title="${canManage()
                       ? 'I could not ask Discord for this server’s channels just now'
                       : 'Only whoever runs this campaign can move where its notes go'}"`}>A chosen channel</button>
             <button type="button" class="${mode === 'dm' ? 'on' : ''}" data-act="campaign/output" data-campaign="${detail.id}"
                     data-mode="dm" ${canManage() && detail.claimed ? '' : 'disabled'}>DM to me</button>
           </div>`)}
        ${canPick && picking ? row('Which channel',
          strayChannel
            ? 'The one this was set to has gone, or I can no longer post in it'
            : 'Only channels Quill can both see and speak in are listed',
          // A list, never a box. A channel id is eighteen digits with no check
          // digit, so anything typed is well-formed whether or not it is real,
          // and the mistake shows up weeks later as a write-up nobody received.
          // No data-campaign on it, deliberately: the click dispatcher reads
          // that attribute as "open this campaign", so a dropdown wearing one
          // would reload the page out from under the person using it.
          `<select class="in chan" data-set-channel aria-label="Which channel the notes are posted in">
             <option value="" disabled ${chosen ? '' : 'selected'}>Choose a channel…</option>
             ${channelOptions(channels, chosen?.id ?? null)}
           </select>`) : ''}
        ${strayChannel ? `
        <div class="quiet" style="margin-top:-6px;padding-bottom:14px;color:var(--amber)">
          Until another is picked, these notes are posted back in the channel the session was recorded in.
        </div>` : ''}
        ${row('Last recorded in', 'The voice channel Quill most recently joined for this campaign',
          `<span class="val">${esc(detail.channel || 'never recorded')}</span>`)}
        ${row('Who writes them',
          providers.length > 1
            ? 'Chosen at the moment of approval, per session'
            : 'The only summariser with an API key on this bot',
          providers.length
            ? `<div class="seg">${providers.map((p) => `
                 <button class="${p === status?.health?.summariserName ? 'on' : ''}" disabled>${esc(providerName(p))}</button>`).join('')}</div>`
            : '<span class="val">none configured</span>')}

        ${canHandOver() ? `
        <div class="cap" style="margin:32px 0 6px">Who runs it</div>
        ${row('The campaign’s manager',
          manager
            ? 'They invite players, fix names, and decide where the notes go'
            : 'Nobody has claimed this campaign yet',
          `<span class="val${manager ? '' : ' unset'}">${esc(managerName)}</span>`)}
        ${heirs.length ? row('Hand it on',
          'Only somebody already at the table — invite them first if they are not',
          // A dropdown and then a press, rather than the channel picker's
          // choose-and-it-happens. Choosing where a recap is posted is undone
          // by choosing again; handing the campaign over gives somebody else
          // the say over this table's records, so it asks twice.
          `<div class="row-btns">
             <select class="in heir" data-heir aria-label="Who takes this campaign on">
               <option value="" disabled ${view.heir ? '' : 'selected'}>Choose who takes it on…</option>
               ${heirs.map((p) => `
                 <option value="${esc(p.userId)}"${p.userId === view.heir ? ' selected' : ''}>${
                   esc(personName(p))}${
                   // Only when it is a SECOND name. listRoster leaves
                   // displayName null for anybody the bot has never heard, so
                   // appending the character name unconditionally rendered
                   // "— Aurion" with nothing in front of the dash.
                   p.displayName && p.characterName ? ` — ${esc(p.characterName)}` : ''}${
                   p.lines ? '' : ' (never spoken)'}</option>`).join('')}
             </select>
             <button type="button" class="btn go" data-act="campaign/manager"
                     data-campaign="${detail.id}" data-user="${esc(view.heir ?? '')}"
                     ${view.heir ? '' : 'disabled'}
                     data-confirm="Hand ${esc(detail.name || detail.label || 'this campaign')} to ${
                       esc(heirs.find((p) => p.userId === view.heir)?.displayName ?? 'them')}? They run it from then on.">
               Hand it over
             </button>
           </div>`) : row('Hand it on',
          'A campaign can only be handed to somebody already on its roster',
          '<span class="val unset">nobody else at this table yet</span>')}
        ` : ''}

        <div class="cap" style="margin:32px 0 6px">Recording</div>
        ${row('Players can opt out',
          detail.optOut !== false
            ? 'Each player is asked in a DM, and can refuse or stop later'
            : 'Everyone on the roster is recorded, and Quill sends them nothing about it',
          `<span class="val">${detail.optOut !== false ? 'yes' : 'no'}</span>`)}
        ${row('Ask me before summarising', 'Nothing is posted until you release it',
          `<span class="val">${s.requireApproval ? 'on' : 'off'}</span>`)}
        ${row('Transcribe automatically', 'Only inside the window, so the PC is free while you work',
          `<div class="row-btns">
             <span class="val">${String(s.windowStartHour ?? 0).padStart(2, '0')}:00 – ${String(s.windowEndHour ?? 0).padStart(2, '0')}:00</span>
             <span class="val">${s.weekdaysOnly ? 'weekdays' : 'any day'}</span>
           </div>`)}
        ${row('Timezone',
          s.nextAutoWindowAt
            ? `Next window opens ${esc(longDate(s.nextAutoWindowAt))} at ${esc(hhmm(s.nextAutoWindowAt))}`
            : 'No automatic window scheduled',
          `<span class="val">${esc(s.timeZone || 'system')}</span>`)}

        <div class="quiet" style="margin-top:20px;max-width:70ch">
          The window, the timezone and the approval switch are set once in <code>pi-service/.env</code> on the
          Pi, because they describe the machine rather than this campaign. Inviting a player still happens in
          Discord, where the people it concerns are: <code>/campaign invite</code>.
        </div>
      </div>

      <div class="aside">
        ${audioCard()}
        ${detail.optOut !== false ? '' : `
        <div class="card">
          <div class="cap" style="color:var(--amber)">Recording · no opt-out</div>
          <h4>Everyone on the roster</h4>
          <div class="quiet" style="margin-top:8px;color:var(--text-2)">
            This campaign was made without an opt-out. Adding somebody records them from the next session;
            Quill sends them no DM and gives them no switch, so telling the table is yours to do.
            ${n(agreed)} ${agreed === 1 ? 'person' : 'people'} on the roster${roster.length - agreed
              ? `, and ${n(roster.length - agreed)} heard in the channel who ${roster.length - agreed === 1 ? 'is' : 'are'} not` : ''}.
          </div>
          ${roster.length - agreed ? `<button class="btn wide" style="margin-top:16px" data-tab="table">Go to the table</button>` : ''}
        </div>`}
        ${detail.optOut !== false ? consentCard(agreed, asked, never) : ''}
        <div class="card">
          <div class="cap">Reading it elsewhere</div>
          <div class="quiet" style="margin-top:10px">
            Every session is exported as markdown into the Obsidian vault on the Pi, alongside the campaign's
            NPC and location ledgers. <code>/campaign export</code> attaches a transcript in Discord.
          </div>
        </div>
        ${canDelete() ? `
        <div class="card danger">
          <div class="cap" style="color:var(--red-lit)">Deleting this campaign</div>
          <div class="quiet" style="margin-top:10px;color:var(--text-2)">
            It leaves every list straight away, and nothing is erased — not a session, not a line anybody
            spoke. You have ${RESTORE_DAYS} days to change your mind.
          </div>
          <button type="button" class="btn wide danger" style="margin-top:16px" data-delete-campaign>
            Delete ${esc(detail.name || detail.label || 'this campaign')}
          </button>
        </div>` : ''}
      </div>
    </div>`;
}

// Who has answered, at a table where each player is asked. Not drawn at all
// where nobody is: a tally of agreements nobody was asked for is three zeroes
// under a heading that is not true of that table.
function consentCard(agreed, asked, never) {
  return `
        <div class="card">
          <div class="cap">Consent · players choose</div>
          <div style="display:flex;flex-direction:column;gap:9px;margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:13.5px"><span>Agreed</span><span class="mono agreed">${agreed}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:13.5px"><span>Asked, waiting</span><span class="mono waiting">${asked}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:13.5px"><span>Never asked</span><span class="mono never">${never}</span></div>
          </div>
          ${asked + never ? `<button class="btn wide" style="margin-top:16px" data-tab="table">
            Ask the ${asked + never === 1 ? 'one who has not answered' : `${asked + never} who have not answered`}
          </button>` : ''}
        </div>`;
}

// What this install does with a recording.
//
// It used to be a fixed green card reading "Deleted once transcribed … never
// leaves your network and is not kept, and this cannot be turned off", which
// several settings on the Pi make untrue. The sentences come from the bot now
// (campaign/audio-facts.js), built from the same configuration the behaviour
// is, and they are the ones the invitation DM and the join screen show a
// player — so what a manager reads here is what their table was told.
//
// Green only when nothing leaves the bot's own machine. A card that is the
// colour of "all is well" while describing an upload to Google would be the
// old card's mistake made again in a different font.
function audioCard() {
  const a = detail?.audio;
  // A bot older than this page does not say. Nothing true can be drawn, so
  // nothing is — rather than the old promise.
  if (!a) return '';
  const local = !a.cloudTranscribe && !a.driveAudio;
  const head = a.retentionDays > 0
    ? `Deleted from the bot after ${plural(a.retentionDays, 'day')}`
    : 'Kept until you delete it';
  return `
    <div class="card${local ? ' good' : ''}">
      <div class="cap"${local ? ' style="color:var(--sage-lit)"' : ''}>Audio</div>
      <h4>${head}</h4>
      <ul class="facts-list">
        ${(a.lines ?? []).map((line) => `<li>${esc(line)}</li>`).join('')}
      </ul>
      <div class="quiet" style="margin-top:12px">
        ${detail.optOut !== false
          ? 'Each player is shown these same lines before they agree.'
          : 'Nobody at this table is sent these lines. They are here so you can tell them.'}
        Set in <code>pi-service/.env</code> on the Pi.
      </div>
    </div>`;
}

const disabledNote = () => `
  <div class="quiet" style="margin-top:18px;color:var(--brass-lit)">
    Actions are turned off on this bot — set <code>STATUS_TOKEN</code> in <code>pi-service/.env</code>
    (and in the dashboard) to act from here.
  </div>`;

// ==========================================================================
// The twenty-four voices
// ==========================================================================

// The twelve families, in the order the picker lays them out. The colours
// themselves are in the stylesheet, as .v-<family>-<shade>; this is the names
// and the order, which CSS cannot carry. Kept in step with
// pi-service/src/web/palette.js by test/palette.test.js, which reads both.
const VOICE_FAMILIES = [
  ['red', 'Red'], ['copper', 'Copper'], ['bronze', 'Bronze'], ['brass', 'Brass'],
  ['gold', 'Gold'], ['green', 'Green'], ['ocean', 'Ocean'], ['blue', 'Blue'],
  ['eldritch', 'Eldritch'], ['black', 'Black'], ['silver', 'Silver'], ['white', 'White'],
];

// A colour that came from somewhere else is not a colour.
//
// The server checks this on the way in and stores a slug, so nothing in the
// database should ever fail here. It is checked again on the way out because
// the value is about to become part of a class attribute, and "the server
// validated it" is a promise about today's server rather than about this
// line. Cheap, and it fails to plain ink rather than to broken markup.
const realVoice = (slug) => /^[a-z]+-(deep|bright)$/.test(String(slug ?? ''));

// Whether other people's colours are drawn at all.
//
// A per-viewer preference, kept in this browser beside the theme, because it
// is a fact about reading rather than about the table: two people can be
// looking at the same transcript and want different answers and neither is
// wrong.
//
// Yours is always drawn. Turning colours off is about the other five names —
// finding your own line in four hours of talk is the reason somebody picked a
// colour in the first place, and switching that off is not what the button is
// for.
const VOICES_OFF = 'quill-voices-off';
function voicesShown() {
  try { return localStorage.getItem(VOICES_OFF) !== '1'; } catch (e) { return true; }
}
function showVoices(on) {
  try {
    if (on) localStorage.removeItem(VOICES_OFF); else localStorage.setItem(VOICES_OFF, '1');
  } catch (e) { /* a browser with storage turned off keeps them on */ }
}

// The second way in, and the only one most of a table has.
//
// The picker belongs in the transcript, where the colour is the whole point of
// looking. The trouble is that a PLAYER cannot open a transcript — deliberately
// and correctly: a recap is the table's shared account of an evening, and a
// transcript is every word five people said, which being at the table does not
// entitle you to. See viewer.js.
//
// So a picker that lives only in the transcript legend is a picker only the DM
// can reach, and everybody else is colourless forever — which is the opposite
// of "your own, and nobody else's". This is the same dialog, on the panel that
// is already about you, shown while you are inside a campaign because a colour
// belongs to one table rather than to an account.
function myInkRow() {
  if (!me?.signedIn || !view.campaignId || !detail) return '';
  const mine = (detail.roster ?? []).find((r) => String(r.userId) === String(me.userId));
  const colour = mine?.colour ?? null;
  const ink = voiceClass(me.userId, colour);
  return `
    <button type="button" class="sheet-ink${ink}" data-voice-for="${esc(me.userId)}"
            title="How your name is written in transcripts at ${esc(detail.label || detail.name || 'this table')}">
      <i class="voice-dot tiny${colour && realVoice(colour) ? '' : ' unset'}"><i class="swatch"></i></i>
      <span class="what">${colour ? esc(voiceName(colour)) : 'No colour yet'}</span>
      <span class="quiet">in ${esc(detail.label || detail.name || 'this table')}</span>
    </button>`;
}

// A way to pick your colour on a night you did not speak.
//
// The picker sits on your own name in the legend, and the legend is who
// spoke — so somebody who sat out a session, or joined the table afterwards,
// would have nowhere to set one from. Shown only in that case, so there are
// never two ways to open the same dialog in one panel.
function myVoiceRow() {
  if (!me?.signedIn || !view.campaignId) return '';
  if ((script?.speakers ?? []).some((sp) => String(sp.userId) === String(me.userId))) return '';

  const mine = (detail?.roster ?? []).find((r) => String(r.userId) === String(me.userId));
  const colour = mine?.colour ?? null;
  const ink = voiceClass(me.userId, colour);
  return `
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--rule)">
      <div class="${ink.trim()}" style="display:flex;align-items:center;gap:11px">
        <button type="button" class="voice-pick${ink ? ' voiced' : ''}" data-voice-for="${esc(me.userId)}"
                style="width:auto"
                title="${colour ? `${esc(voiceName(colour))} — press to change how your name is written`
                  : 'Pick the colour your name is written in'}">
          <i class="voice-dot tiny${colour && realVoice(colour) ? '' : ' unset'}"><i class="swatch"></i></i>
          <span>Your colour</span></button>
        <span class="quiet" style="font-size:11.5px">you did not speak in this one</span>
      </div>
    </div>`;
}

// The classes that write something in somebody's colour, or nothing at all.
// Both classes or neither, deliberately: `voiced` on its own would ask for a
// property that is not set anywhere.
function voiceClass(userId, colour) {
  if (!colour || !realVoice(colour)) return '';
  const mine = Boolean(me?.signedIn && userId && String(userId) === String(me.userId));
  if (!voicesShown() && !mine) return '';
  return ` voiced v-${colour}`;
}

