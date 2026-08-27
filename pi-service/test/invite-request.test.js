import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { handleAuthRoute } from '../src/web/auth-routes.js';
import { askToken, askedBy, ASK_COOKIE } from '../src/web/auth.js';
import { runAction } from '../src/web/actions.js';
import { OPERATOR } from '../src/web/viewer.js';
import { accessRoster } from '../src/web/access.js';

// Asking to be let in.
//
// Quill is pre-alpha and the guest list is short, so most people who sign in
// are turned away. The screen they land on offers a button that puts their
// name in a queue — which is a genuinely awkward thing to build, because the
// person pressing it has NO SESSION and by design never will until somebody
// admits them. web/auth-routes checks the guest list before it writes any row.
//
// So the button carries its own credential: a short-lived signed note saying
// only "Discord confirmed this is user X, called Y", which can do exactly one
// thing. Most of this file is about that note, because a credential that grants
// nothing is still a credential and forging one would let anybody put any name
// in front of the operator.

const STRANGER = '80000000000000008';
const OWNER = '20000000000000002';

async function world(t, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-ask-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = {
    authSecret: 'a'.repeat(32),
    discordClientId: 'app-1',
    discordClientSecret: 'shh',
    dashboardUrl: 'http://pihouse.local:8095',
    ownerUserId: OWNER,
    ...over,
  };
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return { db, cfg };
}

const ask = ({ db, cfg, cookie = null }) =>
  handleAuthRoute({
    pathname: '/auth/ask',
    method: 'POST',
    url: new URL('http://pi/auth/ask'),
    body: {},
    req: { headers: cookie ? { cookie } : {} },
    db,
    cfg,
    secure: false,
  });

const noteFor = (cfg, userId, username) => `${ASK_COOKIE}=${askToken(cfg, { userId, username })}`;

// ---------------------------------------------------------------------------
// The note itself
// ---------------------------------------------------------------------------

test('a note says who Discord vouched for, and nothing else', async (t) => {
  const { cfg } = await world(t);
  const token = askToken(cfg, { userId: STRANGER, username: 'thistlewick' });

  assert.deepEqual(askedBy(cfg, token), { userId: STRANGER, username: 'thistlewick' });
});

test('a name with a dot in it survives the trip', async (t) => {
  const { cfg } = await world(t);
  // The fields are dot-separated and Discord allows dots, commas and non-ASCII
  // in a username. Base64url is what stops a name from becoming a field.
  for (const name of ['a.b.c', 'ünïcodé', 'has,comma', '..', '']) {
    const back = askedBy(cfg, askToken(cfg, { userId: STRANGER, username: name }));
    assert.equal(back?.userId, STRANGER, name);
    assert.equal(back?.username, name || null, name);
  }
});

test('a forged note is nobody', async (t) => {
  const { cfg } = await world(t);
  const real = askToken(cfg, { userId: STRANGER, username: 'thistlewick' });
  const [id, name, expires] = real.split('.');

  // Every part swapped in turn, each with the original signature.
  assert.equal(askedBy(cfg, `${OWNER}.${name}.${expires}.deadbeef`), null, 'a made-up signature');
  assert.equal(askedBy(cfg, `${OWNER}.${name}.${expires}.${real.split('.')[3]}`), null, 'a swapped id');
  assert.equal(askedBy(cfg, `${id}.${name}.${Number(expires) + 1e9}.${real.split('.')[3]}`), null, 'a stretched expiry');
  assert.equal(askedBy(cfg, real.slice(0, -1)), null, 'one character short');
  assert.equal(askedBy(cfg, ''), null);
  assert.equal(askedBy(cfg, null), null);
  assert.equal(askedBy(cfg, 'not.even.the.shape'), null);
});

test('a note signed with a different secret is nobody', async (t) => {
  const { cfg } = await world(t);
  const other = { ...cfg, authSecret: 'b'.repeat(32) };

  assert.equal(askedBy(cfg, askToken(other, { userId: STRANGER, username: 'x' })), null);
});

test('a note goes stale after half an hour', async (t) => {
  const { cfg } = await world(t);
  const token = askToken(cfg, { userId: STRANGER, username: 'thistlewick' });

  assert.ok(askedBy(cfg, token, { now: Date.now() + 29 * 60 * 1000 }), 'still good at 29 minutes');
  assert.equal(askedBy(cfg, token, { now: Date.now() + 31 * 60 * 1000 }), null, 'and gone at 31');
});

test('with no secret configured there is no note to hand out', async (t) => {
  const { cfg } = await world(t, { authSecret: null, statusToken: null });

  assert.equal(askToken(cfg, { userId: STRANGER }), null);
  assert.equal(askedBy(cfg, 'anything'), null);
});

// ---------------------------------------------------------------------------
// Being turned away costs the database nothing
// ---------------------------------------------------------------------------

test('a refused sign-in writes no row at all', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  // Somebody reads the screen and closes the tab. That is the common case and
  // it should leave exactly what it left before this feature existed: nothing.
  assert.equal(db.listAccessRows().length, 0);
  assert.equal(db.countRequests(), 0);
});

