import { dashboardSource } from './lib/dashboard-source.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import vm from 'node:vm';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';
import { openSession } from '../src/web/auth.js';

// The dashboard, actually rendered.
//
// Everything else in this suite tests what the Pi SENDS. This runs the page's
// own script against a real server in a stubbed DOM and tests what it DRAWS,
// which is where a different class of bug lives: a template that throws
// halfway and leaves a half-built pane, a field read from a payload the viewer
// was never given, a control offered to somebody whose every click on it would
// answer 403.
//
// It is not a browser and does not pretend to be one — there is no layout, no
// CSS and no real events. What it does have is the page's real logic against
// the real API, which is enough to catch every dashboard bug found so far.

const HTML = fileURLToPath(new URL('../../dashboard/html/', import.meta.url));
const PAGE = fileURLToPath(new URL('../../dashboard/html/index.html', import.meta.url));

const DEV = '10000000000000001';
const OWNER = '20000000000000002';
const CREATOR = '30000000000000003';
const PLAYER = '40000000000000004';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// `memberOf` is what decides whether a viewer can be given a campaign at all:
// canCreateIn is "the servers Quill is in that you are also in", and only
// Discord can answer the second half. Off by default, which is the state every
// test here but the creation walk wants.
async function world(t, { activeSessions = new Map(), memberOf = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-render-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const campaignId = db.createCampaign('guild-1', 'Cipher', CREATOR);
  db.setConsent(campaignId, PLAYER, true);
  db.addCorrection(campaignId, 'Kaylen', 'Kaelen');

  for (let i = 0; i < 2; i += 1) {
    const meeting = db.createMeeting({
      guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
      startedAt: `2026-08-0${i + 1}T19:00:00Z`, audioDir: '/tmp',
    });
    db.finalizeTranscription(meeting, [
      { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'Kaelen opens the ledger.' },
      { userId: CREATOR, displayName: 'kez', startMs: 2, endMs: 3, text: 'The clerk looks up.' },
    ]);
    db.endMeeting(meeting, `2026-08-0${i + 1}T22:00:00Z`);
    db.setSummary(meeting, {
      // The recap names an NPC and a place that the campaign also has entries
      // for, which is what makes a wikilink possible at all.
      tldr: 'They talked their way into the lower registry. Wren Halloway signed the writ.',
      scenes: [{ title: 'The queue at the notary', points: ['The writ passed on the second reading.'] }],
      npcsIntroduced: ['Wren Halloway: the notary clerk'],
      locationsVisited: ['The Ashen Vaults'],
      partyDecisions: ['Leave the stone in the wall.'],
      // One thing and one quantity, so the item list has something to keep and
      // something to leave out.
      lootAndRewards: ['A brass key stamped with a wren', '450 gold pieces'],
      unresolvedThreads: [], followUps: [], funnyMoments: [],
    });
    db.setMeetingStatus(meeting, 'done');
  }

  const cfg = {
    statusHost: '127.0.0.1',
    statusPort: await freePort(),
    statusToken: 'sesame',
    ownerUserId: DEV,
    dashboardRequireLogin: true,
    scheduleTimeZone: 'Europe/London',
    transcribeWindowStartHour: 8,
    transcribeWindowEndHour: 16,
    transcribeWeekdaysOnly: true,
    transcribeRequireApproval: true,
    summaryProvider: 'gemini',
    geminiApiKey: 'k',
    geminiModel: 'gemini-3.6-flash',
    // A port with nothing on it, so "the transcriber is unreachable" is a
    // state this test actually reaches.
    whisperServerUrl: `http://127.0.0.1:${await freePort()}/`,
  };

  const { server, close } = startStatusServer({
    db, cfg, activeSessions,
    client: {
      user: { tag: 'Quill#0233' },
      guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'The Cellar', ownerId: OWNER }]]) },
    },
    discord: {
      isMemberOf: async () => memberOf,
      findKnownMember: async () => null,
      sendCode: async () => ({ ok: true }),
      findPeople: async () => ({ ok: true, people: [] }),
      invite: async () => ({ ok: true, message: 'asked' }),
      // What the destination switch's channel picker is drawn from. One
      // uncategorised and two under a heading, so the grouping has something
      // to group.
      listChannels: async () => ({
        ok: true,
        channels: [
          { id: '900000000000000001', name: 'rules', category: null },
          { id: '900000000000000002', name: 'session-notes', category: 'Campaign' },
          { id: '900000000000000003', name: 'lore', category: 'Campaign' },
        ],
      }),
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));

  t.after(async () => {
    // Awaited: the database must outlive the last request still being answered.
    await close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, campaignId, base: `http://127.0.0.1:${server.address().port}` };
}

// A DOMTokenList with just the four methods the page uses, and with them
// actually agreeing with each other.
const classList = () => {
  const on = new Set();
  return {
    add: (...names) => names.forEach((c) => on.add(c)),
    remove: (...names) => names.forEach((c) => on.delete(c)),
    contains: (c) => on.has(c),
    toggle: (c, force) => {
      const want = force ?? !on.has(c);
      if (want) on.add(c); else on.delete(c);
      return want;
    },
  };
};

