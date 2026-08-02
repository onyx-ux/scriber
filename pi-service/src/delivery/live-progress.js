// A single Discord message that edits itself while long work runs.
//
// Transcribing a session and then summarising it can take anywhere from
// seconds (GPU + Gemini) to hours (Pi CPU), and until now the bot said
// "working on it" and then went silent for the duration — indistinguishable
// from having crashed. This keeps one message up to date instead of posting a
// stream of new ones.
//
// Everything here is best-effort by design: this is a status line, and a
// Discord hiccup while editing it must never take down the transcription or
// summary it is reporting on.

// Discord allows 5 edits per 5 seconds per channel. 10s is far inside that
// while still feeling live, and it bounds the damage if several sessions
// somehow run at once.
const DEFAULT_INTERVAL_MS = 10_000;

export function startLiveProgress({ channel, render, intervalMs = DEFAULT_INTERVAL_MS, initial }) {
  let message = null;
  let stopped = false;
  let lastText = null;
  let timer = null;
  // Serialises edits: without this a slow edit overlapping the next tick can
  // apply out of order and leave the message showing stale progress.
  let inFlight = Promise.resolve();

  const post = async () => {
    const content = initial ?? render() ?? 'Working…';
    try {
      message = await channel.send({ content });
      // Seed what's on screen, or the first tick re-sends identical text and
      // spends a rate-limit slot to change nothing.
      lastText = content;
    } catch {
      message = null; // no permission, deleted channel — carry on silently
    }
  };

  const started = post();

  const paint = async () => {
    if (stopped || !message) return;
    let text;
    try {
      text = render();
    } catch {
      return; // a broken renderer must not stop the work it describes
    }
    if (!text || text === lastText) return;
    lastText = text;
    await message.edit({ content: text }).catch(() => {});
  };

  timer = setInterval(() => {
    inFlight = inFlight.then(paint);
  }, intervalMs);
  timer.unref?.();

  return {
    // Final state: stop ticking, then write the closing text exactly once so
    // the message doesn't linger on a half-finished count.
    async finish(finalText) {
      stopped = true;
      clearInterval(timer);
      await started;
      await inFlight;
      if (!message) return null;
      if (finalText) await message.edit({ content: finalText }).catch(() => {});
      return message;
    },
    // Remove the status line entirely — used when a real message (the notes
    // themselves) is about to replace it.
    async remove() {
      stopped = true;
      clearInterval(timer);
      await started;
      await inFlight;
      await message?.delete().catch(() => {});
      message = null;
    },
  };
}
