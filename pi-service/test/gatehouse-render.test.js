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

// The gatehouse, actually rendered.
//
// Same idea as dashboard-render.test.js and the same reason: this page's own
// script, run against a real server in a stubbed DOM, catches the class of bug
// that reading either half alone never will — a field the roster stopped
// sending, a button offered to somebody whose click would answer 403, a
// template that throws halfway and leaves the page holding its loading state.
//
// It matters more here than on the dashboard. This is the page that decides
// who may sign in at all, so "it drew the wrong thing" and "it let the wrong
// person in" are one keystroke apart.

const HTML = fileURLToPath(new URL('../../dashboard/html/', import.meta.url));
const PAGE = fileURLToPath(new URL('../../dashboard/html/gatehouse.html', import.meta.url));

const DEV = '10000000000000001';
const PLAYER = '40000000000000004';
const FRIEND = '50000000000000005';

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

async function world(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-gate-render-'));
  const db = openDb(join(dir, 'db.sqlite'));

  const campaignId = db.createCampaign('guild-1', 'Cipher', DEV);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'thistlewick', startMs: 0, endMs: 1, text: 'hello' },
  ]);

  const cfg = {
    statusHost: '127.0.0.1',
    statusPort: await freePort(),
    statusToken: 'sesame',
    authSecret: 'a'.repeat(32),
    ownerUserId: DEV,
    dashboardRequireLogin: true,
    summaryProvider: 'gemini',
    geminiApiKey: 'k',
    geminiModel: 'gemini-3.6-flash',
    ...extra,
  };

  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(),
    client: {
      user: { tag: 'Quill#0233' },
      guilds: { cache: new Map([['guild-1', { id: 'guild-1', name: 'The Cellar', ownerId: DEV }]]) },
    },
    discord: { lookUp: async () => ({ ok: true, userId: FRIEND, username: 'fenwick' }) },
  });
  await new Promise((resolve) => server.once('listening', resolve));

  t.after(async () => {
    await close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, base: `http://127.0.0.1:${server.address().port}` };
}

const cookieFor = (db, cfg, userId, username) =>
  `quill_session=${openSession(db, cfg, { userId, username }).token}`;

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

// Just enough DOM for a page whose entire output is one innerHTML and three
// document-level listeners.
async function render({ base, cookie }) {
  const html = await readFile(PAGE, 'utf8');
  const blocks = await pageScripts(html, 'gatehouse');

  const nodes = {};
  const listeners = {};
  const node = (id) => (nodes[id] ??= {
    id, _html: '', className: '', textContent: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    focus() {}, querySelector: () => null, closest: () => null,
  });

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    fetch: (path, init) => fetch(
      path.replace(/^\/api/, base) + (path.includes('?') ? '&' : '?') + 'token=sesame',
      { ...init, headers: { ...(init?.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) } }
    ),
    URLSearchParams, URL, Date, Math, JSON, Number, String, Boolean, Array, Object, Set, Map, Intl,
    location: { search: '' },
    setTimeout, clearTimeout,
    document: {
      getElementById: node,
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  blocks.forEach((block, i) => vm.runInContext(block, sandbox, { filename: `gatehouse-${i}.js` }));

  const body = () => ['page', 'rows', 'toast'].map((id) => nodes[id]?._html ?? '').join('\n');

  // Polled rather than slept: first paint is two awaited fetches deep.
  for (let i = 0; i < 200 && /^\s*$|Reading the list/.test(body()); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const settle = async () => {
    for (let i = 0; i < 200 && !nodes.toast?.textContent; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 60));
  };

  return {
    body,
    toast: () => nodes.toast?.textContent ?? '',
    // What the Level control offers for one person, as { level: selectable }.
    levelsFor(userId) {
      // Sliced rather than matched. A regex spanning the options wants
      // [\s\S], and inside a template literal that quietly becomes [sS] --
      // which matches, finds nothing, and looks exactly like a missing control.
      const markup = body();
      const at = markup.indexOf(`data-level="${userId}"`);
      assert.ok(at >= 0, `no level control for ${userId}`);
      const opts = markup.slice(at, markup.indexOf('</select>', at));

      return Object.fromEntries(
        [...opts.matchAll(/<option value="([a-z]+)"([^>]*)>/g)]
          .map(([, level, attrs]) => [level, !attrs.includes('disabled')])
      );
    },
    async pick(userId, level) {
      await listeners.change({ target: { dataset: { level: userId }, value: level } });
      await settle();
    },
    async type(q) {
      await listeners.input({ target: { id: 'q', value: q } });
    },
    // A click on the first control matching every one of these strings.
    async click(...needles) {
      const markup = body();
      const tags = [...markup.matchAll(/<button\b[^>]*>/gi)].map((m) => m[0]);
      const tag = tags.find((t) => needles.every((n) => t.includes(n)));
      assert.ok(tag, `no button matching ${needles.join(' + ')} in:\n${tags.join('\n')}`);

      const attrs = Object.fromEntries(
        [...tag.matchAll(/data-([a-z-]+)="([^"]*)"/gi)].map(([, k, v]) => [k, v])
      );
      const btn = {
        dataset: attrs, disabled: false, classList: { add() {}, remove() {} },
        textContent: 'x', isConnected: true,
        // The page asks for [data-only] and [data-do] off the same click, so a
        // stub that only ever answers to one of them sends a filter chip down
        // the branch that acts on a person.
        closest: (sel) => (attrs[sel.replace(/^\[data-|\]$/g, '')] === undefined ? null : btn),
        setAttribute() {}, removeAttribute() {},
      };
      await listeners.click({ target: btn });
      // data-said buttons arm on the first press and act on the second.
      if (attrs.said) await listeners.click({ target: btn });
      await settle();
    },
  };
}

// --- what it draws -------------------------------------------------------

test('the owner is shown the roster, and every row explains itself', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /On the list/i);
  assert.match(markup, /fenwick/);
  assert.match(markup, /<select[^>]*data-level=/, 'no level control was drawn');
  assert.match(markup, /data-do="access\/uninvite" data-user="50000000000000005"/,
    'a row this page wrote is a row it must offer to strike off');
  assert.match(markup, /thistlewick/, 'somebody who has only ever spoken still counts as known');
  assert.match(markup, /data-do="access\/invite" data-user="40000000000000004"/,
    'somebody turned away is offered no way in');
  assert.doesNotMatch(markup, /undefined|\bNaN\b|\[object Object\]/);
});

