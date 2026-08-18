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
    close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, parked, base: `http://127.0.0.1:${server.address().port}` };
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

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
  model: 'gemini-3.1-flash-lite', code: '123456',
};

async function driver({ base, typed = {} }) {
  const html = await readFile(PAGE, 'utf8');
  const source = /(?<=<script>)[\s\S]*(?=<\/script>)/.exec(html)[0];

  const requests = [];
  const posts = [];
  const confirms = [];
  const panels = {};
  const listeners = {};
  let cookie = null;

  const el = (id) => (panels[id] ??= {
    id, _html: '', className: '', _text: '', dataset: {}, value: typed[id] ?? (id === 'people-q' ? 'newbie' : ''),
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    focus() {}, setSelectionRange() {}, closest: () => null, querySelector: () => null,
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
    confirm: () => { confirms.push(1); return true; },
    setTimeout, clearTimeout, setInterval: () => 0,
    document: {
      getElementById: el,
      // Every listener, not just the last: the page registers three separate
      // submit handlers, and keeping one meant two of them never ran.
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      body: { classList: { add() {}, remove() {} } },
      activeElement: null,
      createElement: () => ({ click() {}, style: {} }),
      get title() { return this._t; }, set title(v) { this._t = v; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'dashboard.js' });

  const PANELS = ['top', 'rail-list', 'rail-nav', 'rail-foot', 'banner', 'screen', 'modal', 'toast'];
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

      let fields = [];
      if (tag === 'form') {
        const rest = markup.slice(m.index);
        const block = rest.slice(0, rest.indexOf('</form>') + 7);
        fields = [...block.matchAll(/name="([a-z]+)"/g)].map((f) => [f[1], TYPED[f[1]] ?? 'x']);
      }

      found.push({
        tag, dataset, fields,
        classes: (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean),
        type: /type="submit"/.test(attrs) ? 'submit' : 'button',
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

  return { body, controls, fire, posts, requests, input: el };
}

const nav = (dataset, classes = ['btn']) => ({ tag: 'button', classes, dataset, type: 'button' });

// Attributes that ride on a data-act button as payload rather than being a
// control in their own right.
const PAYLOAD = ['confirm', 'job', 'meeting', 'user', 'wrong', 'provider',
                 'queue', 'paused', 'mode', 'action', 'role', 'campaign'];

test('every control the dashboard renders does something', async (t) => {
  const { parked, base } = await world(t);
  const page = await driver({ base });

  const CAMPAIGN = nav({ screen: 'campaign' }, ['navlink']);
  const stops = [
    ['campaign / notes', [CAMPAIGN, nav({ tab: 'notes' }, ['tab'])]],
    ['campaign / the table', [CAMPAIGN, nav({ tab: 'table' }, ['tab'])]],
    ['campaign / corrections', [CAMPAIGN, nav({ tab: 'corrections' }, ['tab'])]],
    ['campaign / settings', [CAMPAIGN, nav({ tab: 'settings' }, ['tab'])]],
    ['transcript reader', [CAMPAIGN, nav({ transcript: String(parked) })]],
    ['models', [nav({ screen: 'models' }, ['navlink'])]],
    ['servers', [nav({ screen: 'servers' }, ['navlink'])]],
    ['access', [nav({ screen: 'access' }, ['navlink'])]],
    ['import dialog', [CAMPAIGN, nav({ import: '' })]],
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
  ];

  for (const [what, steps, control] of quiet) {
    await reset(steps);
    const r = await page.fire(control);
    assert.ok(r.changed || r.requested, `${what}: does nothing from either state`);
  }

  assert.deepEqual(dead.filter((d) => !/session=|tab=|closeModal|speaker$/.test(d)), [],
    `controls wired to nothing:\n${dead.join('\n')}`);
});

// The sign-in card never renders on the walk above, because that server has
// login switched off. Its four controls are the ones a stranger sees first.
test('the sign-in card works end to end', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-signin-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const campaignId = db.createCampaign('guild-1', 'Cipher', DEV);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [{ userId: PLAYER, displayName: 'saf', startMs: 0, endMs: 1, text: 'hi' }]);

  const sent = [];
  const cfg = {
    statusHost: '127.0.0.1', statusPort: await freePort(), statusToken: 'sesame',
    ownerUserId: DEV, dashboardRequireLogin: true, dataDir: dir,
    scheduleTimeZone: 'Europe/London', transcribeWindowStartHour: 8, transcribeWindowEndHour: 16,
    transcribeWeekdaysOnly: true, transcribeRequireApproval: true,
    summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'g',
  };
  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(), client: null,
    discord: {
      findKnownMember: async () => ({ userId: PLAYER, username: 'saf' }),
      sendCode: async ({ code }) => { sent.push(code); return { ok: true }; },
      findPeople: async () => ({ ok: true, people: [] }),
      invite: async () => ({ ok: true, message: 'x' }),
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // The sign-in handlers read their value off the input element rather than out
  // of FormData, so the driver seeds the elements themselves.
  const page = await driver({
    base: `http://127.0.0.1:${server.address().port}`,
    typed: { 'signin-name': 'saf' },
  });
  assert.match(page.body(), /Sign in to Quill/);
  assert.doesNotMatch(page.body(), /Cipher/, 'the app must not render behind the card');

  const asked = await page.fire({ tag: 'form', dataset: { signinRequest: '' }, fields: [] });
  assert.ok(asked.requested, 'asking for a code does nothing');
  assert.equal(sent.length, 1, 'no code was sent');

  const back = await page.fire(nav({ signinBack: '' }));
  assert.ok(back.changed, 'the back link does nothing');

  // Round trip: ask again, type the code the bot sent, and land signed in.
  await page.fire({ tag: 'form', dataset: { signinRequest: '' }, fields: [] });
  page.input('signin-code').value = sent.at(-1);

  const verified = await page.fire({ tag: 'form', dataset: { signinVerify: '' }, fields: [] });
  assert.ok(verified.requested, 'submitting the code does nothing');
  assert.match(page.body(), /the games you play in/, 'the level is derived from the account after signing in');

  const out = await page.fire(nav({ logout: '' }));
  assert.ok(out.requested, 'signing out does nothing');
  assert.match(page.body(), /Sign in to Quill/, 'signing out returns to the card');
});
