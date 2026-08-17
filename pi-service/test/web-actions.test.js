import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { runAction, findAction, ACTIONS } from '../src/web/actions.js';
import {
  approveSummary,
  approveAllSummaries,
  transcribeAction,
  setPaused,
} from '../src/pipeline/job-actions.js';

// The dashboard's control surface.
//
// These matter more than the average handler test: this is the file that turns
// a read-only status port into something that can spend the owner's API budget
// and seize the PC's GPU. Everything here is about what the API refuses.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-actions-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = {
    summaryProvider: 'gemini',
    geminiApiKey: 'test-key',
    geminiModel: 'gemini-3.6-flash',
    transcribeSnoozeHours: 12,
  };
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { db, cfg, dir, campaignId };
}

// A meeting with a parked job of the given type, which is the state every
// action here acts on. Built through the real pipeline calls rather than by
// writing job rows directly, so a change to how jobs are parked shows up here
// instead of leaving these testing a shape nothing produces any more.
function parked(db, type, campaignId) {
  const meetingId = db.createMeeting({
    guildId: 'guild-1',
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: new Date().toISOString(),
    audioDir: '/tmp',
  });

  if (type === 'transcribe') {
    return { meetingId, jobId: db.enqueueTranscribeJob(meetingId, { requireApproval: true }).id };
  }

  const job = db.finalizeTranscription(
    meetingId,
    [{ userId: 'someone', displayName: 'Someone', startMs: 0, endMs: 1000, text: 'hello' }],
    { requireApproval: true }
  );
  return { meetingId, jobId: job.id };
}

// --- what the action table will not do ---

test('an unknown action is not found rather than guessed at', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = runAction({ pathname: '/actions/delete-everything', body: {}, db, cfg });

  assert.equal(res.status, 404);
  assert.equal(res.payload.ok, false);
});

test('the action list is closed — no path reaches an arbitrary db method', () => {
  assert.deepEqual(
    Object.keys(ACTIONS).sort(),
    [
      'campaign/output',
      'corrections/add',
      'corrections/remove',
      'corrections/replay',
      'health/probe',
      'import',
      'pause',
      'roster/character',
      'roster/forget',
      'roster/invite',
      'roster/search',
      'session/discard',
      'summary/again',
      'summary/approve',
      'summary/approve-all',
      'summary/park',
      'transcribe',
    ],
    'adding one has to be a decision someone makes on purpose'
  );
  assert.equal(findAction('/actions/../status'), null);
  assert.equal(findAction('/status'), null);
});

test('a job id that is not a number is refused, not coerced', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  for (const jobId of ['12abc', '', null, {}, '1e3', -4, 1.5]) {
    const res = runAction({ pathname: '/actions/summary/approve', body: { jobId }, db, cfg });
    assert.equal(res.status, 400, `jobId ${JSON.stringify(jobId)} should be refused`);
  }
});

test('pause sets a state rather than toggling one', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  // A toggle sent twice by a double-click lands on the opposite of what the
  // person who clicked it saw, so the action requires an explicit boolean.
  assert.equal(runAction({ pathname: '/actions/pause', body: { queue: 'summarize' }, db, cfg }).status, 400);

  const body = { queue: 'summarize', paused: true };
  runAction({ pathname: '/actions/pause', body, db, cfg });
  runAction({ pathname: '/actions/pause', body, db, cfg });
  assert.equal(db.getSetting('summarize_paused'), 'true', 'twice is the same as once');
});

test('pause refuses a queue it does not have', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = setPaused(db, { queue: 'everything', paused: true });

  assert.equal(res.ok, false);
  assert.equal(db.getSetting('everything_paused'), null, 'a typo must not create a setting');
});

test('an unknown transcribe action is refused', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { jobId } = parked(db, 'transcribe', campaignId);
  const res = runAction({ pathname: '/actions/transcribe', body: { jobId, action: 'delete' }, db, cfg });

  assert.equal(res.status, 400);
  assert.equal(db.getJob(jobId).status, 'awaiting_approval', 'and changes nothing');
});

