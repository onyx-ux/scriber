// Builds one Obsidian note per PLAYER CHARACTER from the full transcripts.
//
// The NPC extractor is explicitly told the party are not NPCs, so the people
// the campaign is actually about were the only cast with no notes at all.
// They also need a different shape: an NPC note answers "who is this and what
// do they want", a PC note answers "who plays them, what are they, and what
// have they done so far".
//
// The hard part is that a PC is known by at least two names. The transcript
// is labelled with the DISCORD SPEAKER ("Brett"), while the table calls the
// character something else entirely ("BenTen"), and whisper spells both
// several ways. Both have to end up as aliases or half the mentions in the
// vault link to nothing.
import { npcKey, parseEntityList } from './npc-extract.js';

export const CHARACTER_SYSTEM_PROMPT = `You are a meticulous D&D campaign archivist.

You will be given the RAW TRANSCRIPT of one session, exactly as spoken. It is
automatic speech-to-text: names are often misheard, sentences are broken, and
players talk over each other. Read past that.

Extract the PLAYER CHARACTERS — the adventuring party. You will be given the
roster: which speaker plays which character, and which speaker is the DM.

RULES
- One entry per player character on the roster. Do not add entries for the DM,
  for NPCs, or for characters not on the roster.
- A speaker label in the transcript is the PLAYER, not necessarily the
  character. Record the character's name as the name, and put the speaker
  label in "player".
- aliases must contain every spelling the transcript actually uses for this
  character, including the speaker label, obvious mis-hearings, and any short
  form the table uses. This is what makes existing links keep working, so be
  generous here rather than tidy.
- Only include what this transcript supports. Never carry in knowledge of
  published D&D modules or of typical builds for a class. If the transcript
  does not say someone's level, omit level.
- Quotes must be copied verbatim. Prefer lines that show how the character
  talks or a moment the table reacted to. If nothing is clean enough, leave
  quotes empty.
- notableMoments are what the CHARACTER did in the fiction — not what the
  player said about dice or rules.

Return ONLY a JSON object of this shape, with no prose and no code fence:

{
  "characters": [
    {
      "name": "Aurion",
      "player": "Aurion",
      "aliases": ["Orion", "Aurian"],
      "race": "Dragonborn",
      "class": "Paladin",
      "level": null,
      "deity": "Bahamut",
      "description": "2-4 sentences on who they are and how they play.",
      "goal": "What this character is after, in their own terms.",
      "relationships": [{ "who": "Meepo", "how": "Vouched for him with the party." }],
      "notableMoments": ["What they actually did this session."],
      "quotes": ["A verbatim line, if there is a clean one."],
      "hooks": ["Threads left open that are specifically theirs."],
      "status": "alive | dead | unknown"
    }
  ]
}

Omit any field you have no evidence for. Return {"characters": []} if the
transcript has none.`;

export function buildCharacterUserMessage({ transcript, sessionNumber, date, roster = [], dm = null, existingNames = [] }) {
  const lines = [`SESSION ${sessionNumber}${date ? ` (${date})` : ''}`];

  lines.push(
    'ROSTER (speaker -> character):',
    ...roster.map((r) => `  ${r.player} -> ${r.character || '(character name unknown — find it in the transcript)'}`)
  );
  if (dm) lines.push(`DM (not a player character): ${dm}`);

  // Same reason as the NPC extractor: the vault already links these
  // spellings, and an extraction that renames a character without carrying
  // the old spelling into aliases silently orphans every existing link.
  if (existingNames.length) {
    lines.push(`NAMES ALREADY USED IN THIS CAMPAIGN'S NOTES: ${existingNames.join(', ')}`);
  }

  lines.push('', 'TRANSCRIPT:', transcript);
  return lines.join('\n');
}

export function parseCharacterResponse(text) {
  return parseEntityList(text, 'characters');
}

const uniq = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v.trim()))];

