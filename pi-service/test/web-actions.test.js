import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { runAction, findAction, ACTIONS } from '../src/web/actions.js';
import { buildTranscriptView } from '../src/web/transcript-view.js';
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
      'access/dismiss',
      'access/invite',
      'access/level',
      'access/revoke',
      'access/tier',
      'access/uninvite',
      'campaign/create',
      'campaign/delete',
      'campaign/edition',
      'campaign/manager',
      'campaign/output',
      'campaign/restore',
      'campaign/restore-review',
      'corrections/add',
      'corrections/remove',
      'corrections/replay',
      'health/probe',
      'import',
      'invite/accept',
      'invite/link',
      'invite/peek',
      'invite/revoke',
      'model/choose',
      'pause',
      'recap/note',
      'recap/note-edit',
      'recap/note-remove',
      'roster/character',
      'roster/colour',
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

// 'channel' needs a channel id AND Discord's own list of where this bot may
// speak. The id is never taken on trust: every test below is about what happens
// when the two disagree.

// One bridge, answering whatever this test wants it to answer.
const listing = (channels) => ({
  discord: {
    listChannels: async () =>
      channels === null ? { ok: false, message: 'no' } : { ok: true, channels },
  },
});

test('a channel on the list is chosen, and named back in the bot’s own words', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const ctx = listing([{ id: '900000000000000001', name: 'session-notes', category: 'Text Channels' }]);

  const res = await runAction({
    pathname: '/actions/campaign/output',
    body: { campaignId, mode: 'channel', channelId: '900000000000000001' },
    db, cfg, ctx,
  });

  assert.equal(res.payload.ok, true);
  assert.match(res.payload.message, /#session-notes/, 'named, not left as an eighteen-digit id');

  const saved = db.getCampaign(campaignId);
  assert.equal(saved.output_mode, 'channel');
  assert.equal(saved.output_channel_id, '900000000000000001');
});

test('a channel Discord did not list is refused, however well formed', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const ctx = listing([{ id: '900000000000000001', name: 'session-notes', category: null }]);

  const res = await runAction({
    pathname: '/actions/campaign/output',
    // A perfectly plausible snowflake that is simply not one of ours.
    body: { campaignId, mode: 'channel', channelId: '900000000000000009' },
    db, cfg, ctx,
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /cannot post in that channel/i);
  assert.equal(db.getCampaign(campaignId).output_mode, null, 'and nothing was changed');
});

// The distinction the whole guard rests on: "Discord said you may not post
// there" and "nobody managed to ask Discord" are different answers, and only
// the second one means the setting should be left exactly as it was.
test('an unreachable Discord changes nothing rather than trusting the browser', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  const res = await runAction({
    pathname: '/actions/campaign/output',
    body: { campaignId, mode: 'channel', channelId: '900000000000000001' },
    db, cfg, ctx: listing(null),
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /could not ask Discord/i);
  assert.equal(db.getCampaign(campaignId).output_mode, null);
});

test('a bot with no Discord bridge at all refuses the same way', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const res = await runAction({
    pathname: '/actions/campaign/output',
    body: { campaignId, mode: 'channel', channelId: '900000000000000001' },
    db, cfg,
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /could not ask Discord/i);
});

test('choosing "a channel" without saying which is refused', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const ctx = listing([{ id: '900000000000000001', name: 'session-notes', category: null }]);

  const res = await runAction({
    pathname: '/actions/campaign/output', body: { campaignId, mode: 'channel' }, db, cfg, ctx,
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /Which channel/i);
});

// A stale id is not harmless: switching back to 'channel' from Discord would
// otherwise silently resume posting somewhere nobody has looked at in months.
test('moving off a channel clears the channel, rather than leaving it behind', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const ctx = listing([{ id: '900000000000000001', name: 'session-notes', category: null }]);

  await runAction({
    pathname: '/actions/campaign/output',
    body: { campaignId, mode: 'channel', channelId: '900000000000000001' },
    db, cfg, ctx,
  });
  assert.equal(db.getCampaign(campaignId).output_channel_id, '900000000000000001');

  runAction({ pathname: '/actions/campaign/output', body: { campaignId, mode: 'dm' }, db, cfg });
  assert.equal(db.getCampaign(campaignId).output_channel_id, null);
});

