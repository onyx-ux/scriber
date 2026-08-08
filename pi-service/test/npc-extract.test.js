import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNpcResponse,
  npcKey,
  mergeNpcs,
  reconcileAliases,
  renderNpcNote,
  npcFileName,
} from '../src/campaign/npc-extract.js';

// --- parsing what the model actually returns ---

test('a bare JSON object is parsed', () => {
  const npcs = parseNpcResponse('{"npcs":[{"name":"Meepo"}]}');
  assert.deepEqual(npcs.map((n) => n.name), ['Meepo']);
});

// Models wrap JSON in a fence or a sentence often enough that a bare
// JSON.parse loses a whole session's extraction to one stray backtick.
test('a fenced or chatty response is still parsed', () => {
  assert.equal(parseNpcResponse('```json\n{"npcs":[{"name":"Meepo"}]}\n```').length, 1);
  assert.equal(parseNpcResponse('Here you go:\n{"npcs":[{"name":"Meepo"}]}\nHope that helps!').length, 1);
});

test('junk yields nothing rather than throwing', () => {
  for (const bad of ['', '   ', 'no json here', '{"npcs":', '{}', '{"npcs":"nope"}', null, undefined]) {
    assert.deepEqual(parseNpcResponse(bad), [], JSON.stringify(bad));
  }
});

test('entries without a usable name are dropped', () => {
  const npcs = parseNpcResponse('{"npcs":[{"name":"Meepo"},{"name":""},{"role":"nameless"},null]}');
  assert.deepEqual(npcs.map((n) => n.name), ['Meepo']);
});

// --- identity across sessions ---

test('the same NPC is recognised despite case and punctuation', () => {
  assert.equal(npcKey('Meepo'), npcKey('meepo'));
  assert.equal(npcKey('Meepo,'), npcKey('Meepo'));
  assert.equal(npcKey('  MEEPO  '), 'meepo');
  assert.notEqual(npcKey('Meepo'), npcKey('Kerowyn'));
});