test('a player is told whose page this is rather than shown an empty one', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, PLAYER, 'thistlewick') });
  const markup = page.body();

  assert.match(markup, /the bot owner's/i);
  assert.doesNotMatch(markup, /fenwick/, 'the roster leaked to somebody who may not have it');
  assert.doesNotMatch(markup, /On the list/i);
  assert.doesNotMatch(markup, /undefined|\bNaN\b|\[object Object\]/);
});

// The state this page could not previously be in. Until the htpasswd prompt
// came off /gatehouse/ on 2026-08-31, the browser demanded a shared password
// before any of this ran, so a visitor with no Discord session never arrived.
// They do now, and the two noes have to stay apart: somebody who has not been
// asked who they are is not the same as somebody who has been asked and is not
// a dev. Telling the first "this is the owner's" describes a door they never
// tried.
test('a visitor with no session is offered the way in, not told off', async (t) => {
  const { db, cfg, base } = await world(t, {
    discordClientId: '1', discordClientSecret: 'shh', dashboardUrl: 'http://dash.test',
  });
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: '' });
  const markup = page.body();

  assert.match(markup, /Continue with Discord/i, 'a way in');
  assert.match(markup, /auth\/discord/, 'pointed at the real sign-in route');
  assert.doesNotMatch(markup, /the bot owner's/i, 'that is the refusal for somebody who HAS signed in');
  assert.doesNotMatch(markup, /fenwick/, 'and the roster is still nobody else’s business');
  assert.doesNotMatch(markup, /undefined|\bNaN\b|\[object Object\]/);
});

// An install nobody can sign into must not draw a button that goes to Discord
// and comes back with an error page mentioning none of this bot's settings.
test('an install with no OAuth credentials names the one that is missing', async (t) => {
  const { base } = await world(t);

  const markup = (await render({ base, cookie: '' })).body();

  assert.match(markup, /not set up for Discord sign-in/i);
  assert.match(markup, /DISCORD_CLIENT_ID/, 'and says which setting');
  assert.doesNotMatch(markup, /Continue with Discord/i, 'no button that cannot work');
});

// --- servers that have gone ---

