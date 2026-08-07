import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transcribeTick } from '../src/pipeline/transcribe-worker.js';

const cfg = {
  scheduleTimeZone: 'Australia/Brisbane',
  transcribeWindowStartHour: 8,
  transcribeWindowEndHour: 16,
  transcribeWeekdaysOnly: true,
  transcribeSnoozeHours: 24,
  ownerUserId: 'OWNER',
};

const WED_10AM = new Date('2026-08-05T00:00:00Z'); // inside the auto window
const WED_9PM = new Date('2026-08-05T11:00:00Z'); // outside it

// A stand-in for the parts of the db the tick touches, so the scheduling
// plumbing can be checked without a real GPU or a real Discord connection.
function fakeDb({ jobs = [], settings = {}, meetings } = {}) {
  const calls = { failed: [], notified: [] };
  return {
    calls,
    getSetting: (k) => settings[k],
    dueTranscribeJobs: () => jobs,
    getMeeting: (id) => (meetings ? meetings[id] : { id, channel_id: 'C1', guild_id: 'G1' }),
    failJobPermanently: (id, reason) => calls.failed.push({ id, reason }),
    markJobNotified: (id) => calls.notified.push(id),
  };
}

const job = (over = {}) => ({
  id: 1,
  meeting_id: 1,
  status: 'awaiting_approval',
  next_attempt_at: '2026-08-01T00:00:00.000Z',
  notified_at: null,
  ...over,
});

const spyRun = () => {
  const runs = [];
  const runJob = async (_db, _client, usedCfg, j) => runs.push({ jobId: j.id, cfg: usedCfg });
  return { runs, runJob };
};

const reachable = async () => true;
const unreachable = async () => false;

test('a paused worker does nothing at all, not even probe the PC', async () => {
  const db = fakeDb({ jobs: [job({ status: 'pending' })], settings: { transcribe_paused: 'true' } });
  const { runs, runJob } = spyRun();
  let probed = false;

  const result = await transcribeTick(db, null, cfg, {
    now: WED_10AM,
    probe: async () => ((probed = true), true),
    runJob,
  });

  assert.equal(result, null);
  assert.equal(runs.length, 0);
  assert.equal(probed, false, 'a paused worker should not be waking the PC up either');
});

test('an empty queue skips the probe', async () => {
  let probed = false;
  await transcribeTick(fakeDb({ jobs: [] }), null, cfg, {
    now: WED_10AM,
    probe: async () => ((probed = true), true),
    runJob: spyRun().runJob,
  });
  assert.equal(probed, false);
});

test('an approved job runs and the tick reports which one', async () => {
  const db = fakeDb({ jobs: [job({ status: 'pending' })] });
  const { runs, runJob } = spyRun();

  const result = await transcribeTick(db, null, cfg, { now: WED_10AM, probe: reachable, runJob });

  assert.equal(result, 1);
  assert.equal(runs.length, 1);
});

// Transcription monopolises the GPU; two at once just makes both slower and
// doubles the VRAM on a card someone may be gaming on.
test('only one job runs per tick even when several are due', async () => {
  const db = fakeDb({ jobs: [job({ id: 1, status: 'pending' }), job({ id: 2, meeting_id: 2, status: 'pending' })] });
  const { runs, runJob } = spyRun();

  await transcribeTick(db, null, cfg, { now: WED_10AM, probe: reachable, runJob });

  assert.deepEqual(runs.map((r) => r.jobId), [1]);
});

test('the PC is probed once per tick, not once per job', async () => {
  const db = fakeDb({ jobs: [job({ id: 1 }), job({ id: 2, meeting_id: 2 })] });
  let probes = 0;

  await transcribeTick(db, null, cfg, {
    now: WED_9PM, // outside the window, so nothing runs and both jobs are considered
    probe: async () => (probes++, true),
    runJob: spyRun().runJob,
  });

  assert.equal(probes, 1);
});

test('nothing runs at 9pm on a weeknight without approval', async () => {
  const db = fakeDb({ jobs: [job({ notified_at: WED_9PM.toISOString() })] });
  const { runs, runJob } = spyRun();

  await transcribeTick(db, null, cfg, { now: WED_9PM, probe: reachable, runJob });

  assert.equal(runs.length, 0, 'this is the entire point of the feature');
});

test('an unreachable PC runs nothing rather than falling back to the Pi', async () => {
  const db = fakeDb({ jobs: [job({ status: 'pending' })] });
  const { runs, runJob } = spyRun();

  const result = await transcribeTick(db, null, cfg, { now: WED_10AM, probe: unreachable, runJob });

  assert.equal(result, null);
  assert.equal(runs.length, 0);
});

// "Use the Pi instead" needs no PC, so gating it on the PC answering would
// make the escape hatch useless in exactly the case it exists for.
test('a job targeted at the Pi runs even with the PC switched off', async () => {
  const db = fakeDb({ jobs: [job({ status: 'pending' })], settings: { transcribe_target_1: 'pi' } });
  const { runs, runJob } = spyRun();

  await transcribeTick(db, null, cfg, { now: WED_10AM, probe: unreachable, runJob });

  assert.equal(runs.length, 1, 'the Pi does not need the PC to be awake');
});

test('a job whose meeting has been deleted is failed rather than retried forever', async () => {
  const db = fakeDb({ jobs: [job({ status: 'pending' })], meetings: {} });
  const { runs, runJob } = spyRun();

  await transcribeTick(db, null, cfg, { now: WED_10AM, probe: reachable, runJob });

  assert.equal(runs.length, 0);
  assert.equal(db.calls.failed.length, 1);
  assert.match(db.calls.failed[0].reason, /no longer exists/);
});

// An owner with DMs closed would otherwise generate a reminder attempt every
// single tick, forever.
test('a reminder is recorded even when the DM cannot be delivered', async () => {
  const db = fakeDb({ jobs: [job()] });
  const { runs, runJob } = spyRun();

  await transcribeTick(db, null, cfg, { now: WED_9PM, probe: reachable, runJob });

  assert.deepEqual(db.calls.notified, [1], 'no client is available here, so the DM cannot have succeeded');
  assert.equal(runs.length, 0);
});

test('a reminder does not consume the tick — a runnable job still gets to run', async () => {
  const db = fakeDb({
    jobs: [job({ id: 1, notified_at: null }), job({ id: 2, meeting_id: 2, status: 'pending' })],
  });
  const { runs, runJob } = spyRun();

  await transcribeTick(db, null, cfg, { now: WED_9PM, probe: reachable, runJob });

  assert.deepEqual(db.calls.notified, [1]);
  assert.deepEqual(runs.map((r) => r.jobId), [2], 'the approved job should not wait a whole minute behind a reminder');
});
