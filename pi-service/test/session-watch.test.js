import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { reviewSession, watchConnection, runSessionWatch } from '../src/voice/session-watch.js';

// Two failures a recording could have that nobody saw, both from 26 Sep 2026
// and before: the bot dropped out of voice and the session carried on showing
// "recording" with nothing arriving; and everybody left without /leave and the
// session stayed open indefinitely, holding a voice slot.

const MIN = 60_000;
const cfg = { voiceEmptyCloseMinutes: 10, voiceSilenceAlertMinutes: 15 };
const session = (over = {}) => ({ meetingId: 7, startedAtMs: 0, lastAudioAt: null, ...over });

// --- the empty channel ------------------------------------------------------

test('an empty channel starts a clock rather than ending anything at once', () => {
  const s = session();
  assert.equal(reviewSession(s, { humans: 0, recordable: 0 }, 5 * MIN, cfg), null);
  assert.equal(s.emptySince, 5 * MIN);
});

test('ten minutes empty ends the session', () => {
  const s = session({ emptySince: 5 * MIN });
  assert.deepEqual(reviewSession(s, { humans: 0, recordable: 0 }, 15 * MIN, cfg), { kind: 'close', reason: 'empty' });
});

// A comfort break is people leaving and coming back. Coming back has to reset
// the clock, or a table that steps away twice for six minutes is cut off.
test('somebody coming back resets the clock', () => {
  const s = session({ emptySince: 5 * MIN });
  reviewSession(s, { humans: 2, recordable: 2 }, 9 * MIN, cfg);
  assert.equal(s.emptySince, null);
  assert.equal(reviewSession(s, { humans: 0, recordable: 0 }, 12 * MIN, cfg), null);
});

test('a channel that no longer exists counts as empty', () => {
  const s = session({ emptySince: 0 });
  assert.equal(reviewSession(s, null, 11 * MIN, cfg).kind, 'close');
});

test('0 turns the empty-channel close off', () => {
  const s = session({ emptySince: 0 });
  assert.equal(reviewSession(s, { humans: 0, recordable: 0 }, 600 * MIN, { ...cfg, voiceEmptyCloseMinutes: 0 }), null);
});

// --- the silent session -----------------------------------------------------

test('people who agreed to be recorded, and no audio for fifteen minutes, is an alert', () => {
  const s = session({ lastAudioAt: 10 * MIN });
  assert.equal(reviewSession(s, { humans: 4, recordable: 4 }, 24 * MIN, cfg), null);
  assert.deepEqual(reviewSession(s, { humans: 4, recordable: 4 }, 25 * MIN, cfg), { kind: 'silent', minutes: 15 });
});

test('the alert is sent once, not every half minute', () => {
  const s = session({ lastAudioAt: 0 });
  assert.equal(reviewSession(s, { humans: 4, recordable: 4 }, 16 * MIN, cfg).kind, 'silent');
  assert.equal(reviewSession(s, { humans: 4, recordable: 4 }, 17 * MIN, cfg), null);
});

test('audio arriving again re-arms it', () => {
  const s = session({ lastAudioAt: 0 });
  reviewSession(s, { humans: 4, recordable: 4 }, 16 * MIN, cfg);
  s.lastAudioAt = 20 * MIN;
  assert.equal(reviewSession(s, { humans: 4, recordable: 4 }, 30 * MIN, cfg), null);
  assert.equal(reviewSession(s, { humans: 4, recordable: 4 }, 36 * MIN, cfg).kind, 'silent');
});

// Silence from people who declined is the consent check working, not a fault.
test('nobody recordable in the channel is not an alert', () => {
  const s = session({ lastAudioAt: 0 });
  assert.equal(reviewSession(s, { humans: 3, recordable: 0 }, 60 * MIN, cfg), null);
});

test('a session that never heard anything counts from when it started', () => {
  const s = session({ startedAtMs: 10 * MIN, lastAudioAt: null });
  assert.equal(reviewSession(s, { humans: 2, recordable: 2 }, 20 * MIN, cfg), null);
  assert.equal(reviewSession(s, { humans: 2, recordable: 2 }, 25 * MIN, cfg).kind, 'silent');
});

// --- the connection itself --------------------------------------------------

// A fake @discordjs/voice connection: an emitter with a status, plus entersState
// and rejoin that the test drives.
function fakeConnection() {
  const c = new EventEmitter();
  c.state = { status: 'ready' };
  c.rejoins = 0;
  c.rejoin = () => {
    c.rejoins += 1;
    return true;
  };
  return c;
}

const fastTimings = { recoverMs: 20, rejoinMs: 20, rejoinDelaysMs: [1, 1] };

