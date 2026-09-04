import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import { linesOf, isPart, partName, anchorOf, readingOf, redlineOf } from '../src/notes/redline.js';

// Corrections the table makes to a write-up.
//
// The promise this feature is built on is that NOTHING here can destroy the
// summariser's text. Most of this file is that promise written as assertions:
// the base survives every correction, a correction removed brings the original
// line straight back, and the one thing that genuinely replaces the base — a
// re-summarise — keeps the old write-up and its redlines rather than dropping
// them on the floor.

const BASE = {
  tldr: 'They went through the front door and found the registry already open.',
  scenes: [
    { title: 'The queue at the notary', points: ['Wren stamped the writ.', 'Nobody read it.'] },
    { title: 'Down the service stair', points: ['Brizzlebek went first.'] },
  ],
  partyDecisions: ['Leave the stone in the wall.'],
  unresolvedThreads: [],
  followUps: ['Find out who else has a writ like this one.'],
  npcsIntroduced: ['Wren Halloway — the notary clerk.'],
  locationsVisited: ['The Ashen Vaults — the notary house on the hill.'],
  lootAndRewards: [],
  funnyMoments: [],
};

const note = (over = {}) => ({
  id: 1, part: 'tldr', index: 0, quoted: BASE.tldr, body: 'It was the side door.',
  userId: 'saf', createdAt: '2026-09-04T10:00:00Z', ...over,
});

// --- addressing ------------------------------------------------------------

test('every piece of a write-up can be pointed at', () => {
  const lines = linesOf(BASE);

  // Single-value fields are one-element lists rather than a special case, so
  // there is one shape to anchor against.
  assert.deepEqual(lines.get('tldr'), [BASE.tldr]);
  assert.deepEqual(lines.get('scene:0:title'), ['The queue at the notary']);
  assert.deepEqual(lines.get('scene:0'), ['Wren stamped the writ.', 'Nobody read it.']);
  assert.deepEqual(lines.get('scene:1'), ['Brizzlebek went first.']);
  assert.deepEqual(lines.get('followUps'), ['Find out who else has a writ like this one.']);

  // A section the summariser left empty is still a part — it just has nothing
  // in it. Absent and empty are different, and only one of them is an error.
  assert.deepEqual(lines.get('unresolvedThreads'), []);
  assert.equal(isPart(BASE, 'unresolvedThreads'), true);
  assert.equal(isPart(BASE, 'scene:9'), false);
  assert.equal(isPart(BASE, 'constructor'), false);
  assert.equal(isPart(BASE, ''), false);
});

test('a part has a name a person would recognise', () => {
  assert.equal(partName('followUps'), 'Follow-ups');
  assert.match(partName('scene:0', BASE), /queue at the notary/);
  assert.match(partName('scene:0:title', BASE), /title of/);
  // A scene with no title of its own is still nameable.
  assert.match(partName('scene:1', { scenes: [{}, {}] }), /scene 2/);
});

// --- where a correction landed --------------------------------------------

test('a correction finds its line again after one above it is removed', () => {
  const lines = linesOf(BASE);
  // Written against the second point, and the write-up now has it first.
  const moved = linesOf({ ...BASE, scenes: [{ title: 'x', points: ['Nobody read it.'] }] });

  assert.deepEqual(anchorOf(lines, note({ part: 'scene:0', index: 1, quoted: 'Nobody read it.' })),
                   { state: 'held', part: 'scene:0', index: 1 });
  assert.deepEqual(anchorOf(moved, note({ part: 'scene:0', index: 1, quoted: 'Nobody read it.' })),
                   { state: 'moved', part: 'scene:0', index: 0 });
});

test('a correction whose line is gone is kept, not dropped', () => {
  // The failure this exists to stop: somebody's own words about their own
  // game disappearing quietly because the text moved underneath them.
  const gone = linesOf({ ...BASE, scenes: [] });
  const at = anchorOf(gone, note({ part: 'scene:0', index: 1, quoted: 'Nobody read it.' }));
  assert.equal(at.state, 'orphaned');

  const view = redlineOf({ ...BASE, scenes: [] },
                         [note({ part: 'scene:0', index: 1, quoted: 'Nobody read it.' })]);
  assert.equal(view.orphaned.length, 1);
  assert.equal(view.orphaned[0].quoted, 'Nobody read it.');
});

