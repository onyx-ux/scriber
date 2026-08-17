import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository is UTF-8, and the machine it is edited on can silently break
// that.
//
// One specific failure, which has already happened once: a tool that reads a
// BOM-less UTF-8 file as Windows-1252 decodes an em dash (E2 80 94) as three
// separate Latin-1 characters and, on save, writes all three back as UTF-8. The
// damage is permanent in the bytes, invisible in any viewer that renders it,
// and shipped to the browser before anybody noticed.
//
// Every pattern below is written as escapes rather than as the characters
// themselves, so this file does not trip its own check. The alternative was to
// exclude it from the walk, and an exclusion is a hole — the guard would stop
// covering the one file somebody is most likely to edit while thinking about
// encodings.
//
// This used to guard the dashboard alone, which was the file it happened to. It
// now walks everything tracked, because nothing about that accident was
// specific to that file — it was specific to the editor.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Text this project actually authors. Binaries and dependencies are not our
// encoding to answer for.
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.conf', '.template', '.sh']);
const SKIP = new Set(['node_modules', '.git', 'data', 'backups', 'dist', 'coverage']);

// The signatures of UTF-8 read as Windows-1252:
//   U+00E2 U+20AC  the dashes and the smart quotes
//   U+00C2 + C1    non-breaking space and friends
//   U+00C3 + C1    accented letters, which matter here because players have
//                  names like Sáfriel
const MOJIBAKE = new RegExp('\u00e2\u20ac|\u00c2[\x80-\xbf\s]|\u00c3[\x80-\xbf]');

// The residue of an encoding accident the pattern above did not happen to
// match — U+FFFD, the replacement character.
const REPLACEMENT = '\ufffd';

async function textFiles(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (SKIP.has(entry.name)) continue;

    const path = join(dir, entry.name);
    if (entry.isDirectory()) await textFiles(path, found);
    else if (TEXT.has(extname(entry.name))) found.push(path);
  }
  return found;
}

test('no tracked text file has been round-tripped through Windows-1252', async () => {
  const files = await textFiles(ROOT);
  assert.ok(files.length > 40, `expected to find the tree, found ${files.length} files`);

  const damaged = [];
  for (const path of files) {
    const text = await readFile(path, 'utf8');
    const hit = MOJIBAKE.exec(text);
    if (hit) {
      damaged.push(`${path.slice(ROOT.length)} @ ${hit.index}: ${JSON.stringify(text.slice(hit.index - 25, hit.index + 25))}`);
    }
  }

  assert.deepEqual(damaged, [], `mojibake found:\n${damaged.join('\n')}`);
});

// The other half of the same accident: the tool that corrupts the text also
// announces itself by adding a BOM.
test('no tracked text file carries a UTF-8 BOM', async () => {
  const files = await textFiles(ROOT);
  const stamped = [];

  for (const path of files) {
    const bytes = await readFile(path);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) stamped.push(path.slice(ROOT.length));
  }

  assert.deepEqual(stamped, [], `a BOM means something rewrote the whole file:\n${stamped.join('\n')}`);
});

// A stray replacement character is the residue of an encoding accident the
// pattern above did not happen to match.
test('no tracked text file contains a replacement character', async () => {
  const files = await textFiles(ROOT);
  const broken = [];

  for (const path of files) {
    const text = await readFile(path, 'utf8');
    if (text.includes(REPLACEMENT)) broken.push(path.slice(ROOT.length));
  }

  assert.deepEqual(broken, [], `U+FFFD means bytes were decoded as the wrong encoding:\n${broken.join('\n')}`);
});

// A canary rather than a coincidence: this project writes prose in its comments
// and uses em dashes throughout. If they all vanish, something has mangled them
// rather than somebody having removed them on purpose.
test('the em dashes are still there', async () => {
  const page = await readFile(join(ROOT, 'dashboard', 'html', 'index.html'), 'utf8');
  assert.ok(page.includes('—'), 'the dashboard lost its em dashes, which is what the corruption looks like');
});
