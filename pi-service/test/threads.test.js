import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { openThreadTexts, recordSessionThreads } from '../src/campaign/threads.js';
import { runAction } from '../src/web/actions.js';
import { buildCampaignView } from '../src/web/campaign-view.js';
import { buildSummaryUserMessage, DND_SUMMARY_PROMPT, DND_REDUCE_PROMPT, DND_CHUNK_PROMPT } from '../src/prompts/dnd-summary-prompt.js';
import { summarizeTranscript } from '../src/pipeline/summarize-client.js';

// "Still unresolved" only ever grew. Every session's write-up listed its open
// threads, nothing ever closed one, and a campaign's list of mysteries was the
// sum of every one it had ever had. Threads now live in their own table with a
// status; the summariser is shown the open ones and may PROPOSE that a session
// settled one, and the person running the table decides.

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-threads-'));
  const path = join(dir, 'db.sqlite');
  const db = openDb(path);
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const meeting = () =>
    db.createMeeting({ guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'Voice', startedAt: new Date().toISOString(), audioDir: '/tmp' });
  const act = (name, body) => runAction({ pathname: `/actions/${name}`, body: { campaignId, ...body }, db, cfg: {} }).payload;
  return { db, path, campaignId, meeting, act };
}

test('a session opens its threads, and the same thread twice is one thread', async (t) => {
  const { db, campaignId, meeting } = await world(t);
  const one = meeting();
  recordSessionThreads(db, { campaignId, meetingId: one, notes: { unresolvedThreads: ['Who else has a key?', 'Why did the lamp relight?'] } });
  const two = meeting();
  recordSessionThreads(db, { campaignId, meetingId: two, notes: { unresolvedThreads: ['who else has a key'] } });

  const threads = db.listThreads(campaignId);
  assert.equal(threads.length, 2);
  assert.ok(threads.every((th) => th.status === 'open'));
  assert.equal(threads.find((th) => /key/.test(th.text)).openedMeetingId, one, 'first seen wins');
});

test('a thread the summariser says was settled is proposed, not closed', async (t) => {
  const { db, campaignId, meeting } = await world(t);
  const one = meeting();
  recordSessionThreads(db, { campaignId, meetingId: one, notes: { unresolvedThreads: ['Who else has a key?'] } });
  const two = meeting();
  recordSessionThreads(db, {
    campaignId,
    meetingId: two,
    notes: {
      unresolvedThreads: [],
      resolvedThreads: [
        { thread: 'Who else has a key?', evidence: 'Wren admitted she kept the second key.' },
        { thread: 'A thread nobody ever opened', evidence: 'ignored' },
      ],
    },
  });

  const [thread] = db.listThreads(campaignId);
  assert.equal(thread.status, 'open', 'the model does not get to close anything');
  assert.equal(thread.proposal.meetingId, two);
  assert.match(thread.proposal.evidence, /second key/);
  assert.equal(db.listThreads(campaignId).length, 1, 'an unknown thread is not invented');
});

test('the manager accepts a proposal, and can reopen it', async (t) => {
  const { db, campaignId, meeting, act } = await world(t);
  const one = meeting();
  recordSessionThreads(db, { campaignId, meetingId: one, notes: { unresolvedThreads: ['Who else has a key?'] } });
  const two = meeting();
  recordSessionThreads(db, { campaignId, meetingId: two, notes: { resolvedThreads: [{ thread: 'Who else has a key?', evidence: 'Wren did.' }] } });
  const [thread] = db.listThreads(campaignId);

  const res = act('threads/set', { threadId: thread.id, status: 'resolved' });
  assert.equal(res.ok, true);
  let now = db.listThreads(campaignId)[0];
  assert.equal(now.status, 'resolved');
  assert.equal(now.closedMeetingId, two, 'closed in the session that settled it');
  assert.equal(now.proposal, null);

  act('threads/set', { threadId: thread.id, status: 'open' });
  now = db.listThreads(campaignId)[0];
  assert.equal(now.status, 'open');
  assert.equal(now.closedMeetingId, null);
});

test('a proposal can be turned down without closing anything', async (t) => {
  const { db, campaignId, meeting, act } = await world(t);
  const one = meeting();
  recordSessionThreads(db, { campaignId, meetingId: one, notes: { unresolvedThreads: ['Who else has a key?'] } });
  recordSessionThreads(db, { campaignId, meetingId: meeting(), notes: { resolvedThreads: [{ thread: 'Who else has a key?', evidence: 'x' }] } });
  const [thread] = db.listThreads(campaignId);

  act('threads/keep-open', { threadId: thread.id });
  const now = db.listThreads(campaignId)[0];
  assert.equal(now.status, 'open');
  assert.equal(now.proposal, null);
});

test('a thread from another table cannot be touched through this one', async (t) => {
  const { db, meeting, act } = await world(t);
  const other = db.createCampaign('guild-1', 'Strahd', 'dm-2');
  recordSessionThreads(db, { campaignId: other, meetingId: meeting(), notes: { unresolvedThreads: ['The mists'] } });
  const [theirs] = db.listThreads(other);

  const res = act('threads/set', { threadId: theirs.id, status: 'dropped' });
  assert.equal(res.ok, false);
  assert.equal(db.listThreads(other)[0].status, 'open');
});

