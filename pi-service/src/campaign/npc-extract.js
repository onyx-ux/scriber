// Builds one Obsidian note per NPC from the FULL session transcripts.
//
// The per-session summary already lists "NPCs Introduced", but it is one line
// each and only covers the session that introduced them. A character who
// recurs for six months has six one-liners scattered across six notes and no
// page of their own. Reading the raw transcript instead picks up what the
// summary throws away: how they speak, what they wanted, what they were lying
// about, and the loose ends the table left hanging.
//
// Extraction is per session, then merged by name, so an NPC accumulates
// across sessions and the note records which ones they appeared in.

export const NPC_SYSTEM_PROMPT = `You are a meticulous D&D campaign archivist.

You will be given the RAW TRANSCRIPT of one session, exactly as spoken. It is
automatic speech-to-text: names are often misheard, sentences are broken, and
players talk over each other. Read past that.

Extract every NPC — every character who is NOT a player character. Include
quest-givers, shopkeepers, villains, monsters that spoke or were named,
animals with names, and deities or absent figures the party discussed at
length. A creature the party simply fought and never named is not an NPC.

RULES
- Only include NPCs with actual evidence in this transcript. Never invent one,
  and never carry in knowledge of published D&D modules: if the party met a
  character from a printed adventure, describe them ONLY as they appeared at
  this table.
- The player characters are listed below. They are NOT NPCs, and neither are
  the players themselves.
- Prefer the spelling the table settled on. If a name is clearly mangled by
  transcription, use your best reconstruction and put the variants in aliases.
- Anything you are unsure of should be omitted rather than guessed. An empty
  field is fine; a confident invention is not.
- Quotes must be copied verbatim from the transcript. If a line is too garbled
  to quote, leave quotes empty.
- You may be given NAMES ALREADY USED IN THIS CAMPAIGN'S NOTES. Those are the
  spellings the existing notes link to. Whenever one of them refers to a
  character you are extracting, include it verbatim in that character's
  aliases — even if you are confident the real spelling is different, and even
  if the existing name covers two characters at once. Those links already
  exist in the vault and must keep resolving. Do not invent a character just
  because a name appears in that list.

Return ONLY a JSON object of this shape, with no prose and no code fence:

{
  "npcs": [
    {
      "name": "Meepo",
      "aliases": ["Meepo the kobold"],
      "race": "Kobold",
      "role": "Keeper of the tribe's white dragon",
      "status": "alive",
      "affiliation": "Kobold tribe of the Sunless Citadel",
      "locations": ["Sunless Citadel"],
      "description": "2-4 sentences on who they are and how they came across.",
      "motivation": "What they want, in their own terms.",
      "relationships": [{ "who": "Kobold Queen", "how": "Serves her, and fears her temper." }],
      "notableMoments": ["What they actually did this session."],
      "quotes": ["A verbatim line, if there is a clean one."],
      "hooks": ["Threads the party left open involving them."],
      "partyStanding": "friendly | hostile | wary | neutral | unknown"
    }
  ]
}

status must be one of: alive, dead, unknown.
Omit any field you have no evidence for. Return {"npcs": []} if there are none.`;

export function buildNpcUserMessage({
  transcript,
  sessionNumber,
  date,
  playerCharacters = [],
  existingNames = [],
}) {
  const players = playerCharacters.length
    ? playerCharacters.join(', ')
    : '(none recorded — treat recurring speakers as players)';

  const lines = [
    `SESSION ${sessionNumber}${date ? ` (${date})` : ''}`,
    `PLAYER CHARACTERS (never NPCs): ${players}`,
  ];

  // The vault already links [[Kerowyn]] and [[Kobold Queen]]. If the model
  // returns "Kerawin Hucrele" and "Yusdrayl" without carrying those forward as
  // aliases, every one of those existing links silently stops resolving.
  if (existingNames.length) {
    lines.push(`NAMES ALREADY USED IN THIS CAMPAIGN'S NOTES: ${existingNames.join(', ')}`);
  }

  lines.push('', 'TRANSCRIPT:', transcript);
  return lines.join('\n');
}

// Models wrap JSON in prose or a code fence often enough that trusting a bare
// JSON.parse means losing a whole session's extraction to a stray backtick.
//
// `key` is the property the list lives under ("npcs", "characters"). A bare
// array is accepted too, since that is the other shape models return when
// asked for a list.
export function parseEntityList(text, key) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }

  const list = Array.isArray(parsed) ? parsed : parsed[key];
  if (!Array.isArray(list)) return [];

  return list.filter((n) => n && typeof n.name === 'string' && n.name.trim());
}

export function parseNpcResponse(text) {
  return parseEntityList(text, 'npcs');
}

// "meepo", "Meepo," and "MEEPO" are the same character.
export function npcKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const uniq = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v.trim()))];

