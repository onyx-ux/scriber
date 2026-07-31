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
