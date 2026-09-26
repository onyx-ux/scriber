import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  transcribeSpeakerStreams,
  isGeminiTranscribeConfigured,
  planStream,
  assignToRange,
  joinFragments,
} from '../src/stt/gemini-stream.js';
import { writePcmWav } from '../src/pipeline/wav-merge.js';

// The per-clip design this replaced failed in two measured ways: waiting for
// each clip cost 13.1s of round trip, and firing the clips back-to-back
// without waiting killed the socket ("Internal error" at +16s). What is left
// is a continuous stream per speaker, which means the mapping from "a fragment
// arrived here in the stream" back to "this clip, this person, this minute" is
// now the load-bearing part — and the part that fails silently, producing a
// transcript that reads fine and is attributed to the wrong moment.

const cfg = {
  geminiTranscribe: true,
  geminiApiKey: 'gm-test',
  geminiTranscribeModel: 'gemini-3.5-transcribe-live',
  geminiTranscribeMaxRealtime: 0, // unpaced, so tests stay instant
  whisperLanguage: 'en',
};

async function wav(dir, name, ms, { sampleRate = 16_000, channels = 1, bitsPerSample = 16 } = {}) {
  const bytes = Math.round((sampleRate * channels * (bitsPerSample / 8) * ms) / 1000);
  const data = Buffer.alloc(bytes - (bytes % ((channels * bitsPerSample) / 8)), 0x11);
  const path = join(dir, name);
  await writeFile(path, writePcmWav({ sampleRate, channels, bitsPerSample }, data));
  return path;
}

const clip = (wavPath, { userId = 'u1', displayName = 'Player', startMs = 0, durationMs = 1000 } = {}) => ({
  userId,
  displayName,
  wavPath,
  startMs,
  endMs: startMs + durationMs,
});

// A socket that answers when it has been given `afterMs` of audio, so a test
// can say "reply during clip 3" and have the mapping proved rather than
// assumed.
//
// A script entry is either an array of those replies, or an object:
//   { refuse: true }        the server closes the socket before setup. The
//                           real SDK's connect() then NEVER settles — it
//                           awaits an open and a setupComplete that nothing
//                           rejects — so this one never settles either.
//   { closeAfterMs, replies } the server drops the socket once it has been
//                           sent that much audio, and anything sent after
//                           is lost, as the real one is.
function fakeTransport(script = []) {
  const sockets = [];
  const queue = [...script];
  let refused = 0;

  const connect = async (params) => {
    const entry = queue.shift() ?? [];
    const { onmessage, onclose } = params.callbacks;

    if (entry.refuse) {
      refused += 1;
      onclose?.({ code: 1011, reason: 'refused in a test' });
      return new Promise(() => {});
    }

    const pending = Array.isArray(entry) ? entry : entry.replies ?? [];
    const rec = { config: params.config, model: params.model, audioMs: 0, closed: false };

    const socket = {
      sendRealtimeInput(message) {
        if (!message.audio?.data) return;
        if (rec.closed) return; // a closed socket drops audio without a word
        rec.audioMs += Buffer.from(message.audio.data, 'base64').length / 32;
        for (const item of pending) {
          if (!item.sent && rec.audioMs >= item.afterMs) {
            item.sent = true;
            if (item.goAway) onmessage({ goAway: { timeLeft: '50s' } });
            if (item.text != null) onmessage({ serverContent: { inputTranscription: { text: item.text } } });
          }
        }
        if (entry.closeAfterMs != null && rec.audioMs >= entry.closeAfterMs && !rec.closed) {
          rec.closed = true;
          onclose?.({ code: 1011, reason: entry.closeReason ?? 'dropped in a test' });
        }
      },
      close() {
        if (rec.closed) return;
        rec.closed = true;
        onclose?.({ code: 1000, reason: '' });
      },
    };
    sockets.push(rec);
    return socket;
  };

  return { connect, sockets, refusals: () => refused };
}

// Timings shrunk so a refused socket costs milliseconds rather than the
// thirty seconds and the backoff it costs against the real API.
const fast = {
  ...cfg,
  geminiTranscribeConnectTimeoutMs: 50,
  geminiTranscribeRetryDelaysMs: [5, 5],
  geminiTranscribeCloseWaitMs: 20,
};

// --- the pure parts -------------------------------------------------------