// --- what it does do ---

test('approving a summary releases exactly that job', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const mine = parked(db, 'summarize', campaignId);
  const other = parked(db, 'summarize', campaignId);

  const res = runAction({ pathname: '/actions/summary/approve', body: { jobId: mine.jobId }, db, cfg });

  assert.equal(res.payload.ok, true);
  assert.equal(db.getJob(mine.jobId).status, 'pending');
  assert.equal(db.getJob(other.jobId).status, 'awaiting_approval', 'the other stays parked');
});

test('approving twice is refused the second time', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { jobId } = parked(db, 'summarize', campaignId);

  assert.equal(approveSummary(db, cfg, { jobId }).ok, true);
  const again = approveSummary(db, cfg, { jobId });
  assert.equal(again.ok, false);
  assert.match(again.message, /already released/);
});

test('a provider that is not set up is named, not silently swapped', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { jobId } = parked(db, 'summarize', campaignId);

  const res = approveSummary(db, cfg, { jobId, provider: 'anthropic' });
  assert.equal(res.ok, false);
  assert.match(res.message, /isn't set up/);
  assert.equal(db.getJob(jobId).status, 'awaiting_approval', 'and the job stays parked');

  const nonsense = approveSummary(db, cfg, { jobId, provider: 'gpt' });
  assert.match(nonsense.message, /Unknown provider/);
});

test('transcribe now releases the job; later parks it with a time', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const now = parked(db, 'transcribe', campaignId);
  assert.equal(transcribeAction(db, cfg, { jobId: now.jobId, action: 'now' }).ok, true);
  assert.equal(db.getJob(now.jobId).status, 'pending');

  const later = parked(db, 'transcribe', campaignId);
  const res = transcribeAction(db, cfg, { jobId: later.jobId, action: 'later' });
  assert.equal(res.ok, true);
  assert.equal(db.getJob(later.jobId).status, 'awaiting_approval');
  assert.ok(new Date(res.until).getTime() > Date.now(), 'and comes back later, not never');
});

test('transcribing on the Pi bypasses the GPU schedule and says so in settings', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { jobId } = parked(db, 'transcribe', campaignId);

  transcribeAction(db, cfg, { jobId, action: 'pi' });
  assert.equal(db.getJob(jobId).status, 'pending');
  assert.equal(db.getSetting(`transcribe_target_${jobId}`), 'pi');
});

test('a job already running is left alone', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { jobId } = parked(db, 'transcribe', campaignId);
  db.markJobRunning(jobId);

  const res = transcribeAction(db, cfg, { jobId, action: 'now' });
  assert.equal(res.ok, false);
  assert.match(res.message, /right now/);
});

// The bug this surfaced: db.approveAllWaiting() matches every parked job of
// any type, so "approve all summaries" also released parked TRANSCRIPTIONS —
// jobs sitting there precisely because nobody had agreed to spend the GPU yet
// — and then reported the count as summaries.
test('approving all summaries does not release a parked transcription', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const summary = parked(db, 'summarize', campaignId);
  const transcription = parked(db, 'transcribe', campaignId);

  const res = approveAllSummaries(db, cfg);

  assert.equal(res.released, 1, 'only the summary');
  assert.equal(db.getJob(summary.jobId).status, 'pending');
  assert.equal(
    db.getJob(transcription.jobId).status,
    'awaiting_approval',
    'the GPU is not seized by a button that said it was releasing summaries'
  );
});

test('approving a transcription through the summary action is refused', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { jobId } = parked(db, 'transcribe', campaignId);

  const res = approveSummary(db, cfg, { jobId });
  assert.equal(res.ok, false);
  assert.match(res.message, /transcription, not a summary/);
  assert.equal(db.getJob(jobId).status, 'awaiting_approval');
});

test('approving all when nothing waits says so instead of claiming work', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = approveAllSummaries(db, cfg);

  assert.equal(res.ok, true);
  assert.equal(res.released, 0);
  assert.match(res.message, /Nothing is waiting/);
});

