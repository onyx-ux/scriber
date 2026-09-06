import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

import { openDb } from '../src/store/db.js';
import { buildTranscriptView } from '../src/web/transcript-view.js';
import { transcribeAll, LINE_BREAKS } from '../src/pipeline/transcribe.js';

// Which engine wrote a transcript, and what its line breaks are worth.
//
// This exists because of a fault that had kept a whole rung of the ladder
// switched off. Gemini transcription is accurate about WHO spoke (229 of 229 on
// 396 real clips) and approximate about where one line ends and the next
// begins. That was treated as disqualifying — while the batched whisper path,
// which makes the identical trade for a different reason, shipped as the
// default on the Pi and said nothing about it either. The two positions could
// not both be right. What was actually missing was not accuracy, it was the
// label: nothing recorded how a transcript had been made, so an approximate one
// and an exact one were indistinguishable forever afterwards.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-prov-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  return { db, campaignId };
}

const LINES = [
  { userId: 'dm-1', displayName: 'Kez', startMs: 0, endMs: 2_000, text: 'The queue has not moved.' },
  { userId: '111', displayName: 'Matt', startMs: 9_000, endMs: 11_000, text: 'Does it need a seal?' },
];

const recorded = (db, campaignId, opts) => {
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'voice', channelName: 'Voice Chat',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meetingId, LINES, opts);
  db.endMeeting(meetingId, '2026-08-01T22:00:00Z');
  return meetingId;
};

// --- what each path claims about itself ---------------------------------

// A stub server: one clip in, one line out, no whisper and no socket. What is
// under test is the CLAIM the run returns, not the words.
const clips = [
  { userId: '111', displayName: 'Matt', wavPath: '/tmp/a.wav', startMs: 0, endMs: 1_000 },
];

test('an unbatched whisper run says its line breaks are exact', async () => {
  // One clip per encode window is one Discord speaking turn per line, which is
  // as exact as the boundaries can be — they are not inferred at all, they are
  // the ones Discord's own capture wrote.
  const cfg = { transcribeBatching: false, whisperServerUrl: 'http://gpu:8089', whisperDropFiller: false };
  const run = await transcribeAll([], cfg, { serverReachable: true });
  assert.equal(run.engine, 'whisper');
  assert.equal(run.lineBreaks, 'exact');
});

test('a batched whisper run admits its line breaks are approximate', async () => {
  // whisper.cpp encodes a fixed 30-second window however short the clip is, so
  // the Pi's CPU path merges one speaker's clips to fill it — 5x faster, and a
  // word can land on the neighbouring clip. This has been the default on the Pi
  // for months and had never once said so.
  const cfg = { transcribeBatching: true, whisperServerUrl: null, whisperDropFiller: false };
  const run = await transcribeAll([], cfg, { serverReachable: false });
  assert.equal(run.engine, 'whisper');
  assert.equal(run.lineBreaks, 'approximate');
});

test('a Gemini run makes the same admission, and it is the same admission', async () => {
  const cfg = {
    geminiTranscribe: true, geminiApiKey: 'k', geminiTranscribeModel: 'm',
    transcribeVia: 'gemini', whisperDropFiller: false,
  };
  // No socket: transcribeSpeakerStreams is reached through the injectable
  // `connect`, and with no clips it never opens one.
  const run = await transcribeAll([], cfg, { serverReachable: false, connect: () => {
    throw new Error('should not connect for an empty run');
  } });
  assert.equal(run.engine, 'gemini');
  assert.equal(run.lineBreaks, 'approximate');

  // And the point of the whole exercise: the two paths land in the SAME band,
  // so whatever is said about one is said about the other. If this ever
  // diverges, one of them is being held to a standard the other is not.
  assert.ok(LINE_BREAKS.approximate.engineOf.whisper, 'the batched path lost its wording');
  assert.ok(LINE_BREAKS.approximate.engineOf.gemini, 'the Gemini path lost its wording');
});

// --- and what the database keeps -----------------------------------------

