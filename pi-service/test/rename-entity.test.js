import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renameInNote, renameLinks } from '../src/campaign/rename-entity.js';

// The extractor names a character from what the transcript sounded like and
// the table corrects it afterwards — "Seth" was Saf all along. The old name
// has to survive as an alias: every recap written before the rename used it.
test('the old name becomes an alias', () => {
  const note = [
    '---',
    'name: "Seth"',
    'aliases: ["Saf", "Joss"]',
    'type: pc',
    '---',
    '',
    '# Seth',
    '',
    'A cleric.',
  ].join('\n');

  const out = renameInNote(note, 'Seth', 'Saf');
  assert.match(out, /^name: "Saf"$/m);
  assert.match(out, /^aliases: \["Seth", "Joss"\]$/m, 'old name in, new name out');
  assert.match(out, /^# Saf$/m);
  assert.match(out, /^A cleric\.$/m, 'the body is untouched');
});

test('a note with no alias list gets one rather than losing the old name', () => {
  const out = renameInNote('---\nname: "Seth"\ntype: pc\n---\n', 'Seth', 'Saf');
  assert.match(out, /^name: "Saf"\naliases: \["Seth"\]$/m);
});

test('a heading that is not the name is left alone', () => {
  const out = renameInNote('---\nname: "Seth"\n---\n\n# Seth\n\n## What Seth did\n', 'Seth', 'Saf');
  assert.match(out, /^# Saf$/m);
  assert.match(out, /^## What Seth did$/m, 'section headings are link targets elsewhere');
});

// The prose said "Seth", so it should keep saying "Seth" — only where the
// link POINTS changes.
test('a bare link keeps its wording and gains a pipe', () => {
  assert.equal(renameLinks('The party met [[Seth]] there.', 'Seth', 'Saf'), 'The party met [[Saf|Seth]] there.');
});

test('a piped link keeps its wording and repoints', () => {
  assert.equal(renameLinks('| [[Seth|Saf]] | 191 |', 'Seth', 'Saf'), '| [[Saf]] | 191 |', 'and collapses when they match');
  assert.equal(renameLinks('[[Seth|Sef]] healed him.', 'Seth', 'Saf'), '[[Saf|Sef]] healed him.');
});

test('a name that merely contains the old one is not touched', () => {
  const text = '[[Seth Junior]] and [[Sethian]] are other people.';
  assert.equal(renameLinks(text, 'Seth', 'Saf'), text);
});

test('plain prose mentions are not links and are left alone', () => {
  assert.equal(renameLinks('Seth walked in.', 'Seth', 'Saf'), 'Seth walked in.');
});

test('a long name with regex characters in it renames safely', () => {
  const out = renameLinks('[[Thaddeus Leopard Archibald|Tad]] cast Friends.', 'Thaddeus Leopard Archibald', 'Tad');
  assert.equal(out, '[[Tad]] cast Friends.');
});

// \s matches a newline, so `^# Name\s*$` under the m flag swallowed the blank
// line after the heading and closed the note up as it renamed it. Every line
// that is not the rename itself has to survive untouched.
test('renaming changes only the lines it means to', () => {
  const note = ['---', 'name: "Seth"', 'aliases: ["Saf"]', '---', '', '# Seth', '', '*A cleric*', '', 'Body text.', ''].join('\n');
  const out = renameInNote(note, 'Seth', 'Saf');

  assert.equal(out.split('\n').length, note.split('\n').length, 'no lines added or removed');
  const before = note.split('\n');
  assert.deepEqual(
    out.split('\n').filter((l, i) => l !== before[i]),
    ['name: "Saf"', 'aliases: ["Seth"]', '# Saf']
  );
});
