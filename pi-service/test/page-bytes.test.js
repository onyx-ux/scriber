import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The bytes of the source, and the one breakpoint that was measured wrong.
//
// Two faults sat in "Known faults" for weeks and both were invisible: a file
// whose line endings disagreed with the rest of the repo, and a top bar that
// pushed the page sideways only between 821px and 1023px. Neither shows up in
// a rendered page, a screenshot or any other test here, so both are checked
// on the text itself.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HTML = ROOT + 'dashboard/html/index.html';

// --- the invisible bytes -------------------------------------------------

// Every source file in this repo is LF and contains no NUL, and .gitattributes
// says so. This is the same claim enforced where somebody will meet it: git
// only normalises what it is handed, so a tool that writes CRLF back into the
// working tree is caught on the next run rather than on the next patch that
// mysteriously fails to match a string that looks right on screen.
//
// The NUL half is not hypothetical either. syncParts() joined two fields on a
// literal NUL byte typed into the file, and the cost was not that it broke —
// it works — but that grep, diff and every other text tool then classified an
// 8,000-line page as binary and skipped it in silence. It sat out the
// repo-wide line-ending sweep that was looking for exactly this.

const SOURCE_DIRS = [
  'pi-service/src',
  'pi-service/test',
  'dashboard/html',
  'dashboard/templates',
];

// Bytes rather than text, and the one file here that is legitimately both.
const BINARY = /\.(png|jpg|jpeg|gif|ico|woff2?)$/i;

async function* sourceFiles(dir) {
  const here = ROOT + dir;
  for (const entry of await readdir(here, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) yield* sourceFiles(rel);
    else if (!BINARY.test(entry.name)) yield rel;
  }
}

// Tab, newline, and nothing else below a space. A source file has no business
// carrying a raw control character, and four of the five found here were doing
// real work — a NUL delimiter, a NUL-to-unit-separator range — which is the
// point: they were CORRECT, and still wrong to type as bytes.
const PRINTABLE = (b) => b >= 0x20 || b === 0x09 || b === 0x0a;

test('every source file is LF and carries no raw control characters', async () => {
  const crlf = [];
  const control = [];
  let seen = 0;

  for (const dir of SOURCE_DIRS) {
    for await (const rel of sourceFiles(dir)) {
      seen += 1;
      const bytes = await readFile(ROOT + rel);
      for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 0x0d) {
          if (bytes[i + 1] === 0x0a) { crlf.push(rel); break; }
          control.push(`${rel} (lone CR at byte ${i})`);
          break;
        }
        if (!PRINTABLE(bytes[i]) || bytes[i] === 0x7f) {
          control.push(`${rel} (0x${bytes[i].toString(16).padStart(2, '0')} at byte ${i})`);
          break;
        }
      }
    }
  }

  assert.ok(seen > 150, `only ${seen} source files found — the walk is looking in the wrong place`);
  assert.deepEqual(crlf, [], `CRLF has come back into: ${crlf.join(', ')} — run dos2unix on them`);
  assert.deepEqual(
    control,
    [],
    `a raw control character was typed into: ${control.join(', ')} — write it as an escape ` +
      '(\\u0000, \\x1f) instead. It works either way; what it costs is that every text tool ' +
      'then calls the file binary and skips it in silence.'
  );
});

// --- the band between a phone and a laptop -------------------------------

test('the top bar releases its height in the same breakpoint that lets it wrap', async () => {
  const page = await readFile(HTML, 'utf8');

  // The bar needs 1018px at its narrowest and was pinned to one 76px row until
  // 820, so every width in between scrolled the whole page sideways. It wraps
  // from 1023 down now — and the height has to come off in the SAME rule.
  // Wrapping inside a bar still declaring `flex: 0 0 76px` is how the first
  // attempt at this failed: a second row appeared and the pause buttons on it
  // came out sliced along the top.
  const band = page.match(/@media \(max-width: 1023px\) \{([\s\S]*?)\n  \}/);
  assert.ok(band, 'the 1023px band is gone — the page scrolls sideways again between 821 and 1023');

  const rules = band[1];
  assert.match(rules, /\.top \{[^}]*flex-wrap: wrap/, 'the bar no longer wraps in the band');
  assert.match(rules, /\.top \{[^}]*height: auto/, 'the bar wraps but is still pinned to one row height');
  assert.match(rules, /\.top \{[^}]*flex: none/, 'the bar wraps but its flex basis still pins it');

  // The controls have to give up their right-hand berth too, or the second row
  // hangs off the right of the page with the quill above nothing.
  assert.match(rules, /\.top \.right \{[^}]*margin-left: 0/);

  // And it is said once. These two rules used to live in the phone block as
  // well; the narrower block is contained by this one, so a copy down there is
  // a second place to change and the one that never gets changed.
  const phone = page.match(/@media \(max-width: 820px\) \{([\s\S]*?)\n  \}/);
  assert.ok(phone, 'the phone block is gone');
  assert.doesNotMatch(phone[1], /\.top \.right \{/, 'the wrap rule is back in two places');
});
