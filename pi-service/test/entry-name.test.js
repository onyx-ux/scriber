import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitEntryName, isUsableName } from '../src/campaign/entry-name.js';
import { entryKey, entryName } from '../src/campaign/ledger.js';
import { renderMarkdown } from '../src/export/markdown.js';

// Every string below is copied verbatim from a real exported session note.
// They all used a COLON, which the original split did not handle — so the
// wikilink wrapped the entire sentence when it was under the length guard
// and vanished when it was over, and the ledger keyed on the whole sentence.
const REAL = [
  ["Bob: A merchant's assistant who survives a wolf attack.", 'Bob'],
  ['Kerowyn: A mother who hires the party to rescue her children.', 'Kerowyn'],
  ['Rurik: The local blacksmith.', 'Rurik'],
  ['Oakhurst: A town where the party gathers at the Old Boar Inn.', 'Oakhurst'],
  ['Sunless Citadel: An ancient ruin partially sunk into the ground, accessible via a ravine.', 'Sunless Citadel'],
  ['Talgan and Sharwin: The missing children of Kerowyn.', 'Talgan and Sharwin'],
];

test('the name is split off however the model punctuated it', () => {
  for (const [entry, expected] of REAL) {
    assert.equal(splitEntryName(entry).name, expected, entry);
  }
  assert.equal(splitEntryName('Vex the Bold — a smuggler from the docks').name, 'Vex the Bold');
  assert.equal(splitEntryName('Old Miriam, herbalist').name, 'Old Miriam');
  assert.equal(splitEntryName('Corky (the local cleric)').name, 'Corky');
  assert.equal(splitEntryName('Garren').name, 'Garren', 'a bare name has no separator at all');
});

test('the description is preserved, not swallowed', () => {
  const { name, rest } = splitEntryName('Rurik: The local blacksmith.');
  assert.equal(name, 'Rurik');
  assert.equal(`${name}${rest}`, 'Rurik: The local blacksmith.', 'round-trips exactly');
});

// Splitting on whichever separator comes first keeps a name containing a
// comma intact when the real separator is a colon.
test('the first separator wins', () => {
  assert.equal(splitEntryName('Talgan and Sharwin: children, missing').name, 'Talgan and Sharwin');
  assert.equal(splitEntryName('Smith, Jones — two guards').name, 'Smith', 'comma genuinely comes first here');
});

test('a sentence with no name is left unlinked rather than made into a note', () => {
  const long = 'The party never learned who had been leaving the marks on the door of the inn';
  assert.equal(isUsableName(splitEntryName(long).name), false);
  assert.equal(isUsableName(''), false);
  assert.equal(isUsableName('12345'), false, 'digits alone are not a name');
  assert.equal(isUsableName('Bob'), true);
});

// A time like "10:30" has no space after the colon, so it must not split.
test('a colon without a following space is not a separator', () => {
  assert.equal(splitEntryName('The 10:30 Coach: a stagecoach line').name, 'The 10:30 Coach');
});

// --- the two things that were broken ---

test('the exported wikilink names the NPC, not the whole sentence', () => {
  const md = renderMarkdown({
    meeting: { id: 10, channel_name: 'Session', started_at: '2026-08-01T00:00:00Z' },
    utterances: [{ display_name: 'A', text: 'hi', start_ms: 0, end_ms: 1 }],
    notes: {
      tldr: 'A session.',
      npcsIntroduced: REAL.slice(0, 3).map(([e]) => e),
      locationsVisited: [REAL[3][0], REAL[4][0]],
    },
    cfg: { obsidianWikilinks: true },
  });

  for (const [, name] of REAL.slice(0, 5)) {
    assert.ok(md.includes(`[[${name}]]`), `expected [[${name}]] in the export`);
  }
  assert.ok(!md.includes("[[Bob: A merchant's"), 'the description must stay outside the link');
  assert.ok(md.includes("[[Bob]]: A merchant's assistant"), 'and must still be readable after it');
});

