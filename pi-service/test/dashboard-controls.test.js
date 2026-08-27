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

// Does every button do something?
//
// dashboard-render.test.js asks what the page DRAWS. This asks what it DOES:
// every control the page renders is clicked, and has to produce an observable
// effect — a request, a redraw, or a confirmation. A control that produces none
// of those is wired to nothing, which is invisible until somebody clicks it and
// nothing happens.
//
// Two things make this trustworthy rather than theatre. Every control is
// clicked from a KNOWN screen, because a navigation partway down the list
// otherwise leaves later clicks firing on the wrong screen — which looks
// exactly like a dead button. And the controls that legitimately do nothing
// (clicking the tab you are already on) are re-clicked from the opposite state,
// where they must do something.

const HTML = fileURLToPath(new URL('../../dashboard/html/', import.meta.url));
const PAGE = fileURLToPath(new URL('../../dashboard/html/index.html', import.meta.url));

const DEV = '10000000000000001';
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

// A campaign with something in every state the page can draw, so no control is
// missing merely because the data that triggers it is absent.
async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-controls-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const campaignId = db.createCampaign('guild-1', 'Cipher', DEV);
  db.setConsent(campaignId, PLAYER, true);
  db.addCorrection(campaignId, 'Kaylen', 'Kaelen');

  const posted = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(posted, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'Kaelen opens the ledger.' },
    { userId: DEV, displayName: 'kez', startMs: 2, endMs: 3, text: 'The clerk looks up.' },
  ]);
  db.endMeeting(posted, '2026-08-01T22:00:00Z');
  db.setSummary(posted, {
    tldr: 'They talked their way into the lower registry.',
    scenes: [{ title: 'The queue', points: ['The writ passed.'] }],
    npcsIntroduced: ['Wren Halloway: the clerk'], locationsVisited: ['The Vaults'],
    partyDecisions: [], unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
  });
  db.setMeetingStatus(posted, 'done');

  // One awaiting approval, so the approve and park buttons exist.
  const parked = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-08T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(
    parked,
    [{ userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'waiting on you' }],
    { requireApproval: true }
  );
  db.endMeeting(parked, '2026-08-08T22:00:00Z');

  // One failed and empty, so discard exists.
  const broken = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-07-19T19:00:00Z', audioDir: '/tmp',
  });
  db.endMeeting(broken, '2026-07-19T19:00:04Z');
  db.setMeetingStatus(broken, 'transcribe_failed');

  db.recordModelUsage({ provider: 'gemini', model: 'gemini-3.6-flash', role: 'summary', totalTokens: 1400 });

  // Somebody signed in, so the account sheet has a session to show and
  // its sign-out button is rendered rather than skipped.
  openSession(db, { statusToken: 'sesame' }, { userId: PLAYER, username: 'saf' });

  // One deleted campaign inside its window, so the rail draws a restore button
  // for the walk to press. Without it the control simply is not rendered, and
  // "not rendered" is indistinguishable from "tested" in a walk like this.
  const deleted = db.createCampaign('guild-1', 'Strahd', DEV);
  db.archiveCampaign(deleted, DEV);

  // And one ticket waiting on a decision, so the review dialog and its two
  // buttons are rendered for the walk to press.
  const waiting = db.createCampaign('guild-1', 'Ashfall', PLAYER);
  db.archiveCampaign(waiting, PLAYER);
  const requestId = db.createRestoreRequest({
    campaignId: waiting,
    requestedBy: PLAYER,
    requesterName: 'saf',
    reason: 'We still play every week.',
    whyDeleted: 'A row about scheduling.',
    takingOwnership: 'yes',
  });


  const cfg = {
    statusHost: '127.0.0.1', statusPort: await freePort(), statusToken: 'sesame',
    ownerUserId: DEV, dashboardRequireLogin: false, dataDir: dir,
    scheduleTimeZone: 'Europe/London', transcribeWindowStartHour: 8, transcribeWindowEndHour: 16,
    transcribeWeekdaysOnly: true, transcribeRequireApproval: true,
    summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-3.6-flash',
    modelDailyTokenBudget: 100_000, askDailyLimit: 20,
    whisperServerUrl: `http://127.0.0.1:${await freePort()}/`,
  };

  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(),
    client: {
      user: { tag: 'Quill#0233' },
      guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'The Cellar', ownerId: 'someone' }]]) },
    },
    discord: {
      findKnownMember: async () => null,
      sendCode: async () => ({ ok: true }),
      findPeople: async () => ({ ok: true, people: [
        { userId: '999888777666555444', username: 'newbie', displayName: 'Newbie', avatar: null },
      ] }),
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

  return { db, cfg, campaignId, parked, requestId, base: `http://127.0.0.1:${server.address().port}` };
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

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

// Enough of a selector engine for the handful of selectors the page uses.
function matches(node, sel) {
  for (const part of sel.split(',').map((s) => s.trim())) {
    const tag = /^([a-z]+)/.exec(part)?.[1];
    if (tag && node.tag !== tag) continue;
    const cls = /^\.([a-z-]+)/.exec(part)?.[1];
    if (cls && !node.classes.includes(cls)) continue;

    const bare = part.replace(/:not\([^)]*\)/g, '');
    const needs = [...bare.matchAll(/\[data-([a-z-]+)\]/g)].map((m) => camel(m[1]));
    const notData = [...part.matchAll(/:not\(\[data-([a-z-]+)\]\)/g)].map((m) => camel(m[1]));
    const notTag = [...part.matchAll(/:not\(([a-z]+)\)/g)].map((m) => m[1]);

    if (!needs.every((k) => node.dataset[k] !== undefined)) continue;
    if (notData.some((k) => node.dataset[k] !== undefined)) continue;
    if (notTag.includes(node.tag)) continue;
    return true;
  }
  return false;
}

