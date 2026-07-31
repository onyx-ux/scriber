// Speech-to-text reliably mangles invented fantasy names, and it mangles
// them the SAME way every session — "Vex" comes back as "Vecks" week after
// week. So a correction is stored per campaign and replayed over every
// future transcript automatically, rather than being a one-off edit.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary anchored where the term allows it, so correcting "Vecks" to
// "Vex" doesn't also rewrite the middle of an unrelated word. Terms that
// start or end with punctuation can't take a \b on that side.
export function correctionRegex(wrong) {
  const term = String(wrong);
  const prefix = /^[\w]/.test(term) ? '\\b' : '';
  const suffix = /[\w]$/.test(term) ? '\\b' : '';
  return new RegExp(`${prefix}${escapeRegex(term)}${suffix}`, 'gi');
}

// corrections: [{ wrong_text, correct_text }]
export function applyCorrections(text, corrections) {
  let out = String(text ?? '');
  for (const c of corrections || []) {
    if (!c?.wrong_text) continue;
    // Function replacement so "$&", "$1" etc. in the replacement are treated
    // as literal text rather than regex substitutions.
    out = out.replace(correctionRegex(c.wrong_text), () => c.correct_text);
  }
  return out;
}

export function countCorrectionMatches(text, wrong) {
  const matches = String(text ?? '').match(correctionRegex(wrong));
  return matches ? matches.length : 0;
}
