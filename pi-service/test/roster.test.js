import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { resolveSpeakerName, rosterNames } from '../src/campaign/character-names.js';
import { buildSummaryUserMessage, buildChunkUserMessage, buildReduceUserMessage } from '../src/prompts/dnd-summary-prompt.js';

async function tmpDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-roster-'));
  const db = openDb(join(dir, 'db.sqlite'));
  // Close the native handle before removing the directory — on Windows,
  // deleting a WAL file better-sqlite3 still has open fails with EBUSY.
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// The campaign in server G, which for these tests is the only one there.
const only = (db, guildId = 'G') => db.defaultCampaignId(guildId);

function record(db, { guildId = 'G', userId, displayName, lines = 1 }) {
  const id = db.createMeeting({
    guildId,
    channelId: 'C',
    channelName: 'Session',
    startedAt: new Date().toISOString(),
    audioDir: '/tmp/none',
  });
  db.finalizeTranscription(
    id,
    Array.from({ length: lines }, (_, i) => ({
      userId,
      displayName,
      text: `line ${i}`,
      startMs: i * 10,
      endMs: i * 10 + 5,
    })),
    { requireApproval: false }
  );
  return id;
}

// --- the roster the DM picks from ---

test('the roster is everyone recorded, whether or not they have a character', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'Brett', lines: 3 });
  record(db, { userId: 'u2', displayName: 'Aurion', lines: 1 });
  db.setCharacterName(only(db), 'u1', 'BenTen');

  const roster = db.listRoster(only(db));
  assert.deepEqual(
    roster.map((r) => [r.displayName, r.characterName, r.lines]),
    [
      ['Brett', 'BenTen', 3],
      ['Aurion', null, 1],
    ],
    'most talkative first, unnamed players included'
  );
});

// The characters table alone could never drive this: it has rows only for
// players already named, and naming the others is the entire point.
test('a player with no character still appears, so they can be given one', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'Saf' });

  assert.deepEqual(db.listCharacters(only(db)), []);
  assert.equal(db.listRoster(only(db)).length, 1);
  assert.equal(db.listRoster(only(db))[0].characterName, null);
});

test('a renamed player is listed under the name they use now', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'OldNick' });
  record(db, { userId: 'u1', displayName: 'NewNick' });

  const [entry] = db.listRoster(only(db));
  assert.equal(entry.displayName, 'NewNick');
  assert.equal(entry.lines, 2, 'and their whole history still counts');
});

test('one table cannot see another table', async (t) => {
  const db = await tmpDb(t);
  record(db, { guildId: 'G', userId: 'u1', displayName: 'Brett' });
  record(db, { guildId: 'H', userId: 'u2', displayName: 'Someone Else' });

  assert.deepEqual(db.listRoster(only(db)).map((r) => r.displayName), ['Brett']);
});

test('forgetting a character leaves the player on the roster', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'Brett' });
  db.setCharacterName(only(db), 'u1', 'BenTen');

  assert.equal(db.forgetCharacterName(only(db), 'u1'), 1);
  assert.equal(db.forgetCharacterName(only(db), 'u1'), 0, 'a second clear is a no-op, not an error');
  assert.equal(db.listRoster(only(db))[0].characterName, null);
  assert.equal(resolveSpeakerName(db, only(db), 'u1', 'Brett'), 'Brett');
});

// --- what the summariser is told ---

// The reported bug: a player whose character is not their Discord name was
// written up as an NPC the party met.
test('rosterNames carries BOTH the Discord name and the character', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'Brett' });
  db.setCharacterName(only(db), 'u1', 'BenTen');

  const names = rosterNames(db, only(db));
  assert.ok(names.includes('Brett'), JSON.stringify(names));
  assert.ok(names.includes('BenTen'), JSON.stringify(names));
});

// Speaker labels are resolved when the audio is captured, so sessions
// recorded before the mapping existed are labelled with the Discord name and
// later ones with the character. Both have to be covered.
test('rosterNames covers a player named only after they were recorded', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'Brett' }); // captured before
  db.setCharacterName(only(db), 'u1', 'BenTen');
  record(db, { userId: 'u1', displayName: 'BenTen' }); // captured after

  const names = rosterNames(db, only(db));
  assert.ok(names.includes('Brett'));
  assert.ok(names.includes('BenTen'));
});

test('rosterNames includes a character set before that player ever spoke', async (t) => {
  const db = await tmpDb(t);
  record(db, { userId: 'u1', displayName: 'Brett' });
  db.setCharacterName(only(db), 'u2', 'Newcomer');

  assert.ok(rosterNames(db, only(db)).includes('Newcomer'));
});

test('an empty roster is an empty list, not a crash', async (t) => {
  const db = await tmpDb(t);
  assert.deepEqual(rosterNames(db, only(db)), []);
});

// --- the prompt ---

const meta = {
  channelName: 'Session',
  date: '2026-08-10',
  attendees: ['Brett', 'Aurion'],
  playerCharacters: ['Brett', 'BenTen', 'Aurion'],
};

test('every prompt variant names the party and says they are not NPCs', () => {
  for (const [label, message] of [
    ['single', buildSummaryUserMessage('transcript', meta)],
    ['map', buildChunkUserMessage('slice', meta, 1, 3)],
    ['reduce', buildReduceUserMessage([{ narrative: 'x' }], meta)],
  ]) {
    assert.match(message, /PLAYER CHARACTERS/, `${label} names the party`);
    assert.match(message, /never list any of them as an NPC/, `${label} says why`);
    assert.match(message, /BenTen/, `${label} carries the character name`);
    assert.match(message, /Attendees: Brett, Aurion/, `${label} keeps the attendee line`);
  }
});

test('the line is omitted entirely when no roster is known', () => {
  const message = buildSummaryUserMessage('transcript', { ...meta, playerCharacters: [] });
  assert.doesNotMatch(message, /PLAYER CHARACTERS/);
  assert.match(message, /Attendees: Brett, Aurion/);
});

test('the slice number survives the shared header', () => {
  assert.match(buildChunkUserMessage('slice', meta, 2, 7), /Slice 2 of 7\./);
});
