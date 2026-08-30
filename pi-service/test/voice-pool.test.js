import { test } from 'node:test';
import assert from 'node:assert/strict';

import { voicePool, botsFor, freeBot, poolSize } from '../src/voice/pool.js';

// Which bot sits down at which table.
//
// Discord gives one bot user one voice connection per server, so a Discord
// with two tables playing at once needs two bot users. This is the file that
// decides which of them takes the next /join, and everything it decides is a
// pure function of "who is logged in where" and "who is already busy" — no
// state of its own, deliberately, so it cannot drift out of step with the
// sessions that are the real answer. See src/voice/pool.js.

const GUILD = 'one-server';
const ELSEWHERE = 'another-server';

// A client is only ever asked one thing: are you in this guild. A Map answers
// .has() exactly as discord.js's Collection does.
const client = (...guildIds) => ({ guilds: { cache: new Map(guildIds.map((id) => [id, {}])) } });

test('the pool is the primary plus its extras, primary first', () => {
  const pool = voicePool(client(GUILD), [client(GUILD), client(GUILD)]);

  assert.deepEqual(pool.map((b) => b.id), ['primary', 'voice-1', 'voice-2']);
  assert.deepEqual(pool.map((b) => b.primary), [true, false, false]);
  assert.equal(poolSize(pool), 3);
});

// The normal install, and the one that must not get slower or stranger.
test('with no extra tokens there is exactly one bot, and it is the primary', () => {
  const pool = voicePool(client(GUILD));

  assert.equal(poolSize(pool), 1);
  assert.equal(freeBot(pool, GUILD).id, 'primary');
  assert.equal(freeBot(pool, GUILD, new Set(['primary'])), null, 'and once it is busy there is no other');
});

// Order is not tidiness. A server running one table should use the bot the
// table recognises, so the extras only ever appear when a second game is
// genuinely being recorded at the same time.
test('the primary is always offered first while it is free', () => {
  const pool = voicePool(client(GUILD), [client(GUILD)]);

  assert.equal(freeBot(pool, GUILD).id, 'primary');
  assert.equal(freeBot(pool, GUILD, new Set(['primary'])).id, 'voice-1');
  assert.equal(freeBot(pool, GUILD, new Set(['primary', 'voice-1'])), null);
});

// Busy is per SERVER. A bot recording in one Discord is still free to record
// in another — which is what makes one extra token buy a second table in every
// server at once rather than only in the one it was added for.
test('a bot busy in one server is still free in another', () => {
  const pool = voicePool(client(GUILD, ELSEWHERE), [client(GUILD, ELSEWHERE)]);

  // 'primary' is recording in GUILD; that says nothing about ELSEWHERE, and
  // the caller is the one that scopes the busy set — see busyBotIds.
  assert.equal(freeBot(pool, GUILD, new Set(['primary'])).id, 'voice-1');
  assert.equal(freeBot(pool, ELSEWHERE, new Set()).id, 'primary');
});

// An extra token is one application, invited to servers one at a time. The
// half-invited state is the normal one on the way to the finished one, and it
// has to degrade to "the bots that are really there" rather than to an error.
test('a bot that was never invited to this server is not offered', () => {
  const pool = voicePool(client(GUILD, ELSEWHERE), [client(ELSEWHERE)]);

  assert.deepEqual(botsFor(pool, GUILD).map((b) => b.id), ['primary']);
  assert.equal(freeBot(pool, GUILD, new Set(['primary'])), null, 'a bot in another Discord cannot record here');
  assert.deepEqual(botsFor(pool, ELSEWHERE).map((b) => b.id), ['primary', 'voice-1']);
});

// Extras are logged in after the pool is built, so "still connecting" is a
// state /join can genuinely arrive in. An empty guild cache is the same answer
// as not being invited, and the same answer is the right one: not yet.
test('a bot still connecting is not offered', () => {
  const stillConnecting = { guilds: { cache: new Map() } };
  const pool = voicePool(client(GUILD), [stillConnecting]);

  assert.deepEqual(botsFor(pool, GUILD).map((b) => b.id), ['primary']);
  assert.equal(freeBot(pool, GUILD, new Set(['primary'])), null);
});

// A client that has not finished constructing has no .guilds at all. Reached
// through optional chaining rather than a guard, so a shape nobody anticipated
// answers "not a candidate" instead of throwing inside /join.
test('a client with no guild cache at all is not offered, and does not throw', () => {
  const pool = voicePool({}, [{ guilds: null }]);

  assert.deepEqual(botsFor(pool, GUILD), []);
  assert.equal(freeBot(pool, GUILD), null);
});

// --- what the config makes of DISCORD_VOICE_TOKENS ---
//
// Loaded in its own file, and this is the only test that imports config/env.js:
// it reads process.env at module load, so it can only be given one set of
// values per process. node:test runs each FILE in its own process, which is
// what makes this safe here and unsafe anywhere else.

test('extra tokens are parsed in order, and a repeat of the primary is refused', async (t) => {
  process.env.DISCORD_TOKEN = 'primary-token';
  process.env.DISCORD_CLIENT_ID = '12345';
  process.env.GEMINI_API_KEY = 'k';
  // The dangerous line, and the reason this is checked at all: two clients on
  // ONE token are one bot user, which still gets one voice connection per
  // server — so the "second table" would evict the first from its channel,
  // which is the exact failure the second bot exists to prevent.
  process.env.DISCORD_VOICE_TOKENS = ' second-token , primary-token,second-token ,,third-token ';

  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  t.after(() => { console.warn = warn; });

  const { config } = await import('../src/config/env.js');

  assert.deepEqual(config.voiceTokens, ['second-token', 'third-token'], 'trimmed, in order, no blanks');
  assert.equal(warnings.filter((w) => w.includes('DISCORD_TOKEN repeated')).length, 1);
  assert.equal(warnings.filter((w) => w.includes('duplicate token')).length, 1);
});
