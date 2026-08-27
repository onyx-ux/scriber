import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildStatus, SECTIONS } from '../src/web/status.js';
import { scopeStatus } from '../src/web/scope.js';
import { buildViewer, OPERATOR } from '../src/web/viewer.js';

// What the snapshot costs, and who pays for it.
//
// viewer-scope.test.js asks what LEAVES the Pi. This asks what is BUILT in the
// first place, which used to be "all of it, for everybody". The page polls
// every five seconds, and the queue and the model bill are both real work to
// assemble before scopeStatus dropped them for anyone below dev.
//
// The access roster used to be the worst of them — a level resolved for every
// person the bot has ever seen, twice a campaign each — and it is no longer
// here at all. It moved to its own route when the page that reads it stopped
// being a tab on the dashboard, so nobody's poll pays for it now, the operator
// included. The test below holds that line.
//
// The two halves now read the same declaration, so the tests here are mostly
// about them being unable to disagree.

const DEV = 'owner-1';
const CREATOR = 'dm-1';
const PLAYER = 'player-1';

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-sections-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = { ownerUserId: DEV, statusToken: 'x', summaryProvider: 'gemini', scheduleTimeZone: 'UTC' };

  const campaignId = db.createCampaign('guild-1', 'Cipher', CREATOR);
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: PLAYER, displayName: 'Saf', startMs: 0, endMs: 1, text: 'hello' },
  ]);

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    db,
    cfg,
    campaignId,
    viewer: (userId) => buildViewer({ db, cfg, userId, guildsOwned: [] }),
    owner: () => buildViewer({ db, cfg, userId: 'server-owner', guildsOwned: ['guild-1'] }),
  };
}

// A db that remembers what was asked of it, so a test can say "this poll did
// not go looking for the queue" rather than only "the queue is not in the
// answer".
function counting(db) {
  const calls = {};
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls[prop] = (calls[prop] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  });
  return { proxy, calls };
}

const snapshot = (db, cfg, viewer) => buildStatus({ db, cfg, activeSessions: new Map(), viewer });

// ==========================================================================
// the declaration is the whole agreement
// ==========================================================================

test('every declared section names a capability a viewer can actually hold', async (t) => {
  const { viewer } = await world(t);
  const capabilities = Object.keys(viewer(DEV).can);

  for (const [name, capability] of Object.entries(SECTIONS)) {
    assert.ok(capabilities.includes(capability), `${name} rides behind "${capability}", which is not a capability`);
  }
});

test('a section is built for exactly the levels that are allowed to read it', async (t) => {
  const { db, cfg, viewer, owner } = await world(t);

  const people = { dev: viewer(DEV), owner: owner(), creator: viewer(CREATOR), player: viewer(PLAYER) };

  for (const [level, who] of Object.entries(people)) {
    const status = snapshot(db, cfg, who);
    for (const [name, capability] of Object.entries(SECTIONS)) {
      assert.equal(
        name in status,
        Boolean(who.can[capability]),
        `${level} ${who.can[capability] ? 'should' : 'should not'} have ${name} built`
      );
    }
  }
});

// The point of the whole candidate: not merely withheld, never assembled.
test('a player\'s poll does not pay to build the machinery it will not be sent', async (t) => {
  const { db, cfg, viewer } = await world(t);
  const { proxy, calls } = counting(db);

  snapshot(proxy, cfg, viewer(PLAYER));

  assert.equal(calls.listPipeline ?? 0, 0, 'the queue was not read');
  assert.equal(calls.modelUsageToday ?? 0, 0, 'the model bill was not totted up');
  assert.ok((calls.campaignOverview ?? 0) > 0, 'but the campaigns still were — that is the dashboard');
});

test('the operator console still pays for all of it, because it reads all of it', async (t) => {
  const { db, cfg } = await world(t);
  const { proxy, calls } = counting(db);

  const status = snapshot(proxy, cfg, OPERATOR);

  assert.ok((calls.listPipeline ?? 0) > 0);
  for (const name of Object.keys(SECTIONS)) assert.ok(name in status, `${name} is missing for the operator`);
});

