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
    return src ? readFile(join(HTML, src[1].replace(/^\//, '')), 'utf8') : inline;
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
  assert.match(markup, /data-act="pause"/, 'the pause switches are the owner\'s');
  assert.match(markup, /data-import/);
  assert.match(markup, /data-screen="models"/, 'the API bill is the owner\x27s to see');
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

// The user's own rule: no mention of which model wrote anything, below dev.
test('the health line names the machinery only for the operator', async (t) => {
  const { db, cfg, base } = await world(t);

  const dev = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(dev.body(), /whisper server/);

  const player = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  assert.match(player.body(), /writing up is/, 'they are still told whether it works');
  assert.doesNotMatch(player.body(), /whisper|gemini/i);
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

// The API bill, drawn. Its numbers are what this bot counted as it spent them,
// and the page has to say so rather than implying it read a meter.
test('the Models screen shows spend and never claims a remaining balance', async (t) => {
  const { db, cfg, base } = await world(t);
  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.6-flash', role: 'summary',
                        inputTokens: 900, outputTokens: 300, totalTokens: 1400 });
  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.1-flash-lite', role: 'ask',
                        inputTokens: 40, outputTokens: 8, totalTokens: 50 });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await page.click(['[data-screen]'], { screen: 'models' }, (m) => /tokens today/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /1,450 tokens today/);
  assert.match(markup, /gemini-3\.6-flash/, 'the summary model is named');
  assert.match(markup, /gemini-3\.1-flash-lite/, 'and the cheap one it uses for questions');
  assert.match(markup, /Counted by this bot/, 'the honest framing survives to the page');
  assert.doesNotMatch(markup, /remaining balance.*\d/, 'no invented quota figure');
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
test('a player is offered no machinery on the desk', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  const markup = page.body();

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
  assert.match(markup, /That text — not your voice/, 'what leaves the machine is stated, not glossed');
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
  await page.settle((m) => /id="thr-token"/.test(m));
  const markup = page.body();

  assert.ok(balanced(markup).ok);
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
