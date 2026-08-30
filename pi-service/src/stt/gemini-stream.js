import { GoogleGenAI } from '@google/genai';

import { readPcmWav } from '../pipeline/wav-merge.js';

// Gemini 3.5 Transcribe Live, fed one continuous stream PER SPEAKER.
//
// This replaces an earlier per-clip design that did not work. The numbers,
// all measured against the live API on a real 191-minute session, are worth
// keeping because each one closed off a road:
//
//   per clip, waiting for each         13.10 s/clip, 19% timed out  (~9 h)
//   per clip, pipelined (no waiting)   socket dies: "Internal error" at +16s
//   continuous stream                  2.1x realtime, reliable
//
// The live API is built for a stream and punishes anything else. Sending a
// clip and waiting for its transcription spends ~13s on the round trip
// whatever the clip's length; firing the activity blocks back-to-back without
// waiting kills the connection outright. What works is what it was designed
// for: open a socket and talk into it.
//
// WHY PER SPEAKER. Discord hands us one audio stream per person, so a socket
// per person keeps attribution exact by construction — the model is never
// asked to guess who spoke, and diarization stays off. Six concurrent sockets
// were measured working on one key, which is a table's worth.
//
// WHY 1x. The model has no word timestamps, so something else has to say when
// each fragment was said. Measured at 1x realtime, fragments arrive 0.3s
// behind the audio — close enough that ARRIVAL TIME IS THE TIMESTAMP, checked
// against whisper's own timings for the same minutes and matching to ~1s.
// Push faster and the model falls behind unpredictably (at 4x it was still
// draining ~100s after the audio stopped), and that lag lands straight in the
// transcript as misplaced lines. Pace is configurable because the trade is
// real, but the default is the one that keeps the timestamps honest.
//
// The same module serves the live path: streaming a recording from disk at 1x
// and streaming a session from Discord as it happens are the same thing, and
// the second is free — people already talk in realtime.

const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const MIME_TYPE = `audio/pcm;rate=${SAMPLE_RATE}`;
const FRAME_MS = 1000;

// Silence inserted between one speaker's consecutive clips, so the model's own
// voice detection ends a turn at the seam rather than running two utterances
// together. Also what keeps a stream from being one unbroken 55-minute
// sentence.
const GAP_MS = 700;

// Below this a clip is a mic click or a noise-gate blip rather than speech.
const MIN_CLIP_MS = 200;

// The session ceiling is WALL CLOCK, not audio — measured: a socket fed only
// 41s of audio was still cut off at 10 minutes. It is announced first, with
// `goAway` arriving ~50s ahead, which is the window to roll cleanly in. Both
// limits are honoured: this one for the clock, the audio budget for the feed.
const WALL_CLOCK_LIMIT_MS = 9 * 60_000;