// Every script the page carries, in the order a browser would run them.
//
// This used to be one greedy match from the first <script> to the last
// </script>, which worked only while the page had exactly one block. The
// moment a second appeared — the theme setter in <head>, which has to run
// before first paint — the "source" spanned both and swallowed the thousand
// lines of markup between them, and every test in this file died on
// `Unexpected token '<'` a long way from the cause.
//
// Non-greedy and per-block, so a third one changes nothing here. The head
// script is harmless in the sandbox: it reads localStorage, which does not
// exist here, inside its own try/catch.
// Every script the page carries, in the order a browser would run them —
// including the ones it fetches. A `src` on this page is always an absolute
// path, because the dashboard and the gatehouse are served from prefixes of
// their own and a relative one would resolve under each of them; here that
// means it resolves against dashboard/html rather than against this file.
async function pageScripts(html, what) {
  const found = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(found.length > 0, `no <script> found in the ${what} page`);

  return Promise.all(found.map(([, attrs, inline]) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    return src ? readFile(join(HTML, src[1].replace(/^\//, '').replace(/[?].*$/, '')), 'utf8') : inline;
  }));
}

// Load the page's script into a sandbox with just enough DOM to run.
async function render({ base, cookie, search = '' }) {
  const html = await readFile(PAGE, 'utf8');
  const scripts = await pageScripts(html, 'dashboard');

  const panels = {};
  // Every handler for a type, not the last one registered.
  //
  // It used to be one function per type, which was true of the page for as long
  // as the page had one submit handler. It grew a second — the threshold's own
  // fields — and the newer registration silently replaced the older, so a form
  // this harness sent went to the wrong listener and did nothing at all. A
  // browser calls both; so does this.
  const listeners = {};
  const on = (type, fn) => { (listeners[type] ??= []).push(fn); };
  const fire = async (type, event) => {
    for (const fn of listeners[type] ?? []) await fn(event);
  };
  const copied = [];
  const el = (id) => (panels[id] ??= {
    id, _html: '', className: '', textContent: '', dataset: {},
    // Every element in a browser has these. Stubbing them away turned "put the
    // torch beside the chosen line" into a TypeError in a screen that works
    // perfectly well in a real one, so they are here rather than guarded for at
    // every call site in the page.
    classList: classList(), style: {}, offsetTop: 0, offsetHeight: 0,
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    focus() {}, querySelector() { return null; }, setSelectionRange() {}, closest: () => null,
    // measureChrome() asks the split how far down the page it starts, to
    // budget the sticky columns' height. Nothing here has a layout, so the
    // honest answer is a zero box — the same answer a display:none element
    // would give, and the page is written to survive it.
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  });

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    fetch: (path, init) => fetch(
      path.replace(/^\/api/, base) + (path.includes('?') ? '&' : '?') + 'token=sesame',
      { ...init, headers: { ...(init?.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) } }
    ),
    URLSearchParams, URL, Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map, Intl,
    FormData: class {},
    // An invitation arrives as /app/?join=<token>, so the address bar is a real
    // input to this page and not decoration.
    location: { search, pathname: '/app/', hash: '' },
    history: { replaceState() {} },
    // A real one, because the invite token is moved into it on arrival and read
    // back out a paint later — a stub that forgot between the two would pass
    // the tests and lose every invitation in production.
    sessionStorage: (() => {
      const kept = new Map();
      return {
        getItem: (k) => (kept.has(k) ? kept.get(k) : null),
        setItem: (k, v) => kept.set(k, String(v)),
        removeItem: (k) => kept.delete(k),
      };
    })(),
    // Real too, and for the same reason: the colour switch is a fact about
    // this browser rather than about the account, and the page guards every
    // read of it with try/catch — so an absent store looks identical to one
    // that has never been written to, and the switch could not be tested at
    // all.
    localStorage: (() => {
      const kept = new Map();
      return {
        getItem: (k) => (kept.has(k) ? kept.get(k) : null),
        setItem: (k, v) => kept.set(k, String(v)),
        removeItem: (k) => kept.delete(k),
      };
    })(),
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    confirm: () => true,
    setTimeout, clearTimeout,
    // The page's own polling would keep firing under the test runner.
    setInterval: () => 0,
    // The page re-measures its chrome on resize. Nothing here ever resizes;
    // this exists so registering the handler is not a TypeError.
    addEventListener: on,
    scrollY: 0,
    document: {
      getElementById: el,
      addEventListener: on,
      // A real class list rather than a bag of no-ops: renderScreen dresses the
      // body for the sign-in gate and renderSheet asks for that class back, so
      // stubs that always answer "no" put the two out of step.
      body: { classList: classList() },
      activeElement: null,
      createElement: () => ({ click() {}, style: {} }),
      // The gate appends a stylesheet link for the landing page's typefaces.
      head: { appendChild() {} },
      // Looked up by settleColumn to run the shelf animation. Nothing here has
      // a layout, so the honest answer is "not present" — and the page is
      // written to return early on exactly that. What these tests read is the
      // markup either side of the animation, not the animation.
      querySelector: () => null,
      // Same answer, plural. The threshold asks for every answer row at once to
      // work out where its torch should stand; with no layout here there are
      // none to find, and the page is written to place no torch rather than to
      // assume one.
      querySelectorAll: () => [],
      // The theme control writes the mode onto <html>, and does it OUTSIDE the
      // try/catch that guards localStorage. measureChrome writes --above onto
      // the same element, so the style map has to agree with itself: it is
      // read before it is written, and a stub that always answered '' would
      // hide a page that rewrote the property on every paint.
      documentElement: {
        setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
        style: (() => {
          const props = new Map();
          return {
            setProperty: (name, value) => props.set(name, value),
            getPropertyValue: (name) => props.get(name) ?? '',
          };
        })(),
      },
      get title() { return this._t; },
      set title(v) { this._t = v; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  scripts.forEach((block, i) => vm.runInContext(block, sandbox, { filename: `dashboard-${i}.js` }));

  // 'sheet' is the account panel hung off the top bar, drawn into its own
  // element rather than into the screen.
  const body = () => ['top', 'rail-list', 'rail-nav', 'rail-foot', 'banner', 'screen', 'modal', 'sheet']
    .map((id) => panels[id]?._html ?? '').join('\n');

  // Polled rather than slept: the page's first paint is several awaited
  // fetches deep, and a fixed delay is either slow or flaky depending on the
  // machine it runs on.
  const settle = async (until, ms = 4000) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (until(body())) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const click = async (matches, dataset = {}, until = () => true) => {
    const node = {
      dataset, disabled: false, type: 'button',
      closest: (sel) => (matches.includes(sel) ? node : null),
      get textContent() { return 'x'; }, set textContent(v) {},
    };
    await fire('click', { target: node });
    await settle(until);
  };

  // The threshold's fields are forms, so Enter sends them — which means the
  // only way to drive one from here is the submit listener, not a click.
  const submit = async (marker, values = {}, until = () => true) => {
    Object.entries(values).forEach(([id, value]) => { el(id).value = value; });
    const form = {
      closest: (sel) => (sel === `form[${marker}]` ? form : null),
      querySelector: () => null,
    };
    await fire('submit', { target: form, preventDefault() {} });
    await settle(until);
  };

  await settle((html_) => html_.length > 500);
  return { body, click, submit, settle, copied };
}

// Every element opened is closed. A template that throws part-way through
// leaves unbalanced markup, which is the shape most render bugs take.
function balanced(markup) {
  const opens = (markup.match(/<(?!\/)([a-z][a-z0-9]*)\b[^>]*?(?<!\/)>/g) ?? [])
    .filter((tag) => !/^<(br|img|input|hr|meta|link|path|svg\b.*\/)/.test(tag));
  const closes = markup.match(/<\/[a-z][a-z0-9]*>/g) ?? [];
  return { opens: opens.length, closes: closes.length, ok: opens.length === closes.length };
}

// A session for somebody who has been here before.
//
// The second half matters as much as the first. /me answers firstVisit from the
// sign-on log, and openSession writes the row that log is made of — so without
// a prior sign-in every viewer in this file is a brand new account, and the
// page draws them the threshold instead of the dashboard. That is the right
// behaviour and it is tested on its own below; everything else here is about
// what a returning viewer is shown.
const cookieFor = (db, cfg, userId, username) => {
  db.recordAuthEvent(userId, username, 'in');
  return `quill_session=${openSession(db, cfg, { userId, username }).token}`;
};

// And a session for somebody the bot has never seen, which is the whole of what
// makes the threshold appear.
const firstCookieFor = (db, cfg, userId, username) =>
  `quill_session=${openSession(db, cfg, { userId, username }).token}`;

// The page opens on the desk, so anything about the inside of a campaign has
// to walk in through its square. Done as a click rather than by reaching into
// `view`, because the square being clickable is half of what is under test.
const enter = (page, campaignId, until) =>
  page.click(['[data-campaign]:not([data-act]):not(form)'], { campaign: String(campaignId) }, until);

// --- it draws at all ---

test('the operator sees the app, with the machinery on it', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /data-import/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok, 'unbalanced markup means a template threw part-way');
  assert.match(markup, /Cipher/);
  // The pause switches are still the operator's, in the gatehouse's Status
  // room now rather than on every screen's top bar.
  assert.doesNotMatch(markup, /data-act="pause"/, 'the pause switches moved to the gatehouse');
  assert.match(markup, /data-import/);
  // The bill moved to the gatehouse; the top bar carries everybody's own usage.
  assert.match(markup, /data-screen="usage"/);
  assert.doesNotMatch(markup, /data-screen="models"/);
});

// The specific failure this catches: a field read off a payload the viewer was
// never given renders the string "undefined" into the page.
test('no screen renders undefined, NaN or [object Object]', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);

  for (const [matches, dataset] of [
    [['[data-screen]'], { screen: 'desk' }],
    [['[data-campaign]:not([data-act]):not(form)'], { campaign: String(campaignId) }],
    [['[data-shelf]'], { shelf: 'npcs' }],
    [['[data-shelf]'], { shelf: 'places' }],
    [['[data-shelf]'], { shelf: 'items' }],
    [['[data-shelf]'], { shelf: 'sessions' }],
    [['[data-tab]'], { tab: 'table' }],
    [['[data-tab]'], { tab: 'corrections' }],
    [['[data-tab]'], { tab: 'settings' }],
    [['[data-tab]'], { tab: 'notes' }],
    [['[data-screen]'], { screen: 'servers' }],
    [['[data-screen]'], { screen: 'campaign' }],
    [['[data-import]'], {}],
    [['[data-close-modal]'], {}],
  ]) {
    await page.click(matches, dataset);
    const markup = page.body();
    const broken = /undefined|\bNaN\b|\[object Object\]/.exec(markup);
    assert.equal(
      broken,
      null,
      broken ? `${JSON.stringify(dataset)}: ${markup.slice(Math.max(0, broken.index - 60), broken.index + 60)}` : ''
    );
    assert.ok(balanced(markup).ok, `${JSON.stringify(dataset)} left unbalanced markup`);
  }
});

// --- it draws the right thing for each level ---

const FORBIDDEN = {
  owner: [/gemini|whisper|anthropic/i, /data-act="pause"/, /data-import/, /summary\/approve/],
  creator: [/gemini|whisper|anthropic/i, /data-act="pause"/, /data-import/, /summary\/approve/,
            /data-screen="servers"/],
  player: [/gemini|whisper|anthropic/i, /data-act="pause"/, /data-import/, /summary\/approve/,
           /data-screen="servers"/, /data-transcript/, /corrections\/add/, /roster\/invite/],
};

for (const [level, userId, username] of [
  ['owner', OWNER, 'owner'],
  ['creator', CREATOR, 'kez'],
  ['player', PLAYER, 'saf'],
]) {
  test(`${level === 'owner' ? 'an' : 'a'} ${level} is offered nothing their level cannot do`, async (t) => {
    const { db, cfg, base, campaignId } = await world(t);
    const page = await render({ base, cookie: cookieFor(db, cfg, userId, username) });
    await enter(page, campaignId);
    // The table tab is where the roster and the invite panel live, so a check
    // that never opens it would pass for the wrong reason.
    await page.click(['[data-tab]'], { tab: 'table' });
    const markup = page.body();

    assert.ok(balanced(markup).ok);
    assert.match(markup, /Cipher/, 'they can still see their own campaign');

    for (const pattern of FORBIDDEN[level]) {
      assert.doesNotMatch(markup, pattern, `${level} was offered ${pattern}`);
    }
  });
}

