import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { expandTerms, closeSpellings, similarity } from '../src/campaign/lookup.js';
import { gatherContext } from '../src/pipeline/ask-client.js';
import { buildAskUserMessage } from '../src/prompts/ask-prompt.js';

// Search used to be a substring LIKE per keyword, and /ask added only each
// session's one-line summary. A name whisper spelled three ways was found
// under one of them, and a question about "Yusdrayl" missed every session where
// the transcript said "Use Drail".

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-search-'));
  const path = join(dir, 'db.sqlite');
  const db = openDb(path);
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = (lines, summary = null) => {
    const meetingId = db.createMeeting({
      guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'Voice',
      startedAt: `2026-09-0${lines.length}T19:00:00Z`, audioDir: '/tmp',
    });
    db.finalizeTranscription(
      meetingId,
      lines.map((text, i) => ({ userId: 'u', displayName: 'Bex', startMs: i * 61_000, endMs: i * 61_000 + 1, text, rawText: text }))
    );
    if (summary) {
      db.setSummary(meetingId, summary);
      db.setMeetingStatus(meetingId, 'done');
    }
    return meetingId;
  };
  return { db, path, dir, campaignId, session };
}

// --- the index --------------------------------------------------------------

test('ranked search finds any of several spellings, best match first', async (t) => {
  const { db, campaignId, session } = await world(t);
  session(['Yusdrail opens the door', 'the kobold waits', 'Use Drail and Yusdrail argue']);

  const rows = db.searchUtterancesRanked(campaignId, ['Yusdrail', 'Use Drail'], 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, 'Use Drail and Yusdrail argue', 'the line matching both spellings ranks first');
});

test('the index follows a correction, a re-transcription and a deletion', async (t) => {
  const { db, campaignId, session } = await world(t);
  const meetingId = session(['Vecks opens it']);
  db.addCorrection(campaignId, 'Vecks', 'Vex');
  db.reapplyCorrections(campaignId, (s) => s.replace(/Vecks/g, 'Vex'));

  assert.equal(db.searchUtterancesRanked(campaignId, ['Vex'], 5).length, 1);
  assert.equal(db.searchUtterancesRanked(campaignId, ['Vecks'], 5).length, 0);

  db.finalizeTranscription(meetingId, [{ userId: 'u', displayName: 'A', startMs: 0, endMs: 1, text: 'fresh words' }]);
  assert.equal(db.searchUtterancesRanked(campaignId, ['Vex'], 5).length, 0);
  assert.equal(db.searchUtterancesRanked(campaignId, ['fresh'], 5).length, 1);
});

test('a short term still works, through the slower path', async (t) => {
  const { db, campaignId, session } = await world(t);
  session(['we go to Oz', 'nothing']);
  assert.equal(db.searchUtterancesRanked(campaignId, ['Oz'], 5).length, 1);
});

test('another table in the same Discord is never searched', async (t) => {
  const { db, session } = await world(t);
  session(['the mists of Barovia']);
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  assert.equal(db.searchUtterancesRanked(other, ['mists'], 5).length, 0);
});

test('a database from before the index is indexed when it is opened', async (t) => {
  const { db, path, campaignId, session } = await world(t);
  session(['Marrowgate lies east']);
  db.raw.exec('DROP TRIGGER IF EXISTS utterances_fts_ai; DROP TRIGGER IF EXISTS utterances_fts_ad; DROP TRIGGER IF EXISTS utterances_fts_au; DROP TABLE utterances_fts;');
  db.close();

  const again = openDb(path);
  try {
    assert.equal(again.searchUtterancesRanked(campaignId, ['Marrowgate'], 5).length, 1);
  } finally {
    again.close();
  }
});

// --- names ------------------------------------------------------------------

const names = [
  { name: 'Yusdrayl', aliases: ['Yusdrail', 'Use Drail'] },
  { name: 'Meepo', aliases: ['Mepo'] },
];

test('a name in the question brings its other spellings with it', () => {
  const { terms, matched } = expandTerms('Who is Yusdrayl?', names);
  assert.deepEqual(new Set(terms), new Set(['Yusdrayl', 'Yusdrail', 'Use Drail']));
  assert.deepEqual(matched.map((m) => m.name), ['Yusdrayl']);
});

test('asking by a misheard spelling finds the name too', () => {
  const { terms } = expandTerms('what did use drail say', names);
  assert.ok(terms.includes('Yusdrayl'));
});

test('a question naming nobody expands to nothing', () => {
  assert.deepEqual(expandTerms('what happened at the gate', names).matched, []);
});

test('similar spellings score high and unrelated words low', () => {
  assert.ok(similarity('yusdrayl', 'yusdrail') > 0.5);
  assert.ok(similarity('yusdrayl', 'kobold') < 0.2);
});

test('close spellings are offered when nothing matches exactly', async (t) => {
  const { db, campaignId, session } = await world(t);
  session(['Yusdrail opens the door', 'the kobold waits']);
  const close = closeSpellings(db, campaignId, 'Yusdrayl');
  assert.deepEqual(close.words, ['Yusdrail']);
  assert.equal(close.rows.length, 1);
});

// --- what /ask is given -----------------------------------------------------

test('ask context carries whole write-ups by session number, not meeting id', async (t) => {
  const { db, campaignId, session } = await world(t);
  // Another table's meeting first, so this campaign's meeting ids and session
  // numbers differ: session 2 here is meeting 3.
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  db.createMeeting({ guildId: 'guild-1', campaignId: other, channelId: 'v', channelName: 'x', startedAt: '2026-08-01T00:00:00Z', audioDir: '/tmp' });
  db.createMeeting({ guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'x', startedAt: '2026-08-01T00:00:00Z', audioDir: '/tmp' });
  session(['Use Drail gives us the key', 'we leave'], {
    tldr: 'The party met Yusdrayl.',
    scenes: [{ title: 'The throne room', points: ['Yusdrayl handed over a brass key.'] }],
    unresolvedThreads: ['Who else has a key?'],
  });

  const ctx = gatherContext(db, campaignId, 'what did Yusdrayl give us?', {}, { names });
  const msg = buildAskUserMessage('what did Yusdrayl give us?', ctx.summaries, ctx.excerpts, ctx.names);

  assert.match(msg, /Session 2/, 'the session number the table uses');
  assert.doesNotMatch(msg, /Session 3|#3/, 'never the meeting id');
  assert.match(msg, /brass key/, 'scenes, not just the one-line summary');
  assert.match(msg, /Who else has a key\?/);
  assert.match(msg, /Use Drail gives us the key/, 'found through the alias');
  assert.match(msg, /0:00:00/);
  assert.match(msg, /Yusdrayl .*Use Drail/, 'the model is told which spellings are one name');
});
