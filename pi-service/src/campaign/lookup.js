// Finding things in a campaign when the transcriber cannot spell them.
//
// The names people search for and ask about are exactly the words speech to
// text gets wrong, and it gets them wrong differently each session:
// "Yusdrayl", "Yusdrail", "Use Drail". A search for one spelling used to find
// only that spelling.
//
// Two things close most of that gap. The vault's entity notes already carry
// every spelling the transcriber produced for a name as aliases, so a name in
// a query brings its aliases with it (expandTerms). And when nothing matches
// exactly, words that share most of their three-letter pieces with the query
// are offered instead (closeSpellings).
import { readVaultEntities } from './vault-index.js';
import { campaignFolderFor } from '../export/naming.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Every entity note in the campaign's vault, as { name, aliases, kind }.
// Empty when there is no vault on this machine, which is a normal state.
export async function loadCampaignNames(cfg, campaign) {
  if (!cfg?.obsidianExportDir || !campaign) return [];
  try {
    const entities = await readVaultEntities(cfg, campaignFolderFor(campaign));
    return entities.map((e) => ({ name: e.name, aliases: e.declared ?? e.aliases ?? [], kind: e.kind }));
  } catch {
    return [];
  }
}

// A whole-phrase, case-insensitive "does this text mention that name".
function mentions(text, name) {
  const n = norm(name);
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(norm(text));
}

// The search terms a query really stands for: the query itself, plus every
// spelling of any name it mentions (by the name or by one of its aliases).
export function expandTerms(query, names = []) {
  const terms = new Set();
  const matched = [];
  for (const entity of names) {
    const spellings = [entity.name, ...(entity.aliases ?? [])].filter(Boolean);
    if (spellings.some((s) => mentions(query, s))) {
      matched.push(entity);
      for (const s of spellings) terms.add(s);
    }
  }
  return { terms: [...terms], matched };
}

function trigrams(word) {
  const w = ` ${norm(word)} `;
  const out = new Set();
  for (let i = 0; i + 3 <= w.length; i += 1) out.add(w.slice(i, i + 3));
  return out;
}

// Dice similarity over three-letter pieces, 0 to 1. "yusdrayl" and "yusdrail"
// share most of theirs; "yusdrayl" and "kobold" share none.
export function similarity(a, b) {
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both += 1;
  return (2 * both) / (x.size + y.size);
}

const CLOSE_ENOUGH = 0.5;

// Words in the campaign's transcripts spelled like `word`, and the lines they
// are on. For a single-word search that found nothing exactly: the likeliest
// reason is that the transcriber spelled it another way.
export function closeSpellings(db, campaignId, word, { limit = 25 } = {}) {
  const target = norm(word);
  if ([...target].length < 4 || /\s/.test(target)) return { words: [], rows: [] };

  // Candidates are lines sharing any three-letter piece with the word, from
  // the trigram index. The pieces with spaces round them (word starts and
  // ends) are not in the index, so only the inner ones are asked for.
  const inner = [...trigrams(target)].filter((g) => !g.includes(' '));
  const candidates = db.searchUtterancesRanked(campaignId, inner, 400);

  const words = new Map(); // spelling as written -> score
  const rows = [];
  for (const row of candidates) {
    let best = 0;
    for (const token of String(row.text).split(/[^\p{L}\p{N}']+/u)) {
      if ([...token].length < 3 || norm(token) === target) continue;
      const score = similarity(target, token);
      if (score >= CLOSE_ENOUGH) {
        best = Math.max(best, score);
        words.set(token, Math.max(words.get(token) ?? 0, score));
      }
    }
    if (best > 0) rows.push({ ...row, rank: -best });
  }

  return {
    words: [...words.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 5),
    rows: rows.sort((a, b) => a.rank - b.rank).slice(0, limit),
  };
}
