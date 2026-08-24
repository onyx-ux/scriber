import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commonArgs, renderEntityRun } from '../scripts/lib/render-entity-run.mjs';

// The flags the three builders share.
//
// Worth a test of its own because each script used to parse them separately and
// they had already drifted: build-character-notes.mjs picked its campaign
// argument with `/^\d{15,}$/`, which accepts a Discord guild id and rejects
// every campaign name — while its own usage line advertised
// `<campaign|guildId>`. Naming a campaign printed the usage and exited.

const parse = (...argv) => commonArgs(['node', 'build-x.mjs', ...argv]);

test('a campaign can be named, not just given as a guild id', () => {
  assert.equal(parse('Cipher', '--write').which, 'Cipher');
  assert.equal(parse('123456789012345678').which, '123456789012345678');
  assert.equal(parse('7').which, '7', 'a campaign id is a small number and still works');
});

// The other half of the same drift: build-npc-notes.mjs took the first
// non-`--` argument, so `--model gemini-x Cipher` picked "gemini-x" as the
// campaign and then failed to find it.
test('a flag value is never mistaken for the campaign', () => {
  assert.equal(parse('--model', 'gemini-x', 'Cipher').which, 'Cipher');
  assert.equal(parse('--cache', 'npcs.json', 'Cipher').which, 'Cipher');
  assert.equal(parse('--dm', 'Old Dad', 'Cipher', '--write').which, 'Cipher');
});

test('with no campaign named there is nothing to build', () => {
  assert.equal(parse('--write').which, undefined);
  assert.equal(parse().which, undefined);
});

test('the write and json switches are off unless asked for', () => {
  const bare = parse('Cipher');
  assert.equal(bare.write, false);
  assert.equal(bare.json, false);
  assert.equal(bare.cachePath, null);

  const loud = parse('Cipher', '--write', '--json', '--cache', 'out.json');
  assert.equal(loud.write, true);
  assert.equal(loud.json, true);
  assert.equal(loud.cachePath, 'out.json');
});

// The default is not the configured summariser on purpose: that is a budget
// model chosen for cheap recaps, and reading thousands of lines of raw
// transcript for character detail is a different job.
test('the model defaults to something stronger than the summariser', () => {
  assert.equal(parse('Cipher').model, 'gemini-3.6-flash');
  assert.equal(parse('Cipher', '--model', 'claude-x').model, 'claude-x');
});

test('a repeated flag collects every value', () => {
  assert.deepEqual(parse('Cipher', '--pc', 'Brett=BenTen', '--pc', 'Aurion').flagAll('--pc'), [
    'Brett=BenTen',
    'Aurion',
  ]);
  assert.deepEqual(parse('Cipher').flagAll('--pc'), []);
});

// The renderer is what the scripts print. It must survive an event it has never
// seen rather than throwing partway through a build that already spent money.
test('an unknown event is ignored rather than thrown on', () => {
  const render = renderEntityRun({ noun: 'NPC' });
  assert.doesNotThrow(() => render({ type: 'something-added-later' }));
});