// Merges an NPC seen in several sessions into one record. Later sessions win
// on facts that change (status, standing, role) and accumulate on facts that
// build up (moments, quotes, hooks) — a character who dies in session 4 should
// not read as alive because session 2 said so.
export function mergeNpcs(perSession) {
  const byKey = new Map();

  for (const { sessionNumber, npcs } of perSession) {
    for (const npc of npcs) {
      const key = npcKey(npc.name);
      if (!key) continue;

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          name: npc.name.trim(),
          aliases: uniq(npc.aliases || []),
          race: npc.race || null,
          role: npc.role || null,
          status: npc.status || 'unknown',
          affiliation: npc.affiliation || null,
          locations: uniq(npc.locations || []),
          description: npc.description || '',
          motivation: npc.motivation || '',
          relationships: npc.relationships || [],
          partyStanding: npc.partyStanding || 'unknown',
          sessions: [sessionNumber],
          notableMoments: (npc.notableMoments || []).map((m) => ({ session: sessionNumber, text: m })),
          quotes: (npc.quotes || []).map((q) => ({ session: sessionNumber, text: q })),
          hooks: (npc.hooks || []).map((h) => ({ session: sessionNumber, text: h })),
        });
        continue;
      }

      existing.sessions = uniq([...existing.sessions.map(String), String(sessionNumber)]).map(Number).sort((a, b) => a - b);
      existing.aliases = uniq([...existing.aliases, ...(npc.aliases || [])]);
      existing.locations = uniq([...existing.locations, ...(npc.locations || [])]);

      // Latest session wins on anything that can change over time.
      if (npc.status) existing.status = npc.status;
      if (npc.partyStanding) existing.partyStanding = npc.partyStanding;
      if (npc.role) existing.role = npc.role;
      if (npc.affiliation) existing.affiliation = npc.affiliation;
      if (npc.race && !existing.race) existing.race = npc.race;
      if (npc.motivation) existing.motivation = npc.motivation;
      // The longer description is usually the one with something in it.
      if ((npc.description || '').length > existing.description.length) existing.description = npc.description;

      for (const r of npc.relationships || []) {
        if (!existing.relationships.some((e) => npcKey(e.who) === npcKey(r.who))) existing.relationships.push(r);
      }
      existing.notableMoments.push(...(npc.notableMoments || []).map((m) => ({ session: sessionNumber, text: m })));
      existing.quotes.push(...(npc.quotes || []).map((q) => ({ session: sessionNumber, text: q })));
      existing.hooks.push(...(npc.hooks || []).map((h) => ({ session: sessionNumber, text: h })));
    }
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Words too generic to identify anyone. "Kobold Queen" and "Queen Yusdrayl"
// share "queen", which says nothing about whether they are the same character.
const GENERIC = new Set([
  'the', 'of', 'and', 'a', 'an', 'lord', 'lady', 'sir', 'king', 'queen', 'prince',
  'princess', 'captain', 'master', 'mister', 'miss', 'uncle', 'aunt', 'old', 'young',
  'mayor', 'sheriff', 'guard', 'innkeeper', 'blacksmith', 'cleric', 'wizard', 'priest',
]);

const tokens = (name) =>
  npcKey(name)
    .split(' ')
    .filter((t) => t.length >= 4 && !GENERIC.has(t));

// Small edit distance, capped — "Illian" and "Ilion" are the same person heard
// twice by a speech-to-text model.
function closeEnough(a, b, max = 2) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = temp;
    }
  }
  return prev[b.length] <= max;
}

// The vault already contains [[Kerowyn]] and [[Illian Merrick]]. If the
// extraction returns "Kerowyn Hucrele" and "Ilion Merrick" without those exact
// spellings as aliases, those links stop resolving — Obsidian matches aliases
// verbatim. The prompt asks for this, but a model following an instruction
// most of the time is not good enough when the failure is silent, so it is
// enforced here.
//
// Only an unambiguous match counts. A name matching two NPCs (a combined
// "Talgan and Sharwin" entry, say) is left alone and reported: claiming the
// same alias on two notes makes Obsidian pick one arbitrarily.
export function reconcileAliases(npcs, existingNames = []) {
  const unresolved = [];

  for (const existing of existingNames) {
    const key = npcKey(existing);
    if (!key) continue;

    const already = npcs.find(
      (n) => npcKey(n.name) === key || n.aliases.some((a) => npcKey(a) === key)
    );
    if (already) continue;

    const existingTokens = tokens(existing);
    if (existingTokens.length === 0) {
      unresolved.push(existing);
      continue;
    }

    const matches = npcs.filter((npc) => {
      const candidateTokens = [npc.name, ...npc.aliases].flatMap(tokens);
      return existingTokens.some((t) => candidateTokens.some((c) => closeEnough(t, c)));
    });

    if (matches.length === 1) matches[0].aliases.push(existing);
    else unresolved.push(existing);
  }

  return { npcs, unresolved };
}

// Obsidian resolves [[Name]] by filename wherever the file sits, so a note in
// NPCs/ still satisfies the [[Meepo]] links already written into the session
// recaps and the ledger.
const link = (name) => `[[${String(name).replace(/[[\]]/g, '').trim()}]]`;
const yamlString = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const yamlList = (values) => `[${values.map(yamlString).join(', ')}]`;

