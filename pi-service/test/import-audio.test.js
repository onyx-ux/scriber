import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentsToUtterances } from '../src/pipeline/import-audio.js';

const seg = (text, fromMs, toMs) => ({ text, fromMs, toMs });

test('short segments are merged into readable utterances', () => {
  const out = segmentsToUtterances(
    [seg('The party', 0, 500), seg('opens the door.', 500, 1200), seg('Roll initiative.', 1200, 2000)],
    'Table',
    { maxChars: 400 }
  );

  assert.equal(out.length, 1, 'whisper emits half-sentences; one row each would be unreadable');
  assert.equal(out[0].text, 'The party opens the door. Roll initiative.');
  assert.equal(out[0].startMs, 0);
  assert.equal(out[0].endMs, 2000, 'the merged row spans to the last segment');
});

test('merging stops at the length cap', () => {
  const out = segmentsToUtterances([seg('a'.repeat(300), 0, 1000), seg('b'.repeat(300), 1000, 2000)], 'Table', {
    maxChars: 400,
  });
  assert.equal(out.length, 2);
  assert.equal(out[1].startMs, 1000, 'the second row starts at its own offset');
});

test('every row carries the speaker label, since one track cannot be diarised', () => {
  const out = segmentsToUtterances([seg('one', 0, 1), seg('two', 5000, 6000)], 'The Table', { maxChars: 3 });
  assert.deepEqual([...new Set(out.map((u) => u.displayName))], ['The Table']);
  assert.deepEqual([...new Set(out.map((u) => u.userId))], ['imported']);
});

test('offsets are preserved so the transcript timestamps line up', () => {
  const out = segmentsToUtterances([seg('later line', 3_600_000, 3_601_000)], 'Table');
  assert.equal(out[0].startMs, 3_600_000);
});

test('no segments yields no utterances rather than a bogus empty row', () => {
  assert.deepEqual(segmentsToUtterances([], 'Table'), []);
});
