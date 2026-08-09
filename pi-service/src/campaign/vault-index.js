// Every name the vault knows about, and which note each one points at.
//
// The ledger (campaign/ledger.js) knows the names the summariser has emitted.
// The per-entity notes under NPCs/ and Locations/ know more: each carries an
// `aliases:` list of the spellings whisper actually produced for that name
// ("Kaltrix" and "Kalkrix" for Caltrix, "Yusdrayl" for the Kobold Queen).
// Those aliases are the ones worth linking — they are exactly the mentions a
// reader would otherwise fail to connect to anything.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENTITY_FOLDERS = ['NPCs', 'Locations'];

// Only the leading --- block, and only the two keys we need. A real YAML
// parser would be a dependency for four lines of very predictable output
// (renderNpcNote writes these), and would still need this much validation.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!match) return { name: null, aliases: [] };

  const block = match[1];
  const name = /^name:\s*"?([^"\n]*?)"?\s*$/m.exec(block)?.[1]?.trim() || null;

  const inline = /^aliases:\s*\[(.*)\]\s*$/m.exec(block);
  if (inline) {
    const aliases = inline[1]
      .split(',')
      .map((a) => a.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
    return { name, aliases };
  }

  // The block form, in case a note has been hand-edited into it.
  const blockList = /^aliases:\s*\r?\n((?:\s*-\s*.*\r?\n?)+)/m.exec(block);
  if (blockList) {
    const aliases = blockList[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
    return { name, aliases };
  }

  return { name, aliases: [] };
}

// Aliases are recorded as the bare word whisper produced — "Kerawin" for
// Kerowyn Hucrele, "Yusdrayl" for the Kobold Queen — but the prose says
// "Kerawin Hucrele" and "Queen Yusdrayl". Matching the bare alias alone
// leaves the rest of the name dangling outside the link:
//
//     [[Kerowyn Hucrele|Kerawin]] Hucrele
//
// So each single-word alias is also paired with every word of the canonical
// name, in both orders. That yields "Kerawin Hucrele" and "Queen Yusdrayl"
// without having to work out which word the alias is standing in for. The
// linker tries the longest name first, so whichever variant the text actually
// uses wins, with the bare alias left as the fallback. Variants that match
// nothing ("Yusdrayl Kobold") cost nothing — they are simply never found.
export function expandAliases(name, aliases) {
  const words = String(name).split(/\s+/).filter(Boolean);
  if (words.length < 2) return [...aliases];

  const out = new Set(aliases);
  for (const alias of aliases) {
    if (!alias || alias.includes(' ')) continue;
    for (const word of words) {
      if (word.toLowerCase() === alias.toLowerCase()) continue;
      out.add(`${word} ${alias}`);
      out.add(`${alias} ${word}`);
    }
  }
  return [...out];
}

// An alias two different notes both claim is worse than no link at all:
// "Talgan and Sharwin" is listed by both Hucrele siblings, and a wikilink
// would silently resolve to whichever note Obsidian happened to index first.
// Canonical names win over aliases; a name claimed twice is dropped.
export function buildNameIndex(entities) {
  const canonical = new Set(entities.map((e) => e.name));
  const claims = new Map(); // name -> Set of canonical notes claiming it

  for (const entity of entities) {
    for (const alias of [entity.name, ...entity.aliases]) {
      if (!alias) continue;
      if (alias !== entity.name && canonical.has(alias)) continue; // another note owns this outright
      if (!claims.has(alias)) claims.set(alias, new Set());
      claims.get(alias).add(entity.name);
    }
  }

  const targets = new Map();
  const ambiguous = [];
  for (const [alias, owners] of claims) {
    if (owners.size > 1 && !canonical.has(alias)) {
      ambiguous.push({ alias, owners: [...owners] });
      continue;
    }
    targets.set(alias, canonical.has(alias) ? alias : [...owners][0]);
  }

  return { targets, ambiguous };
}

// Folds in names that have no entity note of their own — ledger entries, and
// whoever turned up this session. They link to themselves, which renders as
// an unresolved (dim) note in Obsidian: a visible to-do rather than a silent
// gap. Ambiguous names stay out, same as everywhere else.
export function addPlainNames(index, names) {
  const ambiguous = new Set(index.ambiguous.map((a) => a.alias));
  for (const name of names) {
    if (!name) continue;
    if (!index.targets.has(name) && !ambiguous.has(name)) index.targets.set(name, name);
  }
  return index;
}

// Reads NPCs/ and Locations/ under a campaign folder. Returns the entities in
// no particular order; the linker sorts by length so the longest name wins.
export async function readVaultEntities(cfg, folder) {
  const entities = [];

  for (const kind of ENTITY_FOLDERS) {
    const dir = join(cfg.obsidianExportDir, folder, kind);
    let files = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue; // a campaign with no entity notes yet
    }

    for (const file of files) {
      const noteName = file.replace(/\.md$/, '');
      let front = { name: null, aliases: [] };
      try {
        front = parseFrontmatter(await readFile(join(dir, file), 'utf8'));
      } catch {
        // Unreadable note: still worth linking by filename.
      }
      // The FILENAME is canonical, not the frontmatter name — that is what a
      // [[wikilink]] actually resolves against. A frontmatter name that
      // disagrees becomes just another alias.
      const declared = [...front.aliases, front.name].filter((a) => a && a !== noteName);
      const aliases = expandAliases(noteName, declared).filter((a) => a !== noteName);
      entities.push({ name: noteName, aliases, declared, kind, path: join(dir, file) });
    }
  }

  return entities;
}
