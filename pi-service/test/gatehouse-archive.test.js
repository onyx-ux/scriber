import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';

// Deleted campaigns and the model bill moved off the dashboard and into the
// gatehouse, which only the operator can open. Moving them, rather than
// hiding them behind more checks on the dashboard, means there is one door to
// get right: these routes answer the operator and refuse everybody else.

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

async function serving(t, over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-gate-archive-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const kept = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  const gone = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  db.archiveCampaign(gone, 'dm-2', new Date().toISOString());
  const cfg = {
    statusHost: '127.0.0.1', statusPort: await freePort(), statusToken: 'sesame',
    scheduleTimeZone: 'Europe/London', summaryProvider: 'gemini', geminiApiKey: 'k',
    ...over,
  };
  const { server, close } = startStatusServer({ db, cfg, activeSessions: new Map() });
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=sesame`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, kept, gone, get };
}

test('the operator reads the archive in the gatehouse', async (t) => {
  const { get, gone } = await serving(t);
  const res = await get('/archive');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.campaigns.map((c) => c.id), [gone]);
  assert.equal(res.body.campaigns[0].name, 'Strahd');
  assert.ok(res.body.campaigns[0].daysLeft > 0);
  assert.deepEqual(res.body.requests, []);
});

test('the operator reads the bill in the gatehouse', async (t) => {
  const { get } = await serving(t);
  const res = await get('/usage');
  assert.equal(res.status, 200);
  assert.ok(res.body.today, 'today’s spend');
  assert.ok(Array.isArray(res.body.byModel));
});

test('anybody who is not the operator is refused both', async (t) => {
  const { get } = await serving(t, { dashboardRequireLogin: true, authSecret: 'a'.repeat(32) });
  assert.equal((await get('/archive')).status, 403);
  assert.equal((await get('/usage')).status, 403);
});

test('the dashboard snapshot no longer carries the archive', async (t) => {
  const { get } = await serving(t);
  const res = await get('/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.restorable, undefined);
  assert.equal(res.body.restoreQueue, undefined);
});
