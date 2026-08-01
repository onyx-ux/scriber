import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

// One place that knows how to ask a language model a question, so the
// summariser and /ask don't each carry their own HTTP client.
//
// Audio and transcription are ALWAYS local regardless of provider — this
// only affects the summarising step, which is the one place a bigger model
// measurably improves the result. Choosing 'anthropic'/'gemini' means finished
// transcript text leaves your network; the recordings never do.

const OLLAMA = 'ollama';
const ANTHROPIC = 'anthropic';
const GEMINI = 'gemini';

// Claude's context window is far larger than this; capping it keeps a single
// request from ballooning, and the slice-and-merge path below stays available
// for genuinely enormous sessions.
const ANTHROPIC_CONTEXT_TOKENS = 180_000;
// Non-streaming ceiling — the SDK warns that larger values risk HTTP timeouts.
const ANTHROPIC_MAX_OUTPUT_TOKENS = 16_000;

// Same reasoning as the Anthropic cap above, just against Gemini's (much
// larger) advertised window — this is a request-size cap, not the model's
// actual limit, so the slice-and-merge path still covers oversized sessions.
const GEMINI_CONTEXT_TOKENS = 180_000;
const GEMINI_MAX_OUTPUT_TOKENS = 16_000;

let anthropicClient = null;
function getAnthropicClient(cfg) {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: cfg.anthropicApiKey });
  return anthropicClient;
}

let geminiClient = null;
function getGeminiClient(cfg) {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
  return geminiClient;
}

// How much input the configured provider can actually take in one request.
export function contextTokens(cfg) {
  if (cfg.summaryProvider === ANTHROPIC) return ANTHROPIC_CONTEXT_TOKENS;
  if (cfg.summaryProvider === GEMINI) return GEMINI_CONTEXT_TOKENS;
  return cfg.ollamaNumCtx;
}

// Ollama is asked to stream, and it matters more than it looks.
//
// With stream:false, Ollama withholds the response headers until the entire
// generation has finished. Node's fetch (undici) applies a 300-SECOND default
// headersTimeout that no AbortController or config value can raise, so every
// summary taking longer than five minutes died as an opaque "fetch failed" —
// long before the 20-minute timeout this function is handed. On a contended
// GPU, or whenever a request forces Ollama to reload the model at a larger
// num_ctx, five minutes is easy to exceed.
//
// Streaming makes the headers arrive immediately and every token chunk resets
// undici's idle timer, so the AbortController below becomes the only deadline
// that actually applies — which is what the caller expects.
async function readOllamaStream(res, controller) {
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let final = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const chunk = JSON.parse(trimmed);
    // Ollama reports mid-stream problems as a JSON field, not an HTTP status —
    // the response is already a 200 by then.
    if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
    if (chunk.message?.content) content += chunk.message.content;
    // The terminating chunk carries the token accounting (prompt_eval_count).
    if (chunk.done) final = chunk;
  };

  let finished = false;
  try {
    for await (const bytes of res.body) {
      buffered += decoder.decode(bytes, { stream: true });

      // Chunks split at arbitrary byte boundaries, so the last line of a chunk
      // is usually incomplete — keep it buffered until its newline arrives.
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    handleLine(buffered);
    finished = true;
  } finally {
    // If we bailed out mid-stream (a JSON parse failure, an error chunk), the
    // response is still open and Ollama is still generating into it — cancel
    // so the socket and the GPU work are both released.
    if (!finished) controller.abort();
  }

  return { content, final };
}

