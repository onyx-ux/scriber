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
