import {
  DND_SUMMARY_PROMPT,
  DND_CHUNK_PROMPT,
  DND_REDUCE_PROMPT,
  buildSummaryUserMessage,
  buildChunkUserMessage,
  buildReduceUserMessage,
} from '../prompts/dnd-summary-prompt.js';
import { callModel, contextTokens } from './model-client.js';

const EMPTY_NOTES = {
  tldr: '',
  scenes: [],
  partyDecisions: [],
  unresolvedThreads: [],
  followUps: [],
  npcsIntroduced: [],
  locationsVisited: [],
  lootAndRewards: [],
  funnyMoments: [],
};

// Rough English-text heuristic. Deliberately pessimistic (real English is
// closer to 4 chars/token) so we under-fill the context rather than overrun
// it — overrunning is silent data loss, under-filling just means one extra
// chunk.
const CHARS_PER_TOKEN = 3.5;
// Headroom inside num_ctx that must stay free for the model's own JSON reply.
const RESERVE_OUTPUT_TOKENS = 1500;
// Extra slack for the user-message header, chat template tokens, and the
// inaccuracy of the estimate above.
const SAFETY_TOKENS = 300;

function estTokens(s) {
  return Math.ceil(String(s).length / CHARS_PER_TOKEN);
}

// How many characters of transcript we can put in one request, given the
// configured provider's context window and the system prompt we're pairing
// with it.
function inputBudgetChars(cfg, systemPrompt) {
  const available = contextTokens(cfg) - estTokens(systemPrompt) - RESERVE_OUTPUT_TOKENS - SAFETY_TOKENS;
  // Never go below a floor — a pathologically small num_ctx shouldn't produce
  // thousands of one-line chunks.
  return Math.max(2000, Math.floor(available * CHARS_PER_TOKEN));
}

// Split on utterance boundaries (newlines) so a speaker's line is never cut
// in half mid-sentence, which would garble both chunks either side of the cut.
function splitTranscript(transcript, maxChars) {
  const lines = transcript.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    // A single utterance longer than the whole budget (rare, but possible if
    // whisper emits one enormous run-on segment) has to be hard-split.
    if (line.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      continue;
    }

    if (current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).filter((v) => v && v.trim());
}

// Models occasionally emit `null` (or a bare string, or an object) where the
// schema asks for an array. Spreading that straight over EMPTY_NOTES used to
// overwrite a good default with null, and the first `.map()` downstream in
// discord-post/markdown would throw — failing the job permanently on an
// otherwise perfectly good summary. Coerce every field to its declared shape.
function normalizeNotes(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    tldr: typeof p.tldr === 'string' ? p.tldr : '',
    scenes: (Array.isArray(p.scenes) ? p.scenes : [])
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        title: typeof s.title === 'string' ? s.title : 'Untitled scene',
        points: asStringArray(s.points),
      })),
    partyDecisions: asStringArray(p.partyDecisions),
    unresolvedThreads: asStringArray(p.unresolvedThreads),
    followUps: (Array.isArray(p.followUps) ? p.followUps : [])
      // Models sometimes emit a placeholder {assignee: null, task: ""} rather
      // than an empty list; those would render as empty checklist bullets.
      .filter((f) => f && typeof f === 'object' && typeof f.task === 'string' && f.task.trim())
      .map((f) => ({ assignee: typeof f.assignee === 'string' ? f.assignee : null, task: f.task })),
    npcsIntroduced: asStringArray(p.npcsIntroduced),
    locationsVisited: asStringArray(p.locationsVisited),
    lootAndRewards: asStringArray(p.lootAndRewards),
    funnyMoments: asStringArray(p.funnyMoments),
  };
}


// How much of a session may be missing before the summary stops being worth
// producing at all. A third is already a lot to lose silently; beyond that the
// remaining slices can easily imply the opposite of what happened.
const MAX_FAILED_SLICE_RATIO = 1 / 3;

// One slice failing to parse shouldn't throw away a whole 4-hour session, so
// retry once and then fall back to an empty partial for that slice only.
async function summarizeChunk(chunk, meta, index, total, cfg, timeoutMs) {
  const userMessage = buildChunkUserMessage(chunk, meta, index, total);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callModel(DND_CHUNK_PROMPT, userMessage, cfg, timeoutMs, { estTokens });
      return { ok: true, partial: normalizeNotes(extractJson(raw)) };
    } catch (err) {
      if (attempt === 2) {
        console.error(`[summarize] slice ${index}/${total} failed after retry: ${err.message}`);
        return { ok: false, partial: { ...EMPTY_NOTES } };
      }
      console.warn(`[summarize] slice ${index}/${total} failed (${err.message}) — retrying once`);
    }
  }
  return { ok: false, partial: { ...EMPTY_NOTES } };
}

