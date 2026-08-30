import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecapContext,
  worthRecapping,
  recapForTable,
  RECAP_SYSTEM_PROMPT,
} from '../src/pipeline/recap-client.js';

const notes = {
  tldr: 'The party talked their way past the kobold guards and found Meepo, who wants his dragon back. They agreed to help, mostly because Nyx thought it was funny.',
  npcsIntroduced: ['Meepo — a kobold keeper who has lost his dragon', 'Sir Braford — mentioned, not met'],
  unresolvedThreads: ['Calcryx the white dragon is still missing', 'The Hucrele siblings have not been found'],
  lootAndRewards: ['3 gold pieces', 'a gem worth 5gp'],
  funnyMoments: ['Meepo in his skid-mark underwear'],
};

const characters = [{ character_name: 'Nyx' }, { character_name: 'Cipher' }, { character_name: 'BenTen' }];

test('the context carries what a spoken recap can use', () => {
  const ctx = buildRecapContext(notes, { characters });
  assert.match(ctx, /WHAT HAPPENED/);
  assert.match(ctx, /Meepo/);
  assert.match(ctx, /STILL UNRESOLVED/);
  assert.match(ctx, /Calcryx/);
  assert.match(ctx, /Nyx, Cipher, BenTen/);
});

// A vault page is where loot lists and in-jokes belong. Reading them aloud is
// how a four-sentence recap becomes a ninety-second one nobody listens to.
test('loot and in-jokes are left out of a spoken recap', () => {
  const ctx = buildRecapContext(notes, { characters });
  assert.doesNotMatch(ctx, /gold pieces/);
  assert.doesNotMatch(ctx, /skid-mark/);
});

// The last thing in the context is the last thing the model reads, and the
// prompt tells it to end there — the open thread is the sentence the table
// actually needs.
test('the unresolved thread is given last, where the recap should land', () => {
  const ctx = buildRecapContext(notes, { characters });
  assert.ok(ctx.lastIndexOf('STILL UNRESOLVED') > ctx.indexOf('WHAT HAPPENED'));
});

test('missing sections are omitted rather than sent as empty headings', () => {
  const ctx = buildRecapContext({ tldr: 'A short one.' });
  assert.match(ctx, /A short one\./);
  assert.doesNotMatch(ctx, /NEW FACES/);
  assert.doesNotMatch(ctx, /STILL UNRESOLVED/);
  assert.doesNotMatch(ctx, /THE PARTY/);
});

test('nothing at all still produces a string rather than throwing', () => {
  assert.equal(buildRecapContext(), '');
  assert.equal(buildRecapContext(null, {}), '');
});

// The summariser writes an honest one-liner for a night that was not really a
// session. Turning "this was a microphone test" into something to read aloud
// helps nobody and costs a call.
test('a session not worth retelling is recognised before a call is spent', () => {
  assert.equal(worthRecapping(notes), true);
  assert.equal(worthRecapping({ tldr: 'This session was a microphone test.' }), false);
  assert.equal(worthRecapping({ tldr: '' }), false);
  assert.equal(worthRecapping({}), false);
  assert.equal(worthRecapping(), false);
});

test('the prompt forbids inventing what the DM has not shown', () => {
  assert.match(RECAP_SYSTEM_PROMPT, /Invent nothing/);
  assert.match(RECAP_SYSTEM_PROMPT, /do not speculate about what happens next/i);
  assert.match(RECAP_SYSTEM_PROMPT, /never the players' real or Discord names/);
});

test('it asks on the cheap model, not the summariser’s', async () => {
  let seen = null;
  await recapForTable({
    notes,
    characters,
    cfg: {},
    ask: async (system, user, cfg, timeoutMs, options) => {
      seen = { system, user, options };
      return 'You talked your way past the kobolds.';
    },
  });

  assert.equal(seen.options.role, 'ask', 'a rephrase of four sentences is not worth the top model');
  assert.equal(seen.system, RECAP_SYSTEM_PROMPT);
  assert.match(seen.user, /Calcryx/, 'the open thread has to reach the model');
});

test('the meeting id rides along so the spend is attributable', async () => {
  let opts = null;
  await recapForTable({
    notes,
    cfg: {},
    meetingId: 21,
    db: { recordModelUsage() {} },
    ask: async (s, u, c, t, o) => {
      opts = o;
      return 'ok';
    },
  });
  assert.equal(opts.meetingId, 21);
});

test('whitespace around the answer is trimmed, and a blank one stays blank', async () => {
  const spoken = await recapForTable({ notes, cfg: {}, ask: async () => '\n  You found Meepo.  \n' });
  assert.equal(spoken, 'You found Meepo.');

  const empty = await recapForTable({ notes, cfg: {}, ask: async () => '   ' });
  assert.equal(empty, '', 'the caller checks for this and falls back to the stored note');
});