let client = null;
const getClient = (cfg) => (client ??= new GoogleGenAI({ apiKey: cfg.geminiApiKey }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isGeminiTranscribeConfigured(cfg) {
  return Boolean(cfg?.geminiTranscribe && cfg?.geminiApiKey);
}

// Fragments arrive without their own spacing — measured: ["Meepo", "Meepo
// comes up.", "You see this one here?"] — so a blind concatenation runs every
// sentence into the next. A space goes in only where neither side has one,
// which is also correct for a model that does send its own.
export function joinFragments(parts) {
  return parts
    .reduce((acc, p) => (acc ? acc + (/\s$/.test(acc) || /^\s/.test(p) ? '' : ' ') + p : p), '')
    .replace(/\s+/g, ' ')
    .trim();
}

// One speaker's clips laid end to end with a gap between each, plus where each
// clip sits in that stream. The ranges are what turn "a fragment arrived when
// the cursor was at 92_400ms" back into "that was clip 37".
//
// Exported because the mapping is the part most worth testing without a
// socket: get it wrong and the transcript is right but attributed to the wrong
// moment, which is invisible until somebody reads it.
export function planStream(clips, { gapMs = GAP_MS } = {}) {
  const ranges = [];
  let cursor = 0;
  for (const clip of clips) {
    const durMs = Math.max(0, clip.durationMs ?? 0);
    if (durMs < MIN_CLIP_MS) continue;
    ranges.push({ clip, fromMs: cursor, toMs: cursor + durMs });
    cursor += durMs + gapMs;
  }
  // The last clip's end, not the cursor — the cursor has a trailing gap on it
  // that no clip occupies, and progress reported against that never reaches
  // 100%.
  return { ranges, totalMs: ranges.length ? ranges[ranges.length - 1].toMs : 0 };
}

// Which clip a fragment belongs to, given where the audio cursor was when it
// arrived and how far the model is running behind.
//
// Nearest range rather than strict containment: a fragment that lands in an
// inserted gap still belongs to whichever clip it is closest to, and dropping
// it would lose real speech.
export function assignToRange(ranges, atMs) {
  let best = null;
  let bestDist = Infinity;
  for (const r of ranges) {
    const dist = atMs < r.fromMs ? r.fromMs - atMs : atMs > r.toMs ? atMs - r.toMs : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return best;
}

const defaultConnect = (params, cfg) => getClient(cfg).live.connect(params);

// One socket, and everything that can go wrong with it. Rolled by the caller
// rather than here, so the audio cursor survives a roll.
async function openSocket(cfg, vocabulary, connect) {
  const state = { fragments: [], goingAway: false, closed: false, fatal: null, openedAt: Date.now() };

  const session = await connect(
    {
      model: cfg.geminiTranscribeModel,
      config: {
        responseModalities: ['TEXT'],
        inputAudioTranscription: {
          languageCodes: [cfg.whisperLanguage || 'en'],
          // Measured worth 2.2x more correctly-spelled proper nouns than
          // whisper's prompt, and unlike that prompt it cannot echo back as
          // dialogue. Incompatible with timestamps and diarization on the file
          // model; on this one there are neither to lose.
          ...(vocabulary.length ? { customVocabulary: vocabulary } : {}),
        },
        // Deliberately NOT disabling automatic detection. Explicit activity
        // signals are what the failed per-clip design used, and pipelining
        // them killed the socket outright. Here the model segments its own
        // stream and the gaps above tell it where.
      },
      callbacks: {
        onmessage: (message) => {
          if (message.goAway) state.goingAway = true;
          const t = message.serverContent?.inputTranscription;
          if (t?.text) state.fragments.push({ text: t.text, atWallMs: Date.now() });
        },
        onerror: (e) => {
          state.fatal = new Error(`live socket error: ${e?.message ?? 'unknown'}`);
          state.closed = true;
        },
        onclose: () => {
          state.closed = true;
        },
      },
    },
    cfg
  );

  return { session, state };
}

// Streams one speaker's whole track, rolling sockets as the wall clock or the
// server require, and returns every fragment tagged with the audio cursor at
// the moment it arrived.
async function streamOneSpeaker(ranges, totalMs, readAudio, cfg, vocabulary, connect, onAudioMs) {
  const pace = cfg.geminiTranscribeMaxRealtime > 0 ? cfg.geminiTranscribeMaxRealtime : 1;
  const collected = [];

  let socket = await openSocket(cfg, vocabulary, connect);
  let socketStartedAt = Date.now();
  let cursorMs = 0;
  const startedAt = Date.now();

  // Fragments are drained with the cursor value they arrived at, so a roll
  // does not lose the mapping.
  const drain = () => {
    for (const f of socket.state.fragments.splice(0)) collected.push({ text: f.text, cursorMs });
  };

  const roll = async () => {
    drain();
    try {
      socket.session.close();
    } catch {
      /* already gone */
    }
    socket = await openSocket(cfg, vocabulary, connect);
    socketStartedAt = Date.now();
  };

  for (const range of ranges) {
    const pcm = await readAudio(range.clip);
    if (!pcm) continue;

    // Roll BEFORE the clip rather than during it, so no utterance straddles a
    // seam. goAway gives ~50s of warning, which is ample for this.
    if (socket.state.goingAway || socket.state.closed || Date.now() - socketStartedAt > WALL_CLOCK_LIMIT_MS) {
      await roll();
    }

    for (let at = 0; at < pcm.length; at += BYTES_PER_MS * FRAME_MS) {
      const frame = pcm.subarray(at, Math.min(at + BYTES_PER_MS * FRAME_MS, pcm.length));
      try {
        socket.session.sendRealtimeInput({ audio: { data: frame.toString('base64'), mimeType: MIME_TYPE } });
      } catch (err) {
        // A dead socket mid-clip costs this clip's tail; the roll picks the
        // stream back up rather than abandoning the speaker.
        await roll();
      }
      cursorMs += frame.length / BYTES_PER_MS;
      drain();

      // Hold to `pace` times realtime. Above ~4x the server drops audio
      // silently; at 1x the arrival time IS the timestamp.
      const owed = cursorMs / pace - (Date.now() - startedAt);
      if (owed > 0) await sleep(owed);
    }

    // The gap has to be SENT, not just counted. It is what the model's own
    // voice detection segments on, so a gap that exists only in the
    // bookkeeping gives it one unbroken utterance to chop up however it likes
    // — and leaves the cursor describing more audio than the socket received,
    // which puts every later fragment on the wrong clip.
    const silence = Buffer.alloc(BYTES_PER_MS * GAP_MS);
    for (let at = 0; at < silence.length; at += BYTES_PER_MS * FRAME_MS) {
      const frame = silence.subarray(at, Math.min(at + BYTES_PER_MS * FRAME_MS, silence.length));
      try {
        socket.session.sendRealtimeInput({ audio: { data: frame.toString('base64'), mimeType: MIME_TYPE } });
      } catch {
        /* the roll before the next clip picks this up */
      }
      cursorMs += frame.length / BYTES_PER_MS;
      drain();
    }

    onAudioMs?.(range.toMs, totalMs);
  }

  // The tail: the model keeps emitting after the audio stops. Quiescence is
  // the signal — waiting for a close would pay the full session timeout.
  let seen = -1;
  for (let quiet = 0; quiet < 20 && seen !== collected.length; quiet += 1) {
    seen = collected.length;
    await sleep(1000);
    drain();
    if (collected.length !== seen) quiet = 0;
  }
  drain();

  try {
    socket.session.close();
  } catch {
    /* already gone */
  }

  return collected;
}

// clips: [{ userId, displayName, wavPath, startMs, endMs }]
//
// Returns the same { results, failures } shape the whisper paths produce.
export async function transcribeSpeakerStreams(
  clips,
  cfg,
  { vocabulary = [], onProgress, connect = defaultConnect, readAudio = null } = {}
) {
  const bySpeaker = new Map();
  for (const c of clips) {
    if (!bySpeaker.has(c.userId)) bySpeaker.set(c.userId, []);
    bySpeaker.get(c.userId).push(c);
  }

  const failures = [];

  // Durations come from the WAV itself. end_ms in the database is not usable —
  // it equals start_ms on every row.
  const load =
    readAudio ??
    (async (clip) => {
      const wav = await readPcmWav(clip.wavPath);
      if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1 || wav.bitsPerSample !== 16) {
        throw new Error(`expected 16kHz mono 16-bit PCM, got ${wav.sampleRate}Hz ${wav.channels}ch ${wav.bitsPerSample}-bit`);
      }
      return wav.data;
    });

  const plans = [];
  for (const [userId, list] of bySpeaker) {
    list.sort((a, b) => a.startMs - b.startMs);
    const sized = [];
    for (const clip of list) {
      try {
        const pcm = await load(clip);
        sized.push({ ...clip, durationMs: pcm.length / BYTES_PER_MS, _pcm: pcm });
      } catch (err) {
        failures.push({ wavPath: clip.wavPath, error: err.message });
      }
    }
    plans.push({ userId, ...planStream(sized) });
  }

  const totalAudioMs = plans.reduce((n, p) => n + p.totalMs, 0);
  const doneBySpeaker = new Map();
  const report = () => {
    if (!onProgress) return;
    const done = [...doneBySpeaker.values()].reduce((a, b) => a + b, 0);
    onProgress(Math.round(done), Math.round(totalAudioMs));
  };

  console.log(
    `[gemini-stt] ${bySpeaker.size} speaker streams, ${(totalAudioMs / 60000).toFixed(1)} min of audio, ` +
      `paced at ${cfg.geminiTranscribeMaxRealtime}x` +
      `${vocabulary.length ? `, ${vocabulary.length} campaign terms` : ''}`
  );

  // Concurrently — measured working on six sockets at once, and the wall clock
  // is then the LONGEST speaker rather than the sum of all of them.
  const perSpeaker = await Promise.all(
    plans.map(async (plan) => {
      if (!plan.ranges.length) return [];
      try {
        const fragments = await streamOneSpeaker(
          plan.ranges,
          plan.totalMs,
          async (clip) => clip._pcm,
          cfg,
          vocabulary,
          connect,
          (doneMs) => {
            doneBySpeaker.set(plan.userId, doneMs);
            report();
          }
        );
        return { plan, fragments };
      } catch (err) {
        for (const r of plan.ranges) failures.push({ wavPath: r.clip.wavPath, error: err.message });
        console.error(`[gemini-stt] speaker stream failed: ${err.message}`);
        return null;
      }
    })
  );

  // Fragments back onto clips, by where the cursor was when each arrived.
  const byClip = new Map();
  for (const entry of perSpeaker) {
    if (!entry || !entry.fragments) continue;
    for (const f of entry.fragments) {
      const range = assignToRange(entry.plan.ranges, f.cursorMs);
      if (!range) continue;
      if (!byClip.has(range)) byClip.set(range, []);
      byClip.get(range).push(f.text);
    }
  }

  const results = [];
  for (const [range, parts] of byClip) {
    const text = joinFragments(parts);
    if (!text) continue;
    results.push({
      userId: range.clip.userId,
      displayName: range.clip.displayName,
      startMs: range.clip.startMs,
      endMs: range.clip.endMs,
      text,
      seconds: (range.toMs - range.fromMs) / 1000,
    });
  }

  results.sort((a, b) => a.startMs - b.startMs);
  return { results, failures };
}
