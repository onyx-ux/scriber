// dashboard/html/dash/app/03-chrome.js: The theme, the campaigns page, the desk, the account sheet, the top bar and the banner.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// The theme
// ==========================================================================
//
// Three states, not two. "auto" is the absence of a stored choice, so a person
// who never touches this follows their machine forever rather than being
// frozen at whatever it happened to be the first time they opened the page.
// The <script> in <head> reads the same key before first paint.

const themeMode = () => {
  try {
    const t = localStorage.getItem('quill-theme');
    return t === 'dark' || t === 'light' ? t : 'auto';
  } catch (e) { return 'auto'; }
};

function setTheme(mode) {
  try {
    if (mode === 'auto') localStorage.removeItem('quill-theme');
    else localStorage.setItem('quill-theme', mode);
  } catch (e) {}
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  paint();
}

const themeSwitch = () => {
  const now = themeMode();
  return `<div class="seg theme" role="group" aria-label="Theme">${
    [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([id, name]) =>
      `<button type="button" class="${now === id ? 'on' : ''}" data-theme-set="${id}"
         aria-pressed="${now === id}">${name}</button>`).join('')
  }</div>`;
};

// ==========================================================================
// The campaigns page, and going in
// ==========================================================================

// What is true about a table right now, and worth acting on. Only ever one
// thing: a campaign being recorded is not also waiting on you, and a campaign
// with nothing to say gets no line rather than a line saying nothing.
//
// Deliberately not `claimed`. It reads like a live state and is not one — it
// means the campaign has a DM who runs it, which is a fact about the campaign
// rather than something happening tonight. The signal an operator actually
// wants from it is the opposite one, a campaign with nobody running it, and
// that is a different line than this.
const campaignState = (c) =>
  c.recording ? { key: 'live', dot: 'live', say: 'recording now' }
  : c.awaiting ? { key: 'wait', dot: 'brass', say: `${plural(c.awaiting, 'night')} waiting on you` }
  : null;

// "played 2 days ago". Days rather than hours, because the unit a campaign is
// measured in is the night it was played, and "played 14h ago" is a sentence
// about a server rather than about a game.
function lastPlayed(iso) {
  if (!iso) return 'no nights recorded';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'played today';
  if (days === 1) return 'played yesterday';
  if (days < 14) return `played ${days} days ago`;
  if (days < 60) return `played ${Math.round(days / 7)} weeks ago`;
  return `played ${Math.round(days / 30)} months ago`;
}

// The tally: one stroke per night. Written up, waiting on you, and still with
// the transcriber, in that order — so the strokes read left to right as the
// life of a session, and the pen-coloured ones are always the ones to look at.
//
// Capped, because past about forty strokes the row stops being a shape you can
// take in at a glance and the number is the better answer.
const TALLY_CAP = 40;
function tally(c) {
  const total = c.sessions ?? 0;
  if (!total) return '';
  const shown = Math.min(total, TALLY_CAP);
  const wait = Math.min(c.awaiting ?? 0, shown);
  const done = Math.max(0, Math.min(c.completed ?? 0, shown - wait));

  const marks = Array.from({ length: shown }, (_, i) =>
    i < done ? 'done' : i < done + wait ? 'wait' : '');

  const groups = [];
  for (let i = 0; i < marks.length; i += 5) {
    groups.push(`<span class="grp">${
      marks.slice(i, i + 5).map((k) => `<i class="${k}"></i>`).join('')}</span>`);
  }
  return `<span class="tally" aria-hidden="true">${groups.join('')}${
    total > shown ? `<span class="rest">+${total - shown}</span>` : ''}</span>`;
}

// Small numbers as words. A display face setting "6 campaigns" reads like a
// receipt; past twelve the word is longer than the thing it counts.
const WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
               'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const count = (x) => (x < WORDS.length ? WORDS[x] : String(x));

