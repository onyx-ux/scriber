import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callModel } from '../src/pipeline/model-client.js';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const cfg = {
  summaryProvider: 'ollama',
  ollamaUrl: 'http://pc.local:11434',
  ollamaModel: 'qwen2.5:14b',
  ollamaNumCtx: 9216,
};

// Build an NDJSON body the way Ollama streams it, optionally splitting the
// bytes at awkward places to prove the line buffering survives it.
function ndjsonResponse(objects, { splitEvery = null } = {}) {
  const text = objects.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);

  const stream = new ReadableStream({
    start(controller) {
      const size = splitEvery ?? bytes.length;
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

const chunks = [
  { message: { content: 'The party ' }, done: false },
  { message: { content: 'entered the ' }, done: false },
  { message: { content: 'crypt.' }, done: false },
  { message: { content: '' }, done: true, prompt_eval_count: 500 },
];

// The whole point of the change: a non-streaming request makes Ollama withhold
// its headers until generation finishes, and undici kills that at 300s no
// matter what timeout we pass in.
test('the request asks Ollama to stream', async () => {
  let sentBody = null;
  global.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return ndjsonResponse(chunks);
  };

  await callModel('sys', 'user', cfg, 60_000);
  assert.equal(sentBody.stream, true, 'stream:false reintroduces the 5-minute undici ceiling');
  assert.equal(sentBody.options.num_ctx, 9216, 'the context size must still be sent');
});

test('streamed chunks are reassembled into the full message', async () => {
  global.fetch = async () => ndjsonResponse(chunks);
  assert.equal(await callModel('sys', 'user', cfg, 60_000), 'The party entered the crypt.');
});

// A chunk boundary in the middle of a JSON line would throw a parse error if
// the buffering were wrong, losing a summary that had already been generated.
test('a response split mid-line still parses', async () => {
  global.fetch = async () => ndjsonResponse(chunks, { splitEvery: 7 });
  assert.equal(await callModel('sys', 'user', cfg, 60_000), 'The party entered the crypt.');
});

test('a final line arriving without a trailing newline is not dropped', async () => {
  global.fetch = async () => {
    const text = chunks.map((o) => JSON.stringify(o)).join('\n'); // no trailing \n
    return new Response(text, { status: 200 });
  };
  assert.equal(await callModel('sys', 'user', cfg, 60_000), 'The party entered the crypt.');
});

// Ollama reports mid-stream failures in the body, after a 200 has been sent.
test('an error inside the stream fails loudly rather than truncating', async () => {
  global.fetch = async () =>
    ndjsonResponse([
      { message: { content: 'partial' }, done: false },
      { error: 'model requires more system memory' },
    ]);

  await assert.rejects(
    () => callModel('sys', 'user', cfg, 60_000),
    /more system memory/,
    'a half-generated summary must never be stored as if it were complete'
  );
});

test('an empty stream is an error, not an empty summary', async () => {
  global.fetch = async () => ndjsonResponse([{ message: { content: '' }, done: true }]);
  await assert.rejects(() => callModel('sys', 'user', cfg, 60_000), /no message content/);
});

test('an HTTP error is still reported with its status', async () => {
  global.fetch = async () => new Response('model not found', { status: 404 });
  await assert.rejects(() => callModel('sys', 'user', cfg, 60_000), /HTTP 404/);
});

// "fetch failed" on its own gave no way to tell a powered-off PC from a slow
// one; this is what lands in the job's last_error column.
test('the underlying cause is surfaced instead of a bare "fetch failed"', async () => {
  global.fetch = async () => {
    const err = new Error('fetch failed');
    err.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    throw err;
  };

  await assert.rejects(() => callModel('sys', 'user', cfg, 60_000), /fetch failed \(ECONNREFUSED\)/);
});

test('our own timeout is reported as a timeout', async () => {
  global.fetch = async (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

  await assert.rejects(() => callModel('sys', 'user', cfg, 50), /timed out after/);
});

test('truncation is still detected from the terminating chunk', async () => {
  global.fetch = async () => ndjsonResponse(chunks);

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    // prompt_eval_count is 500 in the final chunk, so claiming ~5000 tokens
    // were sent means Ollama silently dropped most of the transcript.
    await callModel('sys', 'user', cfg, 60_000, { estTokens: () => 2500 });
  } finally {
    console.warn = realWarn;
  }

  assert.match(warnings.join('\n'), /possible context truncation/);
});
