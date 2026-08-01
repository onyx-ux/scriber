import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { postSessionNotes } from '../src/delivery/discord-post.js';

const meeting = { id: 4, channel_id: 'chan-1', channel_name: 'the-table', started_at: '2026-08-01T10:00:00Z' };
const notes = { tldr: 'The party burned down the inn.' };

async function withMd(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'scriber-dm-'));
  const mdPath = join(dir, 'session-4.md');
  await writeFile(mdPath, '# Session 4\n');
  try {
    return await fn(mdPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A fake client that records where things were sent.
function stubClient({ dmWorks = true, ownerExists = true } = {}) {
  const sent = { dm: [], channel: [] };
  return {
    sent,
    users: {
      fetch: async (id) => {
        if (!ownerExists) throw new Error('Unknown User');
        return {
          id,
          createDM: async () => {
            // Discord 50007 — the recipient refuses DMs from bots.
            if (!dmWorks) throw new Error('Cannot send messages to this user');
            return { send: async (msg) => sent.dm.push(msg) };
          },
        };
      },
    },
    channels: {
      fetch: async (id) => ({ id, send: async (msg) => sent.channel.push(msg) }),
    },
  };
}

test('notes go to the session channel by default', async () => {
  const client = stubClient();
  await withMd((mdPath) =>
    postSessionNotes({ discordClient: client, meeting, notes, mdPath, cfg: { ownerUserId: 'owner-1' } })
  );

  assert.ok(client.sent.channel.length > 0);
  assert.equal(client.sent.dm.length, 0, 'DMing must be opt-in — the table expects the recap in the channel');
});

test('with the flag on, notes and the attachment both go to the owner DM', async () => {
  const client = stubClient();
  await withMd((mdPath) =>
    postSessionNotes({
      discordClient: client,
      meeting,
      notes,
      mdPath,
      cfg: { notesToOwnerDm: true, ownerUserId: 'owner-1' },
    })
  );

  assert.ok(client.sent.dm.length >= 2, 'the body and the markdown file both arrive');
  assert.equal(client.sent.channel.length, 0, 'nothing leaks into the server channel');
  assert.ok(
    client.sent.dm.some((m) => m.files?.length),
    'the markdown export is attached, not just the summary text'
  );
});

// Losing a session's notes because someone has DMs closed would be a far
// worse outcome than posting them where they'd have gone anyway.
test('a refused DM falls back to the channel instead of dropping the notes', async () => {
  const client = stubClient({ dmWorks: false });
  await withMd((mdPath) =>
    postSessionNotes({
      discordClient: client,
      meeting,
      notes,
      mdPath,
      cfg: { notesToOwnerDm: true, ownerUserId: 'owner-1' },
    })
  );

  assert.equal(client.sent.dm.length, 0);
  assert.ok(client.sent.channel.length > 0, 'the notes still reached somebody');
});

test('an unfetchable owner also falls back rather than failing', async () => {
  const client = stubClient({ ownerExists: false });
  await withMd((mdPath) =>
    postSessionNotes({
      discordClient: client,
      meeting,
      notes,
      mdPath,
      cfg: { notesToOwnerDm: true, ownerUserId: 'ghost' },
    })
  );

  assert.ok(client.sent.channel.length > 0);
});

// The flag alone can't work — there'd be nobody to DM.
test('the flag without an owner id keeps using the channel', async () => {
  const client = stubClient();
  await withMd((mdPath) =>
    postSessionNotes({ discordClient: client, meeting, notes, mdPath, cfg: { notesToOwnerDm: true, ownerUserId: null } })
  );

  assert.equal(client.sent.dm.length, 0);
  assert.ok(client.sent.channel.length > 0);
});
