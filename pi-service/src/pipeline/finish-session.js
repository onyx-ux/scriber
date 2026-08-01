import { rm } from 'node:fs/promises';

import { transcribeAll } from './transcribe.js';
import { applyCorrections } from '../campaign/corrections.js';
import { syncSessionAudio, backupAndSyncDatabase } from '../sync/drive-sync.js';
import { buildCompressedSessionRecording } from './session-recording.js';
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

  // Building + compressing a whole-session recording costs real CPU time on
  // top of transcription, so only pay for it when the result would actually
  // be used. When it is, this uploads ONE clean, listenable recording of the
  // whole session instead of the raw per-utterance fragment directory
  // (hundreds of tiny files a person was never meant to open individually).
  // Pointless if the audio is being discarded — the upload would be the only
  // copy of something we just decided not to keep.
  if (cfg.keepAudio && cfg.driveSyncEnabled && cfg.driveSyncAudio) {
    buildCompressedSessionRecording(capturedUtterances, audioDir)
      .then((mp3Path) => (mp3Path ? syncSessionAudio(mp3Path, meetingId, cfg) : null))
      .catch((err) => console.warn(`[session-recording] meeting ${meetingId}: ${err.message}`));
  }

  // Deliberately after finalizeTranscription, never before: until that
  // transaction commits, these files are the ONLY copy of the session, and
  // recovery.js rebuilds a crashed meeting by scanning this very directory.
  // Once the transcript is in the database the audio has served its purpose.
  if (!cfg.keepAudio) {
    await rm(audioDir, { recursive: true, force: true }).catch((err) =>
      console.warn(`[audio] meeting ${meetingId}: could not remove ${audioDir}: ${err.message}`)
    );
  }

  backupAndSyncDatabase(db, cfg).catch(() => {});

  return { ok: true, utteranceCount: utterances.length, failures, job };
}
