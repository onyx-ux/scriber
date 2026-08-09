import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFrontmatter,
  buildNameIndex,
  expandAliases,
  readVaultEntities,
  addPlainNames,
  canonicaliseEntries,
} from '../src/campaign/vault-index.js';
import { splitEntryName } from '../src/campaign/entry-name.js';
import { linkifyBody, linkifyNote } from '../src/campaign/vault-linker.js';
import { linkifyEntities } from '../src/export/linkify.js';

// --- reading the index out of the vault ---

test('parseFrontmatter reads the name and inline aliases', () => {
  const { name, aliases } = parseFrontmatter(`---
name: "Kobold Queen"
aliases: ["Kobold Queen", "Yusdrayl", "Yuzral"]
type: npc
---
# Kobold Queen
`);
  assert.equal(name, 'Kobold Queen');
  assert.deepEqual(aliases, ['Kobold Queen', 'Yusdrayl', 'Yuzral']);
});

test('parseFrontmatter also reads a hand-edited block list', () => {
  const { aliases } = parseFrontmatter(`---
name: Meepo
aliases:
  - Meepo
  - "Mee-po"
---
`);
  assert.deepEqual(aliases, ['Meepo', 'Mee-po']);
});

test('parseFrontmatter is not fooled by a --- later in the note', () => {
  const { name, aliases } = parseFrontmatter('# Meepo\n\n---\n\nname: not frontmatter\n');
  assert.equal(name, null);
  assert.deepEqual(aliases, []);
});

// Aliases are recorded as bare words; the prose writes them with the rest of
// the name attached, and linking only the bare word leaves "Hucrele" dangling
// outside the link.
test('expandAliases produces the title and surname forms', () => {
  const kerowyn = expandAliases('Kerowyn Hucrele', ['Kerawin']);
  assert.ok(kerowyn.includes('Kerawin Hucrele'), JSON.stringify(kerowyn));

  const queen = expandAliases('Kobold Queen', ['Yusdrayl']);
  assert.ok(queen.includes('Queen Yusdrayl'), JSON.stringify(queen));

  // A one-word name has nothing to stitch on.
  assert.deepEqual(expandAliases('Meepo', ['Meepo']), ['Meepo']);
});

// This is the whole reason buildNameIndex exists: both Hucrele siblings list
// "Talgan and Sharwin", and a link would resolve to whichever note Obsidian
// indexed first — silently, and differently on different machines.
test('an alias two notes both claim is dropped, not guessed', () => {
  const { targets, ambiguous } = buildNameIndex([
    { name: 'Talgan Hucrele', aliases: ['Talgan', 'Talgan and Sharwin'] },
    { name: 'Sharwin Hucrele', aliases: ['Sharwin', 'Talgan and Sharwin'] },
  ]);

  assert.ok(!targets.has('Talgan and Sharwin'));
  assert.deepEqual(ambiguous.map((a) => a.alias), ['Talgan and Sharwin']);
  assert.equal(targets.get('Talgan'), 'Talgan Hucrele', 'the unambiguous aliases still work');
  assert.equal(targets.get('Sharwin'), 'Sharwin Hucrele');
});

test('a canonical note name beats another note claiming it as an alias', () => {
  const { targets } = buildNameIndex([
    { name: 'Bob', aliases: [] },
    { name: 'Illian Merrick', aliases: ['Bob'] }, // a bad alias on someone else's note
  ]);
  assert.equal(targets.get('Bob'), 'Bob');
});

test('readVaultEntities takes the FILENAME as canonical', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'Cipher', 'NPCs'), { recursive: true });
  // Frontmatter disagreeing with the filename: the filename is what a
  // [[wikilink]] resolves against, so the frontmatter name is just an alias.
  await writeFile(
    join(dir, 'Cipher', 'NPCs', 'Kerowyn Hucrele.md'),
    '---\nname: "Kerowyn"\naliases: ["Kerawin"]\n---\n# Kerowyn\n',
    'utf8'
  );

  const [entity] = await readVaultEntities({ obsidianExportDir: dir }, 'Cipher');
  assert.equal(entity.name, 'Kerowyn Hucrele');
  assert.ok(entity.aliases.includes('Kerowyn'));
  assert.ok(entity.aliases.includes('Kerawin Hucrele'), 'the expanded form is there too');
});

