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
function fakeTransport(script = []) {
  const sockets = [];
  const queue = [...script];

  const connect = async (params) => {
    const rec = { config: params.config, model: params.model, audioMs: 0, closed: false };
    const { onmessage } = params.callbacks;
    const pending = queue.shift() ?? [];

    const socket = {
      sendRealtimeInput(message) {
        if (!message.audio?.data) return;
        rec.audioMs += Buffer.from(message.audio.data, 'base64').length / 32;
        for (const item of pending) {
          if (!item.sent && rec.audioMs >= item.afterMs) {
            item.sent = true;
            if (item.goAway) onmessage({ goAway: { timeLeft: '50s' } });
            if (item.text != null) onmessage({ serverContent: { inputTranscription: { text: item.text } } });
          }
        }
      },
      close() {
        rec.closed = true;
      },
    };
    sockets.push(rec);
    return socket;
  };

  return { connect, sockets };
}

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
