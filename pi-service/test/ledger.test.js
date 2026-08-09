import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { entryKey, readKnownEntities, updateCampaignLedger, campaignDirInfo } from '../src/campaign/ledger.js';

// The dedup key is the whole point of the ledger: the summariser rephrases
// descriptions between sessions, so comparing full lines made every
// re-mention look brand new and the files grew duplicates forever.
test('entryKey collapses rephrasings of the same entity', () => {
  assert.equal(entryKey('- Vex the Bold — a smuggler _(session #3, 2026-01-01)_'), 'vex the bold');
  assert.equal(entryKey('Vex the Bold, smuggler of the docks'), 'vex the bold');
  assert.equal(entryKey('Vex the Bold - smuggler'), 'vex the bold');
  assert.equal(entryKey('The Rusty Anchor (a tavern)'), 'the rusty anchor');
  assert.equal(entryKey('Marrowgate'), 'marrowgate');

  assert.equal(
    entryKey('Vex the Bold — smuggler'),
    entryKey('Vex the Bold, a smuggler from the docks'),
    'differently-phrased descriptions of one NPC must produce the same key'
  );
});

test('entryKey is case- and whitespace-insensitive', () => {
  assert.equal(entryKey('  VEX THE BOLD  '), 'vex the bold');
});

async function tmpCfg() {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-ledger-'));
  return { cfg: { obsidianExportDir: dir }, dir };
}

test('updateCampaignLedger appends only genuinely new entries', async (t) => {
  const { cfg, dir } = await tmpCfg();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const meeting = { id: 1, guild_id: 'G', channel_name: 'Cipher', started_at: '2026-01-01T00:00:00Z' };
  await updateCampaignLedger({
    meeting,
    notes: { npcsIntroduced: ['Vex the Bold — a smuggler'], locationsVisited: ['The Rusty Anchor (tavern)'] },
    cfg,
    folder: 'Cipher',
  });

  // Same NPC, different wording, next session — must NOT be added again.
  await updateCampaignLedger({
    meeting: { ...meeting, id: 2 },
    notes: {
      npcsIntroduced: ['Vex the Bold, smuggler from the docks', 'Mira the Cook — new'],
      locationsVisited: ['The Rusty Anchor, still the same pub'],
    },
    cfg,
    folder: 'Cipher',
  });

  const { localDir } = campaignDirInfo(cfg, 'Cipher');
  const npcs = await readFile(join(localDir, 'NPCs.md'), 'utf8');
  const locations = await readFile(join(localDir, 'Locations.md'), 'utf8');

  assert.equal(npcs.match(/Vex the Bold/g).length, 1, 'Vex must appear exactly once');
  assert.match(npcs, /Mira the Cook/, 'a genuinely new NPC is still added');
  assert.equal(locations.match(/Rusty Anchor/g).length, 1, 'the tavern must not be re-listed');
});

test('readKnownEntities reports what the campaign has already recorded', async (t) => {
  const { cfg, dir } = await tmpCfg();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { localDir } = campaignDirInfo(cfg, 'Cipher');
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, 'NPCs.md'), '# NPCs\n\n- Vex the Bold — a smuggler _(session #1, 2026-01-01)_\n');
  await writeFile(join(localDir, 'Locations.md'), '# Locations\n\n- The Rusty Anchor (tavern) _(session #1, 2026-01-01)_\n');

  const known = await readKnownEntities(cfg, 'Cipher');
  assert.ok(known.npcs.has('vex the bold'));
  assert.ok(known.locations.has('the rusty anchor'));
  assert.ok(!known.npcs.has('mira the cook'));
});

test('readKnownEntities is empty (not an error) for a brand new campaign', async (t) => {
  const { cfg, dir } = await tmpCfg();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const known = await readKnownEntities(cfg, 'G', 'Never Played');
  assert.equal(known.npcs.size, 0);
  assert.equal(known.locations.size, 0);
});
