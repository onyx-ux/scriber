// dashboard/html/dash/app/05-threshold.js: The first-time welcome.
//
// One of ten classic scripts that together are the dashboard, loaded in
// order by index.html and sharing one global scope. Split out of a single
// inline script on 2026-09-27 without changing a line; see ADR-0002.

// ==========================================================================
// The threshold — the screen somebody sees once, on their first sign-in
// ==========================================================================
//
// WORK IN PROGRESS. What is here is the whole shape and the whole animation;
// what is not is listed in ROADMAP.md under "Work in progress", and the
// sheet says so on screen rather than pretending otherwise.
//
// TODO: finish the threshold — the endings need their copy settled with a real
// first-time reader, the "Add Quill to a Discord" door has nowhere to go until
// the install URL exists (same blank as QUILL_INVITE on the landing page), and
// firstVisit is derived from a log that is pruned at 300 events, so somebody who
// signed in a year and three hundred events ago would be greeted as new. See
// countSignIns() in store/db.js.
//
// TODO: the invite link is only offered here, on a screen somebody sees once.
// A table that gains a player in month four has nowhere to go and ask for one,
// and nothing anywhere shows the manager that a live link exists or lets them
// pull it — invite/revoke is written and tested and has no button. Both belong
// on the campaign's own table tab.
//
// Why a screen at all, when the dashboard already has firstRun(): firstRun is
// about the INSTALL — no campaigns exist yet, said to whoever is looking. This
// is about the PERSON, and the two are not the same event. A player invited to
// a table that has been running for a year arrives to a dashboard full of
// somebody else's work with no idea which part of it is theirs, and the
// operator's own firstRun has long since stopped being drawn.

const welcome = {
  open: false,
  // q1 | q2 | name | where | roster | join | agree | seat | close
  //
  // Two roads out of the first question, because two entirely different people
  // press it.
  //
  // MAKING (q2 → name → where → roster). Somebody starting a game. They are not
  // sent off to find a button — the book asks what the story is called, which
  // Discord it is told in, and who else is at the table, and it has made the
  // thing by the time they reach the end. Every step is a real action the
  // dashboard already has (campaign/create, roster/search, roster/invite,
  // invite/link), asked for in the same voice.
  //
  // JOINING (join → agree → seat). Somebody who was handed a link. They have no
  // table to make, no server to pick and nothing to name but themselves, so
  // walking them through the maker's questions would be four screens of "not
  // me" before the one thing they came to do. The link names the table; all
  // that is left is whether Quill may write them down, and what to call them
  // when it does.
  step: 'q1',
  role: null,      // 'dm' | 'player' — are they starting a story or joining one
  here: null,      // 'yes' | 'no' — is Quill already in their Discord
  writing: false,
  burning: false,  // the answered question is on fire; no second answer lands
  forced: false,   // #welcome, so this can be looked at without a new account
  dismissed: false,

  // The table being made.
  name: '',
  guildId: null,
  campaignId: null,  // it exists once this is set, and nothing here can unmake it
  busy: false,       // a create, a search or an ask is in flight
  query: '',
  found: null,       // roster/search results; null is "not searched", [] is "nobody"
  note: '',          // one mono line under the field — a refusal, or no matches
  asked: [],         // the ids already asked, so a torch stays lit through a redraw
  link: null,        // this table's own invite URL, once the maker has asked for one
  linkUntil: '',     // and the day it stops working, said rather than left to be found out

  // The table being joined.
  token: '',       // the invitation, off the URL or typed in
  invite: null,    // what invite/peek said it was: { campaignId, campaignName, … }
  character: '',
  recorded: null,  // true once they have agreed, false once they have declined
};

// Written under the account id rather than a bare flag: two people sharing a
// machine are two first times, and the second one is not the first one's.
const WELCOMED = 'quill-welcomed';

let welcomeKey = null;
let thrTimer = null;
let thrQueue = [];

const thrTables = () => status?.campaigns ?? [];

function maybeWelcome() {
  if (welcome.open || welcome.dismissed) return;
  // Held until /status has landed, because what this screen asks depends on
  // whether it can already see a table for them — see the note in the CSS.
  if (!me?.signedIn || !status) return;

  // An invitation opens this screen for anybody, and that is the one case that
  // overrules both gates below. Being handed a link is not a first visit — the
  // player it is most likely to reach is somebody who signed in months ago for
  // a different table — and the localStorage flag says only that this browser
  // has been through the screen once, which is not a reason to refuse the
  // second table they are asked to join.
  const invited = Boolean(thrPendingToken());
  if (!invited) {
    if (!me.firstVisit && !welcome.forced) return;
    try { if (localStorage.getItem(WELCOMED) === String(me.userId)) return; } catch (e) { /* fine */ }
  }

  welcome.open = true;
  if (invited) {
    welcome.role = 'player';
    welcome.token = thrPendingToken();
    welcome.step = 'join';
    welcomePeek();
  } else {
    welcome.step = 'q1';
  }
  document.body.classList.remove('gate-open');
}

// The invitation this browser is carrying, if any.
//
// Stashed in sessionStorage the moment it is read off the URL, and read back
// from there rather than from the address bar, because of what happens in
// between: somebody opening an invite link without a session is bounced through
// Discord and lands back on a bare /app/ — the query string is gone, and with
// it the whole reason they clicked. The tab remembers instead. Cleared when
// the screen is done with it, so a later refresh is not a third invitation.
const JOINING = 'quill-joining';
function thrPendingToken() {
  if (welcome.token) return welcome.token;
  try { return sessionStorage.getItem(JOINING) || ''; } catch (e) { return ''; }
}
function thrForgetToken() {
  try { sessionStorage.removeItem(JOINING); } catch (e) { /* fine */ }
}

function closeWelcome() {
  welcome.open = false;
  welcome.dismissed = true;
  welcome.writing = false;
  welcome.burning = false;
  welcomeKey = null;
  clearTimeout(thrTimer);
  // Remembered in the browser rather than on the Pi: the server knows this was
  // a first sign-in, but not that the screen was got through, and a refresh
  // halfway down it should not start the book again.
  try { localStorage.setItem(WELCOMED, String(me?.userId ?? '1')); } catch (e) { /* fine */ }
  // The invitation has been dealt with, one way or the other. Left in place it
  // would reopen this screen on the next poll and ask them to join a table they
  // just joined.
  thrForgetToken();
  document.body.classList.remove('thr-open');
  paint();
}

