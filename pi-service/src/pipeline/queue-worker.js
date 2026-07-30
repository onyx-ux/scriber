import { summarizeViaOllama } from './summarize-client.js';
import { buildTranscriptText } from './transcribe.js';
import { exportMarkdown } from '../export/markdown.js';
import { postSessionNotes } from '../delivery/discord-post.js';
import { syncSessionMarkdown, backupAndSyncDatabase, pullLedgerFromDrive, pushLedgerToDrive } from '../sync/drive-sync.js';
import { updateCampaignLedger, campaignDirInfo } from '../campaign/ledger.js';

function backoffMs(attempts, cfg) {
  const ms = cfg.summarizeRetryBaseMs * Math.pow(2, attempts);
  return Math.min(ms, cfg.summarizeRetryMaxMs);
}

// Call once at startup: setInterval(() => tick(...), 15000)
export async function tick(db, discordClient, cfg) {
  const job = db.nextDueJob();
  if (!job) return;

  db.markJobRunning(job.id);
  const meeting = db.getMeeting(job.meeting_id);

  try {
    const utterances = db.listUtterances(meeting.id);
    const transcript = buildTranscriptText(utterances);
    const meta = {
      channelName: meeting.channel_name,
      date: meeting.started_at,
      attendees: [...new Set(utterances.map((u) => u.display_name))],
    };

    const notes = await summarizeViaOllama(transcript, meta, cfg);

    db.setSummary(meeting.id, notes);
    const mdPath = await exportMarkdown({ meeting, utterances, notes, cfg });
    await postSessionNotes({ discordClient, meeting, notes, mdPath, cfg });

    // Pull the ledger down first — you may have edited NPCs.md/Locations.md
    // etc. directly in Obsidian since the last session, and we don't want
    // to append onto a stale local copy and lose those edits.
    const { localDir: ledgerDir, remoteSubpath: ledgerRemote } = campaignDirInfo(
      cfg,
      meeting.guild_id,
      meeting.channel_name
    );
    await pullLedgerFromDrive(ledgerDir, ledgerRemote, cfg);
    await updateCampaignLedger({ meeting, notes, cfg });
    await pushLedgerToDrive(ledgerDir, ledgerRemote, cfg);

    db.markJobDone(job.id);
    console.log(`[queue] meeting ${meeting.id} summarized and posted`);

    // The markdown now includes the AI summary, not just the raw transcript
    // — this is the version worth having synced to Drive/Obsidian. Also
    // refresh the DB snapshot so the backup reflects summary_json too.
    await syncSessionMarkdown(mdPath, cfg).catch(() => {});
    await backupAndSyncDatabase(db, cfg).catch(() => {});
  } catch (err) {
    const attempts = job.attempts + 1;
    const hitMax = cfg.summarizeMaxAttempts > 0 && attempts >= cfg.summarizeMaxAttempts;

    if (hitMax) {
      db.failJobPermanently(job.id, err.message);
      db.setMeetingStatus(meeting.id, 'summary_failed');
      console.error(`[queue] meeting ${meeting.id} failed permanently after ${attempts} attempts: ${err.message}`);
      return;
    }

    const delay = backoffMs(attempts, cfg);
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    db.rescheduleJob(job.id, nextAttemptAt, err.message);
    console.warn(
      `[queue] meeting ${meeting.id} summarize attempt ${attempts} failed (${err.message}) — retrying in ${Math.round(delay / 1000)}s`
    );
  }
}

export function startQueueWorker(db, discordClient, cfg, intervalMs = 15000) {
  const handle = setInterval(() => {
    tick(db, discordClient, cfg).catch((err) => console.error('[queue] tick error:', err));
  }, intervalMs);
  return () => clearInterval(handle);
}