// Discord is asked for exactly one thing here, and only when the answer could
// change what gets written. Making the write-ups private must not depend on the
// gateway being up.
test('only a channel destination goes to Discord at all', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  let asked = 0;
  const ctx = { discord: { listChannels: async () => { asked += 1; return { ok: true, channels: [] }; } } };

  runAction({ pathname: '/actions/campaign/output', body: { campaignId, mode: 'dm' }, db, cfg, ctx });
  runAction({ pathname: '/actions/campaign/output', body: { campaignId, mode: 'default' }, db, cfg, ctx });
  assert.equal(asked, 0);

  await runAction({
    pathname: '/actions/campaign/output',
    body: { campaignId, mode: 'channel', channelId: '900000000000000001' }, db, cfg, ctx,
  });
  assert.equal(asked, 1);
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

// --- what colour a voice is written in ---

test('a colour from the palette is stored against the person, per campaign', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';

  const res = runAction({
    pathname: '/actions/roster/colour',
    body: { campaignId, userId: who, colour: 'eldritch-deep' },
    db,
    cfg,
  });

  assert.equal(res.payload.ok, true);
  assert.equal(db.getVoiceColour(campaignId, who), 'eldritch-deep');
  assert.deepEqual(db.listVoiceColours(campaignId), { [who]: 'eldritch-deep' });
});

test('picking a colour does not put anybody at the table', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';

  runAction({ pathname: '/actions/roster/colour', body: { campaignId, userId: who, colour: 'gold-bright' }, db, cfg });

  // The one way this differs from roster/character beside it. Naming a
  // character is a claim about who plays here; choosing a colour is a claim
  // about nothing, and enrolling somebody as a side effect of a preference
  // would put a name on the list the DM reads as "these are my players".
  assert.equal(db.isCampaignMember(campaignId, who), false);
});

test('a colour that is not in the palette is refused, and nothing is stored', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';

  for (const bad of [
    'chartreuse',
    'red',
    'red-deepish',
    'red-deep red-bright',
    'red-deep" onmouseover="x',
    '#ff0000',
  ]) {
    const res = runAction({ pathname: '/actions/roster/colour', body: { campaignId, userId: who, colour: bad }, db, cfg });
    assert.equal(res.payload.ok, false, bad);
    assert.equal(res.status, 400, bad);
    assert.equal(db.getVoiceColour(campaignId, who), null, bad);
  }
});

test('an empty colour clears the one on file rather than being refused', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';
  runAction({ pathname: '/actions/roster/colour', body: { campaignId, userId: who, colour: 'ocean-deep' }, db, cfg });

  const res = runAction({ pathname: '/actions/roster/colour', body: { campaignId, userId: who, colour: '' }, db, cfg });
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.colour, null);
  assert.equal(db.getVoiceColour(campaignId, who), null);
});

test('the same person can be a different colour at each of their tables', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const other = db.createCampaign('guild-2', 'Ashfall', 'dm-2');
  const who = '175407464513011713';

  runAction({ pathname: '/actions/roster/colour', body: { campaignId, userId: who, colour: 'red-deep' }, db, cfg });
  runAction({ pathname: '/actions/roster/colour', body: { campaignId: other, userId: who, colour: 'blue-bright' }, db, cfg });

  assert.equal(db.getVoiceColour(campaignId, who), 'red-deep');
  assert.equal(db.getVoiceColour(other, who), 'blue-bright');
});

test('leaving a table takes the colour with you', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const who = '175407464513011713';
  runAction({ pathname: '/actions/roster/character', body: { campaignId, userId: who, name: 'Vex' }, db, cfg });
  runAction({ pathname: '/actions/roster/colour', body: { campaignId, userId: who, colour: 'silver-deep' }, db, cfg });

  db.removeFromCampaign(campaignId, who);

  // Coming back later should be a fresh choice, the same way consent is —
  // not a colour they cannot remember agreeing to.
  assert.equal(db.getVoiceColour(campaignId, who), null);
});