// The health line left the top bar for the gatehouse's Status room on
// 2026-09-27. Below dev it still names no machinery, because it is not there.
test('the top bar carries no health line and no pause switch, for anybody', async (t) => {
  const { db, cfg, base } = await world(t);

  const dev = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.doesNotMatch(dev.body(), /whisper server|writing up is|data-act="pause"/);
  assert.match(dev.body(), /href="\/gatehouse\/"/, 'the operator still has the way to it');

  const player = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  assert.doesNotMatch(player.body(), /whisper|gemini|writing up is|data-act="pause"/i);
});

// On a phone the column used to draw as nothing at all. It is a drawer there
// and can be folded on a wide window; either way the ribbon over the pane has
// the button that brings it back and names the night being read.
test('the campaign column folds away into a ribbon that names the session', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /class="ribbon-name"/.test(m));

  let markup = page.body();
  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="col-bar"/, 'the column has its own menu button');
  assert.match(markup, /<div class="ribbon-name">Session \d+<\/div>/, 'the night is the ribbon\'s hero');
  assert.match(markup, /class="menu-btn" data-rail aria-controls="campaign-column"\s+aria-expanded="true"/);

  await page.click(['[data-rail]'], {});
  markup = page.body();
  assert.match(markup, /class="menu-btn" data-rail aria-controls="campaign-column"\s+aria-expanded="false"/,
    'folded, the ribbon\'s button says the column is closed');

  await page.click(['[data-rail]'], {});
  assert.match(page.body(), /class="menu-btn" data-rail aria-controls="campaign-column"\s+aria-expanded="true"/);
});

// --- signed out ---

test('a signed-out visitor gets the sign-in card and no campaign names', async (t) => {
  const { base } = await world(t);
  const page = await render({ base, cookie: null });
  const markup = page.body();

  assert.match(markup, /Sign in to Quill/);
  assert.doesNotMatch(markup, /Cipher/, 'the app must not render behind the sign-in card');
  assert.ok(balanced(markup).ok);
});

// A player reads the notes; the transcript is the verbatim record and is not
// theirs. The page must not offer a button whose every click answers 403.
test('a player is shown notes and never a transcript button', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  await enter(page, campaignId);

  // The recap arrives a fetch after the screen first paints, and render() only
  // waits for the page to have drawn SOMETHING. On an idle machine it is there
  // by the time this reads; on a busy one it is not, and the test failed for
  // want of a wait rather than for want of the notes.
  await page.settle((m) => /talked their way into the lower registry/i.test(m));
  const markup = page.body();

  assert.match(markup, /talked their way into the lower registry/i, 'the recap is theirs to read');
  assert.doesNotMatch(markup, /data-transcript/);
});

// The bill moved to the gatehouse (see gatehouse-render.test.js). In its place
// is a PLACEHOLDER for per-account usage, which is not built. It has to say so:
// dummy figures that read as real would be the page lying about somebody's
// account.
test('the usage screen is plainly a preview with example figures', async (t) => {
  const { db, cfg, base } = await world(t);
  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.6-flash', role: 'summary',
                        inputTokens: 900, outputTokens: 300, totalTokens: 1400 });

  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  await page.click(['[data-screen]'], { screen: 'usage' }, (m) => /Your account this month/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /preview/);
  assert.match(markup, /These figures are examples/);
  assert.doesNotMatch(markup, /gemini-3\.6-flash|1,400 tokens/, 'nothing of the real bill reaches a player');
});

// --- the desk --------------------------------------------------------------

// The first screen after signing in. What is under test is not the layout —
// there is none here — but which doors it draws, because a door is a promise
// that a place exists and can be got to.
test('the desk is the first screen, and holds a door per place', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="door/, 'the index is drawn');
  assert.match(markup, /data-screen="campaigns"/, 'the whole ledger is one of them');
  assert.match(markup, /data-screen="servers"/);
  assert.match(markup, /href="\/gatehouse\/"/, 'the operator can get to the guest list');
  assert.match(markup, /Cipher/, 'the table you last played is one click away');
  assert.doesNotMatch(markup, /data-import/, 'the campaign column is not on this screen');
});

// The fault this screen was rebuilt to fix: every door was headed with a
// COUNT — "Three servers", "Four tables" — so the display face was spent on a
// number and the place itself went unnamed. A count belongs in the figure
// column. Nothing in the index may be named one again.
test('a door is headed with its name, never with a count', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  const named = [...markup.matchAll(/class="door-name">([^<]+)</g)].map((m) => m[1].trim());
  assert.ok(named.length >= 2, 'there are doors to check');
  for (const name of named) {
    assert.doesNotMatch(
      name,
      /^(\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|no)\b/i,
      `"${name}" is a count where a place should be named`,
    );
  }
  assert.match(markup, /class="door-fig">[^<]*\d/, 'and the counts are in the figure column');
});

// The head reports, it does not ask. "Where would you like to start?" was the
// page putting the question back to the person who had just opened it.
test('the desk says what is true rather than asking where to go', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.doesNotMatch(markup, /Where would you like to start/);
  assert.match(markup, /class="desk-say">[^<]*\w/, 'the verdict is written');
});

// A campaign is flagged recording when IT has a session open, not when its
// Discord does. It used to be the Discord, which lit every table in the server
// off one /join; the desk then had to count distinct guilds to get back to one.
// Both halves have moved: the flag is per campaign, so the count is of flags.
test('one session in a Discord with two tables is one session', async (t) => {
  const live = new Map();
  const { db, cfg, base, campaignId } = await world(t, { activeSessions: live });
  db.createCampaign('guild-1', 'The second table', CREATOR);
  // Keyed by meeting, and naming its own campaign — the shape handleJoin
  // registers now that one Discord can hold two live sessions.
  live.set(101, {
    meetingId: 101, guildId: 'guild-1', campaignId,
    startedAtMs: Date.now() - 60_000, channelName: 'The Cellar', capturedUtterances: [],
  });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /Quill is at the table\./);
  assert.doesNotMatch(markup, /Quill is at two tables/);
  assert.match(markup, /class="band live"/, 'and the live band is drawn once');
  assert.equal(markup.match(/class="band live"/g).length, 1);
});

// Every door is one somebody may walk through, so a viewer must not be drawn
// one that would refuse them.
// A player with one table is taken straight to it, so the desk is somewhere
// they go rather than somewhere they start. See `landed` in 09-paint.js.
const toTheDesk = (page) =>
  page.click(['[data-screen]'], { screen: 'desk' }, (m) => /class="desk-say"/.test(m));

test('a player with one table opens straight into it', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.doesNotMatch(markup, /class="desk-say"/, 'not left on a desk with one door on it');
  assert.match(markup, /class="shelf-slider picked"/, 'and the sessions are listed, not the chooser');

  // The way back to the desk is still a way back to the desk: the shortcut is
  // spent on arrival and must not bounce them into the campaign again.
  await toTheDesk(page);
  assert.match(page.body(), /class="desk-say"/);
});

test('the operator still starts on the desk, one table or not', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(page.body(), /class="desk-say"/);
});

// The transcriber being away is the ordinary state of a PC that is off, and it
// is only a banner while a session is actually stopped behind it.
test('an unreachable transcriber with nothing held is a mark, not a banner', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.doesNotMatch(markup, /class="banner"/);
  assert.match(markup, /class="navmark away"/);

  const player = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  assert.doesNotMatch(player.body(), /navmark away/, 'and it is nobody else\'s business');
});

test('an unreachable transcriber with a session held is still a banner', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-09T19:00:00Z', audioDir: '/tmp',
  });
  db.endMeeting(meeting, '2026-08-09T22:00:00Z');
  db.setMeetingStatus(meeting, 'awaiting_transcription');
  db.enqueueTranscribeJob(meeting, { requireApproval: false });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();
  assert.match(markup, /class="banner"/);
  assert.match(markup, /held until the machine comes back/);
  assert.doesNotMatch(markup, /navmark away/, 'one of the two speaks, never both');
});

test('a player is offered no machinery on the desk', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  await toTheDesk(page);
  const markup = page.body();

  assert.doesNotMatch(markup, /data-screen="usage"/, 'nor the usage page while its figures are examples');

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="door/);
  assert.match(markup, /Cipher/, 'their own table is still theirs to open');
  assert.doesNotMatch(markup, /data-screen="models"/);
  assert.doesNotMatch(markup, /data-screen="servers"/);
  assert.doesNotMatch(markup, /gatehouse/);
});