// How many tables somebody sits at, remarked upon. Indexed by that number, so
// the page gets quietly more concerned about you as the list grows.
//
// Dry rather than loud, and none of them repeats the number the sentence has
// already said. This is the first line on the first screen, read every time
// anybody opens the dashboard — a joke at that frequency has to be quiet
// enough to live with, so these are asides in the scribe's voice rather than
// punchlines, and they are set in the dim colour to read as muttering.
const REMARKS = [
  '',                                            // 0 — the first-run screen answers instead
  'A good place to start.',
  'Twice the names to keep straight.',
  'The calendar is doing the hard part.',
  'Somebody at your table is very patient.',
  'Quill has stopped asking when you sleep.',
  'This is less a hobby than a rota.',
  'One for every night of the week.',
  'Somewhere, a session zero is weeping.',
  'The ink budget has become a real concern.',
  'Quill would like a word.',
  'Nobody needs this many worlds.',
  'One for every month, apparently.',
];
const remark = (howMany) => REMARKS[howMany] ?? 'Quill has stopped counting and started worrying.';

// The send-off, on a night with nothing running — which is most of them.
//
// This line is the first thing anybody sees, and it is standing in the doorway
// of an evening of D&D. Two earlier attempts got that wrong in the same way.
// "Everything is written up." was a status. So was every line that replaced
// it, because each one opened by saying what Quill was doing — "Nothing is
// running", "Quill is idle", "Between nights" — and spent the good half of the
// sentence on the machine rather than on the game.
//
// Nobody signs in to find out how the bot is feeling. The state is already
// drawn: a live table gets a band, a queue gets a band, and their absence is
// the answer on its own. So the head is not a status at all now. It is a quip
// to send somebody off with, and it is the only place in this product allowed
// to be purely for fun.
//
// Table talk, not fantasy diction: split parties, hoards, plot hooks nobody
// pulls, a plan that lasts one round. Mock-heroic and dry rather than loud —
// the joke carries the energy, so none of them needs an exclamation mark.
//
// Two constraints hold, and both are load-bearing rather than stylistic:
//
//   - None may claim the writing is finished. scope.js zeroes `awaiting` for
//     anybody who may not see the queue, so "all written up" would be Quill
//     vouching to a player for something it had never shown them. Because
//     these say nothing about Quill at all, the operator and a player can be
//     given the same line — and a test holds the two equal, so if they ever
//     diverge a claim has crept back in.
//   - None may need an apostrophe. These are single-quoted literals in a file
//     patched by exact string match, and a stray escape is a silent corruption
//     rather than a syntax error.
const ONWARD = [
  'Fortune favours the party that splits up.',
  'Somewhere a goblin is having a normal day.',
  'The map has edges. Go past them.',
  'The hoard will not loot itself.',
  'Every legend started with a bad idea.',
  'May your plans survive the first round.',
  'Roll badly. It makes a better story.',
  'Go forth and ignore the plot hook.',
  'Trust the dice. They have never let anyone down.',
  'Go and make something worth writing down.',
];

// Which of them today gets. Fixed to the date and not to chance: the desk
// re-renders on every five-second poll, so a line picked at random would
// change while somebody was still reading it. A day book has one line per
// day, and ten of them is enough that the one you get feels like today's
// rather than like a rotation you have learned.
//
// Counted in local days rather than UTC ones, so it turns over at the reader's
// midnight rather than in the middle of somebody's session.
const onward = () => {
  const d = new Date();
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return ONWARD[day % ONWARD.length];
};

// ==========================================================================
// The desk — the front door, and the answer before the question
// ==========================================================================
//
// Signing in used to land on the ledger of campaigns, which answers "which
// table" and nothing else. Then it landed on a sheet of squares headed
// "Where would you like to start?", which asked the question instead of
// answering it and headed four of its squares with a count rather than a
// name — "Three servers", "Four tables" — so there was nothing on the page
// to scan.
//
// This screen answers first. The head reports the one thing that is true
// right now, in Quill's own voice. Under it, tonight: a live recording and
// nights waiting to be written up, full width, drawn only when they exist —
// there is no "nothing is recording" band, because a page of absences is a
// worse answer than a shorter page. Under THAT, the index: every standing
// place there is to go, named, with its figure ruled across to the right.
//
// The rule the whole screen is built on: prose gets words ("Two nights are
// waiting"), the figure column gets digits ("2 nights"). A count never takes
// the display face, and a place is never nameless.

