import { DND_ASK_PROMPT, buildAskUserMessage } from '../prompts/ask-prompt.js';
import { callModel as defaultCallModel, contextTokens } from './model-client.js';
import { allowanceFor } from '../access/tiers.js';

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

// Gathers the campaign context for a question: every session recap (cheap and
// gives the model the through-line) plus transcript lines matching the
// question's distinctive words. Trimmed to fit the context window, dropping
// excerpts first since the recaps are the higher-value signal per token.
export function gatherContext(db, campaignId, question, cfg) {
  const summaries = db.listCompletedMeetings(campaignId).map((m) => {
    let tldr = '';
    try {
      tldr = JSON.parse(m.summary_json || '{}').tldr || '';
    } catch {
      tldr = '';
    }
    return { id: m.id, channel: m.channel_name, date: (m.started_at || '').slice(0, 10), tldr };
  });

  const keywords = extractKeywords(question);
  const byKey = new Map();
  for (const word of keywords) {
    for (const row of db.searchUtterances(campaignId, word, 12)) {
      const key = `${row.meeting_id}:${row.start_ms}:${row.text}`;
      if (byKey.has(key)) continue;
      const totalSec = Math.floor(row.start_ms / 1000);
      byKey.set(key, {
        meetingId: row.meeting_id,
        time: `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`,
        speaker: row.display_name,
        text: row.text,
      });
    }
  }
  let excerpts = [...byKey.values()].sort((a, b) => a.meetingId - b.meetingId || a.time.localeCompare(b.time));

  // Trim to fit: drop excerpts (lowest value per token) until it fits.
  const budgetTokens = contextTokens(cfg) - estTokens(DND_ASK_PROMPT) - RESERVE_OUTPUT_TOKENS - SAFETY_TOKENS;
  while (excerpts.length > 0 && estTokens(buildAskUserMessage(question, summaries, excerpts)) > budgetTokens) {
    excerpts = excerpts.slice(0, Math.floor(excerpts.length * 0.8));
  }

  return { summaries, excerpts, keywords };
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
  cfg,
  db = null,
  timeoutMs = 5 * 60 * 1000,
  callModel = defaultCallModel,
}) {
  const answer = await callModel(
    DND_ASK_PROMPT,
    buildAskUserMessage(question, summaries, excerpts),
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
          'each one costs the person running the bot an API call. It resets at midnight, and `/campaign recap`, ' +
          '`/campaign search` and `/campaign history` are free.',
  };
}
