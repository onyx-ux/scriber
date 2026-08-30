import { callModel } from './model-client.js';

// "What happened last time?" — the question every session opens with, asked
// out loud, usually by whoever missed the last one.
//
// /campaign recap already answered a DIFFERENT question. It reposts the stored
// tldr, which is written for the vault: past tense, third person, a record of
// a session for somebody reading back through a campaign. That is the right
// thing to keep in a note and the wrong thing to read to a table — nobody
// opens a game night by reciting a summary of themselves.
//
// So the stored notes stay exactly as they are and this rewrites them for the
// room: second person, present-tense stakes, and it stops on the thread that
// is still open, because the point of a recap is to hand the table the thing
// they are about to do something about.
//
// WHAT IT IS ALLOWED TO KNOW
//
// Only the finished notes of the last session — never the transcript, and
// never the campaign's other sessions. Two reasons, and the cheap one is
// second: the notes are a record of what the table WITNESSED, so a recap
// built from them cannot leak something the DM has not shown yet. Feeding it
// the transcript would widen that to every aside anybody made with their mic
// open. Reading one small JSON object also costs a fraction of what /ask does.

export const RECAP_SYSTEM_PROMPT = `You are recapping the previous session of a Dungeons & Dragons game, out loud, to the players at the table who are about to start the next one.

Write it the way a "previously on..." runs before an episode:

- 3 to 5 sentences. Shorter is better. This is spoken aloud, not read.
- Address the party as "you". They were there; do not describe them from outside.
- Present the events as consequence, not inventory. "The kobolds let you pass, for now" beats "The party negotiated with the kobolds."
- Use characters' names where you have them, never the players' real or Discord names.
- END on whatever is still unfinished — the door not opened, the promise not kept, the thing behind them. That is the sentence the table needs.

Hard rules:
- Use ONLY what is in the notes below. Invent nothing: no new NPCs, no motives nobody stated, no foreshadowing the DM has not written.
- Do not speculate about what happens next, and do not ask the table questions.
- No headings, no bullet points, no bold. Plain prose, ready to be read aloud.
- If the notes describe a session that was not really gameplay (a test, a technical night, an aborted start), say that plainly in one sentence instead of inventing a story.`;

// The notes, flattened to the few fields a spoken recap can actually use.
//
// Deliberately not everything that is in the summary: loot lists and funny
// moments are what a vault page is for, and reading them aloud is how a
// 4-sentence recap becomes a 90-second one nobody listens to.
export function buildRecapContext(rawNotes = {}, { characters = [] } = {}) {
  // JSON.parse('null') is null, and a default only covers undefined — a
  // summary column holding the four characters "null" would otherwise throw
  // here rather than degrading to "nothing to say".
  const notes = rawNotes ?? {};
  const lines = [];

  const tldr = String(notes.tldr || '').trim();
  if (tldr) lines.push(`WHAT HAPPENED:\n${tldr}`);

  const list = (label, values) => {
    const items = (Array.isArray(values) ? values : []).map((v) => String(v || '').trim()).filter(Boolean);
    if (items.length) lines.push(`${label}:\n${items.map((i) => `- ${i}`).join('\n')}`);
  };

  list('NEW FACES', notes.npcsIntroduced);
  // The one the recap has to land on, so it is given last and named as such.
  list('STILL UNRESOLVED', notes.unresolvedThreads);

  const names = characters.map((c) => c.character_name ?? c).filter(Boolean);
  if (names.length) lines.push(`THE PARTY (use these names): ${names.join(', ')}`);

  return lines.join('\n\n');
}

// Whether there is enough here to be worth spending a call on.
//
// An empty or apologetic tldr is what the summariser writes for a night that
// was not really a session, and rewriting "this was a microphone test" into
// something to read aloud helps nobody.
export function worthRecapping(notes = {}) {
  return String((notes ?? {}).tldr || '').trim().length >= 40;
}

// `ask` for the role, not `summary`: this is a rephrase of something already
// written, which is exactly the shape /ask has its cheaper model for. Writing
// up three hours of transcript deserves the best model available; turning four
// sentences around does not.
export async function recapForTable({ notes, characters = [], cfg, db = null, meetingId = null, timeoutMs = 60_000, ask = callModel }) {
  const context = buildRecapContext(notes, { characters });
  const text = await ask(RECAP_SYSTEM_PROMPT, context, cfg, timeoutMs, { role: 'ask', db, meetingId });
  return String(text || '').trim();
}