// Session 32 on 2026-09-27 was written up three times in an evening and ended
// with nine open threads, three of them the same thread worded twice: "Finding
// Gertrude" and "Locating Gertrude", both still open, both from one session.
test('writing a session up again replaces its threads instead of adding to them', async (t) => {
  const { db, campaignId, meeting } = await world(t);
  const one = meeting();
  recordSessionThreads(db, { campaignId, meetingId: one, notes: { unresolvedThreads: ['Who else has a key?'] } });
  const two = meeting();
  recordSessionThreads(db, {
    campaignId,
    meetingId: two,
    notes: {
      unresolvedThreads: ['Finding Gertrude in the castle.', 'Burying Ismark’s father.'],
      resolvedThreads: [{ thread: 'Who else has a key?', evidence: 'Wren.' }],
    },
  });

  const again = recordSessionThreads(db, {
    campaignId,
    meetingId: two,
    notes: { unresolvedThreads: ['Locating Gertrude, taken to the castle.', 'Burying Ismark’s father.'] },
  });

  assert.equal(again.retracted, 1, 'the old wording of the Gertrude thread goes');
  const texts = db.listThreads(campaignId).map((th) => th.text);
  assert.deepEqual(texts.sort(), ['Burying Ismark’s father.', 'Locating Gertrude, taken to the castle.', 'Who else has a key?'].sort());
  assert.equal(db.listThreads(campaignId).find((th) => /key/.test(th.text)).proposal, null, 'the old write-up’s proposal goes too');
});

test('a re-summarise leaves alone what the table decided and what another session raised', async (t) => {
  const { db, campaignId, meeting, act } = await world(t);
  const two = meeting();
  recordSessionThreads(db, {
    campaignId,
    meetingId: two,
    notes: { unresolvedThreads: ['The mists.', 'The raven.', 'The locked tower.'] },
  });
  const three = meeting();
  db.setSummary(three, { tldr: 'x', unresolvedThreads: ['The locked tower.'] });
  recordSessionThreads(db, { campaignId, meetingId: three, notes: { unresolvedThreads: ['The locked tower.'] } });
  const raven = db.listThreads(campaignId).find((th) => th.text === 'The raven.');
  act('threads/set', { threadId: raven.id, status: 'dropped' });

  recordSessionThreads(db, { campaignId, meetingId: two, notes: { unresolvedThreads: [] } });

  const left = Object.fromEntries(db.listThreads(campaignId).map((th) => [th.text, th.status]));
  assert.deepEqual(left, { 'The locked tower.': 'open', 'The raven.': 'dropped' });
});

test('a re-summarise is not shown its own last write-up as earlier threads', async (t) => {
  const { db, campaignId, meeting } = await world(t);
  const one = meeting();
  recordSessionThreads(db, { campaignId, meetingId: one, notes: { unresolvedThreads: ['Who else has a key?'] } });
  const two = meeting();
  recordSessionThreads(db, { campaignId, meetingId: two, notes: { unresolvedThreads: ['Finding Gertrude.'] } });

  assert.deepEqual(openThreadTexts(db, campaignId, { meetingId: two }), ['Who else has a key?']);
  assert.equal(openThreadTexts(db, campaignId).length, 2, 'everyone else still sees both');
});

test('threads already in old write-ups are opened when the table first appears', async (t) => {
  const { db, path, campaignId, meeting } = await world(t);
  const m = meeting();
  db.setSummary(m, { tldr: 'x', unresolvedThreads: ['Why did the lamp relight?'] });
  db.setMeetingStatus(m, 'done');
  db.raw.exec('DROP TABLE campaign_threads');
  db.close();

  const again = openDb(path);
  try {
    assert.deepEqual(again.listThreads(campaignId).map((th) => th.text), ['Why did the lamp relight?']);
  } finally {
    again.close();
  }
});

test('the campaign view carries the threads with their proposals', async (t) => {
  const { db, campaignId, meeting } = await world(t);
  recordSessionThreads(db, { campaignId, meetingId: meeting(), notes: { unresolvedThreads: ['Who else has a key?'] } });
  const view = buildCampaignView({ db, campaignId });
  assert.equal(view.threads.length, 1);
  assert.equal(view.threads[0].status, 'open');
  assert.equal(view.threads[0].openedSession, 1);
});

// --- the summariser's side ---------------------------------------------------

test('the summariser is shown the open threads and asked to say which were settled', () => {
  const msg = buildSummaryUserMessage('A: hi', { attendees: ['A'], openThreads: ['Who else has a key?'] });
  assert.match(msg, /OPEN THREADS FROM EARLIER SESSIONS/);
  assert.match(msg, /- Who else has a key\?/);
  for (const prompt of [DND_SUMMARY_PROMPT, DND_REDUCE_PROMPT, DND_CHUNK_PROMPT]) {
    assert.match(prompt, /"resolvedThreads"/);
  }
});

test('a resolvedThreads answer survives normalisation', async () => {
  const notes = await summarizeTranscript('A: hello there, we found the key', { attendees: ['A'] }, { summaryProvider: 'gemini' }, {
    callModel: async () =>
      JSON.stringify({ tldr: 't', resolvedThreads: [{ thread: 'Who else has a key?', evidence: 'Wren.' }, { thread: 7 }] }),
  });
  assert.deepEqual(notes.resolvedThreads, [{ thread: 'Who else has a key?', evidence: 'Wren.' }]);
});
