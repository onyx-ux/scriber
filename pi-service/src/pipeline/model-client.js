import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { ladderFor, topModel } from './model-choice.js';

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

async function callAnthropic(systemPrompt, userMessage, cfg, timeoutMs, model) {
  // Server-side fallback: if the model declines the request, the API re-runs
  // it on Anthropic's recommended fallback model in the same call rather than
  // handing back a refusal that would fail the whole session summary.
  //
  // .withResponse() rather than the plain call, because the rate-limit headers
  // are the only place either provider tells us how much room is left. Google
  // does not report it at all, so on Gemini "availability" can only ever be
  // what we have counted ourselves — see recordUsage.
  const { data: response, response: http } = await getAnthropicClient(cfg)
    .beta.messages.create(
      {
        model,
        max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      { timeout: timeoutMs }
    )
    .withResponse();

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

  const number = (name) => {
    const raw = http?.headers?.get?.(name);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  return {
    text,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      // What Anthropic says is left, straight from the response.
      remainingTokens: number('anthropic-ratelimit-tokens-remaining'),
      remainingRequests: number('anthropic-ratelimit-requests-remaining'),
      resetsAt: http?.headers?.get?.('anthropic-ratelimit-tokens-reset') ?? null,
    },
  };
}

// Finish reasons that mean Gemini declined or blocked the response rather
// than genuinely running out of room — surfaced as a clear error instead of
// silently returning empty/partial text.
const GEMINI_BLOCKED_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST', 'SPII']);

async function callGemini(systemPrompt, userMessage, cfg, timeoutMs, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await getGeminiClient(cfg).models.generateContent({
      model,
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

    // totalTokenCount is not promptTokenCount + candidatesTokenCount on the
    // flash models: the difference is thinking, which is billed and which the
    // lite models do not do. Recording all three is what makes the difference
    // visible on the dashboard instead of a mystery in the bill.
    const used = response.usageMetadata ?? {};
    return {
      text,
      usage: {
        inputTokens: used.promptTokenCount ?? 0,
        outputTokens: used.candidatesTokenCount ?? 0,
        totalTokens: used.totalTokenCount ?? 0,
        thinkingTokens: used.thoughtsTokenCount ?? null,
        // Google reports no remaining-quota anywhere in the response.
        remainingTokens: null,
      },
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Whether an error means "out of quota" as opposed to "that went wrong".
//
// The distinction decides whether it is worth trying a cheaper model. Being
// rate-limited says nothing about the request, so the same work on a smaller
// model is likely to succeed. A refusal, a timeout or a malformed response
// says something about the request, and re-running it somewhere else spends
// money to fail twice.
export function isQuotaError(err) {
  const status = err?.status ?? err?.code ?? err?.response?.status;
  if (status === 429 || status === 503 || status === 529) return true;

  const message = String(err?.message ?? '');
  return /RESOURCE_EXHAUSTED|rate.?limit|quota|too many requests|overloaded|high demand/i.test(message);
}

// Whether the provider could not be reached at all, as opposed to answering
// badly.
//
// A different question from isQuotaError and it leads somewhere different. Out
// of quota is the provider talking, so a cheaper model of theirs is worth a
// try. Unreachable is nobody talking — the same host, the same DNS, the same
// dead link — and walking down that provider's own ladder is three more ways
// to fail identically. The only move that could work is the other provider.
//
// Node's fetch buries the real reason one level down in `cause`, and the two
// SDKs each have their own name for it, so all three shapes are asked about.
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

export function isProviderUnreachable(err) {
  if (/^(APIConnectionError|APIConnectionTimeoutError|AbortError|TimeoutError|FetchError)$/.test(err?.name ?? '')) {
    return true;
  }
  if (NETWORK_CODES.has(err?.code) || NETWORK_CODES.has(err?.cause?.code)) return true;

  // callGemini turns its own AbortError into a plain Error, so the wording it
  // chose has to be recognised here rather than the name.
  return /timed out|fetch failed|network error|socket hang up/i.test(String(err?.message ?? ''));
}

// The other provider to try when the configured one cannot answer at all.
//
// Both keys being set is already the operator saying they are willing to pay
// either — configuredProviders is the same list the dashboard offers them to
// pick from per job. So crossing over is inside what they have authorised, and
// the alternative is the failure this bot is least willing to hand somebody:
// we recorded your evening and never wrote it up.
//
// It is still a switch, because "willing to pay for either" and "spend the
// other one without asking me" are not quite the same sentence, and the
// operator paying the bill is the one who gets to decide which they meant.
export function fallbackProvider(cfg, current) {
  if (cfg?.summaryProviderFallback === false) return null;
  return configuredProviders(cfg).find((p) => p !== current) ?? null;
}

// Mark an error as "this provider could not answer", which is the only kind
// worth asking somebody else about. The error itself is kept rather than
// wrapped, so the message and the stack still point at what actually broke.
const unavailable = (err) => Object.assign(err, { providerUnavailable: true });

// Ask a model, and step down the ladder if the provider is out of room.
//
// The ladder comes from pipeline/model-choice.js and differs by role: writing
// up a session starts at the best model available, answering a question starts
// at the cheapest that will do. `db` is optional — without it nothing is
// recorded and the call still works, which is what keeps every existing test
// and the injectable-callModel seams in summarize-client working unchanged.
//
// If the whole ladder is exhausted, the OTHER provider gets one attempt — but
// only for a summary. /ask deliberately does not cross over, for the same
// reason its ladder does not climb: a question asked in passing is not worth
// quietly reaching for a second bill, and "ask me again in a bit" is a fine
// answer to one. A session that has already been recorded is not.
export async function callModel(systemPrompt, userMessage, cfg, timeoutMs, options = {}) {
  // `ask` is injectable for the same reason summarize-client's callModel is:
  // the ladder, the crossing over and the recording are the parts worth
  // testing, and none of them should need a live key to exercise. The default
  // is the real thing.
  const { role = 'summary', db = null, meetingId = null, ask = askOnce } = options;
  const first = cfg.summaryProvider === ANTHROPIC ? ANTHROPIC : GEMINI;
  const record = { role, db, meetingId, ask };

  try {
    return await askProvider(first, systemPrompt, userMessage, cfg, timeoutMs, record);
  } catch (err) {
    const other = err?.providerUnavailable && role === 'summary' ? fallbackProvider(cfg, first) : null;
    if (!other) throw err;

    console.warn(
      `[model] ${first} could not answer (${String(err.message).slice(0, 120)}) — trying ${other}`
    );

    try {
      const text = await askProvider(other, systemPrompt, userMessage, cfg, timeoutMs, record);
      console.log(`[model] ${role}: ${other} wrote this one because ${first} was unavailable`);
      return text;
    } catch (second) {
      // Both are down, so report the configured one — that is the provider the
      // operator set up and the one they will go looking for in the log. But a
      // fallback that failed for its OWN reason is saying something about the
      // request rather than about the weather, and that is the more useful of
      // the two errors.
      throw second?.providerUnavailable ? err : second;
    }
  }
}

// One call, to whichever provider was named.
const askOnce = (provider, systemPrompt, userMessage, cfg, timeoutMs, model) =>
  provider === ANTHROPIC
    ? callAnthropic(systemPrompt, userMessage, cfg, timeoutMs, model)
    : callGemini(systemPrompt, userMessage, cfg, timeoutMs, model);

// One provider, top of its ladder down.
async function askProvider(provider, systemPrompt, userMessage, cfg, timeoutMs, { role, db, meetingId, ask }) {
  const pinned = withProvider(cfg, provider);
  const ladder = ladderFor(pinned, role, db);

  let lastError = null;
  for (const [index, model] of ladder.entries()) {
    const startedAt = Date.now();
    try {
      const result = await ask(provider, systemPrompt, userMessage, pinned, timeoutMs, model);

      recordUsage(db, {
        provider, model, role, meetingId, outcome: 'ok',
        ms: Date.now() - startedAt, ...result.usage,
      });

      if (index > 0) {
        console.log(`[model] ${role}: ${ladder[0]} was out of quota, ${model} answered instead`);
      }
      return result.text;
    } catch (err) {
      const limited = isQuotaError(err);
      const unreachable = isProviderUnreachable(err);
      recordUsage(db, {
        provider, model, role, meetingId,
        outcome: limited ? 'rate_limited' : 'failed',
        ms: Date.now() - startedAt,
        error: err.message,
      });

      lastError = err;
      // Nobody is home. A cheaper model of theirs is the same host over the
      // same broken link, so stop walking down and let the caller step across.
      if (unreachable) throw unavailable(err);
      // Only quota sends us down the ladder. Anything else is the request's
      // fault and would fail again, one model cheaper.
      if (!limited) throw err;
      console.warn(`[model] ${model} is out of quota (${err.message.slice(0, 120)})`);
    }
  }

  // Every model this provider has, all out of room. That is a fact about the
  // provider rather than about the request, so it is worth asking the other.
  throw unavailable(lastError ?? new Error('No model was available to answer.'));
}

// Written where it can be counted later, and never allowed to break a call
// that otherwise worked. Metering is not worth failing a session summary over.
function recordUsage(db, entry) {
  try {
    db?.recordModelUsage?.({
      ...entry,
      totalTokens: entry.totalTokens || (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
    });
  } catch (err) {
    console.warn('[model] could not record usage:', err.message);
  }
}

// Used to decide whether to promise an immediate summary or explain that it's
// queued. Deliberately a key check rather than a network call: burning an API
// request on every /leave to ask "are you up?" costs money and still wouldn't
// prove the next call succeeds. A genuine outage surfaces through the retry
// queue, which is what it's for.
export async function isSummariserReachable(cfg) {
  return cfg.summaryProvider === ANTHROPIC ? Boolean(cfg.anthropicApiKey) : Boolean(cfg.geminiApiKey);
}

// Human-readable name for the summariser, for status messages.
//
// Names the model that would actually run rather than the one in the env file:
// the operator can pick a different one on the dashboard, and a message that
// promises Gemini 3.6 while 3.1-flash-lite does the work is a message that
// will be quoted back at somebody.
export function summariserLabel(cfg, db = null) {
  const model = topModel(cfg, 'summary', db) ?? (cfg.summaryProvider === ANTHROPIC ? cfg.anthropicModel : cfg.geminiModel);
  return cfg.summaryProvider === ANTHROPIC ? `Claude (${model})` : `Gemini (${model})`;
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