test('the transcript carries the colour of each speaker, and null where there is none', async (t) => {
  const { db, campaignId } = await harness(t);
  const { meetingId } = parked(db, 'summarise', campaignId);

  // Set through the store rather than the action: parked() files its one
  // utterance under the speaker id 'someone', and roster/colour quite
  // rightly refuses anything that is not a Discord snowflake. What is being
  // asked here is whether the READER carries the colour, which is a different
  // question from who may set one.
  db.setVoiceColour(campaignId, 'someone', 'green-bright');
  const view = buildTranscriptView({ db, meetingId });
  assert.equal(view.speakers.find((s) => s.userId === 'someone').colour, 'green-bright');

  db.setVoiceColour(campaignId, 'someone', null);
  assert.equal(buildTranscriptView({ db, meetingId }).speakers[0].colour, null);
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
    // The guard asks about the CAMPAIGN, not its Discord: with a second bot,
    // another table in the same server being mid-session says nothing about
    // whether this one's audio pipeline is free.
    activeSessions: new Map([[1, { meetingId: 1, guildId: 'guild-1', campaignId }]]),
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

// --- the invite link ---
//
// The other way onto a roster, and the one that hands a stranger a URL. What is
// pinned here is the three things that would make it a hole: a token that can be
// guessed at by elimination, an acceptance that records somebody other than the
// person doing the accepting, and a "yes" that was never actually said.

const SEATED = '175407464513011713';
const SOMEBODY_ELSE = '175407464513011799';
const seated = (userId = SEATED) => ({ viewer: { userId, can: {} } });

async function linkFor(db, cfg, campaignId, ctx = seated()) {
  const res = await runAction({ pathname: '/actions/invite/link', body: { campaignId }, db, cfg, ctx });
  return res.payload.token;
}

test('one campaign has one link, however many times it is asked for', async (t) => {
  const { db, cfg, campaignId } = await harness(t);

  const first = await runAction({ pathname: '/actions/invite/link', body: { campaignId }, db, cfg, ctx: seated() });
  const again = await runAction({ pathname: '/actions/invite/link', body: { campaignId }, db, cfg, ctx: seated() });

  assert.equal(first.payload.ok, true);
  assert.match(first.payload.token, /^[A-Za-z0-9_-]{20,}$/, 'random enough not to be walked through');
  assert.equal(again.payload.token, first.payload.token, 'a second press is "show me the link", not "make another"');
  assert.equal(first.payload.url, null, 'no DASHBOARD_URL means no address rather than half of one');
});

test('a link says which table it is for, and nothing else about it', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);

  const res = await runAction({ pathname: '/actions/invite/peek', body: { token }, db, cfg, ctx: seated() });

  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.campaignName, 'Cipher');
  assert.equal(res.payload.alreadyIn, false);
  assert.equal(res.payload.characterName, null);
  assert.ok(!('people' in res.payload) && !('sessions' in res.payload), 'a token is not a key to the campaign');
});

test('a token that was never one is refused in the same words as a revoked one', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);
  await runAction({ pathname: '/actions/invite/revoke', body: { campaignId }, db, cfg, ctx: seated() });

  const pulled = await runAction({ pathname: '/actions/invite/peek', body: { token }, db, cfg, ctx: seated() });
  const invented = await runAction({
    pathname: '/actions/invite/peek', body: { token: 'not-a-token-at-all' }, db, cfg, ctx: seated(),
  });

  assert.equal(pulled.status, 404);
  assert.equal(invented.status, 404);
  assert.equal(pulled.payload.message, invented.payload.message, 'telling them apart tells a stranger which guesses were warm');
});

test('an expired link is dead even though nobody revoked it', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  db.createInviteLink({
    token: 'last-week', campaignId, createdBy: 'dm-1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const res = await runAction({ pathname: '/actions/invite/peek', body: { token: 'last-week' }, db, cfg, ctx: seated() });
  assert.equal(res.status, 404);
});

test('accepting records the session, never a user id from the body', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);

  const res = await runAction({
    pathname: '/actions/invite/accept',
    // The body names somebody else, twice over. It is ignored both times.
    body: { token, consent: true, name: 'Marn', userId: SOMEBODY_ELSE, campaignId: 9999 },
    db, cfg, ctx: seated(),
  });

  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.recorded, true);
  assert.equal(db.mayRecord(campaignId, SEATED), true);
  assert.equal(db.getCharacterName(campaignId, SEATED), 'Marn');
  assert.equal(db.mayRecord(campaignId, SOMEBODY_ELSE), false, "the body cannot consent on anyone else’s behalf");
});

test('anything but a literal yes is recorded as a no', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);

  for (const consent of [undefined, null, 'true', 1, 'yes', {}]) {
    const res = await runAction({
      pathname: '/actions/invite/accept',
      body: { token, consent, name: 'Marn' },
      db, cfg, ctx: seated(),
    });
    assert.equal(res.payload.recorded, false, `${JSON.stringify(consent)} is not agreement`);
    assert.equal(db.mayRecord(campaignId, SEATED), false);
  }
});

