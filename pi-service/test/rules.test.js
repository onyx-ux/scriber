import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { rulesFor, EDITIONS, DEFAULT_EDITION, isEdition, SPELL_COUNT } from '../src/web/rules.js';

// The rules table, and the promises the dashboard makes on the strength of it.
//
// src/web/rules.js is generated from each wiki's own spell index, so the things
// worth testing are not the 506 rows — they came from the source — but the
// rules ABOUT them: that no edition offers a link it cannot answer, that no
// ordinary English word is in there waiting to link "the light was failing" to
// a cantrip, and that what comes out is an address rather than something a page
// would paste into a href.
//
// If the wikis ever restructure and the generator has to change, this is the
// file that says what the new output still has to be true of.

const RULES = fileURLToPath(new URL('../src/web/rules.js', import.meta.url));

test('an edition only offers what that wiki actually has', async () => {
  const source = await readFile(RULES, 'utf8');
  const rows = [...source.matchAll(/^ {2}\['(.+?)', '([a-z0-9-]+)', ([123])\],$/gm)]
    .map((m) => ({ name: m[1].replace(/\\'/g, "'"), slug: m[2], on: Number(m[3]) }));
  assert.equal(rows.length, SPELL_COUNT, 'the table and its own count disagree');

  // By SLUG, not by name. Seventeen spells are on both wikis under the same
  // name and different addresses — dnd5e writes bigbys-hand and dnd2024 writes
  // bigby-s-hand — so they are two rows, and a check keyed on the name would
  // see each of them offered by the edition the other one belongs to.
  for (const [id, ed] of Object.entries(EDITIONS)) {
    const offered = new Set(rulesFor(id).map((s) => s.url.split('spell:')[1]));
    for (const row of rows) {
      const has = Boolean(row.on & ed.bit);
      assert.equal(offered.has(row.slug), has,
        `${row.name} (${row.slug}) is ${has ? 'missing from' : 'offered by'} the ${id} list`);
    }
  }
});

test('every link is an https address on the wiki it claims to be', () => {
  for (const [id, ed] of Object.entries(EDITIONS)) {
    for (const spell of rulesFor(id)) {
      // https for both, including the 2024 wiki, which 301s to http. Asking for
      // the secure one and being refused is a different thing from writing the
      // insecure one down — see the note in rules.js.
      assert.ok(spell.url.startsWith('https://'), `${spell.name} is not https: ${spell.url}`);
      assert.ok(spell.url.startsWith(ed.base), `${spell.name} is on the wrong wiki: ${spell.url}`);
      assert.match(spell.url, /\/spell:[a-z0-9-]+$/, `${spell.name} has a malformed slug: ${spell.url}`);
    }
  }
});

test('no name could break out of the markup it is written into', () => {
  // Each name is escaped where it is drawn, and each is also built into a
  // regular expression. Both are safer if the names are just words.
  for (const spell of rulesFor('2014').concat(rulesFor('2024'))) {
    assert.match(spell.name, /^[A-Za-z][A-Za-z' ]*$/, spell.name);
  }
});

test('no ordinary English word is offered as a spell', () => {
  // The failure this exists to stop: "the light was failing" becoming a link to
  // a cantrip. Single-word spell names are only linked if they are words nobody
  // uses for anything else, which is a hand-made list in the generator — so
  // this is the list of what must never come back.
  const ordinary = [
    'Aid', 'Alarm', 'Bane', 'Bless', 'Blight', 'Blink', 'Blur', 'Clone', 'Command',
    'Confusion', 'Creation', 'Darkness', 'Dawn', 'Daylight', 'Dream', 'Fear', 'Fly',
    'Friends', 'Gate', 'Grease', 'Guidance', 'Gust', 'Harm', 'Haste', 'Heal', 'Heroism',
    'Hex', 'Identify', 'Jump', 'Knock', 'Light', 'Maze', 'Mending', 'Message', 'Resistance',
    'Sanctuary', 'Scatter', 'Shield', 'Silence', 'Sleep', 'Slow', 'Snare', 'Symbol',
    'Web', 'Weird', 'Wish', 'Tongues', 'Awaken', 'Suggestion', 'Shatter',
  ];
  const offered = new Set(rulesFor('2014').concat(rulesFor('2024')).map((s) => s.name));
  for (const word of ordinary) {
    assert.equal(offered.has(word), false, `"${word}" would link every time somebody used the word`);
  }
});

test('a single-word name is only there if it is unmistakable', () => {
  const singles = [...new Set(rulesFor('2014').concat(rulesFor('2024')).map((s) => s.name))]
    .filter((n) => !n.includes(' '));
  // Every one of them is a coined word — long, or a compound. This is a shape
  // check rather than a dictionary: it catches a short common word slipping
  // into the generator's keep-list, which is the way this would go wrong.
  for (const name of singles) {
    assert.ok(name.length >= 7, `"${name}" is short enough to be an ordinary word`);
  }
});

test('the schools of magic are not spells', () => {
  // The wiki's spell index links its eight school pages from the same list.
  // "Evocation Spells" is not a thing a write-up says.
  for (const spell of rulesFor('2014').concat(rulesFor('2024'))) {
    assert.doesNotMatch(spell.url, /-school$/, spell.name);
    assert.doesNotMatch(spell.name, / Spells$/, spell.name);
  }
});

test('the two editions are genuinely different lists', () => {
  const a = new Set(rulesFor('2014').map((s) => s.name));
  const b = new Set(rulesFor('2024').map((s) => s.name));
  assert.ok([...a].some((n) => !b.has(n)), '2014 has nothing of its own');
  assert.ok([...b].some((n) => !a.has(n)), '2024 has nothing of its own');
  assert.ok([...a].some((n) => b.has(n)), 'the two share nothing, which cannot be right');

  // The one everybody knows, on both.
  assert.ok(a.has('Fireball') && b.has('Fireball'));
});

test('an edition nobody recognises is the current one, not an error', () => {
  // The campaign row can hold anything a migration or a hand-edit left in it,
  // and a write-up with no links is a worse answer than a write-up linked to
  // the current rules.
  assert.equal(isEdition('2014'), true);
  assert.equal(isEdition('2024'), true);
  // A number is accepted: isEdition stringifies, because the value it guards
  // can arrive as a column read back from SQLite as easily as from a request
  // body, and 2024 the number means the same thing as '2024' the string.
  assert.equal(isEdition(2024), true);
  for (const junk of ['', null, undefined, '5e', 'constructor', '__proto__', 'toString']) {
    assert.equal(isEdition(junk), false, String(junk));
  }
  assert.deepEqual(rulesFor('nonsense'), rulesFor(DEFAULT_EDITION));
  assert.deepEqual(rulesFor(), rulesFor(DEFAULT_EDITION));
});

test('no name appears twice in one edition', () => {
  for (const id of Object.keys(EDITIONS)) {
    const names = rulesFor(id).map((s) => s.name);
    assert.equal(new Set(names).size, names.length, `${id} lists a name twice`);
  }
});