test('a disconnect the library recovers from on its own is left alone', async () => {
  const c = fakeConnection();
  const events = [];
  const entersState = async (conn, status) => {
    if (status === 'signalling') return conn;
    throw new Error('timeout');
  };
  watchConnection(c, { entersState, onLost: (r) => events.push(['lost', r]), onRejoined: () => events.push(['back']), timings: fastTimings });

  c.emit('disconnected', { status: 'ready' }, { status: 'disconnected', reason: 0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(events, []);
  assert.equal(c.rejoins, 0);
});

test('a dropped connection is rejoined', async () => {
  const c = fakeConnection();
  const events = [];
  let readyAfterRejoin = false;
  const entersState = async (conn, status) => {
    if (status === 'ready' && c.rejoins > 0) {
      readyAfterRejoin = true;
      return conn;
    }
    throw new Error('timeout');
  };
  watchConnection(c, { entersState, onLost: (r) => events.push(['lost', r]), onRejoined: () => events.push(['back']), timings: fastTimings });

  c.emit('disconnected', {}, { status: 'disconnected', reason: 0, closeCode: 4006 });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(readyAfterRejoin);
  assert.deepEqual(events, [['back']]);
});

test('a connection that will not come back is reported lost, once', async () => {
  const c = fakeConnection();
  const events = [];
  const entersState = async () => {
    throw new Error('timeout');
  };
  watchConnection(c, { entersState, onLost: (r) => events.push(['lost', r]), onRejoined: () => events.push(['back']), timings: fastTimings });

  c.emit('disconnected', {}, { status: 'disconnected', reason: 0, closeCode: 4006 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.rejoins, 2, 'one rejoin per configured delay');
  assert.deepEqual(events, [['lost', 'dropped']]);
});

// 4014 is Discord saying the bot was removed from the channel — kicked, or the
// channel deleted. Somebody decided that, so rejoining would be overruling them.
test('being removed from the channel is not fought', async () => {
  const c = fakeConnection();
  const events = [];
  const entersState = async () => {
    throw new Error('timeout');
  };
  watchConnection(c, { entersState, onLost: (r) => events.push(['lost', r]), timings: fastTimings });

  c.emit('disconnected', {}, { status: 'disconnected', reason: 0, closeCode: 4014 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.rejoins, 0);
  assert.deepEqual(events, [['lost', 'removed']]);
});

// --- the loop that joins them -----------------------------------------------

test('the watch ends an abandoned session and tells the table and the owner', async () => {
  const s = session({ meetingId: 9, emptySince: 0, voiceChannelId: 'v1' });
  const sessions = new Map([[9, s]]);
  const ended = [];
  const told = [];

  await runSessionWatch({
    sessions,
    cfg,
    now: 11 * MIN,
    presenceOf: () => ({ humans: 0, recordable: 0 }),
    endSession: async (x, reason) => ended.push([x.meetingId, reason]),
    tell: async (x, what) => told.push([x.meetingId, what.kind]),
  });

  assert.deepEqual(ended, [[9, 'empty']]);
  assert.deepEqual(told, [[9, 'close']]);
});

test('one session failing to end does not stop the others being checked', async () => {
  const a = session({ meetingId: 1, emptySince: 0 });
  const b = session({ meetingId: 2, emptySince: 0 });
  const ended = [];
  await runSessionWatch({
    sessions: new Map([[1, a], [2, b]]),
    cfg,
    now: 11 * MIN,
    presenceOf: () => ({ humans: 0, recordable: 0 }),
    endSession: async (x) => {
      if (x.meetingId === 1) throw new Error('boom');
      ended.push(x.meetingId);
    },
    tell: async () => {},
  });
  assert.deepEqual(ended, [2]);
});

// --- what the table is told -------------------------------------------------

test('an automatic ending is said in the channel /join was run in', async () => {
  const { announceAutoEnd } = await import('../src/commands/index.js');
  const sent = [];
  const client = { channels: { fetch: async (id) => (id === 'text-1' ? { send: async (m) => sent.push(m) } : null) } };
  const s = { meetingId: 3, channelName: 'The Cellar', textChannelId: 'text-1', capturedUtterances: [1, 2, 3] };

  await announceAutoEnd({ client, session: s, reason: 'empty' });
  await announceAutoEnd({ client, session: s, reason: 'dropped', ended: { clipCount: 40 } });

  assert.match(sent[0], /Everyone has left \*\*#The Cellar\*\*/);
  assert.match(sent[0], /3 clips, queued/);
  assert.doesNotMatch(sent[0], /campaign join/, 'an empty table is not told to rejoin');
  assert.match(sent[1], /lost my connection/);
  assert.match(sent[1], /40 clips/);
  assert.match(sent[1], /\/campaign join/);
});
