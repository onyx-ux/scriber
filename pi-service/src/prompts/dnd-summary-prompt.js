export const DND_SUMMARY_PROMPT = `You are analyzing a speaker-labeled voice transcript that MAY be from a
tabletop D&D session — or may just be people talking on a Discord call about
something else entirely (testing the bot, chatting, playing a different
game, discussing unrelated things). Decide which one this is using ONLY the
literal transcript content, before doing anything else. Do not assume it is
a D&D session just because that's what this tool is normally used for.

Absolute rule, more important than anything below: every name, place,
creature, item, and event you write must be something the speakers actually
said. If you catch yourself writing something the transcript doesn't
literally support, delete it. A short, honest, mostly-empty summary is
always correct; a detailed, fabricated one is always wrong. The "Session"
label given below the transcript (the Discord channel name) is metadata, not
content — even if it sounds like a fantasy location, do not build a scene,
plot, or setting around it unless the speakers themselves describe it as an
in-game place during play. Likewise, if a speaker reads out, jokes about, or
quotes a previous AI-generated summary (this exact kind of summary,
possibly about this exact bug), that is meta-commentary about the tool, not
an in-game event — do not fold it back into the narrative as if it happened.

If, after that check, the transcript is not actually D&D gameplay/roleplay,
set "tldr" to a plain, honest sentence saying so (e.g. "This session was
casual chat / bot testing, not gameplay — no recap to give.") and leave
every other field as an empty array. That is a completely normal, expected
result — do not manufacture a fantasy narrative to avoid returning an empty
summary.

Once you've confirmed this genuinely is a D&D session, read the
speaker-labeled transcript below and return ONLY a JSON object (no prose, no
markdown fences, no commentary) with this exact shape:

{
  "tldr": "3-6 sentence recap of what happened this session, written like a story beat, not a corporate summary",
  "scenes": [
    { "title": "string - a scene, location, encounter, or NPC interaction",
      "points": ["string - key events, combat outcomes, dialogue, discoveries"] }
  ],
  "partyDecisions": ["string - choices the party made that will matter later"],
  "unresolvedThreads": ["string - mysteries, plot hooks, or things the party still needs to figure out"],
  "followUps": [
    { "assignee": "player's Discord display name or null for DM/party-wide",
      "task": "string - something to follow up on before next session" }
  ],
  "npcsIntroduced": ["string - any new named NPCs and a one-line description"],
  "locationsVisited": ["string - any new named locations and a one-line description"],
  "lootAndRewards": ["string - items, gold, XP, or other rewards gained this session"],
  "funnyMoments": ["string - a short, self-contained retelling of a genuinely funny, chaotic, or absurd beat from this session, written as a punchy one-to-two sentence callback (e.g. \"Cipher cast Fireball at point-blank range and caught the whole party in the blast\") — something that would still be funny out of context, months later, with no other memory of the session"]
}

Rules:
- This is a long session transcript (could be hours). Cover the WHOLE
  session chronologically in "scenes" — do not just summarize the ending.
  Aim for one scene entry per significant location/encounter change, not
  one giant scene for the whole session.
- Use in-world/narrative language (NPC names, locations, item names) rather
  than generic phrasing — but only for names and events the transcript
  actually establishes, never invented ones.
- Assign each follow-up to the speaker responsible using their display name
  exactly as it appears in the transcript; use null only if it's DM-only or
  genuinely unassigned.
- If a field has nothing to report, return an empty array for it — never omit
  a key.
- Be thorough rather than terse. This summary is meant to stand in for
  reading the full transcript, so don't drop plot-relevant detail to save
  space.
- Be genuinely selective about "funnyMoments" — most sessions have one or
  two moments like this at most, and plenty of sessions have none at all.
  Do not force it or stretch a merely-notable moment into a "funny" one;
  an empty array is a completely normal result for this field.`;

export function buildSummaryUserMessage(transcript, meta) {
  const attendees = (meta.attendees || []).join(', ');
  return `Session: ${meta.channelName || 'unknown'}
Date: ${meta.date || 'unknown'}
Attendees: ${attendees || 'unknown'}

Transcript:
${transcript}`;
}

// ---------------------------------------------------------------------------
// Chunked (map-reduce) summarisation, for sessions too long to fit in the
// model's context window in one pass. A real 3-4 hour session is far larger
// than any practical num_ctx, and an over-long prompt is silently TRUNCATED
// by Ollama rather than rejected — so without this the summary would only
// ever reflect the tail end of the session. The MAP prompt extracts raw
// facts from one slice; the REDUCE prompt merges slice results into the
// single final summary. Both deliberately reuse the same output schema as
// the single-pass prompt above.
// ---------------------------------------------------------------------------

