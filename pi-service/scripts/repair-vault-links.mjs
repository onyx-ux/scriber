#!/usr/bin/env node
// One-off repair for notes exported before the wikilink split understood
// colons. Two things go wrong in those files:
//
//   [[Bob: A merchant's assistant who survives a wolf attack.]]
//       -> a note named after a whole sentence, one per phrasing
//   Kerowyn: A mother who hires the party to rescue her children.
//       -> no link at all, purely because the line was over 60 characters
//
// Both are rewritten to "[[Name]]: description".
//
// Only lines inside the NPC and location sections are touched — in a session
// note that is "## NPCs Introduced" / "## Locations Visited", in a ledger file
// the whole list. Prose elsewhere is left alone: this repairs a formatting
// bug, it does not retro-fit the prose linking that new exports now do.
//
// Dry run by default. Pass --write to actually change anything, and it makes
// a timestamped .bak of every file it edits.
import { readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

import { splitEntryName, isUsableName } from '../src/campaign/entry-name.js';

const WRITE = process.argv.includes('--write');
const ROOT = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);

if (!ROOT) {
  console.error('usage: node scripts/repair-vault-links.mjs <vault-dir> [--write]');
  process.exit(1);
}

const LIST_SECTIONS = /^##\s+(NPCs Introduced|Locations Visited)\s*$/i;
// Only these two hold entities. Party-Decisions.md and Unresolved-Threads.md
// are full sentences — "How the strange creatures were created." is not an
// NPC, and linking it produces a note per plot point plus, where the sentence
// happens to contain a comma, a link that stops mid-phrase.
const LEDGER_FILES = new Set(['NPCs.md', 'Locations.md']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (extname(entry.name) === '.md') yield path;
  }
}

// "- [[Whole sentence.]] _(session #10)_" or "- Name: description _(...)_"
function repairLine(line) {
  const m = line.match(/^(\s*-\s+)(.*)$/);
  if (!m) return null;

  const [, bullet, body] = m;

  // Keep any trailing "_(session #10, date)_" annotation exactly as it is.
  const ann = body.match(/(\s*_\([^)]*\)_\s*)$/);
  const annotation = ann ? ann[1] : '';
  let content = annotation ? body.slice(0, -annotation.length) : body;

  // Unwrap a link that swallowed the description.
  const wrapped = content.match(/^\[\[(.+)\]\]$/);
  if (wrapped) content = wrapped[1];

  // Already correct: "[[Name]]: rest"
  if (/^\[\[[^\]]+\]\]/.test(content)) return null;

  const { name, rest } = splitEntryName(content);
  if (!isUsableName(name)) return null;

  const repaired = `${bullet}[[${name}]]${rest}${annotation}`;
  return repaired === line ? null : repaired;
}

function repairFile(text, isLedger) {
  const lines = text.split('\n');
  let inList = isLedger;
  let changes = 0;

  const out = lines.map((line) => {
    if (!isLedger && line.startsWith('## ')) {
      inList = LIST_SECTIONS.test(line);
      return line;
    }
    if (!inList) return line;

    const repaired = repairLine(line);
    if (repaired === null) return line;
    changes++;
    return repaired;
  });

  return { text: out.join('\n'), changes };
}

let filesChanged = 0;
let linesChanged = 0;

for await (const path of walk(ROOT)) {
  const original = await readFile(path, 'utf8');
  const isLedger = LEDGER_FILES.has(path.split(/[\\/]/).pop());
  const { text, changes } = repairFile(original, isLedger);
  if (changes === 0) continue;

  filesChanged++;
  linesChanged += changes;
  console.log(`\n${path}  (${changes} line${changes === 1 ? '' : 's'})`);

  const before = original.split('\n');
  text.split('\n').forEach((line, i) => {
    if (line !== before[i]) {
      console.log(`  - ${before[i]}`);
      console.log(`  + ${line}`);
    }
  });

  if (WRITE) {
    const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
    await copyFile(path, backup);
    await writeFile(path, text, 'utf8');
  }
}

console.log(
  `\n${WRITE ? 'Repaired' : 'Would repair'} ${linesChanged} line(s) across ${filesChanged} file(s).` +
    (WRITE ? ' A .bak copy was made of each file changed.' : ' Re-run with --write to apply.')
);
