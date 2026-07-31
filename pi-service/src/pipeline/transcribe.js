import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { transcribeWav } from '../stt/whisper.js';
import { mergeWavs, assignSegmentsToRanges } from './wav-merge.js';

// whisper.cpp reloads its entire model from disk on every invocation. A real
// Discord session captures one short WAV per speaking turn — often under a
// couple of seconds of actual audio — so for a session with hundreds of
// utterances, that reload cost (measured: comparable to transcribing several
// minutes of real audio) dwarfs the actual transcription work. Batching
// merges each group of utterances into one file (with silence gaps between
// them) and makes ONE whisper call per batch instead of one per utterance,
// then splits the result back out by matching each returned segment's offset
// against the batch's per-utterance time ranges.
const BATCH_SIZE = 30;
const GAP_MS = 700;

function toResult(u, text) {
  return { userId: u.userId, displayName: u.displayName, startMs: u.startMs, endMs: u.endMs, text };
}

async function transcribeIndividually(batch, cfg) {
  const results = [];
  const failures = [];
  for (const u of batch) {
    try {
      const { text } = await transcribeWav(u.wavPath, cfg);
      if (text) results.push(toResult(u, text));
    } catch (err) {
      failures.push({ wavPath: u.wavPath, error: err.message });
      console.error(`[transcribe] failed on ${u.wavPath}: ${err.message}`);
    }
  }
  return { results, failures };
}

async function transcribeMerged(batch, cfg) {
  const { buffer, ranges } = await mergeWavs(
    batch.map((u) => u.wavPath),
    GAP_MS
  );
  const mergedPath = join(tmpdir(), `scriber-merge-${randomUUID()}.wav`);
  await writeFile(mergedPath, buffer);
  try {
    const { segments } = await transcribeWav(mergedPath, cfg);
    const texts = assignSegmentsToRanges(segments, ranges);
    return batch.map((u, idx) => (texts[idx] ? toResult(u, texts[idx]) : null)).filter(Boolean);
  } finally {
    await unlink(mergedPath).catch(() => {});
  }
}

// A lone file gets no benefit from merging (nothing to batch with) — skip
// straight to a single whisper call so the last, short batch of a session
// isn't carrying merge machinery for no reason.
async function transcribeBatch(batch, cfg) {
  if (batch.length === 1) return transcribeIndividually(batch, cfg);

  try {
    return { results: await transcribeMerged(batch, cfg), failures: [] };
  } catch (err) {
    // A malformed/mismatched WAV in the batch (or any other merge-time
    // failure) would otherwise cost every utterance in the batch its
    // transcript. Falling back to the slow one-at-a-time path for just this
    // batch trades speed for correctness only where something's actually
    // wrong, instead of everywhere.
    console.error(`[transcribe] merged batch failed (${err.message}) — retrying its files individually`);
    return transcribeIndividually(batch, cfg);
  }
}

// capturedUtterances: [{ userId, displayName, wavPath, startMs, endMs }]
export async function transcribeAll(capturedUtterances, cfg, { onProgress, batchSize = BATCH_SIZE } = {}) {
  const results = [];
  const failures = [];
  let done = 0;

  for (let i = 0; i < capturedUtterances.length; i += batchSize) {
    const batch = capturedUtterances.slice(i, i + batchSize);
    const { results: batchResults, failures: batchFailures } = await transcribeBatch(batch, cfg);
    results.push(...batchResults);
    failures.push(...batchFailures);
    done += batch.length;
    onProgress?.(done, capturedUtterances.length);
  }

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
