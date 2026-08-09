import { finishSession } from './finish-session.js';
import { rebuildCapturedUtterances } from './recovery.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { decideTranscribeAction } from './transcribe-schedule.js';
import { applyTranscribeTarget, TARGET_PI, TARGET_PC } from './transcribe-target.js';
import { notifyTranscribeReminder } from '../delivery/transcribe-notify.js';
import { notifyApprovalNeeded } from '../delivery/approval-notify.js';
import { startLiveProgress } from '../delivery/live-progress.js';
import { resolveProgressTarget } from '../delivery/progress-target.js';
import { sessionLabel } from '../export/naming.js';
import { getTranscription, describeTranscription } from './progress.js';

// Decides WHEN a recorded session is allowed to use the PC's GPU, and runs it.
//
// See transcribe-schedule.js for the policy. This file is only the plumbing:
// find due work, ask the (pure, tested) decision function what to do, and do
// it. Keeping the policy separate is what makes "would it run at 9pm on a
// Saturday?" answerable in a unit test rather than by waiting until Saturday.

// Deliberately one job per tick. Transcription is the heaviest thing this
// system does and it monopolises the GPU; running two sessions concurrently
// would just make both slower and double the VRAM footprint on a card that
// is also somebody's gaming machine.
// probe and runJob are injectable so the scheduling plumbing can be tested
// without a GPU on the other end; production always uses the defaults.
export async function transcribeTick(
  db,
  discordClient,
  cfg,
  { now = new Date(), probe = isWhisperServerReachable, runJob = runTranscribeJob } = {}
) {
  if (db.getSetting('transcribe_paused') === 'true') return null;

  const jobs = db.dueTranscribeJobs();
  if (jobs.length === 0) return null;

  // One reachability probe per tick, not per job — it is the same server.
  const serverReachable = await probe(cfg);

  for (const job of jobs) {
    const meeting = db.getMeeting(job.meeting_id);
    if (!meeting) {
      db.failJobPermanently(job.id, 'meeting no longer exists');
      continue;
    }

    // "Use the Pi instead" deliberately opts out of the whole GPU schedule:
    // it needs no PC, so it must not be gated on the PC answering.
    const onPi = db.getSetting(`transcribe_target_${job.id}`) === 'pi';
    const { action, reason } = decideTranscribeAction({
      job,
      now,
      serverReachable: onPi ? true : serverReachable,
      cfg,
    });

    if (action === 'remind') {
      await notifyTranscribeReminder({ discordClient, cfg, meeting, jobId: job.id, now });
      // Recorded even if the DM failed, so an owner with DMs closed doesn't
      // turn into a reminder attempt on every single tick.
      db.markJobNotified(job.id);
      continue;
    }

    if (action !== 'run') continue;

    console.log(`[transcribe] meeting ${meeting.id}: starting (${reason}${onPi ? ', on the Pi' : ''})`);
    await runJob(db, discordClient, applyTranscribeTarget(cfg, onPi ? TARGET_PI : TARGET_PC), job, meeting);
    return job.id; // one per tick
  }

  return null;
}

async function runTranscribeJob(db, discordClient, cfg, job, meeting) {
  db.markJobRunning(job.id);
  let live = null;

  try {
    // The in-memory utterance list is long gone by now — a job may have been
    // waiting for days — so rebuild it from the audio still on disk.
    const captured = await rebuildCapturedUtterances(db, meeting, cfg, discordClient);
    if (captured.length === 0) {
      db.failJobPermanently(job.id, 'no audio found for this meeting');
      db.setMeetingStatus(meeting.id, 'transcription_failed');
      console.error(`[transcribe] meeting ${meeting.id}: no audio on disk, cannot transcribe`);
      return;
    }

    live = await startChannelProgress({ discordClient, cfg, meeting, clipCount: captured.length });

    const result = await finishSession(db, meeting.id, captured, meeting.audio_dir, cfg, {
      serverReachable: true,
    });

    await live?.remove();
    live = null;

    if (!result.ok) {
      // Nothing usable came back. Reschedule rather than fail permanently —
      // the usual cause is the PC going away mid-run, which fixes itself.
      db.rescheduleJob(job.id, new Date(Date.now() + cfg.transcribeSnoozeHours * 3600_000).toISOString(), 'transcription produced nothing usable');
      console.error(`[transcribe] meeting ${meeting.id}: produced nothing usable, will retry`);
      return;
    }

    db.markJobDone(job.id);
    console.log(`[transcribe] meeting ${meeting.id}: ${result.utteranceCount} utterances transcribed`);

    // Summarising is a separate job with its own approval gate; hand over.
    if (result.job?.status === 'awaiting_approval') {
      await notifyApprovalNeeded({
        discordClient,
        cfg,
        meeting: db.getMeeting(meeting.id),
        jobId: result.job.id,
        utteranceCount: result.utteranceCount,
      });
    }
  } catch (err) {
    await live?.finish(`⚠️ ${sessionLabel(meeting)}: transcription failed — \`${String(err.message).slice(0, 150)}\`. The audio is safe and it will be retried.`);
    db.rescheduleJob(
      job.id,
      new Date(Date.now() + cfg.transcribeSnoozeHours * 3600_000).toISOString(),
      err.message
    );
    console.error(`[transcribe] meeting ${meeting.id} failed: ${err.message}`);
  }
}

// Progress goes to the owner's DM, not the table's channel — it reports on
// the owner's GPU and queue, and a session transcribed hours later would
// otherwise interrupt an unrelated conversation with percentages. See
// delivery/progress-target.js.
async function startChannelProgress({ discordClient, cfg, meeting, clipCount }) {
  const channel = await resolveProgressTarget(discordClient, cfg, meeting);
  if (!channel) return null;

  return startLiveProgress({
    channel,
    initial: `🎧 Transcribing session #${meeting.id} — ${clipCount} clips…`,
    render: () => {
      const entry = getTranscription(meeting.id);
      return entry ? `🎧 ${sessionLabel(meeting)}: ${describeTranscription(entry)}` : null;
    },
  });
}

export function startTranscribeWorker(db, discordClient, cfg) {
  const handle = setInterval(() => {
    transcribeTick(db, discordClient, cfg).catch((err) =>
      console.error('[transcribe] tick error:', err.message)
    );
  }, cfg.transcribePollMs);
  return () => clearInterval(handle);
}
