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

async function world(t) {
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
    db, cfg, activeSessions: new Map(),
    client: {
      user: { tag: 'Quill#0233' },
      guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'The Cellar', ownerId: OWNER }]]) },
    },
    discord: {
      findKnownMember: async () => null,
      sendCode: async () => ({ ok: true }),
      findPeople: async () => ({ ok: true, people: [] }),
      invite: async () => ({ ok: true, message: 'asked' }),
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
async function render({ base, cookie }) {
  const html = await readFile(PAGE, 'utf8');
  const scripts = await pageScripts(html, 'dashboard');

  const panels = {};
  const listeners = {};
  const copied = [];
  const el = (id) => (panels[id] ??= {
    id, _html: '', className: '', textContent: '', dataset: {},
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
    location: { search: '' },
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    confirm: () => true,
    setTimeout, clearTimeout,
    // The page's own polling would keep firing under the test runner.
    setInterval: () => 0,
    // The page re-measures its chrome on resize. Nothing here ever resizes;
    // this exists so registering the handler is not a TypeError.
    addEventListener: (type, fn) => { listeners[type] = fn; },
    scrollY: 0,
    document: {
      getElementById: el,
      addEventListener: (type, fn) => { listeners[type] = fn; },
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
    await listeners.click({ target: node });
    await settle(until);
  };

  await settle((html_) => html_.length > 500);
  return { body, click, settle, copied };
}

// Every element opened is closed. A template that throws part-way through
// leaves unbalanced markup, which is the shape most render bugs take.
function balanced(markup) {
  const opens = (markup.match(/<(?!\/)([a-z][a-z0-9]*)\b[^>]*?(?<!\/)>/g) ?? [])
    .filter((tag) => !/^<(br|img|input|hr|meta|link|path|svg\b.*\/)/.test(tag));
  const closes = markup.match(/<\/[a-z][a-z0-9]*>/g) ?? [];
  return { opens: opens.length, closes: closes.length, ok: opens.length === closes.length };
}

const cookieFor = (db, cfg, userId, username) =>
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
// there is none here — but which doors it draws, because a square is a
// promise that a place exists and can be got to.
test('the desk is the first screen, and holds a door per place', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /Where would you like to start\?/);
  assert.match(markup, /class="leaf/, 'the squares are drawn');
  assert.match(markup, /Cipher/, 'the table you last played has its own square');
  assert.match(markup, /data-screen="campaigns"/, 'and the whole ledger is one of them');
  assert.match(markup, /href="\/gatehouse\/"/, 'the operator can get to the guest list');
  assert.doesNotMatch(markup, /data-import/, 'the campaign column is not on this screen');
});

// Every square is a door somebody may walk through, so a viewer must not be
// drawn one that would refuse them.
test('a player is offered no machinery on the desk', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });
  const markup = page.body();

  assert.ok(balanced(markup).ok);
  assert.match(markup, /class="leaf/);
  assert.match(markup, /Cipher/, 'their own table is still theirs to open');
  assert.doesNotMatch(markup, /data-screen="models"/);
  assert.doesNotMatch(markup, /data-screen="servers"/);
  assert.doesNotMatch(markup, /gatehouse/);
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

  // And following it lands on that entry rather than merely selecting it.
  await page.click(['[data-entry]'], { entry: 'npcs:wren halloway' },
                   (m) => /notary clerk/.test(m));
  assert.match(page.body(), /Wren Halloway/);
  assert.match(page.body(), /First met in\s+Session 1/, 'and the entry says which night, by number');
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