export function renderNpcNote(npc, { campaign, knownEntities = [] } = {}) {
  const known = new Set(knownEntities.map(npcKey));
  const linkIfKnown = (name) => (known.has(npcKey(name)) ? link(name) : String(name));

  const fm = ['---', `name: ${yamlString(npc.name)}`];
  if (npc.aliases.length) fm.push(`aliases: ${yamlList(npc.aliases)}`);
  fm.push('type: npc');
  if (npc.race) fm.push(`race: ${yamlString(npc.race)}`);
  if (npc.role) fm.push(`role: ${yamlString(npc.role)}`);
  fm.push(`status: ${npc.status}`);
  fm.push(`party_standing: ${npc.partyStanding}`);
  if (npc.affiliation) fm.push(`affiliation: ${yamlString(npc.affiliation)}`);
  if (npc.locations.length) fm.push(`locations: ${yamlList(npc.locations)}`);
  fm.push(`first_seen: ${Math.min(...npc.sessions)}`);
  fm.push(`sessions: [${npc.sessions.join(', ')}]`);
  if (campaign) fm.push(`campaign: ${yamlString(campaign)}`);
  fm.push(`tags: [npc]`);
  fm.push('---', '');

  const body = [`# ${npc.name}`, ''];

  const subtitle = [npc.race, npc.role].filter(Boolean).join(' — ');
  if (subtitle) body.push(`*${subtitle}*`, '');

  if (npc.description) body.push(npc.description, '');

  if (npc.motivation) body.push('## What they want', npc.motivation, '');

  if (npc.locations.length) {
    body.push('## Where to find them', ...npc.locations.map((l) => `- ${linkIfKnown(l)}`), '');
  }

  if (npc.relationships.length) {
    body.push(
      '## Relationships',
      ...npc.relationships.map((r) => `- **${linkIfKnown(r.who)}** — ${r.how}`),
      ''
    );
  }

  if (npc.notableMoments.length) {
    body.push(
      '## What they did',
      ...npc.notableMoments.map((m) => `- ${m.text} _([[Session ${String(m.session).padStart(2, '0')}]])_`),
      ''
    );
  }

  if (npc.quotes.length) {
    body.push('## In their own words', '');
    for (const q of npc.quotes) {
      body.push(`> ${q.text}`, `> — _[[Session ${String(q.session).padStart(2, '0')}]]_`, '');
    }
  }

  if (npc.hooks.length) {
    body.push(
      '## Threads left hanging',
      ...npc.hooks.map((h) => `- [ ] ${h.text} _([[Session ${String(h.session).padStart(2, '0')}]])_`),
      ''
    );
  }

  body.push(
    '## Appears in',
    ...npc.sessions.map((s) => `- [[Session ${String(s).padStart(2, '0')}]]`),
    ''
  );

  return fm.join('\n') + body.join('\n');
}

// Windows and Obsidian both dislike these, and the name comes from a model
// reading garbled speech-to-text.
export function npcFileName(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*[\]#^]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned ? `${cleaned}.md` : null;
}

// What this subject is, for the shared run in campaign/entity-notes.js.
//
// Everything above is the part that is genuinely about NPCs — the prompt, how
// their records merge across sessions, how a note reads. Everything the RUN
// does (find the sessions, call the model once each, cache, reconcile, report,
// write) used to be copied into scripts/build-npc-notes.mjs and copied again
// into the location and character builders. This is the seam between them.
export const NPC_SUBJECT = {
  key: 'npcs',
  noun: 'NPC',
  folder: 'NPCs',
  systemPrompt: NPC_SYSTEM_PROMPT,
  userMessage: ({ transcript, sessionNumber, date, existingNames, extras }) =>
    buildNpcUserMessage({
      transcript,
      sessionNumber,
      date,
      existingNames,
      // Who is NOT an NPC. A player whose character is named something other
      // than their Discord name was being written up as a stranger the party
      // met — see campaign/character-names.js.
      playerCharacters: extras.playerCharacters ?? [],
    }),
  parse: parseNpcResponse,
  merge: (perSession) => mergeNpcs(perSession),
  // Enforced rather than trusted: the prompt asks the model to carry existing
  // spellings into aliases, and a model that obeys most of the time is not
  // good enough when the failure is a silently orphaned link.
  reconcile: (records, existingNames) => reconcileAliases(records, existingNames),
  fileName: npcFileName,
  render: renderNpcNote,
  detail: (npc) =>
    [
      npc.race,
      npc.status !== 'unknown' ? npc.status : null,
      `sessions ${npc.sessions.join(', ')}`,
      npc.quotes.length ? `${npc.quotes.length} quote(s)` : null,
      npc.hooks.length ? `${npc.hooks.length} open thread(s)` : null,
    ]
      .filter(Boolean)
      .join(' · '),
};
