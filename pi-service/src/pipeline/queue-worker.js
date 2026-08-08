import { summarizeTranscript } from './summarize-client.js';
import { withProvider, summariserLabel } from './model-client.js';
import { buildTranscriptText } from './transcribe.js';
import { exportMarkdown } from '../export/markdown.js';
import { exportCampaignSite } from '../export/site.js';
import { postSessionNotes } from '../delivery/discord-post.js';
import { syncSessionMarkdown, backupAndSyncDatabase, pullLedgerFromDrive, pushLedgerToDrive } from '../sync/drive-sync.js';
import {
  updateCampaignLedger,
  campaignDirInfo,
  readKnownEntities,
  readKnownEntityNames,
  entryKey,
} from '../campaign/ledger.js';
import { splitEntryName } from '../campaign/entry-name.js';
import { startLiveProgress } from '../delivery/live-progress.js';

// Drop NPCs and locations the campaign already knows about from THIS
// session's recap. The party visiting the same tavern every week shouldn't
// re-list it as a "location visited" forever — the ledger is the permanent
// record, the per-session recap should only carry what's new. The stored
// summary keeps everything; this only affects what gets displayed.
export function withoutAlreadyKnown(notes, known) {
  return {
    ...notes,
    npcsIntroduced: (notes.npcsIntroduced || []).filter((n) => !known.npcs.has(entryKey(n))),
    locationsVisited: (notes.locationsVisited || []).filter((l) => !known.locations.has(entryKey(l))),
  };
}

function backoffMs(attempts, cfg) {
  const ms = cfg.summarizeRetryBaseMs * Math.pow(2, attempts);
  return Math.min(ms, cfg.summarizeRetryMaxMs);
}

// Renders "what is it doing right now" from the summariser's progress events.
// A long session is summarised in slices and then reduced, and on a local
// model each slice can take minutes — so the slice count is the difference
// between "it's working" and "it's hung".
export function renderSummaryProgress(state, label) {
  const { phase, done = 0, total = 0, failed = 0 } = state;
  const note = failed > 0 ? `  ·  ${failed} section(s) failed so far` : '';

  if (phase === 'slices') {
    const bar = total ? ` (${Math.floor((done / total) * 100)}%)` : '';
    return `📝 Summarising with **${label}** — section ${Math.min(done + 1, total)} of ${total}${bar}${note}`;
  }
  if (phase === 'reduce') {
    return done ? `📝 Summarising with **${label}** — assembling the recap…` : `📝 Summarising with **${label}** — combining sections…`;
  }
  return `📝 Summarising with **${label}**…`;
}

// Best-effort throughout: this is a status line, and no failure to post or
// edit it may interfere with the summary it describes.
async function startSummaryProgress({ discordClient, meeting, cfg, jobCfg }) {
  const channelId = cfg.notesChannelId || meeting.channel_id;
  const channel = await discordClient?.channels?.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const label = summariserLabel(jobCfg);
  let state = { phase: 'starting' };

  const live = startLiveProgress({
    channel,
    initial: `📝 Summarising session #${meeting.id} with **${label}**…`,
    render: () => renderSummaryProgress(state, label),
  });

  return {
    report(event) {
      state = event;
    },
    finish: (text) => live.finish(text),
    remove: () => live.remove(),
  };
}

