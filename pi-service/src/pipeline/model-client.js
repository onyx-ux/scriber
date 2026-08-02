import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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

// Ollama is called over node:http rather than fetch, deliberately.
//
// Node's fetch (undici) enforces a 300-SECOND headersTimeout that no
// AbortController, option or config value can raise. Ollama does not send
// response headers until it produces its FIRST TOKEN — streaming does not
// change this, it only means the first token arrives sooner than the last —
// and the wait for that first token includes loading the model.
//
// Measured on this setup with qwen2.5:14b at num_ctx 9216:
//   warm model, 3k-token prompt   0.5s to first byte
//   cold model, same prompt       570s to first byte
// A 12GB card with a desktop's worth of apps also holding VRAM has to thrash
// to make room for a 10GB model, and that load is unavoidably on the critical
// path of whichever request triggers it. Every one of those requests died at
// undici's 300s mark, which is how a real 3-hour session came back summarised
// as "casual chat / bot testing, not gameplay" — six of its seven slices had
// been silently lost.
//
// node:http applies no timeout of its own, so the AbortController below is
// the only deadline, which is what the caller already believes it is setting.
function postJsonStream(url, payload, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = Buffer.from(JSON.stringify(payload));

    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      resolve
    );

    // Deliberately no req.setTimeout(): a hidden deadline here is exactly the
    // bug this function exists to avoid.
    req.on('error', reject);

    if (signal) {
      const abort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    req.end(body);
  });
}
// res is a node:http IncomingMessage — an async iterable of Buffers.
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
    for await (const bytes of res) {
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

async function readBody(res) {
  let text = '';
  for await (const bytes of res) text += bytes.toString();
  return text;
}

async function callOllama(systemPrompt, userMessage, cfg, timeoutMs, estTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await postJsonStream(
      `${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`,
      {
        model: cfg.ollamaModel,
        stream: true,
        // Hold the model in VRAM across the whole job. A long transcript is
        // summarised as several sequential slices, and letting the model be
        // evicted between them would pay the (very expensive — see above)
        // cold load again on the next one.
        keep_alive: cfg.ollamaKeepAlive,
        // Without an explicit num_ctx, Ollama uses its own small default
        // (4096, and in practice it truncated a 28k-token transcript down to
        // ~2k) REGARDLESS of what the model actually supports — silently
        // discarding most of the transcript instead of erroring.
        options: { num_ctx: cfg.ollamaNumCtx },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      },
      controller.signal
    );

    if (res.statusCode >= 400) {
      throw new Error(`Ollama returned HTTP ${res.statusCode}: ${(await readBody(res)).slice(0, 200)}`);
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
