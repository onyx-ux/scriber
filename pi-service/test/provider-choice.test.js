import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  withProvider,
  isValidProvider,
  configuredProviders,
  summariserLabel,
  contextTokens,
} from '../src/pipeline/model-client.js';
import { buildApprovalRow, providerChoiceNote, APPROVE_PREFIX } from '../src/delivery/approval-notify.js';
import { openDb } from '../src/store/db.js';

const baseCfg = {
  summaryProvider: 'ollama',
  ollamaUrl: 'http://stub:11434',
  ollamaModel: 'qwen2.5:14b',
  ollamaNumCtx: 9216,
  geminiApiKey: 'gm-test',
  geminiModel: 'gemini-3.1-flash-lite',
  anthropicApiKey: null,
  anthropicModel: 'claude-opus-5',
};

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-prov-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

function seedParkedJob(db) {
  const meetingId = db.createMeeting({
    guildId: 'G1',
    channelId: 'C1',
    channelName: 'Cipher',
    startedAt: '2026-08-01T10:00:00Z',
    audioDir: '/tmp/audio',
  });
  const job = db.finalizeTranscription(
    meetingId,
    [{ userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1000, text: 'hello' }],
    { requireApproval: true }
  );
  return { meetingId, job };
}

// --- withProvider ---

test('withProvider swaps the provider without disturbing the rest of the config', () => {
  const gemini = withProvider(baseCfg, 'gemini');
  assert.equal(gemini.summaryProvider, 'gemini');
  assert.equal(gemini.ollamaModel, 'qwen2.5:14b', 'unrelated settings are preserved');
  assert.equal(baseCfg.summaryProvider, 'ollama', 'the original config is not mutated');
});

test('withProvider ignores null/unknown values rather than producing a broken config', () => {
  assert.equal(withProvider(baseCfg, null).summaryProvider, 'ollama');
  assert.equal(withProvider(baseCfg, undefined).summaryProvider, 'ollama');
  // A hand-edited or stale value in the database must degrade to the default,
  // not silently select a provider that doesn't exist.
  assert.equal(withProvider(baseCfg, 'gpt5').summaryProvider, 'ollama');
});

test('the overridden config actually drives the downstream provider behaviour', () => {
  // Not just the field — the things that read it must follow too, otherwise a
  // job could "use Gemini" while still budgeting for Ollama's tiny context.
  assert.match(summariserLabel(withProvider(baseCfg, 'gemini')), /Gemini/);
  assert.equal(contextTokens(baseCfg), 9216);
  assert.ok(contextTokens(withProvider(baseCfg, 'gemini')) > 100_000);
});

test('isValidProvider accepts exactly the three real providers', () => {
  assert.ok(isValidProvider('ollama') && isValidProvider('gemini') && isValidProvider('anthropic'));
  assert.ok(!isValidProvider('openai'));
  assert.ok(!isValidProvider(''));
  assert.ok(!isValidProvider(null));
});

// --- configuredProviders ---

test('configuredProviders lists only what has credentials, with Ollama always available', () => {
  assert.deepEqual(configuredProviders(baseCfg), ['ollama', 'gemini']);
  assert.deepEqual(configuredProviders({ ...baseCfg, geminiApiKey: null }), ['ollama']);
  assert.deepEqual(configuredProviders({ ...baseCfg, anthropicApiKey: 'sk-x' }), ['ollama', 'anthropic', 'gemini']);
});

// --- approval buttons ---

test('one button per configured provider, plus "Not yet"', () => {
  const row = buildApprovalRow(42, baseCfg).toJSON();
  const ids = row.components.map((c) => c.custom_id);
  assert.deepEqual(ids, ['scriber:approve:42:ollama', 'scriber:approve:42:gemini', 'scriber:park:42']);
});

test('with only one provider set up, the button stays a plain "Summarise now"', () => {
  const row = buildApprovalRow(42, { ...baseCfg, geminiApiKey: null }).toJSON();
  const ids = row.components.map((c) => c.custom_id);
  assert.deepEqual(ids, ['scriber:approve:42', 'scriber:park:42'], 'no pointless provider picker for a single option');
});

