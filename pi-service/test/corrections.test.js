import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyCorrections, correctionRegex } from '../src/campaign/corrections.js';
import { openDb } from '../src/store/db.js';

const fix = [{ wrong_text: 'Vecks', correct_text: 'Vex' }];

test('corrections are case-insensitive but preserve the intended replacement', () => {
  assert.equal(applyCorrections('vecks drew his blade', fix), 'Vex drew his blade');
  assert.equal(applyCorrections('VECKS shouted', fix), 'Vex shouted');
  assert.equal(applyCorrections('Vecks and Vecks again', fix), 'Vex and Vex again');
});

// Without word boundaries, correcting a short name would corrupt any longer
// word containing it.
test('corrections respect word boundaries', () => {
  assert.equal(
    applyCorrections('the Vecksington estate', fix),
    'the Vecksington estate',
    'a longer word containing the term must be left alone'
  );
  assert.equal(applyCorrections('Vecks, the smuggler', fix), 'Vex, the smuggler');
  assert.equal(applyCorrections('"Vecks!"', fix), '"Vex!"');
});

test('replacement text is literal, not a regex substitution', () => {
  assert.equal(
    applyCorrections('say Vecks', [{ wrong_text: 'Vecks', correct_text: '$& and $1' }]),
    'say $& and $1',
    '"$&" in the replacement must not re-insert the match'
  );
});

test('regex metacharacters in the mangled name are escaped', () => {
  assert.doesNotThrow(() => correctionRegex('a.b*c('));
  assert.equal(applyCorrections('a.b*c( here', [{ wrong_text: 'a.b*c(', correct_text: 'ok' }]), 'ok here');
  assert.equal(
    applyCorrections('axbxc here', [{ wrong_text: 'a.b*c(', correct_text: 'ok' }]),
    'axbxc here',
    'the dot must not act as a wildcard'
  );
});

test('multiple corrections apply in sequence', () => {
  const out = applyCorrections('Vecks met Mira Cook at the Rusti Anchor', [
    { wrong_text: 'Vecks', correct_text: 'Vex' },
    { wrong_text: 'Rusti', correct_text: 'Rusty' },
  ]);
  assert.equal(out, 'Vex met Mira Cook at the Rusty Anchor');
});

test('applyCorrections is safe with no corrections or empty text', () => {
  assert.equal(applyCorrections('unchanged', []), 'unchanged');
  assert.equal(applyCorrections('unchanged', undefined), 'unchanged');
  assert.equal(applyCorrections(null, fix), '');
});

async function freshDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-corr-'));
  const db = openDb(join(dir, 'db.sqlite'));
  // Close the native handle before removing the directory — on Windows,
  // deleting a WAL file that better-sqlite3 still has open fails with EBUSY
  // (Linux allows unlinking open files; Windows doesn't).
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

test('corrections are stored per campaign and upsert on repeat', async (t) => {
  const db = await freshDb(t);
  const a = db.defaultCampaignId('G1');
  const b = db.defaultCampaignId('G2');
  db.addCorrection(a, 'Vecks', 'Vex');
  db.addCorrection(a, 'Vecks', 'Vexx');
  db.addCorrection(b, 'Vecks', 'Other');

  const first = db.listCorrections(a);
  assert.equal(first.length, 1, 'correcting the same term twice updates rather than duplicates');
  assert.equal(first[0].correct_text, 'Vexx');
  assert.equal(db.listCorrections(b)[0].correct_text, 'Other', 'campaigns keep separate corrections');
});

test('two campaigns in ONE server keep separate corrections', async (t) => {
  const db = await freshDb(t);
  const first = db.createCampaign('G', 'Cipher', 'dm-a');
  const second = db.createCampaign('G', 'Strahd', 'dm-b');

  db.addCorrection(first, 'Vecks', 'Vex');
  assert.deepEqual(db.listCorrections(second), [], 'the other table at the same Discord is unaffected');
  assert.equal(db.listCorrections(first)[0].correct_text, 'Vex');
});

test('rewriteUtterances fixes past transcripts and reports how many changed', async (t) => {
  const db = await freshDb(t);
  const id = db.createMeeting({
    guildId: 'G1',
    channelId: 'C1',
    channelName: 'Cipher',
    startedAt: '2026-07-31T10:00:00Z',
    audioDir: '/tmp/a',
  });
  db.finalizeTranscription(id, [
    { userId: 'u1', displayName: 'Koru', startMs: 0, endMs: 1, text: 'Vecks opens the door' },
    { userId: 'u1', displayName: 'Koru', startMs: 1, endMs: 2, text: 'nothing to change here' },
  ]);

  const changed = db.rewriteUtterances(db.defaultCampaignId('G1'), (text) => applyCorrections(text, fix));
  assert.equal(changed, 1, 'only lines that actually differ are counted');

  const texts = db.listUtterances(id).map((u) => u.text);
  assert.deepEqual(texts, ['Vex opens the door', 'nothing to change here']);
});

test('rewriteUtterances never touches another campaign', async (t) => {
  const db = await freshDb(t);
  const mine = db.createMeeting({ guildId: 'G1', channelId: 'C', channelName: 'A', startedAt: 'x', audioDir: '/a' });
  const theirs = db.createMeeting({ guildId: 'G2', channelId: 'C', channelName: 'B', startedAt: 'x', audioDir: '/a' });
  db.finalizeTranscription(mine, [{ userId: 'u', displayName: 'd', startMs: 0, endMs: 1, text: 'Vecks' }]);
  db.finalizeTranscription(theirs, [{ userId: 'u', displayName: 'd', startMs: 0, endMs: 1, text: 'Vecks' }]);

  db.rewriteUtterances(db.defaultCampaignId('G1'), (text) => applyCorrections(text, fix));
  assert.equal(db.listUtterances(mine)[0].text, 'Vex');
  assert.equal(db.listUtterances(theirs)[0].text, 'Vecks', 'another guild is untouched');
});

test('rewriteUtterances never touches the other campaign in the same server', async (t) => {
  const db = await freshDb(t);
  const first = db.createCampaign('G', 'Cipher', 'dm-a');
  const second = db.createCampaign('G', 'Strahd', 'dm-b');
  const mine = db.createMeeting({ guildId: 'G', campaignId: first, channelId: 'C', channelName: 'A', startedAt: 'x', audioDir: '/a' });
  const theirs = db.createMeeting({ guildId: 'G', campaignId: second, channelId: 'C', channelName: 'B', startedAt: 'x', audioDir: '/a' });
  db.finalizeTranscription(mine, [{ userId: 'u', displayName: 'd', startMs: 0, endMs: 1, text: 'Vecks' }]);
  db.finalizeTranscription(theirs, [{ userId: 'u', displayName: 'd', startMs: 0, endMs: 1, text: 'Vecks' }]);

  db.rewriteUtterances(first, (text) => applyCorrections(text, fix));
  assert.equal(db.listUtterances(mine)[0].text, 'Vex');
  assert.equal(db.listUtterances(theirs)[0].text, 'Vecks', 'the other table in the same Discord is untouched');
});

test('removeCorrection deletes only the named term', async (t) => {
  const db = await freshDb(t);
  const c = db.defaultCampaignId('G1');
  db.addCorrection(c, 'Vecks', 'Vex');
  db.addCorrection(c, 'Rusti', 'Rusty');

  assert.equal(db.removeCorrection(c, 'Vecks'), 1);
  assert.deepEqual(
    db.listCorrections(c).map((x) => x.wrong_text),
    ['Rusti']
  );
});
