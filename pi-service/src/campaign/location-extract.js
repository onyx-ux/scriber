// One Obsidian note per place, built from the full session transcripts.
//
// The counterpart to npc-extract.js, and it reuses that module's generic
// helpers — parsing a model's JSON, normalising a name, reconciling aliases
// against links the vault already contains, and turning a name into a
// filename are all the same problem whether the subject is a person or a
// place. Only the prompt and the rendered shape differ.
import { npcKey, reconcileAliases, parseNpcResponse } from './npc-extract.js';

export {
  // Re-exported so a caller doing locations doesn't have to import from a
  // module named after NPCs to get them.
  npcKey as entityKey,
  reconcileAliases,
  parseNpcResponse as parseEntityResponse,
};

export const LOCATION_SYSTEM_PROMPT = `You are a meticulous D&D campaign archivist.

You will be given the RAW TRANSCRIPT of one session, exactly as spoken. It is
automatic speech-to-text: names are often misheard, sentences are broken, and
players talk over each other. Read past that.

Extract every PLACE the party visited, travelled through, or discussed as
somewhere they might go: settlements, buildings, rooms with a name, dungeons,
regions, landmarks. A room described only as "the next room" is not a place; a
room the table named ("the goblin larder") is.

RULES
- Only include places with actual evidence in this transcript. Never invent
  one, and never carry in knowledge of published D&D modules: describe a place
  ONLY as it appeared at this table.
- Prefer the spelling the table settled on, and put transcription variants in
  aliases.
- Nest properly: if a room sits inside a larger site, name that site in
  "partOf" rather than inventing a separate entry for the building.
- Anything you are unsure of should be omitted rather than guessed.

Return ONLY a JSON object of this shape, with no prose and no code fence:

{
  "locations": [
    {
      "name": "Sunless Citadel",
      "aliases": ["The Citadel"],
      "kind": "dungeon",
      "partOf": "A ravine a day's travel from Oakhurst",
      "region": "Near Oakhurst",
      "controlledBy": "Kobold tribe, contested by goblins",
      "status": "explored",
      "description": "2-4 sentences on what the place is and how it felt.",
      "features": ["Concrete things that are actually there."],
      "inhabitants": ["Named creatures or people found here."],
      "events": ["What happened here this session."],
      "hooks": ["Reasons to come back, or things left unexplored."],
      "danger": "safe | uneasy | dangerous | deadly | unknown"
    }
  ]
}

kind should be a short noun: town, inn, dungeon, room, shop, road, ruin, shrine.
status must be one of: unexplored, explored, partially explored, destroyed, unknown.
Omit any field you have no evidence for. Return {"locations": []} if there are none.`;

export function buildLocationUserMessage({ transcript, sessionNumber, date, existingNames = [] }) {
  const lines = [`SESSION ${sessionNumber}${date ? ` (${date})` : ''}`];

  if (existingNames.length) {
    lines.push(
      `NAMES ALREADY USED IN THIS CAMPAIGN'S NOTES: ${existingNames.join(', ')}`,
      'If one of those refers to a place you are extracting, include it verbatim in that place\'s aliases.'
    );
  }

  lines.push('', 'TRANSCRIPT:', transcript);
  return lines.join('\n');
}

export function parseLocationResponse(text) {
  // parseNpcResponse looks for a `npcs` array; locations come back under a
  // different key, so normalise before handing it over.
  const raw = String(text ?? '');
  return parseNpcResponse(raw.replace(/"locations"\s*:/, '"npcs":'));
}

const uniq = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v.trim()))];