// A day book is headed with its date, and this is the only place on the page
// where today is the subject.
const today = () => {
  try {
    return new Date().toLocaleDateString(undefined,
      { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    return '';
  }
};

// The mark that means "this goes somewhere". One glyph on every band and
// every door, so the affordance is a single sign rather than four.
const ARW = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M4.5 12h14m-6-5.5L18.5 12 12.5 17.5" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// One entry in the index. Name at the left margin, leader ruled across to the
// figure, arrow past it, and what is behind the door on the line below.
//
// `fig` is allowed to be empty: the gatehouse is a page about people rather
// than a page of things to count, and a leader that runs all the way to the
// arrow says that more honestly than an invented number would.
const door = (attrs, { name, say, fig = '' }) => `
  <button type="button" class="door" ${attrs}>
    <span class="door-name">${esc(name)}</span>
    <span class="door-lead" aria-hidden="true"></span>
    <span class="door-fig">${esc(fig)}</span>
    <span class="door-arw">${ARW}</span>
    <span class="door-say">${esc(say)}</span>
  </button>`;

// One band. `mark` carries markup — the live dot is part of the label, not a
// decoration beside it — so it is the one field here that is not escaped.
const band = (attrs, { tone, mark, name, say, fig, figAttrs = '', go }) => `
  <button type="button" class="band ${tone}" ${attrs}>
    <span class="band-main">
      <span class="band-mark">${mark}</span>
      <span class="band-name">${esc(name)}</span>
      <span class="band-say">${esc(say)}</span>
    </span>
    <span class="band-end">
      <span class="band-fig" ${figAttrs}>${esc(fig)}</span>
      <span class="band-go">${esc(go)}${ARW}</span>
    </span>
  </button>`;

function deskScreen() {
  const camps = status?.campaigns ?? [];
  const rec = camps.find((c) => c.recording) ?? null;
  // One flag, one session. The flag used to mean "this Discord is recording",
  // so it lit every campaign in the server and the count had to be of distinct
  // guilds to avoid reporting two sessions off one /join. It now means "THIS
  // table is recording" — and counting guilds would under-report the other
  // way, since a Discord with a second bot can genuinely hold two at once.
  const sessions = camps.filter((c) => c.recording).length;
  // The live session behind the recording campaign, which is where the clock
  // and the clip count come from. Matched on the meeting rather than the
  // guild, which picks an arbitrary one of two tables in the same Discord.
  const onAir = rec ? (status?.recording ?? []).find((r) => r.meetingId === rec.meetingId) : null;

  const waiting = camps.reduce((sum, c) => sum + (c.awaiting || 0), 0);
  const needy = camps.filter((c) => c.awaiting).sort((a, b) => b.awaiting - a.awaiting)[0];
  const held = Boolean(waiting && needy && can());

  const nights = camps.reduce((sum, c) => sum + (c.sessions || 0), 0);
  const hours = camps.reduce((sum, c) => sum + (c.hours || 0), 0);

  // What Quill has to report — at most one thing, and the most urgent one.
  // A table on the air beats a queue; a queue beats a quiet night; and a
  // desk with nothing recorded on it yet is not owed a joke.
  const verdict = sessions
    ? (sessions === 1 ? 'Quill is at the table.' : `Quill is at ${count(sessions).toLowerCase()} tables.`)
    : held
      ? `${count(waiting)} night${waiting === 1 ? ' is' : 's are'} waiting to be written up.`
      : nights ? onward()
      : 'Nothing on file yet.';

  // What the book has come to. Never about tonight, always true.
  //
  // Not the number of tables: the Campaigns door carries that figure three
  // inches below, and the same count said twice on one screen only makes the
  // reader check whether they are two different numbers. This line is the
  // VOLUME of what Quill has kept, which nothing else on the desk says.
  const onFile = nights
    ? [plural(nights, 'night'), hours >= 1 ? `${Math.round(hours)} hours recorded` : '']
        .filter(Boolean).join('  ·  ')
    : '';

  const bands = [];

  if (rec) {
    bands.push(band(`data-campaign="${rec.id}"`, {
      tone: 'live',
      mark: '<span class="dot live"></span>Recording',
      name: rec.name || rec.channel || 'A table',
      say: [
        (onAir?.channel || rec.channel) ? `#${onAir?.channel || rec.channel}` : '',
        rec.guildName || '',
        onAir?.speakers ? plural(onAir.speakers, 'speaker') : '',
      ].filter(Boolean).join('  ·  '),
      fig: hhmmss(onAir?.recordingForMs),
      // Read by the second-hand timer at the foot of this file, the same one
      // that keeps the session pane's clock counting between polls.
      figAttrs: `id="desk-timer" data-meeting="${esc(rec.meetingId ?? '')}"`,
      go: 'Watch it arrive',
    }));
  }

  if (held) {
    const here = needy.awaiting || 0;
    bands.push(band(`data-campaign="${needy.id}"`, {
      tone: 'wait',
      mark: 'Waiting on you',
      name: needy.name || needy.channel || 'One table',
      say: waiting > here
        ? `${here} here, ${waiting - here} at other tables — recorded, not written up`
        : 'recorded, not written up',
      fig: plural(waiting, 'night'),
      go: waiting === 1 ? 'Write it up' : 'Write them up',
    }));
  }

  // The index. Every standing place there is to go, in the order somebody
  // arrives at them: their own tables, then the rooms only the operator has.
  const doors = [];

  doors.push(door('data-screen="campaigns"', {
    name: 'Campaigns',
    say: 'every table, night by night',
    fig: plural(camps.length, 'table'),
  }));

  if (cap('servers')) {
    doors.push(door('data-screen="servers"', {
      name: 'Servers',
      say: 'where Quill is, and what it may hear there',
      fig: plural(status?.servers?.length ?? 0, 'server'),
    }));
  }

  // Everybody's own usage, against what their account allows. A placeholder
  // until per-account limits are built; see usageScreen.
  doors.push(door('data-screen="usage"', {
    name: 'Your usage',
    say: 'what your account has used this month',
    fig: 'preview',
  }));

  // A page of its own rather than a screen of this one, so its entry is a
  // link and goes there the way any link does.
  if (cap('everything')) {
    doors.push(`
      <a class="door" href="/gatehouse/">
        <span class="door-name">The gatehouse</span>
        <span class="door-lead" aria-hidden="true"></span>
        <span class="door-fig"></span>
        <span class="door-arw">${ARW}</span>
        <span class="door-say">who may sign in, deleted campaigns, and what the models cost</span>
      </a>`);
  }

  // The three tables you were at most recently, so the common case — "put me
  // back where I was" — is one click and not two. Ordered by when they last
  // played rather than by whatever the database returned: on the operator's
  // dashboard the first row is somebody else's campaign about half the time.
  //
  // The table that is recording is already the first thing on the page, so it
  // is not offered again three inches below itself.
  const recent = camps
    .filter((c) => c.lastSessionAt && c.id !== rec?.id)
    .sort((a, b) => String(b.lastSessionAt).localeCompare(String(a.lastSessionAt)))
    .slice(0, 3);

  return `
    <div class="desk">
      <div class="desk-head">
        <div class="desk-day">${esc(today())}</div>
        <h1 class="desk-say">${esc(verdict)}</h1>
        ${onFile ? `<div class="desk-sum">${esc(onFile)}</div>` : ''}
      </div>

      ${bands.join('')}

      <div class="index-rank">${doors.join('')}</div>

      ${recent.length ? `
        <div class="desk-back">
          <span class="desk-back-cap">Last at</span>
          ${recent.map((c) => `
            <button type="button" class="backlink" data-campaign="${c.id}">
              <span class="nm">${esc(c.name || c.channel || 'unnamed')}</span>
              <span class="when">${esc(lastPlayed(c.lastSessionAt).replace(/^played /, ''))}</span>
            </button>`).join('')}
        </div>` : ''}
    </div>`;
}

function campaignsScreen() {
  const camps = status?.campaigns ?? [];
  const rec = camps.find((c) => c.recording);
  const waiting = camps.reduce((sum, c) => sum + (c.awaiting || 0), 0);
  const many = `${count(camps.length)} campaign${camps.length === 1 ? '' : 's'}`;

  // What is happening right now, kept out of the headline and given its own
  // line. It is the one thing on this page somebody might need to act on, and
  // a sentence that has to end in a joke is a poor place to keep it.
  const now = rec
    ? `<span class="dot live"></span>Recording at ${esc(rec.name || rec.channel)} right now.`
    : waiting
      ? `<span class="dot brass"></span>${plural(waiting, 'night')} waiting on you.`
      : '';

  return `
    <div class="index">
      <div class="index-head">
        <div class="cap">Campaigns</div>
        <h1>${many}. <span class="aside">${remark(camps.length)}</span></h1>
        ${now ? `<div class="index-now">${now}</div>` : ''}
      </div>

      <div class="chrons">
        ${camps.map(chronicle).join('')}
      </div>

      ${indexMore()}
    </div>`;
}

function chronicle(c) {
  const st = campaignState(c);
  const name = c.name || c.channel || 'unnamed';
  const where = [c.guildName, c.channel ? `#${c.channel}` : ''].filter(Boolean).join(' · ');

  const facts = [
    c.sessions ? `<span><b>${n(c.sessions)}</b> night${c.sessions === 1 ? '' : 's'}</span>` : '',
    c.hours ? `<span><b>${c.hours.toFixed(1)}</b> hours</span>` : '',
    c.lines ? `<span><b>${n(c.lines)}</b> lines</span>` : '',
    `<span><b>${n(c.members)}</b> player${c.members === 1 ? '' : 's'}</span>`,
  ].filter(Boolean).join('');

  return `
    <button type="button" class="chron" data-campaign="${c.id}" data-key="camp-${c.id}">
      <div class="chron-top">
        ${tally(c)}
        ${st ? `<span class="chron-state ${st.key}">
                  ${st.dot ? `<span class="dot ${st.dot}"></span>` : ''}${esc(st.say)}
                </span>` : ''}
        <span class="chron-when">${esc(lastPlayed(c.lastSessionAt))}</span>
      </div>
      <div class="chron-name">${esc(name)}</div>
      <div class="chron-lines">
        ${where ? `<span class="chron-where">${esc(where)}</span>` : ''}
        ${facts}
      </div>
    </button>`;
}

// Starting one, and the ones that are not here any more. Under the ledger
// rather than in it: none of these is a campaign you can open.
function indexMore() {
  const bits = [];

  if (canCreate()) {
    bits.push(`<button type="button" class="camp newcamp" data-new-campaign>
      <div class="l1"><span class="nm">+ New campaign</span></div>
      <div class="meta">in a Discord you own</div>
    </button>`);
  }

  // Deleted campaigns and requests to restore one are in the gatehouse's
  // Archive now, which only the operator opens. Somebody else who wants one
  // back asks with /campaign restore in Discord.

  return bits.length ? `<div class="index-more">${bits.join('')}</div>` : '';
}

// ==========================================================================
// The account, hung off the last mark in the top bar
// ==========================================================================

function renderSheet() {
  const el = $('sheet');
  if (view.sheet !== 'account' || document.body.classList.contains('gate-open')) {
    morph(el, '');
    return;
  }
  morph(el, `<div class="sheet-scrim" data-close-sheet></div>
    <div class="sheet" role="dialog" aria-label="Account">${accountSheet()}</div>`);
}

// Who the bot thinks you are, and the way out. Shown even when sign-in is not
// required, because "you are seeing this as the operator" is worth knowing
// before you press something that spends money.
function accountSheet() {
  const b = status?.bot;
  return `
    <div class="cap">Account</div>
    <div style="padding:0 14px">
      ${me?.signedIn ? `
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
          <span style="color:var(--text)">${esc(me.username)}</span>
          <span class="pill" style="margin-left:auto;padding:1px 7px">${esc(me.level)}</span>
        </div>
        <div class="quiet" style="margin-bottom:13px">sees ${esc(me.sees ?? '')}</div>
        ${myInkRow()}
        <button class="btn sm" data-logout style="width:100%">Sign out</button>`
      : me?.signInAvailable ? `
        <div style="margin-bottom:10px;color:var(--text-2)">the operator</div>
        <button class="btn sm" data-signin style="width:100%">Sign in as yourself</button>
        <div class="quiet" style="font-size:11.5px;margin-top:8px">
          try your account before requiring it
        </div>`
      : `<div class="quiet">signed in as the operator</div>`}
    </div>
    ${me?.can?.everything ? `
      <a class="sheet-link" href="/gatehouse/">
        <span>Gatehouse</span>
        <span class="quiet">who can sign in</span>
      </a>` : ''}
    <div class="sheet-foot">
      ${b ? `${esc(b.user || 'offline')}<br>${uptime(b.uptimeMs)}` : 'connecting…'}
    </div>`;
}

// Line-drawn at the quill's weight, so the end of the top bar is the same hand
// as the mark at its start.
const glyph = {
  pen: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" stroke="currentColor" stroke-width="1.7"/></svg>`,
  servers: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="6" rx="1.6" stroke="currentColor" stroke-width="1.3"/>
    <rect x="3.5" y="13.5" width="17" height="6" rx="1.6" stroke="currentColor" stroke-width="1.3"/>
    <path d="M7 7.5h.01M7 16.5h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
  models: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3.5 13.9 9l5.6.6-4.2 3.8 1.2 5.5-4.5-2.9-4.5 2.9 1.2-5.5L4.5 9.6 10.1 9z"
          stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
};

function navMarks() {
  const servers = status?.servers?.length ?? 0;
  return `
    ${cap('servers') ? `
      <button type="button" class="navmark${view.screen === 'servers' ? ' on' : ''}"
              data-screen="servers" aria-label="Servers">
        ${glyph.servers}${servers ? `<span class="n">${servers}</span>` : ''}
      </button>` : ''}
    <button type="button" class="navmark${view.screen === 'usage' ? ' on' : ''}"
            data-screen="usage" aria-label="Your usage">${glyph.models}</button>
    <button type="button" class="navmark${view.sheet === 'account' ? ' on' : ''}"
            data-sheet="account" aria-expanded="${view.sheet === 'account'}"
            aria-label="${me?.signedIn ? `Signed in as ${esc(me.username)}` : 'Account'}">
      <span class="who">${esc((me?.username || '?').slice(0, 1))}</span>
    </button>`;
}

// The quill is the way home from everywhere. On the campaigns page it is just
// the mark; anywhere else it is the first step of the crumb, so "back to the
// campaigns" is a word as well as an icon.
const homeMark = `
  <button type="button" class="mark" data-screen="desk" aria-label="The desk">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20.5 2.6c-7 .9-11.8 5-14 11.4l-1.7 4.9 4.8-1.7C16 15 20 10.2 20.5 2.6Z" stroke="#C9A227" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M6.2 18.3c2.9-4.1 6.8-7.1 11.6-9" stroke="#C9A227" stroke-width="1" opacity=".5"/>
      <path d="M5.1 19.6 2.6 22.2" stroke="#C9A227" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
  </button>`;

// ==========================================================================
// The top bar
// ==========================================================================

function renderTop() {
  const h = status?.health ?? {};

  if (view.screen === 'transcript') {
    morph($('top'), `
      ${homeMark}
      <span class="crumb">${esc(script?.campaign || '')}</span>
      <span class="crumb-sep">/</span>
      <span class="crumb">${esc(script ? sessionName(script) : 'Session')}</span>
      <span class="crumb-sep">/</span>
      <h2>Transcript</h2>
      <div class="right">
        ${script ? `
          <button class="btn" data-copy-transcript>Copy all</button>
          <button class="btn" data-download="${script.meetingId}">Download .txt</button>
          ${script.total && can()
            ? `<button type="button" class="btn go" data-act="summary/again" data-meeting="${script.meetingId}"
                 data-confirm="Write the notes for ${esc(sessionName(script))} again?">Summarise this</button>`
            : ''}` : ''}
        ${themeSwitch()}
        <button class="btn ghost" data-screen="campaign">Close</button>
      </div>`);
    return;
  }

  // On the desk the mark stands alone and the title is the product.
  // Everywhere else the mark is the first step of a crumb, so the way back to
  // the desk is a word as well as an icon.
  const home = view.screen === 'desk';
  const title =
    home ? 'Quill'
    : view.screen === 'campaigns' ? 'Campaigns'
    : view.screen === 'servers' ? 'Servers'
    : view.screen === 'usage' ? 'Your usage'
    : campaign()?.name || campaign()?.channel || (status?.campaigns?.length ? 'Quill' : 'Setup');

  // Below dev the health line names nothing. Which transcriber, which model
  // and whose GPU are facts about the owner's machine and their bill; whether
  // the bot can currently turn speech into notes at all is not, and it is the
  // answer to "why hasn't last night appeared".
  const health = !status
    ? ''
    : cap('models')
      ? [
          `<span class="${h.whisperServer === false ? 'down' : ''}">${dotFor(h.whisperServer)}whisper server</span>`,
          `<span class="${h.summariser === false ? 'down' : ''}">${dotFor(h.summariser)}${esc(h.summariserName || 'summariser')}</span>`,
          h.transcribePaused ? '<span class="held"><span class="dot warn"></span>transcribing paused</span>' : '',
          h.summarisePaused ? '<span class="held"><span class="dot warn"></span>summarising paused</span>' : '',
        ].filter(Boolean).join('')
      : `<span class="${h.working === false ? 'down' : ''}">${dotFor(h.working)}${
          h.working === false ? 'writing up is delayed' : h.paused ? 'writing up is paused' : 'writing up is working'
        }</span>`;

  // Each button says the state it moves TO, so it is the same click whatever
  // the page last managed to render — a toggle sent twice by a double-click,
  // or by two tabs open on this page, lands on the opposite of what the person
  // who clicked it saw.
  const buttons = can() && cap('machinery') && status
    ? `<button type="button" class="btn" data-act="pause" data-queue="transcribe" data-paused="${!h.transcribePaused}"
         ${h.transcribePaused ? '' : 'data-confirm="Pause transcription? Nothing new will start."'}>
         ${h.transcribePaused ? 'Resume transcribing' : 'Pause transcribing'}</button>
       <button type="button" class="btn" data-act="pause" data-queue="summarize" data-paused="${!h.summarisePaused}"
         ${h.summarisePaused ? '' : 'data-confirm="Pause summarising? Nothing new will start."'}>
         ${h.summarisePaused ? 'Resume summarising' : 'Pause summarising'}</button>`
    : '';

  morph($('top'), `
    ${homeMark}
    ${home ? '' : `<button type="button" class="crumb crumb-back" data-screen="desk">Desk</button>
                        <span class="crumb-sep">/</span>`}
    <h2>${esc(title)}</h2>
    ${view.screen === 'campaign' && canRename() ? `<button type="button" class="rename-pen" data-rename
       aria-label="Rename ${esc(title)}" title="Rename this campaign">${glyph.pen}</button>` : ''}
    <div class="health">${health}</div>
    <div class="right">${buttons}${themeSwitch()}${navMarks()}</div>`);
}

// ==========================================================================
// The banner — the transcriber being unreachable, said once, at the top
// ==========================================================================

function renderBanner() {
  const h = status?.health ?? {};
  // The degraded banner is a machine problem with a machine fix, and every
  // control on it belongs to whoever owns the machine.
  if (!status || !cap('machinery') || h.whisperServer !== false || view.screen === 'transcript') {
    morph($('banner'), '');
    return;
  }

  const held = (status.queue?.queuedTranscribe?.length ?? 0) + (status.working?.transcribing?.length ?? 0);

  morph($('banner'), `
    <div class="banner">
      <span class="dot bad" style="width:10px;height:10px;flex:0 0 10px"></span>
      <div class="text" style="flex:1">
        <div class="say">Quill cannot reach the transcriber on your PC.</div>
        <div class="why">
          Nothing is lost — recording, consent DMs and slash commands all still work.
          ${held ? `${plural(held, 'session')} ${held === 1 ? 'is' : 'are'} held until the machine comes back.` : ''}
          ${h.checkedAt ? `Last checked ${esc(since(new Date(h.checkedAt).getTime()))}.` : ''}
        </div>
      </div>
      <div class="row-btns">
        ${can() ? '<button type="button" class="btn danger" data-act="health/probe">Try again now</button>' : ''}
        <button class="btn ghost" data-diagnose>${view.diagnosing ? 'Hide the detail' : 'What is held'}</button>
      </div>
    </div>
    ${view.diagnosing ? diagnosis() : ''}`);
}

function diagnosis() {
  const q = status?.queue ?? {};
  const rows = [
    ...(status?.working?.transcribing ?? []).map((t) => ({ what: `Session #${t.meetingId}`, sub: t.description, tag: 'stopped' })),
    ...(q.queuedTranscribe ?? []).map((j) => ({ what: `Session #${j.meetingId}`, sub: `${plural(j.utterances, 'clip')} on disk`, tag: 'held' })),
    ...(q.awaitingTranscribe ?? []).map((j) => ({ what: `Session #${j.meetingId}`, sub: 'waiting on you, not the PC', tag: 'ready' })),
    ...(q.awaitingSummary ?? []).map((j) => ({ what: `Session #${j.meetingId}`, sub: 'already transcribed · waiting on you', tag: 'ready' })),
  ];

  return `
    <div class="banner-more">
      <div style="flex:1;min-width:280px">
        <div class="cap">The queue right now</div>
        ${rows.length ? `<div class="steps" style="margin-top:16px">${rows.map((r) => `
          <div>
            <div style="flex:1">
              <div class="what">${esc(r.what)}</div>
              <div class="sub">${esc(r.sub ?? '')}</div>
            </div>
            <span class="mono" style="font-size:11px;color:${r.tag === 'ready' ? 'var(--sage-lit)' : 'var(--brass-lit)'}">${r.tag}</span>
          </div>`).join('')}</div>` : '<div class="quiet" style="margin-top:12px">Nothing is queued.</div>'}
        <div class="quiet" style="margin-top:20px;max-width:70ch">
          Nothing expires while the transcriber is away. Audio is only deleted once a transcript exists,
          so every held session still has its clips.
        </div>
      </div>
      <div class="aside">
        <div class="card">
          <div class="cap">The transcriber</div>
          <div class="mono" style="font-size:12.5px;color:var(--text-2);margin-top:12px;line-height:1.9">
            ${esc(status?.health?.whisperServerHost || 'no WHISPER_SERVER_URL set')}<br>
            <span style="color:var(--red-lit)">no reply</span><br>
            checked ${esc(status?.health?.checkedAt ? since(new Date(status.health.checkedAt).getTime()) : 'never')}
          </div>
          <div class="quiet" style="margin-top:12px">
            Nearly always the PC being asleep. Wake it, then press “Try again now”.
          </div>
        </div>
        <div class="card">
          <div class="cap">Still working</div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px;font-size:13.5px;color:var(--text-2)">
            <div><span class="dot ok"></span> Recording voice channels</div>
            <div><span class="dot ok"></span> Consent DMs</div>
            <div><span class="dot ok"></span> Slash commands</div>
            <div><span class="dot ${status?.health?.summariser === false ? 'bad' : 'ok'}"></span> Summarising, once a transcript exists</div>
          </div>
        </div>
      </div>
    </div>`;
}

