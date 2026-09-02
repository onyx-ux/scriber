import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  isRealDeparture, rememberVisibleGuilds, reconcileGuilds, installGuildPresence,
} from '../src/campaign/guild-presence.js';

// What happens to a table when its Discord goes.
//
// Before this existed the bot had no guildDelete handler at all, so a campaign
// whose server was deleted stayed in the list forever looking live — while
// every control on it was already broken. These tests hold two things: that it
// leaves the list, and that NOTHING is destroyed on the way out.

const DEV = '10000000000000001';

// The parts of discord.js this actually touches. A Map of guilds and an `on`,
// which is the whole surface — the module is separated from index.js precisely
// so this is all a test has to build.
function fakeClient(guilds = []) {
  const cache = new Map(guilds.map((g) => [g.id, g]));
  const handlers = new Map();
  return {
    guilds: { cache },
    on: (evt, fn) => handlers.set(evt, fn),
    emit: (evt, payload) => handlers.get(evt)?.(payload),
    // so a test can stage a removal the way Discord would
    drop: (id) => cache.delete(id),
    add: (g) => cache.set(g.id, g),
  };
}

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-guilds-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db };
}

const quiet = () => {};

// --- telling a removal from an outage ---

test('an unavailable guild is an outage, not a departure', () => {
  assert.equal(isRealDeparture({ id: 'g1', available: false }), false);
  assert.equal(isRealDeparture({ id: 'g1', available: true }), true);
  // discord.js omits `available` entirely on an ordinary removal.
  assert.equal(isRealDeparture({ id: 'g1' }), true);
  assert.equal(isRealDeparture(null), false);
});

// --- the catch-up pass ---

test('a campaign whose server is gone leaves the campaign list', async (t) => {
  const { db } = await world(t);
  const staying = db.createCampaign('g-live', 'Cipher', DEV);
  const going = db.createCampaign('g-gone', 'Strahd', DEV);

  const client = fakeClient([{ id: 'g-live', name: 'The Cellar' }]);
  rememberVisibleGuilds(db, client);
  const { marked } = reconcileGuilds(db, client, { log: quiet });

  assert.equal(marked, 1);
  assert.deepEqual(db.listCampaigns().map((c) => c.id), [staying], 'only the live one');
  assert.deepEqual(db.listStrandedCampaigns().map((c) => c.id), [going]);
});

test('nothing about the stranded campaign is destroyed', async (t) => {
  const { db } = await world(t);
  const id = db.createCampaign('g-gone', 'Strahd', DEV);
  const meeting = db.createMeeting({
    guildId: 'g-gone', campaignId: id, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: DEV, displayName: 'matt', startMs: 0, endMs: 1, text: 'hello' },
  ]);

  reconcileGuilds(db, fakeClient([{ id: 'g-other', name: 'Elsewhere' }]), { log: quiet });

  assert.equal(db.listCampaigns().length, 0, 'gone from the list');
  assert.equal(db.getCampaign(id), null, 'and gone from the ordinary lookup with it');

  // Hidden, not deleted. The see-through accessor is the same one the archive
  // uses, and it still finds everything.
  const still = db.getCampaignIncludingArchived(id);
  assert.ok(still, 'the row is still there');
  assert.equal(still.name, 'Strahd');
  assert.equal(still.archived_at, null, 'and it was never archived — nobody decided this');
  assert.equal(db.getMeeting(meeting).campaign_id, id, 'and so is its session');
});

// The install this was written for: the server went weeks ago, long before any
// of this code existed, so there is no guilds row to sweep and no event to
// replay. Driving the pass from the CAMPAIGNS is what finds it.
test('a server that went before any of this existed is still caught', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g-ancient', 'Old Table', DEV);

  assert.equal(db.listDepartedGuilds().length, 0, 'nothing recorded about it yet');
  reconcileGuilds(db, fakeClient([{ id: 'g-live', name: 'Here' }]), { log: quiet });

  assert.deepEqual(db.listDepartedGuilds().map((g) => g.guild_id), ['g-ancient']);
});

