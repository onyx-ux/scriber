// Cutting a payload down to what the person asking is entitled to.
//
// This is the half of access control that matters. Hiding a button is a
// courtesy to the person looking at the screen; not sending them the data is
// the part that survives someone opening the network tab. Every field removed
// here is removed BEFORE it leaves the Pi, so the dashboard's own rendering
// rules are decoration on top of a payload that is already correct.
//
// Two rules, both from the user's own brief:
//
//   * anything that spends the owner's money or seizes their hardware is the
//     owner's business alone;
//   * which model wrote a recap is nobody's business but the person paying for
//     it. A player reading last week's notes does not need to know, and telling
//     them invites a conversation about it that is not theirs to have.
import { maySee, mayManage } from './viewer.js';

// The status snapshot, cut to size.
//
// Rebuilt field by field rather than deleted from: a payload that grows a new
// field later should not silently start leaking, and the only way to get that
// property is for this to be a list of what goes IN.
export function scopeStatus(status, viewer) {
  if (viewer?.can?.everything) return status;

  const campaigns = (status.campaigns ?? []).filter((c) => maySee(viewer, c.id));
  const guildIds = new Set(campaigns.map((c) => c.guildId));

  const scoped = {
    generatedAt: status.generatedAt,
    // The bot's own identity and uptime stay: a dashboard that will not say
    // whether the bot is online is not a dashboard. The opus backend goes —
    // that is a fact about the operator's machine.
    bot: {
      user: status.bot?.user ?? null,
      online: Boolean(status.bot?.online),
      uptimeMs: status.bot?.uptimeMs ?? null,
    },
    campaigns: campaigns.map((c) => scopeCampaignRow(c, viewer)),
    recording: (status.recording ?? []).filter((r) => guildIds.has(r.guildId)),
    // Health without the machinery: whether the bot can currently turn speech
    // into notes at all is something a player is entitled to know, because it
    // explains why last night has not appeared. WHICH transcriber and WHICH
    // model is not.
    health: viewer?.can?.models
      ? status.health
      : {
          working: status.health?.whisperServer !== false && status.health?.summariser !== false,
          paused: Boolean(status.health?.transcribePaused || status.health?.summarisePaused),
        },
    actionsEnabled: status.actionsEnabled,
    viewer: { level: viewer?.level ?? 'none', username: viewer?.username ?? null, can: viewer?.can },
  };

  if (viewer?.can?.servers) {
    scoped.servers = (status.servers ?? []).filter((g) => viewer.guildIds.includes(g.id) || guildIds.has(g.id));
  }

  if (viewer?.can?.metrics) {
    scoped.totals = {
      campaigns: campaigns.length,
      sessions: campaigns.reduce((n, c) => n + c.sessions, 0),
      lines: campaigns.reduce((n, c) => n + c.lines, 0),
      hours: campaigns.reduce((n, c) => n + c.hours, 0),
      players: new Set(campaigns.map((c) => c.members)).size ? campaigns.reduce((n, c) => n + c.members, 0) : 0,
    };
  }

  // The queue is machinery: it is a list of what is about to spend the GPU and
  // the API budget, and every control over it is the owner's.
  if (viewer?.can?.machinery) {
    scoped.working = status.working;
    scoped.queue = status.queue;
    scoped.schedule = status.schedule;
    scoped.providers = status.providers;
    scoped.totals = status.totals;
    // The API bill, and which model is spending it. One person's business.
    scoped.models = status.models;
    scoped.backup = status.backup;
  }

  return scoped;
}

// One campaign row in the rail. The counts a player sees are about their own
// table, which is theirs; the hours and the line totals are the operator's
// capacity-planning numbers and go with the rest of the metrics.
function scopeCampaignRow(campaign, viewer) {
  const base = {
    id: campaign.id,
    name: campaign.name,
    channel: campaign.channel,
    guildId: campaign.guildId,
    guildName: campaign.guildName,
    sessions: campaign.sessions,
    members: campaign.members,
    lastSessionAt: campaign.lastSessionAt,
    recording: campaign.recording,
    claimed: campaign.claimed,
  };

  if (viewer?.can?.metrics) {
    Object.assign(base, {
      completed: campaign.completed,
      named: campaign.named,
      lines: campaign.lines,
      hours: campaign.hours,
      output: campaign.output,
    });
  } else {
    // Kept at zero rather than absent, so the page's arithmetic does not have
    // to know which fields it might not have been given.
    Object.assign(base, { lines: 0, hours: 0, output: 'default' });
  }

  // A decision badge only means something to somebody who can act on it.
  base.awaiting = viewer?.can?.approvals ? campaign.awaiting : 0;
  base.mine = mayManage(viewer, campaign.id);
  return base;
}

// One campaign in full.
//
// The roster is the sensitive part: it is a list of Discord accounts and their
// consent states, which is exactly the thing a player at the table has no
// business reading about the person sitting next to them.
export function scopeCampaign(view, viewer) {
  if (viewer?.can?.everything) return view;

  const manage = mayManage(viewer, view.id);

  const scoped = {
    id: view.id,
    name: view.name,
    label: view.label,
    guildId: view.guildId,
    channel: view.channel,
    claimed: view.claimed,
    output: manage ? view.output : 'default',
    // Sessions minus the machinery: what happened and whether it is readable,
    // never the job that is about to spend something on it.
    sessions: (view.sessions ?? []).map((s) => scopeSession(s, viewer)),
    // Corrections are the table's shared vocabulary and reading them is
    // harmless; changing them is gated on the action side.
    corrections: manage ? view.corrections : [],
    roster: manage
      ? view.roster
      // Who else is at the table, without the accounts or the consent states.
      // A player seeing "Priya — asked, no answer yet" is being shown somebody
      // else's private decision about being recorded.
      : (view.roster ?? []).map((p) => ({
          userId: p.userId === viewer?.userId ? p.userId : null,
          displayName: p.displayName,
          characterName: p.characterName,
          lines: p.lines,
          enrolled: p.enrolled,
          consent: p.userId === viewer?.userId ? p.consent : { state: 'hidden', label: '', mayRecord: false },
        })),
    viewerCan: { manage, transcripts: Boolean(viewer?.can?.transcripts) },
  };

  return scoped;
}

function scopeSession(session, viewer) {
  if (viewer?.can?.machinery) return session;
  const { job, ...rest } = session;
  return {
    ...rest,
    // The state word survives — "posted", "failed", "queued" all describe the
    // session rather than the machine — but the job behind it does not, and
    // neither does the offer to throw it away.
    job: job ? { status: job.status, type: job.type } : null,
    discardable: false,
  };
}