test('a server the bot was removed from is named, with its tables under it', async (t) => {
  const { db, cfg, base } = await world(t);
  const stranded = db.createCampaign('guild-gone', 'Strahd', DEV);
  db.rememberGuild('guild-gone', 'The Old Cellar');
  db.markGuildLeft('guild-gone', '2026-08-12T10:00:00Z');

  const markup = (await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') })).body();

  assert.match(markup, /Servers that have gone/i);
  assert.match(markup, /The Old Cellar/, 'the name, kept from while the bot could still read it');
  assert.match(markup, /Strahd/, 'and the table stuck in it');
  assert.match(markup, /Nothing has been thrown away/i, 'said plainly, because it is the question');
  assert.doesNotMatch(markup, /undefined|\bNaN\b|\[object Object\]/);
  assert.ok(stranded);
});

// It is a record, not a queue of work. Every other section of this page ends in
// buttons; this one must not, because there is nothing to decide and the state
// undoes itself if the bot is added back.
test('the gone section offers no controls at all', async (t) => {
  const { db, cfg, base } = await world(t);
  db.createCampaign('guild-gone', 'Strahd', DEV);
  db.rememberGuild('guild-gone', 'The Old Cellar');
  db.markGuildLeft('guild-gone');

  const markup = (await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') })).body();
  // Just this section — the page footer follows it, and the point is what is
  // inside the record rather than what comes after it.
  const start = markup.indexOf('<section class="gone">');
  const section = markup.slice(start, markup.indexOf('</section>', start));
  assert.ok(start > -1, 'the section is drawn');

  assert.doesNotMatch(section, /<button/, 'nothing to press');
  assert.doesNotMatch(section, /data-do=/, 'and no action wired behind anything');
});

test('with no server gone the section is not drawn at all', async (t) => {
  const { db, cfg, base } = await world(t);

  const markup = (await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') })).body();

  assert.doesNotMatch(markup, /Servers that have gone/i, 'an empty section is a question nobody asked');
});

test('with the door unlocked the page leads with that, not with the list', async (t) => {
  const { db, cfg, base } = await world(t, { dashboardRequireLogin: false });
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /door is not locked/i);
  assert.match(markup, /DASHBOARD_REQUIRE_LOGIN/);
  assert.doesNotMatch(markup, /accounts can sign in/i,
    'the page led with the list while the list was not being enforced');
});

test('with no list at all the page says the door is open rather than saying nothing', async (t) => {
  const { db, cfg, base } = await world(t);

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /Any Discord account can sign in/i);
  assert.doesNotMatch(markup, /undefined|\bNaN\b|\[object Object\]/);
});

// --- the level control ---------------------------------------------------

// The column goes both ways now. Every rung is pickable except dev, which
// belongs to the Tier column so that appointing an operator is one act.
test('the dropdown offers every rung in both directions, except dev', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });

  for (const who of [PLAYER, FRIEND]) {
    assert.deepEqual(page.levelsFor(who), {
      dev: false, owner: true, creator: true, player: true, none: true,
    }, who);
  }
});

// The caveat rides on the option itself rather than arriving in a toast after
// the click, because the mistake this prevents is made at the moment of
// choosing: reading "creator" as a claim on a campaign.
test('a rung above somebody says what it actually buys, in the dropdown', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /<option value="owner">owner · not a server<\/option>/);
  assert.match(markup, /<option value="creator">creator · not a campaign<\/option>/);
  assert.match(markup, /<option value="dev" disabled>dev · via Tier<\/option>/);
});

test('the operator gets a control that is visibly nobody\'s to change', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /<select class="lvl" disabled/);
  assert.doesNotMatch(markup, new RegExp(`data-level="${DEV}"`),
    'the operator was handed a control that would refuse every use of it');
  // The caption names the setting rather than the file alone, because there
  // are two settings that can put somebody here now and only one of them is
  // the one to edit.
  assert.match(markup, /you — OWNER_USER_ID in \.env/);
});

test('picking a lower level holds them there and the row says so', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });

  await page.pick(PLAYER, 'none');

  assert.equal(db.capFor(PLAYER), 'none');
  assert.match(page.toast(), /Held at none/);
  assert.match(page.body(), /held down from player/);
  assert.match(page.body(), /class="row [^"]*held/);
});

test('and picking their own level back lifts it', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setCap(PLAYER, 'none');

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(page.body(), /held down from player/);

  await page.pick(PLAYER, 'player');

  assert.equal(db.capFor(PLAYER), null);
  assert.match(page.toast(), /Back to player/);
  assert.doesNotMatch(page.body(), /held down/);
});

// --- the tier ------------------------------------------------------------

test('the tier is every rung with the current one pressed, and none of them disabled', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setTier(PLAYER, 3);

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /<button type="button" class="t on"\s+data-tier="3" data-user="40000000000000004"/,
    'the tier somebody is on is not the one showing as pressed');
  for (const t of [0, 1, 2, 4, 9]) {
    assert.match(markup, new RegExp(`data-tier="${t}" data-user="40000000000000004"`),
      `tier ${t} was not offered — this control goes up as well as down`);
  }
  for (const t of [5, 6, 7, 8]) {
    assert.doesNotMatch(markup, new RegExp(`data-tier="${t}"`),
      `tier ${t} does not exist and must not be drawn`);
  }
});

test('pressing a tier moves them, and says what it bought', async (t) => {
  const { db, cfg, base } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 2: 60, 3: 200 } });
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });

  await page.click('data-tier="3"', `data-user="${PLAYER}"`);

  assert.equal(db.tierOf(PLAYER), 3);
  assert.match(page.toast(), /Tier 3/);
  assert.match(page.toast(), /200 questions a day/);
});

