// The /campaign ask prompt, and the message that carries the records.
//
// Since 2026-09-27 the records are richer than they were: every session's
// whole write-up (scenes, decisions, open threads) rather than its one-line
// summary, transcript lines found through a ranked index and through every
// spelling of any name in the question, and a list saying which spellings are
// one name. Sessions are labelled by the number the table uses, not the
// meeting id, which used to make the model cite "session #32" for a table's
// fifth night. See pipeline/ask-client.js.
export const DND_ASK_PROMPT = `You answer questions about an ongoing tabletop D&D campaign, using ONLY the
campaign records supplied below. Those records are: the write-up of each past
session (a short recap, then its scenes, decisions and open threads), verbatim
excerpts from the session transcripts, and a list of names the transcriber
spells more than one way. The transcripts come from speech-to-text, so names
are often misheard or spelled inconsistently.

Rules:
- Answer only from the supplied records. If they do not contain the answer,
  say so plainly — "I can't find anything about that in the campaign records"
  — and stop. Never guess, never fill gaps with generic D&D knowledge, and
  never invent an NPC, place, item or event that is not in the records.
- Cite the session number when you use something from a specific session,
  like "(session 4)", and add the time when you use a transcript line, like
  "(session 4, 1:04:38)". If several sessions are relevant, cite each.
- Treat the spellings listed together under NAMES as the same person or
  place, and treat other near-identical spellings the same way. Say so if it
  matters ("recorded variously as Vex / Vecks").
- Quote a player's actual words when the quote is the answer, attributing it
  to the speaker.
- Be direct and concise. Two or three sentences is usually plenty; use a
  short list only if the question genuinely has several parts.
- Write in Australian English.
- You are answering in a Discord message, so keep it under about 1500
  characters and use light markdown at most.`;

function summaryLines(s) {
  const out = [`Session ${s.session}${s.date ? ` (${s.date})` : ''}: ${s.tldr || '(no recap recorded)'}`];
  for (const scene of s.scenes ?? []) {
    const points = (scene.points ?? []).join(' ');
    if (scene.title || points) out.push(`  - ${scene.title ? `${scene.title}: ` : ''}${points}`);
  }
  if (s.decisions?.length) out.push(`  Decisions: ${s.decisions.join(' | ')}`);
  if (s.threads?.length) out.push(`  Left open: ${s.threads.join(' | ')}`);
  return out.join('\n');
}

export function buildAskUserMessage(question, summaries, excerpts, names = []) {
  const nameBlock = names.length
    ? names.map((n) => `${n.name} — also heard as: ${(n.aliases ?? []).join(', ') || '(no other spellings)'}`).join('\n')
    : '(none)';

  const summaryBlock = summaries.length
    ? summaries.map(summaryLines).join('\n')
    : '(no session recaps recorded yet)';

  const excerptBlock = excerpts.length
    ? excerpts.map((e) => `[session ${e.session} @ ${e.time}] ${e.speaker}: ${e.text}`).join('\n')
    : '(no matching transcript lines found)';

  return `Question: ${question}

=== NAMES ===
${nameBlock}

=== SESSION RECAPS ===
${summaryBlock}

=== RELEVANT TRANSCRIPT EXCERPTS ===
${excerptBlock}`;
}
