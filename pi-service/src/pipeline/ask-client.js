import { DND_ASK_PROMPT, buildAskUserMessage } from '../prompts/ask-prompt.js';

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
export function gatherContext(db, guildId, question, cfg) {
  const summaries = db.listCompletedMeetings(guildId).map((m) => {
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
    for (const row of db.searchUtterances(guildId, word, 12)) {
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
  const budgetTokens = cfg.ollamaNumCtx - estTokens(DND_ASK_PROMPT) - RESERVE_OUTPUT_TOKENS - SAFETY_TOKENS;
  while (excerpts.length > 0 && estTokens(buildAskUserMessage(question, summaries, excerpts)) > budgetTokens) {
    excerpts = excerpts.slice(0, Math.floor(excerpts.length * 0.8));
  }

  return { summaries, excerpts, keywords };
}

export async function askCampaign({ question, summaries, excerpts, cfg, timeoutMs = 5 * 60 * 1000 }) {
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
        options: { num_ctx: cfg.ollamaNumCtx },
        messages: [
          { role: 'system', content: DND_ASK_PROMPT },
          { role: 'user', content: buildAskUserMessage(question, summaries, excerpts) },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const content = data?.message?.content;
    if (!content) throw new Error('Ollama response had no message content');
    return content.trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
