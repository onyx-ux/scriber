import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { callModel } from '../src/pipeline/model-client.js';

// These run against a REAL http server rather than a stubbed fetch, because
// the transport is the thing under test: the bug being guarded here was
// Node's fetch imposing a 300s headersTimeout that silently killed slow
// Ollama requests, so a test that stubs fetch away would prove nothing.
async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const cfg = {
    summaryProvider: 'ollama',
    ollamaUrl: `http://127.0.0.1:${server.address().port}`,
    ollamaModel: 'qwen2.5:14b',
    ollamaNumCtx: 9216,
    ollamaKeepAlive: '30m',
  };
  try {
    return await run(cfg);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const ndjson = (objects) => objects.map((o) => JSON.stringify(o)).join('\n') + '\n';

const CHUNKS = [
  { message: { content: 'The party ' }, done: false },
  { message: { content: 'entered the ' }, done: false },
  { message: { content: 'crypt.' }, done: false },
  { message: { content: '' }, done: true, prompt_eval_count: 500 },
];

const readRequest = async (req) => {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body);
};

test('the request streams, pins the context, and holds the model in VRAM', async () => {
  let seen = null;
  await withServer(
    async (req, res) => {
      seen = await readRequest(req);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(ndjson(CHUNKS));
    },
    async (cfg) => {
      await callModel('sys', 'user', cfg, 60_000);
      assert.equal(seen.stream, true);
      assert.equal(seen.options.num_ctx, 9216);
      // Without this the model can be evicted between slices of one job, and
      // the next slice pays a cold load measured at 570s on this hardware.
      assert.equal(seen.keep_alive, '30m');
      assert.equal(seen.messages[0].content, 'sys');
    }
  );
});

test('streamed chunks are reassembled into the full message', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(ndjson(CHUNKS));
    },
    async (cfg) => assert.equal(await callModel('s', 'u', cfg, 60_000), 'The party entered the crypt.')
  );
});

// A chunk boundary mid-JSON would throw a parse error if buffering were wrong,
// losing a summary that had already been generated.
test('a response split at awkward byte boundaries still parses', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      const bytes = Buffer.from(ndjson(CHUNKS));
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    },
    async (cfg) => assert.equal(await callModel('s', 'u', cfg, 60_000), 'The party entered the crypt.')
  );
});

test('a final line without a trailing newline is not dropped', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(CHUNKS.map((o) => JSON.stringify(o)).join('\n'));
    },
    async (cfg) => assert.equal(await callModel('s', 'u', cfg, 60_000), 'The party entered the crypt.')
  );
});

// THE regression this transport exists for. Node's fetch would abort this at
// 300s no matter what timeout was configured; a cold Ollama model load was
// measured at 570s, so every such request died.
test('headers arriving long after the request are NOT cut off at a hidden deadline', async () => {
  await withServer(
    (req, res) => {
      // Well past undici's 300s headersTimeout, scaled down so the test is
      // quick: what matters is that no deadline other than ours exists.
      setTimeout(() => {
        res.writeHead(200);
        res.end(ndjson(CHUNKS));
      }, 300);
    },
    async (cfg) => {
      const text = await callModel('s', 'u', cfg, 60_000);
      assert.equal(text, 'The party entered the crypt.', 'a slow first byte must not fail the request');
    }
  );
});

test('our own timeout still applies and is reported as a timeout', async () => {
  await withServer(
    () => {
      /* never respond at all */
    },
    async (cfg) => await assert.rejects(() => callModel('s', 'u', cfg, 300), /timed out after/)
  );
});

test('an error inside the stream fails loudly rather than truncating', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(ndjson([{ message: { content: 'partial' }, done: false }, { error: 'model requires more system memory' }]));
    },
    async (cfg) =>
      await assert.rejects(
        () => callModel('s', 'u', cfg, 60_000),
        /more system memory/,
        'a half-generated summary must never be stored as if it were complete'
      )
  );
});

test('an empty stream is an error, not an empty summary', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(ndjson([{ message: { content: '' }, done: true }]));
    },
    async (cfg) => await assert.rejects(() => callModel('s', 'u', cfg, 60_000), /no message content/)
  );
});

test('an HTTP error is reported with its status and body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404);
      res.end('model not found');
    },
    async (cfg) => await assert.rejects(() => callModel('s', 'u', cfg, 60_000), /HTTP 404.*model not found/s)
  );
});

// "fetch failed" gave no way to tell a powered-off PC from a slow one; this
// string is what lands in the job's last_error column.
test('a refused connection names the real cause', async () => {
  const cfg = {
    summaryProvider: 'ollama',
    // Port 1 is reserved and nothing listens on it.
    ollamaUrl: 'http://127.0.0.1:1',
    ollamaModel: 'm',
    ollamaNumCtx: 4096,
    ollamaKeepAlive: '30m',
  };
  await assert.rejects(() => callModel('s', 'u', cfg, 5_000), /ECONNREFUSED/);
});

test('truncation is still detected from the terminating chunk', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(ndjson(CHUNKS));
    },
    async (cfg) => {
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (m) => warnings.push(String(m));
      try {
        await callModel('s', 'u', cfg, 60_000, { estTokens: () => 2500 });
      } finally {
        console.warn = realWarn;
      }
      assert.match(warnings.join('\n'), /possible context truncation/);
    }
  );
});