test('declining is an answer on file rather than silence', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);

  await runAction({ pathname: '/actions/invite/accept', body: { token, consent: false }, db, cfg, ctx: seated() });

  assert.equal(db.getConsent(campaignId, SEATED)?.state, 'declined');
});

// Somebody who will not be recorded is still at the table, and whoever runs it
// still has to know who they are. The two facts are separate rows and the
// capture path only ever asks the second one.
test('a declined player is still named, and still not recorded', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);

  const res = await runAction({
    pathname: '/actions/invite/accept',
    body: { token, consent: false, name: 'Orrin Vale' },
    db, cfg, ctx: seated(),
  });

  assert.equal(res.payload.recorded, false);
  assert.equal(res.payload.characterName, 'Orrin Vale');
  assert.equal(db.getCharacterName(campaignId, SEATED), 'Orrin Vale', 'the table knows who they are');
  assert.equal(db.mayRecord(campaignId, SEATED), false, 'and still never records them');
  assert.equal(db.getConsent(campaignId, SEATED)?.state, 'declined', 'naming did not overwrite the answer');
});

test('a link cannot be accepted by somebody with no Discord session', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);

  // The operator's own console: `everything`, and no account to consent as.
  const res = await runAction({
    pathname: '/actions/invite/accept',
    body: { token, consent: true, name: 'Marn' },
    db, cfg, ctx: { viewer: { userId: null, can: { everything: true } } },
  });

  assert.equal(res.status, 403);
  assert.equal(db.listConsent(campaignId).length, 0, 'agreeing to be recorded is not the owner to do');
});

test('somebody already at the table is told so rather than asked again', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const token = await linkFor(db, cfg, campaignId);
  db.setConsent(campaignId, SEATED, true);
  db.setCharacterName(campaignId, SEATED, 'Marn');

  const res = await runAction({ pathname: '/actions/invite/peek', body: { token }, db, cfg, ctx: seated() });

  assert.equal(res.payload.alreadyIn, true);
  assert.equal(res.payload.characterName, 'Marn');
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

// --- the blast radius of one correction ---
//
// Found the hard way, on live data: "a" -> "b" passes every other check, and
// because the rewriter is word-boundary anchored it replaced every standalone
// "a" in 1,011 of a campaign's 6,844 lines. There is no undoing that — you
// cannot tell afterwards which "b" used to be an "a" — and it took a restore
// from a snapshot to get the transcripts back.

async function loaded(db, campaignId, lines) {
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'Voice Chat',
    startedAt: new Date().toISOString(), audioDir: '/tmp',
  });
  db.finalizeTranscription(
    meetingId,
    Array.from({ length: lines }, (_, i) => ({
      userId: 'u', displayName: 'A', startMs: i, endMs: i + 1,
      text: i % 2 === 0 ? 'she found a door in the wall' : 'nothing of interest here',
    }))
  );
  return meetingId;
}

test('a correction that would rewrite a quarter of the campaign is refused', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  await loaded(db, campaignId, 400);

  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId, wrong: 'a', right: 'b' },
    db, cfg,
  });

  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.needsConfirming, true);
  assert.equal(res.payload.wouldChange, 200);
  assert.match(res.payload.message, /cannot be undone/);
  assert.deepEqual(db.listCorrections(campaignId), [], 'and nothing was saved');
  assert.match(db.listUtterances(1)[0].text, /found a door/, 'and nothing was rewritten');
});

test('confirming it explicitly still lets it through', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  await loaded(db, campaignId, 400);

  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId, wrong: 'a', right: 'b', force: true },
    db, cfg,
  });

  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.changed, 200);
});

// A real name is distinctive, so the guard must never get in the way of the
// thing corrections exist for.
test('an ordinary name correction is unaffected', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  const meetingId = await loaded(db, campaignId, 400);
  db.raw.prepare(`UPDATE utterances SET text = 'Vecks opens the door' WHERE meeting_id = ? AND id % 7 = 0`).run(meetingId);

  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId, wrong: 'Vecks', right: 'Vex' },
    db, cfg,
  });

  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.changed > 0);
});

// A small campaign where three lines really are a quarter of everything must
// not be blocked — both thresholds have to be crossed.
test('a tiny campaign is not blocked by the fraction alone', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  await loaded(db, campaignId, 8);

  // "door" is in half these lines, which is far over the fraction — but four
  // lines is not a thousand, so the floor keeps the guard quiet.
  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId, wrong: 'door', right: 'gate' },
    db, cfg,
  });

  assert.equal(res.payload.ok, true, res.payload.message);
});

