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
      tldr: 'They talked their way into the lower registry.',
      scenes: [{ title: 'The queue at the notary', points: ['The writ passed on the second reading.'] }],
      npcsIntroduced: ['Wren Halloway: the notary clerk'],
      locationsVisited: ['The Ashen Vaults'],
      partyDecisions: ['Leave the stone in the wall.'],
      unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
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
function pageScripts(html) {
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'no <script> found in the dashboard page');
  return blocks;
}

// Load the page's script into a sandbox with just enough DOM to run.
async function render({ base, cookie }) {
  const html = await readFile(PAGE, 'utf8');
  const scripts = pageScripts(html);

  const panels = {};
  const listeners = {};
  const el = (id) => (panels[id] ??= {
    id, _html: '', className: '', textContent: '', dataset: {},
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    focus() {}, querySelector() { return null; }, setSelectionRange() {}, closest: () => null,
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
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true,
    setTimeout, clearTimeout,
    // The page's own polling would keep firing under the test runner.
    setInterval: () => 0,
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
      // try/catch that guards localStorage.
      documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null },
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
  return { body, click, settle };
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

// --- it draws at all ---

test('the operator sees the app, with the machinery on it', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
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
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });

  for (const [matches, dataset] of [
    [['[data-tab]'], { tab: 'table' }],
    [['[data-tab]'], { tab: 'corrections' }],
    [['[data-tab]'], { tab: 'settings' }],
    [['[data-tab]'], { tab: 'notes' }],
    [['[data-screen]'], { screen: 'servers' }],
    [['[data-screen]'], { screen: 'access' }],
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
    const { db, cfg, base } = await world(t);
    const page = await render({ base, cookie: cookieFor(db, cfg, userId, username) });
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
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'saf') });

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
