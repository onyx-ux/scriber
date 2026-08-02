import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

// One place that knows how to ask a language model a question, so the
// summariser and /ask don't each carry their own HTTP client.
//
// Summarising is the ONLY step that leaves this network. Audio capture and
// transcription are always local (see stt/whisper.js), so the recordings
// themselves never go anywhere — only the finished transcript text does.
//
// A local option (Ollama) used to live here too. It was removed: a 14B model
// on a 12GB card took ~7.5 minutes per transcript slice, roughly an hour for
// a session that Gemini summarises in under a minute, and the quality was not
// close either. The cost of dropping it is that summarising now needs the
// internet — if it's down, jobs queue and retry rather than falling back to
// something local.

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
  return cfg.summaryProvider === ANTHROPIC ? ANTHROPIC_CONTEXT_TOKENS : GEMINI_CONTEXT_TOKENS;
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

export async function callModel(systemPrompt, userMessage, cfg, timeoutMs) {
  return cfg.summaryProvider === ANTHROPIC
    ? callAnthropic(systemPrompt, userMessage, cfg, timeoutMs)
    : callGemini(systemPrompt, userMessage, cfg, timeoutMs);
}

// Used to decide whether to promise an immediate summary or explain that it's
// queued. Deliberately a key check rather than a network call: burning an API
// request on every /leave to ask "are you up?" costs money and still wouldn't
// prove the next call succeeds. A genuine outage surfaces through the retry
// queue, which is what it's for.
export async function isSummariserReachable(cfg) {
  return cfg.summaryProvider === ANTHROPIC ? Boolean(cfg.anthropicApiKey) : Boolean(cfg.geminiApiKey);
}

// Human-readable name for the configured summariser, for status messages.
export function summariserLabel(cfg) {
  return cfg.summaryProvider === ANTHROPIC ? `Claude (${cfg.anthropicModel})` : `Gemini (${cfg.geminiModel})`;
}

export const PROVIDERS = [GEMINI, ANTHROPIC];

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

// Which providers this deployment could actually use right now — both need a
// key, so an unconfigured one is offered to nobody rather than failing later.
export function configuredProviders(cfg) {
  const available = [];
  if (cfg.geminiApiKey) available.push(GEMINI);
  if (cfg.anthropicApiKey) available.push(ANTHROPIC);
  return available;
}
