import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { registerCommandHandlers, activeSessions } from '../src/commands/index.js';
import { dashboardLink, dashboardHome, deskInvitation, joinLink } from '../src/delivery/dashboard-link.js';
import { dashboardPointer } from '../src/delivery/approval-notify.js';

// Telling somebody where the desk is.
//
// Two things have to be true before a link is worth sending, and they are
// different questions that were being conflated into one:
//
//   * the address has to be the DESK. The root is the landing page — the two
//     were split so a stranger and an operator meet different things — so
//     `DASHBOARD_URL` bare is the marketing copy, not the tool.
//   * the person has to be somebody the door will open for. Once
//     DASHBOARD_ALLOWED_USERS is set it is a guest list, and an account off it
//     can be handed the address all day and still be refused at sign-in.
//
// The second is why this is tested through the real dispatcher as well as
// directly: a welcome message that sends a new DM to a door that refuses them
// is worse than one that says nothing.

const DM = 'dm-1';
const GUILD = 'G';
const URL_BASE = 'https://quill.example.org';

async function harness(t, cfgExtra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-desk-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = {
    ownerUserId: 'owner', dataDir: dir, obsidianExportDir: join(dir, 'vault'),
    summaryProvider: 'gemini', geminiApiKey: 'k', geminiModel: 'gemini-3.6-flash',
    driveSyncEnabled: false, transcribeRequireApproval: false, summaryRequireApproval: false,
    ...cfgExtra,
  };

  let dispatch = null;
  registerCommandHandlers({ on: (e, fn) => { if (e === 'interactionCreate') dispatch = fn; } }, db, cfg);

  t.after(async () => {
    activeSessions.clear();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, dispatch };
}

function created(dispatch, user = DM, name = 'Cipher') {
  const said = { content: null };
  const take = (p) => { said.content = typeof p === 'string' ? p : p?.content ?? ''; return Promise.resolve({}); };
  return dispatch({
    said, commandName: 'campaign', guildId: GUILD, channelId: 'c',
    user: { id: user, username: user }, member: null, client: {},
    isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true,
    deferred: false, replied: false,
    options: {
      getSubcommand: () => 'create',
      getString: (k) => (k === 'name' ? name : null),
      getInteger: () => null, getBoolean: () => null, getUser: () => null,
      getChannel: () => null, getAttachment: () => null, getFocused: () => '',
    },
    reply: take, editReply: take, followUp: take, deferReply: () => Promise.resolve(),
  }).then(() => said.content);
}

// --- the address ---

test('the link is the desk, not the landing page it shares a host with', () => {
  assert.equal(dashboardLink({ dashboardUrl: URL_BASE }), `${URL_BASE}/app/`);
  assert.equal(dashboardLink({ dashboardUrl: `${URL_BASE}/` }), `${URL_BASE}/app/`);
  assert.equal(
    dashboardLink({ dashboardUrl: `${URL_BASE}/somewhere/else` }),
    `${URL_BASE}/app/`,
    'the path is ours to decide, whatever DASHBOARD_URL happens to carry'
  );
});

// A relative path is a fine redirect for a browser already on the site and is
// not a link at all in a Discord message, so the two callers get two answers.
test('an unusable DASHBOARD_URL is null for a message and relative for a redirect', () => {
  for (const dashboardUrl of [null, undefined, '', 'not a url']) {
    assert.equal(dashboardLink({ dashboardUrl }), null, `${dashboardUrl} is not an address`);
    assert.equal(dashboardHome({ dashboardUrl }), '/app/');
  }
});

test('the approval DM points at the desk rather than the marketing page', () => {
  const said = dashboardPointer({ dashboardUrl: URL_BASE });
  assert.match(said, new RegExp(`${URL_BASE}/app/`));
  assert.doesNotMatch(said, new RegExp(`${URL_BASE}\\s`), 'the bare host is where the sales pitch lives');
});

test('and says how to configure one rather than printing a broken address', () => {
  const said = dashboardPointer({ dashboardUrl: 'not a url' });
  assert.match(said, /DASHBOARD_URL/);
  assert.doesNotMatch(said, /\/app\//, 'a relative path in a DM is characters, not a link');
});

// --- the guest list ---

test('a new campaign comes with an invitation to the desk', async (t) => {
  const h = await harness(t, { dashboardUrl: URL_BASE });
  const said = await created(h.dispatch);

  assert.match(said, /The desk/);
  assert.match(said, /Sign in with Discord/, 'and says how to get in, since there is no password to hand out');
  assert.match(said, /\*\*Cipher\*\* is already on it/, 'and that there is nothing to set up');
  assert.ok(said.length <= 2000, `Discord caps a message at 2000 characters; this is ${said.length}`);
});

// The reader of this one has, by definition, never signed in — they created
// their first campaign a minute ago. They still get the bare address, because
// /app/ IS the sign-on page: DASHBOARD_REQUIRE_LOGIN puts `loginRequired` in
// /me and the page opens Continue-with-Discord as a full-page takeover for
// anybody arriving without a session. A fragment asking for the card it is
// already showing would be decoration on a URL, which is a thing people copy,
// paste and eventually have to explain.
test('the link is the bare address, since that is the sign-on page', async (t) => {
  const h = await harness(t, { dashboardUrl: URL_BASE });
  const said = await created(h.dispatch);

  assert.match(said, new RegExp(`${URL_BASE}/app/`));
  assert.doesNotMatch(said, /#/, 'no fragment on an address somebody is going to paste');
});

test('nothing is said about a dashboard that has no address', async (t) => {
  const h = await harness(t, {});
  const said = await created(h.dispatch);

  assert.doesNotMatch(said, /The desk/);
  assert.match(said, /whole ritual/, 'the rest of the welcome is unaffected');
});

// The one that matters. A guest list turns the desk into a door with a
// bouncer, and handing somebody the address does not get them past it.
test('somebody the guest list will refuse is not sent to the door', async (t) => {
  const h = await harness(t, { dashboardUrl: URL_BASE, dashboardAllowedUsers: 'somebody-else' });
  const said = await created(h.dispatch);

  assert.doesNotMatch(said, /The desk/);
  assert.doesNotMatch(said, /app\//, 'not even the address');
});

test('and somebody on it is', async (t) => {
  const h = await harness(t, { dashboardUrl: URL_BASE, dashboardAllowedUsers: `somebody-else,${DM}` });
  const said = await created(h.dispatch);

  assert.match(said, /The desk/);
});

// The other half of the list lives in the database, added from the gatehouse
// seconds before somebody tries to sign in. maySignIn unions the two, and this
// checks the invitation follows it rather than reading only the env half.
test('an invitation added from the gatehouse counts as much as the env list', async (t) => {
  const h = await harness(t, { dashboardUrl: URL_BASE, dashboardAllowedUsers: 'somebody-else' });

  assert.equal(
    deskInvitation({ cfg: h.cfg, db: h.db, userId: DM, campaignName: 'Cipher' }),
    '',
    'refused while only the env half names somebody else'
  );

  h.db.setInvited(DM, { setBy: 'owner' });

  assert.match(
    deskInvitation({ cfg: h.cfg, db: h.db, userId: DM, campaignName: 'Cipher' }),
    /The desk/,
    'the two halves of the guest list are one list'
  );
});

// The operator can never be locked out by a list — see maySignIn — so the
// welcome must not be the one place that forgets it.
test('the operator is always on their own guest list', async (t) => {
  const h = await harness(t, { dashboardUrl: URL_BASE, dashboardAllowedUsers: 'somebody-else' });
  const said = await created(h.dispatch, 'owner', 'Housebound');

  assert.match(said, /The desk/);
});


// --- the address one table hands to its own players ---
//
// Pasted into a chat window by a person, which is a harder job than the desk
// link has: it has to survive being copied, and it has to work on an install
// nobody has reconfigured.

test('an invitation is the desk with a token on it, not a path of its own', () => {
  const url = joinLink({ dashboardUrl: URL_BASE }, 'brass-key-9');

  assert.equal(url, `${URL_BASE}/app/?join=brass-key-9`);
  // /app/ and not /join/<token>, deliberately: nginx serves the dashboard from
  // an exact `location = /app/`, which a query string does not disturb. A path
  // of its own would need a new location block on every box running the bot
  // before a single link opened. See joinLink.
  assert.match(url, /\/app\/\?/);
});

test('an install with no address makes no link rather than half of one', () => {
  assert.equal(joinLink({}, 'brass-key-9'), null);
  assert.equal(joinLink({ dashboardUrl: 'not a url' }, 'brass-key-9'), null);
  assert.equal(joinLink({ dashboardUrl: URL_BASE }, ''), null, 'and no token is no link');
});

// A DASHBOARD_URL that already carries a path or a query is somebody's reverse
// proxy, and the token has to survive it.
test('a token is added to an address rather than replacing what is there', () => {
  assert.equal(
    joinLink({ dashboardUrl: 'https://pi.example.org/quill/?theme=dark' }, 'k'),
    'https://pi.example.org/app/?join=k',
    'the desk is always /app/ on that host — see dashboardLink'
  );
});
