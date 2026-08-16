import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { openDb } from '../src/store/db.js';
import { startStatusServer } from '../src/web/server.js';

// The HTTP layer itself, over a real socket.
//
// The action table is tested directly elsewhere; what only shows up here is
// everything around it — who is allowed to POST at all, what happens to a
// body that is not JSON, and whether the read routes that replaced /export
// hand back what they claim to.
//
// The auth rules are the reason this file exists. They are the difference
// between a status port and a control panel, and "reads are open, writes are
// not" is exactly the kind of asymmetry that a refactor quietly flattens.

const baseCfg = {
  statusHost: '127.0.0.1',
  scheduleTimeZone: 'Australia/Brisbane',
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeRequireApproval: true,
  transcribeSnoozeHours: 12,
  summaryProvider: 'gemini',
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-3.6-flash',
};

// Bind to 0, note what the OS handed out, give it straight back.
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
  const dir = await mkdtemp(join(tmpdir(), 'quill-http-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');

  // A free port found by the OS rather than a fixed one, which would fail
  // whenever anything else on the machine happened to be using it — on a dev
  // box running the real bot, most of the time. Cannot just pass 0: in this
  // config 0 means "disabled", which is what the bot needs it to mean.
  const cfg = { ...baseCfg, statusPort: await freePort(), ...over };
  const { server, close } = startStatusServer({ db, cfg, activeSessions: new Map() });

  // listen() is asynchronous, so the port is not assigned yet.
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, base, campaignId };
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function parked(db, campaignId) {
  const meetingId = db.createMeeting({
    guildId: 'guild-1',
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: new Date().toISOString(),
    audioDir: '/tmp',
  });
  const job = db.finalizeTranscription(
    meetingId,
    [{ userId: '111', displayName: 'Matt', startMs: 0, endMs: 1000, text: 'we open the door' }],
    { requireApproval: true }
  );
  return { meetingId, jobId: job.id };
}

// --- reads stay open; writes do not ---

test('status is readable without a token, as it always was', async (t) => {
  const { base } = await serving(t);
  const res = await fetch(`${base}/status`);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).actionsEnabled, false);
});

// THE rule. With no token configured there is no correct credential to
// present, and treating that as "everyone is welcome" would mean an
// unauthenticated stranger on the LAN could spend the API budget and seize
// the GPU. So it fails closed instead.
test('with no token configured, every action is refused rather than allowed', async (t) => {
  const { db, base, campaignId } = await serving(t);
  const { jobId } = parked(db, campaignId);

  const res = await post(base, '/actions/summary/approve', { jobId });
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /STATUS_TOKEN/, 'and says how to turn them on');
  assert.equal(db.getJob(jobId).status, 'awaiting_approval', 'nothing happened');
});

test('with a token configured, an action needs it', async (t) => {
  const { db, base, campaignId } = await serving(t, { statusToken: 'sesame' });
  const { jobId } = parked(db, campaignId);

  assert.equal((await post(base, '/actions/summary/approve', { jobId })).status, 401, 'no token');
  assert.equal(
    (await post(base, '/actions/summary/approve', { jobId }, { 'X-Status-Token': 'wrong' })).status,
    401,
    'wrong token'
  );
  assert.equal(db.getJob(jobId).status, 'awaiting_approval');

  const ok = await post(base, '/actions/summary/approve', { jobId }, { 'X-Status-Token': 'sesame' });
  assert.equal(ok.status, 200);
  assert.equal(db.getJob(jobId).status, 'pending');
});

test('a token also gates reads once one is set', async (t) => {
  const { base } = await serving(t, { statusToken: 'sesame' });

  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status?token=sesame`)).status, 200, 'query string, for the browser');
});

test('anything other than GET or POST is refused', async (t) => {
  const { base } = await serving(t, { statusToken: 'sesame' });
  const res = await fetch(`${base}/status`, { method: 'DELETE', headers: { 'X-Status-Token': 'sesame' } });
  assert.equal(res.status, 405);
});

// --- bodies ---

test('a body that is not JSON is a 400, not a crash', async (t) => {
  const { base } = await serving(t, { statusToken: 'sesame' });
  const res = await post(base, '/actions/pause', 'not json at all', { 'X-Status-Token': 'sesame' });

  assert.equal(res.status, 400);
  assert.equal((await fetch(`${base}/health?token=sesame`)).status, 200, 'and the server is still up');
});

test('an oversized body is rejected rather than buffered', async (t) => {
  const { base } = await serving(t, { statusToken: 'sesame' });
  const huge = JSON.stringify({ queue: 'summarize', paused: true, pad: 'x'.repeat(200_000) });

  const res = await post(base, '/actions/pause', huge, { 'X-Status-Token': 'sesame' }).catch((err) => err);
  // The server destroys the request, so either a 400 or a transport-level
  // failure is a pass — what must not happen is 200.
  assert.notEqual(res.status, 200);
});

// --- the reads that replaced /export and /dm roster ---

test('a campaign is readable in full, and an unknown one is a 404', async (t) => {
  const { db, base, campaignId } = await serving(t, { statusToken: 'sesame' });
  parked(db, campaignId);
  db.addCorrection(campaignId, 'Vecks', 'Vex');

  const res = await fetch(`${base}/campaign?id=${campaignId}&token=sesame`);
  const view = await res.json();

  assert.equal(view.label, 'Cipher');
  assert.equal(view.sessions[0].ref, 'Cipher_01');
  assert.deepEqual(view.corrections, [{ wrong: 'Vecks', right: 'Vex' }]);
  assert.ok(view.roster.some((r) => r.userId === '111'));

  assert.equal((await fetch(`${base}/campaign?id=9999&token=sesame`)).status, 404);
  assert.equal((await fetch(`${base}/campaign?id=nonsense&token=sesame`)).status, 404);
});

test('a transcript downloads as plain text under its session name', async (t) => {
  const { db, base, campaignId } = await serving(t, { statusToken: 'sesame' });
  const { meetingId } = parked(db, campaignId);

  const res = await fetch(`${base}/transcript?meeting=${meetingId}&token=sesame`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename=/);
  assert.match(await res.text(), /we open the door/);

  assert.equal((await fetch(`${base}/transcript?meeting=9999&token=sesame`)).status, 404);
});

test('an unknown path is a 404 rather than a stack trace', async (t) => {
  const { base } = await serving(t);
  assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/admin`)).status, 404);
});