test('a key alone is not consent — the switch is what turns this on', () => {
  assert.equal(isGeminiTranscribeConfigured({ geminiApiKey: 'k' }), false);
  assert.equal(isGeminiTranscribeConfigured({ geminiTranscribe: true }), false);
  assert.equal(isGeminiTranscribeConfigured({ geminiTranscribe: true, geminiApiKey: 'k' }), true);
});

test('the stream plan lays clips end to end with a gap between', () => {
  const { ranges, totalMs } = planStream(
    [
      { id: 'a', durationMs: 1000 },
      { id: 'b', durationMs: 2000 },
    ],
    { gapMs: 500 }
  );
  assert.deepEqual(ranges.map((r) => [r.fromMs, r.toMs]), [[0, 1000], [1500, 3500]]);
  // The last clip's END, not the cursor: a trailing gap belongs to no clip,
  // and progress measured against it would never reach 100%.
  assert.equal(totalMs, 3500);
});

// Discord opens a speaking segment for mic clicks too; streaming those spends
// budget to transcribe nothing and adds a seam for the model to trip over.
test('clips too short to be speech never make it into the stream', () => {
  const { ranges } = planStream([
    { id: 'blip', durationMs: 50 },
    { id: 'real', durationMs: 900 },
  ]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].clip.id, 'real');
});

test('a fragment is assigned to the clip it landed in', () => {
  const { ranges } = planStream(
    [
      { id: 'a', durationMs: 1000 },
      { id: 'b', durationMs: 1000 },
    ],
    { gapMs: 700 }
  );
  assert.equal(assignToRange(ranges, 500).clip.id, 'a');
  assert.equal(assignToRange(ranges, 2000).clip.id, 'b');
});

// The model segments its own stream, so a fragment can surface in one of the
// inserted silences. Dropping it would lose real speech, so it goes to
// whichever clip is nearest rather than nowhere.
test('a fragment landing in a gap goes to the nearer clip, not the floor', () => {
  const { ranges } = planStream(
    [
      { id: 'a', durationMs: 1000 },
      { id: 'b', durationMs: 1000 },
    ],
    { gapMs: 1000 }
  );
  assert.equal(assignToRange(ranges, 1100).clip.id, 'a', 'just after a ends');
  assert.equal(assignToRange(ranges, 1900).clip.id, 'b', 'just before b starts');
  assert.equal(assignToRange(ranges, 9999).clip.id, 'b', 'past the end still belongs somewhere');
});

// Measured against the live model: its fragments arrive WITHOUT leading
// spaces, so concatenating produced "MeepoMeepo comes up." A model that does
// send its own spacing must not get double ones either.
test('fragments are joined on the boundary, however the model spaces them', () => {
  assert.equal(joinFragments(['Meepo', 'comes', 'up.']), 'Meepo comes up.');
  assert.equal(joinFragments(['Meepo', ' comes', ' up.']), 'Meepo comes up.');
  assert.equal(joinFragments([]), '');
});

// --- the streaming itself -------------------------------------------------

test('each speaker gets their own socket, and keeps their own words', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, 'a.wav', 1000), { userId: 'u1', displayName: 'Thora', startMs: 0 }),
    clip(await wav(dir, 'b.wav', 1000), { userId: 'u2', displayName: 'Kaelen', startMs: 1000 }),
  ];

  // One script per socket, in the order the speakers are opened.
  const transport = fakeTransport([[{ afterMs: 500, text: 'I open the door' }], [{ afterMs: 500, text: 'Roll for initiative' }]]);

  const { results, failures } = await transcribeSpeakerStreams(clips, cfg, { connect: transport.connect });

  assert.deepEqual(failures, []);
  assert.equal(transport.sockets.length, 2, 'a socket per speaker is what keeps attribution exact');
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.displayName === 'Thora').text, 'I open the door');
  assert.equal(results.find((r) => r.displayName === 'Kaelen').text, 'Roll for initiative');
});

// The whole point of the per-speaker split: the model is never asked who
// spoke, so it cannot get it wrong.
test('one speaker’s several clips land on the right clips', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, '0.wav', 1000), { startMs: 0 }),
    clip(await wav(dir, '1.wav', 1000), { startMs: 5000 }),
    clip(await wav(dir, '2.wav', 1000), { startMs: 9000 }),
  ];

  // Ranges with a 700ms gap: [0,1000] [1700,2700] [3400,4400]. The gaps are
  // sent as real silence, so the socket's audio total and the stream cursor
  // are the same number — which is what makes these trigger points mean
  // "during clip N".
  const transport = fakeTransport([
    [
      { afterMs: 900, text: 'first' },
      { afterMs: 2600, text: 'second' },
      { afterMs: 4300, text: 'third' },
    ],
  ]);

  const { results } = await transcribeSpeakerStreams(clips, cfg, { connect: transport.connect });

  assert.deepEqual(
    results.map((r) => [r.startMs, r.text]),
    [[0, 'first'], [5000, 'second'], [9000, 'third']],
    'each fragment must come back on the clip whose audio produced it'
  );
});