test('the engine is written in the same transaction as the lines it describes', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, { engine: 'gemini', lineBreaks: 'approximate' });

  const meeting = db.getMeeting(meetingId);
  assert.equal(meeting.transcribed_by, 'gemini');
  assert.equal(meeting.line_breaks, 'approximate');
});

test('a session recorded before this existed stays blank rather than guessing', async (t) => {
  const { db, campaignId } = await harness(t);
  // Exactly what the migration leaves behind: rows that predate the column.
  const meetingId = recorded(db, campaignId, {});

  assert.equal(db.getMeeting(meetingId).transcribed_by, null);
  assert.equal(
    buildTranscriptView({ db, meetingId }).provenance,
    null,
    'an unrecorded session is claiming to know how it was made'
  );
});

test('re-transcribing replaces the claim, and a caller that says nothing does not erase it', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, { engine: 'gemini', lineBreaks: 'approximate' });

  // The GPU came back and the evening was run again properly.
  db.finalizeTranscription(meetingId, LINES, { engine: 'whisper', lineBreaks: 'exact' });
  assert.equal(db.getMeeting(meetingId).transcribed_by, 'whisper');
  assert.equal(db.getMeeting(meetingId).line_breaks, 'exact');

  // And a path that has nothing to say leaves the record alone rather than
  // blanking it — COALESCE, not a plain assignment. A caller added later that
  // simply forgets to pass this must not silently unlabel a transcript.
  db.finalizeTranscription(meetingId, LINES, {});
  assert.equal(db.getMeeting(meetingId).transcribed_by, 'whisper');
  assert.equal(db.getMeeting(meetingId).line_breaks, 'exact');
});

// --- and what a reader is told -------------------------------------------

test('an exact transcript names its engine and says nothing else', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, { engine: 'whisper', lineBreaks: 'exact' });

  const { provenance } = buildTranscriptView({ db, meetingId });
  assert.equal(provenance.lineBreaks, 'exact');
  assert.match(provenance.how, /one clip at a time/);
  assert.equal(
    provenance.say,
    LINE_BREAKS.exact.say,
  );
});

test('an approximate transcript says which part of it to trust', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, { engine: 'gemini', lineBreaks: 'approximate' });

  const { provenance } = buildTranscriptView({ db, meetingId });
  assert.match(provenance.how, /Gemini/);

  // The sentence has to keep both halves. Half of it — "the times can be a few
  // seconds out" — reads as a broken transcript on its own; the other half is
  // what makes it usable, because who spoke and in what order is exactly right
  // and that is what a summariser and a reader are both actually using.
  assert.match(provenance.say, /Who spoke and in what order are exact/);
  assert.match(provenance.say, /approximate/);
});

test('an imported transcript does not claim this bot made it', async (t) => {
  const { db, campaignId } = await harness(t);
  const meetingId = recorded(db, campaignId, { engine: 'imported' });

  const { provenance } = buildTranscriptView({ db, meetingId });
  assert.match(provenance.how, /imported/);
  assert.match(provenance.say, /whatever the tool that made it decided/);
  assert.equal(provenance.lineBreaks, null);
});

// --- and that the page actually draws it ---------------------------------

test('the transcript page draws the provenance, and the brass is on the grade', async () => {
  const page = await readFile(fileURLToPath(new URL('../../dashboard/html/index.html', import.meta.url)), 'utf8');

  // Called from the facts rail, under the other facts about this session.
  assert.match(page, /\$\{howItWasMade\(\)\}/, 'the rail stopped drawing it');
  assert.match(page, /function howItWasMade\(\)/);

  // The mark is on the GRADE, not on whether there is a sentence. Both readings
  // carry a sentence — an exact transcript says so rather than staying quiet,
  // because a page that only spoke up about approximate lines would make
  // silence mean "exact", and silence here already means "recorded before any
  // of this was written down".
  assert.match(
    page,
    /class="made\$\{p\.lineBreaks === 'approximate' \? ' rough' : ''\}"/,
    'the brass is keyed off the wrong thing again'
  );

  // And it is drawn in the colour this page uses for held and paused, not the
  // one it uses for broken.
  assert.match(page, /\.made\.rough \.mono \{ color: var\(--brass-lit\)/);
});