// Which roster slot an extracted record belongs to. Tried in order of how
// much the match can be trusted: the player field the model was told to fill,
// then the character name we were given, then any spelling of either.
function rosterSlot(pc, roster) {
  const keys = [pc.name, pc.player, ...(pc.aliases || [])].filter(Boolean).map(npcKey);

  return (
    roster.find((r) => npcKey(r.player) === npcKey(pc.player)) ||
    roster.find((r) => r.character && keys.includes(npcKey(r.character))) ||
    roster.find((r) => keys.includes(npcKey(r.player))) ||
    null
  );
}

// Merged on the PLAYER, not the name.
//
// The NPC merge keys on the name because that is all an NPC has. A player
// character has something better: one player plays one character all campaign,
// and the roster fixes who that is. Keying on the name instead produced two
// notes for the same person whenever the model read the transcript
// differently between sessions — "Orion" in session 1 and "Aurion" in session
// 2, "Tad" and "Thaddeus Leopard Archibald" — which is exactly the case a
// speech-to-text transcript makes common rather than rare.
//
// Facts that change take the latest session; facts that accumulate append. A
// character who levels up in session 4 should not read as level 1 because
// session 2 said so. A name the model used in an earlier session is kept as
// an alias, because the session recaps written at the time used it.
export function mergeCharacters(perSession, roster = []) {
  const byKey = new Map();
  const unmatched = [];

  for (const { sessionNumber, characters } of perSession) {
    for (const pc of characters) {
      const slot = roster.length ? rosterSlot(pc, roster) : null;
      if (roster.length && !slot) {
        unmatched.push({ sessionNumber, name: pc.name });
        continue;
      }
      const key = slot ? npcKey(slot.player) : npcKey(pc.name);
      if (!key) continue;

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          name: pc.name.trim(),
          player: pc.player || null,
          aliases: uniq(pc.aliases || []),
          race: pc.race || null,
          class: pc.class || null,
          level: pc.level ?? null,
          deity: pc.deity || null,
          status: pc.status || 'alive',
          description: pc.description || '',
          goal: pc.goal || '',
          relationships: pc.relationships || [],
          sessions: [sessionNumber],
          notableMoments: (pc.notableMoments || []).map((m) => ({ session: sessionNumber, text: m })),
          quotes: (pc.quotes || []).map((q) => ({ session: sessionNumber, text: q })),
          hooks: (pc.hooks || []).map((h) => ({ session: sessionNumber, text: h })),
        });
        continue;
      }

      existing.sessions = uniq([...existing.sessions.map(String), String(sessionNumber)])
        .map(Number)
        .sort((a, b) => a - b);
      existing.aliases = uniq([...existing.aliases, ...(pc.aliases || [])]);

      // A later session's name wins — the table settles on a fuller name as
      // the campaign goes on ("Tad" becoming "Thaddeus Leopard Archibald").
      // The earlier one becomes an alias rather than being dropped: the
      // session recaps written at the time used it, and those links have to
      // keep resolving.
      if (pc.name && npcKey(pc.name) !== npcKey(existing.name)) {
        existing.aliases = uniq([...existing.aliases, existing.name]);
        existing.name = pc.name.trim();
      }

      if (pc.player) existing.player = pc.player;
      if (pc.status) existing.status = pc.status;
      if (pc.level != null) existing.level = pc.level;
      if (pc.deity) existing.deity = pc.deity;
      if (pc.race && !existing.race) existing.race = pc.race;
      if (pc.class && !existing.class) existing.class = pc.class;
      if (pc.goal) existing.goal = pc.goal;
      if ((pc.description || '').length > existing.description.length) existing.description = pc.description;

      for (const r of pc.relationships || []) {
        if (!existing.relationships.some((e) => npcKey(e.who) === npcKey(r.who))) existing.relationships.push(r);
      }
      existing.notableMoments.push(...(pc.notableMoments || []).map((m) => ({ session: sessionNumber, text: m })));
      existing.quotes.push(...(pc.quotes || []).map((q) => ({ session: sessionNumber, text: q })));
      existing.hooks.push(...(pc.hooks || []).map((h) => ({ session: sessionNumber, text: h })));
    }
  }

  const characters = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  // An extracted record matching nobody on the roster is an NPC the model
  // mistook for a player, and gets no note. Reported rather than dropped in
  // silence — a roster typo would otherwise look like an empty session.
  return Object.assign(characters, { unmatched });
}