const saidOnTheDesk = (markup) => {
  const said = /class="desk-say">([^<]*)</.exec(markup);
  assert.ok(said, 'the desk wrote a verdict');
  return said[1].trim();
};

// The quiet night reads the same to everyone, and that is what makes it safe.
//
// scope.js zeroes `awaiting` for anybody who may not act on it, so a head that
// said "everything is written up" would be Quill vouching to a player for a
// queue it had never shown them. The line points at the evening instead, which
// is true for whoever is looking — so if these two ever diverge, a claim has
// crept back in that only one of them can check.
test('the quiet night says the same thing to the operator and to a player', async (t) => {
  const { db, cfg, base } = await world(t);

  const dev = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const player = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  await toTheDesk(player);

  const said = saidOnTheDesk(dev.body());
  assert.equal(said, saidOnTheDesk(player.body()));
  assert.ok(said.length > 0);
  assert.doesNotMatch(said, /written up/i, 'and it claims nothing about the queue');
});

// The desk repaints on every five-second poll. A line chosen at random would
// change under the reader between one poll and the next, so it is fixed to the
// date instead — two renders a moment apart must agree.
test('the quiet night does not change between two paints', async (t) => {
  const { db, cfg, base } = await world(t);

  const first = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const second = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });

  assert.equal(saidOnTheDesk(first.body()), saidOnTheDesk(second.body()));
});

// --- wikilinks -------------------------------------------------------------

// The connection the compendium already knew about, made clickable where it
// is read. The campaign has an NPC entry for Wren Halloway and the recap says
// the name, so the recap must offer the way there.
test('a name in the write-up links to that entry', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.settle((m) => /class="wiki"/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /<button type="button" class="wiki" data-entry="npcs:wren halloway">Wren Halloway<\/button>/);
  assert.doesNotMatch(markup, /\[\[/, 'the brackets are how a link is written, not how it is read');

  // And following it lands on that name in the list rather than merely
  // selecting it in the column.
  await page.click(['[data-entry]'], { entry: 'npcs:wren halloway' },
                   (m) => /notary clerk/.test(m));
  const landed = page.body();
  assert.match(landed, /class="cast-row" id="entry-npcs-wren-halloway"/,
               'and there is a row to scroll to, with an id a browser will accept');
  assert.match(landed, /class="ledger-night"[\s\S]*?<span class="n">Session 1<\/span>/,
               'under the night it walked on, named by number');
});

// A name that has no entry must not be dressed as a link to one.
test('only names the campaign actually has become links', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.settle((m) => /class="wiki"/.test(m));

  assert.doesNotMatch(page.body(), /class="wiki" data-entry="[^"]*registry/i);
});

// --- the item list ---------------------------------------------------------

test('items are one list, and coin is not on it', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-shelf]'], { shelf: 'items' }, (m) => /brass key/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /A brass key stamped with a wren/);
  assert.doesNotMatch(markup, /450 gold pieces/, 'a quantity is what a night was worth, not a thing');
  assert.match(markup, /class="ledger\b/, 'and what is drawn is a list rather than a page per item');
});

// --- the cast list ---------------------------------------------------------

test('people are one list, and a returning name says which nights', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-shelf]'], { shelf: 'npcs' }, (m) => /notary clerk/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="ledger\b/, 'a list, not a page per name');
  assert.match(markup, /<div class="nm">Wren Halloway<\/div>/);

  // Met on the first night and named again on the second. The row belongs to
  // the night the name walked on and carries the return, rather than being
  // printed again under session two.
  assert.match(markup, /class="again">back in <b>2<\/b>/);
  assert.equal((markup.match(/<div class="nm">Wren Halloway<\/div>/g) ?? []).length, 1,
               'a recurring name is on the list once');
});

test('places are one list too, in the order the party found them', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-shelf]'], { shelf: 'places' }, (m) => /Ashen Vaults/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="ledger\b/);
  assert.match(markup, /<div class="nm">The Ashen Vaults<\/div>/);
  assert.match(markup, /in the order the party found them/);
});

// --- the pane's own furniture ---------------------------------------------

test('a session is called Session N, never by its command reference', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /Session 2/.test(m));
  const markup = page.body();

  assert.match(markup, /Session 1/);
  assert.match(markup, /Session 2/);
  assert.doesNotMatch(markup, /Cipher_0\d/, 'the slug is for slash commands, not for reading');
});

test('the tabs read first and settings belongs to whoever runs the campaign', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);

  const dev = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(dev, campaignId);
  const asDev = dev.body();
  assert.match(asDev, /data-tab="settings"/, 'the operator manages every campaign');
  assert.ok(
    asDev.indexOf('data-tab="notes"') < asDev.indexOf('data-tab="corrections"')
      && asDev.indexOf('data-tab="corrections"') < asDev.indexOf('data-tab="table"'),
    'reading, then fixing, then the roster'
  );

  const player = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  await enter(player, campaignId);
  assert.doesNotMatch(player.body(), /data-tab="settings"/,
    'a player would only be shown values they cannot change');
});

// --- where the notes go ---------------------------------------------------

// "A chosen channel" was drawn disabled from the day the switch existed,
// pointing at a slash command, because the page had never been told which
// channels the bot may post in. It has been now.
test('a channel is chosen from the list Discord gave, never typed', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'settings' }, (html) => html.includes('data-pick-channel'));

  const settings = page.body();
  assert.doesNotMatch(settings, /data-pick-channel[^>]*disabled/,
    'the middle option is live once the channels are known');
  assert.doesNotMatch(settings, /campaign output/,
    'and no longer sends anybody to Discord to do it');

  // Opening the list is its own step: choosing a channel is two answers — that
  // it is a channel, and which one — and the segment can only give the first.
  await page.click(['button[data-pick-channel]'], {}, (html) => html.includes('data-set-channel'));
  const picking = page.body();

  assert.match(picking, /<select[^>]*data-set-channel/, 'a list');
  assert.doesNotMatch(picking, /<input[^>]*channel/i, 'and never a box to type an id into');
  assert.match(picking, /<option value="900000000000000002"[^>]*>#session-notes</);
  assert.match(picking, /<optgroup label="Campaign">/, 'grouped the way Discord draws them');
  assert.match(picking, /<option value="" disabled selected>/, 'nothing is pre-chosen');
});

// The delivery code already falls back to the channel the session was recorded
// in when the chosen one has gone. Nobody was ever told, which is how this goes
// unnoticed for a month.
test('a destination pointing at a channel that has gone says so', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  db.setCampaignOutput(campaignId, 'channel', '900000000000000404');

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'settings' }, (html) => html.includes('data-set-channel'));

  const settings = page.body();
  assert.match(settings, /has gone, or I can no longer post in it/);
  assert.match(settings, /posted back in the channel the session was recorded in/,
    'and what is happening in the meantime');
  assert.match(settings, /<option value="" disabled selected>/, 'the stray id is not offered as a choice');
});

// --- the margin -----------------------------------------------------------

// A session whose scenes name some of its people and not others, so the
// margin has something to anchor to and something to fail to anchor.
// Dated after the fixture's own two, because opening a campaign lands on its
// newest night.
function nightWithScenes(db, campaignId) {
  const m = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-09T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(m, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'We go down.' },
  ]);
  db.endMeeting(m, '2026-08-09T22:00:00Z');
  db.setSummary(m, {
    tldr: 'A short night.',
    scenes: [
      { title: 'Upstairs', points: ['Nothing much happened in the gallery.'] },
      { title: 'Downstairs', points: ['Sable Quorn was waiting in the strongroom.'] },
    ],
    npcsIntroduced: [
      'Sable Quorn: keeper of the strongroom',
      'Ferrety Nim: a runner no scene ever gets round to',
    ],
    locationsVisited: [], partyDecisions: [],
    lootAndRewards: [], unresolvedThreads: [], followUps: [], funnyMoments: [],
  });
  db.setMeetingStatus(m, 'done');
  return m;
}

// The whole point of the margin: the note is not a list at the side of the
// page, it stands level with the sentence that introduces the name. In the
// markup that means it is emitted inside its own scene — after everything the
// scene before it said, and before the scene it belongs to says anything.
test('a name in the margin stands beside the scene that introduces it', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  nightWithScenes(db, campaignId);

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /Downstairs/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);

  // Substrings with no name in them, so a wikilink wrapping "Sable Quorn"
  // cannot break the search.
  const before = markup.indexOf('Nothing much happened in the gallery');
  const after = markup.indexOf('was waiting in the strongroom');
  const note = markup.indexOf('sidenote-name">Sable Quorn<');

  assert.ok(before > 0 && after > 0 && note > 0, 'both scenes and the note are drawn');
  assert.ok(note > before, 'the note is not hoisted above the scene before it');
  assert.ok(note < after, 'and it heads the scene that names them');
});