test('results come back in session order, not speaker order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, 'a.wav', 1000), { userId: 'u1', displayName: 'A', startMs: 3000 }),
    clip(await wav(dir, 'b.wav', 1000), { userId: 'u2', displayName: 'B', startMs: 1000 }),
  ];
  const transport = fakeTransport([[{ afterMs: 500, text: 'later' }], [{ afterMs: 500, text: 'earlier' }]]);

  const { results } = await transcribeSpeakerStreams(clips, cfg, { connect: transport.connect });
  assert.deepEqual(results.map((r) => r.text), ['earlier', 'later']);
});

// goAway arrives ~50s before the server cuts the socket. Rolling on it is what
// keeps a session longer than ten minutes from losing audio at every seam.
test('a goAway rolls onto a fresh socket without losing the stream', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, '0.wav', 1000), { startMs: 0 }),
    clip(await wav(dir, '1.wav', 1000), { startMs: 2000 }),
  ];
  const transport = fakeTransport([
    [{ afterMs: 900, text: 'before the roll', goAway: true }],
    [{ afterMs: 900, text: 'after the roll' }],
  ]);

  const { results, failures } = await transcribeSpeakerStreams(clips, cfg, { connect: transport.connect });

  assert.deepEqual(failures, []);
  assert.equal(transport.sockets.length, 2, 'the warning has to be acted on, or the server cuts it mid-clip');
  assert.ok(transport.sockets[0].closed, 'the old socket is a leak if it is not closed');
  assert.deepEqual(results.map((r) => r.text), ['before the roll', 'after the roll']);
});

// Meeting 32, 26 Sep 2026: the first four-hour session on this path. Every
// speaker reached the nine-minute roll, asked for a fresh socket, and the
// server closed it before setup. The SDK's connect() never settles when that
// happens, so all six streams waited on it forever — no socket open, no error
// logged, the job still `running` an hour later.
test('a reconnect refused before setup is retried rather than waited on forever', { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, '0.wav', 1000), { startMs: 0 }),
    clip(await wav(dir, '1.wav', 1000), { startMs: 2000 }),
  ];
  const transport = fakeTransport([
    [{ afterMs: 900, text: 'before the roll', goAway: true }],
    { refuse: true },
    [{ afterMs: 900, text: 'after the roll' }],
  ]);

  const { results, failures } = await transcribeSpeakerStreams(clips, fast, { connect: transport.connect });

  assert.equal(transport.refusals(), 1);
  assert.deepEqual(failures, []);
  assert.deepEqual(results.map((r) => r.text), ['before the roll', 'after the roll']);
});

// When the server will not take a socket back at all, the run has to END —
// and end as a failure. A transcript committed without that speaker would
// read as complete, and committing is what lets the archive step clear away
// the clips needed to try again.
test('a speaker who can never reconnect fails the run instead of hanging it', { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, 'a0.wav', 1000), { userId: 'u1', startMs: 0 }),
    clip(await wav(dir, 'a1.wav', 1000), { userId: 'u1', startMs: 2000 }),
  ];
  const transport = fakeTransport([
    [{ afterMs: 500, goAway: true }],
    { refuse: true },
    { refuse: true },
    { refuse: true },
  ]);

  await assert.rejects(
    transcribeSpeakerStreams(clips, fast, { connect: transport.connect }),
    /could not reopen.*1011.*refused in a test/s
  );
  assert.equal(transport.refusals(), 3, 'one try plus the two retries the timings allow');
});

// A socket the server drops mid-clip does not throw on send — the real
// transport drops the audio silently. Waiting for the next clip boundary to
// notice would lose the rest of the clip, so the stream has to look before
// every frame.
test('audio is never fed into a socket the server has already closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [clip(await wav(dir, 'long.wav', 5000), { startMs: 0 })];
  const transport = fakeTransport([{ closeAfterMs: 2000 }, []]);

  const { failures } = await transcribeSpeakerStreams(clips, fast, { connect: transport.connect });

  assert.deepEqual(failures, []);
  assert.equal(transport.sockets.length, 2);
  const sent = transport.sockets.reduce((n, s) => n + s.audioMs, 0);
  assert.ok(sent >= 5000, `every second of the clip has to reach a live socket (got ${sent}ms)`);
});