// What a person would plausibly type, per field name.
const TYPED = {
  wrong: 'Kaylen', right: 'Kaelen', name: 'Safriel', query: 'newbie',
  url: 'https://example.com/session.m4a', speaker: 'The Table',
  model: 'gemini-3.1-flash-lite', code: '123456', guildId: 'guild-1',
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

// `signedInAs` seeds the jar with a session cookie the caller already holds,
// which is the only way this driver can be on the far side of signing in: the
// walk back from Discord is a cross-origin navigation, and a sandbox with no
// browser in it cannot follow one. The walk itself is proved over a real socket
// in auth-flow.test.js; what belongs here is what the PAGE does either side.
async function driver({ base, typed = {}, signedInAs = null }) {
  const html = await readFile(PAGE, 'utf8');
  const scripts = await pageScripts(html, 'dashboard');

  const requests = [];
  const posts = [];
  const confirms = [];
  const panels = {};
  const listeners = {};
  let cookie = signedInAs;

  // Panels the page owns and rewrites; everything else that gets an id is a
  // field living INSIDE one of them. Also what body() reads back.
  // 'sheet' included: the account panel hangs off the top bar and is drawn
  // into its own element. Leaving it out made everything in it invisible to
  // this file — the walk below would have called its controls dead, and the
  // sign-in tests could not see what the account says it can see.
  const PANELS = ['top', 'rail-list', 'rail-nav', 'rail-foot', 'banner', 'screen', 'modal', 'sheet', 'toast'];

  // Rewriting a panel throws its children away, exactly as a browser does.
  //
  // This stub used to keep every element it had ever handed out, for ever, so
  // a field the page had just re-rendered still answered with what the test
  // typed into the old one. That is not what a browser does, and the gap hid a
  // real bug: the sign-in handler painted before reading its input, so what
  // somebody typed was destroyed and the page posted an empty name. Every test
  // here passed while signing in was impossible in an actual browser.
  //
  // A field that survives a repaint does so because the page put its value
  // back into the markup, so that is what gets read back here.
  //
  // Read across EVERY panel rather than only the one being rewritten. One paint
  // writes several panels in turn, and a field lives in exactly one of them —
  // so judging "is this field still on the page" by the modal's markup declared
  // the sign-in name gone every single time the modal was drawn, which is every
  // paint. The field held what the page had put in it right up until the last
  // panel of the same paint wiped it, and signing in a second time (back, retype
  // the name, ask again) posted an empty name.
  const everything = () => PANELS.map((id) => panels[id]?._html ?? '').join('\n');

  const reseed = () => {
    const markup = everything();
    for (const [id, node] of Object.entries(panels)) {
      if (PANELS.includes(id)) continue;
      if (!markup.includes(`id="${id}"`)) { node.value = ''; continue; }
      const declared = new RegExp(`id="${id}"[^>]*?\\svalue="([^"]*)"`).exec(markup);
      node.value = declared ? declared[1] : '';
    }
  };

  const el = (id) => (panels[id] ??= {
    id, _html: '', className: '', _text: '', dataset: {}, value: typed[id] ?? (id === 'people-q' ? 'newbie' : ''),
    set innerHTML(v) { this._html = v; if (PANELS.includes(this.id)) reseed(); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    focus() {}, setSelectionRange() {}, closest: () => null, querySelector: () => null,
    // measureChrome() asks the split how far down the page it starts. Nothing
    // here has a layout, so a zero box is the honest answer.
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  });

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // Cookies are carried, because sign-in is a cookie and a driver that drops
    // it can never observe anything past the code screen.
    fetch: async (path, init) => {
      const p = String(path);
      requests.push(p);
      if ((init?.method ?? 'GET') === 'POST') posts.push(p);
      const res = await fetch(
        p.replace(/^\/api/, base) + (p.includes('?') ? '&' : '?') + 'token=sesame',
        { ...init, headers: { ...(init?.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) } }
      );
      const set = res.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
      return res;
    },
    URLSearchParams, URL, Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map, Intl,
    // The page reads a form's fields through FormData, so it has to be iterable
    // or every submit tests an empty request rather than the real one.
    FormData: class {
      constructor(form) { this.fields = form?.__fields ?? []; }
      [Symbol.iterator]() { return this.fields[Symbol.iterator](); }
    },
    location: { search: '' },
    navigator: { clipboard: { writeText: async () => {} } },
    // A real one, empty, as a browser on its first visit would have.
    //
    // The theme switch is the only control that reads its own state back out of
    // storage: themeMode() asks localStorage which of the three is on, and
    // renders aria-pressed from the answer. Without storage that read throws,
    // themeMode() falls back to 'auto' for ever, and all three buttons paint
    // identically no matter which you press — which reads exactly like three
    // controls wired to nothing.
    localStorage: (() => {
      const kept = new Map();
      return {
        getItem: (k) => (kept.has(k) ? kept.get(k) : null),
        setItem: (k, v) => kept.set(k, String(v)),
        removeItem: (k) => kept.delete(k),
        clear: () => kept.clear(),
      };
    })(),
    confirm: () => { confirms.push(1); return true; },
    setTimeout, clearTimeout, setInterval: () => 0,
    // The page re-measures its chrome on resize. Nothing here resizes; this is
    // so registering the handler is not a TypeError.
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    scrollY: 0,
    document: {
      getElementById: el,
      // Every listener, not just the last: the page registers three separate
      // submit handlers, and keeping one meant two of them never ran.
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      // A real class list rather than a bag of no-ops.
      //
      // renderScreen dresses the body for the sign-in gate with
      // toggle('gate-open', …) and renderSheet then ASKS for that class back
      // when deciding whether the account sheet may open. No-ops answer "no" to
      // every contains(), so the two fall out of step and the sheet draws over
      // a gate it should be hidden behind — a bug this file is meant to catch
      // rather than to imitate.
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
      // try/catch that guards localStorage — so without this, clicking it
      // throws rather than being recorded as a control that did something.
      documentElement: {
        setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
        // measureChrome writes --above here. Read before written, so the style
        // map has to remember what it was given.
        style: (() => {
          const props = new Map();
          return {
            setProperty: (name, value) => props.set(name, value),
            getPropertyValue: (name) => props.get(name) ?? '',
          };
        })(),
      },
      get title() { return this._t; }, set title(v) { this._t = v; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  scripts.forEach((block, i) => vm.runInContext(block, sandbox, { filename: `dashboard-${i}.js` }));

  // The toast speaks through textContent rather than innerHTML, so a control
  // whose only effect is a message would otherwise look wired to nothing.
  const body = () =>
    PANELS.map((id) => `${panels[id]?._html ?? ''}${panels[id]?._text ?? ''}`).join('\n');

  const settle = async (until, ms = 4000) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (until(body())) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await settle((h) => h.length > 800);

  function controls() {
    const markup = body();
    const found = [];
    const re = /<(button|form|input|div|span)\b([^>]*\bdata-[a-z-]+[^>]*)>/g;
    let m;
    while ((m = re.exec(markup))) {
      const [, tag, attrs] = m;
      const dataset = {};
      for (const a of attrs.matchAll(/data-([a-z-]+)(?:="([^"]*)")?/g)) dataset[camel(a[1])] = a[2] ?? '';

      // data-key is not a control. It is how dash/morph.js recognises a row
      // across two renders so the node — and with it the caret, the scroll
      // offset and any transition mid-flight — survives the redraw. Clicking
      // one is meant to do nothing, and every keyed row also carries the
      // control that DOES do something, which this walk still finds.
      delete dataset.key;
      if (Object.keys(dataset).length === 0) continue;

      let fields = [];
      if (tag === 'form') {
        const rest = markup.slice(m.index);
        const block = rest.slice(0, rest.indexOf('</form>') + 7);
        // camelCase too — a field called guildId is still a field, and a
        // lowercase-only pattern silently submits the form without it.
        fields = [...block.matchAll(/name="([a-zA-Z]+)"/g)].map((f) => [f[1], TYPED[f[1]] ?? 'x']);
      }

      found.push({
        tag, dataset, fields,
        classes: (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean),
        type: /type="button"/.test(attrs) ? 'button' : 'submit',
      });
    }
    return found;
  }

  async function fire(node, kind = node.tag === 'form' ? 'submit' : 'click') {
    const target = {
      tag: node.tag, classes: node.classes ?? ['btn'], dataset: node.dataset,
      type: node.type ?? 'button', __fields: node.fields ?? [], disabled: false,
      closest(sel) { return matches(this, sel) ? this : null; },
      querySelector: () => null,
      get textContent() { return 'x'; }, set textContent(v) {},
    };
    const before = { html: body(), reqs: requests.length, confirms: confirms.length };
    for (const fn of listeners[kind] ?? []) await fn({ target, preventDefault() {} });
    // A click can start a fetch, so asking immediately answers the wrong question.
    await new Promise((r) => setTimeout(r, 250));
    return {
      changed: body() !== before.html,
      requested: requests.length - before.reqs,
      confirmed: confirms.length - before.confirms,
    };
  }

  // `settle` is handed out as well, for the few places where a fixed wait is
  // not enough. fire() gives a click 250ms to land, which covers one request;
  // signing in is three in a row — verify, then the status and campaign reads
  // that discover who you now are — and on a loaded machine that overruns,
  // leaving the test reading the gate it was still looking at.
  return { body, controls, fire, settle, posts, requests, input: el };
}

const nav = (dataset, classes = ['btn']) => ({ tag: 'button', classes, dataset, type: 'button' });

// Attributes that ride on a data-act button as payload rather than being a
// control in their own right.
const PAYLOAD = ['confirm', 'job', 'meeting', 'user', 'wrong', 'provider',
                 'queue', 'paused', 'mode', 'action', 'role', 'campaign'];

test('every control the dashboard renders does something', async (t) => {
  const { campaignId, parked, requestId, base } = await world(t);
  const page = await driver({ base });

  // The campaign is selected by id rather than by opening whatever screen
  // happens to be current. Creating a campaign lands you in the new empty
  // one, so a reset that only said "campaign screen" would quietly start
  // testing the wrong campaign from that point on.
  const CAMPAIGN = nav({ campaign: String(campaignId) }, ['camp']);
  const stops = [
    ['campaign / notes', [CAMPAIGN, nav({ tab: 'notes' }, ['tab'])]],
    ['campaign / the table', [CAMPAIGN, nav({ tab: 'table' }, ['tab'])]],
    ['campaign / corrections', [CAMPAIGN, nav({ tab: 'corrections' }, ['tab'])]],
    ['campaign / settings', [CAMPAIGN, nav({ tab: 'settings' }, ['tab'])]],
    ['transcript reader', [CAMPAIGN, nav({ transcript: String(parked) })]],
    ['models', [nav({ screen: 'models' }, ['navlink'])]],
    ['servers', [nav({ screen: 'servers' }, ['navlink'])]],
    ['import dialog', [CAMPAIGN, nav({ import: '' })]],
    // Both dialogs get their own stop, because the controls inside one only
    // exist while it is open and are invisible to the walk otherwise.
    ['new campaign dialog', [CAMPAIGN, nav({ newCampaign: '' })]],
    ['restore review dialog', [CAMPAIGN, nav({ review: String(requestId) })]],
  ];

  const reset = async (steps) => { for (const step of steps) await page.fire(step); };
  const seen = new Set();
  const dead = [];
  let total = 0;

  for (const [screen, steps] of stops) {
    await reset(steps);
    const here = page.controls().filter((c) => {
      const keys = Object.keys(c.dataset);
      if (keys.every((k) => k === 'seg' || k === 'backdrop')) return false;
      return c.dataset.act !== undefined || keys.some((k) => !PAYLOAD.includes(k));
    });

    for (const c of here) {
      const key = JSON.stringify([c.tag, c.dataset]);
      if (seen.has(key)) continue;
      seen.add(key);

      await reset(steps);
      const r = await page.fire(c);
      total += 1;

      const label = Object.entries(c.dataset).map(([k, v]) => (v ? `${k}=${v}` : k)).join(' ');
      if (!(r.changed || r.requested || r.confirmed)) dead.push(`${screen}: ${label}`);
    }
  }

  assert.ok(total > 35, `expected the whole surface, exercised only ${total}`);

  // The controls that legitimately do nothing are the ones asking for the state
  // the page is already in. Each is re-clicked from the opposite state, where it
  // must move — which is what separates "quiet" from "wired to nothing".
  const quiet = [
    ['session already open',
     [CAMPAIGN, nav({ tab: 'notes' }, ['tab']), { tag: 'button', classes: ['sess'], dataset: { session: String(parked) }, type: 'button' }],
     { tag: 'button', classes: ['sess'], dataset: { session: String(parked - 1) }, type: 'button' }],

    ['the tab already open',
     [CAMPAIGN, nav({ tab: 'table' }, ['tab'])],
     nav({ tab: 'notes' }, ['tab'])],

    ['closing a dialog that is open',
     [CAMPAIGN, nav({ import: '' })],
     nav({ closeModal: '' })],

    ['clearing a speaker filter that is set',
     [CAMPAIGN, nav({ transcript: String(parked) }), nav({ speaker: String(40000000000000004n) }, ['chip'])],
     nav({ speaker: '' }, ['chip'])],

    // Both halves of the shelf slider are in the markup at once — one of them
    // parked off-screen — so the walk finds the back button even while the
    // chooser is already showing, where asking for the chooser again is
    // correctly a no-op. Opening a shelf first is the state it has to move from.
    ['going back from an open shelf',
     [CAMPAIGN, nav({ shelf: 'npcs' }, ['shelf-row'])],
     nav({ shelfBack: '' }, ['shelf-back'])],

    // Auto is where the page starts, so the walk clicks it while it is already
    // on. From dark it has somewhere to go.
    ['choosing the theme already chosen',
     [CAMPAIGN, nav({ themeSet: 'dark' }, ['seg'])],
     nav({ themeSet: 'auto' }, ['seg'])],
  ];

  for (const [what, steps, control] of quiet) {
    await reset(steps);
    const r = await page.fire(control);
    assert.ok(r.changed || r.requested, `${what}: does nothing from either state`);
  }

  assert.deepEqual(dead.filter((d) => !/session=|tab=|closeModal|speaker$|shelfBack|themeSet=auto/.test(d)), [],
    `controls wired to nothing:\n${dead.join('\n')}`);
});

// Discord's OAuth API, as far as the server can tell, and the walk a browser
// makes through it. Signing in is two redirects now rather than two forms, and
// a sandbox with no browser in it cannot follow a cross-origin navigation — so
// the walk happens over the socket here and its result is handed to the driver.
function fakeOAuth(user) {
  return async (url) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok-1' }) };
    if (url.endsWith('/users/@me')) return { ok: true, json: async () => user };
    return { ok: true, json: async () => ({}) };
  };
}

async function walkOAuth(base) {
  const go = (path, cookie) =>
    fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=sesame`, {
      redirect: 'manual',
      headers: cookie ? { Cookie: cookie } : {},
    });
  const cookieIn = (res, name) =>
    res.headers.getSetCookie().map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean) ?? null;

  const started = await go('/auth/discord');
  const state = cookieIn(started, 'quill_signin');
  const back = await go(`/auth/callback?code=c&state=${encodeURIComponent(state)}`, `quill_signin=${state}`);

  const token = cookieIn(back, 'quill_session');
  assert.ok(token, 'the walk through Discord ended without a session');
  return `quill_session=${token}`;
}

// The sign-in card never renders on the walk above, because that server has
// login switched off. It is what a stranger sees first, and it is now a
// sentence and one link: everything between pressing it and coming back happens
// on Discord. So what belongs here is what the PAGE does either side of that —
// that the gate really hides the app, that the link points at the route which
// actually redirects, and that a browser arriving back holding a session is
// drawn as the person that account earns rather than as the operator.
test('the sign-in card offers one way in, and the far side of it works', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-signin-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const campaignId = db.createCampaign('guild-1', 'Cipher', DEV);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [{ userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'hi' }]);
  db.setSummary(meeting, { tldr: 'They talked their way in.', scenes: [] });
  db.setMeetingStatus(meeting, 'done');

  const cfg = {
    statusHost: '127.0.0.1', statusPort: await freePort(), statusToken: 'sesame',
    ownerUserId: DEV, dashboardRequireLogin: true, dataDir: dir,
    discordClientId: 'app-1', discordClientSecret: 'shh', dashboardUrl: 'http://dash.test',
    scheduleTimeZone: 'Europe/London', transcribeWindowStartHour: 8, transcribeWindowEndHour: 16,
    transcribeWeekdaysOnly: true, transcribeRequireApproval: true,
    summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'g',
  };
  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(), client: null,
    fetchImpl: fakeOAuth({ id: PLAYER, username: 'saf' }),
    discord: {
      findPeople: async () => ({ ok: true, people: [] }),
      invite: async () => ({ ok: true, message: 'x' }),
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    // Awaited: the database must outlive the last request still being answered.
    await close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  const gate = await driver({ base });
  assert.match(gate.body(), /Sign in to Quill/);
  assert.doesNotMatch(gate.body(), /Cipher/, 'the app must not render behind the card');
  assert.match(gate.body(), /Continue with Discord/);
  assert.match(gate.body(), /href="\/api\/auth\/discord"/,
    'the one control on the card must point at the route that redirects to Discord');

  const cookie = await walkOAuth(base);

  const back = await driver({ base, signedInAs: cookie });
  await back.settle((h) => /Cipher/.test(h));
  assert.doesNotMatch(back.body(), /Sign in to Quill/, 'a session gets past the gate');

  // What the account is allowed to see lives in the account sheet rather than
  // on the screen behind it, so this opens the sheet to read it. After signing
  // in you are the person the ACCOUNT earns, not the operator you were before.
  await back.fire(nav({ sheet: 'account' }));
  assert.match(back.body(), /the games you play in/, 'the level is derived from the account');

  const out = await back.fire(nav({ logout: '' }));
  assert.ok(out.requested, 'signing out does nothing');
  await back.settle((h) => /Sign in to Quill/.test(h));
  assert.match(back.body(), /Sign in to Quill/, 'signing out returns to the card');
});

// Signing in while sign-in is still OPTIONAL.
//
// The card used to render only when DASHBOARD_REQUIRE_LOGIN was on, which made
// the one safe order for turning that on — sign in first, so you cannot lock
// yourself out of your own Pi — impossible to follow through the interface.
test('you can sign in before sign-in is required', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-optional-signin-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const campaignId = db.createCampaign('guild-1', 'Cipher', 'someone-else');
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'I paid the fee.' },
  ]);

  const cfg = {
    statusHost: '127.0.0.1', statusPort: await freePort(), statusToken: 'sesame',
    // The whole point: OFF, as it is on a fresh install.
    ownerUserId: DEV, dashboardRequireLogin: false, dataDir: dir,
    discordClientId: 'app-1', discordClientSecret: 'shh', dashboardUrl: 'http://dash.test',
    scheduleTimeZone: 'Europe/London', transcribeWindowStartHour: 8, transcribeWindowEndHour: 16,
    transcribeWeekdaysOnly: true, transcribeRequireApproval: true,
    summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-3.6-flash',
    whisperServerUrl: `http://127.0.0.1:${await freePort()}/`,
  };

  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(),
    client: { user: { tag: 'Quill#0233' }, guilds: { cache: new Map() } },
    fetchImpl: fakeOAuth({ id: PLAYER, username: 'saf' }),
    discord: {
      findPeople: async () => ({ ok: true, people: [] }),
      invite: async () => ({ ok: true, message: 'x' }),
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));

  t.after(async () => {
    // Awaited: the database must outlive the last request still being answered.
    await close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await driver({ base });

  // The operator's view, with a way in rather than no way in. The offer lives
  // in the account sheet — one click off the top bar rather than on the screen
  // itself — so this opens it the way a person would before reading it.
  await page.fire(nav({ sheet: 'account' }));
  assert.match(page.body(), /Sign in as yourself/, 'the offer is there while it is still optional');

  const opened = await page.fire({ tag: 'button', classes: ['btn'], dataset: { signin: '' }, type: 'button' });
  assert.ok(opened.changed);
  assert.match(page.body(), /Sign in to Quill/, 'and it opens the card');
  assert.match(page.body(), /Continue with Discord/);

  // And there is a way back out of it, because at this point signing in is
  // still optional and the operator may simply have been looking.
  const notNow = await page.fire(nav({ signinCancel: '' }, ['gate-btn', 'plain']));
  assert.ok(notNow.changed, 'the way back to the operator view does nothing');

  const cookie = await walkOAuth(base);

  // Signed in as a player, which is NARROWER than the operator they were
  // before — sign-in taking things away is the safe direction.
  const signedIn = await driver({ base, signedInAs: cookie });
  await signedIn.settle((h) => /Cipher/.test(h));
  await signedIn.fire(nav({ sheet: 'account' }));
  assert.match(signedIn.body(), /the games you play in/, 'signed in at the level the account earns');
  assert.doesNotMatch(signedIn.body(), /Sign in as yourself/, 'and the offer is gone');
});
