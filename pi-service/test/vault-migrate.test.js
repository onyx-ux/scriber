import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLedgerFolders, planLedgerMigration, moveCampaignFolder } from '../src/campaign/vault-migrate.js';
import { campaignDirInfo, readKnownEntities } from '../src/campaign/ledger.js';

async function vault(campaigns) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-vault-'));
  return {
    dir,
    cfg: { obsidianExportDir: dir },
    db: { listCampaigns: () => campaigns },
  };
}

async function legacyLedger(dir, name, files) {
  const path = join(dir, 'campaign', name);
  await mkdir(path, { recursive: true });
  for (const [file, body] of Object.entries(files)) await writeFile(join(path, file), body, 'utf8');
  return path;
}

const missing = async (path) => {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
};

test('a legacy ledger folder moves under its campaign', async (t) => {
  const { dir, cfg, db } = await vault([
    { guild_id: '1341529060836380703', campaign_name: 'Cipher', channel_name: '🎲Session' },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const legacy = await legacyLedger(dir, '1341529060836380703-session', {
    'NPCs.md': '# NPCs\n\n- [[Meepo]]: a kobold _(session #16, 2026-08-08)_\n',
    'Locations.md': '# Locations\n\n- [[Oakhurst]]: a village _(session #16, 2026-08-08)_\n',
  });

  const [step] = await migrateLedgerFolders({ db, cfg });
  assert.equal(step.to, join(dir, 'Cipher', 'Ledger'));
  assert.deepEqual(step.moved.sort(), ['Locations.md', 'NPCs.md']);

  // The point of the move: the ledger still reads, from the new location.
  const known = await readKnownEntities(cfg, 'Cipher');
  assert.ok(known.npcs.has('meepo'), 'the NPC survived the move');
  assert.ok(known.locations.has('oakhurst'));

  assert.ok(await missing(legacy), 'the guild-id folder is gone');
  assert.ok(await missing(join(dir, 'campaign')), 'and so is the campaign/ root it lived in');
});

// The campaign name is what /campaign set; without one it falls back to the
// channel — the same rule the session notes use, so a campaign is one folder.
test('an unnamed campaign migrates to its channel-name folder', async (t) => {
  const { dir, cfg, db } = await vault([
    { guild_id: '175407579835531264', campaign_name: null, channel_name: 'Crack Animal Zoo' },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await legacyLedger(dir, '175407579835531264-crack-animal-zoo', { 'NPCs.md': '# NPCs\n\n- Bob: a merchant\n' });
  await migrateLedgerFolders({ db, cfg });

  assert.deepEqual(await readdir(join(dir, 'Crack Animal Zoo', 'Ledger')), ['NPCs.md']);
});

test('running it twice is a no-op, not a second move', async (t) => {
  const { dir, cfg, db } = await vault([{ guild_id: 'G', campaign_name: 'Cipher', channel_name: 'Session' }]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await legacyLedger(dir, 'G-session', { 'NPCs.md': '# NPCs\n\n- Bob\n' });
  assert.equal((await migrateLedgerFolders({ db, cfg })).length, 1);
  assert.equal((await migrateLedgerFolders({ db, cfg })).length, 0, 'nothing left to do');
});

// Overwriting is the one outcome worth avoiding outright: the destination is
// the newer copy, and the ledger is a file you edit by hand.
test('a clash leaves both copies alone rather than overwriting', async (t) => {
  const { dir, cfg, db } = await vault([{ guild_id: 'G', campaign_name: 'Cipher', channel_name: 'Session' }]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await legacyLedger(dir, 'G-session', { 'NPCs.md': 'old\n' });
  const { localDir } = campaignDirInfo(cfg, 'Cipher');
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, 'NPCs.md'), 'new\n', 'utf8');

  const [step] = await migrateLedgerFolders({ db, cfg });
  assert.deepEqual(step.skipped, ['NPCs.md']);
  assert.equal(await readFile(join(localDir, 'NPCs.md'), 'utf8'), 'new\n', 'the destination wins');
  assert.equal(await readFile(join(dir, 'campaign', 'G-session', 'NPCs.md'), 'utf8'), 'old\n', 'and the old copy is kept');
});

test('a ledger for an unknown guild is reported, not guessed at', async (t) => {
  const { dir, cfg, db } = await vault([]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await legacyLedger(dir, '999-mystery', { 'NPCs.md': '- Bob\n' });
  const [step] = await planLedgerMigration({ db, cfg });
  assert.equal(step.to, null);
  assert.match(step.reason, /no campaign/);

  await migrateLedgerFolders({ db, cfg });
  assert.equal(await readFile(join(dir, 'campaign', '999-mystery', 'NPCs.md'), 'utf8'), '- Bob\n');
});

test('no campaign/ folder at all is fine', async (t) => {
  const { dir, cfg, db } = await vault([]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await migrateLedgerFolders({ db, cfg }), []);
});

// --- /campaign renames ---

test('renaming a campaign carries its whole folder across', async (t) => {
  const { dir, cfg } = await vault([]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'Crack Animal Zoo', 'Ledger'), { recursive: true });
  await mkdir(join(dir, 'Crack Animal Zoo', 'NPCs'), { recursive: true });
  await writeFile(join(dir, 'Crack Animal Zoo', 'Session 01.md'), '# one\n', 'utf8');
  await writeFile(join(dir, 'Crack Animal Zoo', 'Ledger', 'NPCs.md'), '- Bob\n', 'utf8');

  const result = await moveCampaignFolder({ cfg, from: 'Crack Animal Zoo', to: 'testhouse2' });
  assert.equal(result.moved, true);
  assert.ok(await missing(join(dir, 'Crack Animal Zoo')));
  assert.equal(await readFile(join(dir, 'testhouse2', 'Ledger', 'NPCs.md'), 'utf8'), '- Bob\n');
  assert.deepEqual((await readdir(join(dir, 'testhouse2'))).sort(), ['Ledger', 'NPCs', 'Session 01.md']);
});

test('renaming onto an existing folder merges instead of clobbering', async (t) => {
  const { dir, cfg } = await vault([]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'Old'), { recursive: true });
  await mkdir(join(dir, 'New'), { recursive: true });
  await writeFile(join(dir, 'Old', 'Session 01.md'), 'old\n', 'utf8');
  await writeFile(join(dir, 'Old', 'Session 02.md'), 'moved\n', 'utf8');
  await writeFile(join(dir, 'New', 'Session 01.md'), 'kept\n', 'utf8');

  const result = await moveCampaignFolder({ cfg, from: 'Old', to: 'New' });
  assert.deepEqual(result.files, ['Session 02.md']);
  assert.deepEqual(result.skipped, ['Session 01.md']);
  assert.equal(await readFile(join(dir, 'New', 'Session 01.md'), 'utf8'), 'kept\n');
  assert.equal(await readFile(join(dir, 'New', 'Session 02.md'), 'utf8'), 'moved\n');
});

test('renaming when nothing was ever exported does nothing', async (t) => {
  const { dir, cfg } = await vault([]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal((await moveCampaignFolder({ cfg, from: 'Nope', to: 'Also Nope' })).moved, false);
  assert.equal((await moveCampaignFolder({ cfg, from: 'Same', to: 'Same' })).moved, false);
});

// A dry run has to be able to answer "what would this do" without doing it —
// it is how the real vault gets checked before the real move.
test('a dry run reports the plan and touches nothing', async (t) => {
  const { dir, cfg, db } = await vault([{ guild_id: 'G', campaign_name: 'Cipher', channel_name: 'Session' }]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await legacyLedger(dir, 'G-session', { 'NPCs.md': '- Bob\n' });
  const [step] = await migrateLedgerFolders({ db, cfg, apply: false });

  assert.deepEqual(step.moved, ['NPCs.md']);
  assert.equal(await readFile(join(dir, 'campaign', 'G-session', 'NPCs.md'), 'utf8'), '- Bob\n');
  assert.ok(await missing(join(dir, 'Cipher')), 'nothing was created');
});
