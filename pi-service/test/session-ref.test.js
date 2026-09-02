import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { sessionRef, parseSessionRef, resolveSessionRef, refSlug } from '../src/campaign/session-ref.js';

async function tmpDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-ref-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

function session(db, guildId, name) {
  db.setCampaignName(guildId, name);
  const id = db.createMeeting({
    guildId, channelId: 'C', channelName: name, startedAt: new Date().toISOString(), audioDir: '/t',
  });
  db.finalizeTranscription(id, [{ userId: 'u', displayName: 'p', text: 'hi', startMs: 0, endMs: 1 }], {
    requireApproval: false,
  });
  db.setMeetingStatus(id, 'done');
  return id;
}

// --- rendering ---

test('a reference names its campaign and pads the number', () => {
  assert.equal(sessionRef('Cipher', 2), 'Cipher_02');
  assert.equal(sessionRef('Cipher', 12), 'Cipher_12');
});

test('spaces come out, because a reference gets typed', () => {
  assert.equal(refSlug('Curse of Strahd'), 'CurseofStrahd');
  assert.equal(sessionRef('Curse of Strahd', 1), 'CurseofStrahd_01');
});

test('an unnamed or unnumbered session has no reference', () => {
  assert.equal(sessionRef('', 1), null);
  assert.equal(sessionRef('Cipher', null), null);
});

// --- parsing ---

test('parsing is forgiving about case and a missing leading zero', () => {
  assert.deepEqual(parseSessionRef('Cipher_02'), { slug: 'cipher', sessionNumber: 2 });
  assert.deepEqual(parseSessionRef('cipher_2'), { slug: 'cipher', sessionNumber: 2 });
  assert.deepEqual(parseSessionRef('Cipher-02'), { slug: 'cipher', sessionNumber: 2 });
  assert.equal(parseSessionRef('nonsense'), null);
  assert.equal(parseSessionRef(''), null);
});

// --- resolving, which is where the permission check bites ---

test('a reference resolves within a campaign you are part of', async (t) => {
  const db = await tmpDb(t);
  session(db, 'G', 'Cipher');
  const reachable = db.listCampaigns();

  const { meeting, error } = resolveSessionRef('Cipher_01', reachable, db);
  assert.equal(error, undefined);
  assert.equal(meeting.session_number, 1);
  assert.equal(meeting.guild_id, 'G');
});

// The bug this replaces: /export 16 from any server returned another table's
// full transcript, because a bare integer names no campaign to check against.
test("a reference cannot reach a campaign you're not part of", async (t) => {
  const db = await tmpDb(t);
  session(db, 'MINE', 'Cipher');
  session(db, 'THEIRS', 'Private Game');

  const mine = db.listCampaigns().filter((c) => c.guild_id === 'MINE');
  assert.match(resolveSessionRef('PrivateGame_01', mine, db).error, /isn't a session in a campaign you're part of/);
});

test('a bare meeting id is still accepted, but only within reach', async (t) => {
  const db = await tmpDb(t);
  const ours = session(db, 'MINE', 'Cipher');
  const theirs = session(db, 'THEIRS', 'Private Game');
  const mine = db.listCampaigns().filter((c) => c.guild_id === 'MINE');

  assert.equal(resolveSessionRef(String(ours), mine, db).meeting.id, ours, 'old ids in scrollback still work');
  assert.match(resolveSessionRef(String(theirs), mine, db).error, /campaign you're not part of/);
  assert.match(resolveSessionRef('#' + theirs, mine, db).error, /campaign you're not part of/);
});

test('a session number the campaign does not have is refused by name', async (t) => {
  const db = await tmpDb(t);
  session(db, 'G', 'Cipher');
  assert.match(resolveSessionRef('Cipher_99', db.listCampaigns(), db).error, /Cipher has no session 99/);
});

test('something that is not a reference at all says what one looks like', async (t) => {
  const db = await tmpDb(t);
  assert.match(resolveSessionRef('what', [], db).error, /Cipher_02/);
});

test('two campaigns numbering from one do not collide', async (t) => {
  const db = await tmpDb(t);
  session(db, 'A', 'Cipher');
  session(db, 'B', 'Strahd');
  const all = db.listCampaigns();

  assert.equal(resolveSessionRef('Cipher_01', all, db).meeting.guild_id, 'A');
  assert.equal(resolveSessionRef('Strahd_01', all, db).meeting.guild_id, 'B');
});
