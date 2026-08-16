import { transcribeRequestMessage, reminderMessage } from '../pipeline/transcribe-schedule.js';
import { dashboardPointer } from './approval-notify.js';

// DMs the owner about a recording that is waiting for the PC's GPU.
//
// Deliberately a DM rather than a channel post: this is an operational
// question for the one person who owns the hardware, not something the table
// needs to see after every session.
//
// A notification, not a control — the buttons moved to the dashboard, so
// nothing in the pipeline depends on a Discord interaction arriving. See the
// note in approval-notify.js.
//
// Best-effort throughout — a DM that can't be delivered must never stop the
// recording being transcribed later. The automatic window still applies and
// the dashboard shows the job regardless, so a failed DM costs convenience
// rather than the session.
async function dmOwner(discordClient, cfg, payload, context) {
  if (!cfg.ownerUserId) {
    console.log(`[transcribe] ${context} (no OWNER_USER_ID set, so no DM sent)`);
    return false;
  }
  try {
    const user = await discordClient.users.fetch(cfg.ownerUserId);
    await user.send(payload);
    console.log(`[transcribe] DMed owner: ${context}`);
    return true;
  } catch (err) {
    console.error(`[transcribe] could not DM owner (${err.message}) — ${context}`);
    return false;
  }
}

export function notifyTranscribeReady({
  discordClient,
  cfg,
  meeting,
  jobId,
  utteranceCount,
  serverReachable,
  now = new Date(),
}) {
  return dmOwner(
    discordClient,
    cfg,
    {
      content:
        transcribeRequestMessage({
          meeting,
          meetingId: meeting.id,
          utteranceCount,
          now,
          cfg,
          serverReachable,
        }) + dashboardPointer(cfg),
    },
    `meeting ${meeting.id} is ready to transcribe (job ${jobId})`
  );
}

export function notifyTranscribeReminder({ discordClient, cfg, meeting, jobId, now = new Date() }) {
  return dmOwner(
    discordClient,
    cfg,
    {
      content:
        reminderMessage({
          meeting,
          meetingId: meeting.id,
          waitingSinceIso: meeting.ended_at || meeting.started_at,
          cfg,
          now,
        }) + dashboardPointer(cfg),
    },
    `reminder for meeting ${meeting.id} (job ${jobId})`
  );
}