test('button custom_ids stay within Discord\'s 100-character limit', () => {
  const row = buildApprovalRow(999999999, { ...baseCfg, anthropicApiKey: 'sk-x' }).toJSON();
  for (const c of row.components) {
    assert.ok(c.custom_id.length <= 100, `${c.custom_id} is too long`);
    assert.ok(c.label.length <= 80, `${c.label} is too long`);
  }
});

// The DM's buttons only have room for a provider name, so the message body has
// to say which model each one actually means.
test('the DM note names the model behind each button, and is empty when there is no choice', () => {
  const note = providerChoiceNote(baseCfg);
  assert.match(note, /qwen2\.5:14b/);
  assert.match(note, /gemini-3\.1-flash-lite/);
  assert.equal(providerChoiceNote({ ...baseCfg, geminiApiKey: null }), '', 'no note when there is nothing to choose');
});

// --- parsing the button id back out (mirrors handleApprovalButton) ---

test('approve button ids parse back to a job id and provider, old format included', () => {
  const parse = (id) => {
    const [rawJobId, provider = null] = id.slice(APPROVE_PREFIX.length).split(':');
    return { jobId: parseInt(rawJobId, 10), provider };
  };

  assert.deepEqual(parse('scriber:approve:42:gemini'), { jobId: 42, provider: 'gemini' });
  // Buttons from a DM sent before per-provider approval existed must still
  // work after an upgrade, meaning "use the configured default".
  assert.deepEqual(parse('scriber:approve:42'), { jobId: 42, provider: null });
});

// --- persistence ---

test('approving with a provider pins it to that job', async (t) => {
  const db = await freshDb(t);
  const { job } = seedParkedJob(db);

  assert.equal(db.getJob(job.id).provider, null, 'jobs start with no pinned provider');
  assert.equal(db.approveJob(job.id, 'gemini'), true);

  const released = db.getJob(job.id);
  assert.equal(released.status, 'pending');
  assert.equal(released.provider, 'gemini');
  assert.equal(db.nextDueJob().provider, 'gemini', 'the worker sees the choice');
});

test('approving without a provider leaves the job on the configured default', async (t) => {
  const db = await freshDb(t);
  const { job } = seedParkedJob(db);
  db.approveJob(job.id);
  assert.equal(db.getJob(job.id).provider, null);
});

test('re-running /summarise without a provider keeps the earlier choice', async (t) => {
  const db = await freshDb(t);
  const { meetingId, job } = seedParkedJob(db);

  db.approveJob(job.id, 'gemini');
  db.requeueSummarizeNow(meetingId); // no provider named
  assert.equal(db.getJob(job.id).provider, 'gemini', 'an omitted provider must not wipe a deliberate choice');

  db.requeueSummarizeNow(meetingId, 'ollama'); // explicitly changed
  assert.equal(db.getJob(job.id).provider, 'ollama');
});

test('requeue on a meeting with no existing job records the provider on the new job', async (t) => {
  const db = await freshDb(t);
  const meetingId = db.createMeeting({
    guildId: 'G1',
    channelId: 'C1',
    channelName: 'Cipher',
    startedAt: '2026-08-01T10:00:00Z',
    audioDir: '/tmp/audio',
  });

  db.requeueSummarizeNow(meetingId, 'gemini');
  assert.equal(db.nextDueJob().provider, 'gemini');
});

test('approveAllWaiting can pin a provider across every parked job', async (t) => {
  const db = await freshDb(t);
  seedParkedJob(db);
  seedParkedJob(db);

  assert.equal(db.approveAllWaiting('gemini'), 2);
  for (const j of db.listPendingJobs()) assert.equal(j.provider, 'gemini');
});

// The provider column was added after the jobs table already existed in a live
// deployment, so opening an older database must migrate rather than crash.
test('an existing jobs table without the provider column is migrated on open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-migrate-'));
  const path = join(dir, 'db.sqlite');

  // Build a pre-migration database by hand: jobs table with no provider column.
  const first = openDb(path);
  first.raw.exec(`DROP TABLE jobs`);
  first.raw.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'summarize',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  first.raw.prepare(`INSERT INTO jobs (meeting_id) VALUES (1)`).run();
  first.close();

  const reopened = openDb(path);
  t.after(async () => {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  });

  const columns = reopened.raw.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  assert.ok(columns.includes('provider'), 'the column is added on open');
  assert.equal(reopened.getJob(1).provider, null, 'the pre-existing row survives, defaulting to no provider');
});