// Call once at startup: setInterval(() => tick(...), 15000)
export async function tick(db, discordClient, cfg) {
  // /pause sets this so nothing is sent to the summariser for a while.
  // Queued work is untouched and resumes exactly where it left off.
  if (db.getSetting('summarize_paused') === 'true') return;

  const job = db.nextDueJob();
  if (!job) return;

  db.markJobRunning(job.id);
  const meeting = db.getMeeting(job.meeting_id);

  // A job can pin its own summariser (chosen per-session via an approval
  // button or /summarise provider:...); otherwise this is just cfg.
  const jobCfg = withProvider(cfg, job.provider);

  let progress = null;
  try {
    const utterances = db.listUtterances(meeting.id);
    const transcript = buildTranscriptText(utterances);
    const meta = {
      channelName: meeting.channel_name,
      date: meeting.started_at,
      attendees: [...new Set(utterances.map((u) => u.display_name))],
    };

    if (job.provider) {
      console.log(`[queue] meeting ${meeting.id}: using per-session summariser ${summariserLabel(jobCfg)}`);
    }

    // Keep a status line current while this runs. Summarising a long session
    // can take anything from seconds to an hour depending on the provider,
    // and silence for that long is indistinguishable from a crash.
    progress = await startSummaryProgress({ discordClient, meeting, cfg, jobCfg });

    const notes = await summarizeTranscript(transcript, meta, jobCfg, {
      onProgress: (event) => progress?.report(event),
    });

    // Store the FULL summary — /recap, /funny and the ledger all read this,
    // and it should stay the complete record of the session.
    db.setSummary(meeting.id, notes);

    // Pull the ledger down first — you may have edited NPCs.md/Locations.md
    // etc. directly in Obsidian since the last session, and we don't want
    // to append onto a stale local copy and lose those edits. Doing it before
    // rendering also means "what does this campaign already know" reflects
    // your manual edits, not just what the bot has seen.
    const { localDir: ledgerDir, remoteSubpath: ledgerRemote } = campaignDirInfo(
      cfg,
      meeting.guild_id,
      meeting.channel_name
    );
    await pullLedgerFromDrive(ledgerDir, ledgerRemote, cfg);

    const known = await readKnownEntities(cfg, meeting.guild_id, meeting.channel_name);
    const displayNotes = withoutAlreadyKnown(notes, known);

    // What the prose is allowed to link to: everyone this campaign already
    // knows about, plus whoever turned up this session. Taken from the FULL
    // notes rather than displayNotes — an NPC omitted from the list because
    // an earlier session already introduced them is exactly the sort of
    // recurring character whose mentions most deserve a link.
    const knownNames = await readKnownEntityNames(cfg, meeting.guild_id, meeting.channel_name);
    const entities = [
      ...knownNames.npcs,
      ...knownNames.locations,
      ...[...(notes.npcsIntroduced || []), ...(notes.locationsVisited || [])].map(
        (e) => splitEntryName(e).name
      ),
    ];

    const mdPath = await exportMarkdown({ meeting, utterances, notes: displayNotes, cfg, entities });

    // The notes themselves are about to appear, so the status line has done
    // its job — remove it rather than leaving "summarising…" above the result.
    await progress?.remove();
    progress = null;

    await postSessionNotes({ discordClient, meeting, notes: displayNotes, mdPath, cfg });

    // Ledger update uses the unfiltered notes so it stays authoritative.
    await updateCampaignLedger({ meeting, notes, cfg });
    await pushLedgerToDrive(ledgerDir, ledgerRemote, cfg);

    // Regenerate the browsable archive page. Best-effort — a failure here
    // must not fail an otherwise-complete session.
    await exportCampaignSite(db, meeting.guild_id, cfg).catch((err) =>
      console.warn(`[site] archive page not regenerated: ${err.message}`)
    );

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
      await progress?.finish(
        `❌ Session #${meeting.id}: summarising failed after ${attempts} attempts — \`${err.message.slice(0, 200)}\`\n` +
          `The transcript is safe. Use \`/summarise meeting_id:${meeting.id}\` to try again.`
      );
      return;
    }

    const delay = backoffMs(attempts, cfg);
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    db.rescheduleJob(job.id, nextAttemptAt, err.message);
    console.warn(
      `[queue] meeting ${meeting.id} summarize attempt ${attempts} failed (${err.message}) — retrying in ${Math.round(delay / 1000)}s`
    );
    // Say so rather than leaving a stale "summarising…" line up: a retry can
    // be half an hour away, and the transcript being safe is the useful part.
    await progress?.finish(
      `⚠️ Session #${meeting.id}: summarising failed (\`${err.message.slice(0, 150)}\`) — retrying in ${Math.round(delay / 1000)}s. The transcript is safe.`
    );
  }
}

export function startQueueWorker(db, discordClient, cfg, intervalMs = 15000) {
  const handle = setInterval(() => {
    tick(db, discordClient, cfg).catch((err) => console.error('[queue] tick error:', err));
  }, intervalMs);
  return () => clearInterval(handle);
}