// The roster the user gave us is authoritative over the model's reading of
// it. The model is looking at speech-to-text and will sometimes decide the
// character is called whatever the speaker label says; the speaker label is
// still worth keeping as an alias either way, since the transcript is full of
// it and the session recaps use it.
export function applyRoster(characters, roster) {
  for (const { player, character } of roster) {
    if (!player) continue;
    const match =
      characters.find((c) => character && npcKey(c.name) === npcKey(character)) ||
      characters.find((c) => npcKey(c.player) === npcKey(player)) ||
      characters.find((c) => npcKey(c.name) === npcKey(player) || c.aliases.some((a) => npcKey(a) === npcKey(player)));
    if (!match) continue;

    if (character) match.name = character;
    match.player = player;
    match.aliases = uniq([...match.aliases, player].filter((a) => npcKey(a) !== npcKey(match.name)));
  }
  return characters;
}

const link = (name) => `[[${String(name).replace(/[[\]]/g, '').trim()}]]`;
const yamlString = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const yamlList = (values) => `[${values.map(yamlString).join(', ')}]`;

export function renderCharacterNote(pc, { campaign, knownEntities = [] } = {}) {
  const known = new Set(knownEntities.map(npcKey));
  const linkIfKnown = (name) => (known.has(npcKey(name)) ? link(name) : String(name));

  const fm = ['---', `name: ${yamlString(pc.name)}`];
  if (pc.aliases.length) fm.push(`aliases: ${yamlList(pc.aliases)}`);
  fm.push('type: pc');
  if (pc.player) fm.push(`player: ${yamlString(pc.player)}`);
  if (pc.race) fm.push(`race: ${yamlString(pc.race)}`);
  if (pc.class) fm.push(`class: ${yamlString(pc.class)}`);
  if (pc.level != null) fm.push(`level: ${pc.level}`);
  if (pc.deity) fm.push(`deity: ${yamlString(pc.deity)}`);
  fm.push(`status: ${pc.status}`);
  fm.push(`first_seen: ${Math.min(...pc.sessions)}`);
  fm.push(`sessions: [${pc.sessions.join(', ')}]`);
  if (campaign) fm.push(`campaign: ${yamlString(campaign)}`);
  fm.push('tags: [pc]');
  fm.push('---', '');

  const body = [`# ${pc.name}`, ''];

  const subtitle = [pc.race, pc.class, pc.level != null ? `level ${pc.level}` : null].filter(Boolean).join(' ');
  const played = pc.player ? `played by ${pc.player}` : null;
  const line = [subtitle, played].filter(Boolean).join(' — ');
  if (line) body.push(`*${line}*`, '');

  if (pc.description) body.push(pc.description, '');
  if (pc.goal) body.push('## What they want', pc.goal, '');

  if (pc.relationships.length) {
    body.push('## Relationships', ...pc.relationships.map((r) => `- **${linkIfKnown(r.who)}** — ${r.how}`), '');
  }

  if (pc.notableMoments.length) {
    body.push(
      '## What they did',
      ...pc.notableMoments.map((m) => `- ${m.text} _([[Session ${String(m.session).padStart(2, '0')}]])_`),
      ''
    );
  }

  if (pc.quotes.length) {
    body.push('## In their own words', '');
    for (const q of pc.quotes) {
      body.push(`> ${q.text}`, `> — _[[Session ${String(q.session).padStart(2, '0')}]]_`, '');
    }
  }

  if (pc.hooks.length) {
    body.push(
      '## Threads left hanging',
      ...pc.hooks.map((h) => `- [ ] ${h.text} _([[Session ${String(h.session).padStart(2, '0')}]])_`),
      ''
    );
  }

  body.push('## Appears in', ...pc.sessions.map((s) => `- [[Session ${String(s).padStart(2, '0')}]]`), '');

  return fm.join('\n') + body.join('\n');
}