// A thrown error must never reach the caller as a stack trace: this port can
// be published, and the bot must stay up.
test('an action that throws answers 500 without leaking the error', async (t) => {
  const { cfg } = await harness(t);
  const exploding = {
    getJob() {
      throw new Error('SQLITE_CORRUPT: /data/db.sqlite is toast');
    },
  };

  const res = runAction({ pathname: '/actions/summary/approve', body: { jobId: 1 }, db: exploding, cfg });
  assert.equal(res.status, 500);
  assert.doesNotMatch(res.payload.message, /SQLITE|db\.sqlite/);
});

// --- a campaign's records ---
//
// The /correct and /dm side. These are the actions that rewrite already-stored
// transcripts, so the tests are mostly about blast radius.

test('a correction rewrites its own campaign and no other', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  const mine = parked(db, 'summarize', campaignId).meetingId;
  const theirs = parked(db, 'summarize', other).meetingId;

  db.finalizeTranscription(mine, [{ userId: 'u', displayName: 'A', startMs: 0, endMs: 1, text: 'Vecks opens it' }]);
  db.finalizeTranscription(theirs, [{ userId: 'u', displayName: 'A', startMs: 0, endMs: 1, text: 'Vecks opens it' }]);

  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId, wrong: 'Vecks', right: 'Vex' },
    db,
    cfg,
  });

  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.changed, 1);
  assert.equal(db.listUtterances(mine)[0].text, 'Vex opens it');
  assert.equal(db.listUtterances(theirs)[0].text, 'Vecks opens it', 'the other table is untouched');
  assert.deepEqual(db.listCorrections(other), []);
});

test('a correction that changes nothing is refused before it is saved', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  for (const body of [
    { campaignId, wrong: 'Vex', right: 'vex' },
    { campaignId, wrong: '  ', right: 'Vex' },
    { campaignId, wrong: 'Vecks', right: '' },
  ]) {
    assert.equal(runAction({ pathname: '/actions/corrections/add', body, db, cfg }).payload.ok, false);
  }
  assert.deepEqual(db.listCorrections(campaignId), [], 'and none of them were stored');
});

test('removing a correction leaves the lines it already rewrote alone', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const meetingId = parked(db, 'summarize', campaignId).meetingId;
  db.finalizeTranscription(meetingId, [{ userId: 'u', displayName: 'A', startMs: 0, endMs: 1, text: 'Vecks' }]);

  runAction({ pathname: '/actions/corrections/add', body: { campaignId, wrong: 'Vecks', right: 'Vex' }, db, cfg });
  const res = runAction({ pathname: '/actions/corrections/remove', body: { campaignId, wrong: 'Vecks' }, db, cfg });

  assert.equal(res.payload.ok, true);
  assert.deepEqual(db.listCorrections(campaignId), []);
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vex', 'undoing the rule is not undoing the rewrite');
});

test('removing a correction that was never saved says so', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = runAction({ pathname: '/actions/corrections/remove', body: { campaignId, wrong: 'Nope' }, db, cfg });
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /No saved correction/);
});

// The case replay exists for: a transcript that arrived AFTER the rule was
// saved, which addCorrection's own one-off rewrite could not have reached.
test('replaying corrections catches a transcript that arrived after the rule', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  runAction({ pathname: '/actions/corrections/add', body: { campaignId, wrong: 'Vecks', right: 'Vex' }, db, cfg });

  const late = parked(db, 'summarize', campaignId).meetingId;
  db.raw
    .prepare(`UPDATE utterances SET text = 'Vecks arrives late' WHERE meeting_id = ?`)
    .run(late);

  const res = runAction({ pathname: '/actions/corrections/replay', body: { campaignId }, db, cfg });
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.changed, 1);
  assert.equal(db.listUtterances(late)[0].text, 'Vex arrives late');
});