// The strong signal, and the one that would have caught the real incident:
// word-boundary matching on one or two characters hits articles and initials,
// never a name. The shortest real correction at this table is "Vex".
test('a one or two character term is refused however small the campaign', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  await loaded(db, campaignId, 6);

  for (const wrong of ['a', 'I', 'of']) {
    const res = runAction({
      pathname: '/actions/corrections/add',
      body: { campaignId, wrong, right: 'something' },
      db, cfg,
    });
    assert.equal(res.payload.ok, false, `"${wrong}" should be refused`);
    assert.match(res.payload.message, /too short/);
  }
  assert.deepEqual(db.listCorrections(campaignId), []);
});

// The exact shape of the real incident: 1,010 of 6,844 lines is 14.8%, which
// slipped under a quarter. The floor is what catches it.
test('the real incident would now be refused', async (t) => {
  const { db, cfg, campaignId } = await harness(t);
  await loaded(db, campaignId, 6844);

  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId, wrong: 'door', right: 'gate' },
    db, cfg,
  });

  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.wouldChange, 3422);
  assert.deepEqual(db.listCorrections(campaignId), [], 'and nothing was written');
});

test('the dry run counts without changing anything', async (t) => {
  const { db, campaignId } = await harness(t);
  await loaded(db, campaignId, 100);
  const before = db.listUtterances(1).map((u) => u.text);

  const n = db.countRewrites(campaignId, (text) => text.replace(/\ba\b/g, 'b'));

  assert.equal(n, 50);
  assert.deepEqual(db.listUtterances(1).map((u) => u.text), before, 'counting is not rewriting');
  assert.equal(db.countUtterancesIn(campaignId), 100);
});

// A made-up campaign id used to write a correction row belonging to nothing:
// mayAct deferred to the action's validator, and the action did not have one.
// Nothing would ever read that row and nothing would clean it up — corrections
// has no foreign key to lean on.
test('a correction for a campaign that does not exist is refused', async (t) => {
  const { db, cfg } = await harness(t);

  const res = runAction({
    pathname: '/actions/corrections/add',
    body: { campaignId: 999999, wrong: 'Vecks', right: 'Vex' },
    db, cfg,
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /No such campaign/);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM corrections').get().n, 0, 'and no orphan row');
});

// --- corrections the table makes to a write-up -----------------------------
//
// The feature's whole safety claim is that none of these three can destroy
// anything. What is checked here is the other half: that they cannot be aimed
// at somebody else's words either.

async function withWriteUp(t) {
  const { db, cfg, campaignId } = await harness(t);
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.setSummary(meetingId, {
    tldr: 'They went through the front door.',
    scenes: [{ title: 'The queue', points: ['Wren stamped the writ.'] }],
    partyDecisions: [],
  });
  // ctx.viewer as the server builds it. `manage` alone is not enough — a
  // creator manages the campaigns they run and no others, and mayManage()
  // checks the list rather than the flag, which is the whole reason a creator
  // at one table cannot reach another.
  const as = (userId, manage = false) => ({
    viewer: {
      userId,
      can: { manage, everything: false },
      manageableCampaignIds: manage ? [campaignId] : [],
    },
  });
  return { db, cfg, campaignId, meetingId, as };
}

const correct = (db, cfg, ctx, body) =>
  runAction({ pathname: '/actions/recap/note', body, db, cfg, ctx });

test('a correction is anchored to the write-up rather than to what was sent', async (t) => {
  const { db, cfg, campaignId, meetingId, as } = await withWriteUp(t);

  const res = correct(db, cfg, as('saf'), {
    campaignId, meetingId, part: 'tldr', index: 0,
    // A caller claiming to strike out something the summariser never wrote.
    // The quote is what finds a moved line again, so taking it on trust would
    // let a correction attach itself to a line of its own invention.
    quoted: 'Something nobody said.',
    body: 'It was the side door.',
  });

  assert.equal(res.payload.ok, true);
  assert.equal(db.getRecapNote(res.payload.note.id).quoted, 'They went through the front door.');
});

test('a correction has to name a line that is really there', async (t) => {
  const { db, cfg, campaignId, meetingId, as } = await withWriteUp(t);

  for (const body of [
    { part: 'constructor', index: 0 },
    { part: 'scene:9', index: 0 },
    { part: 'tldr', index: 4 },
    { part: 'tldr', index: -1 },
  ]) {
    const res = correct(db, cfg, as('saf'), { campaignId, meetingId, ...body, body: 'no' });
    assert.equal(res.payload.ok, false, JSON.stringify(body));
  }
  assert.equal(db.countRecapNotes(meetingId), 0);
});

test('a correction cannot be written onto another table’s session', async (t) => {
  const { db, cfg, meetingId, as } = await withWriteUp(t);
  const other = db.createCampaign('guild-1', 'Somewhere else', 'dm-2');

  const res = correct(db, cfg, as('saf'), {
    campaignId: other, meetingId, part: 'tldr', index: 0, body: 'no',
  });

  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /not at that table/);
  assert.equal(db.countRecapNotes(meetingId), 0);
});