// A name the scenes never get to still has to appear. Dropping it would make
// the margin quieter and the write-up less complete, which is the wrong trade.
test('a name no scene mentions falls to the foot of the margin', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  nightWithScenes(db, campaignId);

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /Downstairs/.test(m));
  const markup = page.body();

  const lastScene = markup.indexOf('was waiting in the strongroom');
  const stray = markup.indexOf('sidenote-name">Ferrety Nim<');

  assert.ok(stray > 0, 'it is still written');
  assert.ok(stray > lastScene, 'after everything the scenes had to say');
});

// Each entry is claimed once, and the rail gives up exactly the two sections
// the margin took over. Both are always in the markup — CSS draws one — so a
// second copy here would be a section a screen reader hears twice.
test('the margin claims each name once, and the rail gives up those sections', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  const markup = page.body();

  // The fixture introduces one NPC and visits one place.
  assert.equal((markup.match(/class="sidenote"/g) ?? []).length, 2);
  assert.equal((markup.match(/sidenote-name">Wren Halloway</g) ?? []).length, 1);
  assert.equal((markup.match(/sidenote-name">The Ashen Vaults</g) ?? []).length, 1);

  // Which sections the rail gives up. recapSections() is rendered TWICE on
  // purpose — once into the rail and once under the prose, with CSS drawing
  // one — so counting the marks would only count that. What matters is WHICH
  // sections carry it: the two the margin took over, and no others.
  const marked = [...markup.matchAll(/class="rail-anchored"><div class="cap"[^>]*>([^<]+)</g)]
    .map((m) => m[1].trim());
  assert.ok(marked.length > 0, 'the rail marks what it gives up');
  assert.deepEqual([...new Set(marked)].sort(), ['Locations', 'NPCs introduced']);
});

// Corrections are about the name, not about which program mishears it — the
// user's own rule, and the same one the health line already follows.
test('the corrections tab names no transcriber', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  // The creator, not the operator: the operator's top bar names the whisper
  // server on every screen, which would fail this for the wrong reason.
  const page = await render({ base, cookie: cookieFor(db, cfg, CREATOR, 'kez') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'corrections' }, (m) => /Heard as/.test(m));

  assert.match(page.body(), /Names that come back wrong/);
  assert.doesNotMatch(page.body(), /whisper/i);
});

// The fix is offered where the mangled name is read, not only on the tab that
// keeps the list.
test('a write-up offers to fix a name it got wrong', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /data-fix-name/.test(m));

  await page.click(['[data-fix-name]'], {}, (m) => /corrections\/add/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /data-act="corrections\/add"/);
  assert.match(markup, /name="wrong"/);
  assert.match(markup, /name="right"/);
});

// What the Copy button puts on the clipboard is a file for a vault, and a file
// for a vault says [[Wren Halloway]] where this page draws an underline. The
// two come from one list of spans, so this also pins the linking rules
// themselves somewhere they can be read as text.
test('the notes copied for Obsidian carry their wikilinks', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.settle((m) => /class="wiki"/.test(m));

  await page.click(['[data-copy-notes]'], {}, () => page.copied.length > 0);
  const markdown = page.copied.at(-1) ?? '';

  assert.match(markdown, /\[\[Wren Halloway\]\] signed the writ/);
  assert.match(markdown, /^# Cipher_0\d/, 'the heading is the name the vault gives the file');
});

// --- the threshold, WIP ---
//
// The screen somebody gets once, on the first sign-in their account has ever
// made. What is pinned here is the routing rather than the writing: which
// question is asked, which is skipped because the bot already knows the answer,
// and which door it puts them at. The animation is a browser matter and this
// harness has no layout — see the CDP checks in the ADR for that class of test.

test('a first sign-in is met by the book, not by the dashboard', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: firstCookieFor(db, cfg, PLAYER, 'saf') });
  await page.settle((m) => /thr-sheet/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok, 'unbalanced markup means a template threw part-way');
  assert.match(markup, /Welcome, adventurer/);
  assert.match(markup, /Create the Story\./);
  assert.match(markup, /Join the Story\./);
  assert.match(markup, /data-thr-answer="dm"/);
  assert.match(markup, /class="wisp"/, 'each answer carries the torch that lights it');
  assert.match(markup, /class="thr-wip"/, 'a screen still being written says so');
  assert.doesNotMatch(markup, /data-screen="models"/, 'nothing of the dashboard is drawn behind it');
});

test('somebody who has been here before is never asked again', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  const markup = page.body();

  assert.doesNotMatch(markup, /Welcome, adventurer/);
});

// The one rule that keeps this from being a questionnaire: a table the bot can
// already see is not something it asks about. saf has played at Cipher, so the
// second question is skipped and the ending is the way in to that table.
test('a player with a table is shown where it is, and asked nothing further', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: firstCookieFor(db, cfg, PLAYER, 'saf') });
  await page.settle((m) => /thr-sheet/.test(m));

  // Joining asks for an invitation first, because somebody pressing "join a
  // story" while already sitting at one means a story this bot cannot see.
  await page.click(['[data-thr-answer]'], { thrAnswer: 'player' }, (m) => /thr-token/.test(m));
  assert.match(page.body(), /Show me the invitation/);

  await page.click(['[data-thr-nolink]'], {}, (m) => /thr-entry/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.doesNotMatch(markup, /Has Quill joined you/, "the maker’s questions are not asked of a joiner");
  assert.match(markup, /Open Cipher/);
  assert.match(markup, new RegExp(`data-thr-campaign="${campaignId}"`));
  assert.match(markup, /first entry/, 'the book writes their name in');
  // One exchange on the page at a time: the question that was answered has
  // burnt away rather than staying above the next thing. There is no fire in
  // this harness — no layout to measure one against — so what is under test is
  // that the answered block is GONE, which is the part the fire is dressing.
  assert.doesNotMatch(markup, /Welcome, adventurer/, 'the answered question does not stay on the page');
});

// The DM with nowhere to put a campaign yet, which is the other half of the
// brief: the two questions, then the door to campaign creation.
test('a new operator is asked the second question and left at campaign creation', async (t) => {
  const { db, cfg, base } = await world(t);
  // Nobody's owner, nobody's player: an account with no table anywhere is the
  // only one the second question is for.
  const page = await render({ base, cookie: firstCookieFor(db, cfg, '50000000000000005', 'rhi') });
  await page.settle((m) => /thr-sheet/.test(m));

  await page.click(['[data-thr-answer]'], { thrAnswer: 'dm' }, (m) => /Has Quill joined/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'yes' }, (m) => /thr-entry/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.doesNotMatch(markup, /Welcome, adventurer/, 'both answered questions are gone');
  assert.match(markup, /Then begin it in Discord/);
  assert.match(markup, /data-thr-door="create"|\/campaign create/);
  assert.match(markup, /data-thr-door="dashboard"/, 'there is always a way past it');
});

// The table gets made inside the threshold rather than behind it. A DM whose
// Discord Quill is already in, and whom the bot could actually be told to make
// a campaign for, is asked what it is called — no dialog, no command, no
// handing them to a screen they have never seen.
test('a new DM who can be given a table is asked what it is called', async (t) => {
  const { db, cfg, base } = await world(t, { memberOf: true });
  const page = await render({ base, cookie: firstCookieFor(db, cfg, '50000000000000005', 'rhi') });
  await page.settle((m) => /thr-sheet/.test(m));

  await page.click(['[data-thr-answer]'], { thrAnswer: 'dm' }, (m) => /Has Quill joined/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'yes' }, (m) => /data-thr-name/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /Then we begin a new one/);
  assert.match(markup, /What is the story called\?/);
  assert.match(markup, /id="thr-name"/, 'the name is typed here');
  assert.doesNotMatch(markup, /\/campaign create/, 'nobody is sent off to type a command');
  assert.doesNotMatch(markup, /first entry/, 'and it is not the ending yet');
});

// --- the other road: joining by invitation ---
//
// A link is the only part of this screen that reaches somebody who is not new.
// It has to open for a player who signed in months ago for a different table,
// it has to name the table before it asks anything, and the question it asks
// has to be answerable with no.

const RHI = '50000000000000005';
const invitedTo = (db, campaignId) =>
  db.createInviteLink({ token: 'brass-key-9', campaignId, createdBy: CREATOR }).token;

test('an invitation opens the book for somebody who has been here before', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const token = invitedTo(db, campaignId);

  // cookieFor, not firstCookieFor: this account has signed in before, which is
  // exactly the case the first-visit gate would refuse.
  const page = await render({
    base, cookie: cookieFor(db, cfg, RHI, 'rhi'), search: `?join=${token}`,
  });
  await page.settle((m) => /thr-terms/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /Cipher is expecting you/, 'it names the table before it asks for anything');
  assert.match(markup, /Yours as well\?/);
  assert.match(markup, /data-thr-agree="no"/, 'the question can be answered with no');
  assert.doesNotMatch(markup, /Welcome, adventurer/, 'an invitation is not the first-timer walk');
  assert.doesNotMatch(markup, /id="thr-seat"/, 'nothing is asked of them before they have agreed');
});

