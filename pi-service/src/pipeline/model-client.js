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
        stream: false,
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

    const data = await res.json();
    const content = data?.message?.content;
    if (!content) throw new Error('Ollama response had no message content');

    // If Ollama still had to truncate, say so loudly rather than quietly
    // returning a summary of only part of the input.
    if (estTokens) {
      const sent = estTokens(systemPrompt) + estTokens(userMessage);
      if (data.prompt_eval_count && sent > data.prompt_eval_count * 1.5) {
        console.warn(
          `[model] possible context truncation: sent ~${sent} est. tokens, Ollama evaluated ${data.prompt_eval_count} (num_ctx=${cfg.ollamaNumCtx})`
        );
      }
    }

    return content;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`);
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
