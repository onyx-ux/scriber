import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildNotesView } from '../src/web/notes-view.js';

// Reading back a recap the summariser wrote.
//
// Almost every test here is about tolerance rather than formatting, and that
// is the point: this blob is written by a language model and has been through
// several prompt revisions. Fields get added, a model occasionally returns a
// string where the schema said array, and a session summarised a year ago has
// to still open. A reader that assumes the current schema is a reader that
// breaks on the oldest and most valuable notes in the vault.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-notes-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  return { db, campaignId };
}

function session(db, campaignId, summary) {
  const id = db.createMeeting({
    guildId: 'guild-1',
    campaignId,
    channelId: 'voice',
    channelName: 'Voice Chat',
    startedAt: '2026-08-01T19:00:00Z',
    audioDir: '/tmp',
  });
  db.finalizeTranscription(id, [{ userId: '111', displayName: 'Matt', startMs: 0, endMs: 1, text: 'we go in' }]);
  db.endMeeting(id, '2026-08-01T22:00:00Z');
  if (summary !== undefined) db.setSummary(id, summary);
  return id;
}

test('a session that was never summarised opens, and says there is nothing yet', async (t) => {
  const { db, campaignId } = await harness(t);
  const view = buildNotesView({ db, meetingId: session(db, campaignId) });

  assert.equal(view.written, false, 'not an error — it may still be waiting on you to approve it');
  assert.equal(view.ref, 'Cipher_01');
  assert.deepEqual(view.scenes, []);
});

test('an unknown session is nothing, not an empty recap', async (t) => {
  const { db } = await harness(t);
  assert.equal(buildNotesView({ db, meetingId: 9999 }), null);
});

test('a full recap comes back field for field', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, {
    tldr: 'The party opened the door.',
    scenes: [{ title: 'The door', points: ['It was locked', 'Then it was not'] }],
    partyDecisions: ['Went left'],
    unresolvedThreads: ['Who locked it?'],
    followUps: [{ assignee: 'Matt', task: 'buy rope' }, { assignee: null, task: 'find the key' }],
    npcsIntroduced: ['Doorkeeper — grumpy'],
    locationsVisited: ['The Door'],
    lootAndRewards: ['40gp'],
    funnyMoments: ['Vex tried to eat the lock'],
  });

  const view = buildNotesView({ db, meetingId: id });
  assert.equal(view.tldr, 'The party opened the door.');
  assert.equal(view.scenes[0].title, 'The door');
  assert.deepEqual(view.scenes[0].points, ['It was locked', 'Then it was not']);
  assert.deepEqual(view.partyDecisions, ['Went left']);
  assert.deepEqual(view.funnyMoments, ['Vex tried to eat the lock']);
  // The one shaped field, flattened to something readable rather than
  // rendered as [object Object].
  assert.deepEqual(view.followUps, ['Matt: buy rope', 'find the key']);
});

// The model is told to return arrays. It does not always.
test('a string where the schema said array is read, not dropped', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, { tldr: 'x', partyDecisions: 'Went left, then right' });

  assert.deepEqual(buildNotesView({ db, meetingId: id }).partyDecisions, ['Went left, then right']);
});

test('junk inside a list is dropped rather than rendered', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, {
    tldr: 'x',
    npcsIntroduced: ['Real NPC', null, '', { name: 'Wrapped in an object' }, { a: 1, b: 2 }, 42],
  });

  assert.deepEqual(
    buildNotesView({ db, meetingId: id }).npcsIntroduced,
    ['Real NPC', 'Wrapped in an object'],
    'a single-string object is recoverable; a number and a two-key object are not'
  );
});

test('a recap from an older prompt, missing half the fields, still opens', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, { tldr: 'Just a summary, as it used to be.' });

  const view = buildNotesView({ db, meetingId: id });
  assert.equal(view.written, true);
  assert.equal(view.tldr, 'Just a summary, as it used to be.');
  for (const field of ['scenes', 'partyDecisions', 'followUps', 'npcsIntroduced', 'lootAndRewards']) {
    assert.deepEqual(view[field], [], `${field} should be empty, not undefined`);
  }
});

// Written by a model and stored verbatim, so this can genuinely be on disk.
test('a summary that is not valid JSON says so instead of taking the request down', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId);
  db.raw.prepare('UPDATE meetings SET summary_json = ? WHERE id = ?').run('{"tldr": "unterminated', id);

  const view = buildNotesView({ db, meetingId: id });
  assert.equal(view.unreadable, true);
  assert.equal(view.ref, 'Cipher_01', 'and still identifies which session it was');
});

test('a scene with no title but real points is kept', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, { tldr: 'x', scenes: [{ points: ['Something happened'] }, {}, 'nonsense'] });

  const scenes = buildNotesView({ db, meetingId: id }).scenes;
  assert.equal(scenes.length, 1, 'the empty scene and the string are dropped');
  assert.deepEqual(scenes[0].points, ['Something happened']);
});