// --- what it reads as ------------------------------------------------------

test('a correction changes what the write-up says and not what it is', () => {
  const corrected = readingOf(BASE, [note()]);
  assert.equal(corrected.tldr, 'It was the side door.');
  // The base object is untouched — every renderer of a write-up gets the same
  // shape, and the summariser's text is still exactly what it was.
  assert.equal(BASE.tldr, 'They went through the front door and found the registry already open.');
});

test('taking the correction away brings the original line straight back', () => {
  assert.equal(readingOf(BASE, [note()]).tldr, 'It was the side door.');
  assert.equal(readingOf(BASE, []).tldr, BASE.tldr);
});

test('an empty correction strikes a line out without deleting anything', () => {
  const corrected = readingOf(BASE, [note({ part: 'scene:0', index: 1, quoted: 'Nobody read it.', body: '' })]);
  assert.deepEqual(corrected.scenes[0].points, ['Wren stamped the writ.']);
  // And it is still in the base, so removing the correction restores it.
  assert.deepEqual(readingOf(BASE, []).scenes[0].points, ['Wren stamped the writ.', 'Nobody read it.']);
});

test('a line corrected twice reads as the newest and shows the argument', () => {
  const first = note({ id: 1, body: 'It was the side door.', createdAt: '2026-09-04T10:00:00Z', userId: 'saf' });
  const second = note({ id: 2, body: 'It was the cellar hatch.', createdAt: '2026-09-04T11:00:00Z', userId: 'rhi' });

  // Handed in the wrong order on purpose: the reading is decided by when they
  // were written, not by what the caller happened to pass.
  assert.equal(readingOf(BASE, [second, first]).tldr, 'It was the cellar hatch.');

  const line = redlineOf(BASE, [second, first]).parts
    .find((p) => p.part === 'tldr').lines[0];
  assert.equal(line.marks.length, 2);
  assert.deepEqual(line.marks.map((m) => m.userId), ['saf', 'rhi']);
  assert.equal(line.reading, 'It was the cellar hatch.');
  assert.equal(line.base, BASE.tldr);
});

test('the marked-up view says what was written and what it says now', () => {
  const view = redlineOf(BASE, [note(), note({ id: 2, part: 'scene:0', index: 1, quoted: 'Nobody read it.', body: '' })]);
  assert.equal(view.count, 2);

  const tldr = view.parts.find((p) => p.part === 'tldr').lines[0];
  assert.equal(tldr.struck, true);
  assert.equal(tldr.gone, false);

  const point = view.parts.find((p) => p.part === 'scene:0').lines[1];
  assert.equal(point.struck, true);
  assert.equal(point.gone, true, 'struck with nothing put back is not the same as corrected');

  // An untouched line is untouched.
  const kept = view.parts.find((p) => p.part === 'scene:0').lines[0];
  assert.equal(kept.struck, false);
  assert.equal(kept.reading, kept.base);
});

test('a write-up nobody has corrected reads exactly as it was written', () => {
  assert.deepEqual(readingOf(BASE, []), { ...BASE, scenes: BASE.scenes.map((s) => ({ ...s })) });
  assert.deepEqual(readingOf(BASE, null), { ...BASE, scenes: BASE.scenes.map((s) => ({ ...s })) });
});

// --- the store, and the one thing that really replaces the base ------------

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-redline-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.setSummary(meetingId, BASE);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return { db, campaignId, meetingId };
}

