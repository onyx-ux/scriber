import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, fmtSpeakerStats } from '../src/export/markdown.js';

const meeting = { id: 7, channel_name: 'Cipher', started_at: '2026-07-31T10:00:00Z' };
const utterances = [
  { display_name: 'Koru', text: 'one two three four five', start_ms: 0, end_ms: 4000 },
  { display_name: 'Onyx', text: 'one two', start_ms: 5000, end_ms: 6000 },
  { display_name: 'Koru', text: 'six seven', start_ms: 7000, end_ms: 8000 },
];

const emptyNotes = {
  tldr: '',
  scenes: [],
  partyDecisions: [],
  unresolvedThreads: [],
  npcsIntroduced: [],
  locationsVisited: [],
  lootAndRewards: [],
  followUps: [],
  funnyMoments: [],
};

test('empty sections are omitted rather than rendered as _none_', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: { ...emptyNotes, tldr: 'The party did a thing.' },
    cfg: {},
  });

  assert.ok(!md.includes('_none_'), 'no placeholder text should survive');
  assert.ok(!md.includes('## Loot & Rewards'), 'an empty section should not get a heading');
  assert.match(md, /The party did a thing\./);
  assert.match(md, /Full Transcript/, 'the transcript is always kept');
});

test('a completely empty summary says so instead of rendering a skeleton', () => {
  const md = renderMarkdown({ meeting, utterances, notes: emptyNotes, cfg: {} });
  assert.match(md, /Nothing substantial to report/);
});

test('NPC and location names become wikilinks, descriptions do not', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: {
      ...emptyNotes,
      tldr: 't',
      npcsIntroduced: ['Vex the Bold — a smuggler'],
      locationsVisited: ['Marrowgate Crypt, deep below'],
    },
    cfg: { obsidianWikilinks: true },
  });

  assert.match(md, /\[\[Vex the Bold\]\] — a smuggler/);
  assert.match(md, /\[\[Marrowgate Crypt\]\], deep below/);
});

test('wikilinks can be turned off', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: { ...emptyNotes, tldr: 't', npcsIntroduced: ['Vex the Bold — a smuggler'] },
    cfg: { obsidianWikilinks: false },
  });
  assert.ok(!md.includes('[['));
});

test('a whole sentence is never turned into a wikilink', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: {
      ...emptyNotes,
      tldr: 't',
      npcsIntroduced: ['A very long rambling sentence that is clearly not a name and should never be linked'],
    },
    cfg: {},
  });
  assert.ok(!md.includes('[['), 'over-long "names" must be left as plain text');
});

test('speaker stats rank by words and include talk time when timings are real', () => {
  const stats = fmtSpeakerStats(utterances);
  assert.match(stats, /\| Speaker \|/);
  assert.match(stats, /Talk time/);
  assert.ok(stats.indexOf('Koru') < stats.indexOf('Onyx'), 'the more talkative player sorts first');
  assert.match(stats, /78%/);
});

test('talk-time column is dropped when durations are unknown', () => {
  // Crash-recovered sessions have no end timestamps, so every duration is 0.
  const stats = fmtSpeakerStats([{ display_name: 'A', text: 'hello there', start_ms: 100, end_ms: 100 }]);
  assert.ok(!stats.includes('Talk time'));
  assert.match(stats, /\| A \| 1 \| 2 \| 100% \|/);
});

test('speaker stats degrade safely on empty or wordless input', () => {
  assert.equal(fmtSpeakerStats([]), null);
  assert.equal(fmtSpeakerStats([{ display_name: 'A', text: '   ', start_ms: 0, end_ms: 0 }]), null);
});

test('camelCase (in-flight) utterances work as well as DB rows', () => {
  const stats = fmtSpeakerStats([{ displayName: 'A', text: 'one two', startMs: 0, endMs: 1000 }]);
  assert.match(stats, /\| A \|/);
});
