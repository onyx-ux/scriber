import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';
import { statusEtag } from '../src/web/status.js';

// Every open dashboard tab asks for /status every five seconds. Before this,
// each ask downloaded the whole snapshot even when nothing in it had moved.
// An ETag lets an unchanged poll come back as a bodiless 304.

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

async function serving(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-etag-'));
  const db = openDb(join(dir, 'db.sqlite'));
  db.createCampaign('guild-1', 'Cipher', 'dm-1');
  const cfg = {
    statusHost: '127.0.0.1',
    statusPort: await freePort(),
    scheduleTimeZone: 'Europe/London',
    summaryProvider: 'gemini',
    geminiApiKey: 'k',
  };
  const { server, close } = startStatusServer({ db, cfg, activeSessions: new Map() });
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base };
}

test('the same snapshot twice answers 304 the second time', async (t) => {
  const { base } = await serving(t);

  const first = await fetch(`${base}/status`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'a 200 carries an ETag');
  await first.json();

  const again = await fetch(`${base}/status`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '', 'a 304 carries no body');
});

test('a change in the snapshot changes the tag', async (t) => {
  const { db, base } = await serving(t);

  const first = await fetch(`${base}/status`);
  const etag = first.headers.get('etag');
  await first.json();

  db.createCampaign('guild-1', 'Strahd', 'dm-2');

  const after = await fetch(`${base}/status`, { headers: { 'if-none-match': etag } });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get('etag'), etag);
});

// The clock fields move on every request. Hashing them in would make every
// tag unique and the whole thing pointless, so they are left out and the page
// advances them itself on a 304.
test('the clock fields do not change the tag', () => {
  const a = { generatedAt: '2026-09-27T10:00:00Z', bot: { uptimeMs: 1000, user: 'Quill' }, recording: [{ meetingId: 1, recordingForMs: 5000, clips: 3 }] };
  const b = { generatedAt: '2026-09-27T10:00:05Z', bot: { uptimeMs: 6000, user: 'Quill' }, recording: [{ meetingId: 1, recordingForMs: 10000, clips: 3 }] };
  assert.equal(statusEtag(a), statusEtag(b));

  const c = { ...b, recording: [{ meetingId: 1, recordingForMs: 10000, clips: 4 }] };
  assert.notEqual(statusEtag(a), statusEtag(c), 'a new clip is a real change');
});
