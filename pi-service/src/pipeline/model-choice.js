// Which model to ask, for what.
//
// Everything used to run on one: SUMMARY_PROVIDER's model wrote the session
// notes and also answered /campaign ask. Those are not the same job.
//
// Writing up three hours of transcript is the thing the bot exists to do well,
// and it is worth the best model available. Answering "who was the notary
// again" is a lookup over recaps that have already been written — the hard
// work happened when the notes were made. Measured against a real key on
// 2026-08-18, a seven-token prompt costs 109 total tokens on gemini-3.6-flash
// and 8 on gemini-3.1-flash-lite, because the flash models emit thinking
// tokens whether or not the question needs any. Thirteen times the spend, for
// a lookup.
//
// So there are two ROLES and a LADDER under each. The ladder is walked only
// when the provider says it is out of quota — never on an ordinary failure,
// because a refusal or a timeout is not a reason to pay a second model to do
// the same work.

export const ROLES = ['summary', 'ask'];

// Defaults, all probed against a live key on 2026-08-18 rather than read off a
// list. The existing note in config/env.js is worth repeating: ListModels lies
// in both directions here — gemini-3.6-flash used to serve requests while
// missing from the list, and gemini-3.1-flash exists in neither.
//
// Deliberately pinned names rather than the -latest aliases. Google moves the
// cheap tier under you (2.5-flash-lite was cut off from new keys, then 3.1
// replaced it); a pinned name that disappears fails loudly on the next call,
// where an alias quietly changes what you are paying for and how it writes.
const DEFAULTS = {
  gemini: {
    summary: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
    ask: 'gemini-3.1-flash-lite',
  },
  anthropic: {
    summary: ['claude-sonnet-5'],
    ask: 'claude-haiku-4-5',
  },
};

const list = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// The operator's own choice, if they have made one on the dashboard.
//
// Settings beat env on purpose: the env file needs a redeploy to change and
// the dashboard does not, and the reason to switch models is usually that
// something is failing right now.
const chosen = (db, key) => {
  try {
    return db?.getSetting?.(key) || null;
  } catch {
    return null;
  }
};

// The top model for a role — what the dashboard shows as "currently using".
export function topModel(cfg, role, db = null) {
  return ladderFor(cfg, role, db)[0] ?? null;
}

// Every model this role may use, best first.
//
// Summary starts at the configured model and falls back through cheaper ones.
// Ask starts cheap and does not climb: if the lite model is out of quota, the
// honest answer is to wait rather than to quietly spend ten times as much on
// a question somebody asked in passing.
export function ladderFor(cfg, role, db = null) {
  const provider = cfg?.summaryProvider === 'anthropic' ? 'anthropic' : 'gemini';
  const fallback = DEFAULTS[provider];

  if (role === 'ask') {
    const picked =
      chosen(db, 'model_ask') ||
      (provider === 'anthropic' ? cfg?.anthropicAskModel : cfg?.geminiAskModel) ||
      fallback.ask;
    // One cheap model, then the summary ladder's cheapest as a last resort —
    // so /ask still answers when the lite tier is exhausted, at a known cost.
    const cheapestSummary = summaryLadder(cfg, db, provider).at(-1);
    return dedupe([picked, cheapestSummary]);
  }

  return summaryLadder(cfg, db, provider);
}

function summaryLadder(cfg, db, provider) {
  const top =
    chosen(db, 'model_summary') ||
    (provider === 'anthropic' ? cfg?.anthropicModel : cfg?.geminiModel);

  const configured =
    provider === 'anthropic' ? list(cfg?.anthropicModelFallbacks) : list(cfg?.geminiModelFallbacks);

  const rest = configured.length ? configured : DEFAULTS[provider].summary;
  return dedupe([top, ...rest]);
}

const dedupe = (models) => [...new Set(models.filter(Boolean))];

// Every model this install might use, for the dashboard's selector. Not a
// catalogue of what the provider offers — a bot cannot know that without
// asking, and asking on every page load would spend a request to render a
// dropdown.
export function knownModels(cfg, db = null) {
  return dedupe([...ladderFor(cfg, 'summary', db), ...ladderFor(cfg, 'ask', db)]);
}
