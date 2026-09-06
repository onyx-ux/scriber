import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/store/db.js';
import { transcribeAction } from '../src/pipeline/job-actions.js';
import { parseTranscribeAction, ACTION_GEMINI, TRANSCRIBE_PREFIX } from '../src/pipeline/transcribe-schedule.js';
import { ACTIONS } from '../src/web/actions.js';

// Choosing the cloud for ONE session, on purpose.
//
// The schedule could already divert an unreachable-PC job to Gemini, and had
// been able to for weeks. What did not exist was any way to ASK for it. The
// module that describes the choice — buildTranscribeChoiceRow,
// transcribeChoicePrompt, parseTranscribeChoice — was written, exported,
// tested, and called by nothing outside its own test file, so the prompt it
// describes had never appeared in the product. The only writer of
// `transcribe_target_<job>` was the Pi button.
//
// Which mattered the moment somebody wanted to compare the two engines on the
// same evening: the only route to Gemini was to switch the PC off and wait for
// a scheduling window, and hope.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-cloud-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'the-cellar',
    startedAt: '2026-09-04T19:00:00Z', audioDir: '/tmp',
  });
  db.endMeeting(meetingId, '2026-09-04T22:00:00Z');
  const jobId = db.raw
    .prepare("INSERT INTO jobs (meeting_id, type, status, next_attempt_at) VALUES (?, 'transcribe', 'awaiting_approval', datetime('now'))")
    .run(meetingId).lastInsertRowid;

  return { db, jobId, meetingId };
}

const CLOUD_ON = { geminiTranscribe: true, geminiApiKey: 'gm-test', transcribeSnoozeHours: 24 };
const CLOUD_OFF = { geminiTranscribe: false, geminiApiKey: 'gm-test', transcribeSnoozeHours: 24 };

test('choosing Gemini pins the target and lets the job past the GPU schedule', async (t) => {
  const { db, jobId } = await harness(t);

  const out = transcribeAction(db, CLOUD_ON, { jobId, action: ACTION_GEMINI });
  assert.equal(out.ok, true);

  // The target the worker reads. Same key the Pi button writes, same shape,
  // and the value is TARGET_GEMINI — which is what makes shouldUseGemini() say
  // yes regardless of whether the PC happens to be answering.
  assert.equal(db.getSetting(`transcribe_target_${jobId}`), 'gemini');

  // And approved, because Gemini does not need the PC and so must not be held
  // behind a window that exists to keep off somebody else’s graphics card.
  const job = db.raw.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  assert.equal(job.status, 'pending');
});

test('the message says the recording is leaving, before it leaves', async (t) => {
  const { db, jobId } = await harness(t);
  const out = transcribeAction(db, CLOUD_ON, { jobId, action: ACTION_GEMINI });

  // This is the only action in the whole bot that sends audio off the network.
  // Whoever pressed it should not have to have read the README to know that,
  // and the confirmation is the last place it can be said.
  assert.match(out.message, /sent to Google/i);

  // And the known cost, said at the same time rather than discovered later on
  // a transcript whose timings look wrong.
  assert.match(out.message, /approximate/i);
});

test('with the cloud off it refuses, and changes nothing at all', async (t) => {
  const { db, jobId } = await harness(t);

  const out = transcribeAction(db, CLOUD_OFF, { jobId, action: ACTION_GEMINI });
  assert.equal(out.ok, false);
  assert.match(out.message, /GEMINI_TRANSCRIBE/);

  // Refused, NOT quietly downgraded to the PC. The whole content of this
  // request is where the audio goes, so substituting a different engine would
  // be the right transcript by the wrong route — and if the reason for pressing
  // it was to compare the two engines, an unannounced substitution silently
  // ruins the comparison and looks like a successful run.
  assert.equal(db.getSetting(`transcribe_target_${jobId}`), null);
  assert.equal(
    db.raw.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status,
    'awaiting_approval',
    'a refused request approved the job anyway'
  );
});

test('the action is reachable from the dashboard and from an old DM button', async (t) => {
  const { db, jobId } = await harness(t);

  // The web action validates against its own allow-list, so an action the
  // page offers but that list does not know is a 400 that only shows up on a
  // real click.
  const res = ACTIONS.transcribe(db, CLOUD_ON, { jobId, action: 'gemini' });
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);

  // And the button parser, which still answers DMs already in scrollback.
  assert.deepEqual(
    parseTranscribeAction(`${TRANSCRIBE_PREFIX}${jobId}:gemini`),
    { jobId: Number(jobId), action: 'gemini' }
  );
});

test('the page offers the button only where the cloud is actually on', async () => {
  const page = await readFile(fileURLToPath(new URL('../../dashboard/html/index.html', import.meta.url)), 'utf8');

  // Gated on the flag, both the button and the sentence under it. A button
  // that always showed and sometimes refused would teach every operator that
  // Quill sends recordings to Google — which, on almost every install, it does
  // not, and that impression is not worth a convenience.
  const offer = page.match(/\$\{status\?\.health\?\.cloudTranscribe \? `/g) ?? [];
  assert.equal(offer.length, 2, 'the cloud button or its warning stopped being gated');

  assert.match(page, /data-action="gemini"/);

  // And it asks first. Every other transcribe button is one click, because
  // every other one keeps the audio on the LAN.
  assert.match(page, /data-confirm="Transcribe this session with Gemini\?[^"]*uploaded to Google/);
});
