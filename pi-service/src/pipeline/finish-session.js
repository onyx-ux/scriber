import { transcribeAll } from './transcribe.js';
import { applyCorrections } from '../campaign/corrections.js';
import { syncSessionAudio, backupAndSyncDatabase } from '../sync/drive-sync.js';
import { archiveSessionAudio } from './session-recording.js';
import { startTranscription, updateTranscription, endTranscription } from './progress.js';

// capturedUtterances: [{ userId, displayName, wavPath, startMs, endMs }]
// Returns { ok, utteranceCount, failures }
//
// serverReachable: whether the GPU whisper server answered a probe just
// before this ran. Only used to decide batching (see transcribe.js) — the
// actual per-clip fallback to CPU is handled inside stt/whisper.js.
export async function finishSession(
  db,
  meetingId,
  capturedUtterances,
  audioDir,
  cfg,
  { serverReachable = null, pinProvider = null } = {}
) {
  db.setMeetingStatus(meetingId, 'transcribing');

  startTranscription(meetingId, capturedUtterances.length);
  let result;
  try {
    result = await transcribeAll(capturedUtterances, cfg, {
      serverReachable,
      onProgress: (done, total) => {
        updateTranscription(meetingId, done, total);
        if (done % 10 === 0 || done === total) {
          console.log(`[transcribe] meeting ${meetingId}: ${done}/${total}`);
        }
      },
    });
  } finally {
    // Must clear even when transcription throws, or /status would report a
    // meeting as forever in progress.
    endTranscription(meetingId);
  }
  const { utterances, failures } = result;

  if (utterances.length === 0) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    return { ok: false, utteranceCount: 0, failures };
  }

  // Replay the campaign's saved /correct fixes over the fresh transcript.
  // whisper mangles the same invented names identically every session, so
  // correcting one once should fix it forever, not just retroactively.
  const meeting = db.getMeeting(meetingId);
  const corrections = meeting ? db.listCorrections(meeting.guild_id) : [];
  if (corrections.length > 0) {
    for (const u of utterances) {
      u.text = applyCorrections(u.text, corrections);
    }
  }

  // Single transaction: replaces utterances, flips status, and enqueues the
  // summarise job together, so a crash mid-way can't duplicate the transcript
  // or strand the meeting with no job. See db.finalizeTranscription.
  // With approval required the job is parked rather than made due, so nothing
  // hits the PC's GPU until the owner explicitly releases it.
  const job = db.finalizeTranscription(meetingId, utterances, {
    requireApproval: cfg.summaryRequireApproval,
    provider: pinProvider,
  });

  // Collapse the session's per-utterance fragments into one compressed
  // recording, then let AUDIO_RETENTION_DAYS age that out on the normal
  // schedule. Deliberately after finalizeTranscription, never before: until
  // that transaction commits these files are the ONLY copy of the session,
  // and recovery.js rebuilds a crashed meeting by scanning this directory.
  //
  // Not awaited — ffmpeg over a few hours of audio takes minutes, and there
  // is no reason to keep /leave waiting on it once the transcript is safe.
  if (cfg.audioArchive) {
    archiveSessionAudio(capturedUtterances, audioDir)
      .then((archive) => {
        if (!archive) return null;
        console.log(
          `[archive] meeting ${meetingId}: ${Math.round(archive.bytes / 1024 / 1024)}MB recording kept, ` +
            `${archive.speakerDirsRemoved} fragment folder(s) removed`
        );
        return cfg.driveSyncEnabled && cfg.driveSyncAudio ? syncSessionAudio(archive.mp3Path, meetingId, cfg) : null;
      })
      // A failed archive leaves the raw clips in place, so nothing is lost —
      // retention will still clear them on schedule.
      .catch((err) => console.warn(`[archive] meeting ${meetingId} kept raw clips: ${err.message}`));
  }

  backupAndSyncDatabase(db, cfg).catch(() => {});

  return { ok: true, utteranceCount: utterances.length, failures, job };
}