// Move on, burning the page from whatever was pressed.
//
// Nothing about the move depends on the fire, so anywhere it cannot run —
// reduced motion, or the render harness, which has no layout to measure a fire
// against — the next thing simply arrives.
function welcomeGo(fromEl, settle) {
  if (welcome.burning) return;
  if (welcome.writing) welcomeFinish();

  const onward = () => { settle(); renderScreen(); };

  const block = document.querySelector('.thr-block');
  const still = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  if (!block || !fromEl || still) { onward(); return; }

  welcomeBurn(block, fromEl, onward);
}

// Whether the two questions lead into making a table rather than to an ending.
// A DM whose Discord already has Quill in it, and whom the bot could actually
// make a campaign for — the same test the dashboard's own New campaign button
// is drawn from.
const thrMakes = () => welcome.role === 'dm' && welcome.here !== 'no' && canCreate();

function welcomeAnswer(value, fromEl) {
  const took = fromEl || document.querySelector(`.thr-choice[data-thr-answer="${value}"]`);
  welcomeGo(took, () => {
    if (welcome.step === 'q1') {
      welcome.role = value;
      // Joining is its own road from here — see the step comment on `welcome`.
      // Asked for a link even when the bot can already see a table for them,
      // because they pressed "join a story" while sitting at one, which means
      // the one they mean is not the one it can see.
      if (value === 'player') { welcome.step = 'join'; return; }
      // A table it can already see is an answer it does not need to ask for.
      welcome.step = thrTables().length ? 'close' : 'q2';
    } else if (welcome.step === 'q2') {
      welcome.here = value;
      welcome.step = thrMakes() ? 'name' : 'close';
    }
  });
}

// --- making the table ------------------------------------------------------

function welcomeNamed(form) {
  if (welcome.busy || welcome.burning) return;

  welcome.name = ($('thr-name')?.value ?? welcome.name).trim();
  welcome.note = '';
  if (welcome.name.length < 2) {
    welcome.note = 'Give it a name first — two letters or more.';
    welcomeRedraw();
    return;
  }

  const servers = status?.canCreateIn ?? [];
  const go = form.querySelector('button[type=submit]');

  // Which Discord is only a question when there is more than one answer.
  if (servers.length > 1 && !welcome.guildId) {
    welcomeGo(go, () => { welcome.step = 'where'; });
    return;
  }
  welcome.guildId = welcome.guildId || servers[0]?.id || null;
  welcomeCreate(go);
}

// The table gets made while the page burns.
//
// Both take about a second, and running them one after the other would put a
// wait on the end of something that has none. The row is being written on the
// Pi for as long as the fire is crossing the screen, and the next question is
// drawn when the slower of the two is done.
async function welcomeCreate(fromEl) {
  if (!welcome.guildId) {
    welcome.note = 'Quill cannot see a server it could make this in.';
    welcomeRedraw();
    return;
  }

  welcome.busy = true;
  welcomeRedraw();

  const pending = send('campaign/create', { name: welcome.name, guildId: welcome.guildId });

  await new Promise((done) => {
    const block = document.querySelector('.thr-block');
    const still = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    if (!block || !fromEl || still) { done(); return; }
    welcomeBurn(block, fromEl, done);
  });

  const payload = await pending;
  welcome.busy = false;

  if (payload?.campaignId) {
    welcome.campaignId = payload.campaignId;
    welcome.query = '';
    welcome.found = null;
    welcome.note = '';
    welcome.step = 'roster';
  } else {
    // It did not take — a name already used, a limit reached, a bot that could
    // not be reached. Back to the field with what the Pi said, rather than on
    // to a roster for a campaign that does not exist.
    welcome.note = payload?.message || 'That did not go through. Try it again.';
    welcome.step = 'name';
  }

  // Forced, because the step may not have changed and renderScreen draws only
  // when it does.
  welcomeKey = null;
  renderScreen();
}

// --- asking the rest of the table ------------------------------------------

async function welcomeFind() {
  if (welcome.busy) return;

  welcome.query = ($('thr-find')?.value ?? welcome.query).trim();
  welcome.note = '';
  if (welcome.query.length < 2) {
    welcome.note = 'Two letters of their Discord name is enough to look.';
    welcomeRedraw();
    return;
  }

  welcome.busy = true;
  welcome.found = null;
  welcomeRedraw();

  const payload = await thrPost('roster/search', {
    campaignId: welcome.campaignId,
    query: welcome.query,
  });
  if (payload.ok === false) {
    welcome.found = null;
    welcome.note = payload.message || 'That did not go through. Try it again.';
  } else {
    welcome.found = payload.people ?? [];
    welcome.note = welcome.found.length
      ? ''
      : `Nobody in that server matches “${welcome.query}”. Discord matches on username and server nickname.`;
  }

  welcome.busy = false;
  welcomeRedraw();
}

// Light somebody's torch. Marked asked before the round trip so the press has
// an effect immediately, and put back if the bot refuses it.
async function welcomeAsk(userId) {
  if (welcome.asked.includes(userId)) return;
  welcome.asked.push(userId);
  welcome.note = '';
  welcomeRedraw();

  const payload = await send('roster/invite', { campaignId: welcome.campaignId, userId });
  if (payload && payload.ok === false) {
    welcome.asked = welcome.asked.filter((id) => id !== userId);
    welcome.note = payload.message || 'That one did not go through.';
    welcomeRedraw();
  }
}