test('the recording question is asked with the facts it cannot be asked without', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({
    base, cookie: cookieFor(db, cfg, RHI, 'rhi'), search: `?join=${invitedTo(db, campaignId)}`,
  });
  await page.settle((m) => /thr-terms/.test(m));
  const markup = page.body();

  assert.match(markup, /only while it is in the voice channel/i);
  assert.match(markup, /That text — not your audio — is then sent to an AI service/, 'what leaves the machine is stated, not glossed');
  assert.match(markup, /not uploaded anywhere to be transcribed/, 'in the bot’s own words about this install');
  assert.match(markup, /campaign consent/, 'and how to take it back');
});

test('agreeing writes the consent and the character name under the session', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({
    base, cookie: cookieFor(db, cfg, RHI, 'rhi'), search: `?join=${invitedTo(db, campaignId)}`,
  });
  await page.settle((m) => /thr-terms/.test(m));

  await page.click(['[data-thr-agree]'], { thrAgree: 'yes' }, (m) => /id="thr-seat"/.test(m));
  assert.match(page.body(), /What do they call you at the table\?/);

  // The last press on this road burns to the dashboard rather than to an ending
  // of its own, so what it settles on is the desk being drawn.
  await page.submit('data-thr-seat', { 'thr-seat': 'Marn Ashgrove' }, (m) => /data-screen/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.equal(db.mayRecord(campaignId, RHI), true);
  assert.equal(db.getCharacterName(campaignId, RHI), 'Marn Ashgrove');
  assert.doesNotMatch(markup, /thr-sheet/, 'the book is gone');
  assert.doesNotMatch(markup, /first entry/, 'and it does not stop to write them in first');
});

test('declining is recorded, and nothing else is asked of them', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({
    base, cookie: cookieFor(db, cfg, RHI, 'rhi'), search: `?join=${invitedTo(db, campaignId)}`,
  });
  await page.settle((m) => /thr-terms/.test(m));

  await page.click(['[data-thr-agree]'], { thrAgree: 'no' }, (m) => /id="thr-seat"/.test(m));
  // The no is sent before the name is even asked for, and deliberately WITHOUT
  // waiting for the page to finish moving — see welcomeAgree. The screen
  // reaching the next step is not the evidence; the row is.
  await page.settle(() => db.getConsent(campaignId, RHI)?.state === 'declined');
  assert.equal(db.getConsent(campaignId, RHI)?.state, 'declined', 'a no is an answer on file, not silence');

  // And they are still asked what to call them: not being recorded is not the
  // same as not being at the table.
  assert.match(page.body(), /your seat is still yours/);
  await page.submit('data-thr-seat', { 'thr-seat': 'Orrin Vale' }, (m) => /thr-entry/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.equal(db.getCharacterName(campaignId, RHI), 'Orrin Vale', 'the table knows who they are');
  assert.equal(db.mayRecord(campaignId, RHI), false, 'and Quill still never records them');
  assert.match(markup, /not in the book/, 'the answer is said back to them');
  assert.doesNotMatch(markup, /data-thr-agree/, 'and it does not ask again');
});

test('somebody who already agreed is asked only what to call them', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  // saf agreed to be recorded at Cipher back in world().
  const page = await render({
    base, cookie: cookieFor(db, cfg, PLAYER, 'saf'), search: `?join=${invitedTo(db, campaignId)}`,
  });
  await page.settle((m) => /id="thr-seat"/.test(m));
  const markup = page.body();

  assert.doesNotMatch(markup, /data-thr-agree/, 'the question has an answer on file already');
  assert.match(markup, /What do they call you at the table\?/);
});

test('a dead invitation names no table and asks for another', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({
    base, cookie: cookieFor(db, cfg, RHI, 'rhi'), search: '?join=never-was-a-token',
  });
  // Settled on the REFUSAL, not on the field. The field is drawn as soon as the
  // step changes; the note under it arrives a paint later, when invite/peek has
  // answered — so waiting for the field and asserting on the note is a race, and
  // it lost one on a loaded machine.
  await page.settle((m) => /not good any more/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /id="thr-token"/);
  assert.match(markup, /not good any more/);
  assert.doesNotMatch(markup, /Cipher/, 'a bad token learns nothing about what exists');
  assert.match(markup, /data-thr-nolink/, 'and there is a way out of the dead end');
});

// And the same two answers from somebody the bot could NOT make a campaign for
// still end where they used to: with the command, since that is the only way in
// that exists for them.
test('a new DM with no server the bot can place a table in gets the command', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: firstCookieFor(db, cfg, '50000000000000005', 'rhi') });
  await page.settle((m) => /thr-sheet/.test(m));

  await page.click(['[data-thr-answer]'], { thrAnswer: 'dm' }, (m) => /Has Quill joined/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'yes' }, (m) => /thr-entry/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /\/campaign create/);
  assert.doesNotMatch(markup, /id="thr-name"/, 'there is nothing to type here');
});

// --- the twenty-four voices ---
//
// The colour is chosen on the campaign table and spent in the transcript, so
// what these check is the far end: that a slug in the database becomes a class
// on a name, that the reader can turn the rest of the table off without
// turning themselves off, and that the filter chips are identified well enough
// to survive a repaint.

async function openTranscript(page) {
  await page.click(['[data-transcript]'], { transcript: '1' }, (m) => /class="line"/.test(m));
  return page.body();
}

test('a chosen colour is what the name is written in', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  db.setVoiceColour(campaignId, PLAYER, 'eldritch-deep');

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'dev') });
  const markup = await openTranscript(page);

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="who[^"]* voiced v-eldritch-deep"/, "the speaker's name is not in their colour");
  assert.match(markup, /class="chip[^"]* voiced v-eldritch-deep"/, "the filter chip is not in their colour");
  assert.doesNotMatch(markup, /v-gold/, 'a colour nobody chose was drawn anyway');
});

test('every speaker chip is identified, so a repaint cannot mistake one for another', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'dev') });
  const markup = await openTranscript(page);

  // Without a data-key the patcher falls back to position among siblings of
  // the same tag, which is fine until somebody speaks for the first time and
  // every chip after them shifts by one — at which point each chip inherits
  // the previous one’s colour for a paint. See dash/morph.js.
  assert.match(markup, /data-key="chip-all"/);
  assert.match(markup, new RegExp(`data-key="chip-${PLAYER}"`));
  assert.match(markup, new RegExp(`data-key="chip-${CREATOR}"`));
});

test('turning the colours off leaves the reader their own', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  db.setVoiceColour(campaignId, PLAYER, 'eldritch-deep');
  db.setVoiceColour(campaignId, CREATOR, 'gold-bright');

  // Signed in AS the creator, so one of the two colours on this table is the
  // reader's own — which is the whole distinction the switch makes.
  const page = await render({ base, cookie: cookieFor(db, cfg, CREATOR, 'kez') });
  let markup = await openTranscript(page);
  assert.match(markup, /v-eldritch-deep/, 'the other player was not drawn in their colour to begin with');

  await page.click(['[data-voices]'], {}, (m) => !/v-eldritch-deep/.test(m));
  markup = page.body();

  assert.doesNotMatch(markup, /v-eldritch-deep/, 'the switch did not take the other player\u2019s colour away');
  assert.match(markup, /v-gold-bright/, 'it took the reader\u2019s own colour away as well, which is not what it is for');

  // And back again, on the same browser.
  await page.click(['[data-voices]'], {}, (m) => /v-eldritch-deep/.test(m));
  assert.match(page.body(), /v-eldritch-deep/, 'the switch only goes one way');
});

test('a table where nobody has picked is not offered a switch', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'dev') });
  const markup = await openTranscript(page);

  // A control that visibly does nothing reads as broken rather than as
  // unnecessary.
  assert.doesNotMatch(markup, /data-voices/);
  assert.doesNotMatch(markup, /voiced/);
});

// --- where you are in a write-up -------------------------------------------
//
// The rail itself is built by reading the DOM, which this harness has none of,
// so it is checked in a real browser instead. What IS checkable here is the
// half the rail is built from: every part of the prose has to be anchored and
// named, or the index has nothing to list and nowhere to send anybody.

