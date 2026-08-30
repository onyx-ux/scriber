// What happens when the process is asked to stop, or trips over itself.
//
// Neither of these existed. The bot ran with no unhandledRejection handler,
// no uncaughtException handler and no signal handler at all, which had three
// consequences worth naming:
//
//   * Node terminates on an unhandled rejection by default. So one stray
//     promise anywhere — a Discord edit on a message somebody deleted, a DM to
//     a closed inbox — took the whole bot down MID-SESSION, and left no line
//     in the log saying what it was. The audio survived (capture writes each clip
//     straight to disk) and recovery.js picks the meeting back up on restart,
//     so nothing was lost; what was missing was any way to find out why.
//   * `docker compose restart` sends SIGTERM, and with nothing listening Node
//     exits instantly: SQLite's WAL is left for the next open to recover, the
//     voice connection is dropped rather than closed, and the clip being
//     written at that moment is truncated.
//   * a real crash and a clean stop looked identical from outside.
//
// The two failures are deliberately treated differently, and that is the
// whole design here.

// How long a shutdown gets before it is abandoned. Docker sends SIGKILL ten
// seconds after SIGTERM by default, so this stays under that: an exit we
// chose is worth more than two extra seconds of trying to be tidy.
const SHUTDOWN_GRACE_MS = 7000;

export function installProcessGuards({
  onShutdown = async () => {},
  proc = process,
  log = console,
  graceMs = SHUTDOWN_GRACE_MS,
} = {}) {
  let stopping = false;

  const shutdown = async (signal) => {
    // Idempotent on purpose. Impatient operators send SIGTERM twice, and
    // docker sends it to every process in the container — running the close
    // path twice would double-close the database.
    if (stopping) {
      log.warn?.(`[lifecycle] already shutting down, ignoring ${signal}`);
      return;
    }
    stopping = true;
    log.log?.(`[lifecycle] ${signal} — shutting down`);

    // A hung close must not turn a tidy stop into a SIGKILL. Whatever has
    // finished by the deadline is what we get.
    const timer = setTimeout(() => {
      log.warn?.(`[lifecycle] shutdown did not finish in ${graceMs}ms — exiting anyway`);
      proc.exit(0);
    }, graceMs);
    timer.unref?.();

    try {
      await onShutdown(signal);
      log.log?.('[lifecycle] clean shutdown');
    } catch (err) {
      log.error?.(`[lifecycle] shutdown failed: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
      proc.exit(0);
    }
  };

  const onSignal = (signal) => () => {
    shutdown(signal);
  };
  const sigterm = onSignal('SIGTERM');
  const sigint = onSignal('SIGINT');

  // STAYS UP, deliberately.
  //
  // A rejection nobody caught is far more often a transient thing in a
  // fire-and-forget path — a Discord call that 404'd, a DM refused — than it
  // is evidence the process is broken. Dying for one of those in the middle
  // of recording somebody's evening is the worse outcome by a wide margin,
  // and the recording is the thing this program exists to not lose.
  //
  // The cost is that a genuinely broken state can now persist instead of
  // being restarted out of. That is why this logs the whole stack rather than
  // a message: something that used to kill the bot silently should now be
  // impossible to miss in `docker logs`.
  const onRejection = (reason) => {
    log.error?.(
      '[lifecycle] UNHANDLED REJECTION — staying up, but this is a bug:\n',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason
    );
  };

  // EXITS, equally deliberately.
  //
  // The opposite case: an exception that escaped every frame means the stack
  // it happened on is gone and whatever it was halfway through is now in an
  // unknown state. Carrying on from there risks writing that unknown state to
  // the database. Exiting non-zero lets Docker's restart policy do the only
  // safe thing, and startup recovery repairs the interrupted meeting.
  const onException = (err) => {
    log.error?.('[lifecycle] UNCAUGHT EXCEPTION — exiting:\n', err?.stack ?? err);
    proc.exit(1);
  };

  proc.on('SIGTERM', sigterm);
  proc.on('SIGINT', sigint);
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);

  // Handed back so tests can take them off again; production never calls it.
  return () => {
    proc.off?.('SIGTERM', sigterm);
    proc.off?.('SIGINT', sigint);
    proc.off?.('unhandledRejection', onRejection);
    proc.off?.('uncaughtException', onException);
  };
}