test('an NPC appearing twice becomes one record listing both sessions', () => {
  const merged = mergeNpcs([
    { sessionNumber: 1, npcs: [{ name: 'Meepo', race: 'Kobold', notableMoments: ['Wept about the dragon.'] }] },
    { sessionNumber: 2, npcs: [{ name: 'meepo', notableMoments: ['Led the party to the queen.'] }] },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sessions, [1, 2]);
  assert.equal(merged[0].race, 'Kobold', 'a fact from the earlier session survives');
  assert.deepEqual(
    merged[0].notableMoments.map((m) => m.session),
    [1, 2],
    'moments accumulate and remember which session they came from'
  );
});

// A character who dies in session 4 must not read as alive because session 2
// said so.
test('facts that change take the value from the latest session', () => {
  const merged = mergeNpcs([
    { sessionNumber: 1, npcs: [{ name: 'Meepo', status: 'alive', partyStanding: 'wary' }] },
    { sessionNumber: 2, npcs: [{ name: 'Meepo', status: 'dead', partyStanding: 'friendly' }] },
  ]);
  assert.equal(merged[0].status, 'dead');
  assert.equal(merged[0].partyStanding, 'friendly');
});

test('aliases and locations accumulate without duplicating', () => {
  const merged = mergeNpcs([
    { sessionNumber: 1, npcs: [{ name: 'Meepo', aliases: ['the kobold'], locations: ['Sunless Citadel'] }] },
    { sessionNumber: 2, npcs: [{ name: 'Meepo', aliases: ['the kobold', 'Meepo the Brave'], locations: ['Sunless Citadel'] }] },
  ]);
  assert.deepEqual(merged[0].aliases, ['the kobold', 'Meepo the Brave']);
  assert.deepEqual(merged[0].locations, ['Sunless Citadel']);
});

test('the longer description wins', () => {
  const merged = mergeNpcs([
    { sessionNumber: 1, npcs: [{ name: 'Meepo', description: 'A kobold.' }] },
    { sessionNumber: 2, npcs: [{ name: 'Meepo', description: 'A distraught kobold who guards a stolen dragon.' }] },
  ]);
  assert.match(merged[0].description, /distraught/);
});

test('NPCs come back in a stable alphabetical order', () => {
  const merged = mergeNpcs([
    { sessionNumber: 1, npcs: [{ name: 'Rurik' }, { name: 'Bob' }, { name: 'Kerowyn' }] },
  ]);
  assert.deepEqual(merged.map((n) => n.name), ['Bob', 'Kerowyn', 'Rurik']);
});

// --- the note itself ---

const npc = {
  name: 'Meepo',
  aliases: ['Meepo the kobold'],
  race: 'Kobold',
  role: 'Keeper of the tribe’s dragon',
  status: 'alive',
  affiliation: 'Kobold tribe',
  locations: ['Sunless Citadel'],
  description: 'A small, distraught kobold.',
  motivation: 'Wants his dragon back.',
  relationships: [{ who: 'Kobold Queen', how: 'Serves her.' }],
  partyStanding: 'friendly',
  sessions: [1, 2],
  notableMoments: [{ session: 2, text: 'Begged the party for help.' }],
  quotes: [{ session: 2, text: 'Meepo miss dragon.' }],
  hooks: [{ session: 2, text: 'The dragon is still missing.' }],
};

test('the frontmatter carries what a DM would filter on', () => {
  const md = renderNpcNote(npc, { campaign: 'Cipher' });
  assert.match(md, /^name: "Meepo"$/m);
  assert.match(md, /^type: npc$/m);
  assert.match(md, /^race: "Kobold"$/m);
  assert.match(md, /^status: alive$/m);
  assert.match(md, /^party_standing: friendly$/m);
  assert.match(md, /^first_seen: 1$/m);
  assert.match(md, /^sessions: \[1, 2\]$/m);
  assert.match(md, /^campaign: "Cipher"$/m);
});

test('the note links back to the sessions it came from', () => {
  const md = renderNpcNote(npc);
  assert.match(md, /\[\[Session 02\]\]/, 'moments cite their session');
  assert.match(md, /## Appears in[\s\S]*\[\[Session 01\]\][\s\S]*\[\[Session 02\]\]/);
});

// A vault full of links to notes that will never exist is worse than plain
// text, so only known entities are linked.
test('only known entities become links', () => {
  const md = renderNpcNote(npc, { knownEntities: ['Kobold Queen'] });
  assert.match(md, /\[\[Kobold Queen\]\]/, 'a known NPC is linked');
  assert.ok(!md.includes('[[Sunless Citadel]]'), 'an unknown location stays plain');

  const withLocation = renderNpcNote(npc, { knownEntities: ['Sunless Citadel'] });
  assert.match(withLocation, /\[\[Sunless Citadel\]\]/);
});

test('quotes are rendered as attributed blockquotes', () => {
  const md = renderNpcNote(npc);
  assert.match(md, /^> Meepo miss dragon\.$/m);
});

test('open threads become checkboxes a DM can tick off', () => {
  assert.match(renderNpcNote(npc), /- \[ \] The dragon is still missing\./);
});

test('sections with nothing in them are left out', () => {
  const sparse = { ...npc, quotes: [], hooks: [], relationships: [], motivation: '' };
  const md = renderNpcNote(sparse);
  assert.ok(!md.includes('In their own words'));
  assert.ok(!md.includes('Threads left hanging'));
  assert.ok(!md.includes('What they want'));
  assert.match(md, /## Appears in/, 'but the session list always survives');
});

// --- filenames ---

test('a name becomes a filename', () => {
  assert.equal(npcFileName('Meepo'), 'Meepo.md');
  assert.equal(npcFileName('Illian Merrick'), 'Illian Merrick.md');
});

test('characters that break a path or Obsidian link are stripped', () => {
  assert.equal(npcFileName('Bob "The Knife" / Robert'), 'Bob The Knife Robert.md', 'and the gap left behind is collapsed');
  assert.equal(npcFileName('Vex [the Bold]'), 'Vex the Bold.md');
  assert.equal(npcFileName('Sir Braford.'), 'Sir Braford.md', 'a trailing dot is dropped on Windows');
});

test('a name with nothing usable in it yields no file', () => {
  assert.equal(npcFileName('///'), null);
  assert.equal(npcFileName('   '), null);
});

// --- keeping existing vault links alive ---

const extracted = () =>
  mergeNpcs([
    {
      sessionNumber: 1,
      npcs: [
        { name: 'Kerowyn Hucrele', aliases: ['Kerawin'] },
        { name: 'Ilion Merrick', aliases: ['Ilyn'] },
        { name: 'Yusdrayl', aliases: ['Queen Yusdrayl'] },
        { name: 'Talgan Hucrele' },
        { name: 'Sharwin Hucrele' },
        { name: 'Meepo' },
      ],
    },
  ]);

test('an exact existing name needs no help', () => {
  const { unresolved } = reconcileAliases(extracted(), ['Meepo']);
  assert.deepEqual(unresolved, []);
});

// Obsidian matches aliases verbatim, so "Kerowyn" must appear on the note even
// though the extracted name starts with it.
test('a shortened existing name is added as an alias', () => {
  const npcs = extracted();
  reconcileAliases(npcs, ['Kerowyn']);
  assert.ok(npcs.find((n) => n.name === 'Kerowyn Hucrele').aliases.includes('Kerowyn'));
});

test('a name the transcript misheard is matched despite the spelling', () => {
  const npcs = extracted();
  const { unresolved } = reconcileAliases(npcs, ['Illian Merrick']);
  assert.deepEqual(unresolved, []);
  assert.ok(npcs.find((n) => n.name === 'Ilion Merrick').aliases.includes('Illian Merrick'));
});

// Claiming one alias on two notes makes Obsidian pick one arbitrarily, so an
// ambiguous name is reported instead of guessed.
test('a name matching two NPCs is reported, not assigned', () => {
  const npcs = extracted();
  const { unresolved } = reconcileAliases(npcs, ['Talgan and Sharwin']);
  assert.deepEqual(unresolved, ['Talgan and Sharwin']);
  assert.ok(!npcs.some((n) => n.aliases.includes('Talgan and Sharwin')));
});

// "Kobold Queen" and "Queen Yusdrayl" share only "queen", which identifies
// nobody.
test('a match on a generic word alone does not count', () => {
  const npcs = extracted();
  const { unresolved } = reconcileAliases(npcs, ['Kobold Queen']);
  assert.deepEqual(unresolved, ['Kobold Queen']);
});

test('reconciliation is safe with nothing to reconcile', () => {
  assert.deepEqual(reconcileAliases(extracted(), []).unresolved, []);
  assert.deepEqual(reconcileAliases([], ['Anyone']).unresolved, ['Anyone']);
});
