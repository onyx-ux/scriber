import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { finishSession } from '../src/pipeline/finish-session.js';
import { writePcmWav } from '../src/pipeline/wav-merge.js';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Transcription goes through the whisper HTTP server, so a stubbed fetch is
// enough to make a session succeed without whisper being installed.
function stubWhisper({ succeed = true } = {}) {
  global.fetch = async () => {
    if (!succeed) return new Response('model exploded', { status: 500 });
    return new Response(
      JSON.stringify({ text: 'we open the crypt', segments: [{ text: ' we open the crypt', start: 0, end: 1 }] }),
      { status: 200 }
    );
  };
}

const baseCfg = {
  whisperServerUrl: 'http://pc.local:8089',
  whisperServerTimeoutMs: 5000,
  whisperLocalFallback: false,
  transcribeBatching: false,
  summaryRequireApproval: true,
  driveSyncEnabled: false,
  driveSyncAudio: false,
};

async function scenario(t, cfg) {
  const root = await mkdtemp(join(tmpdir(), 'scriber-life-'));
  const db = openDb(join(root, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const audioDir = join(root, 'audio', 'meeting-1');
  await mkdir(join(audioDir, 'u1'), { recursive: true });
  const wavPath = join(audioDir, 'u1', '0.wav');
  await writeFile(wavPath, writePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, Buffer.alloc(32000)));

  const meetingId = db.createMeeting({
    guildId: 'G1',
    channelId: 'C1',
    channelName: 'Cipher',
    startedAt: '2026-08-01T10:00:00Z',
    audioDir,
  });

  const captured = [{ userId: 'u1', displayName: 'Koru', wavPath, startMs: 0, endMs: 1000 }];
  const result = await finishSession(db, meetingId, captured, audioDir, { ...baseCfg, ...cfg });
  return { db, meetingId, audioDir, result };
}

// The audio directory itself must survive: it now holds the archive, and
// AUDIO_RETENTION_DAYS is what eventually removes it.
test('the audio directory outlives the transcript, for retention to age out', async (t) => {
  stubWhisper();
  const { audioDir, result, db, meetingId } = await scenario(t, { audioArchive: false });

  assert.equal(result.ok, true);
  assert.equal(await exists(audioDir), true, 'nothing is deleted at commit time any more');
  assert.equal(db.listUtterances(meetingId).length, 1);
});

// THE case that must never regress: destroying audio for a session we failed
// to transcribe would lose the only copy of it, with nothing to show for it.
test('failed transcription leaves the audio completely untouched', async (t) => {
  stubWhisper({ succeed: false });
  const { audioDir, result, db, meetingId } = await scenario(t, { audioArchive: true });

  assert.equal(result.ok, false, 'precondition: transcription failed');
  assert.equal(await exists(join(audioDir, 'u1')), true, 'the raw clips are the only copy — they must stay');
  assert.equal(db.getMeeting(meetingId).status, 'transcription_failed');
});

// Pinning matters because the queue worker reads the global config: without
// it, a session transcribed on the Pi would queue against an Ollama that is
// on the PC we just established is switched off.
test('a pinned provider is recorded on the job', async (t) => {
  stubWhisper();
  const root = await mkdtemp(join(tmpdir(), 'scriber-pin-'));
  const db = openDb(join(root, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const audioDir = join(root, 'audio');
  await mkdir(join(audioDir, 'u1'), { recursive: true });
  const wavPath = join(audioDir, 'u1', '0.wav');
  await writeFile(wavPath, writePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, Buffer.alloc(32000)));

  const meetingId = db.createMeeting({
    guildId: 'G1',
    channelId: 'C1',
    channelName: 'Cipher',
    startedAt: '2026-08-01T10:00:00Z',
    audioDir,
  });

  const captured = [{ userId: 'u1', displayName: 'Koru', wavPath, startMs: 0, endMs: 1000 }];
  const { job } = await finishSession(db, meetingId, captured, audioDir, { ...baseCfg, audioArchive: false }, {
    pinProvider: 'gemini',
  });

  const row = db.raw.prepare('SELECT provider FROM jobs WHERE id = ?').get(job.id);
  assert.equal(row.provider, 'gemini');
});

test('with no pin the job defers to the configured provider', async (t) => {
  stubWhisper();
  const { db, meetingId } = await scenario(t, { audioArchive: false });
  const row = db.raw.prepare('SELECT provider FROM jobs WHERE meeting_id = ?').get(meetingId);
  assert.equal(row.provider, null, 'null means "whatever the config says at run time"');
});
