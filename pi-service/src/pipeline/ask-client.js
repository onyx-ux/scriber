import { DND_ASK_PROMPT, buildAskUserMessage } from '../prompts/ask-prompt.js';
import { callModel as defaultCallModel, contextTokens } from './model-client.js';
import { allowanceFor } from '../access/tiers.js';
import { correctedWriteUp } from '../web/notes-view.js';
import { expandTerms } from '../campaign/lookup.js';

const CHARS_PER_TOKEN = 3.5;
const RESERVE_OUTPUT_TOKENS = 800;
const SAFETY_TOKENS = 300;

// Words too common to be worth searching transcripts for — searching "the"
// would return the entire campaign and crowd out the useful matches.
const STOPWORDS = new Set([
  'the','and','was','were','what','when','where','who','whom','why','how','did','does','do','is','are','has','have','had',
  'that','this','they','them','their','there','then','than','with','from','into','onto','about','for','you','your','our',
  'we','us','it','its','his','her','him','she','he','a','an','of','to','in','on','at','by','or','if','as','be','been',
  'can','could','would','should','will','shall','may','might','get','got','say','said','tell','told','any','all','some',
  'happen','happened','again','ever','last','time','first','know','knew','see','saw','go','went','come','came','make','made',
]);

export function extractKeywords(question, max = 6) {
  const seen = new Set();
  const words = String(question)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  const unique = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    unique.push(w);
  }
  // Longer words are usually the distinctive ones (proper nouns, item names).
  return unique.sort((a, b) => b.length - a.length).slice(0, max);
}

function estTokens(s) {
  return Math.ceil(String(s).length / CHARS_PER_TOKEN);
}

// Never more than this much context per question, whatever the model allows.
// A question is asked in passing and paid for out of the owner's budget; at
// Flash-Lite prices 60k tokens is well under a cent, and it holds dozens of
// whole write-ups.
const ASK_MAX_CONTEXT_TOKENS = 60_000;

const clock = (ms) => {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Gathers the campaign context for a question.
//
//   * Every completed session's whole write-up, as the table has corrected
//     it: the recap, the scenes, the decisions and what was left open. It
//     used to be the one-line recap alone, which dropped most of what a
//     question is about.
//   * Transcript lines found through the ranked index, searching for the
//     question's distinctive words AND every spelling of any name it mentions
//     (names come from the vault's entity notes; see campaign/lookup.js).
//   * Those names, so the model knows "Use Drail" and "Yusdrayl" are one
//     person.
//
// Everything is labelled with the session number the table uses. It used to
// be the meeting id, which made the model cite "session #32" for a table's
// fifth night.
//
// Trimmed to fit, least valuable first: excerpts beyond the best, then the
// scene detail of the oldest sessions, then the oldest sessions altogether.
export function gatherContext(db, campaignId, question, cfg, { names = [] } = {}) {
  const summaries = db.listCompletedMeetings(campaignId).map((m) => {
    const notes = correctedWriteUp(db, m.id) ?? {};
    return {
      session: m.session_number ?? m.id,
      date: (m.started_at || '').slice(0, 10),
      tldr: notes.tldr || '',
      scenes: (notes.scenes ?? []).map((s) => ({ title: s.title, points: s.points ?? [] })),
      decisions: notes.partyDecisions ?? [],
      threads: notes.unresolvedThreads ?? [],
    };
  });

  const keywords = extractKeywords(question);
  const { terms, matched } = expandTerms(question, names);
  const rows = db.searchUtterancesRanked(campaignId, [...terms, ...keywords], 60);
  let excerpts = rows.map((row) => ({
    session: row.session_number ?? row.meeting_id,
    ms: row.start_ms,
    time: clock(row.start_ms),
    speaker: row.display_name,
    text: row.text,
  }));
  const inOrder = (list) => [...list].sort((a, b) => a.session - b.session || a.ms - b.ms);

  const budget =
    Math.min(contextTokens(cfg ?? {}), ASK_MAX_CONTEXT_TOKENS) - estTokens(DND_ASK_PROMPT) - RESERVE_OUTPUT_TOKENS - SAFETY_TOKENS;
  const size = () => estTokens(buildAskUserMessage(question, summaries, inOrder(excerpts), matched));

  // The ranked order is best first, so trimming keeps the best matches.
  while (excerpts.length > 10 && size() > budget) excerpts = excerpts.slice(0, Math.floor(excerpts.length * 0.8));
  for (const s of summaries) {
    if (size() <= budget) break;
    s.scenes = [];
    s.decisions = [];
    s.threads = [];
  }
  while (summaries.length > 1 && size() > budget) summaries.shift();
  while (excerpts.length > 0 && size() > budget) excerpts = excerpts.slice(0, Math.floor(excerpts.length * 0.8));

  return { summaries, excerpts: inOrder(excerpts), keywords, names: matched };
}

// callModel is injectable so the grounding/context-trimming logic can be
// tested without standing up a provider; the default is the real thing.
//
// The `ask` role is what routes this to a cheap model rather than the
// summariser's — see pipeline/model-choice.js for the measured reason.
export async function askCampaign({
  question,
  summaries,
  excerpts,
  names = [],
  cfg,
  db = null,
  timeoutMs = 5 * 60 * 1000,
  callModel = defaultCallModel,
}) {
  const answer = await callModel(
    DND_ASK_PROMPT,
    buildAskUserMessage(question, summaries, excerpts, names),
    cfg,
    timeoutMs,
    { role: 'ask', db }
  );
  return answer.trim();
}

// Whether this person has any questions left today.
//
// /campaign ask is the only place in the bot where somebody who is not the
// owner can spend the owner's API budget. It had no ceiling at all, which was
// fine for one table of friends and is not a property worth keeping.
//
// The ceiling is the asker's TIER now rather than one number for everybody.
// With TIER_ASK_LIMITS unset every tier is worth ASK_DAILY_LIMIT, so this is
// the same twenty questions it always was until somebody decides otherwise.
// See access/tiers.js.
//
// Counted before the call rather than after, so a question that fails still
// costs a slot — otherwise a failing model is an unlimited one.
export function askAllowance(db, cfg, userId) {
  const { tier, askLimit } = allowanceFor(db, cfg, userId);
  const limit = Number(askLimit) || 0;
  if (!limit || limit <= 0) return { allowed: true, tier, limit: 0, used: 0, left: Infinity };

  const used = db?.countAsksToday?.(userId) ?? 0;
  const left = Math.max(0, limit - used);

  return {
    allowed: left > 0,
    tier,
    limit,
    used,
    left,
    message:
      left > 0
        ? null
        : `You have asked ${limit} question${limit === 1 ? '' : 's'} today, which is the daily limit — ` +
          'each one costs the person running the bot an API call. It resets at midnight, and `/campaign recap` ' +
          'and `/campaign search` are free.',
  };
}
