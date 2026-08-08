import { test } from 'node:test';
import assert from 'node:assert/strict';

import { linkifyEntities } from '../src/export/linkify.js';
import { renderMarkdown } from '../src/export/markdown.js';

const CAST = ['Kerowyn', 'Bob', 'Sunless Citadel', 'Oakhurst', 'Illian Merrick', 'Talgan'];

test('a mention in prose becomes a link', () => {
  assert.equal(
    linkifyEntities('The party met Kerowyn at the inn.', CAST),
    'The party met [[Kerowyn]] at the inn.'
  );
});

// The graph cares that a link exists, not how many there are.
test('only the first mention is linked', () => {
  const out = linkifyEntities('Kerowyn spoke. Later Kerowyn left. Kerowyn returned.', CAST);
  assert.equal((out.match(/\[\[Kerowyn\]\]/g) || []).length, 1);
  assert.equal(out, '[[Kerowyn]] spoke. Later Kerowyn left. Kerowyn returned.');
});

test('the longest matching name wins', () => {
  assert.equal(
    linkifyEntities('They descended into the Sunless Citadel.', CAST),
    'They descended into the [[Sunless Citadel]].'
  );
});

test('an already-linked entity is never wrapped twice', () => {
  const out = linkifyEntities('- [[Kerowyn]]: A mother who hires the party.', CAST);
  assert.equal(out, '- [[Kerowyn]]: A mother who hires the party.');
  assert.ok(!out.includes('[[[['));
});

test('a name inside a longer word is left alone', () => {
  assert.equal(linkifyEntities('Bobby polished the bobbin.', CAST), 'Bobby polished the bobbin.');
  assert.equal(linkifyEntities('Bob polished it.', CAST), '[[Bob]] polished it.');
});

test('a possessive keeps the apostrophe outside the link', () => {
  assert.equal(linkifyEntities("Kerowyn's children are missing.", CAST), "[[Kerowyn]]'s children are missing.");
});

// Proper nouns are capitalised; matching loosely would link ordinary words.
test('lowercase prose is not linked', () => {
  assert.equal(linkifyEntities('they wandered the citadel for hours', CAST), 'they wandered the citadel for hours');
});

// The bug the NUL placeholder exists to prevent.
test('numbers in the prose survive intact', () => {
  const text = '- 125 gold pieces offered per ring, and 500 gold for each rescue. Kerowyn paid.';
  const out = linkifyEntities(text, CAST);
  assert.ok(out.includes('125 gold pieces'), out);
  assert.ok(out.includes('500 gold'), out);
  assert.ok(out.includes('[[Kerowyn]]'), out);
});

test('multi-word names are matched whole', () => {
  assert.equal(
    linkifyEntities('Brett meets Illian Merrick near the wagon.', CAST),
    'Brett meets [[Illian Merrick]] near the wagon.'
  );
});

test('nothing to link leaves the text untouched', () => {
  assert.equal(linkifyEntities('A quiet session.', CAST), 'A quiet session.');
  assert.equal(linkifyEntities('Kerowyn spoke.', []), 'Kerowyn spoke.');
  assert.equal(linkifyEntities('', CAST), '');
});

// Junk in the ledger must not become a matcher.
test('unusable entity names are ignored', () => {
  assert.equal(linkifyEntities('Al and the party rested.', ['Al']), 'Al and the party rested.', 'too short');
  assert.equal(linkifyEntities('the party rested', ['the']), 'the party rested', 'not capitalised');
  assert.equal(linkifyEntities('Bob rested', ['', null, undefined, 'Bob']), '[[Bob]] rested');
});

// --- as it lands in a real note ---

const meeting = { id: 10, channel_name: 'Session', started_at: '2026-08-01T00:00:00Z' };
const utterances = [
  { display_name: 'Matt', text: 'Kerowyn told us about the Sunless Citadel', start_ms: 0, end_ms: 1000 },
];

test('the recap is linked but the transcript is left alone', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: {
      tldr: 'The party met Kerowyn and travelled to the Sunless Citadel.',
      npcsIntroduced: ['Kerowyn: A mother who hires the party.'],
    },
    cfg: { obsidianWikilinks: true },
    entities: CAST,
  });

  const [recap, transcript] = md.split('## Full Transcript');
  assert.ok(recap.includes('met [[Kerowyn]]'), 'the TL;DR should link');
  assert.ok(recap.includes('[[Sunless Citadel]]'), 'so should the location');
  assert.ok(
    !transcript.includes('[['),
    'the transcript is thousands of lines — linking through it would bury the note'
  );
});

test('the NPC list stays correctly linked when prose linking is on', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: { tldr: 'x', npcsIntroduced: ['Kerowyn: A mother who hires the party.'] },
    cfg: { obsidianWikilinks: true },
    entities: CAST,
  });

  assert.ok(md.includes('[[Kerowyn]]: A mother'), 'name linked, description outside');
  assert.ok(!md.includes('[[[['), 'and not double-wrapped by the prose pass');
});

test('turning wikilinks off disables prose linking too', () => {
  const md = renderMarkdown({
    meeting,
    utterances,
    notes: { tldr: 'The party met Kerowyn.' },
    cfg: { obsidianWikilinks: false },
    entities: CAST,
  });
  assert.ok(!md.includes('[['));
});
