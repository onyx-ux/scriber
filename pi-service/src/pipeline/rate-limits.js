// What Google lets this key spend, per model, and the pacing that keeps the bot
// under it.
//
// Google reports no remaining quota anywhere — not in a response, not in a
// header — so the only way to stay under a limit is to know it and count. The
// numbers below are the key's own, read off AI Studio's rate-limit page on
// 2026-09-28. RPD was not legible there, so it is left unset (unlimited here)
// until somebody writes it into GEMINI_RATE_LIMITS.
//
// The limit that actually bit was the live transcriber's: 20,000 tokens a
// minute, shared by every speaker's socket. Six speakers streamed at the
// default 4x realtime spend several times that, and the key was refused 30
// seconds into session 32 (26 Sep 2026). The text models' 5 requests a minute
// is the other one worth pacing for: a write-up and the note builders behind
// it are a burst of calls on one model.

// { rpm, tpm, rpd } — any of them null for "no limit known".
export const DEFAULT_LIMITS = {
  'gemini-3.8-flash': { rpm: 5, tpm: 250_000, rpd: null },
  'gemini-3.7-flash': { rpm: 5, tpm: 250_000, rpd: null },
  'gemini-3.6-flash': { rpm: 5, tpm: 250_000, rpd: null },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: null },
  'gemini-3.5-transcribe-live': { rpm: null, tpm: 20_000, rpd: null },
  'gemini-3.8-live-extended-thinking': { rpm: null, tpm: 65_000, rpd: null },
};

// GEMINI_RATE_LIMITS=model=rpm/tpm/rpd,model=rpm/tpm/rpd — an empty or 0 part
// is "no limit". Replaces the default for any model it names.
export function parseLimits(text) {
  const out = {};
  for (const entry of String(text ?? '').split(/[,;\n]/)) {
    const m = /^\s*([^=\s]+)\s*=\s*([\d_]*)\s*\/\s*([\d_]*)\s*(?:\/\s*([\d_]*))?\s*$/.exec(entry);
    if (!m) continue;
    const num = (v) => {
      const n = Number(String(v ?? '').replace(/_/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    out[m[1]] = { rpm: num(m[2]), tpm: num(m[3]), rpd: num(m[4]) };
  }
  return out;
}

export function limitsFor(cfg, model) {
  if (!model) return null;
  const own = cfg?.geminiRateLimits ?? {};
  return own[model] ?? DEFAULT_LIMITS[model] ?? null;
}

// Every model with a known limit, for the gatehouse.
export function allLimits(cfg) {
  return { ...DEFAULT_LIMITS, ...(cfg?.geminiRateLimits ?? {}) };
}

const MINUTE = 60_000;
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

// A sliding one-minute window per model, shared by everything in this process
// that calls it. acquire() waits until a request of that size fits, then books
// it; settle() corrects the booking once the real count is known.
//
// Headroom is kept on purpose. The window here and Google's are not the same
// clock, and anything else using this key — AI Studio in a browser, a probe
// script — spends from the same minute without this process knowing.
export function createRateLimiter({ now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), headroom = 0.85 } = {}) {
  const models = new Map();
  const book = (model) => {
    if (!models.has(model)) models.set(model, { events: [], pausedUntil: 0, day: null, dayCount: 0 });
    return models.get(model);
  };
  const prune = (b, at) => {
    while (b.events.length && b.events[0].at <= at - MINUTE) b.events.shift();
    const day = localDay(at);
    if (b.day !== day) { b.day = day; b.dayCount = 0; }
  };

  // How long until a request of `tokens` fits, or 0 when it fits now.
  function waitFor(b, limits, tokens, at) {
    prune(b, at);
    if (b.pausedUntil > at) return b.pausedUntil - at;
    if (limits.rpm && b.events.length >= limits.rpm) return b.events[0].at + MINUTE - at + 50;
    if (limits.tpm) {
      const budget = limits.tpm * headroom;
      let used = b.events.reduce((n, e) => n + e.tokens, 0);
      // A request bigger than the whole budget still goes, alone, into an
      // empty minute — otherwise it would wait for ever.
      if (used > 0 && used + tokens > budget) {
        for (const e of b.events) {
          used -= e.tokens;
          if (used + tokens <= budget) return e.at + MINUTE - at + 50;
        }
        return b.events[b.events.length - 1].at + MINUTE - at + 50;
      }
    }
    return 0;
  }

  return {
    // Resolves once the request fits, booked. Throws a quota-shaped error when
    // the model's daily allowance is spent, which the model ladder already
    // knows to step down from.
    async acquire(model, { tokens = 0, limits = null, label = '' } = {}) {
      if (!limits) return { settle() {} };
      const b = book(model);
      let waited = 0;
      for (;;) {
        const at = now();
        prune(b, at);
        if (limits.rpd && b.dayCount >= limits.rpd) {
          throw Object.assign(new Error(`RESOURCE_EXHAUSTED: ${model} has used its ${limits.rpd} requests for today`), { status: 429 });
        }
        const ms = waitFor(b, limits, tokens, at);
        if (!ms) break;
        if (!waited) console.log(`[rate] ${label || model}: waiting ${Math.ceil(ms / 1000)}s for room under ${model}'s limits`);
        waited += ms;
        await sleep(Math.min(ms, 5_000));
      }
      const event = { at: now(), tokens };
      b.events.push(event);
      b.dayCount += 1;
      return {
        waitedMs: waited,
        // The real count, once known. Only ever corrects the booking in this
        // window; a request that has aged out is already forgotten.
        settle(actual) {
          if (Number.isFinite(actual) && actual >= 0) event.tokens = actual;
        },
      };
    },

    // Nothing goes to this model until `ms` from now. For a refusal the
    // counting did not see coming — something else spent the minute.
    pause(model, ms) {
      const b = book(model);
      b.pausedUntil = Math.max(b.pausedUntil, now() + ms);
    },

    // The last minute and today, as this process counted them.
    usage(model) {
      const b = book(model);
      prune(b, now());
      return {
        requests: b.events.length,
        tokens: b.events.reduce((n, e) => n + e.tokens, 0),
        today: b.dayCount,
        pausedForMs: Math.max(0, b.pausedUntil - now()),
      };
    },
  };
}

// The one this process shares.
export const rateLimiter = createRateLimiter();

// A request's size before it is sent. Four characters a token is Google's own
// rule of thumb for English; the booking is corrected from the response.
export const estimateTextTokens = (...parts) =>
  Math.ceil(parts.reduce((n, p) => n + String(p ?? '').length, 0) / 4);