test('replaying every rule rewrites a line once, not once per rule', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  db.addCorrection(campaignId, 'Vecks', 'Vex');
  db.addCorrection(campaignId, 'Kaylen', 'Kaelen');

  const meetingId = parked(db, 'summarize', campaignId).meetingId;
  db.raw.prepare(`UPDATE utterances SET text = 'Vecks and Kaylen argue' WHERE meeting_id = ?`).run(meetingId);

  const res = runAction({ pathname: '/actions/corrections/replay', body: { campaignId }, db, cfg });
  assert.equal(res.payload.changed, 1, 'one line changed, however many rules touched it');
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vex and Kaelen argue');
});

test('replaying with nothing saved is refused rather than reported as work', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = runAction({ pathname: '/actions/corrections/replay', body: { campaignId }, db, cfg });
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /no corrections saved/i);
});

// --- where the notes are delivered ---

test('the destination can be moved to a DM and back', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  assert.equal(runAction({ pathname: '/actions/campaign/output', body: { campaignId, mode: 'dm' }, db, cfg }).payload.ok, true);
  assert.equal(db.getCampaign(campaignId).output_mode, 'dm');

  assert.equal(runAction({ pathname: '/actions/campaign/output', body: { campaignId, mode: 'default' }, db, cfg }).payload.ok, true);
  assert.equal(db.getCampaign(campaignId).output_mode, null, 'null is what the delivery code reads as "where we played"');
});

// 'channel' needs a channel id and a list of channels the bot may post in.
// Only Discord can answer that, so the dashboard must not pretend it can.
test('choosing a specific channel is refused here and pointed at Discord', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = runAction({ pathname: '/actions/campaign/output', body: { campaignId, mode: 'channel' }, db, cfg });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /campaign output/);
  assert.equal(db.getCampaign(campaignId).output_mode, null, 'and nothing was changed');
});

test('a DM destination is refused when nobody manages the campaign', async (t) => {
  const { db, cfg } = await harness(t);
  const orphan = db.createCampaign('guild-9', 'Unclaimed', null);
  const res = runAction({ pathname: '/actions/campaign/output', body: { campaignId: orphan, mode: 'dm' }, db, cfg });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /Nobody manages/);
});

// --- looking again at the machines ---

test('the health probe is asked for, not performed inline', async (t) => {
  const { db, cfg } = await harness(t);
  let asked = 0;

  const res = runAction({
    pathname: '/actions/health/probe',
    body: {},
    db,
    cfg,
    ctx: { probeNow: () => { asked += 1; } },
  });

  assert.equal(res.status, 202, 'accepted — the answer arrives in the next poll, not in this response');
  assert.equal(asked, 1);
});

test('a bot with no probe hook says so rather than failing silently', async (t) => {
  const { db, cfg } = await harness(t);
  const res = runAction({ pathname: '/actions/health/probe', body: {}, db, cfg, ctx: {} });
  assert.equal(res.payload.ok, false);
});

// A username is not an id. Without this, a typo silently creates a roster
// entry for a person who does not exist, and the real player still has none.
test('a roster action refuses anything that is not a Discord id', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  for (const who of ['matthew', '', 'user#1234', '12', 'abc123456789']) {
    const res = runAction({
      pathname: '/actions/roster/character',
      body: { campaignId, userId: who, name: 'Vex' },
      db,
      cfg,
    });
    assert.equal(res.status, 400, `${JSON.stringify(who)} should be refused`);
  }
});

test('naming a player enrols them but does not consent for them', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';

  const res = runAction({
    pathname: '/actions/roster/character',
    body: { campaignId, userId: who, name: 'Vex' },
    db,
    cfg,
  });

  assert.equal(res.payload.ok, true);
  assert.equal(db.getCharacterName(campaignId, who), 'Vex');
  assert.equal(db.isCampaignMember(campaignId, who), true, 'naming someone puts them at the table');
  assert.equal(db.mayRecord(campaignId, who), false, 'but being added by someone else is not agreeing');
  assert.match(res.payload.message, /not agreed to be recorded/, 'and the dashboard is told so plainly');
});

