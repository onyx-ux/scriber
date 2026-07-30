import { transcribeWav } from '../stt/whisper.js';

// capturedUtterances: [{ userId, displayName, wavPath, startMs, endMs }]
// Runs sequentially on purpose — whisper.cpp on a Pi is CPU-bound and
// parallel invocations would fight over the same cores and likely be
// slower overall than one-at-a-time. Revisit if the Pi has cores to spare.
export async function transcribeAll(capturedUtterances, cfg, { onProgress } = {}) {
  const results = [];
  const failures = [];

  for (let i = 0; i < capturedUtterances.length; i++) {
    const u = capturedUtterances[i];
    try {
      const { text } = await transcribeWav(u.wavPath, cfg);
      if (text) {
        results.push({
          userId: u.userId,
          displayName: u.displayName,
          startMs: u.startMs,
          endMs: u.endMs,
          text,
        });
      }
    } catch (err) {
      failures.push({ wavPath: u.wavPath, error: err.message });
      console.error(`[transcribe] failed on ${u.wavPath}: ${err.message}`);
    }
    onProgress?.(i + 1, capturedUtterances.length);
  }

  return { utterances: results, failures };
}

export function buildTranscriptText(utterances) {
  return [...utterances]
    .sort((a, b) => a.start_ms - b.start_ms || a.startMs - b.startMs)
    .map((u) => {
      const ms = u.start_ms ?? u.startMs;
      const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
      const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      const name = u.display_name ?? u.displayName;
      const text = u.text;
      return `[${mm}:${ss}] ${name}: ${text}`;
    })
    .join('\n');
}
