import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startTranscription,
  updateTranscription,
  endTranscription,
  getTranscription,
  listTranscriptions,
  estimateRemainingMs,
  formatDuration,
  describeTranscription,
  resetProgress,
} from '../src/pipeline/progress.js';

beforeEach(() => resetProgress());

const T0 = 1_000_000;

test('the estimate comes from the rate actually observed', () => {
  startTranscription(7, 100, T0);
  // 10 clips in 10s = 1s each, so the other 90 should read as ~90s.
  updateTranscription(7, 10, 100, T0 + 10_000);
  assert.equal(estimateRemainingMs(getTranscription(7), T0 + 10_000), 90_000);
});

// A number invented from a single data point would be wildly wrong, and people
// plan their evening around it — "estimating…" is the honest answer.
test('no estimate is offered before there is anything to extrapolate from', () => {
  startTranscription(1, 50, T0);
  assert.equal(estimateRemainingMs(getTranscription(1), T0), null, 'nothing done yet');
  assert.equal(estimateRemainingMs(null), null);
  assert.equal(estimateRemainingMs({ done: 5, total: 0, startedAt: T0 }, T0 + 1000), null, 'unknown total');
});

test('a finished run reports zero rather than a negative estimate', () => {
  startTranscription(2, 10, T0);
  updateTranscription(2, 10, 10, T0 + 5_000);
  assert.equal(estimateRemainingMs(getTranscription(2), T0 + 5_000), 0);
});

// The Pi case: slow enough that the answer is measured in hours, which is
// exactly why the ETA exists.
test('a slow CPU run is reported in hours, not a huge minute count', () => {
  startTranscription(3, 480, T0);
  updateTranscription(3, 10, 480, T0 + 600_000); // 60s per clip
  const remaining = estimateRemainingMs(getTranscription(3), T0 + 600_000);
  assert.equal(remaining, 470 * 60_000);
  assert.equal(formatDuration(remaining), '7h 50m');
});

test('durations read the way a person would say them', () => {
  assert.equal(formatDuration(30_000), 'under a minute');
  assert.equal(formatDuration(90_000), '2m');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(5_400_000), '1h 30m');
  assert.equal(formatDuration(null), 'unknown');
  assert.equal(formatDuration(NaN), 'unknown');
});

test('progress is tracked per meeting and cleared when it ends', () => {
  startTranscription(1, 10, T0);
  startTranscription(2, 20, T0);
  assert.equal(listTranscriptions().length, 2);

  endTranscription(1);
  assert.equal(getTranscription(1), null);
  assert.deepEqual(
    listTranscriptions().map((e) => e.meetingId),
    [2]
  );
});

// finishSession clears progress in a finally block; if that ever regressed,
// /status would show a session transcribing forever.
test('an update for an unknown meeting starts tracking rather than being lost', () => {
  updateTranscription(99, 3, 10, T0);
  assert.equal(getTranscription(99).total, 10);
});

test('the status line carries count, percentage and ETA together', () => {
  startTranscription(5, 100, T0);
  updateTranscription(5, 25, 100, T0 + 25_000);
  const line = describeTranscription(getTranscription(5), T0 + 25_000);
  assert.match(line, /25\/100/);
  assert.match(line, /25%/);
  assert.match(line, /1m left/);
});

test('the status line says it is estimating rather than showing a fake ETA', () => {
  startTranscription(6, 100, T0);
  assert.match(describeTranscription(getTranscription(6), T0), /estimating/);
});
