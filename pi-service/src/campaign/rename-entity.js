// Renames an entity note and repoints every link in the campaign at it.
//
// The extractors name a character from what the transcript sounded like, and
// the table corrects it afterwards: "Seth" was Saf, "Thaddeus Leopard
// Archibald" was Tad. Renaming the file alone is not enough — the note's
// frontmatter still claims the old name, and every [[Old|shown]] link written
// before the rename points at a file that no longer exists.
//
// The old name is always kept as an ALIAS. Anything written before the rename
// (a session recap, a ledger entry, a note somebody typed by hand) used it,
// and dropping it would break exactly the links this is meant to preserve.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Horizontal whitespace only. `\s` matches a newline, so `^# Name\s*$` under
// the m flag matched the heading AND the blank line after it, closing the
// note up by a line every time it renamed one.
const H = '[ \\t]';

// Splits an inline `aliases: [...]` list. Deliberately not a YAML parser:
// these lines are written by renderNpcNote/renderCharacterNote and the shape
// is known.
function parseAliasLine(inner) {
  return inner
    .split(',')
    .map((a) => a.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

// Rewrites the note itself: name, heading, and alias list.
export function renameInNote(text, from, to) {
  let out = String(text);

  out = out.replace(new RegExp(`^name:${H}*.*$`, 'm'), `name: ${JSON.stringify(to)}`);

  const aliasLine = new RegExp(`^aliases:${H}*\\[(.*)\\]${H}*$`, 'm');
  if (aliasLine.test(out)) {
    out = out.replace(aliasLine, (_, inner) => {
      const kept = [...new Set([from, ...parseAliasLine(inner)])].filter((a) => a && a !== to);
      return `aliases: [${kept.map((a) => JSON.stringify(a)).join(', ')}]`;
    });
  } else {
    // No alias list yet, so the old name would be lost entirely.
    out = out.replace(new RegExp(`^(name:${H}*.*)$`, 'm'), `$1\naliases: [${JSON.stringify(from)}]`);
  }

  return out.replace(new RegExp(`^#${H}+${escapeRe(from)}${H}*$`, 'm'), `# ${to}`);
}

// Repoints links elsewhere in the vault.
//
//   [[Old]]        -> [[New|Old]]   the prose said "Old", so it keeps saying it
//   [[Old|shown]]  -> [[New|shown]]
//   [[Old|New]]    -> [[New]]       no point piping a name to itself
export function renameLinks(text, from, to) {
  const esc = escapeRe(from);
  return String(text)
    .replace(new RegExp(`\\[\\[${esc}\\|([^\\]]*)\\]\\]`, 'g'), (_, shown) =>
      shown.trim() === to ? `[[${to}]]` : `[[${to}|${shown}]]`
    )
    .replace(new RegExp(`\\[\\[${esc}\\]\\]`, 'g'), `[[${to}|${from}]]`);
}
