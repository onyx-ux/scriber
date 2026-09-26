import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { renameCampaign, mayRename } from '../src/campaign/rename.js';
import { runAction } from '../src/web/actions.js';
import { ACTION_NEEDS } from '../src/web/authority.js';

// Renaming used to be /campaign rename in Discord and nothing else. It is on
// the dashboard now, beside the campaign's name, and it is the DM's: whoever
// runs the campaign (and the bot owner, who can act on any campaign). A server
// owner who can manage the campaign's roster cannot rename it, and nor can a
// player.

const DM = 'dm-1';
const OWNER = 'owner-1';

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-rename-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const campaignId = db.createCampaign('guild-1', 'Cipher', DM);
  const cfg = { ownerUserId: OWNER, obsidianExportDir: join(dir, 'vault') };
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const as = (userId, extra = {}) => ({
    viewer: { userId, can: { manage: true, everything: false, ...extra }, manageableCampaignIds: [campaignId] },
  });
  const rename = (ctx, name) =>
    runAction({ pathname: '/actions/campaign/rename', body: { campaignId, name }, db, cfg, ctx });
  return { db, cfg, campaignId, as, rename };
}

test('the DM renames their campaign from the dashboard', async (t) => {
  const { db, campaignId, as, rename } = await world(t);
  const res = await rename(as(DM), 'The Cipher of Ashfall');
  assert.equal(res.payload.ok, true, res.payload.message);
  assert.equal(db.getCampaign(campaignId).name, 'The Cipher of Ashfall');
  assert.match(res.payload.message, /renamed to/i);
});

test('somebody who manages the campaign but does not run it cannot rename it', async (t) => {
  const { db, campaignId, as, rename } = await world(t);
  const res = await rename(as('server-owner'), 'Mine now');
  assert.equal(res.payload.ok, false);
  assert.equal(res.status, 403);
  assert.equal(db.getCampaign(campaignId).name, 'Cipher');
});

test('the bot owner can rename any campaign', async (t) => {
  const { db, campaignId, as, rename } = await world(t);
  assert.equal((await rename(as(OWNER), 'Cipher II')).payload.ok, true);
  assert.equal(db.getCampaign(campaignId).name, 'Cipher II');
});

test('a name another campaign files under, or one with nothing usable, is refused', async (t) => {
  const { db, as, rename } = await world(t);
  db.createCampaign('guild-1', 'Strahd', 'dm-2');
  assert.match((await rename(as(DM), 'strahd')).payload.message, /already files its notes there/);
  assert.equal((await rename(as(DM), '🎲🎲')).payload.ok, false);
  assert.equal((await rename(as(DM), '   ')).payload.ok, false);
});

test('the rule is written down twice: the gate and the act', () => {
  assert.equal(ACTION_NEEDS['campaign/rename'], 'manage');
});

test('mayRename is the DM or the bot owner', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const campaign = db.getCampaign(campaignId);
  assert.equal(mayRename({ campaign, userId: DM, cfg, db }), true);
  assert.equal(mayRename({ campaign, userId: OWNER, cfg, db }), true);
  assert.equal(mayRename({ campaign, userId: 'player', cfg, db }), false);
});

test('renameCampaign reports the folder the notes moved to', async (t) => {
  const { db, cfg, campaignId } = await world(t);
  const moves = [];
  const res = await renameCampaign({
    db, cfg, campaignId, name: 'Ashfall',
    move: async (m) => { moves.push(m); return { moved: true }; },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(moves.map((m) => [m.from, m.to]), [['Cipher', 'Ashfall']]);
  assert.match(res.message, /Moved the existing/);
});

// The dashboard's side: the pencil is drawn from viewerCan.rename, which the
// bot works out with the same rule the action enforces.
test('the campaign payload says who may rename', async (t) => {
  const { mkdtemp: mk, rm: remove } = await import('node:fs/promises');
  const { createServer } = await import('node:http');
  const { startStatusServer } = await import('../src/web/server.js');
  const { openSession } = await import('../src/web/auth.js');
  const dir = await mk(join(tmpdir(), 'quill-rename-http-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const campaignId = db.createCampaign('guild-1', 'Cipher', DM);
  const cfg = {
    statusHost: '127.0.0.1', statusPort: port, statusToken: 'sesame', authSecret: 'a'.repeat(32),
    ownerUserId: OWNER, dashboardRequireLogin: true, summaryProvider: 'gemini', geminiApiKey: 'k',
  };
  const { server, close } = startStatusServer({
    db, cfg, activeSessions: new Map(),
    client: { guilds: { cache: new Map([['guild-1', { id: 'guild-1', ownerId: 'server-owner' }]]) } },
  });
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { await close(); db.close(); await remove(dir, { recursive: true, force: true }); });

  const read = async (userId) => {
    const cookie = `quill_session=${openSession(db, cfg, { userId, username: userId }).token}`;
    const res = await fetch(`http://127.0.0.1:${port}/campaign?id=${campaignId}&token=sesame`, { headers: { Cookie: cookie } });
    return res.json();
  };
  assert.equal((await read(DM)).viewerCan.rename, true);
  assert.equal((await read('server-owner')).viewerCan.rename, false, 'managing is not renaming');
});
