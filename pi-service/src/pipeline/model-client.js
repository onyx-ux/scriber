import Anthropic from '@anthropic-ai/sdk';

// One place that knows how to ask a language model a question, so the
// summariser and /ask don't each carry their own HTTP client.
//
// Audio and transcription are ALWAYS local regardless of provider — this
// only affects the summarising step, which is the one place a bigger model
// measurably improves the result. Choosing 'anthropic' means finished
// transcript text leaves your network; the recordings never do.

const OLLAMA = 'ollama';
const ANTHROPIC = 'anthropic';

// Claude's context window is far larger than this; capping it keeps a single
// request from ballooning, and the slice-and-merge path below stays available
// for genuinely enormous sessions.
const ANTHROPIC_CONTEXT_TOKENS = 180_000;
// Non-streaming ceiling — the SDK warns that larger values risk HTTP timeouts.
const ANTHROPIC_MAX_OUTPUT_TOKENS = 16_000;

let anthropicClient = null;
function getAnthropicClient(cfg) {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: cfg.anthropicApiKey });
  return anthropicClient;
}

// How much input the configured provider can actually take in one request.
export function contextTokens(cfg) {
  return cfg.summaryProvider === ANTHROPIC ? ANTHROPIC_CONTEXT_TOKENS : cfg.ollamaNumCtx;
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

export async function callModel(systemPrompt, userMessage, cfg, timeoutMs, { estTokens } = {}) {
  if (cfg.summaryProvider === ANTHROPIC) {
    return callAnthropic(systemPrompt, userMessage, cfg, timeoutMs);
  }
  return callOllama(systemPrompt, userMessage, cfg, timeoutMs, estTokens);
}

// Used to decide whether to promise an immediate summary or explain that it's
// queued. For Anthropic we deliberately don't burn an API call to find out —
// a configured key is treated as available, and a genuine outage surfaces
// through the normal retry queue instead.
export async function isSummariserReachable(cfg, timeoutMs = 3000) {
  if (cfg.summaryProvider === ANTHROPIC) return Boolean(cfg.anthropicApiKey);

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
  return cfg.summaryProvider === ANTHROPIC ? `Claude (${cfg.anthropicModel})` : `Ollama (${cfg.ollamaModel})`;
}