test('the campaign list flags which sessions have notes to read', async (t) => {
  const { db, campaignId } = await harness(t);
  session(db, campaignId, { tldr: 'written' });
  session(db, campaignId);

  const { buildCampaignView } = await import('../src/web/campaign-view.js');
  const sessions = buildCampaignView({ db, campaignId }).sessions;
  assert.deepEqual(
    sessions.map((s) => s.hasNotes).sort(),
    [false, true],
    'so the Notes button is never offered for a session that would open empty'
  );
});

// --- the corrections the table has made ------------------------------------
//
// The page draws the ordinary fields exactly as it always did and never has to
// know corrections exist — which is also why /recap, the export and the
// Discord post are right without a line of their own. `marks` is the only
// thing here that knows, and it is what the switch draws when it is set to
// correcting.

test('the fields are the corrected reading, and the marks are beside them', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, {
    tldr: 'They went through the front door.',
    scenes: [{ title: 'The queue', points: ['Wren stamped the writ.', 'Nobody read it.'] }],
    partyDecisions: ['Leave the stone in the wall.'],
  });

  db.addRecapNote({
    meetingId: id, part: 'tldr', index: 0,
    quoted: 'They went through the front door.',
    body: 'They went through the side door.', userId: 'saf',
  });
  db.addRecapNote({
    meetingId: id, part: 'scene:0', index: 1, quoted: 'Nobody read it.', body: '', userId: 'rhi',
  });

  const view = buildNotesView({ db, meetingId: id });

  // What a reader gets: the corrected sentence, and no sign of how it got
  // there. One document, one truth.
  assert.equal(view.tldr, 'They went through the side door.');
  assert.deepEqual(view.scenes[0].points, ['Wren stamped the writ.']);
  assert.equal(view.corrections, 2);

  // And what somebody correcting gets: the summariser's own line, kept.
  const tldr = view.marks.find((p) => p.part === 'tldr');
  assert.equal(tldr.lines[0].base, 'They went through the front door.');
  assert.equal(tldr.lines[0].reading, 'They went through the side door.');
  assert.equal(tldr.lines[0].marks[0].userId, 'saf');

  const scene = view.marks.find((p) => p.part === 'scene:0');
  assert.equal(scene.lines[1].gone, true, 'struck out with nothing put back');
  assert.equal(scene.lines[1].base, 'Nobody read it.', 'and the original is still there to put back');
});

test('a write-up nobody has corrected reads as it always did', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, {
    tldr: 'They went through the front door.',
    scenes: [{ title: 'The queue', points: ['Wren stamped the writ.'] }],
  });

  const view = buildNotesView({ db, meetingId: id });
  assert.equal(view.tldr, 'They went through the front door.');
  assert.equal(view.corrections, 0);
  assert.deepEqual(view.orphaned, []);
  assert.deepEqual(view.previous, []);
  // The marks are still there — every line, with nothing on it. The page needs
  // them to know what it may let somebody press.
  assert.ok(view.marks.some((p) => p.part === 'tldr'));
});

test('the page is told where the corrections on an older write-up went', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, { tldr: 'The first attempt.', scenes: [] });
  db.addRecapNote({ meetingId: id, part: 'tldr', index: 0, quoted: 'The first attempt.', body: 'No.', userId: 'saf' });

  db.setSummary(id, { tldr: 'A second attempt.', scenes: [] });

  const view = buildNotesView({ db, meetingId: id });
  assert.equal(view.corrections, 0, 'the new write-up starts clean');
  assert.equal(view.previous.length, 1);
  assert.equal(view.previous[0].notes, 1, 'and the old one kept what was said about it');
});

// A correction is anchored to "the third point of the second scene", so the
// document it is anchored to has to be the document everybody reads. The model
// leaves blanks in its lists and readable() drops them — anchoring against the
// raw blob instead would put a correction beside a different sentence.
test('the lines are numbered as the reader sees them, not as the model wrote them', async (t) => {
  const { db, campaignId } = await harness(t);
  const id = session(db, campaignId, {
    tldr: 'An opening.',
    scenes: [],
    partyDecisions: ['', 'Leave the stone in the wall.', '   ', 'Say nothing yet.'],
  });

  const view = buildNotesView({ db, meetingId: id });
  const part = view.marks.find((p) => p.part === 'partyDecisions');
  assert.deepEqual(part.lines.map((l) => l.base), ['Leave the stone in the wall.', 'Say nothing yet.']);
  assert.deepEqual(part.lines.map((l) => l.index), [0, 1]);
  assert.deepEqual(view.partyDecisions, ['Leave the stone in the wall.', 'Say nothing yet.']);
});