// The threshold's own way of asking the bot for something.
//
// Not send(), and that is not duplication for its own sake: send() ends in a
// toast and a repaint of the dashboard, and the dashboard is not on screen. A
// notification reading "HTTP 200" sliding in over the fire is the tell that a
// screen was built out of the wrong parts. What comes back is put into a
// written line, or into the one mono note under the field, instead.
async function thrPost(action, body) {
  try {
    const res = await fetch(`${API}/actions/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    // A refusal that forgot to say so is still a refusal.
    if (!res.ok && payload.ok !== false) return { ok: false, message: `HTTP ${res.status}` };
    return payload;
  } catch (err) {
    return { ok: false, message: `Couldn't reach the bot — ${err.message}` };
  }
}

// --- joining by invitation -------------------------------------------------
//
// Three beats, and the order of them is the whole design. The link says which
// table. The table asks whether it may write you down. Only then does it ask
// what to call you — because a name is the thing you give a table you have
// agreed to sit at, and asking for it first would make the agreeing look like
// the formality after the real question.

// What is at the other end of the token. Read before anything is written, so
// the screen can name the table it is about to ask them to join — a screen that
// cannot say which game it means is asking somebody to sign a blank page.
async function welcomePeek() {
  welcome.busy = true;
  welcome.note = '';
  welcomeRedraw();

  const payload = await thrPost('invite/peek', { token: welcome.token });
  welcome.busy = false;

  if (!payload || payload.ok === false) {
    // The token is dead, or was never one. Back to the field with what the Pi
    // said — never onto a screen that names a table, because there is none.
    welcome.invite = null;
    welcome.token = '';
    thrForgetToken();
    welcome.note = payload?.message || 'That did not go through. Try it again.';
    welcome.step = 'join';
    welcomeKey = null;
    renderScreen();
    return;
  }

  welcome.invite = payload;
  welcome.character = payload.characterName || '';
  // Somebody who already agreed — invited by DM, or here for the second time —
  // is not asked again. The question has an answer on file and re-putting it
  // would invite them to change it by accident.
  welcome.recorded = payload.alreadyIn ? true : null;
  welcome.step = payload.alreadyIn ? 'seat' : 'agree';
  welcomeKey = null;
  renderScreen();
}

// The invitation, pasted. Takes the whole URL or the bare token: somebody
// handed a link copies a link, and asking them to find the part after the "="
// is the interface making its own storage format somebody else's problem.
function welcomeJoined() {
  if (welcome.busy || welcome.burning) return;

  const typed = ($('thr-token')?.value ?? '').trim();
  welcome.note = '';
  if (!typed) {
    welcome.note = 'Paste the link you were sent, or the code at the end of it.';
    welcomeRedraw();
    return;
  }

  welcome.token = thrToken(typed);
  welcomePeek();
}

// The token out of whatever was pasted. A URL with ?join= in it, a bare token,
// or something with a stray space or a trailing bracket from a chat client.
function thrToken(raw) {
  const text = String(raw).trim();
  const match = /[?&#]join=([A-Za-z0-9_-]+)/.exec(text);
  if (match) return match[1];
  return text.replace(/[^A-Za-z0-9_-]/g, '');
}

// The question itself. Yes goes on to the name; no is an answer, recorded as
// one, and ends the screen — there is nothing left to ask somebody who is not
// being written down.
function welcomeAgree(value, fromEl) {
  if (welcome.burning) return;
  welcome.recorded = value === 'yes';

  // A decline is written down HERE, before the page burns and before the name
  // is asked for, and then written again with the name when it arrives. Two
  // sends for one answer, on purpose: everything after this point is optional —
  // they can close the tab at the name — and an answer that only leaves the
  // browser at the end of the road is an answer that gets lost, which for this
  // particular question means somebody who said no is on file as never having
  // been asked. The second send says the same no with a name attached.
  if (!welcome.recorded) welcomeSeal();

  // Both answers are asked what to call them. Somebody who will not be recorded
  // is still at the table, and the person running it still has to know who they
  // are — what changes is that nothing of theirs is captured, not that they
  // stop being a player.
  welcomeGo(fromEl, () => { welcome.step = 'seat'; });
}

async function welcomeSeat(form) {
  if (welcome.busy || welcome.burning) return;

  welcome.character = ($('thr-seat')?.value ?? welcome.character).trim();
  welcome.note = '';
  if (welcome.character.length < 2) {
    welcome.note = 'Two letters or more — it is what Quill will call you in the write-up.';
    welcomeRedraw();
    return;
  }

  welcome.busy = true;
  welcomeRedraw();

  const go = form?.querySelector('button[type=submit]');
  const pending = welcomeSeal();

  await new Promise((done) => {
    const block = document.querySelector('.thr-block');
    const still = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    if (!block || !go || still) { done(); return; }
    welcomeBurn(block, go, done);
  });

  const payload = await pending;
  welcome.busy = false;

  if (payload && payload.ok === false) {
    welcome.note = payload.message || 'That did not go through. Try it again.';
    welcome.step = 'seat';
    welcomeKey = null;
    renderScreen();
    return;
  }

  welcome.campaignId = payload?.campaignId ?? welcome.invite?.campaignId ?? null;
  // They are on a roster they were not on a second ago. Asked for now rather
  // than waited for: the next poll is up to five seconds away, and the dashboard
  // they are about to land on would open without their table on it.
  status = await getStatus().catch(() => status);

  // A yes is finished, and goes out through the fire that is already crossing
  // the page.
  //
  // No ending screen for it, and that is the difference between joining and
  // making. Somebody who has just MADE a table is at the start of something and
  // has decisions in front of them, so the book writes their name in and offers
  // them the door. Somebody who has just joined one has finished: they agreed,
  // they said what to call themselves, and there is nothing a further screen
  // could tell them that the dashboard behind it does not show better.
  if (welcome.recorded) { closeWelcome(); return; }

  // A no is not finished in the same way. It is the one answer on this road
  // with a consequence the person cannot see anywhere else, so it gets said
  // back to them rather than dropped them on a desk that looks the same either
  // way. See thrEndLines.
  welcome.step = 'close';
  welcomeKey = null;
  renderScreen();
}

// The one write this half of the screen makes. Both answers go through it —
// agreeing with a name, and declining with none — so there is exactly one place
// that turns what was pressed here into a consent row.
function welcomeSeal() {
  return thrPost('invite/accept', {
    token: welcome.token,
    consent: welcome.recorded === true,
    // Sent whichever way they answered — see the note on the name in the
    // action. Empty on the first of the two sends a decline makes, because at
    // that point the name has not been asked for yet.
    name: welcome.character,
  });
}

// --- handing the link out --------------------------------------------------

// The maker's side of the same system. Asked for rather than drawn unprompted:
// a live URL sitting on screen before anybody wanted one is a thing to close a
// laptop on, and the press is what says "I am going to paste this somewhere".
async function welcomeLink() {
  if (welcome.busy || !welcome.campaignId) return;
  welcome.busy = true;
  welcome.note = '';
  welcomeRedraw();

  const payload = await thrPost('invite/link', { campaignId: welcome.campaignId });
  welcome.busy = false;

  if (!payload || payload.ok === false) {
    welcome.note = payload?.message || 'That did not go through. Try it again.';
  } else if (!payload.url) {
    // A install with no DASHBOARD_URL cannot produce an address, and half of
    // one is worse than none — somebody would paste it.
    welcome.note = 'This bot has no web address set, so it cannot make a link to hand out.';
  } else {
    welcome.link = payload.url;
    // The end date is what makes it a link somebody can hand out without
    // thinking about it again — said here, once, rather than discovered by a
    // player three weeks later finding a door that no longer opens.
    welcome.linkUntil = payload.expiresAt
      ? new Date(payload.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
      : '';
  }
  welcomeRedraw();
}

// Set the page alight from the torch that was picked.
//
// The fire starts at that flame and spreads outwards at a fixed speed, so what
// crosses the screen is a front rather than a wipe: a glyph two inches from the
// torch catches later than one beside it, whichever line it is on. Every
// character is already its own span from the writing, so this is one measured
// distance and one animation-delay each — no timer per glyph and no second
// pass.
function welcomeBurn(block, took, done) {
  welcome.burning = true;
  took.classList.add('chosen');
  block.querySelectorAll('.thr-choice').forEach((b) => { b.disabled = true; });

  // Anything not yet broken into glyphs — the answers themselves — is broken
  // up now, so the fire crosses them a letter at a time like everything else.
  // Only the spans that hold text: a person's line holds their name and their
  // handle in two of their own, and splitting the wrapper would flatten the two
  // into one run and reflow the line as it burns.
  //
  // Called through a lambda, not handed straight to forEach: forEach passes the
  // index as the second argument, which would land on thrSplit's `shownAlready`
  // and split the first answer unlit and the second one lit.
  block.querySelectorAll('.thr-choice span:not(.wisp)').forEach((el) => {
    if (!el.firstElementChild) thrSplit(el);
  });

  // The fire starts at the torch, which is standing at the line that was taken.
  const flame = ($('thr-wisp') || took).getBoundingClientRect();
  const fromX = flame.left + flame.width / 2;
  const fromY = flame.top + flame.height / 2;

  let last = 0;
  block.querySelectorAll('.ch').forEach((glyph) => {
    const g = glyph.getBoundingClientRect();
    const away = Math.hypot(g.left + g.width / 2 - fromX, g.top + g.height / 2 - fromY);
    // Half a second of the line simply being the one that was taken — lit, with
    // the flame swelling beside it — before anything catches. The press has to
    // read as a choice being made before it reads as a page being destroyed.
    // Then about a foot of page a second.
    const wait = 520 + away * 1.55;
    glyph.style.animationDelay = `${Math.round(wait)}ms`;
    glyph.classList.add('burn');
    if (wait > last) last = wait;
  });

  block.style.setProperty('--ash', `${Math.round(last + 380)}ms`);
  block.classList.add('burning');

  clearTimeout(thrTimer);
  thrTimer = setTimeout(() => {
    welcome.burning = false;
    done();
  }, last + 780);
}

// One line of text becomes one span per character, plus a copy of the whole
// sentence for a screen reader — which is what should be read, rather than
// eighty separate letters. Used by the pen on the way in and by the fire on
// the way out.
function thrSplit(el, shownAlready = true) {
  if (el.querySelector('.ch')) return [];
  const text = el.textContent;
  el.textContent = '';
  const shown = document.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  const made = [];

  // Words are kept whole, and this is not a nicety. A line broken into one span
  // per character gives the browser a place to end a line between any two of
  // them, so the moment a line is narrow enough to wrap it wraps mid-word —
  // "opened" came back as "op" and "ened" on two lines. Each word gets a
  // wrapper that refuses to break; the spaces between words are glyphs of their
  // own, outside the wrappers, and they are the only places a line can end.
  let word = null;
  for (const c of text) {
    const glyph = document.createElement('span');
    // Already on the page for anything the fire is about to take; still unlit
    // for a line the pen has yet to write.
    glyph.className = shownAlready ? 'ch lit' : 'ch';
    glyph.textContent = c;
    made.push(glyph);

    if (c === ' ') { shown.appendChild(glyph); word = null; continue; }
    if (!word) {
      word = document.createElement('span');
      word.className = 'wd';
      shown.appendChild(word);
    }
    word.appendChild(glyph);
  }
  const read = document.createElement('span');
  read.className = 'sr';
  read.textContent = text;
  el.append(shown, read);
  return made;
}

// What the pen writes at this step. Two lines at most, and nowhere to put an
// explaining one — see the note on .thr-line in the stylesheet. Anything worth
// saying is a line the pen writes, at the size everything else is written at.
function thrLines() {
  switch (welcome.step) {
    case 'q1': return [
      'Welcome, adventurer. Time to take your first steps.',
      'Do you…',
    ];
    case 'q2': return [
      'Let me be the Lorekeeper’s assistant, then.',
      'Has Quill joined you in your Discord?',
    ];
    case 'name': return [
      'Then we begin a new one.',
      'What is the story called?',
    ];
    case 'where': return [
      `${welcome.name}, then.`,
      'Which Discord is it told in?',
    ];
    case 'roster': return [
      `${welcome.name} has its first page.`,
      'Who else is at the table?',
    ];

    // Joining. The first of these is the only step in the whole screen that has
    // to admit it needs something the reader may not have on them.
    case 'join': return [
      'Then a story is already being told without you.',
      'Show me the invitation you were sent.',
    ];
    case 'agree': return [
      `${thrJoining()} is expecting you.`,
      'Quill writes down every voice at that table. Yours as well?',
    ];
    case 'seat': return welcome.recorded ? [
      'Then take your seat.',
      'What do they call you at the table?',
    ] : [
      'Then your seat is still yours.',
      'What do they call you at the table?',
    ];
    default: return thrEndLines();
  }
}

// Where the screen puts them down. Five endings, and which one is drawn is
// settled by what the bot can see plus the one or two things it cannot.
function thrEndLines() {
  const tables = thrTables();

  // Declined, and the one ending the joining road still has.
  //
  // Its opposite has none — agreeing burns straight through to the dashboard,
  // because somebody who has just joined a table has finished. A no has not
  // finished in the same way: it is the one answer here with a consequence the
  // person cannot see anywhere else, and a screen that swallowed it would leave
  // them unsure whether it landed. Stated as the fact it is, with no second ask
  // and nothing to press that changes it.
  if (welcome.recorded === false) return [
    'Then you are at the table, and not in the book.',
    'Play on — nothing of yours is kept.',
  ];

  if (welcome.campaignId) return [
    'The story is begun.',
    'Every night you play at it is written up in here.',
  ];
  if (tables.length) return [
    tables.length === 1 ? 'Your table is already in here.' : 'Your tables are already in here.',
    'Every night it has written up is behind this page.',
  ];
  if (welcome.here === 'no') return [
    'Then it has to be in that server before it can keep anything.',
    'Add it, and this page fills itself in.',
  ];
  // A DM this bot could not actually make a campaign for — no server it can see
  // them running. The command is the way in, and since there is no small print
  // left to say where to type it, the written line does.
  if (welcome.role === 'dm') return [
    'Then begin it in Discord, and Quill will keep the rest.',
    'Type this in the Discord you play in.',
  ];
  // A joiner with no invitation. The one ending that names the thing they have
  // to go and get, because unlike every other dead end on this screen there is
  // nothing here they can press to fix it themselves.
  return [
    'Then nothing is filed under your name yet.',
    'Ask whoever keeps the story to send you a link.',
  ];
}

// The table on the other end of the invitation, for the lines that name it.
const thrJoining = () => welcome.invite?.campaignName || 'the table';

// Everything under the writing: the answers, the fields, the doors. Kept apart
// from the lines above because it redraws on its own — a search result arriving
// must not send the pen back over a question that has already been asked. See
// welcomeRedraw.
function thrAfter() {
  switch (welcome.step) {
    case 'q1': return thrChoices([
      { v: 'dm', t: 'Create the Story.' },
      { v: 'player', t: 'Join the Story.' },
    ]);
    case 'q2': return thrChoices([{ v: 'yes', t: 'It has.' }, { v: 'no', t: 'Not yet.' }]);
    case 'name': return thrNameField();
    case 'where': return thrChoices(
      (status?.canCreateIn ?? []).map((g) => ({ v: g.id, t: g.name })), 'data-thr-where'
    );
    case 'roster': return thrRoster();
    case 'join': return thrTokenField();
    case 'agree': return thrTerms();
    case 'seat': return thrSeatField();
    default: return thrEnd();
  }
}

// One torch for the whole list, not one per line — see the note on .wisp.
const thrTorch = '<span class="wisp" id="thr-wisp" aria-hidden="true"></span>';

function thrChoices(list, attr = 'data-thr-answer') {
  return `<div class="thr-choices">${list.map((c) => `
    <button type="button" class="thr-choice" ${attr}="${esc(c.v)}">
      <span>${esc(c.t)}</span>
    </button>`).join('')}${thrTorch}</div>`;
}

// The one place this screen takes something back. Set in the same face at the
// same size as the writing, on a rule rather than in a box: what you type
// continues the sentence the book has just written.
function thrNameField() {
  return `
    <form class="thr-form" data-thr-name>
      <input class="thr-in" id="thr-name" name="name" autocomplete="off" maxlength="60"
             placeholder="the name of the story" value="${esc(welcome.name)}"
             aria-label="What the table is called">
      ${welcome.note ? `<p class="thr-note">${esc(welcome.note)}</p>` : ''}
      <div class="thr-choices">
        <button type="submit" class="thr-choice" ${welcome.busy ? 'disabled' : ''}>
          <span>${welcome.busy ? 'Making it…' : 'Write it in.'}</span>
        </button>
        ${thrTorch}
      </div>
    </form>`;
}

// The invitation, pasted.
//
// A field and a way out, and the way out is a real answer rather than a dodge:
// somebody who pressed "join" without a link has come to the wrong door, and
// the ending it leads to says who to ask. Anything else would leave them typing
// guesses into a box.
function thrTokenField() {
  return `
    <form class="thr-form" data-thr-join>
      <input class="thr-in" id="thr-token" autocomplete="off" maxlength="200"
             placeholder="the link you were sent" value="${esc(welcome.token)}"
             aria-label="The invitation link you were sent">
      ${welcome.note ? `<p class="thr-note">${esc(welcome.note)}</p>` : ''}
      <div class="thr-choices">
        <button type="submit" class="thr-choice" ${welcome.busy ? 'disabled' : ''}>
          <span>${welcome.busy ? 'Looking…' : 'Here it is.'}</span>
        </button>
        <button type="button" class="thr-choice" data-thr-nolink>
          <span>I was not sent one.</span>
        </button>
        ${thrTorch}
      </div>
    </form>`;
}

// The question, and the facts it cannot be fairly asked without.
//
// Every one of these is generated from what this install actually does rather
// than written as a promise — the retention line comes from the same config the
// deleting is driven by. A sentence here that is merely aspirational is a lie
// told at the exact moment somebody is deciding whether to trust the thing.
function thrTerms() {
  const days = welcome.invite?.retentionDays ?? 0;
  const kept = days > 0
    ? `Your recording is deleted after <b>${days} day${days === 1 ? '' : 's'}</b> — long enough to transcribe it and fix mistakes.`
    : 'Your recording is kept until the person running the bot deletes it.';

  return `
    ${thrChoices([
      { v: 'yes', t: 'Write me down.' },
      { v: 'no', t: 'Leave me out of it.' },
    ], 'data-thr-agree')}
    <ul class="thr-terms">
      <li>Quill records you <b>only while it is in the voice channel</b>. It never speaks.</li>
      <li>Your audio becomes text on the machine running this bot. <b>That text — not your voice</b> — is what goes to an AI service to be written up.</li>
      <li>${kept}</li>
      <li>You can change your mind any time with <b>/campaign consent</b>, without asking anyone. That stops future recording; sessions already written up stay as they are.</li>
    </ul>`;
}

// What to call them. The same field as naming a table, asking a smaller and
// more personal thing — so it is the one input on this screen with somebody
// else's word in the placeholder rather than the bot's.
function thrSeatField() {
  return `
    <form class="thr-form" data-thr-seat>
      <input class="thr-in" id="thr-seat" autocomplete="off" maxlength="60"
             placeholder="your character’s name" value="${esc(welcome.character)}"
             aria-label="What your character is called">
      ${welcome.note ? `<p class="thr-note">${esc(welcome.note)}</p>` : ''}
      <div class="thr-choices">
        <button type="submit" class="thr-choice" ${welcome.busy ? 'disabled' : ''}>
          <span>${welcome.busy ? 'Sitting down…' : 'That is me.'}</span>
        </button>
        ${thrTorch}
      </div>
    </form>`;
}

// Asking the rest of the table, two ways.
//
// BY NAME. The dashboard's own roster/search, scoped to the server the campaign
// was just made in, and each name found is a line the torch can stand beside:
// lighting one asks that person. It is not an add — Quill DMs them and they
// decide. Nothing of theirs is recorded until they say yes, which is why the
// line reads "ask" and the state it lands in reads "asked".
//
// BY LINK. One address for the whole table, which is the only thing that works
// for the half of every group who are not in that server yet, or who go by
// something nobody can spell. It is the same consent asked in the same words —
// see thrTerms — and each person answers it themselves.
function thrRoster() {
  const found = welcome.found;
  return `
    <form class="thr-form" data-thr-find>
      <input class="thr-in" id="thr-find" autocomplete="off" maxlength="60"
             placeholder="a Discord username" value="${esc(welcome.query)}"
             aria-label="Search that Discord for somebody">
      <div class="thr-doors">
        <button type="submit" class="thr-door" ${welcome.busy ? 'disabled' : ''}>
          ${welcome.busy ? 'Looking…' : 'Look them up'}</button>
        ${welcome.link ? '' : `<button type="button" class="thr-door quiet" data-thr-link
          ${welcome.busy ? 'disabled' : ''}>Or hand out a link</button>`}
      </div>
    </form>
    ${welcome.link ? `
      <p class="thr-note">Anyone with this can join ${esc(welcome.name || 'the table')}${
        welcome.linkUntil ? ` until ${esc(welcome.linkUntil)}` : ''
      }. They agree to be recorded themselves.</p>
      <code class="thr-link" data-key="thr-link">${esc(welcome.link)}</code>` : ''}
    ${welcome.note ? `<p class="thr-note">${esc(welcome.note)}</p>` : ''}
    <div class="thr-choices">
      ${found?.length ? found.map(thrPerson).join('') : ''}
      <button type="button" class="thr-choice" data-thr-done>
        <span>${welcome.asked.length || welcome.link ? 'That is the table.' : 'Nobody else for now.'}</span>
      </button>
      ${thrTorch}
    </div>`;
}

function thrPerson(p) {
  const asked = welcome.asked.includes(p.userId);
  return `
    <button type="button" class="thr-choice person${asked ? ' asked' : ''}"
            data-key="thr-who-${esc(p.userId)}" ${asked ? 'disabled' : ''}
            data-thr-ask="${esc(p.userId)}">
      <span class="thr-who">${esc(p.displayName || p.username)}</span>
      <span class="thr-at">@${esc(p.username)}${asked ? ' &middot; asked' : ''}</span>
    </button>`;
}

function thrEnd() {
  const tables = thrTables();
  const doors = [];

  if (welcome.campaignId) {
    // Whichever table this screen turned out to be about: the one just made, or
    // — for somebody who joined and said no to being recorded, the one road that
    // still ends here — the one just joined.
    const mine = welcome.name || welcome.invite?.campaignName || 'the table';
    doors.push(`<button type="button" class="thr-door" data-thr-door="open"
      data-thr-campaign="${welcome.campaignId}">Open ${esc(mine)}</button>`);
  } else if (tables.length) {
    tables.slice(0, 3).forEach((c) => {
      doors.push(`<button type="button" class="thr-door" data-thr-door="open" data-thr-campaign="${c.id}">
        Open ${esc(c.name || c.channel || 'the table')}</button>`);
    });
  } else if (welcome.here === 'no') {
    doors.push('<a class="thr-door" href="/">Add Quill to a Discord</a>');
  } else if (welcome.role === 'dm') {
    doors.push('<span class="thr-cmd">/campaign create</span>');
  }

  doors.push('<button type="button" class="thr-door quiet" data-thr-door="dashboard">Go to the dashboard</button>');

  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  // The ledger stamp, and not for everybody.
  //
  // It is the book writing your name in, which is the right last image for
  // every ending but one: somebody who has just said they do not want to be
  // recorded, and has been told in the line above that they are not in the
  // book. Stamping them into it on the next line would be the screen
  // contradicting itself in the space of two sentences.
  const stamp = welcome.recorded === false ? '' : `
    <div class="thr-entry">
      <p class="thr-entry-name" data-w>${esc(me?.username || 'you')}</p>
      <p class="thr-entry-cap">first entry &middot; ${esc(today)}</p>
    </div>`;

  return `${stamp}<div class="thr-doors">${doors.join('')}</div>`;
}

function welcomeScreen() {
  // One exchange on the page at a time. It used to keep every answer above the
  // one being asked, which made a written record of the arrival — a good idea
  // for a book and the wrong one here, because the fire has to have something
  // to take. What is answered is burnt, and what is left is a dark page.
  const said = thrLines()
    .map((text) => `<p class="thr-line" data-w>${esc(text)}</p>`)
    .join('');

  return `
    <div class="thr" data-key="thr-${esc(welcome.step)}">
      <div class="thr-sheet">
        <p class="thr-cap">the first page
          <span class="thr-wip" title="This screen is still being written.">WIP</span>
        </p>
        <div class="thr-block now">
          ${said}
          <div class="thr-after" id="thr-after">${thrAfter()}</div>
        </div>
        <span class="thr-nib" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M20.5 2.6c-7 .9-11.8 5-14 11.4l-1.7 4.9 4.8-1.7C16 15 20 10.2 20.5 2.6Z"
                  stroke="#8FA0F5" stroke-width="1.7" stroke-linejoin="round"/>
            <!-- The point of contact. Without it the quill floats above the
                 line it is supposed to be laying down. -->
            <circle cx="4.9" cy="19.1" r="1.5" fill="#8FA0F5"/>
          </svg>
        </span>
      </div>
      <p class="thr-skip"><button type="button" data-thr-skip>Skip this and go to the dashboard</button></p>
    </div>`;
}

// --- the torch, which is the cursor ----------------------------------------
//
// One flame for the list, standing beside whichever line you are on. It follows
// a pointer, it follows the keyboard, and it is what a press acts on — so what
// gets chosen is always the line that was lit, and there is never a moment
// where two lines look equally taken.

// Which line the torch is standing at, by index within the list.
let thrPicked = 0;

const thrRows = () =>
  Array.from(document.querySelectorAll('.thr-choices .thr-choice:not([disabled])'));

function thrPick(i, { focus = false } = {}) {
  const rows = thrRows();
  if (!rows.length) return;
  thrPicked = Math.max(0, Math.min(rows.length - 1, i));

  const row = rows[thrPicked];
  // Cleared across every row in the list, not just the ones the torch can stand
  // at, so a person already asked does not keep a light that has moved on.
  document.querySelectorAll('.thr-choices .thr-choice').forEach((r) => r.classList.remove('picked'));
  row.classList.add('picked');

  // The torch and the rows are both children of the positioned list, so one
  // offsetTop is the whole sum. Measured against the list rather than the page,
  // which keeps it right while the block is still arriving.
  const torch = $('thr-wisp');
  if (torch) {
    const y = row.offsetTop + (row.offsetHeight - torch.offsetHeight) / 2;
    torch.style.transform = `translateY(${Math.round(y)}px)`;
    torch.classList.add('lit');
  }

  if (focus) row.focus({ preventScroll: true });
}

// Put the torch where it belongs after anything redraws the list.
function thrPlaceTorch() {
  const rows = thrRows();
  if (!rows.length) { $('thr-wisp')?.classList.remove('lit'); return; }
  thrPick(Math.min(thrPicked, rows.length - 1));
}

// Redraw everything below the writing, and nothing above it.
//
// This is what lets a step hold a field. A search result arriving, a torch
// being lit, a refusal to record — all of them change what is under the
// question and none of them should send the pen back over the question itself.
// morph is what makes it safe while somebody is typing into the field: a
// focused field is not touched at all. See ADR-0002.
function welcomeRedraw() {
  const el = $('thr-after');
  if (!el) return;
  morph(el, thrAfter());
  thrPlaceTorch();
}

// The writing itself. Every character is a span that fades up in wet ink and
// dries a beat later, and the nib rides the last one laid down. One class per
// glyph and one animation — no timer per character, and nothing measured that
// is not on screen.
//
// The text is duplicated into a screen-reader copy rather than being read a
// character at a time, which is what the split would otherwise produce.
function welcomeWrite() {
  clearTimeout(thrTimer);
  thrQueue = [];

  const sheet = document.querySelector('.thr-sheet');
  const block = sheet?.querySelector('.thr-block.now');
  if (!block) return;

  block.classList.add('writing');

  // The sheet grows an exchange at a time, and by the third one the answer to
  // the question just asked can be off the bottom of a laptop screen. Brought
  // into view before the pen starts rather than after it stops, so nobody
  // watches an empty page while the writing happens below the fold.
  const still = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  if (block.getBoundingClientRect().bottom > window.innerHeight) {
    block.scrollIntoView({ block: 'end', behavior: still ? 'auto' : 'smooth' });
  }

  // Where one written line ends and the next begins, so the hand can be given
  // a proper rest there rather than running two sentences together.
  const breaks = new Set();

  block.querySelectorAll('[data-w]').forEach((el) => {
    breaks.add(thrQueue.length);
    thrSplit(el, false).forEach((glyph) => thrQueue.push(glyph));
  });

  if (still) { welcomeFinish(); return; }

  const nib = sheet.querySelector('.thr-nib');
  welcome.writing = true;
  // A fresh page: the hand comes in from off it again rather than carrying on
  // from where the last one ended.
  thrNib.started = false;
  thrNib.lift = 0;
  let i = 0;

  (function step() {
    if (i >= thrQueue.length) { welcomeFinish(); return; }
    const glyph = thrQueue[i];
    i += 1;
    glyph.classList.add('on');

    if (nib) {
      // Where the pen should now be heading. The tip of the drawn quill is at
      // (4.9, 19.1) in its 24px box, and it wants to sit just past the glyph
      // rather than on top of it — a pen covering the word it has this second
      // written is the one thing the effect cannot do.
      const g = glyph.getBoundingClientRect();
      const s = sheet.getBoundingClientRect();
      thrNibTo(g.right - s.left, g.bottom - s.top - 21);
      nib.classList.add('on');
    }

    // A hand slows at the end of a clause, lifts at a full stop, and comes off
    // the page entirely between one line and the next. Anything faster reads as
    // a teletype, which is the wrong instrument entirely — and this screen is
    // read once, by somebody who has just arrived and is not in a hurry.
    const c = glyph.textContent;
    const wait = breaks.has(i) ? 620
      : /[.?!—]/.test(c) ? 400
      : /[,;:]/.test(c) ? 220
      : c === ' ' ? 44
      : 33;
    thrTimer = setTimeout(step, wait);
  })();
}

// --- the hand --------------------------------------------------------------
//
// The pen used to be put where the last character was, once per character, with
// a short CSS transition to smear over the gap. At a letter every 33ms that is
// a thing that teleports and blurs; it is not a thing that writes.
//
// So it is driven per frame instead. The letters set a target as they appear
// and the nib is drawn towards it every frame, which means it is genuinely
// travelling between them, and always a little behind — which is where a real
// nib is, because the ink it just laid down is behind the hand.
//
// Two details do most of the work. It turns with the direction it is moving,
// about its own tip, so it leans into the line. And when the target jumps a
// long way — the end of one line to the start of the next — it lifts: the
// stroke stops, it fades and rides higher, and it sets down again at the far
// end. That lift is what a hand actually does at a line ending, and without it
// the pen appears to drag a line backwards through everything it has written.
const thrNib = { x: 0, y: 0, tx: 0, ty: 0, started: false, frame: 0, lift: 0 };

function thrNibTo(x, y) {
  thrNib.tx = x;
  thrNib.ty = y;
  if (!thrNib.started) {
    // Comes in from off the page rather than appearing at the first letter.
    thrNib.started = true;
    thrNib.x = x - 46;
    thrNib.y = y - 34;
  }
  if (!thrNib.frame) thrNib.frame = requestAnimationFrame(thrNibDraw);
}

function thrNibDraw(now) {
  const nib = document.querySelector('.thr-nib');
  if (!nib || !welcome.writing) { thrNib.frame = 0; return; }

  const dx = thrNib.tx - thrNib.x;
  const dy = thrNib.ty - thrNib.y;
  const away = Math.hypot(dx, dy);

  // A long way to go means a new line: the pen comes off the page for it.
  if (away > 110) thrNib.lift = 1;
  else if (away < 26) thrNib.lift = Math.max(0, thrNib.lift - 0.12);

  // Slower while lifted, so the carry across reads as a movement rather than a
  // snap, and quick while writing so it keeps up with the letters.
  const pull = thrNib.lift > 0.5 ? 0.16 : 0.36;
  thrNib.x += dx * pull;
  thrNib.y += dy * pull;

  // The hand's own small movement, and the lean into the direction of travel.
  const bob = Math.sin(now / 38) * 0.7;
  const tilt = Math.max(-7, Math.min(7, dx * 0.55));
  const rise = thrNib.lift * 7;

  nib.style.transform =
    `translate(${(thrNib.x).toFixed(1)}px, ${(thrNib.y + bob - rise).toFixed(1)}px) rotate(${tilt.toFixed(1)}deg)`;
  nib.style.opacity = String(1 - thrNib.lift * 0.55);

  thrNib.frame = requestAnimationFrame(thrNibDraw);
}

function welcomeFinish() {
  clearTimeout(thrTimer);
  welcome.writing = false;
  thrQueue.forEach((glyph) => glyph.classList.add('on'));
  const sheet = document.querySelector('.thr-sheet');
  sheet?.querySelector('.thr-block.now')?.classList.add('ready');
  const nib = sheet?.querySelector('.thr-nib');
  if (nib) { nib.classList.remove('on'); nib.style.opacity = ''; }
  if (thrNib.frame) { cancelAnimationFrame(thrNib.frame); thrNib.frame = 0; }

  // The torch is lit only once there is a list for it to stand beside, and it
  // starts at the top of it.
  thrPicked = 0;
  thrPlaceTorch();

  // The caret lands where the pen stopped. A step that asks for something typed
  // has asked a question out loud; leaving the reader to go and click the line
  // it left open would be a strange way to wait for an answer.
  sheet?.querySelector('.thr-in')?.focus({ preventScroll: true });
}

function renderScreen() {
  const el = $('screen');

  const arriving = Date.now() < entersUntil ? 'arriving' : '';

  // The threshold comes before everything, including the gate: somebody who
  // has just signed in for the first time gets this screen and no dashboard
  // behind it. Drawn once per step rather than on every poll — the writing is
  // in the DOM and a five-second repaint would start it over.
  if (welcome.open) {
    document.body.classList.remove('gate-open');
    document.body.classList.add('thr-open');
    const key = `thr-${welcome.step}`;
    if (welcomeKey !== key) {
      welcomeKey = key;
      el.className = '';
      morph(el, welcomeScreen());
      // After the markup has actually landed, and through whichever of the two
      // exists — the render harness has no frames to wait for.
      if (window.requestAnimationFrame) window.requestAnimationFrame(welcomeWrite);
      else setTimeout(welcomeWrite, 0);
    }
    return;
  }
  document.body.classList.remove('thr-open');

  // Nobody home. Shown instead of the app rather than over it: a dashboard
  // that renders its chrome and then refuses every request is a worse way to
  // learn you are signed out than being asked to sign in.
  // Sign-in is shown when this install demands it, and also when somebody
  // asks for it. Without the second case there was no way to sign in at all
  // while DASHBOARD_REQUIRE_LOGIN was off — which made the one safe order
  // for turning it on (sign in first, so you cannot lock yourself out)
  // impossible to follow.
  // Toggled here rather than in paint() so the class and the screen can never
  // disagree: whatever this function decides to draw is what the body is
  // dressed for. body.gate-open folds away the top bar and turns the page to
  // paper, because the gate is a full-page takeover in the landing
  // page's world rather than a card floating in the dark tool.
  const gateOpen = Boolean(me && !me.signedIn && (me.loginRequired || view.signingIn));
  document.body.classList.toggle('gate-open', gateOpen);

  if (gateOpen) {
    el.className = '';
    // Turned away is its own screen, not a red line under the sign-in button.
    // Offering Continue with Discord again to somebody Discord has already
    // vouched for is a loop, and the loop is what makes it read as a fault.
    morph(el, view.notInvited ? notInvitedScreen() : signInScreen());
    return;
  }

  // The desk. Answered before everything else because it is where the page
  // starts and where the quill goes back to.
  if (view.screen === 'desk' && status?.campaigns?.length) {
    el.className = arriving;
    morph(el, deskScreen());
    return;
  }

  // The ledger of tables, one step in from the desk.
  if (view.screen === 'campaigns' && status?.campaigns?.length) {
    el.className = arriving;
    morph(el, campaignsScreen());
    return;
  }

  if (view.screen === 'transcript') { el.className = 'split'; morph(el, transcriptScreen()); return; }
  if (view.screen === 'servers')    { el.className = arriving; morph(el, serversScreen()); return; }
  if (view.screen === 'usage')      { el.className = arriving; morph(el, usageScreen()); return; }

  if (status && !status.campaigns?.length) { el.className = ''; morph(el, firstRun()); return; }

  // The campaign column is a column on a wide window, folded away when its
  // reader asks, and a drawer over the page on a narrow one. Whichever way it
  // is not showing, the ribbon over the pane is the way back to it.
  const wide = railWide();
  const folded = wide && railFolded();
  const drawer = !wide && view.drawer;
  document.body.classList?.toggle?.('drawer-lock', drawer);
  el.className = `split ${arriving}${folded ? ' rail-folded' : ''}${drawer ? ' drawer-open' : ''}`.trim();
  morph(el, `
    <div class="sessions" id="campaign-column"${wide ? '' : ` role="dialog" aria-label="This campaign"${drawer ? ' aria-modal="true"' : ' inert'}`}>
      ${columnBar(wide)}
      <div class="shelf-slider ${view.shelfPicking ? 'picking' : 'picked'}">
        <div class="shelf-page chooser" ${view.shelfPicking ? '' : 'aria-hidden="true"'}>
          ${shelfChooser()}
        </div>
        <div class="shelf-page list" ${view.shelfPicking ? 'aria-hidden="true"' : ''}>
          ${shelfHeader()}
          ${columnList()}
          ${view.shelf === 'sessions' && cap('machinery') ? `
            <div class="foot">
              <button class="btn wide" data-import>${detail?.sessions?.length ? 'Import a recording' : 'Import a recording instead'}</button>
            </div>` : ''}
        </div>
      </div>
    </div>
    ${wide ? '' : '<div class="drawer-scrim" data-rail-close aria-hidden="true"></div>'}
    <div class="pane">
      ${ribbon(wide, folded, drawer)}
      <div class="pane-main${view.tab === 'notes' && view.shelf === 'sessions' && marking() ? ' marking' : ''}">
        ${tabsBar()}
        ${paneBody()}
      </div>
      ${view.tab === 'notes' && view.shelf === 'sessions' ? factsRail() : ''}
    </div>`);
}

// --- the first run ---------------------------------------------------------

function firstRun() {
  const h = status?.health ?? {};
  return `
    <div class="center">
      <div class="kicker">Nothing has been recorded yet</div>
      <h1 class="display" style="font-size:44px;margin-top:18px">Quill is on your server and listening for a table.</h1>
      <div class="say-2" style="font-size:16px">Four things to do once, then it runs on its own.</div>
      <div class="steps" style="margin-top:36px">
        <div>
          <span class="mark done">✓</span>
          <div style="flex:1">
            <div class="what">Quill is signed in${status?.servers?.length ? ` on ${plural(status.servers.length, 'server')}` : ''}</div>
            <div class="sub">${esc(status?.bot?.user || 'connecting…')}${status?.bot?.uptimeMs ? ` · ${uptime(status.bot.uptimeMs)}` : ''}</div>
          </div>
        </div>
        <div class="now">
          <span class="mark" style="border-color:var(--brass);color:var(--brass)">2</span>
          <div style="flex:1">
            <div class="what" style="font-weight:500">Make a campaign</div>
            <div class="sub" style="font-family:var(--sans);font-size:13px">One per game. It holds the roster, the corrections and every session.</div>
          </div>
          ${canCreate()
            ? `<button type="button" class="btn sm go" data-new-campaign>New campaign</button>`
            : `<code>/campaign create</code>`}
        </div>
        <div>
          <span class="mark">3</span>
          <div style="flex:1">
            <div class="what" style="color:var(--dim)">Point it at a voice channel</div>
            <div class="sub" style="font-family:var(--sans);font-size:13px">Run it from the channel you are playing in. Quill records until somebody ends the session with <code>/campaign leave</code>.</div>
          </div>
          <code>/campaign join</code>
        </div>
        <div>
          <span class="mark">4</span>
          <div style="flex:1">
            <div class="what" style="color:var(--dim)">Ask the table</div>
            <div class="sub" style="font-family:var(--sans);font-size:13px">Nobody is recorded until they say yes in a DM.</div>
          </div>
          <code>/campaign invite</code>
        </div>
      </div>
      <div class="quiet" style="margin-top:26px">
        The transcriber runs on your own machine —
        ${h.whisperServer === false ? 'Quill cannot reach it right now.' : h.whisperServer ? 'Quill can reach it.' : 'Quill has not checked yet.'}
        Audio never leaves your network.
      </div>
    </div>`;
}