test('forgetting a character keeps the player on the roster', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';
  runAction({ pathname: '/actions/roster/character', body: { campaignId, userId: who, name: 'Vex' }, db, cfg });

  const res = runAction({ pathname: '/actions/roster/forget', body: { campaignId, userId: who }, db, cfg });
  assert.equal(res.payload.ok, true);
  assert.equal(db.getCharacterName(campaignId, who), null);
  assert.equal(db.isCampaignMember(campaignId, who), true);
});

// --- re-summarising ---

test('a session with no transcript cannot be summarised', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { meetingId } = parked(db, 'transcribe', campaignId);

  const res = runAction({ pathname: '/actions/summary/again', body: { meetingId }, db, cfg });
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /no transcript yet/);
});

test('re-summarising a transcribed session queues it rather than duplicating the job', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { meetingId } = parked(db, 'summarize', campaignId);

  runAction({ pathname: '/actions/summary/again', body: { meetingId }, db, cfg });
  runAction({ pathname: '/actions/summary/again', body: { meetingId }, db, cfg });

  const jobs = db.listPendingJobs().filter((j) => j.meeting_id === meetingId && j.type === 'summarize');
  assert.equal(jobs.length, 1, 'twice must not post the session twice');
  assert.equal(jobs[0].status, 'pending');
});

// --- importing a recording made somewhere else ---

test('an import is refused without a plausible URL and a real campaign', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const ctx = { activeSessions: new Map(), startImport: () => assert.fail('should not have started') };

  for (const body of [
    { campaignId },
    { campaignId, url: 'not-a-url' },
    { campaignId, url: 'file:///etc/passwd' },
    { campaignId: 9999, url: 'https://example.com/a.mp3' },
    { url: 'https://example.com/a.mp3' },
  ]) {
    assert.notEqual(runAction({ pathname: '/actions/import', body, db, cfg, ctx }).status, 202);
  }
});

test('an import will not start on top of a live recording', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const ctx = {
    activeSessions: new Map([['guild-1', { meetingId: 1 }]]),
    startImport: () => assert.fail('two recordings would interleave into one audio pipeline'),
  };

  const res = runAction({
    pathname: '/actions/import',
    body: { campaignId, url: 'https://example.com/session.mp3' },
    db,
    cfg,
    ctx,
  });
  assert.equal(res.status, 409);
});

// Started, not awaited: an hours-long recording cannot be transcribed inside
// an HTTP request, and the Discord version spent real effort fighting the
// 15-minute interaction window to pretend otherwise.
test('an import is accepted and left running rather than awaited', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const started = [];
  const ctx = { activeSessions: new Map(), startImport: (args) => started.push(args) };

  const res = runAction({
    pathname: '/actions/import',
    body: { campaignId, url: 'https://example.com/session.mp3', speaker: 'The Table' },
    db,
    cfg,
    ctx,
  });

  assert.equal(res.status, 202, 'accepted, not completed');
  assert.equal(started.length, 1);
  assert.equal(started[0].speakerLabel, 'The Table');
  assert.equal(started[0].guildId, 'guild-1', 'filed against the campaign it was named for');
});

// --- discarding a session that never had anything in it ---
//
// A recording where nobody was recordable produces a meeting with no audio, no
// transcript, and a job that fails with "produced nothing usable" and retries
// on the schedule forever — because nothing that could happen would make it
// succeed. The guard is what makes a delete button safe: emptiness is part of
// the DELETE's own WHERE, so there is no gap between checking and deleting in
// which a real session could appear.

test('an empty failed session can be thrown away, and stops retrying', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { meetingId, jobId } = parked(db, 'transcribe', campaignId);

  const res = runAction({ pathname: '/actions/session/discard', body: { meetingId }, db, cfg });

  assert.equal(res.payload.ok, true);
  assert.equal(db.getMeeting(meetingId), undefined, 'the meeting is gone');
  assert.equal(db.getJob(jobId), undefined, 'and so is the job that kept retrying it');
});

