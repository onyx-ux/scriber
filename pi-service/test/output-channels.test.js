import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { createDiscordBridge } from '../src/web/discord-bridge.js';

// Where a campaign's write-ups may be posted.
//
// The dashboard's destination switch had "A chosen channel" disabled from the
// day it was drawn, because the page had never been told which channels exist
// or which of them this bot may speak in. This is the answer to that question,
// and every test here is about it being an ANSWER rather than a guess: a
// channel offered in the picker is one the next write-up will actually reach.
//
// The stubs are shaped like discord.js and use its own constants, so a channel
// type or permission flag renamed underneath us fails here rather than silently
// filtering everything out and leaving the picker permanently empty.

const ALL = () => ({ has: () => true });
const VIEW_ONLY = () => ({ has: (flag) => flag === PermissionFlagsBits.ViewChannel });

function channel({
  id,
  name,
  type = ChannelType.GuildText,
  category = null,
  categoryAt = 0,
  at = 0,
  perms = ALL,
}) {
  return {
    id,
    name,
    type,
    rawPosition: at,
    parent: category ? { name: category, rawPosition: categoryAt } : null,
    permissionsFor: perms,
  };
}

// A client holding one guild. `me` is the bot's own member, which is what every
// permission question below is asked about.
function botIn(channels, { me = { id: 'bot' }, guild = {} } = {}) {
  return {
    guilds: {
      fetch: async () => ({
        members: { me, fetchMe: async () => me },
        channels: { cache: new Map(channels.map((c) => [c.id, c])) },
        ...guild,
      }),
    },
  };
}

const listing = (client) => createDiscordBridge({ client, db: {}, cfg: {} }).listChannels({ guildId: 'g1' });

test('the picker is offered the channels a write-up could actually reach', async () => {
  const res = await listing(
    botIn([
      channel({ id: '1', name: 'general', at: 0 }),
      channel({ id: '2', name: 'announcements', type: ChannelType.GuildAnnouncement, at: 1 }),
    ])
  );

  assert.equal(res.ok, true);
  assert.deepEqual(res.channels.map((c) => c.name), ['general', 'announcements']);
  assert.deepEqual(res.channels.map((c) => c.id), ['1', '2'], 'the id is what gets stored');
});

// Seeing a channel and being able to speak in it are different permissions, and
// only one of them gets a recap delivered. A channel the bot can read but not
// post in looks like a perfectly good choice right up until the first write-up
// is silently dropped.
test('a channel the bot can see but not speak in is not offered', async () => {
  const res = await listing(
    botIn([
      channel({ id: '1', name: 'general' }),
      channel({ id: '2', name: 'staff-only', perms: VIEW_ONLY }),
    ])
  );

  assert.deepEqual(res.channels.map((c) => c.name), ['general']);
});

test('only text and announcement channels are offered', async () => {
  const res = await listing(
    botIn([
      channel({ id: '1', name: 'general' }),
      // Voice carries a text chat, but it is where the table PLAYS — a recap
      // dropped in lands in the middle of next week's session.
      channel({ id: '2', name: 'The Cellar', type: ChannelType.GuildVoice }),
      channel({ id: '3', name: 'Text Channels', type: ChannelType.GuildCategory }),
      channel({ id: '4', name: 'questions', type: ChannelType.GuildForum }),
    ])
  );

  assert.deepEqual(res.channels.map((c) => c.name), ['general']);
});

// The order Discord's own sidebar uses, so the person choosing is reading the
// list they already know rather than a re-sorted one they have to search.
test('the list comes back in the order Discord draws it', async () => {
  const res = await listing(
    botIn([
      channel({ id: '3', name: 'lore', category: 'Campaign', categoryAt: 1, at: 1 }),
      channel({ id: '1', name: 'rules', at: 0 }),
      channel({ id: '2', name: 'session-notes', category: 'Campaign', categoryAt: 1, at: 0 }),
      channel({ id: '4', name: 'off-topic', category: 'Zulu', categoryAt: 2, at: 0 }),
    ])
  );

  assert.deepEqual(res.channels.map((c) => c.name), ['rules', 'session-notes', 'lore', 'off-topic']);
  assert.deepEqual(res.channels.map((c) => c.category), [null, 'Campaign', 'Campaign', 'Zulu']);
});

// The distinction the whole guard rests on. "I could not ask" and "there is
// nowhere I may post" are different facts, and only one of them is worth
// changing a permission over — so they must not both arrive as an empty list.
test('a server the bot has left says so rather than answering nothing', async () => {
  const res = await createDiscordBridge({
    client: { guilds: { fetch: async () => { throw new Error('unknown guild'); } } },
    db: {}, cfg: {},
  }).listChannels({ guildId: 'g1' });

  assert.equal(res.ok, false);
  assert.match(res.message, /not in that server/i);
});

test('a bot that cannot find its own membership refuses rather than assuming yes', async () => {
  const res = await listing(botIn([channel({ id: '1', name: 'general' })], { me: null }));

  assert.equal(res.ok, false);
  assert.match(res.message, /permissions/i);
  assert.equal(res.channels, undefined, 'and offers nothing on the strength of a guess');
});

test('a server with nowhere to post answers an empty list, not a failure', async () => {
  const res = await listing(botIn([channel({ id: '1', name: 'staff-only', perms: VIEW_ONLY })]));

  assert.equal(res.ok, true);
  assert.deepEqual(res.channels, []);
});

// The cache is the live answer — the Guilds intent fills it at startup and the
// gateway keeps it current. The fetch exists for the one case it cannot cover:
// a guild the bot has only just joined.
test('an empty cache falls back to asking Discord directly', async () => {
  let fetched = 0;
  const res = await createDiscordBridge({
    client: {
      guilds: {
        fetch: async () => ({
          members: { me: { id: 'bot' } },
          channels: {
            cache: new Map(),
            fetch: async () => {
              fetched += 1;
              return new Map([['1', channel({ id: '1', name: 'general' })]]);
            },
          },
        }),
      },
    },
    db: {}, cfg: {},
  }).listChannels({ guildId: 'g1' });

  assert.equal(fetched, 1);
  assert.deepEqual(res.channels.map((c) => c.name), ['general']);
});