test('the campaign vocabulary and a pinned language reach every socket', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, 'a.wav', 900), { userId: 'u1' }),
    clip(await wav(dir, 'b.wav', 900), { userId: 'u2' }),
  ];
  const transport = fakeTransport([[], []]);

  await transcribeSpeakerStreams(clips, cfg, {
    connect: transport.connect,
    vocabulary: ['Kaelen Zyrthax', 'Thora Ironfist'],
  });

  for (const s of transport.sockets) {
    assert.deepEqual(s.config.inputAudioTranscription.customVocabulary, ['Kaelen Zyrthax', 'Thora Ironfist']);
    assert.deepEqual(s.config.inputAudioTranscription.languageCodes, ['en']);
    // Explicit activity signals are what the failed per-clip design used;
    // pipelining them killed the socket outright.
    assert.equal(s.config.realtimeInputConfig, undefined, 'the model segments its own stream here');
  }
});

test('an unreadable clip fails alone and the speaker keeps going', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(join(dir, 'missing.wav'), { startMs: 0 }),
    clip(await wav(dir, 'ok.wav', 1000), { startMs: 2000 }),
  ];
  const transport = fakeTransport([[{ afterMs: 500, text: 'still here' }]]);

  const { results, failures } = await transcribeSpeakerStreams(clips, cfg, { connect: transport.connect });

  assert.equal(failures.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'still here');
});

test('a clip in the wrong format is rejected rather than streamed as noise', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [clip(await wav(dir, 'stereo.wav', 900, { channels: 2 }), { startMs: 0 })];
  const { failures } = await transcribeSpeakerStreams(clips, cfg, { connect: fakeTransport([]).connect });

  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /16kHz mono 16-bit/);
});

test('progress is reported against the audio, not the clip count', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [
    clip(await wav(dir, '0.wav', 1000), { startMs: 0 }),
    clip(await wav(dir, '1.wav', 3000), { startMs: 2000 }),
  ];
  const seen = [];
  await transcribeSpeakerStreams(clips, cfg, {
    connect: fakeTransport([[]]).connect,
    onProgress: (done, total) => seen.push([done, total]),
  });

  assert.ok(seen.length >= 2, 'a bar that only moves at the end is not a bar');
  const [done, total] = seen[seen.length - 1];
  assert.equal(done, total, 'it has to reach the end, or the bar stalls at 90% forever');
});

// Session 32, the second night (26 Sep 2026): the key ran out of quota 30
// seconds in. Every reconnect SUCCEEDED and was then closed at once with 1011
// "You exceeded your current quota", 910 times. Rolling onto a fresh socket
// each time kept the run going, feeding audio into sockets that dropped it, and
// it "finished" with 852 lines of a four-hour session. Committing that let the
// archive step delete the clips a retry needed.
test('running out of quota fails the run rather than rolling forever', { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [clip(await wav(dir, 'long.wav', 5000), { startMs: 0 })];
  const quota = { closeAfterMs: 1000, closeReason: 'You exceeded your current quota, please check your plan and billing details.' };
  const transport = fakeTransport([quota, quota, quota, quota, quota, quota]);

  await assert.rejects(
    transcribeSpeakerStreams(clips, fast, { connect: transport.connect }),
    /quota/
  );
  assert.equal(transport.sockets.length, 1, 'quota is not something a fresh socket fixes');
});

// The general form of the same failure: whatever the reason, sockets that die
// moments after opening are not a stream. A few of those in a row is a run
// that is losing audio, and it has to stop.
test('sockets that keep dying as soon as they open fail the run', { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const clips = [clip(await wav(dir, 'long.wav', 9000), { startMs: 0 })];
  const dying = { closeAfterMs: 1000, closeReason: 'Internal error' };
  const transport = fakeTransport(Array.from({ length: 10 }, () => dying));

  await assert.rejects(
    transcribeSpeakerStreams(clips, fast, { connect: transport.connect }),
    /keep closing/
  );
  assert.ok(transport.sockets.length <= 5, `gave up after ${transport.sockets.length} sockets`);
});
