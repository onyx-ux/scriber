import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLocationResponse,
  mergeLocations,
  renderLocationNote,
} from '../src/campaign/location-extract.js';

test('locations come back under their own key', () => {
  const locs = parseLocationResponse('{"locations":[{"name":"Oakhurst"},{"name":"Sunless Citadel"}]}');
  assert.deepEqual(locs.map((l) => l.name), ['Oakhurst', 'Sunless Citadel']);
});

test('a fenced response is still parsed', () => {
  assert.equal(parseLocationResponse('```json\n{"locations":[{"name":"Oakhurst"}]}\n```').length, 1);
});

test('junk yields nothing rather than throwing', () => {
  for (const bad of ['', 'nope', '{"locations":', null]) {
    assert.deepEqual(parseLocationResponse(bad), [], JSON.stringify(bad));
  }
});

test('a place visited twice records both sessions', () => {
  const merged = mergeLocations([
    { sessionNumber: 1, locations: [{ name: 'Oakhurst', kind: 'town', events: ['Met the mayor.'] }] },
    { sessionNumber: 2, locations: [{ name: 'oakhurst', events: ['Resupplied at the inn.'] }] },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sessions, [1, 2]);
  assert.equal(merged[0].kind, 'town', 'a fact from the first visit survives');
  assert.deepEqual(merged[0].events.map((e) => e.session), [1, 2]);
});

// A citadel cleared in session 4 must not still read as unexplored.
test('status and danger take the latest session’s value', () => {
  const merged = mergeLocations([
    { sessionNumber: 1, locations: [{ name: 'Citadel', status: 'unexplored', danger: 'unknown', controlledBy: 'Kobolds' }] },
    { sessionNumber: 2, locations: [{ name: 'Citadel', status: 'partially explored', danger: 'dangerous', controlledBy: 'Goblins' }] },
  ]);
  assert.equal(merged[0].status, 'partially explored');
  assert.equal(merged[0].danger, 'dangerous');
  assert.equal(merged[0].controlledBy, 'Goblins');
});

test('features and inhabitants accumulate without duplicating', () => {
  const merged = mergeLocations([
    { sessionNumber: 1, locations: [{ name: 'Citadel', features: ['A ravine'], inhabitants: ['Meepo'] }] },
    { sessionNumber: 2, locations: [{ name: 'Citadel', features: ['A ravine', 'A throne'], inhabitants: ['Meepo'] }] },
  ]);
  assert.deepEqual(merged[0].features, ['A ravine', 'A throne']);
  assert.deepEqual(merged[0].inhabitants, ['Meepo']);
});

const loc = {
  name: 'Sunless Citadel',
  aliases: ['The Citadel'],
  kind: 'dungeon',
  partOf: 'A ravine near Oakhurst',
  region: 'Near Oakhurst',
  controlledBy: 'Kobold tribe',
  status: 'partially explored',
  danger: 'dangerous',
  description: 'An ancient fortress swallowed by the earth.',
  features: ['A makeshift throne against an altar'],
  inhabitants: ['Meepo', 'Kobold Queen'],
  sessions: [2],
  events: [{ session: 2, text: 'The party descended by rope.' }],
  hooks: [{ session: 2, text: 'The lower level is unexplored.' }],
};

test('the frontmatter carries what a DM would filter on', () => {
  const md = renderLocationNote(loc, { campaign: 'Cipher' });
  assert.match(md, /^type: location$/m);
  assert.match(md, /^kind: "dungeon"$/m);
  assert.match(md, /^danger: dangerous$/m);
  assert.match(md, /^status: "partially explored"$/m);
  assert.match(md, /^first_seen: 2$/m);
  assert.match(md, /^campaign: "Cipher"$/m);
});

test('inhabitants link to their NPC notes when those exist', () => {
  const md = renderLocationNote(loc, { knownEntities: ['Meepo', 'Kobold Queen'] });
  assert.match(md, /- \[\[Meepo\]\]/);
  assert.match(md, /- \[\[Kobold Queen\]\]/);
});

// A vault full of links to notes that will never exist is worse than plain text.
test('an inhabitant with no note stays plain text', () => {
  const md = renderLocationNote(loc, { knownEntities: [] });
  assert.ok(!md.includes('[[Meepo]]'));
  assert.match(md, /- Meepo/);
});

test('the note links back to the sessions it came from', () => {
  const md = renderLocationNote(loc);
  assert.match(md, /## Visited in[\s\S]*\[\[Session 02\]\]/);
  assert.match(md, /- \[ \] The lower level is unexplored\./, 'unexplored threads are tickable');
});

test('sections with nothing in them are left out', () => {
  const sparse = { ...loc, features: [], inhabitants: [], hooks: [], events: [] };
  const md = renderLocationNote(sparse);
  assert.ok(!md.includes('## What is there'));
  assert.ok(!md.includes('## Who is there'));
  assert.ok(!md.includes('## Left unexplored'));
  assert.match(md, /## Visited in/, 'but the session list always survives');
});

// The table called the same building the "Old Boar Tavern" one week and the
// "Old Boar Inn" the next. Keying on the name alone produced two notes.
test('a place renamed between sessions merges into one note', () => {
  const merged = mergeLocations([
    { sessionNumber: 1, locations: [{ name: 'Old Boar Tavern', aliases: ['Old Boar Inn'], kind: 'inn' }] },
    { sessionNumber: 2, locations: [{ name: 'Old Boar Inn', events: ['Rested here.'] }] },
  ]);

  assert.equal(merged.length, 1, 'one inn, not two');
  assert.deepEqual(merged[0].sessions, [1, 2]);
  assert.ok(merged[0].aliases.includes('Old Boar Inn'));
});

test('the merged-away name survives as an alias so its links resolve', () => {
  const merged = mergeLocations([
    { sessionNumber: 1, locations: [{ name: 'The Citadel' }] },
    { sessionNumber: 2, locations: [{ name: 'Sunless Citadel', aliases: ['The Citadel'] }] },
  ]);

  assert.equal(merged.length, 1);
  assert.ok(
    merged[0].aliases.includes('Sunless Citadel') || merged[0].name === 'Sunless Citadel',
    'whichever name lost must still be reachable'
  );
});

test('genuinely different places are not merged', () => {
  const merged = mergeLocations([
    { sessionNumber: 1, locations: [{ name: 'Oakhurst' }, { name: 'Sunless Citadel' }] },
  ]);
  assert.equal(merged.length, 2);
});
