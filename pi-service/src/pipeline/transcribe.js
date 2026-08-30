import { writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { transcribeWav } from '../stt/whisper.js';
import { transcribeSpeakerStreams, isGeminiTranscribeConfigured } from '../stt/gemini-stream.js';
import { looksLikePromptEcho, promptTerms } from '../stt/vocabulary.js';
import { looksLikeHallucination } from '../stt/hallucination.js';
import { mergeWavs, assignSegmentsToRanges } from './wav-merge.js';

// whisper.cpp encodes a fixed 30-SECOND window no matter how short the input
// is — measured on the Pi at ~65s of CPU per window for medium.en. A Discord
// session is hundreds of one-to-two-second clips (one per speaking turn), so
// transcribing them one at a time burns a full 30s window on each: a real
// 235-clip session was measured at ~4.5 hours, essentially all of it wasted
// encode. Merging clips so each window is actually full is worth ~6x.
//
// The catch, found by A/B testing against real session audio: whisper
// re-segments merged audio however it likes and its timestamps do NOT line up
// with the clip boundaries that went in. Merging clips from DIFFERENT people
// therefore smears text across speakers — the transcript stops being a
// reliable record of who said what, which is the whole point of it.
//
// So batches are built PER SPEAKER. Whatever whisper does with the timing
// inside a batch, every word in it provably belongs to that one person; only
// the line breaks within a single speaker's own run can shift. Attribution —
// the part that matters — is exact by construction.
//
// (Two other approaches were measured and rejected: passing many files to one
// whisper invocation still pays a full window each (~65s/file, no better than
// before, so the model reload was never the real cost); and shrinking the
// encoder window with -ac wrecks the output — at -ac 200 it looped a phrase
// twice, at -ac 100 it returned ".".)
//
// WHAT THIS COSTS, measured on 20 real clips against the one-at-a-time path:
//   speed        1389s -> 262s (5.3x)
//   speakers     100% correct (0 lines misattributed)
//   words kept   ~95% (109 of 114)
//   line breaks  ragged — whisper's word timestamps drift by a few hundred
//                ms on merged audio, which is wider than a ~1s clip, so a
//                word can land on the neighbouring clip and sentences get
//                chopped ("I" / "have 87," as separate lines). Widening the
//                silence gap to 1500ms did not help and cost words, so no
//                realistic gap fixes this.
// The content, order and speakers are all right; it's the line breaks and
// exact per-line timestamps that suffer. That's a fair trade for a summariser
// (which reads the whole transcript anyway) but it IS a regression in how the
// raw transcript reads, so TRANSCRIBE_BATCHING=false opts back out.

// Target audio per batch. Just under 30s so a batch normally lands in one
// encode window; going over would spill into a second, mostly-empty one.
const TARGET_BATCH_MS = 27_000;
// Silence between merged clips. Measured 700 vs 1500ms on real audio: wider
// gaps did NOT reduce how often a word lands on a neighbouring clip (whisper's
// word timestamps drift more than a ~1s clip is wide, so no realistic gap
// fixes it) and cost both audio length and a few words. Kept narrow.
const GAP_MS = 700;
// 16kHz mono 16-bit PCM = 32 bytes per millisecond. Used to size batches from
// file length without decoding anything.
const BYTES_PER_MS = 32;
const WAV_HEADER_BYTES = 44;

function toResult(u, text) {
  return { userId: u.userId, displayName: u.displayName, startMs: u.startMs, endMs: u.endMs, text };
}

async function clipDurationMs(wavPath) {
  try {
    const { size } = await stat(wavPath);
    return Math.max(0, (size - WAV_HEADER_BYTES) / BYTES_PER_MS);
  } catch {
    return 0;
  }
}

async function transcribeIndividually(batch, cfg, prompt) {
  const results = [];
  const failures = [];
  for (const u of batch) {
    try {
      const { text, langProb, seconds } = await transcribeWav(u.wavPath, cfg, { prompt });
      // Only applied per-clip: the filter needs whisper's per-clip language
      // confidence, which a merged batch reports once for 27s of audio.
      if (text && cfg.whisperDropFiller !== false && looksLikeHallucination(text, { langProb, seconds })) {
        console.log(
          `[whisper] dropped filler "${text}" from ${u.displayName} (lang confidence ${
            typeof langProb === 'number' ? langProb.toFixed(2) : 'n/a'
          }, ${seconds ?? '?'}s)`
        );
        continue;
      }
      if (text) results.push(toResult(u, text));
    } catch (err) {
      failures.push({ wavPath: u.wavPath, error: err.message });
      console.error(`[transcribe] failed on ${u.wavPath}: ${err.message}`);
    }
  }
  return { results, failures };
}

async function transcribeMerged(batch, cfg, prompt) {
  const { buffer, ranges } = await mergeWavs(
    batch.map((u) => u.wavPath),
    GAP_MS
  );
  const mergedPath = join(tmpdir(), `scriber-merge-${randomUUID()}.wav`);
  await writeFile(mergedPath, buffer);
  try {
    // Word-level segmentation, so each merged clip can get its own text back.
    // whisper's default segments span several clips at once, which collapsed
    // a 20-clip batch into 3 lines with timestamps minutes out of place.
    const { segments } = await transcribeWav(mergedPath, cfg, { wordLevel: true, prompt });
    // assignSegmentsToRanges falls back to the nearest range rather than
    // dropping a segment that lands in one of the inserted gaps, so no speech
    // is lost even when whisper's timing disagrees with the layout.
    const texts = assignSegmentsToRanges(segments, ranges);
    return batch.map((u, idx) => (texts[idx] ? toResult(u, texts[idx]) : null)).filter(Boolean);
  } finally {
    await unlink(mergedPath).catch(() => {});
  }
}

// One speaker's clips, in time order, grouped so each group is roughly one
// encode window's worth of audio.
async function batchesForSpeaker(utterances) {
  const batches = [];
  let current = [];
  let currentMs = 0;

  for (const u of utterances) {
    const durationMs = await clipDurationMs(u.wavPath);
    // A single clip longer than a whole window goes alone — merging it with
    // anything would only spill further.
    if (durationMs >= TARGET_BATCH_MS) {
      if (current.length) batches.push(current);
      batches.push([u]);
      current = [];
      currentMs = 0;
      continue;
    }
    if (current.length && currentMs + durationMs + GAP_MS > TARGET_BATCH_MS) {
      batches.push(current);
      current = [];
      currentMs = 0;
    }
    current.push(u);
    currentMs += durationMs + (current.length > 1 ? GAP_MS : 0);
  }
  if (current.length) batches.push(current);
  return batches;
}

async function transcribeBatch(batch, cfg, prompt) {
  // Nothing to gain from the merge machinery for a lone clip.
  if (batch.length === 1) return transcribeIndividually(batch, cfg, prompt);

  try {
    return { results: await transcribeMerged(batch, cfg, prompt), failures: [] };
  } catch (err) {
    // A malformed WAV (or any other merge-time failure) would otherwise cost
    // every clip in the batch its transcript. Falling back to one-at-a-time
    // for just this batch trades speed for correctness only where something
    // is actually wrong.
    console.error(`[transcribe] merged batch failed (${err.message}) — retrying its files individually`);
    return transcribeIndividually(batch, cfg, prompt);
  }
}

// Decides which clips get merged together. Exported so the "a batch is always
// one speaker" invariant — the thing that broke attribution when it didn't
// hold — can be tested directly, without needing whisper.
export async function planBatches(capturedUtterances) {
  // Group by speaker first — see the note at the top of this file. Within a
  // speaker, keep chronological order so merged audio runs forward in time.
  const bySpeaker = new Map();
  for (const u of capturedUtterances) {
    if (!bySpeaker.has(u.userId)) bySpeaker.set(u.userId, []);
    bySpeaker.get(u.userId).push(u);
  }

  const batches = [];
  for (const utterances of bySpeaker.values()) {
    utterances.sort((a, b) => a.startMs - b.startMs);
    batches.push(...(await batchesForSpeaker(utterances)));
  }
  return batches;
}

// Batching trades transcript quality for speed, so it should only be paid for
// where the speed is actually needed. The GPU server does a clip in ~0.17s —
// a whole session finishes in minutes untouched, so there is nothing to buy
// and the cleaner transcript wins. The Pi's CPU does the same clip in ~65s,
// where 5x decides whether a session is readable tomorrow morning at all.
//
// Exported for the tests, which is also where the fallback case is pinned: a
// configured-but-unreachable server ends up transcribing on the CPU, so it
// must resolve to batched, not clean.
export function shouldBatch(cfg, { serverReachable = null } = {}) {
  if (cfg.transcribeBatching !== 'auto') return cfg.transcribeBatching !== false;
  // No server configured, or a configured one that is not answering: this is
  // going to run on the Pi's CPU, so take the 5x.
  if (!cfg.whisperServerUrl) return true;
  return serverReachable === false;
}

// Whether this session goes to Gemini instead of whisper.
//
// The middle rung, never the first: the GPU is faster, costs nothing and
// keeps the audio on the LAN, so Gemini is only reached for when that machine
// cannot do the work. It is off entirely without GEMINI_TRANSCRIBE and a key
// — see config/env.js for why that switch is the operator's to throw.
//
// Exported for the tests, which is where the ordering is pinned: a reachable
// GPU server must win, or turning this on would quietly move every session's
// audio off the network.
export function shouldUseGemini(cfg, { serverReachable = null } = {}) {
  if (!isGeminiTranscribeConfigured(cfg)) return false;

  // An explicit answer at /leave beats the automatic ladder either way. The
  // literals are pipeline/transcribe-target.js's TARGET_* values, compared by
  // hand rather than imported so this module stays free of discord.js.
  if (cfg.transcribeVia === 'gemini') return true;
  if (cfg.transcribeVia === 'pi') return false;

  if (!cfg.whisperServerUrl) return true;
  return serverReachable === false;
}

// The Gemini path. Flat by design — no batching, no merging, no word
// timestamps — because the thing batching exists to amortise (whisper.cpp's
// fixed 30-second encode window) has no equivalent on a streaming socket.
// See stt/gemini-live.js.
// `connect` is injectable for the same reason probe and runJob are in
// transcribe-worker.js: the routing and the filtering are the parts worth
// testing, and neither should need a key or a socket. Production never passes
// it — stt/gemini-live.js supplies the real transport.
async function transcribeViaGemini(capturedUtterances, cfg, { onProgress, vocabulary, connect }) {
  // Chronological, so a rolled session's boundary falls between two clips
  // that were already neighbours rather than in the middle of the evening.
  const clips = [...capturedUtterances].sort((a, b) => a.startMs - b.startMs);

  console.log(
    `[gemini-stt] transcribing ${clips.length} clips on ${cfg.geminiTranscribeModel}` +
      `${vocabulary.length ? ` with ${vocabulary.length} campaign terms` : ''}`
  );

  const { results, failures } = await transcribeSpeakerStreams(clips, cfg, {
    vocabulary,
    onProgress,
    ...(connect ? { connect } : {}),
  });

  // The filler guard still runs, but with one hand tied: it separates real
  // speech from silence-hallucination on whisper's LANGUAGE CONFIDENCE, and
  // Gemini reports none. That leaves the duration fallback, which by design
  // only catches the very shortest clips (see stt/hallucination.js). Kept
  // anyway — it is strictly better than nothing, and Gemini is not trained on
  // subtitles so it should have far less of this to catch in the first place.
  const utterances = [];
  for (const { seconds, ...result } of results) {
    if (cfg.whisperDropFiller !== false && looksLikeHallucination(result.text, { seconds })) {
      console.log(`[gemini-stt] dropped filler "${result.text}" from ${result.displayName} (${seconds.toFixed(1)}s)`);
      continue;
    }
    utterances.push(result);
  }

  // No prompt-echo guard here on purpose. custom_vocabulary is a biasing list
  // rather than text fed to the decoder, so there is no prompt to come back —
  // the failure looksLikePromptEcho exists to catch cannot happen on this path.
  return { utterances, failures };
}

// capturedUtterances: [{ userId, displayName, wavPath, startMs, endMs }]
//
// Set cfg.transcribeBatching = false to transcribe every clip on its own
// instead. That is ~5x slower on CPU (a 235-clip session measured at ~4.5
// hours vs ~50 min) but gives cleaner line breaks and exact per-clip
// timestamps — see the trade-off note at the top of this file.
export async function transcribeAll(
  capturedUtterances,
  cfg,
  { onProgress, serverReachable = null, prompt = '', vocabulary = [], connect = null } = {}
) {
  // Gemini takes the whole run or none of it — the two engines split a
  // session's clips differently (one socket vs per-speaker merged batches),
  // so mixing them within one session would mean two sets of line breaks and
  // two sets of timestamp behaviour in the same transcript.
  if (shouldUseGemini(cfg, { serverReachable })) {
    return transcribeViaGemini(capturedUtterances, cfg, { onProgress, vocabulary, connect });
  }

  const results = [];
  const failures = [];

  const batches = shouldBatch(cfg, { serverReachable })
    ? await planBatches(capturedUtterances)
    : capturedUtterances.map((u) => [u]);

  // A prompted clip that came back as nothing but campaign names is whisper
  // reading the prompt off a near-silent recording, not someone talking.
  // See looksLikePromptEcho — this was reproduced against the live server.
  const terms = promptTerms(prompt);
  const keep = (r) => {
    if (!looksLikePromptEcho(r.text, terms)) return true;
    console.warn(`[whisper] dropped a prompt echo from ${r.displayName}: "${r.text}"`);
    return false;
  };

  let done = 0;
  for (const batch of batches) {
    const { results: batchResults, failures: batchFailures } = await transcribeBatch(batch, cfg, prompt);
    results.push(...batchResults.filter(keep));
    failures.push(...batchFailures);
    done += batch.length;
    onProgress?.(done, capturedUtterances.length);
  }

  // Batching walks one speaker at a time, so results come out grouped by
  // person; the transcript needs to read chronologically.
  results.sort((a, b) => a.startMs - b.startMs);
  return { utterances: results, failures };
}

// Accepts either DB rows (snake_case start_ms) or in-flight captured
// utterances (camelCase startMs), so read the offset through one accessor.
// The previous `a.start_ms - b.start_ms || a.startMs - b.startMs` chain
// evaluated to NaN whenever two DB rows shared a start_ms (0 || NaN), and a
// comparator returning NaN gives an implementation-defined ordering.
const offsetMs = (u) => u.start_ms ?? u.startMs ?? 0;

export function buildTranscriptText(utterances) {
  return [...utterances]
    .sort((a, b) => offsetMs(a) - offsetMs(b))
    .map((u) => {
      const ms = offsetMs(u);
      const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
      const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      const name = u.display_name ?? u.displayName;
      const text = u.text;
      return `[${mm}:${ss}] ${name}: ${text}`;
    })
    .join('\n');
}
