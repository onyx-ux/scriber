import { transcribeAll } from './transcribe.js';
import { applyCorrections } from '../campaign/corrections.js';
import { syncSessionAudio, backupAndSyncDatabase } from '../sync/drive-sync.js';

// capturedUtterances: [{ userId, displayName, wavPath, startMs, endMs }]
// Returns { ok, utteranceCount, failures }
export async function finishSession(db, meetingId, capturedUtterances, audioDir, cfg) {
  db.setMeetingStatus(meetingId, 'transcribing');

  const { utterances, failures } = await transcribeAll(capturedUtterances, cfg, {
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        console.log(`[transcribe] meeting ${meetingId}: ${done}/${total}`);
      }
    },
  });

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
  });

  syncSessionAudio(audioDir, meetingId, cfg).catch(() => {});
  backupAndSyncDatabase(db, cfg).catch(() => {});

  return { ok: true, utteranceCount: utterances.length, failures, job };
}