// Same shape of rules as mergeNpcs: the latest session wins on what changes
// (status, who controls it, how dangerous it is), and everything that
// accumulates keeps the session it came from.
export function mergeLocations(perSession) {
  const byKey = new Map();

  for (const { sessionNumber, locations } of perSession) {
    for (const loc of locations) {
      const key = npcKey(loc.name);
      if (!key) continue;

      // Match on aliases too, not just the name. The table called the same
      // building the "Old Boar Tavern" one week and the "Old Boar Inn" the
      // next; keying on the name alone produced two notes for one inn.
      const existing =
        byKey.get(key) ??
        [...byKey.values()].find(
          (candidate) =>
            candidate.aliases.some((a) => npcKey(a) === key) ||
            (loc.aliases || []).some((a) => npcKey(a) === npcKey(candidate.name))
        );

      if (!existing) {
        byKey.set(key, {
          name: loc.name.trim(),
          aliases: uniq(loc.aliases || []),
          kind: loc.kind || null,
          partOf: loc.partOf || null,
          region: loc.region || null,
          controlledBy: loc.controlledBy || null,
          status: loc.status || 'unknown',
          danger: loc.danger || 'unknown',
          description: loc.description || '',
          features: uniq(loc.features || []),
          inhabitants: uniq(loc.inhabitants || []),
          sessions: [sessionNumber],
          events: (loc.events || []).map((e) => ({ session: sessionNumber, text: e })),
          hooks: (loc.hooks || []).map((h) => ({ session: sessionNumber, text: h })),
        });
        continue;
      }

      existing.sessions = uniq([...existing.sessions.map(String), String(sessionNumber)])
        .map(Number)
        .sort((a, b) => a - b);
      // Keep the name it was merged under as an alias, so a link written with
      // the other week's wording still resolves.
      existing.aliases = uniq([
        ...existing.aliases,
        ...(loc.aliases || []),
        ...(npcKey(loc.name) === npcKey(existing.name) ? [] : [loc.name]),
      ]);
      existing.features = uniq([...existing.features, ...(loc.features || [])]);
      existing.inhabitants = uniq([...existing.inhabitants, ...(loc.inhabitants || [])]);

      if (loc.status) existing.status = loc.status;
      if (loc.danger) existing.danger = loc.danger;
      if (loc.controlledBy) existing.controlledBy = loc.controlledBy;
      if (loc.kind && !existing.kind) existing.kind = loc.kind;
      if (loc.partOf && !existing.partOf) existing.partOf = loc.partOf;
      if (loc.region && !existing.region) existing.region = loc.region;
      if ((loc.description || '').length > existing.description.length) existing.description = loc.description;

      existing.events.push(...(loc.events || []).map((e) => ({ session: sessionNumber, text: e })));
      existing.hooks.push(...(loc.hooks || []).map((h) => ({ session: sessionNumber, text: h })));
    }
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const link = (name) => `[[${String(name).replace(/[[\]]/g, '').trim()}]]`;
const yamlString = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const yamlList = (values) => `[${values.map(yamlString).join(', ')}]`;
const sessionLink = (n) => `[[Session ${String(n).padStart(2, '0')}]]`;

export function renderLocationNote(loc, { campaign, knownEntities = [] } = {}) {
  const known = new Set(knownEntities.map(npcKey));
  const linkIfKnown = (name) => (known.has(npcKey(name)) ? link(name) : String(name));

  const fm = ['---', `name: ${yamlString(loc.name)}`];
  if (loc.aliases.length) fm.push(`aliases: ${yamlList(loc.aliases)}`);
  fm.push('type: location');
  if (loc.kind) fm.push(`kind: ${yamlString(loc.kind)}`);
  if (loc.region) fm.push(`region: ${yamlString(loc.region)}`);
  if (loc.partOf) fm.push(`part_of: ${yamlString(loc.partOf)}`);
  if (loc.controlledBy) fm.push(`controlled_by: ${yamlString(loc.controlledBy)}`);
  fm.push(`status: ${yamlString(loc.status)}`);
  fm.push(`danger: ${loc.danger}`);
  fm.push(`first_seen: ${Math.min(...loc.sessions)}`);
  fm.push(`sessions: [${loc.sessions.join(', ')}]`);
  if (campaign) fm.push(`campaign: ${yamlString(campaign)}`);
  fm.push('tags: [location]', '---', '');

  const body = [`# ${loc.name}`, ''];

  const subtitle = [loc.kind, loc.region].filter(Boolean).join(' — ');
  if (subtitle) body.push(`*${subtitle}*`, '');
  if (loc.description) body.push(loc.description, '');

  if (loc.partOf) body.push(`**Part of:** ${linkIfKnown(loc.partOf)}`, '');
  if (loc.controlledBy) body.push(`**Held by:** ${linkIfKnown(loc.controlledBy)}`, '');

  if (loc.features.length) body.push('## What is there', ...loc.features.map((f) => `- ${f}`), '');

  if (loc.inhabitants.length) {
    body.push('## Who is there', ...loc.inhabitants.map((i) => `- ${linkIfKnown(i)}`), '');
  }

  if (loc.events.length) {
    body.push('## What happened here', ...loc.events.map((e) => `- ${e.text} _(${sessionLink(e.session)})_`), '');
  }

  if (loc.hooks.length) {
    body.push('## Left unexplored', ...loc.hooks.map((h) => `- [ ] ${h.text} _(${sessionLink(h.session)})_`), '');
  }

  body.push('## Visited in', ...loc.sessions.map((s) => `- ${sessionLink(s)}`), '');

  return fm.join('\n') + body.join('\n');
}
