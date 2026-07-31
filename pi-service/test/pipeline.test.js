import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTranscriptText } from '../src/pipeline/transcribe.js';
import { withoutAlreadyKnown } from '../src/pipeline/queue-worker.js';
import { buildSessionBody } from '../src/delivery/discord-post.js';

test('buildTranscriptText orders by offset and formats timestamps', () => {
  const text = buildTranscriptText([
    { display_name: 'B', text: 'second', start_ms: 65_000 },
    { display_name: 'A', text: 'first', start_ms: 1_000 },
  ]);
  assert.equal(text, '[00:01] A: first\n[01:05] B: second');
});

// The comparator used to fall through to NaN when two rows shared a start_ms,
// which is implementation-defined ordering.
test('buildTranscriptText is stable when two lines share a timestamp', () => {
  const rows = [
    { display_name: 'A', text: 'one', start_ms: 1000 },
    { display_name: 'B', text: 'two', start_ms: 1000 },
  ];
  assert.doesNotThrow(() => buildTranscriptText(rows));
  assert.equal(buildTranscriptText(rows).split('\n').length, 2);
});

test('buildTranscriptText accepts in-flight camelCase utterances too', () => {
  assert.equal(buildTranscriptText([{ displayName: 'A', text: 'hi', startMs: 0 }]), '[00:00] A: hi');
});

test('withoutAlreadyKnown drops entities the campaign already recorded', () => {
  const filtered = withoutAlreadyKnown(
    {
      tldr: 'unchanged',
      npcsIntroduced: ['Vex the Bold, a smuggler', 'Mira the Cook — new this week'],
      locationsVisited: ['The Rusty Anchor (tavern)', 'Marrowgate Crypt'],
    },
    { npcs: new Set(['vex the bold']), locations: new Set(['the rusty anchor']) }
  );

  assert.deepEqual(filtered.npcsIntroduced, ['Mira the Cook — new this week']);
  assert.deepEqual(filtered.locationsVisited, ['Marrowgate Crypt']);
  assert.equal(filtered.tldr, 'unchanged', 'other fields are untouched');
});

test('withoutAlreadyKnown copes with missing arrays', () => {
  const filtered = withoutAlreadyKnown({ tldr: 't' }, { npcs: new Set(), locations: new Set() });
  assert.deepEqual(filtered.npcsIntroduced, []);
  assert.deepEqual(filtered.locationsVisited, []);
});

test('buildSessionBody omits empty sections', () => {
  const body = buildSessionBody({
    tldr: 'The party did a thing.',
    scenes: [],
    partyDecisions: [],
    unresolvedThreads: [],
    npcsIntroduced: [],
    locationsVisited: [],
    lootAndRewards: [],
    followUps: [],
    funnyMoments: [],
  });

  assert.ok(!body.includes('_none_'));
  assert.ok(!body.includes('Loot & Rewards'));
  assert.match(body, /The party did a thing\./);
});

test('buildSessionBody is honest when there is genuinely nothing', () => {
  const body = buildSessionBody({ tldr: '', scenes: [], partyDecisions: [], unresolvedThreads: [], npcsIntroduced: [], locationsVisited: [], lootAndRewards: [], followUps: [], funnyMoments: [] });
  assert.match(body, /Nothing substantial to report/);
});

test('buildSessionBody renders every populated section', () => {
  const body = buildSessionBody({
    tldr: 'T',
    scenes: [{ title: 'S', points: ['p'] }],
    partyDecisions: ['d'],
    unresolvedThreads: ['u'],
    npcsIntroduced: ['n'],
    locationsVisited: ['l'],
    lootAndRewards: ['r'],
    followUps: [{ assignee: 'Bob', task: 't' }],
    funnyMoments: ['f'],
  });

  for (const heading of ['What Happened', 'Moments Worth', 'Scenes', 'Party Decisions', 'Unresolved', 'NPCs', 'Locations', 'Loot', 'Before Next Session']) {
    assert.ok(body.includes(heading), `expected section: ${heading}`);
  }
  assert.match(body, /\*\*Bob:\*\* t/, 'assigned follow-ups name the player');
});