test('every NPC gets a link, not just the ones under 60 characters', () => {
  const md = renderMarkdown({
    meeting: { id: 10, channel_name: 'Session', started_at: '2026-08-01T00:00:00Z' },
    utterances: [{ display_name: 'A', text: 'hi', start_ms: 0, end_ms: 1 }],
    notes: { tldr: 'x', npcsIntroduced: REAL.map(([e]) => e) },
    cfg: { obsidianWikilinks: true },
  });

  const linked = (md.match(/\[\[/g) || []).length;
  assert.equal(linked, REAL.length, 'link count should not depend on description length');
});

test('wikilinks can still be turned off', () => {
  const md = renderMarkdown({
    meeting: { id: 10, channel_name: 'Session', started_at: '2026-08-01T00:00:00Z' },
    utterances: [{ display_name: 'A', text: 'hi', start_ms: 0, end_ms: 1 }],
    notes: { tldr: 'x', npcsIntroduced: ['Rurik: The local blacksmith.'] },
    cfg: { obsidianWikilinks: false },
  });
  assert.ok(!md.includes('[['));
});

// The ledger re-adds an NPC every session if the key includes the wording.
test('a re-mentioned NPC matches an earlier entry however it is reworded', () => {
  const stored = "- Kerowyn: A mother who hires the party to rescue her children. _(session #10, 2026-08-01)_";
  assert.equal(entryKey(stored), 'kerowyn');
  assert.equal(entryKey('Kerowyn: the grieving mother from Oakhurst'), 'kerowyn');
  assert.equal(entryKey('Kerowyn — mother of Talgan and Sharwin'), 'kerowyn');
});

test('ledger names keep their capitalisation for the whisper prompt', () => {
  assert.equal(entryName('- Sunless Citadel: An ancient ruin _(session #10)_'), 'Sunless Citadel');
  assert.equal(entryName('- [[Vex the Bold]] — a smuggler'), 'Vex the Bold');
});

// The exporter links NPC names, so stored ledger lines contain brackets. If
// the key kept them, every linked NPC would be re-appended every session.
test('a linked ledger entry still matches an unlinked mention', () => {
  assert.equal(entryKey("- [[Bob]]: A merchant's assistant. _(session #10, 2026-08-01)_"), 'bob');
  assert.equal(entryKey('Bob: a merchant assistant'), 'bob');
  assert.equal(
    entryKey('- [[Sunless Citadel]]: An ancient ruin _(session #10)_'),
    entryKey('Sunless Citadel — a ruin below the ravine')
  );
});

// --- the ledger writes linked entries too ---

test('new ledger entries are linked, and dedupe still matches them', async (t) => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { updateCampaignLedger } = await import('../src/campaign/ledger.js');

  const dir = await mkdtemp(join(tmpdir(), 'scriber-ledger-'));
  const cfg = { obsidianExportDir: dir, obsidianWikilinks: true };
  const meeting = { id: 16, guild_id: 'G1', channel_name: 'Session', started_at: '2026-08-08' };

  await updateCampaignLedger({
    meeting,
    notes: {
      npcsIntroduced: ['Meepo: A distraught kobold guarding a stolen dragon.'],
      locationsVisited: ['Sunless Citadel: An ancient ruin.'],
      unresolvedThreads: ['Whether the kobolds can be trusted at all.'],
    },
    cfg,
    folder: 'Cipher',
  });

  const npcs = await readFile(join(dir, 'Cipher', 'Ledger', 'NPCs.md'), 'utf8');
  assert.match(npcs, /- \[\[Meepo\]\]: A distraught kobold/, 'entities are linked');

  // Sentences are not entities — a note per plot point helps nobody.
  const threads = await readFile(join(dir, 'Cipher', 'Ledger', 'Unresolved-Threads.md'), 'utf8');
  assert.ok(!threads.includes('[['), 'threads stay unlinked');

  // The same NPC arriving unlinked next session must match the linked entry.
  await updateCampaignLedger({
    meeting: { ...meeting, id: 17 },
    notes: { npcsIntroduced: ['Meepo: the kobold, still upset'] },
    cfg,
    folder: 'Cipher',
  });
  const after = await readFile(join(dir, 'Cipher', 'Ledger', 'NPCs.md'), 'utf8');
  assert.equal((after.match(/Meepo/g) || []).length, 1, 'no duplicate on re-mention');
});

// A slash inside [[...]] is a PATH separator, not part of the name:
// [[Kobold Lair / Throne Room]] looks for "Throne Room" inside a folder
// called "Kobold Lair " and finds nothing. The raw markdown looks fine,
// which is what makes it worth a guard rather than a review.
test('a name containing wikilink syntax is not linked at all', async () => {
  const { isUsableName } = await import('../src/campaign/entry-name.js');

  assert.equal(isUsableName('Kobold Lair / Throne Room'), false, 'slash is a path separator');
  assert.equal(isUsableName('Sunless Citadel#Lower'), false, 'hash is a heading link');
  assert.equal(isUsableName('Meepo|Kaltrix'), false, 'pipe is an alias separator');
  assert.equal(isUsableName('The [Outcast]'), false);

  // Punctuation with no meaning inside a link is still fine.
  assert.equal(isUsableName('Goblin Guard Post & Target Practice Room'), true);
  assert.equal(isUsableName("Meepo's Room"), true);
  assert.equal(isUsableName('Kobold Queen'), true);
});