test('a campaign with no entity notes is empty, not an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readVaultEntities({ obsidianExportDir: dir }, 'Nothing Here'), []);
});

// --- rendering ---

test('an alias links to the canonical note but keeps the prose wording', () => {
  const targets = new Map([['Yusdrayl', 'Kobold Queen']]);
  assert.equal(
    linkifyEntities('The party met Yusdrayl.', ['Yusdrayl'], { targets }),
    'The party met [[Kobold Queen|Yusdrayl]].'
  );
});

test('a canonical name still renders as a plain link', () => {
  const targets = new Map([['Meepo', 'Meepo']]);
  assert.equal(linkifyEntities('Meepo wept.', ['Meepo'], { targets }), '[[Meepo]] wept.');
});

// --- what the linker refuses to touch ---

const opts = (names, pairs = []) => ({ names, targets: new Map(pairs.length ? pairs : names.map((n) => [n, n])) });

test('frontmatter is never edited', () => {
  const note = '---\nname: "Meepo"\nlocations: ["Sunless Citadel"]\n---\n\nMeepo lives in the Sunless Citadel.\n';
  const out = linkifyNote(note, opts(['Sunless Citadel']));
  assert.match(out, /^---\nname: "Meepo"\nlocations: \["Sunless Citadel"\]\n---/, 'YAML untouched');
  assert.match(out, /lives in the \[\[Sunless Citadel\]\]/, 'the body is still linked');
});