test('a correction is stored against the line it was written about', async (t) => {
  const { db, meetingId } = await world(t);
  const row = db.addRecapNote({
    meetingId, part: 'tldr', index: 0, quoted: BASE.tldr,
    body: 'It was the side door.', userId: 'saf',
  });

  assert.equal(row.part, 'tldr');
  assert.equal(row.index, 0, 'the column is idx because INDEX is a SQL keyword; nothing above the store says so');
  assert.equal(row.quoted, BASE.tldr);
  assert.equal(row.versionId, null, 'a new correction is on the write-up that is current');
  assert.ok(row.createdAt, 'read back from disk rather than assembled from the arguments');

  assert.equal(db.countRecapNotes(meetingId), 1);
  assert.deepEqual(db.listRecapNotes(meetingId).map((n) => n.id), [row.id]);
});

test('you can change and take back your own correction, and nobody else’s', async (t) => {
  const { db, meetingId } = await world(t);
  const mine = db.addRecapNote({ meetingId, part: 'tldr', index: 0, quoted: BASE.tldr, body: 'Side door.', userId: 'saf' });

  assert.equal(db.editRecapNote(mine.id, 'rhi', 'no'), 0, 'somebody else changed it');
  assert.equal(db.removeRecapNote(mine.id, 'rhi'), 0, 'somebody else removed it');
  assert.equal(db.getRecapNote(mine.id).body, 'Side door.');

  assert.equal(db.editRecapNote(mine.id, 'saf', 'The side door.'), 1);
  assert.equal(db.getRecapNote(mine.id).body, 'The side door.');
  assert.ok(db.getRecapNote(mine.id).editedAt, 'a changed correction says it was changed');

  assert.equal(db.removeRecapNote(mine.id, 'saf'), 1);
  assert.equal(db.getRecapNote(mine.id), null);
});

// The whole reason this feature has versions at all. Re-summarising is the one
// act that genuinely destroys what a correction was written about, and it is
// the deletion the feature exists to prevent, arriving by the back door.
test('re-summarising keeps the old write-up and the corrections on it', async (t) => {
  const { db, meetingId } = await world(t);
  db.addRecapNote({ meetingId, part: 'tldr', index: 0, quoted: BASE.tldr, body: 'Side door.', userId: 'saf' });
  db.addRecapNote({ meetingId, part: 'scene:0', index: 1, quoted: 'Nobody read it.', body: '', userId: 'rhi' });

  db.setSummary(meetingId, { tldr: 'A completely different opening.', scenes: [], partyDecisions: [] });

  // The new write-up starts clean. Nothing is re-anchored onto it: a
  // correction is somebody's words about a sentence, and guessing which new
  // sentence they meant would be inventing their opinion.
  assert.equal(db.countRecapNotes(meetingId), 0);

  const [version] = db.listRecapVersions(meetingId);
  assert.ok(version, 'the replaced write-up was not kept');
  assert.equal(version.notes, 2, 'the corrections did not go with it');

  const old = db.getRecapVersion(version.id);
  assert.equal(old.notes.tldr, BASE.tldr);
  const kept = db.listRecapNotes(meetingId, version.id);
  assert.equal(kept.length, 2);
  assert.equal(readingOf(old.notes, kept).tldr, 'Side door.',
               'the old version no longer reads as the table corrected it');
});

test('re-summarising a write-up nobody corrected leaves no version behind', async (t) => {
  const { db, meetingId } = await world(t);
  db.setSummary(meetingId, { tldr: 'Another go.', scenes: [] });

  // The value kept here is the redlines, not the model's earlier drafts. A
  // night summarised three times with nobody touching it should not grow a
  // version history.
  assert.deepEqual(db.listRecapVersions(meetingId), []);
});

test('a version with an unreadable blob says so rather than throwing', async (t) => {
  const { db, meetingId } = await world(t);
  db.addRecapNote({ meetingId, part: 'tldr', index: 0, quoted: BASE.tldr, body: 'Side door.', userId: 'saf' });
  db.raw.prepare(`UPDATE meetings SET summary_json = '{not json' WHERE id = ?`).run(meetingId);
  db.setSummary(meetingId, { tldr: 'New.', scenes: [] });

  const [version] = db.listRecapVersions(meetingId);
  assert.equal(db.getRecapVersion(version.id).notes, null);
  assert.equal(db.getRecapVersion(99999), null);
});