test('a session with a transcript cannot be discarded, whatever its status', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const { meetingId } = parked(db, 'summarize', campaignId);
  db.setMeetingStatus(meetingId, 'transcription_failed');

  const res = runAction({ pathname: '/actions/session/discard', body: { meetingId }, db, cfg });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /not empty/);
  assert.ok(db.getMeeting(meetingId), "somebody's evening is not a delete button's business");
  assert.equal(db.listUtterances(meetingId).length, 1);
});

test('discarding something that does not exist says so', async (t) => {
  const { db, cfg } = await harness(t);
  const res = runAction({ pathname: '/actions/session/discard', body: { meetingId: 4242 }, db, cfg });
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /No such session/);
});

// --- inviting somebody from the dashboard ---
//
// The one action whose effect is a message to a human being. It must not
// report success before Discord has accepted the DM, and it must not record an
// invite that nobody can see.

const bridge = (overrides = {}) => ({
  discord: {
    findPeople: async () => ({ ok: true, people: [] }),
    invite: async () => ({ ok: true, message: 'sent' }),
    ...overrides,
  },
});

test('an invite refuses anything that is not a Discord id', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  for (const who of ['matthew', '', 'user#1234', '12']) {
    const res = await runAction({
      pathname: '/actions/roster/invite',
      body: { campaignId, userId: who },
      db, cfg, ctx: bridge(),
    });
    assert.equal(res.status, 400, `${JSON.stringify(who)} should be refused`);
  }
});

test('an invite reports the DM failing rather than claiming it was sent', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = await runAction({
    pathname: '/actions/roster/invite',
    body: { campaignId, userId: '175407464513011713' },
    db, cfg,
    ctx: bridge({ invite: async () => ({ ok: false, message: "📪 I couldn't DM them" }) }),
  });

  assert.equal(res.status, 400);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /couldn't DM/);
});

test('a bot with no Discord connection says so instead of failing silently', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = await runAction({
    pathname: '/actions/roster/invite',
    body: { campaignId, userId: '175407464513011713' },
    db, cfg, ctx: {},
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /cannot send invitations/);
});

test('searching for people needs a real campaign', async (t) => {
  const { db, cfg } = await harness(t);
  const res = await runAction({
    pathname: '/actions/roster/search',
    body: { campaignId: 9999, query: 'saf' },
    db, cfg, ctx: bridge(),
  });

  assert.equal(res.status, 400);
  assert.match(res.payload.message, /No such campaign/);
});

test('a search is scoped to the campaign\'s own server', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  let askedFor = null;

  await runAction({
    pathname: '/actions/roster/search',
    body: { campaignId, query: 'saf' },
    db, cfg,
    ctx: bridge({
      findPeople: async (args) => { askedFor = args; return { ok: true, people: [] }; },
    }),
  });

  assert.equal(askedFor.guildId, 'guild-1', 'never a server the campaign does not belong to');
  assert.equal(askedFor.query, 'saf');
});

// An async handler that rejects must be caught by the same net as a sync one:
// this port can be published and must never return a stack trace.
test('an async action that rejects answers 500 without leaking the error', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = await runAction({
    pathname: '/actions/roster/invite',
    body: { campaignId, userId: '175407464513011713' },
    db, cfg,
    ctx: bridge({ invite: async () => { throw new Error('DiscordAPIError: token 4nT0k3n invalid'); } }),
  });

  assert.equal(res.status, 500);
  assert.doesNotMatch(res.payload.message, /4nT0k3n|DiscordAPIError/);
});

// Synchronous actions must keep working exactly as they did — the whole point
// of not making runAction async was that every existing caller stays valid.
test('a synchronous action still returns without a promise', async (t) => {
  const { db, cfg } = await harness(t);
  const res = runAction({ pathname: '/actions/pause', body: { queue: 'summarize', paused: true }, db, cfg });

  assert.equal(typeof res.then, 'undefined', 'still a plain result');
  assert.equal(res.payload.ok, true);
});