// The roster is the most expensive question this server answers and the least
// often asked. It left /status when the gatehouse became its own page; nobody
// polling twelve times a minute should be rebuilding it, the owner least of
// all, because the owner is the one whose poll used to.
test("nobody's poll builds the access roster any more, not even the owner's", async (t) => {
  const { db, cfg, viewer } = await world(t);

  for (const who of [OPERATOR, viewer(DEV), viewer(PLAYER)]) {
    const { proxy, calls } = counting(db);
    const status = snapshot(proxy, cfg, who);

    assert.equal(calls.listKnownPeople ?? 0, 0, 'the roster was assembled by a poll');
    assert.ok(!('access' in status), 'the roster rode out on /status');
  }
});

// A caller with no viewer is the bot asking itself what is going on — a test,
// the queue worker, the operator's own console. None of those arrived over the
// network, and every path that did passes a viewer.
test('no viewer means build everything, exactly as before', async (t) => {
  const { db, cfg } = await world(t);
  const status = buildStatus({ db, cfg, activeSessions: new Map() });

  for (const name of Object.keys(SECTIONS)) assert.ok(name in status, `${name} is missing`);
});

// ==========================================================================
// what everybody gets regardless
// ==========================================================================

// A dashboard that will not say whether the bot is online is not a dashboard,
// and a player is entitled to know the machine is broken — that is why last
// night has not appeared.
test('the unconditional sections survive the narrowest viewer', async (t) => {
  const { db, cfg, viewer } = await world(t);
  const status = snapshot(db, cfg, viewer(PLAYER));

  for (const name of ['generatedAt', 'bot', 'campaigns', 'recording', 'health', 'actionsEnabled']) {
    assert.ok(name in status, `${name} should never be gated`);
    assert.ok(!(name in SECTIONS), `${name} must not be declared gated`);
  }
});

// Campaigns are cut to the viewer's own tables rather than withheld, so the
// build must hand over all of them for scopeStatus to filter.
test('the campaign list is filtered by the cut, not by the build', async (t) => {
  const { db, cfg, campaignId, viewer } = await world(t);
  const stranger = buildViewer({ db, cfg, userId: 'nobody-at-all' });

  assert.ok(snapshot(db, cfg, stranger).campaigns.length > 0, 'built for everyone');
  assert.equal(
    scopeStatus(snapshot(db, cfg, stranger), stranger).campaigns.length,
    0,
    'and cut to nothing for somebody with no table'
  );
  assert.deepEqual(
    scopeStatus(snapshot(db, cfg, viewer(PLAYER)), viewer(PLAYER)).campaigns.map((c) => c.id),
    [campaignId]
  );
});

// ==========================================================================
// the failure direction that matters
// ==========================================================================

// Adding a field to the snapshot and forgetting to declare it must not leak.
// The cut is a list of what goes IN, so an undeclared section is dropped.
test('a section nobody declared never reaches anyone below dev', async (t) => {
  const { db, cfg, viewer } = await world(t);
  const status = snapshot(db, cfg, viewer(PLAYER));
  status.somethingAddedLater = { secret: 'the API key, say' };

  const scoped = scopeStatus(status, viewer(PLAYER));
  assert.equal('somethingAddedLater' in scoped, false, 'an undeclared section is not sent');
});

// And the cut still runs even though the build already withheld it — the same
// belt-and-braces the auth sweep gets. A section that somehow arrived built for
// a viewer who may not read it is still dropped on the way out.
test('the cut drops a section the build should never have made', async (t) => {
  const { db, cfg, viewer } = await world(t);
  const status = snapshot(db, cfg, viewer(PLAYER));
  status.access = { people: [{ userId: DEV }] };
  status.models = { today: { tokens: 1_000_000 } };

  const scoped = scopeStatus(status, viewer(PLAYER));
  assert.equal('access' in scoped, false);
  assert.equal('models' in scoped, false);
});