// Feed an already-reduced result back in as another "slice note". The reduce
// prompt reads a `narrative` field on each slice, so map tldr across.
function asSliceNote(notes) {
  const { tldr, ...rest } = notes;
  return { narrative: tldr, ...rest };
}

// Group slice notes so each group still fits in one reduce call. Guarantees
// at least two per group so the list always shrinks and we can't loop forever.
function groupToFit(partials, meta, cfg) {
  const budget = inputBudgetChars(cfg, DND_REDUCE_PROMPT);
  const groups = [];
  let current = [];

  for (const partial of partials) {
    const candidate = [...current, partial];
    if (current.length >= 2 && buildReduceUserMessage(candidate, meta).length > budget) {
      groups.push(current);
      current = [partial];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

async function reduceToFinal(partials, meta, cfg, timeoutMs) {
  const budget = inputBudgetChars(cfg, DND_REDUCE_PROMPT);
  let level = partials;

  // Collapse in passes until the whole set fits in a single reduce call.
  for (let pass = 1; pass <= 4; pass++) {
    if (level.length <= 1 || buildReduceUserMessage(level, meta).length <= budget) break;

    const groups = groupToFit(level, meta, cfg);
    if (groups.length >= level.length) break; // no progress possible; let the final call truncate rather than spin

    console.log(`[summarize] reduce pass ${pass}: collapsing ${level.length} slice notes into ${groups.length}`);
    const next = [];
    for (const group of groups) {
      const raw = await callModel(DND_REDUCE_PROMPT, buildReduceUserMessage(group, meta), cfg, timeoutMs, { estTokens });
      next.push(asSliceNote(normalizeNotes(extractJson(raw))));
    }
    level = next;
  }

  const raw = await callModel(DND_REDUCE_PROMPT, buildReduceUserMessage(level, meta), cfg, timeoutMs, { estTokens });
  return normalizeNotes(extractJson(raw));
}

// Throws on any failure — including "PC is off" (connection refused) and
// "PC is on but slow/model still loading" (timeout). Caller (queue-worker)
// is responsible for retry/backoff; this function does not retry itself.
// timeoutMs applies per Ollama request, not to the whole (possibly chunked) job.
export async function summarizeTranscript(transcript, meta, cfg, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const singlePassBudget = inputBudgetChars(cfg, DND_SUMMARY_PROMPT);

  // Short session: one call, exactly as before.
  if (transcript.length <= singlePassBudget) {
    const raw = await callModel(DND_SUMMARY_PROMPT, buildSummaryUserMessage(transcript, meta), cfg, timeoutMs, { estTokens });
    return normalizeNotes(extractJson(raw));
  }

  // Long session: map over slices, then reduce. Without this the tail of the
  // transcript is all the model would ever see.
  const chunks = splitTranscript(transcript, inputBudgetChars(cfg, DND_CHUNK_PROMPT));
  console.log(
    `[summarize] transcript is ${transcript.length} chars — too long for one pass (context=${contextTokens(cfg)} tokens); summarising in ${chunks.length} slices`
  );

  const partials = [];
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { ok, partial } = await summarizeChunk(chunks[i], meta, i + 1, chunks.length, cfg, timeoutMs);
    if (!ok) failed++;
    partials.push(asSliceNote(partial));
    // Only claim success when it actually succeeded — the failure path has
    // already logged its own error above.
    if (ok) console.log(`[summarize] slice ${i + 1}/${chunks.length} done`);
  }

  // A summary built from a minority of the session is not a summary — it is a
  // confident-sounding fabrication. A real 3-hour session once came back as
  // "casual chat / bot testing, not gameplay" because six of its seven slices
  // had failed and the reduce step faithfully summarised the resulting
  // emptiness. Failing here instead sends the job back to the retry queue,
  // which will run it again later (typically once the PC is free), and a late
  // summary beats a wrong one.
  if (failed > chunks.length * MAX_FAILED_SLICE_RATIO) {
    throw new Error(
      `${failed}/${chunks.length} transcript slices failed to summarise — refusing to build a summary from the rest`
    );
  }

  const notes = await reduceToFinal(partials, meta, cfg, timeoutMs);

  // Below the threshold the summary is worth keeping, but the reader still has
  // to know it is incomplete — silence here is what made the bad summary
  // indistinguishable from a good one.
  if (failed > 0) {
    console.warn(`[summarize] ${failed}/${chunks.length} slices failed — final summary may have gaps`);
    const gap = `⚠️ Partial summary — ${failed} of ${chunks.length} sections of this session could not be processed.`;
    notes.tldr = notes.tldr ? `${gap}\n\n${notes.tldr}` : gap;
  }

  return notes;
}