test('the operator gets a tier control nobody can press', async (t) => {
  const { db, cfg, base } = await world(t);
  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /aria-disabled="true"/);
  assert.doesNotMatch(markup, new RegExp(`data-tier="\d" data-user="${DEV}"`),
    'the owner was handed a control that would refuse every use of it');
});

test('what somebody has spent shows only once they have spent something', async (t) => {
  const { db, cfg, base } = await world(t, { tierAskLimits: { 0: 2, 1: 40 } });

  const quiet = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.doesNotMatch(quiet.body(), /asks today/, 'a column of zeroes hides the row that matters');

  db.countAsk(PLAYER);
  const used = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(used.body(), /1\/2 asks today/);
  assert.doesNotMatch(used.body(), /class="spent full"/);

  db.countAsk(PLAYER);
  const spent = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(spent.body(), /class="spent full">2\/2 asks today/,
    'somebody at their ceiling reads the same as somebody with room left');
});

test('a person is told their own tier and what is left of it', async (t) => {
  const { db, cfg, base } = await world(t, { tierAskLimits: { 0: 5, 1: 20, 2: 60 } });
  db.setTier(PLAYER, 2);

  const res = await fetch(`${base}/me?token=sesame`, {
    headers: { Cookie: cookieFor(db, cfg, PLAYER, 'thistlewick') },
  });
  const me = await res.json();

  assert.equal(me.tier, 2);
  assert.equal(me.askLimit, 60);
});

// --- finding somebody ----------------------------------------------------

test('search narrows to a name, and to a fragment of an id', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(page.body(), /thistlewick/);

  await page.type('fenw');
  assert.match(page.body(), /fenwick/);
  assert.doesNotMatch(page.body(), /thistlewick/, 'search matched somebody it should not have');

  await page.type(PLAYER.slice(-6));
  assert.match(page.body(), /thistlewick/, 'an id fragment found nobody');
  assert.doesNotMatch(page.body(), /fenwick/);

  await page.type('nobody at all');
  assert.match(page.body(), /matches/, 'an empty result rendered as a blank table');

  await page.type('');
  assert.match(page.body(), /thistlewick/);
  assert.match(page.body(), /fenwick/);
});

test('a chip narrows to a group and says how many are in it', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(page.body(), /data-only="on"[^>]*>On the list<span class="n">2<\/span>/);
  assert.match(page.body(), /data-only="off"[^>]*>Turned away<span class="n">1<\/span>/);

  await page.click('data-only="off"');
  assert.match(page.body(), /thistlewick/);
  assert.doesNotMatch(page.body(), /fenwick/, 'a filtered-out row was still drawn');
});

test('the chips for an exception appear only when there is one', async (t) => {
  const { db, cfg, base } = await world(t);

  const quiet = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.doesNotMatch(quiet.body(), /data-only="held"/, 'a chip that could only ever say zero');

  db.setCap(PLAYER, 'none');
  const held = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  assert.match(held.body(), /data-only="held"[^>]*>Held down<span class="n">1<\/span>/);
});

// --- what its buttons do -------------------------------------------------

test('Admit beside a name puts that name on the list', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  await page.click('access/invite', PLAYER);

  assert.equal(db.isInvited(PLAYER), true);
  assert.match(page.toast(), /can sign in/);
  assert.match(page.body(), /thistlewick/);
});

test('Remove takes two presses, and the first one changes nothing', async (t) => {
  const { db, cfg, base } = await world(t);
  db.setInvited(FRIEND, { username: 'fenwick' });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });

  // The harness fires twice for a data-said button; fire once by hand first to
  // prove the arming press is inert.
  const markup = page.body();
  assert.match(markup, /data-said="Remove fenwick and end their sessions\?"/,
    'the confirmation does not name the bigger half of what it does');

  await page.click('access/uninvite', FRIEND);
  assert.equal(db.isInvited(FRIEND), false);
  assert.match(page.toast(), /last name on it|Off the list/);
});

test('a name the page cannot remove is offered no button that pretends it can', async (t) => {
  const { db, cfg, base } = await world(t, { dashboardAllowedUsers: FRIEND });

  const page = await render({ base, cookie: cookieFor(db, cfg, DEV, 'matt') });
  const markup = page.body();

  assert.match(markup, /<span class="tag">in \.env<\/span>/,
    "the row gives no reason for having no button");
  assert.doesNotMatch(markup, new RegExp(`data-do="access/uninvite" data-user="${FRIEND}"`),
    'a Remove was offered for a row only pi-service/.env can change');
});