test('pressing the button is what writes the row', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  const res = await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(db.countRequests(), 1);

  const [waiting] = db.listRequests();
  assert.equal(waiting.userId, STRANGER);
  assert.equal(waiting.username, 'thistlewick');
  assert.ok(waiting.requestedAt, 'no date was recorded');
});

test('no note, a forged note or a stale one writes nothing and says so', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  for (const cookie of [null, `${ASK_COOKIE}=forged`, `${ASK_COOKIE}=a.b.c.d`]) {
    const res = await ask({ db, cfg, cookie });
    assert.equal(res.status, 400, String(cookie));
    assert.match(res.payload.message, /stale/);
  }

  assert.equal(db.countRequests(), 0, 'a refused ask still put somebody in the queue');
});

// A queue sorted by impatience is not a queue.
test('asking twice does not move them up the queue', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });
  const first = db.listRequests()[0].requestedAt;

  await new Promise((r) => setTimeout(r, 1100));
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  assert.equal(db.countRequests(), 1, 'a second ask made a second row');
  assert.equal(db.listRequests()[0].requestedAt, first, 'the date was refreshed');
});

test('a name that changed between asks is updated', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'oldname') });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'newname') });

  assert.equal(db.listRequests()[0].username, 'newname');
});

test('somebody already on the list is told so rather than queued', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });
  db.setInvited(STRANGER, { username: 'thistlewick' });

  const res = await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  assert.equal(res.status, 200);
  assert.equal(res.payload.already, true);
  assert.equal(db.countRequests(), 0, 'an admitted person was put in the queue');
});

test('the note is spent whether it worked or not', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  const res = await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });
  assert.match([res.cookie].flat().join('; '), /quill_ask=;/, 'the note was left live');
});

// ---------------------------------------------------------------------------
// The queue, and answering it
// ---------------------------------------------------------------------------

const act = (db, cfg, name, body) =>
  runAction({ pathname: `/actions/${name}`, body, db, cfg, ctx: { viewer: OPERATOR } });

test('admitting somebody keeps the date they asked on', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });
  const asked = db.listRequests()[0].requestedAt;

  const res = await act(db, cfg, 'access/invite', { userId: STRANGER, username: 'thistlewick' });
  assert.equal(res.status, 200);

  assert.equal(db.countRequests(), 0, 'still in the queue after being let in');
  assert.equal(db.isInvited(STRANGER), true);
  // The only record of how long they waited. Erasing it on admission would
  // make the queue look like it had always been empty.
  assert.equal(db.requestFor(STRANGER)?.requestedAt, asked, 'the date they asked was thrown away');
});

test('dismissing clears the ask and leaves nothing behind', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  const res = await act(db, cfg, 'access/dismiss', { userId: STRANGER });

  assert.equal(res.status, 200);
  assert.equal(res.payload.cleared, true);
  assert.equal(db.countRequests(), 0);
  // Not a ban and not a note in a file: the row is gone entirely, because a
  // row saying nothing would put them on the page for ever.
  assert.equal(db.listAccessRows().length, 0, 'a dismissed ask left litter behind');
  assert.equal(db.isInvited(STRANGER), false);
});

test('somebody dismissed can ask again', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });
  await act(db, cfg, 'access/dismiss', { userId: STRANGER });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  assert.equal(db.countRequests(), 1, 'dismissing turned into a ban');
});

test('dismissing somebody who is not waiting is not an error', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });

  const res = await act(db, cfg, 'access/dismiss', { userId: STRANGER });
  assert.equal(res.status, 200);
  assert.equal(res.payload.cleared, false);
});

// A ceiling or a tier is written through tidyAccess, which deletes rows that
// say nothing. A pending ask is a row that says something.
test('setting a tier does not sweep away a pending ask', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  db.setTier(STRANGER, 2);
  db.setTier(STRANGER, null);
  db.setCap(STRANGER, null);

  assert.equal(db.countRequests(), 1, 'tidyAccess ate a request');
});

test('the gatehouse sees who is waiting', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });

  const roster = accessRoster({ db, cfg });
  const them = roster.people.find((p) => p.userId === STRANGER);

  assert.equal(roster.waiting, 1);
  assert.ok(them, 'somebody waiting was not on the page that answers them');
  assert.equal(them.waiting, true);
  assert.ok(them.requestedAt);
  assert.equal(them.invited, false);
});

test('once admitted they stop being a question', async (t) => {
  const { db, cfg } = await world(t, { dashboardAllowedUsers: OWNER });
  await ask({ db, cfg, cookie: noteFor(cfg, STRANGER, 'thistlewick') });
  await act(db, cfg, 'access/invite', { userId: STRANGER, username: 'thistlewick' });

  const roster = accessRoster({ db, cfg });
  const them = roster.people.find((p) => p.userId === STRANGER);

  assert.equal(roster.waiting, 0);
  assert.equal(them.waiting, false);
  assert.equal(them.invited, true);
  assert.ok(them.requestedAt, 'the date they asked should survive being let in');
});
