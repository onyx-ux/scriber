import { DND_SUMMARY_PROMPT, buildSummaryUserMessage } from '../prompts/dnd-summary-prompt.js';

const EMPTY_NOTES = {
  tldr: '',
  scenes: [],
  partyDecisions: [],
  unresolvedThreads: [],
  followUps: [],
  npcsIntroduced: [],
  locationsVisited: [],
  lootAndRewards: [],
};

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeNotes(parsed) {
  return { ...EMPTY_NOTES, ...parsed };
}

// Throws on any failure — including "PC is off" (connection refused) and
// "PC is on but slow/model still loading" (timeout). Caller (queue-worker)
// is responsible for retry/backoff; this function does not retry itself.
export async function summarizeViaOllama(transcript, meta, cfg, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.ollamaModel,
        stream: false,
        messages: [
          { role: 'system', content: DND_SUMMARY_PROMPT },
          { role: 'user', content: buildSummaryUserMessage(transcript, meta) },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const data = await res.json();
    const content = data?.message?.content;
    if (!content) throw new Error('Ollama response had no message content');

    return normalizeNotes(extractJson(content));
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    // fetch's connection-refused error message differs by platform; surface it as-is,
    // the queue worker doesn't need to distinguish "PC off" from other network errors,
    // it retries either way.
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Quick reachability check, used by a "/summarize" command to give the user
// an immediate yes/no instead of silently enqueueing when they can see the
// PC is clearly off.
export async function isOllamaReachable(cfg, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