test('a correction on a night with no write-up yet is refused', async (t) => {
  const { db, cfg, campaignId, as } = await withWriteUp(t);
  const blank = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-08T19:00:00Z', audioDir: '/tmp',
  });

  const res = correct(db, cfg, as('saf'), { campaignId, meetingId: blank, part: 'tldr', index: 0, body: 'no' });
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.message, /no write-up/);
});

test('somebody else’s correction is not yours to change', async (t) => {
  const { db, cfg, campaignId, meetingId, as } = await withWriteUp(t);
  const { payload } = correct(db, cfg, as('saf'), { campaignId, meetingId, part: 'tldr', index: 0, body: 'Side door.' });

  const res = runAction({
    pathname: '/actions/recap/note-edit',
    body: { campaignId, noteId: payload.note.id, body: 'Something Saf never said.' },
    db, cfg, ctx: as('rhi'),
  });

  assert.equal(res.status, 403);
  assert.equal(db.getRecapNote(payload.note.id).body, 'Side door.');
});

// The bug this was written for: the removal was being done first and judged
// afterwards, so the null that means "the manager's override" was handed over
// by anybody whose id simply did not match — which is exactly the case it has
// to refuse.
test('a player cannot remove another player’s correction', async (t) => {
  const { db, cfg, campaignId, meetingId, as } = await withWriteUp(t);
  const { payload } = correct(db, cfg, as('saf'), { campaignId, meetingId, part: 'tldr', index: 0, body: 'Side door.' });

  const res = runAction({
    pathname: '/actions/recap/note-remove',
    body: { campaignId, noteId: payload.note.id },
    db, cfg, ctx: as('rhi'),
  });

  assert.equal(res.status, 403);
  assert.equal(db.countRecapNotes(meetingId), 1, 'it was removed before the answer was worked out');
});

test('whoever runs the table can take down a correction, and the line comes back', async (t) => {
  const { db, cfg, campaignId, meetingId, as } = await withWriteUp(t);
  const { payload } = correct(db, cfg, as('saf'), { campaignId, meetingId, part: 'tldr', index: 0, body: 'Side door.' });

  const res = runAction({
    pathname: '/actions/recap/note-remove',
    body: { campaignId, noteId: payload.note.id },
    db, cfg, ctx: as('dm-1', true),
  });

  assert.equal(res.payload.ok, true);
  assert.match(res.payload.message, /original line is back/);
  assert.equal(db.countRecapNotes(meetingId), 0);
  // And it really is back: the write-up was never touched.
  assert.match(db.getMeeting(meetingId).summary_json, /front door/);
});

test('every one of these says what it did', async (t) => {
  const { db, cfg, campaignId, meetingId, as } = await withWriteUp(t);
  const made = correct(db, cfg, as('saf'), { campaignId, meetingId, part: 'tldr', index: 0, body: 'Side door.' });
  const struck = correct(db, cfg, as('saf'), { campaignId, meetingId, part: 'scene:0', index: 0, body: '' });

  // server.js writes these to the audit log and the dashboard toasts them.
  // Without one the log reads "ok: undefined" and the toast says "HTTP 200".
  assert.match(made.payload.message, /Corrected in the opening/);
  assert.match(struck.payload.message, /Struck out of/);

  const edited = runAction({
    pathname: '/actions/recap/note-edit',
    body: { campaignId, noteId: made.payload.note.id, body: 'The side door.' },
    db, cfg, ctx: as('saf'),
  });
  assert.match(edited.payload.message, /Correction changed/);
});
