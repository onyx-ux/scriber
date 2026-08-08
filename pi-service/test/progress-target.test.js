import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProgressTarget } from '../src/delivery/progress-target.js';

// Progress lines ("transcribing 99/3454 — ~17m left", "summarising with
// Gemini") are about the owner's hardware and queue. They were going to the
// table's channel, which narrates the plumbing at people who just played a
// session — and a session transcribed hours later would interrupt an
// unrelated conversation with percentages.

const dmChannel = { id: 'dm', kind: 'dm' };
const guildChannel = { id: 'C1', kind: 'guild' };

function client({ dmWorks = true, guildWorks = true } = {}) {
  return {
    users: {
      fetch: async () => ({
        createDM: async () => {
          if (!dmWorks) throw new Error('cannot send messages to this user');
          return dmChannel;
        },
      }),
    },
    channels: {
      fetch: async () => {
        if (!guildWorks) throw new Error('unknown channel');
        return guildChannel;
      },
    },
  };
}

const meeting = { channel_id: 'C1' };

test('progress goes to the owner’s DM', async () => {
  const target = await resolveProgressTarget(client(), { ownerUserId: 'OWNER' }, meeting);
  assert.equal(target.kind, 'dm');
});

// Discord lets anyone refuse DMs from bots. A status line in the wrong place
// beats a long silent job that looks like a crash.
test('a closed DM falls back to the channel rather than going silent', async () => {
  const target = await resolveProgressTarget(client({ dmWorks: false }), { ownerUserId: 'OWNER' }, meeting);
  assert.equal(target.kind, 'guild');
});

test('with no owner configured it uses the channel', async () => {
  const target = await resolveProgressTarget(client(), {}, meeting);
  assert.equal(target.kind, 'guild');
});

test('a dedicated notes channel is preferred over the session channel', async () => {
  let asked = null;
  const c = client();
  c.channels.fetch = async (id) => ((asked = id), guildChannel);

  await resolveProgressTarget(c, { notesChannelId: 'NOTES' }, meeting);
  assert.equal(asked, 'NOTES');
});

test('nothing reachable returns null instead of throwing', async () => {
  assert.equal(await resolveProgressTarget(null, {}, meeting), null);
  assert.equal(await resolveProgressTarget(client({ guildWorks: false }), {}, meeting), null);
  assert.equal(await resolveProgressTarget(client(), {}, {}), null, 'no channel to fall back to');
});
