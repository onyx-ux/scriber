// Ledger entries are written as a name followed by a description, and the
// model chooses the punctuation between them. Observed in real sessions:
//
//   Bob: A merchant's assistant who survives a wolf attack.
//   Vex the Bold — a smuggler from the docks
//   Old Miriam, herbalist
//   Corky (the local cleric)
//
// Two things need the NAME on its own, and both were getting the whole
// sentence instead because the colon — by far the most common separator the
// model actually uses — was missing from the split:
//
//   * the Obsidian wikilink, which produced
//     [[Bob: A merchant's assistant who survives a wolf attack.]] — a note
//     per phrasing rather than a note per NPC, and only when the sentence
//     happened to be under the length guard, so half the entries silently
//     got no link at all;
//   * the ledger's dedupe key, which is supposed to make a re-mentioned NPC
//     match an existing entry. Keyed on the full sentence, any reworded
//     description reads as a brand new NPC and gets appended again.
//
// Splitting on whichever separator comes FIRST keeps names containing a
// comma or dash intact when a colon is present ("Talgan and Sharwin: ...").
const SEPARATOR = /\s*:\s+|\s+[—–-]\s+|,\s+|\s+\(/;

export function splitEntryName(entry) {
  const s = String(entry ?? '').trim();
  const m = s.match(SEPARATOR);
  if (!m || m.index === 0) return { name: s, rest: '' };
  return { name: s.slice(0, m.index).trim(), rest: s.slice(m.index) };
}

// A name long enough to be a sentence is the model failing to give one, and
// a 200-character wikilink is worse than no wikilink.
export const MAX_NAME_LENGTH = 60;

export function isUsableName(name) {
  return Boolean(name) && name.length <= MAX_NAME_LENGTH && /[a-z]/i.test(name);
}
