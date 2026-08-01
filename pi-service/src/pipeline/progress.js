// Live progress for work that takes long enough to be worth asking about.
//
// Transcription is the only step where "how long is left?" is a real question:
// on the GPU a session is done in a couple of minutes, but on the Pi's CPU the
// same session runs for hours, and until now the only way to know how far
// along it was was to read the container logs.
//
// Deliberately in memory rather than in the database. This is a progress bar,
// not a record — writing a row per clip would put hundreds of pointless
// transactions in the way of the actual work, and a restart abandons the
// in-flight transcription anyway (recovery.js starts it over from the audio).

const active = new Map();

export function startTranscription(meetingId, total, now = Date.now()) {
  active.set(meetingId, { meetingId, done: 0, total, startedAt: now, updatedAt: now });
}

export function updateTranscription(meetingId, done, total, now = Date.now()) {
  const entry = active.get(meetingId);
  if (!entry) return startTranscription(meetingId, total, now);
  entry.done = done;
  entry.total = total ?? entry.total;
  entry.updatedAt = now;
}

export function endTranscription(meetingId) {
  active.delete(meetingId);
}

export function getTranscription(meetingId) {
  return active.get(meetingId) ?? null;
}

export function listTranscriptions() {
  return [...active.values()];
}

// Exported for tests — nothing else should need to wipe live state.
export function resetProgress() {
  active.clear();
}

// Milliseconds left, from the rate actually observed so far. Returns null
// rather than a guess when there is nothing to extrapolate from: a made-up
// ETA on the first clip would be wildly wrong and is worse than saying
// nothing, because people plan around it.
export function estimateRemainingMs(entry, now = Date.now()) {
  if (!entry || !entry.total || entry.done <= 0) return null;
  if (entry.done >= entry.total) return 0;

  const elapsed = now - entry.startedAt;
  if (elapsed <= 0) return null;

  const msPerItem = elapsed / entry.done;
  return Math.round(msPerItem * (entry.total - entry.done));
}

// Short, honest, and rounded — this is an estimate from a running average, so
// presenting it to the second would imply a precision it does not have.
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return 'under a minute';

  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// One line of "where is it up to", for /status.
export function describeTranscription(entry, now = Date.now()) {
  if (!entry) return null;
  const remaining = estimateRemainingMs(entry, now);
  const pct = entry.total ? Math.floor((entry.done / entry.total) * 100) : 0;
  const eta = remaining === null ? 'estimating…' : `~${formatDuration(remaining)} left`;
  return `transcribing ${entry.done}/${entry.total} (${pct}%) — ${eta}`;
}
