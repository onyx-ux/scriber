// Keeping an eye on recordings that nobody is watching.
//
// Two failures a recording could have without anybody finding out until the
// transcript came back short, or never came back at all:
//
//   * The bot drops out of voice — a network blip the library cannot recover
//     from, a voice server that goes away, somebody kicking it. Before this
//     there was no handler for the Disconnected state, so the session kept
//     showing "recording" with nothing arriving.
//   * Everybody leaves and nobody types /campaign leave. The meeting stayed
//     open indefinitely and held a voice slot, so the table's next /join was
//     refused.
//
// watchConnection handles the first, inside capture.js. reviewSession and
// runSessionWatch handle the second and also notice the first from the outside:
// people in the channel who agreed to be recorded, and no audio arriving.

const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// @discordjs/voice's VoiceConnectionDisconnectReason.WebSocketClose, and the
// close code Discord sends when the bot has been removed from the channel:
// kicked, or the channel deleted. Also sent for a move to another channel, in
// which case the library goes straight back to connecting.
const WEBSOCKET_CLOSE = 0;
const REMOVED = 4014;

// Watches one voice connection for a drop and tries to get it back.
//
// Follows the recovery pattern @discordjs/voice documents: a connection that
// is moving to another channel or a new voice server leaves Disconnected on its
// own within a few seconds, so wait for that first. Only a connection that
// stays down is rejoined, a few times with a pause between. Removal (4014) is
// not fought: somebody decided the bot should not be there.
//
// onLost fires at most once, with 'removed' or 'dropped', and the caller ends
// the session so everything captured so far is queued.
export function watchConnection(connection, { entersState, onLost, onRejoined, timings = {} }) {
  const t = { recoverMs: 5_000, rejoinMs: 20_000, rejoinDelaysMs: [2_000, 10_000, 30_000], ...timings };
  let handling = false;
  let lost = false;

  const lose = (reason) => {
    if (lost) return;
    lost = true;
    onLost?.(reason);
  };

  connection.on('disconnected', async (_previous, next) => {
    if (handling || lost) return;
    handling = true;
    try {
      if (next?.reason === WEBSOCKET_CLOSE && next?.closeCode === REMOVED) {
        try {
          await entersState(connection, 'connecting', t.recoverMs);
          console.log('[voice] moved to another channel; still recording');
        } catch {
          console.warn('[voice] removed from the voice channel');
          lose('removed');
        }
        return;
      }

      try {
        await Promise.race([
          entersState(connection, 'signalling', t.recoverMs),
          entersState(connection, 'connecting', t.recoverMs),
        ]);
        return;
      } catch {
        /* still down: rejoin below */
      }

      for (const [i, delay] of t.rejoinDelaysMs.entries()) {
        await sleep(delay);
        if (connection.state?.status === 'destroyed') return;
        console.warn(`[voice] connection dropped (close ${next?.closeCode ?? 'n/a'}); rejoining, attempt ${i + 1}`);
        try {
          connection.rejoin();
          await entersState(connection, 'ready', t.rejoinMs);
          console.log('[voice] rejoined');
          onRejoined?.();
          return;
        } catch {
          /* try again after the next delay */
        }
      }
      lose('dropped');
    } finally {
      handling = false;
    }
  });
}

// What to do about one live session right now. Returns null, or
// { kind: 'close', reason: 'empty' } or { kind: 'silent', minutes }.
//
// presence is { humans, recordable } for the channel the bot is sitting in, or
// null when that channel cannot be found, which counts as empty. `recordable`
// is the humans there who agreed to be recorded: silence from people who
// declined is the consent check working, not a fault.
//
// Mutates the session's own bookkeeping (emptySince, silenceAlertedAt), which
// lives on the activeSessions entry alongside everything else about it.
export function reviewSession(session, presence, now, cfg) {
  const closeMs = (cfg.voiceEmptyCloseMinutes ?? 0) * MIN;
  const silenceMs = (cfg.voiceSilenceAlertMinutes ?? 0) * MIN;
  const humans = presence?.humans ?? 0;

  if (humans === 0) {
    session.emptySince ??= now;
    if (closeMs > 0 && now - session.emptySince >= closeMs) return { kind: 'close', reason: 'empty' };
    return null;
  }
  session.emptySince = null;

  const heard = session.lastAudioAt ?? session.startedAtMs ?? now;
  if (session.silenceAlertedAt != null && heard > session.silenceAlertedAt) session.silenceAlertedAt = null;

  if (silenceMs > 0 && (presence?.recordable ?? 0) > 0 && session.silenceAlertedAt == null && now - heard >= silenceMs) {
    session.silenceAlertedAt = now;
    return { kind: 'silent', minutes: Math.round((now - heard) / MIN) };
  }
  return null;
}

// One pass over every live session. Each is handled on its own, so one that
// fails to end does not stop the rest being checked.
export async function runSessionWatch({ sessions, cfg, now = Date.now(), presenceOf, endSession, tell }) {
  for (const session of [...sessions.values()]) {
    try {
      const action = reviewSession(session, presenceOf(session), now, cfg);
      if (!action) continue;
      if (action.kind === 'close') await endSession(session, action.reason);
      await tell(session, action);
    } catch (err) {
      console.error(`[voice-watch] meeting ${session.meetingId}: ${err.message}`);
    }
  }
}

// The timer, wired to the real Discord client. Returns a stop function.
//
// presence is read from whichever channel the bot is actually in now, which
// is not always the one /join was run in: somebody can drag the bot to another
// channel and it keeps recording there.
export function startSessionWatch({ client, db, cfg, sessions, endSession, tell, intervalMs = 30_000 }) {
  if (!(cfg.voiceEmptyCloseMinutes > 0) && !(cfg.voiceSilenceAlertMinutes > 0)) return () => {};

  const presenceOf = (session) => {
    const channelId = session.handle?.channelId?.() ?? session.voiceChannelId;
    if (channelId && channelId !== session.voiceChannelId) session.voiceChannelId = channelId;
    const channel = client.channels?.cache?.get(channelId);
    if (!channel?.members) return null;
    const people = [...channel.members.values()].filter((m) => !m.user?.bot);
    return {
      humans: people.length,
      recordable: people.filter((m) => db.mayRecord(session.campaignId, m.id)).length,
    };
  };

  const timer = setInterval(() => {
    for (const s of sessions.values()) {
      const heard = s.handle?.lastAudioAt?.();
      if (heard) s.lastAudioAt = heard;
    }
    runSessionWatch({ sessions, cfg, presenceOf, endSession, tell }).catch((err) =>
      console.error('[voice-watch] pass failed:', err.message)
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
