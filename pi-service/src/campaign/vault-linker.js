// Adds wikilinks to a note that is already written.
//
// The exporter links a session recap as it writes it, against the names the
// ledger held at that moment. This is the retrospective version: given the
// vault's full name index, link every mention in an existing note. What it
// deliberately leaves alone:
//
//   * frontmatter — a wikilink inside a YAML value is not a link, it is a
//     malformed value;
//   * headings — Obsidian's outline and any [[Note#heading]] links elsewhere
//     are keyed on the literal heading text;
//   * blockquotes — those are verbatim transcript quotes, and editing what
//     somebody actually said is not a linker's job;
//   * the "## Full Transcript" section of a session note, for the same
//     reason. This is the same boundary export/markdown.js draws;
//   * fenced code.
import { linkifyEntities } from '../export/linkify.js';

const TRANSCRIPT_HEADING = /^##\s+Full Transcript\s*$/;

// Where one "first occurrence only" scope ends and the next begins.
//
// A whole note is too coarse: an NPC's "What they did" bullets would all go
// unlinked because the name happened to appear once in the description at the
// top. A ledger file is a flat list of independent entries under a single
// heading, so there each LIST ITEM is its own scope ('item' mode).
function scopeLines(lines, mode) {
  const marked = [];
  let scope = 0;
  let inFence = false;

  for (const [index, line] of lines.entries()) {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (isFence) inFence = !inFence;

    const isHeading = !inFence && /^#{1,6}\s/.test(line);
    const isItem = !inFence && /^\s*[-*+]\s/.test(line);
    if (isHeading || (mode === 'item' && isItem)) scope++;

    const skip = inFence || isFence || isHeading || /^\s*>/.test(line);
    marked.push({ index, scope, linkable: !skip && line.trim() !== '' });
  }

  return marked;
}

function alreadyLinked(text) {
  const linked = new Set();
  for (const [, target] of text.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) linked.add(target.trim());
  return linked;
}

export function linkifyBody(body, { names, targets, mode = 'section' }) {
  const lines = body.split('\n');

  const groups = new Map();
  for (const line of scopeLines(lines, mode)) {
    if (!line.linkable) continue;
    if (!groups.has(line.scope)) groups.set(line.scope, []);
    groups.get(line.scope).push(line.index);
  }

  for (const indices of groups.values()) {
    const before = indices.map((i) => lines[i]).join('\n');

    // A name already linked in this scope is done. "**[[Meepo]]** — cared for
    // as a pet by Meepo" should stay as written rather than link Meepo twice
    // in one line: linkifyEntities protects existing links from being wrapped
    // again, but has no way to know they referred to the same entity.
    const linked = alreadyLinked(before);
    const candidates = names.filter((n) => !linked.has(targets?.get(n) ?? n));
    if (candidates.length === 0) continue;

    const after = linkifyEntities(before, candidates, { targets });
    if (after === before) continue;

    const rewritten = after.split('\n');
    // linkifyEntities only ever substitutes within a line, so the line count
    // is preserved. Bail rather than corrupt a file if that stops being true.
    if (rewritten.length !== indices.length) {
      throw new Error(`linkify changed the line count (${indices.length} -> ${rewritten.length})`);
    }
    indices.forEach((lineIndex, n) => {
      lines[lineIndex] = rewritten[n];
    });
  }

  return lines.join('\n');
}

// Frontmatter off, transcript off, link the rest, put it back byte-for-byte.
export function linkifyNote(text, { names, targets, mode }) {
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  const head = front ? front[0] : '';
  let body = text.slice(head.length);

  let tail = '';
  const lines = body.split('\n');
  const cut = lines.findIndex((l) => TRANSCRIPT_HEADING.test(l));
  if (cut !== -1) {
    tail = `\n${lines.slice(cut).join('\n')}`;
    body = lines.slice(0, cut).join('\n');
  }

  return head + linkifyBody(body, { names, targets, mode }) + tail;
}