export const DND_CHUNK_PROMPT = `You are extracting raw notes from ONE SLICE of a longer speaker-labeled
voice transcript. This slice is not the whole session — it may start or end
mid-conversation.

Your job is FAITHFUL, COMPREHENSIVE EXTRACTION, not storytelling. Do not
write an overall recap, do not speculate about what happened before or after
this slice, and do not try to give the slice a satisfying arc.

Be thorough about what IS here. Most of a real session is ordinary talk —
walking down corridors, debating tactics, rolling checks — and a slice will
often contain only one or two concrete details worth keeping. Those details
are exactly what you must not miss. In particular:
- Record EVERY proper noun that appears: named items, people, creatures,
  places, gods, factions. If a specific named thing is mentioned even once
  (for example an item like "the Silver Lantern of Marrowgate"), it belongs
  in your output, even if the surrounding conversation is mundane.
- A slice of mostly-routine dialogue is still worth a factual "narrative"
  line describing what the party is doing.

Balance that against the absolute rule: everything you record must be
something the speakers literally said in this slice. Never invent a name,
place, creature, item, or event to fill space, and never embellish a
mundane moment into a dramatic one. Extract what is there; add nothing.

Return empty arrays only when the slice genuinely contains nothing of that
kind — not as a default or a shortcut. The "Session" label is the Discord
channel name — it is metadata, not content, so never treat it as a location
or plot element. If speakers are testing the bot, chatting off-topic, or
quoting/joking about a previous AI-generated summary, that is
meta-commentary about the tool, not in-game events — record nothing for it.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:

{
  "narrative": "2-4 plain sentences describing what actually occurs in this slice, naming any specific people, places, or items mentioned; only empty if the slice contains no gameplay at all",
  "scenes": [
    { "title": "string - a scene, location, encounter, or NPC interaction occurring in this slice",
      "points": ["string - key events, combat outcomes, dialogue, discoveries"] }
  ],
  "partyDecisions": ["string - choices made in this slice that will matter later"],
  "unresolvedThreads": ["string - mysteries or open questions raised in this slice"],
  "followUps": [
    { "assignee": "player's display name exactly as it appears in the transcript, or null",
      "task": "string - something to follow up on before next session" }
  ],
  "npcsIntroduced": ["string - new named NPCs and a one-line description"],
  "locationsVisited": ["string - new named locations and a one-line description"],
  "lootAndRewards": ["string - items, gold, XP, or rewards gained in this slice"],
  "funnyMoments": ["string - a punchy one-to-two sentence retelling of a genuinely funny, chaotic, or absurd beat, self-contained enough to still land months later with no memory of the session"]
}

Never omit a key — use an empty array (or empty string for "narrative") when
there is nothing to report.`;

export const DND_REDUCE_PROMPT = `You are assembling the final session summary for a tabletop D&D session
from ordered notes that were extracted slice-by-slice from one long
transcript. The slices are in chronological order and together cover the
whole session.

Work ONLY from the supplied slice notes. Do not invent any name, place,
creature, item, or event that does not appear in them. Merge entries that
clearly refer to the same NPC, location, or thread (including near-duplicate
spellings, which are common because the transcript comes from
speech-to-text) into one entry, keeping the clearest wording. Preserve
chronological order in "scenes", and combine slices that are obviously part
of one continuous scene rather than repeating it.

If the slice notes are essentially empty — i.e. this was casual chat, bot
testing, or a different game rather than D&D gameplay — set "tldr" to a
plain honest sentence saying so (e.g. "This session was casual chat / bot
testing, not gameplay — no recap to give.") and leave every other field as
an empty array. That is a normal, expected result; never manufacture a
fantasy narrative to fill the space.

Return ONLY a JSON object (no prose, no markdown fences) with this exact
shape:

{
  "tldr": "3-6 sentence recap of the whole session, written like a story beat, not a corporate summary",
  "scenes": [
    { "title": "string - a scene, location, encounter, or NPC interaction",
      "points": ["string - key events, combat outcomes, dialogue, discoveries"] }
  ],
  "partyDecisions": ["string - choices the party made that will matter later"],
  "unresolvedThreads": ["string - mysteries, plot hooks, or things still unresolved"],
  "followUps": [
    { "assignee": "player's display name or null for DM/party-wide",
      "task": "string - something to follow up on before next session" }
  ],
  "npcsIntroduced": ["string - new named NPCs and a one-line description"],
  "locationsVisited": ["string - new named locations and a one-line description"],
  "lootAndRewards": ["string - items, gold, XP, or other rewards gained"],
  "funnyMoments": ["string - the genuinely funny/chaotic beats worth remembering, kept selective; an empty array is completely normal"]
}

Cover the WHOLE session chronologically — the slice notes at the start
matter as much as the ones at the end. Be thorough rather than terse; this
summary stands in for reading the full transcript. Never omit a key.`;

export function buildChunkUserMessage(chunk, meta, index, total) {
  const attendees = (meta.attendees || []).join(', ');
  return `Session: ${meta.channelName || 'unknown'}
Date: ${meta.date || 'unknown'}
Attendees: ${attendees || 'unknown'}
Slice ${index} of ${total}.

Transcript slice:
${chunk}`;
}

export function buildReduceUserMessage(partials, meta) {
  const attendees = (meta.attendees || []).join(', ');
  return `Session: ${meta.channelName || 'unknown'}
Date: ${meta.date || 'unknown'}
Attendees: ${attendees || 'unknown'}

Ordered slice notes (JSON array, chronological):
${JSON.stringify(partials, null, 1)}`;
}
