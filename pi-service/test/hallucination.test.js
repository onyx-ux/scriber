import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeHallucination,
  isFillerPhrase,
  LANG_CONFIDENCE_FLOOR,
  SHORT_CLIP_SECONDS,
} from '../src/stt/hallucination.js';

// Measured on a real session: hallucinated clips topped out at 0.899 language
// confidence, real speech sat at 0.993+.
const NOISE = { langProb: 0.64, seconds: 0.58 };
const SPEECH = { langProb: 0.999, seconds: 2.9 };

test('whisper’s stock silence fillers are recognised', () => {
  for (const t of ['Thank you.', 'thank you', 'Thanks for watching!', 'Bye.', 'You.', '...']) {
    assert.equal(isFillerPhrase(t), true, t);
  }
});

// The whole risk of this filter is eating real dialogue that merely contains
// one of these words.
test('a sentence that merely contains a filler word is not a filler phrase', () => {
  for (const t of [
    'Thank you for the healing potion',
    'I thank you, my lord',
    'Bye, I am heading to the tavern',
    'You open the door',
  ]) {
    assert.equal(isFillerPhrase(t), false, t);
  }
});

test('a filler phrase on a low-confidence clip is dropped', () => {
  assert.equal(looksLikeHallucination('Thank you.', NOISE), true);
});

// Someone actually saying it scores like ordinary speech, so it survives.
test('a filler phrase someone genuinely said is kept', () => {
  assert.equal(looksLikeHallucination('Thank you.', SPEECH), false);
});

test('real dialogue is never touched, however low the confidence', () => {
  assert.equal(looksLikeHallucination('I attack the goblin', { langProb: 0.2, seconds: 0.4 }), false);
});

test('the language-confidence floor is what decides it', () => {
  assert.equal(looksLikeHallucination('Bye.', { langProb: LANG_CONFIDENCE_FLOOR - 0.01, seconds: 10 }), true);
  assert.equal(looksLikeHallucination('Bye.', { langProb: LANG_CONFIDENCE_FLOOR + 0.01, seconds: 0.1 }), false,
    'confidence wins over duration when both are available');
});

// The Pi's CPU path reports no language probability at all.
test('without a confidence score it falls back to duration', () => {
  assert.equal(looksLikeHallucination('Thank you.', { seconds: SHORT_CLIP_SECONDS - 0.1 }), true);
  assert.equal(looksLikeHallucination('Thank you.', { seconds: SHORT_CLIP_SECONDS + 0.1 }), false);
});

// Dropping real speech is the worse error, so silence about the clip means keep.
test('with no evidence at all the clip is kept', () => {
  assert.equal(looksLikeHallucination('Thank you.', {}), false);
  assert.equal(looksLikeHallucination('Thank you.'), false);
});

test('empty text is not a hallucination', () => {
  assert.equal(looksLikeHallucination('', NOISE), false);
});
