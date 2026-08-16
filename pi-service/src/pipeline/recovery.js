import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSpeakerName } from '../campaign/character-names.js';
import { notifyTranscribeReady } from '../delivery/transcribe-notify.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { MIN_UTTERANCE_MS } from '../voice/capture.js';
import { wavDurationMs } from './wav-merge.js';

// Capture writes each utterance's WAV straight to disk as it happens (see
// voice/capture.js) — nothing sits only in memory. So if the bot process
// dies mid-session (Pi power loss, OOM, a crash), the audio is safe; what's
// lost is only the in-memory `capturedUtterances` array that would normally
// get built up during the live session and consumed by /leave.
//
// On startup, for any meeting stuck in 'recording' or 'transcribing'
// (meaning the process died before finishing that meeting), rebuild the
// utterance list by scanning audio_dir/<userId>/<startMs>.wav directly, then
// run it through the normal finishSession pipeline as if /leave had just
// been called.
// discordClient is optional — if it's already logged in (recovery is called
// from the 'ready' handler so this is normally the case), we use it to
// resolve real display names the same way a live /join does; otherwise (or
// if a member fetch fails, e.g. they left the server) we fall back to the
// bare user ID, same as before.
export async function recoverInterruptedMeetings(db, cfg, discordClient) {
  // --- job-queue reconciliation, before any meeting recovery ---

  // A job left mid-flight when the process died is still marked 'running',
  // and nextDueJob only ever picks up 'pending' rows — so without this it
  // would sit there untouched forever instead of being retried.
  const reset = db.resetStuckRunningJobs();
  if (reset > 0) console.log(`[recovery] reset ${reset} job(s) stuck in 'running' back to pending`);

  // Meetings that transcribed fine but ended up with no live job (crash at
  // exactly the wrong moment, or a job that hit its permanent-failure cap).
  // Nothing else would ever look at these again.
  const orphans = db.listMeetingsAwaitingSummaryWithoutJob();
  for (const meeting of orphans) {
    db.enqueueSummarizeJob(meeting.id);
    console.log(`[recovery] meeting ${meeting.id} was awaiting summary with no job — re-queued`);
  }

  const stuck = db.listInterruptedMeetings();
  if (stuck.length === 0) return;

  console.log(`[recovery] found ${stuck.length} interrupted meeting(s) from before restart`);

  for (const meeting of stuck) {
    if (!meeting.audio_dir) {
      console.warn(`[recovery] meeting ${meeting.id} has no audio_dir recorded, marking failed`);
      db.setMeetingStatus(meeting.id, 'transcription_failed');
      continue;
    }

    try {
      const captured = await rebuildCapturedUtterances(db, meeting, cfg, discordClient);
      if (captured.length === 0) {
        console.warn(`[recovery] meeting ${meeting.id}: no audio files found, marking empty/failed`);
        db.setMeetingStatus(meeting.id, 'transcription_failed');
        continue;
      }

      // A crashed session never ran /leave, so ended_at was never recorded.
      // Approximate it from when the last captured utterance began — far
      // closer to the truth than "now", since recovery may not run until days
      // later, and /history and the exported notes both display this.
      if (!meeting.ended_at) {
        const startedMs = new Date(meeting.started_at).getTime();
        const lastOffsetMs = captured[captured.length - 1]?.startMs ?? 0;
        if (!Number.isNaN(startedMs)) {
          db.endMeeting(meeting.id, new Date(startedMs + lastOffsetMs).toISOString());
        }
      }

      // Queue it rather than transcribing here. Recovery runs at startup, and
      // a restart at 9pm would otherwise seize the PC's GPU the moment the
      // bot came back — exactly the behaviour the schedule exists to prevent.
      // The audio is already safe on disk; the worker will pick this up when
      // it is allowed to.
      db.setMeetingStatus(meeting.id, 'awaiting_transcription');
      const job = db.enqueueTranscribeJob(meeting.id, { requireApproval: cfg.transcribeRequireApproval });
      console.log(
        `[recovery] meeting ${meeting.id}: recovered ${captured.length} audio file(s), queued for transcription (job ${job.id})`
      );

      if (cfg.transcribeRequireApproval && discordClient) {
        await notifyTranscribeReady({
          discordClient,
          cfg,
          meeting: db.getMeeting(meeting.id),
          jobId: job.id,
          utteranceCount: captured.length,
          serverReachable: await isWhisperServerReachable(cfg),
        });
      }
    } catch (err) {
      console.error(`[recovery] meeting ${meeting.id} failed to recover: ${err.message}`);
      db.setMeetingStatus(meeting.id, 'transcription_failed');
    }
  }
}

// Exported because deferred transcription needs exactly this: a session can
// now sit for days between being recorded and being transcribed, so by the
// time it runs the in-memory utterance list is long gone and the audio on
// disk is the only source of truth — the same situation recovery handles
// after a crash.
export async function rebuildCapturedUtterances(db, meeting, cfg, discordClient) {
  const captured = [];
  let userDirs;
  try {
    userDirs = await readdir(meeting.audio_dir, { withFileTypes: true });
  } catch {
    return captured; // audio_dir itself is gone
  }

  for (const entry of userDirs) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const userPath = join(meeting.audio_dir, userId);
    const files = await readdir(userPath).catch(() => []);

    // Prefer a live Discord display name (same as a normal /join), falling
    // back to the bare user ID only if we have no client, the guild isn't
    // cached, or the member can't be fetched (e.g. they've since left).
    // Character-name resolution on top of that always works either way,
    // since it's a DB lookup keyed by user_id.
    let discordName = userId;
    const guild = discordClient?.guilds.cache.get(meeting.guild_id);
    if (guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) discordName = member.displayName;
    }
    const displayName = resolveSpeakerName(db, meeting.campaign_id, userId, discordName);

    for (const file of files) {
      if (!file.endsWith('.wav')) continue;
      const startMs = parseInt(file.replace(/\.wav$/, ''), 10);
      if (Number.isNaN(startMs)) continue;

      // Same filter the live capture path applies — a session that ends
      // mid-utterance (e.g. /leave called right as someone was talking)
      // leaves a truncated/empty WAV on disk that whisper.cpp can't do
      // anything useful with and would otherwise just log as a failure.
      const filePath = join(userPath, file);
      if ((await wavDurationMs(filePath)) < MIN_UTTERANCE_MS) continue;

      captured.push({
        userId,
        displayName,
        wavPath: filePath,
        startMs,
        endMs: startMs, // unknown after a crash; fine, only used for talk-time stats we don't compute yet
      });
    }
  }

  return captured.sort((a, b) => a.startMs - b.startMs);
}