test('headings are left alone so [[Note#heading]] links elsewhere keep working', () => {
  const out = linkifyBody('## Meepo and the dragon\n\nMeepo wept.\n', opts(['Meepo']));
  assert.match(out, /^## Meepo and the dragon$/m);
  assert.match(out, /\[\[Meepo\]\] wept/);
});

test('blockquotes are verbatim speech and stay verbatim', () => {
  const out = linkifyBody('> Wretched Goblin stole Kaltrix.\n\nHe meant Caltrix.\n', opts(['Caltrix', 'Kaltrix']));
  assert.match(out, /^> Wretched Goblin stole Kaltrix\.$/m);
  assert.match(out, /He meant \[\[Caltrix\]\]/);
});

test('the transcript half of a session note is never linked', () => {
  const note = ['## TL;DR', '', 'The party met Meepo.', '', '## Full Transcript', '', '**Matt:** Meepo is here.', ''].join('\n');
  const out = linkifyNote(note, opts(['Meepo']));
  assert.match(out, /The party met \[\[Meepo\]\]\./);
  assert.match(out, /\*\*Matt:\*\* Meepo is here\./, 'the transcript keeps its wording');
});

test('fenced code is not prose', () => {
  const out = linkifyBody('```\nMeepo = 1\n```\n\nMeepo wept.\n', opts(['Meepo']));
  assert.match(out, /^Meepo = 1$/m);
  assert.match(out, /\[\[Meepo\]\] wept/);
});

// --- scope ---

test('each section links a name once, so later sections are not left bare', () => {
  const note = [
    '## Description',
    'Meepo lost the dragon. Meepo wept.',
    '',
    '## What they did',
    '- Meepo guided the party.',
  ].join('\n');

  const out = linkifyBody(note, opts(['Meepo']));
  assert.equal((out.match(/\[\[Meepo\]\]/g) || []).length, 2, 'once per section, not once per note');
  assert.match(out, /- \[\[Meepo\]\] guided the party\./);
  assert.match(out, /lost the dragon\. Meepo wept\./, 'and not twice within a section');
});

// The ledger is a flat list of independent entries under one heading, so
// section scope would link only the first entry's mentions.
test('ledger list items each get their own scope', () => {
  const ledger = ['# NPCs', '', '- [[Garren]]: The barkeep at the Old Boar Inn.', '- [[Corky]]: A cleric at the Old Boar Inn.'].join('\n');

  const section = linkifyBody(ledger, { ...opts(['Old Boar Inn']), mode: 'section' });
  assert.equal((section.match(/\[\[Old Boar Inn\]\]/g) || []).length, 1);

  const item = linkifyBody(ledger, { ...opts(['Old Boar Inn']), mode: 'item' });
  assert.equal((item.match(/\[\[Old Boar Inn\]\]/g) || []).length, 2, 'every entry gets linked');
});

test('a name already linked in a scope is not linked again in it', () => {
  const out = linkifyBody('- **[[Meepo]]** — cared for as a pet by Meepo.\n', opts(['Meepo']));
  assert.equal(out, '- **[[Meepo]]** — cared for as a pet by Meepo.\n', 'unchanged');
});

test('an alias is not linked when its canonical note is already linked here', () => {
  const targets = new Map([
    ['Kerowyn Hucrele', 'Kerowyn Hucrele'],
    ['Kerowyn', 'Kerowyn Hucrele'],
  ]);
  const out = linkifyBody('- **[[Kerowyn Hucrele]]** — Mother of Kerowyn.\n', {
    names: ['Kerowyn Hucrele', 'Kerowyn'],
    targets,
  });
  assert.equal(out, '- **[[Kerowyn Hucrele]]** — Mother of Kerowyn.\n');
});

// --- the invariant that makes this safe to run over a whole vault ---

test('every line that is not a link change survives byte for byte', () => {
  const note = [
    '---',
    'name: "Meepo"',
    '---',
    '',
    '# Meepo',
    '',
    '*Kobold — Keeper of the dragon*',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'He guards the Sunless Citadel.',
    '',
  ].join('\n');

  const out = linkifyNote(note, opts(['Sunless Citadel']));
  assert.equal(out.split('\n').length, note.split('\n').length, 'line count preserved');

  const changed = out.split('\n').filter((l, i) => l !== note.split('\n')[i]);
  assert.deepEqual(changed, ['He guards the [[Sunless Citadel]].']);
});

test('a note with nothing to link comes back identical', () => {
  const note = '# Empty\n\nNothing to see.\n';
  assert.equal(linkifyNote(note, opts(['Meepo'])), note);
});

// --- keeping one entity to one ledger entry ---

// Changing summariser model changes the wording wholesale: 3.1-flash-lite
// wrote "Kobold Queen", 3.6-flash writes "Queen Yusdrayl". The ledger keys on
// the leading name, so without this the whole cast gets re-introduced under
// new spellings the first session after a model change.
test('a summariser renaming a known NPC is mapped back to the vault name', () => {
  const { targets } = buildNameIndex([{ name: 'Kobold Queen', aliases: expandAliases('Kobold Queen', ['Yusdrayl']) }]);

  assert.deepEqual(
    canonicaliseEntries(['Queen Yusdrayl - The ruler of the kobold tribe.'], targets, splitEntryName),
    ['Kobold Queen - The ruler of the kobold tribe.'],
    "the name is rewritten, the summariser's description is not"
  );
});

test('an entity the vault has never heard of is left exactly as written', () => {
  const { targets } = buildNameIndex([{ name: 'Meepo', aliases: [] }]);
  const entries = ['Grimlock the Unseen - A brand new villain.'];
  assert.deepEqual(canonicaliseEntries(entries, targets, splitEntryName), entries);
});

test('addPlainNames maps a ledger-only name to itself', () => {
  const index = addPlainNames(buildNameIndex([]), ['Shatterspike', null, '']);
  assert.equal(index.targets.get('Shatterspike'), 'Shatterspike');
  assert.equal(index.targets.size, 1, 'blanks are ignored');
});