test('every part of a write-up is anchored and named', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  const markup = page.body();

  assert.ok(balanced(markup).ok);

  const parts = [...markup.matchAll(/id="(part-[a-z0-9-]+)" data-part="([^"]*)"/g)]
    .map((m) => ({ id: m[1], name: m[2] }));

  // The fixture has a lede, one scene, and one decision — the follow-ups list
  // is empty, and a section with nothing in it is not a place to send anybody.
  assert.ok(parts.some((p) => p.id === 'part-0'), 'the opening has no anchor');
  assert.ok(parts.some((p) => p.id === 'part-1'), 'the first scene has no anchor');
  assert.ok(parts.some((p) => p.id === 'part-decisions'), 'the decisions have no anchor');
  assert.equal(parts.filter((p) => p.id === 'part-followups').length, 0,
               'an empty section was still offered as somewhere to go');

  // A name each, and an id each. Two parts sharing an id would send both rows
  // of the index to whichever one the browser found first.
  for (const p of parts) assert.ok(p.name.length > 0, `${p.id} has no name`);
  assert.equal(new Set(parts.map((p) => p.id)).size, parts.length);

  // The scene takes its own title, so the index reads as the write-up does.
  assert.ok(parts.some((p) => p.name === 'The queue at the notary'),
            'a scene is not indexed under its own title');
});

// The index is the one thing on this page built by reading the page, so the
// copy the template makes describes the write-up that was open a moment ago.
// Opening a different session made that visible: the index went blank until
// the five-second poll came round, and on other timing it listed the previous
// night's scenes under ids that had gone. It is put right straight after the
// morph instead, which only works if there is a slot to put it in and if the
// putting-right happens before anything reads the rows.
test('the index has a slot of its own, filled after the page is drawn', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);

  assert.match(page.body(), /<div class="parts-slot" data-key="parts-slot">/,
               'the rail has nowhere to put an index that disagrees with the page');

  const html = await dashboardSource();
  const paint = html.slice(html.lastIndexOf('function paint()'));
  const sync = paint.indexOf('syncParts()');
  const mark = paint.indexOf('markPart()');
  assert.ok(sync > 0, 'paint never puts the index right');
  assert.ok(mark > 0 && sync < mark, 'the index is marked before it is the right index');
});

// Correcting a write-up is a state, not a button, so the switch has to say
// which state you are in rather than which one pressing it would reach — and
// it cannot be there at all for somebody the bot cannot name, because every
// part of a correction (whose it is, whose colour it is in, who may change it)
// needs an account behind it.
test('the write-up offers a way into correcting it, and starts out of it', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  const markup = page.body();

  assert.match(markup, /data-seg="marking"/, 'no switch on the write-up');
  assert.match(markup, /data-mark="read"[^>]*>Reading</);
  assert.match(markup, /data-mark="correct"[^>]*>Correcting</);

  // Out of it to begin with: a page that opened in a mode where clicking a
  // sentence changes it would be a page that changes sentences by accident.
  assert.doesNotMatch(markup, /class="mark-band"/, 'the page opened already correcting');
  assert.doesNotMatch(markup, /data-mark-line=/, 'a line was pressable before anybody asked');
  assert.doesNotMatch(markup, /class="pane-main marking"/);
});

test('the card that opens over a name has somewhere to be drawn', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  // The links are drawn once the compendium has been read, which is a fetch
  // per session — so this waits for the thing it is about to assert on rather
  // than for the screen it sits on.
  await page.settle((m) => /class="wiki"/.test(m));

  // It is anchored to a node inside a panel the patcher rebuilds, so it has to
  // live outside every panel or it would be thrown away with the first poll
  // that landed while somebody was reading it.
  const html = await readFile(PAGE, 'utf8');
  assert.match(html, /<div class="peek" id="peek" role="tooltip" hidden><\/div>/);

  const skeleton = html.slice(html.indexOf('<div id="modal">'), html.indexOf('<script src="/dash/morph.js">'));
  assert.ok(skeleton.includes('id="peek"'), 'the card is inside something that gets patched');

  // And the names it opens over are the wikilinks, which carry the entry it
  // reads. If that attribute ever moves, the card goes blank rather than
  // loudly wrong.
  assert.match(page.body(), /class="wiki" data-entry="npcs:wren halloway"/);
});

// --- finding your way around a campaign (2026-11-14) -----------------------

test('the session list says what each night was called', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /class="ttl"/.test(m));

  // The first scene's own heading, which is also the write-up's headline. A
  // column that says only "Session 2" cannot be scanned for a night.
  assert.match(page.body(), /<span class="ttl">The queue at the notary<\/span>/);
});

test('one night leads to the next without going back to the list', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const [newest, oldest] = db.listRecentMeetings(campaignId, 5).map((m) => m.id);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId, (m) => /class="night-turn/.test(m));
  let markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="ribbon-name">Session 2</, 'it opens on the latest night');
  assert.match(markup, /aria-label="No later night"/, 'which has nothing after it');
  assert.match(markup, new RegExp(`class="menu-btn step" data-step-session="${oldest}"`), 'and one before');
  assert.match(markup, new RegExp(`class="turn back" data-step-session="${oldest}"`),
    'offered again at the foot of the write-up, where the reading ends');

  await page.click(['[data-step-session]'], { stepSession: String(oldest) },
    (m) => /class="ribbon-name">Session 1</.test(m));
  markup = page.body();
  assert.match(markup, /class="ribbon-name">Session 1</);
  assert.match(markup, /aria-label="No earlier night"/);
  assert.match(markup, new RegExp(`class="turn on" data-step-session="${newest}"`));
});

// Both nights in this campaign introduce Wren Halloway in the same five words,
// which is what a summariser told to say who somebody is will do.
test('a line the write-ups repeat about somebody is said once', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-shelf]'], { shelf: 'npcs' }, (m) => /notary clerk/.test(m));
  const said = page.body().match(/<div class="cast-said">[\s\S]*?<\/div>/)?.[0] ?? '';

  assert.equal((said.match(/The notary clerk/g) ?? []).length, 1);
  assert.match(page.body(), /class="again">back in <b>2<\/b>/, 'and the return is still on the row');
});

test('a word is found in every write-up and every transcript', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'search' }, (m) => /id="hunt-q"/.test(m));
  assert.doesNotMatch(page.body(), /In the write-ups/, 'nothing is listed before anything is asked');

  // Said aloud on both nights, and in neither write-up.
  await page.submit('data-campaign-search', { 'hunt-q': 'ledger' }, (m) => /In the transcripts · /.test(m));
  let markup = page.body();
  assert.ok(balanced(markup).ok);
  assert.match(markup, /In the transcripts · 2 lines/);
  assert.match(markup, /Kaelen opens the <mark>ledger<\/mark>\./);
  assert.match(markup, /00:00:00 · saf/, 'with when it was said and by whom');
  assert.match(markup, /data-transcript="\d+"\s+data-find="ledger"/, 'and a way into the transcript it came from');
  assert.match(markup, /No write-up mentions “ledger”/);

  // Written up on both nights, and never said on the record.
  await page.submit('data-campaign-search', { 'hunt-q': 'WRIT' }, (m) => /Nobody said “WRIT”/.test(m));
  markup = page.body();
  assert.match(markup, /In the write-ups · 4 lines/, 'the summary and the scene, on each of two nights');
  assert.match(markup, /signed the <mark>writ<\/mark>\./, 'found whatever the case it was typed in');
  assert.match(markup, /Nobody said “WRIT” on the record/);
});

test('a player searches the write-ups and is never handed a transcript line', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const cookie = cookieFor(db, cfg, PLAYER, 'saf');
  const page = await render({ base, cookie });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'search' }, (m) => /id="hunt-q"/.test(m));
  await page.submit('data-campaign-search', { 'hunt-q': 'ledger' }, (m) => /No write-up mentions/.test(m));
  const markup = page.body();

  assert.match(markup, /No write-up mentions “ledger”/);
  assert.doesNotMatch(markup, /In the transcripts/);
  assert.doesNotMatch(markup, /opens the/, 'the line that would have matched is not on the page');

  // And the page not asking is a courtesy. This is the rule.
  const asked = await fetch(`${base}/search?campaign=${campaignId}&q=ledger&token=sesame`, { headers: { Cookie: cookie } });
  assert.equal(asked.status, 403);
});

test('the table tab hands out the invite link, and can pull it', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'table' }, (m) => /Or hand out a link/.test(m));
  assert.match(page.body(), /data-act="invite\/link"/);
  assert.doesNotMatch(page.body(), /data-act="invite\/revoke"/, 'nothing to pull until one is out');

  await page.click(['button[data-act]'], { act: 'invite/link', campaign: String(campaignId) },
    (m) => /data-act="invite\/revoke"/.test(m));
  assert.ok(db.liveInviteLinkFor(campaignId), 'the press made one');
  // This install has no DASHBOARD_URL, so there is a link and no address for
  // it. Said, rather than half an address somebody would paste.
  assert.match(page.body(), /no web address set/);
  assert.doesNotMatch(page.body(), /data-act="invite\/link"/);

  await page.click(['button[data-act]'], { act: 'invite/revoke', campaign: String(campaignId) },
    (m) => /data-act="invite\/link"/.test(m));
  assert.equal(db.liveInviteLinkFor(campaignId) ?? null, null, 'and the second press pulled it');

  const player = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  await enter(player, campaignId);
  await player.click(['[data-tab]'], { tab: 'table' }, (m) => /class="grid roster/.test(m));
  assert.doesNotMatch(player.body(), /hand out a link/, 'the link is the manager’s to give');
});

