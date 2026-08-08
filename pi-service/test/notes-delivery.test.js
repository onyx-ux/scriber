import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { postSessionNotes } from '../src/delivery/discord-post.js';

// The notes are sent as several text messages followed by the transcript as
// an attachment. If the attachment throws, the text has ALREADY been posted —
// so letting it fail the job means the summariser re-runs (real API cost) and
// the same recap is posted again on every retry, forever, for a permission
// no amount of retrying can change. Observed live: the bot had SendMessages
// but not AttachFiles in the notes channel.

const meeting = { id: 16, channel_id: 'C1', channel_name: 'Session', started_at: '2026-08-08T10:00:00Z' };
const notes = { tldr: 'The party descended into the citadel.' };

async function mdFile() {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-notes-'));
  const path = join(dir, 'session-16.md');
  await writeFile(path, '# Session 16\n');
  return path;
}

function fakeChannel({ failAttachment = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(payload) {
      if (payload.files) {
        if (failAttachment) {
          const err = new Error('Missing Permissions');
          err.code = 50013;
          throw err;
        }
        sent.push({ kind: 'attachment' });
        return;
      }
      sent.push({ kind: 'text', content: payload.content });
    },
  };
}

const clientFor = (channel) => ({ channels: { fetch: async () => channel } });

test('notes and the transcript are both delivered when permissions allow', async () => {
  const channel = fakeChannel();
  await postSessionNotes({
    discordClient: clientFor(channel),
    meeting,
    notes,
    mdPath: await mdFile(),
    cfg: {},
  });

  assert.ok(channel.sent.some((m) => m.kind === 'text'));
  assert.equal(channel.sent.filter((m) => m.kind === 'attachment').length, 1);
});

test('a blocked attachment does not throw away the whole delivery', async () => {
  const channel = fakeChannel({ failAttachment: true });

  await assert.doesNotReject(
    postSessionNotes({
      discordClient: clientFor(channel),
      meeting,
      notes,
      mdPath: await mdFile(),
      cfg: {},
    }),
    'throwing here re-runs the summariser and re-posts the recap on every retry'
  );

  assert.ok(channel.sent.some((m) => m.kind === 'text'), 'the recap still goes out');
});

test('the recap is posted exactly once even when the attachment fails', async () => {
  const channel = fakeChannel({ failAttachment: true });
  const path = await mdFile();

  await postSessionNotes({ discordClient: clientFor(channel), meeting, notes, mdPath: path, cfg: {} });

  const texts = channel.sent.filter((m) => m.kind === 'text');
  assert.ok(texts.length >= 1);
  assert.ok(
    texts.every((m) => typeof m.content === 'string' && m.content.length > 0),
    'no empty sends'
  );
});

test('an unfetchable channel is reported, not thrown', async () => {
  await assert.doesNotReject(
    postSessionNotes({
      discordClient: { channels: { fetch: async () => null } },
      meeting,
      notes,
      mdPath: await mdFile(),
      cfg: {},
    })
  );
});
