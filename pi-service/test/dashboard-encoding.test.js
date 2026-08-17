import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The dashboard is one hand-written UTF-8 file full of em dashes, and it is
// edited from a Windows machine. That combination has one specific failure:
// a tool that reads a BOM-less UTF-8 file as Windows-1252 turns every "—"
// (E2 80 94) into "â€"" and, on save, writes those three characters back as
// UTF-8 — so the corruption is permanent, invisible in a diff viewer that
// renders it, and only shows up as garbage in the browser.
//
// It has happened once. This is the check that it does not happen twice.

const PAGE = fileURLToPath(new URL('../../dashboard/html/index.html', import.meta.url));

// The signatures of UTF-8 read as Windows-1252. "â€" covers the dashes and the
// smart quotes; "Â " covers non-breaking space; "Ã" covers accented letters,
// which matter here because players have names like Sáfriel.
const MOJIBAKE = /â€|Â[\x80-\xBF\s]|Ã[\x80-\xBF]/;

test('the dashboard is UTF-8 and has not been round-tripped through Windows-1252', async () => {
  const bytes = await readFile(PAGE);
  const text = bytes.toString('utf8');

  const found = MOJIBAKE.exec(text);
  assert.equal(
    found,
    null,
    found
      ? `mojibake at offset ${found.index}: ${JSON.stringify(text.slice(found.index - 30, found.index + 30))}`
      : ''
  );

  // A BOM is the other half of the same accident: the tool that corrupts the
  // text also announces itself by adding one.
  assert.notEqual(
    `${bytes[0]},${bytes[1]},${bytes[2]}`,
    '239,187,191',
    'the page has a UTF-8 BOM — it was saved by something that rewrote the whole file'
  );

  // A canary rather than a coincidence: if the em dashes survive, the encoding
  // survived. If somebody legitimately removes every one of them, this fails
  // loudly and can be deleted on purpose.
  assert.ok(text.includes('—'), 'expected em dashes in the page; their absence means they were mangled');
});

// Every non-ASCII character in the file should be one somebody meant to type.
// A stray C1 control or a lone replacement character is the residue of an
// encoding accident that the pattern above did not happen to match.
test('the dashboard contains no replacement characters or stray controls', async () => {
  const text = await readFile(PAGE, 'utf8');

  assert.equal(text.includes('�'), false, 'U+FFFD means bytes were decoded as the wrong encoding somewhere');
  const control = /[-]/.exec(text);
  assert.equal(control, null, control ? `C1 control at offset ${control.index}` : '');
});
