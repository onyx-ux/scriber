import { transcribeAll } from './transcribe.js';
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

  db.insertUtterances(meetingId, utterances);
  db.setMeetingStatus(meetingId, 'awaiting_summary');
  db.enqueueSummarizeJob(meetingId);

  syncSessionAudio(audioDir, meetingId, cfg).catch(() => {});
  backupAndSyncDatabase(db, cfg).catch(() => {});

  return { ok: true, utteranceCount: utterances.length, failures };
}
