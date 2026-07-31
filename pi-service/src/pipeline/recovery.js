import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { finishSession } from './finish-session.js';
import { resolveSpeakerName } from '../campaign/character-names.js';
import { EMPTY_WAV_SIZE } from '../voice/capture.js';

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

async function rebuildCapturedUtterances(db, meeting, cfg, discordClient) {
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
    const displayName = resolveSpeakerName(db, meeting.guild_id, userId, discordName);

    for (const file of files) {
      if (!file.endsWith('.wav')) continue;
      const startMs = parseInt(file.replace(/\.wav$/, ''), 10);
      if (Number.isNaN(startMs)) continue;

      // Same filter the live capture path applies — a session that ends
      // mid-utterance (e.g. /leave called right as someone was talking)
      // leaves a truncated/empty WAV on disk that whisper.cpp can't do
      // anything useful with and would otherwise just log as a failure.
      const filePath = join(userPath, file);
      const { size } = await stat(filePath).catch(() => ({ size: 0 }));
      if (size <= EMPTY_WAV_SIZE) continue;

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
