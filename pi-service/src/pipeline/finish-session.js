import { rename, mkdir, copyFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { transcribeAll } from './transcribe.js';
import { applyCorrections } from '../campaign/corrections.js';
import { syncSessionAudio, backupAndSyncDatabase } from '../sync/drive-sync.js';
import { archiveSessionAudio } from './session-recording.js';
import { startTranscription, updateTranscription, endTranscription } from './progress.js';
import { campaignPrompt } from '../stt/vocabulary.js';

// Moves a finished recording into the outbox the PC collects from, so long
// campaigns don't accumulate on the Pi's card. The PC pulls and deletes
// (see pc-sync/docker-compose.yml), so this directory is a handover point,
// not storage — retention still ages it out if the PC never collects.
//
// The name has to identify the session on its own: once it leaves the Pi it
// has no directory structure or database around it to say what it was.
// fs is injectable so the EXDEV branch below can be exercised in a test —
// provoking a real cross-filesystem rename would mean mounting one.
export async function offloadArchive(mp3Path, meetingId, cfg, fs = { rename, copyFile, unlink }) {
  if (!cfg.audioOffloadDir) return null;

  await mkdir(cfg.audioOffloadDir, { recursive: true });
  const target = join(cfg.audioOffloadDir, `session-${meetingId}-${basename(mp3Path)}`);

  try {
    await fs.rename(mp3Path, target);
  } catch (err) {
    // rename() fails across filesystems (EXDEV), which is likely the moment
    // the outbox is put on different storage — fall back to copy+delete so
    // that stays a configuration choice rather than a silent breakage.
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(mp3Path, target);
    await fs.unlink(mp3Path);
  }

  console.log(`[offload] meeting ${meetingId}: recording moved to ${target} for the PC to collect`);
  return target;
}

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

  // Bias whisper toward this campaign's proper nouns before transcribing
  // anything — see stt/vocabulary.js. Campaign-scoped, so tables sharing a
  // bot (or a server) don't leak names into each other.
  const prompt = await campaignPrompt(db, cfg, db.getMeeting(meetingId));
  if (prompt) console.log(`[whisper] meeting ${meetingId}: vocabulary prompt (${prompt.length} chars)`);

  startTranscription(meetingId, capturedUtterances.length);
  let result;
  try {
    result = await transcribeAll(capturedUtterances, cfg, {
      prompt,
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
  const corrections = meeting?.campaign_id ? db.listCorrections(meeting.campaign_id) : [];
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
      .then(async (archive) => {
        if (!archive) return null;
        console.log(
          `[archive] meeting ${meetingId}: ${Math.round(archive.bytes / 1024 / 1024)}MB recording kept, ` +
            `${archive.speakerDirsRemoved} fragment folder(s) removed`
        );

        if (cfg.driveSyncEnabled && cfg.driveSyncAudio) await syncSessionAudio(archive.mp3Path, meetingId, cfg);

        // Hand the recording to the PC. Only ever reached AFTER the
        // transcript is committed and the archive exists, so the Pi never
        // gives up its only copy of something it hasn't transcribed yet.
        return offloadArchive(archive.mp3Path, meetingId, cfg);
      })
      // A failed archive leaves the raw clips in place, so nothing is lost —
      // retention will still clear them on schedule.
      .catch((err) => console.warn(`[archive] meeting ${meetingId} kept raw clips: ${err.message}`));
  }

  backupAndSyncDatabase(db, cfg).catch(() => {});

  return { ok: true, utteranceCount: utterances.length, failures, job };
}
