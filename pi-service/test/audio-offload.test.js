import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { offloadArchive } from '../src/pipeline/finish-session.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scriber-offload-'));
  const sessionDir = join(root, 'session');
  await mkdir(sessionDir, { recursive: true });
  const mp3Path = join(sessionDir, '2026-08-05.mp3');
  await writeFile(mp3Path, 'pretend audio');
  return { root, mp3Path, outbox: join(root, 'outbox') };
}

test('with no outbox configured the recording is left exactly where it is', async () => {
  const { mp3Path } = await fixture();
  assert.equal(await offloadArchive(mp3Path, 12, {}), null);
  assert.equal(await readFile(mp3Path, 'utf8'), 'pretend audio', 'the only copy must survive an unconfigured offload');
});

test('the recording is moved out of the Pi, not copied', async () => {
  const { mp3Path, outbox } = await fixture();

  const target = await offloadArchive(mp3Path, 12, { audioOffloadDir: outbox });

  assert.equal(await readFile(target, 'utf8'), 'pretend audio');
  await assert.rejects(stat(mp3Path), { code: 'ENOENT' }, 'leaving the original behind defeats the point — the Pi is out of space');
});

// Once it is sitting in a flat outbox on another machine, the filename is the
// only thing left that says which session it was.
test('the offloaded name identifies the session on its own', async () => {
  const { mp3Path, outbox } = await fixture();
  await offloadArchive(mp3Path, 12, { audioOffloadDir: outbox });

  const [name] = await readdir(outbox);
  assert.match(name, /session-12-/);
  assert.match(name, /\.mp3$/);
});

test('two sessions recorded on the same date do not overwrite each other', async () => {
  const { mp3Path, outbox } = await fixture();
  await offloadArchive(mp3Path, 12, { audioOffloadDir: outbox });

  const second = await fixture();
  await offloadArchive(second.mp3Path, 13, { audioOffloadDir: outbox });

  assert.equal((await readdir(outbox)).length, 2, 'same basename, different meeting — both must survive');
});

test('a missing outbox is created rather than failing the handover', async () => {
  const { mp3Path, root } = await fixture();
  const nested = join(root, 'does', 'not', 'exist');

  const target = await offloadArchive(mp3Path, 12, { audioOffloadDir: nested });
  assert.equal(await readFile(target, 'utf8'), 'pretend audio');
});

// rename() cannot cross a filesystem boundary, and putting the outbox on a
// USB disk or a different mount is a plausible thing to do. That must stay a
// configuration choice, not a silent failure to free any space.
const failingRename = (code) => async () => {
  const err = new Error(code);
  err.code = code;
  throw err;
};

test('a cross-filesystem outbox falls back to copy+delete', async () => {
  const { mp3Path, outbox } = await fixture();
  const { copyFile, unlink } = await import('node:fs/promises');

  const target = await offloadArchive(mp3Path, 12, { audioOffloadDir: outbox }, {
    rename: failingRename('EXDEV'),
    copyFile,
    unlink,
  });

  assert.equal(await readFile(target, 'utf8'), 'pretend audio', 'the copy has to actually contain the recording');
  await assert.rejects(stat(mp3Path), { code: 'ENOENT' }, 'copy without delete frees nothing on the Pi');
});

test('an unexpected filesystem error is not swallowed as a successful move', async () => {
  const { mp3Path, outbox } = await fixture();
  const { copyFile, unlink } = await import('node:fs/promises');

  await assert.rejects(
    offloadArchive(mp3Path, 12, { audioOffloadDir: outbox }, { rename: failingRename('EACCES'), copyFile, unlink }),
    { code: 'EACCES' }
  );
  assert.equal(await readFile(mp3Path, 'utf8'), 'pretend audio', 'a failed offload must leave the recording intact');
});