// Discord being unreachable at the wrong moment must not empty the install.
test('an empty guild cache marks nothing', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g-live', 'Cipher', DEV);

  const out = reconcileGuilds(db, fakeClient([]), { log: quiet });

  assert.equal(out.skipped, true);
  assert.equal(db.listCampaigns().length, 1, 'still there');
});

test('restarting does not move the date the server went', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g-gone', 'Strahd', DEV);
  const client = fakeClient([{ id: 'g-live', name: 'Here' }]);

  reconcileGuilds(db, client, { log: quiet });
  const first = db.listDepartedGuilds()[0].left_at;

  reconcileGuilds(db, client, { log: quiet });
  assert.equal(db.listDepartedGuilds()[0].left_at, first, 'the date is when it happened');
});

// --- the name, which is the thing that cannot be recovered later ---

test('the last known name survives the server going', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g-gone', 'Strahd', DEV);

  // Two servers, so that dropping one leaves a believable cache. Dropping the
  // only one is an outage as far as reconcileGuilds is concerned, and it
  // rightly refuses to act on it — see the empty-cache test above.
  const client = fakeClient([
    { id: 'g-gone', name: 'The Old Cellar' },
    { id: 'g-live', name: 'Still Here' },
  ]);
  rememberVisibleGuilds(db, client);

  client.drop('g-gone');
  reconcileGuilds(db, client, { log: quiet });

  assert.equal(db.listDepartedGuilds()[0].name, 'The Old Cellar',
               'a bot cannot read a server it is not in — this is the only chance to know');
});

// --- the events ---

test('being removed strands the table; being added back returns it', async (t) => {
  const { db } = await world(t);
  const id = db.createCampaign('g1', 'Cipher', DEV);
  const client = fakeClient([{ id: 'g1', name: 'The Cellar' }]);
  rememberVisibleGuilds(db, client);
  installGuildPresence(db, client, { log: quiet });

  client.emit('guildDelete', { id: 'g1', name: 'The Cellar' });
  assert.equal(db.listCampaigns().length, 0, 'off the list');
  assert.deepEqual(db.listStrandedCampaigns().map((c) => c.id), [id]);

  client.emit('guildCreate', { id: 'g1', name: 'The Cellar' });
  assert.deepEqual(db.listCampaigns().map((c) => c.id), [id], 'and back, with nobody deciding anything');
  assert.equal(db.listStrandedCampaigns().length, 0);
});

test('an outage does not strand anything', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g1', 'Cipher', DEV);
  const client = fakeClient([{ id: 'g1', name: 'The Cellar' }]);
  installGuildPresence(db, client, { log: quiet });

  client.emit('guildDelete', { id: 'g1', name: 'The Cellar', available: false });

  assert.equal(db.listCampaigns().length, 1, 'somebody else’s outage is not a decision about this table');
});

// --- what the gatehouse is handed ---

test('a departed server with nothing filed under it is not worth a line', async (t) => {
  const { db } = await world(t);
  db.rememberGuild('g-empty', 'Nowhere');
  db.markGuildLeft('g-empty');

  assert.equal(db.listDepartedGuilds().length, 0);
});

test('the departed list counts what is actually stuck there', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g-gone', 'Strahd', DEV);
  db.createCampaign('g-gone', 'Cipher', DEV);
  const archived = db.createCampaign('g-gone', 'Abandoned', DEV);
  db.archiveCampaign(archived, DEV);

  reconcileGuilds(db, fakeClient([{ id: 'g-live', name: 'Here' }]), { log: quiet });

  const [gone] = db.listDepartedGuilds();
  assert.equal(gone.campaigns, 2, 'an archived one was already gone for a different reason');
});

// The name-clash check has to see through this, or a stranded campaign's
// folder could be claimed by a new one and the two would interleave on disk.
test('a stranded campaign still holds its folder name', async (t) => {
  const { db } = await world(t);
  db.createCampaign('g-gone', 'Cipher', DEV);
  reconcileGuilds(db, fakeClient([{ id: 'g-live', name: 'Here' }]), { log: quiet });

  const { campaignNameClash } = await import('../src/campaign/resolve.js');
  assert.ok(campaignNameClash(db, 'cipher'), 'the notes are still on disk under that folder');
});
