import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { archiveSessionAudio } from '../src/pipeline/session-recording.js';
import { writePcmWav } from '../src/pipeline/wav-merge.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function session(t, { clips = 3 } = {}) {
  const audioDir = await mkdtemp(join(tmpdir(), 'scriber-arch-'));
  t.after(() => rm(audioDir, { recursive: true, force: true }));

  await mkdir(join(audioDir, 'u1'), { recursive: true });
  await mkdir(join(audioDir, 'u2'), { recursive: true });

  const captured = [];
  for (let i = 0; i < clips; i++) {
    const userId = i % 2 === 0 ? 'u1' : 'u2';
    const wavPath = join(audioDir, userId, `${i * 2000}.wav`);
    await writeFile(wavPath, writePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, Buffer.alloc(32_000)));
    captured.push({ userId, displayName: userId, wavPath, startMs: i * 2000, endMs: i * 2000 + 1000 });
  }

  return { audioDir, captured };
}

// THE safety property. Deleting the fragments is only ever justified by an
// archive that actually exists — otherwise a broken ffmpeg would quietly
// destroy the session it was supposed to be preserving.
test('a failed archive leaves every fragment in place', async (t) => {
  const { audioDir, captured } = await session(t);

  // Point at an ffmpeg that cannot exist, so compression always fails.
  const originalPath = process.env.PATH;
  process.env.PATH = join(audioDir, 'no-binaries-here');
  t.after(() => {
    process.env.PATH = originalPath;
  });

  await assert.rejects(() => archiveSessionAudio(captured, audioDir));

  assert.equal(await exists(join(audioDir, 'u1')), true, 'speaker folders must survive a failed archive');
  assert.equal(await exists(join(audioDir, 'u2')), true);
  for (const u of captured) {
    assert.equal(await exists(u.wavPath), true, `${u.wavPath} was destroyed by a failed archive`);
  }
});

test('a session with nothing in it archives to nothing and deletes nothing', async (t) => {
  const { audioDir } = await session(t, { clips: 0 });
  assert.equal(await archiveSessionAudio([], audioDir), null);
  assert.equal(await exists(join(audioDir, 'u1')), true, 'no archive means no licence to delete');
});

test('the archive replaces the fragments in the same directory', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, async (t) => {
  const { audioDir, captured } = await session(t);

  const archive = await archiveSessionAudio(captured, audioDir);
  assert.ok(archive, 'an archive was produced');
  assert.ok(archive.bytes > 0, 'and it has content');
  assert.equal(archive.speakerDirsRemoved, 2);

  assert.equal(await exists(archive.mp3Path), true, 'the archive itself stays');
  assert.equal(await exists(join(audioDir, 'u1')), false, 'the fragments are gone');
  assert.equal(await exists(join(audioDir, 'u2')), false);

  // It must live inside audio_dir, because that directory is exactly what the
  // retention timer deletes — an archive written anywhere else would never
  // age out and would quietly fill the Pi's disk forever.
  const left = await readdir(audioDir);
  assert.deepEqual(left, ['session-full.mp3']);

  // The intermediate uncompressed WAV must not be left behind; it is several
  // times larger than the archive it was made for.
  assert.equal(await exists(join(audioDir, 'session-full.wav')), false);
});
