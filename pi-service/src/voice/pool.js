// Which of this install's bots may hold a voice connection, and which one is
// free to take the next session.
//
// THE RULE THIS FILE EXISTS FOR
//
// Discord gives one bot USER one voice connection per SERVER. Not one per
// channel — one per server. So a Discord with two tables playing on a Friday
// cannot be recorded by one bot however the bookkeeping is arranged, which is
// exactly what commands/index.js said for as long as there was only ever one:
// "a bot can only hold one voice connection per server, so two tables in one
// Discord genuinely cannot record at the same time."
//
// That sentence was true and is now only true of ONE bot. The way to record
// two channels at once is more bot users, which is a second application in the
// developer portal and a second token — free, and the only thing Discord will
// accept as an answer.
//
// WHY THE EXTRAS ARE MULES RATHER THAN BOTS
//
// The obvious shape is to run the whole bot twice. That shape is wrong here,
// and expensively so: two processes on one SQLite file both claim the same
// queue job (nothing in store/db.js claims atomically), and each one's startup
// resets the OTHER's running jobs — so an evening gets summarised twice, at
// twice the API bill, and posted twice to the table.
//
// So the extras are not bots. They are microphones. They log in, they sit in
// the guild, they hold a voice connection and stream audio into the same
// capture pipeline, and they do nothing else at all: no slash commands
// registered, no interaction handlers, no queue worker, no dashboard.
//
// Everything that is not the socket itself keeps running on the PRIMARY
// client, which is in the same guild and can see the same channels. That is
// what makes this cheap rather than invasive:
//
//   * the table sees ONE set of slash commands, because only the primary
//     registers any. Two full bots would put two /join entries in the picker.
//   * delivery/ never learns that mules exist. Posting a write-up, DMing the
//     owner, resolving a display name — all of it goes through the primary,
//     so no meeting has to remember which bot recorded it and nothing in the
//     schema changes.
//   * there is still one database, one queue worker, one transcribe worker
//     and one dashboard, so none of the two-process hazards above can happen.
//
// WHY THIS FILE HOLDS NO STATE
//
// "Which bot is busy" is deliberately not stored here. It is derived, on every
// call, from the live session registry in commands/index.js — the same map the
// dashboard reads and /leave deletes from. A second copy of that fact is a
// copy that can drift, and the way it drifts is a bot marked busy forever
// after a session that ended badly, which nothing would ever notice and no
// restart-free fix exists for. Ask the sessions; they are the ones that know.

// The bots that could hold a voice connection, primary first.
//
// Order is load-bearing rather than tidy. The primary is offered first, so a
// server with one table running uses the bot everybody recognises and the
// mules stay idle and unnoticed — they only ever appear in a voice channel
// when a second table is genuinely playing at the same time.
//
// Labels rather than Discord ids, and that is deliberate too: a snowflake is
// not known until that client has logged in, which is after the pool is built
// and after registerCommandHandlers has already closed over it. A label is
// known from the config, is stable across restarts, and is what a log line
// wants to say anyway.
export function voicePool(primary, extras = []) {
  return [
    { id: 'primary', client: primary, primary: true },
    ...extras.map((client, i) => ({ id: `voice-${i + 1}`, client, primary: false })),
  ];
}

// Whether this bot is logged in and actually in that server.
//
// Both halves matter and neither implies the other. A mule that has not
// finished connecting has an empty guild cache, and a mule nobody invited to
// this particular Discord is logged in perfectly happily and cannot join
// anything in it. Either way the answer is the same — it is not a candidate —
// so /join degrades to "the bots that are really there" rather than failing on
// a connection that was still warming up.
export function botsFor(pool, guildId) {
  return pool.filter((bot) => Boolean(bot.client?.guilds?.cache?.has?.(guildId)));
}

// The first bot in this server that is not already recording in it, or null.
//
// `busyIds` is a Set of pool labels, built by the caller from the live
// sessions plus any /join still in flight. Null means every bot this install
// has is already in a voice channel in this Discord, which is a thing to say
// out loud rather than a thing to queue — see handleJoin.
export function freeBot(pool, guildId, busyIds = new Set()) {
  return botsFor(pool, guildId).find((bot) => !busyIds.has(bot.id)) ?? null;
}

// How many tables this install could record at once in one server. Said at
// startup and on the "all of me are busy" refusal, because "two" is the number
// somebody needs when deciding whether to add another token.
export const poolSize = (pool) => pool.length;

// What a mule needs to be able to do, and nothing more.
//
// Guilds so it knows the server exists, GuildVoiceStates so it can open a
// voice connection. It is never handed MessageContent, never registers a
// command and never reads a channel — it is a microphone with a login.
export const VOICE_ONLY_INTENTS = ['Guilds', 'GuildVoiceStates'];
