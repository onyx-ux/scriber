import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transcribeWav, isWhisperServerReachable } from '../src/stt/whisper.js';
import { writePcmWav } from '../src/pipeline/wav-merge.js';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const serverCfg = {
  whisperServerUrl: 'http://pc.local:8089',
  whisperServerTimeoutMs: 5000,
  whisperLocalFallback: true,
  // A whisper binary that cannot exist, so any fallback to local is obvious.
  whisperBin: '/nonexistent/whisper',
  whisperModelPath: '/nonexistent/model',
  whisperThreads: 4,
};

async function withClip(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-wsrv-'));
  const path = join(dir, 'clip.wav');
  await writeFile(path, writePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }, Buffer.alloc(3200)));
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The server speaks OpenAI's verbose_json, where times are SECONDS. The local
// CLI reports MILLISECONDS. Everything downstream (notably /import splitting a
// long recording into utterances) assumes ms, so getting this wrong would
// silently compress a whole session into the first second of its timeline.
test('server segment times are converted from seconds to milliseconds', async () => {
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        text: 'hello there',
        segments: [
          { text: ' hello', start: 1.5, end: 2.25 },
          { text: ' there', start: 2.25, end: 3.0 },
        ],
      }),
      { status: 200 }
    );

  await withClip(async (path) => {
    const { text, segments } = await transcribeWav(path, serverCfg);
    assert.equal(text, 'hello there');
    assert.deepEqual(segments, [
      { text: 'hello', fromMs: 1500, toMs: 2250 },
      { text: 'there', fromMs: 2250, toMs: 3000 },
    ]);
  });
});

test('a missing top-level text field falls back to joining the segments', async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ segments: [{ text: ' one', start: 0, end: 1 }, { text: ' two', start: 1, end: 2 }] }), {
      status: 200,
    });

  await withClip(async (path) => {
    const { text } = await transcribeWav(path, serverCfg);
    assert.equal(text, 'one two', 'a transcript must never come back silently empty');
  });
});

test('empty segments are dropped rather than becoming blank transcript lines', async () => {
  global.fetch = async () =>
    new Response(JSON.stringify({ text: 'a', segments: [{ text: '  ', start: 0, end: 1 }, { text: ' a', start: 1, end: 2 }] }), {
      status: 200,
    });

  await withClip(async (path) => {
    const { segments } = await transcribeWav(path, serverCfg);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'a');
  });
});

test('the request is a multipart POST to /inference asking for verbose_json', async () => {
  let seenUrl = null;
  let seenMethod = null;
  let seenFormat = null;

  global.fetch = async (url, opts) => {
    seenUrl = String(url);
    seenMethod = opts.method;
    seenFormat = opts.body.get('response_format');
    assert.ok(opts.body.get('file'), 'the audio itself must be attached');
    return new Response(JSON.stringify({ text: 'x', segments: [] }), { status: 200 });
  };

  await withClip(async (path) => {
    await transcribeWav(path, serverCfg);
    assert.equal(seenUrl, 'http://pc.local:8089/inference');
    assert.equal(seenMethod, 'POST');
    // Only verbose_json returns per-segment timings, which /import needs.
    assert.equal(seenFormat, 'verbose_json');
  });
});

test('a trailing slash on the configured URL does not produce a double slash', async () => {
  let seenUrl = null;
  global.fetch = async (url) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ text: 'x', segments: [] }), { status: 200 });
  };

  await withClip(async (path) => {
    await transcribeWav(path, { ...serverCfg, whisperServerUrl: 'http://pc.local:8089/' });
    assert.equal(seenUrl, 'http://pc.local:8089/inference');
  });
});

// The GPU machine being off is the expected everyday case, not an exception.
test('an unreachable server falls back to the local CPU path', async () => {
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };

  await withClip(async (path) => {
    // Local whisper is a binary that does not exist, so a fallback attempt
    // surfaces as that spawn failure — proving it fell back rather than
    // silently returning an empty transcript.
    await assert.rejects(() => transcribeWav(path, serverCfg), /ENOENT|nonexistent/);
  });
});

test('with fallback disabled the server error propagates instead', async () => {
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };

  await withClip(async (path) => {
    await assert.rejects(
      () => transcribeWav(path, { ...serverCfg, whisperLocalFallback: false }),
      /ECONNREFUSED/,
      'the real cause must be reported, not masked by a local spawn error'
    );
  });
});

test('an HTTP error from the server is treated as a failure, not an empty transcript', async () => {
  global.fetch = async () => new Response('model not loaded', { status: 500 });

  await withClip(async (path) => {
    await assert.rejects(
      () => transcribeWav(path, { ...serverCfg, whisperLocalFallback: false }),
      /HTTP 500/
    );
  });
});

test('no server configured goes straight to local without touching the network', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };

  await withClip(async (path) => {
    await assert.rejects(() => transcribeWav(path, { ...serverCfg, whisperServerUrl: null }));
    assert.equal(called, false, 'must not call out when no server is configured');
  });
});

test('word-level segmentation is requested only when asked for', async () => {
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ max_len: opts.body.get('max_len'), split: opts.body.get('split_on_word') });
    return new Response(JSON.stringify({ text: 'x', segments: [] }), { status: 200 });
  };

  await withClip(async (path) => {
    await transcribeWav(path, serverCfg);
    assert.equal(seen[0].max_len, null, 'a single clip needs no word-level split');

    await transcribeWav(path, serverCfg, { wordLevel: true });
    assert.equal(seen[1].max_len, '1');
    assert.equal(seen[1].split, 'true');
  });
});

test('reachability reports false without a configured server, and never throws', async () => {
  assert.equal(await isWhisperServerReachable({ whisperServerUrl: null }), false);

  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await isWhisperServerReachable(serverCfg), false);

  global.fetch = async () => new Response('ok', { status: 200 });
  assert.equal(await isWhisperServerReachable(serverCfg), true);
});
