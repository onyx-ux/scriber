import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWhisperPrompt,
  selectVocabulary,
  looksLikePromptEcho,
  promptTerms,
  PROMPT_MAX_CHARS,
} from '../src/stt/vocabulary.js';
import { entryName, entryKey } from '../src/campaign/ledger.js';

const sources = {
  corrections: [{ wrong_text: 'kaylen', correct_text: 'Kaelen' }],
  characters: [{ character_name: 'Thora Ironfist' }],
  npcs: ['Vex the Bold', 'Old Miriam'],
  locations: ['Baldur’s Gate'],
};

test('the prompt names the campaign’s proper nouns', () => {
  const prompt = buildWhisperPrompt(sources);
  for (const name of ['Kaelen', 'Thora Ironfist', 'Vex the Bold', 'Baldur’s Gate']) {
    assert.ok(prompt.includes(name), `${name} missing from: ${prompt}`);
  }
});

test('an empty campaign produces no prompt rather than a bare lead-in', () => {
  assert.equal(buildWhisperPrompt({}), '', 'sending a contentless prompt just spends context for nothing');
  assert.equal(buildWhisperPrompt({ corrections: [], characters: [], npcs: [], locations: [] }), '');
});

// Corrections are words this campaign has already PROVEN whisper mishears, so
// they must survive the budget when longer-tailed sources do not.
test('corrections outrank every other source', () => {
  const [first] = selectVocabulary(sources);
  assert.equal(first, 'Kaelen');
});

test('player characters outrank ledger entries', () => {
  const order = selectVocabulary(sources);
  assert.ok(order.indexOf('Thora Ironfist') < order.indexOf('Vex the Bold'));
});

// A ledger is appended to over time, so its tail is the current cast.
test('recent ledger entries outrank ones from session one', () => {
  const order = selectVocabulary({ npcs: ['Session One Guy', 'Last Week’s Villain'] });
  assert.ok(order.indexOf('Last Week’s Villain') < order.indexOf('Session One Guy'));
});

test('a name appearing in two sources is only paid for once', () => {
  const terms = selectVocabulary({
    corrections: [{ correct_text: 'Kaelen' }],
    characters: [{ character_name: 'kaelen' }],
  });
  assert.deepEqual(terms, ['Kaelen'], 'and the first-seen capitalisation wins');
});

test('single letters and stray fragments are left out', () => {
  const terms = selectVocabulary({ npcs: ['X', 'a', 'Ok', 'Vex'] });
  assert.deepEqual(terms, ['Vex'], 'short tokens collide with ordinary words and waste budget');
});

// Whisper silently drops the front of an over-long prompt, which would throw
// away exactly the corrections that were ranked first.
test('the prompt stays inside the model’s window', () => {
  const npcs = Array.from({ length: 400 }, (_, i) => `Lord Longname the ${i}th of Someplace`);
  const prompt = buildWhisperPrompt({ npcs });
  assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${prompt.length} chars`);
});

test('truncation never cuts a name in half', () => {
  const npcs = Array.from({ length: 400 }, (_, i) => `Longname${i}`);
  const prompt = buildWhisperPrompt({ npcs });

  const listed = prompt.replace(/^[^.]*\.\s*/, '').replace(/\.$/, '').split(', ');
  for (const term of listed) {
    assert.ok(npcs.includes(term), `"${term}" is not a whole name`);
  }
});

test('the highest-priority terms are the ones that survive truncation', () => {
  const prompt = buildWhisperPrompt({
    corrections: [{ correct_text: 'Kaelen' }],
    npcs: Array.from({ length: 400 }, (_, i) => `Filler${i}`),
  });
  assert.ok(prompt.includes('Kaelen'), 'the proven mishearing must not be the thing that gets dropped');
});

test('a tiny budget yields no prompt rather than a broken one', () => {
  assert.equal(buildWhisperPrompt(sources, { maxChars: 5 }), '');
});

// --- prompt echo guard ---

test('prompt terms round-trip out of a built prompt', () => {
  assert.deepEqual(promptTerms(buildWhisperPrompt(sources)), [
    'Kaelen',
    'Thora Ironfist',
    'Old Miriam',
    'Vex the Bold',
    'Baldur’s Gate',
  ]);
  assert.deepEqual(promptTerms(''), []);
});

// Reproduced against the live whisper server: 5s of low noise transcribed as
// "Kaelen Zyrthax, Thoram." once the campaign vocabulary was supplied.
test('a clip that is nothing but campaign names is treated as an echo', () => {
  const terms = ['Kaelen Zyrthax', 'Thora Ironfist', 'Vex the Bold'];
  assert.equal(looksLikePromptEcho('Kaelen Zyrthax, Thora Ironfist.', terms), true);
});

// The exact string the live server produced for a prompt naming "Thora
// Ironfist" — note "Thoras", which an exact-word matcher does not catch.
test('a fuzzy echo with mangled names is still caught', () => {
  const terms = ['Kaelen Zyrthax', 'Thora Ironfist', 'Vexnar the Bold'];
  assert.equal(looksLikePromptEcho('Kaelen Zyrthax, Thoras, Thoras, Thoras.', terms), true);
});

// Loose matching must not start eating ordinary words that happen to share a
// few letters with a short name.
test('short names do not swallow ordinary words', () => {
  const terms = ['Vex', 'Kaelen'];
  assert.equal(looksLikePromptEcho('vexing vexed', terms), false);
});

test('real speech containing a name is kept', () => {
  const terms = ['Kaelen', 'Thora', 'Vex'];
  assert.equal(looksLikePromptEcho('Kaelen, look out behind you!', terms), false);
  assert.equal(looksLikePromptEcho('I think Thora should open the door', terms), false);
});

// Shouting one name is an ordinary thing to do at a table. Losing real speech
// is worse than keeping the occasional fabrication, so one term is not enough.
test('a single name on its own is not treated as an echo', () => {
  assert.equal(looksLikePromptEcho('Kaelen!', ['Kaelen', 'Thora', 'Vex']), false);
});

test('the guard does nothing when no prompt was used', () => {
  assert.equal(looksLikePromptEcho('Kaelen, Thora.', []), false);
  assert.equal(looksLikePromptEcho('', ['Kaelen', 'Thora']), false);
});

// --- ledger name extraction ---

test('ledger names keep their capitalisation and lose their wikilinks', () => {
  assert.equal(entryName('- [[Vex the Bold]] — a smuggler from the docks'), 'Vex the Bold');
  assert.equal(entryName('- Old Miriam, herbalist'), 'Old Miriam');
  assert.equal(entryName('- Kaelen _(Session 3)_'), 'Kaelen');
});

// entryKey drives ledger dedupe; changing it would re-add every known NPC.
test('entryKey behaviour is unchanged by the name helper', () => {
  assert.equal(entryKey('- Vex the Bold — a smuggler'), 'vex the bold');
  assert.equal(entryKey('- Old Miriam, herbalist'), 'old miriam');
});