test('the book can be turned back a page', async (t) => {
  const { db, cfg, base } = await world(t, { memberOf: true });
  const page = await render({ base, cookie: firstCookieFor(db, cfg, RHI, 'rhi') });
  await page.settle((m) => /thr-sheet/.test(m));
  assert.doesNotMatch(page.body(), /data-thr-back/, 'there is nothing before the first question');

  await page.click(['[data-thr-answer]'], { thrAnswer: 'dm' }, (m) => /Has Quill joined/.test(m));
  assert.match(page.body(), /data-thr-back/);
  await page.click(['[data-thr-answer]'], { thrAnswer: 'yes' }, (m) => /data-thr-name/.test(m));

  await page.click(['[data-thr-back]'], {}, (m) => /Has Quill joined/.test(m));
  assert.match(page.body(), /Has Quill joined/);
  await page.click(['[data-thr-back]'], {}, (m) => /Do you…/.test(m));
  assert.match(page.body(), /data-thr-answer="player"/, 'and the first question is asked again, unanswered');
  assert.doesNotMatch(page.body(), /data-thr-back/);
});

// The case the way back was built for: the name is the first thing a new DM
// types, the table is made the moment they press, and until now a slip there
// could only be put right from a Settings tab they had not seen yet.
test('a mistyped campaign name is corrected from the next page, not made twice', async (t) => {
  const { db, cfg, base } = await world(t, { memberOf: true });
  const page = await render({ base, cookie: firstCookieFor(db, cfg, RHI, 'rhi') });
  await page.settle((m) => /thr-sheet/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'dm' }, (m) => /Has Quill joined/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'yes' }, (m) => /data-thr-name/.test(m));

  await page.submit('data-thr-name', { 'thr-name': 'Emberfal' }, (m) => /data-thr-optout/.test(m));
  await page.click(['[data-thr-optout]'], { thrOptout: 'yes' }, (m) => /Who else is at the table/.test(m));
  assert.match(page.body(), /Change the name/);
  const made = db.listCampaigns('guild-1').find((c) => c.name === 'Emberfal');
  assert.ok(made, 'the table exists by now');

  await page.click(['[data-thr-back]'], {}, (m) => /A slip of the pen/.test(m));
  await page.submit('data-thr-name', { 'thr-name': 'Emberfall' }, (m) => /Emberfall has its first page/.test(m));

  assert.equal(db.getCampaign(made.id).name, 'Emberfall', 'the same table, under the right name');
  assert.equal(db.listCampaigns('guild-1').filter((c) => /^Emberfal/.test(c.name)).length, 1,
    'and not a second one beside it');
  assert.equal(db.getCampaign(made.id).opt_out, 1, 'and "they may" left the opt-out on');
});

// --- a table with no opt-out (2026-11-14) ----------------------------------
//
// Whoever makes a campaign is asked once whether its players may choose not to
// be recorded. Yes is how every campaign worked before the question existed.
// No means the DM answers for the table: adding somebody records them, and the
// bot sends nobody anything. See pi-service/src/campaign/opt-out.js.

test('the book asks whether players may opt out before it makes the table', async (t) => {
  const { db, cfg, base } = await world(t, { memberOf: true });
  const page = await render({ base, cookie: firstCookieFor(db, cfg, RHI, 'rhi') });
  await page.settle((m) => /thr-sheet/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'dm' }, (m) => /Has Quill joined/.test(m));
  await page.click(['[data-thr-answer]'], { thrAnswer: 'yes' }, (m) => /data-thr-name/.test(m));
  await page.submit('data-thr-name', { 'thr-name': 'Greyhollow' }, (m) => /data-thr-optout/.test(m));

  const asked = page.body();
  assert.match(asked, /May a player choose not to be recorded\?/);
  assert.match(asked, /Quill sends them nothing/, 'and what the second answer means is said before it is pressed');
  assert.equal(db.listCampaigns('guild-1').some((c) => c.name === 'Greyhollow'), false, 'nothing is made yet');

  await page.click(['[data-thr-optout]'], { thrOptout: 'no' }, (m) => /Who else is at the table/.test(m));
  const made = db.listCampaigns('guild-1').find((c) => c.name === 'Greyhollow');
  assert.equal(made.opt_out, 0);
  assert.equal(db.mayRecord(made.id, RHI), true, 'and whoever answered for the table is at it');
});

test('a table with no opt-out says so, and adds rather than asks', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  db.setCampaignOptOut(campaignId, false);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'table' }, (m) => /class="grid roster/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  // kez has spoken and is not on the roster as recorded; saf agreed long ago.
  assert.match(markup, /One person here is not being recorded/);
  assert.match(markup, /set up to record everyone on its roster/);
  assert.match(markup, />Add<\/button>/);
  assert.match(markup, /Add someone new/);
  assert.match(markup, /Quill sends them\s+nothing/);
  assert.doesNotMatch(markup, /said yes in a DM|They get a DM|still to hear from/,
    'none of the words about asking are true of this table');

  await page.click(['[data-tab]'], { tab: 'settings' }, (m) => /Players can opt out/.test(m));
  const settings = page.body();
  assert.match(settings, /Players can opt out[\s\S]{0,400}<span class="val">no<\/span>/);
  assert.match(settings, /Recording · no opt-out/);
  assert.match(settings, /Nobody at this table is sent these lines/);
  assert.doesNotMatch(settings, /Consent · players choose[\s\S]{0,40}<div style="display:flex/, 'no consent tally where nobody was asked');
});

// The card read "never leaves your network and is not kept, and this cannot be
// turned off" on every install, whatever the install did.
test('the Audio card says what this install does, and which kind of table it is', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  cfg.audioRetentionDays = 14;
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'settings' }, (m) => /class="facts-list"/.test(m));
  let markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /Deleted from the bot after 14 days/);
  assert.match(markup, /class="card good"/, 'green, because nothing here leaves the machine');
  assert.match(markup, /Your recording is never sent anywhere else/);
  assert.match(markup, /Consent · players choose/);
  assert.match(markup, /Each player is shown these same lines before they agree/);
  assert.doesNotMatch(markup, /cannot be turned off|Deleted once transcribed/);

  // The same campaign on an install that can send a session to Google and
  // keeps the clips. Read again from the bot, not remembered by the page.
  Object.assign(cfg, { geminiTranscribe: true, audioRetentionDays: 0 });
  await enter(page, campaignId);
  await page.click(['[data-tab]'], { tab: 'settings' }, (m) => /Kept until you delete it/.test(m));
  markup = page.body();
  assert.match(markup, /Kept until you delete it/);
  assert.match(markup, /Google \(Gemini\)/);
  assert.doesNotMatch(markup, /class="card good"/, 'and it is not the colour of all-is-well');
  assert.doesNotMatch(markup, /never sent anywhere else/);
});

test('an invitation to a table with no opt-out offers joining or not, never joining unrecorded', async (t) => {
  const { db, cfg, base, campaignId } = await world(t);
  db.setCampaignOptOut(campaignId, false);
  const token = invitedTo(db, campaignId);
  const cookie = cookieFor(db, cfg, RHI, 'rhi');
  const page = await render({ base, cookie, search: `?join=${token}` });
  await page.settle((m) => /data-thr-agree/.test(m));
  const markup = page.body();

  assert.match(markup, /Every voice at that table is written down/);
  assert.match(markup, /data-thr-agree="leave"/);
  assert.doesNotMatch(markup, /data-thr-agree="no"/);
  assert.match(markup, /no switch to turn it off later/);

  // The page not offering it is a courtesy. This is the rule.
  const sneaked = await fetch(`${base}/actions/invite/accept?token=sesame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ token, consent: false, name: 'Orrin' }),
  });
  assert.equal((await sneaked.json()).ok, false);
  assert.equal(db.getConsent(campaignId, RHI), null, 'and nothing was written down about them');

  await page.click(['[data-thr-agree]'], { thrAgree: 'leave' }, (m) => /goes on without you/.test(m));
  assert.equal(db.getConsent(campaignId, RHI), null, 'walking away sends nothing either');
  assert.doesNotMatch(page.body(), /first entry/);
});