async function callOllama(systemPrompt, userMessage, cfg, timeoutMs, estTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.ollamaModel,
        stream: true,
        // Without an explicit num_ctx, Ollama uses its own small default
        // (4096, and in practice it truncated a 28k-token transcript down to
        // ~2k) REGARDLESS of what the model actually supports — silently
        // discarding most of the transcript instead of erroring.
        options: { num_ctx: cfg.ollamaNumCtx },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const { content, final } = await readOllamaStream(res, controller);
    if (!content) throw new Error('Ollama response had no message content');

    // If Ollama still had to truncate, say so loudly rather than quietly
    // returning a summary of only part of the input.
    if (estTokens && final) {
      const sent = estTokens(systemPrompt) + estTokens(userMessage);
      if (final.prompt_eval_count && sent > final.prompt_eval_count * 1.5) {
        console.warn(
          `[model] possible context truncation: sent ~${sent} est. tokens, Ollama evaluated ${final.prompt_eval_count} (num_ctx=${cfg.ollamaNumCtx})`
        );
      }
    }

    return content;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    // Node collapses every transport-level failure into the word "fetch
    // failed" and hides the real reason in `cause` — the difference between
    // "the PC is off" (ECONNREFUSED) and "it took too long" matters here, and
    // this message is what gets stored as the job's last_error.
    if (err.cause?.code || err.cause?.message) {
      throw new Error(`${err.message} (${err.cause.code || err.cause.message})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(systemPrompt, userMessage, cfg, timeoutMs) {
  // Server-side fallback: if the model declines the request, the API re-runs
  // it on Anthropic's recommended fallback model in the same call rather than
  // handing back a refusal that would fail the whole session summary.
  const response = await getAnthropicClient(cfg).beta.messages.create(
    {
      model: cfg.anthropicModel,
      max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    },
    { timeout: timeoutMs }
  );

  // Must be checked before reading content — a refusal returns HTTP 200 with
  // empty or partial content, so indexing content[0] blindly would break.
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined this request (${response.stop_details?.category ?? 'unspecified'})`
    );
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text.trim()) throw new Error('Claude response contained no text');
  return text;
}

// Finish reasons that mean Gemini declined or blocked the response rather
// than genuinely running out of room — surfaced as a clear error instead of
// silently returning empty/partial text.
const GEMINI_BLOCKED_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST', 'SPII']);

async function callGemini(systemPrompt, userMessage, cfg, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await getGeminiClient(cfg).models.generateContent({
      model: cfg.geminiModel,
      contents: userMessage,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && GEMINI_BLOCKED_REASONS.has(finishReason)) {
      throw new Error(`Gemini declined this request (${finishReason})`);
    }

    const text = response.text;
    if (!text?.trim()) throw new Error('Gemini response contained no text');
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(systemPrompt, userMessage, cfg, timeoutMs, { estTokens } = {}) {
  if (cfg.summaryProvider === ANTHROPIC) {
    return callAnthropic(systemPrompt, userMessage, cfg, timeoutMs);
  }
  if (cfg.summaryProvider === GEMINI) {
    return callGemini(systemPrompt, userMessage, cfg, timeoutMs);
  }
  return callOllama(systemPrompt, userMessage, cfg, timeoutMs, estTokens);
}

// Used to decide whether to promise an immediate summary or explain that it's
// queued. For Anthropic we deliberately don't burn an API call to find out —
// a configured key is treated as available, and a genuine outage surfaces
// through the normal retry queue instead.
export async function isSummariserReachable(cfg, timeoutMs = 3000) {
  if (cfg.summaryProvider === ANTHROPIC) return Boolean(cfg.anthropicApiKey);
  if (cfg.summaryProvider === GEMINI) return Boolean(cfg.geminiApiKey);

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

// Human-readable name for the configured summariser, for status messages.
export function summariserLabel(cfg) {
  if (cfg.summaryProvider === ANTHROPIC) return `Claude (${cfg.anthropicModel})`;
  if (cfg.summaryProvider === GEMINI) return `Gemini (${cfg.geminiModel})`;
  return `Ollama (${cfg.ollamaModel})`;
}

export const PROVIDERS = [OLLAMA, ANTHROPIC, GEMINI];

export function isValidProvider(name) {
  return PROVIDERS.includes(name);
}

// A copy of cfg pinned to one specific provider, for running a single job on
// something other than SUMMARY_PROVIDER. Returns cfg unchanged for a null or
// unrecognised name, so a stale/hand-edited value in the database degrades to
// "use the configured default" rather than breaking the job.
export function withProvider(cfg, provider) {
  if (!provider || !isValidProvider(provider)) return cfg;
  return { ...cfg, summaryProvider: provider };
}

// Which providers this deployment could actually use right now. Ollama is
// always listed (it needs no key — it may still be unreachable, which is a
// separate runtime question answered by isSummariserReachable); the cloud
// ones only count as usable once their key is set.
export function configuredProviders(cfg) {
  const available = [OLLAMA];
  if (cfg.anthropicApiKey) available.push(ANTHROPIC);
  if (cfg.geminiApiKey) available.push(GEMINI);
  return available;
}
