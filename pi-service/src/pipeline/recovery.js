import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { finishSession } from './finish-session.js';

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
export async function recoverInterruptedMeetings(db, cfg) {
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
      const captured = await rebuildCapturedUtterances(db, meeting, cfg);
      if (captured.length === 0) {
        console.warn(`[recovery] meeting ${meeting.id}: no audio files found, marking empty/failed`);
        db.setMeetingStatus(meeting.id, 'transcription_failed');
        continue;
      }

      console.log(`[recovery] meeting ${meeting.id}: recovered ${captured.length} audio file(s), transcribing...`);
      const result = await finishSession(db, meeting.id, captured, meeting.audio_dir, cfg);
      console.log(
        `[recovery] meeting ${meeting.id}: ${result.ok ? `recovered ${result.utteranceCount} utterances` : 'recovery transcription produced nothing usable'}`
      );
    } catch (err) {
      console.error(`[recovery] meeting ${meeting.id} failed to recover: ${err.message}`);
      db.setMeetingStatus(meeting.id, 'transcription_failed');
    }
  }
}

async function rebuildCapturedUtterances(db, meeting, cfg) {
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

    // Character-name resolution still works here even without a live
    // Discord guild fetch, since it's a DB lookup keyed by user_id —
    // recovered transcripts get the same character names as normal.
    const displayName = db.getCharacterName(meeting.guild_id, userId) || userId;

    for (const file of files) {
      if (!file.endsWith('.wav')) continue;
      const startMs = parseInt(file.replace(/\.wav$/, ''), 10);
      if (Number.isNaN(startMs)) continue;
      captured.push({
        userId,
        displayName,
        wavPath: join(userPath, file),
        startMs,
        endMs: startMs, // unknown after a crash; fine, only used for talk-time stats we don't compute yet
      });
    }
  }

  return captured.sort((a, b) => a.startMs - b.startMs);
}
