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
// Which capability each section rides behind. Declared once, next to the code
// that builds it, and used here to decide what may be SENT — so a section
// cannot be added to the snapshot with its audience decided in only one of the
// two places. See web/status.js.
import { SECTIONS } from './status.js';

// The sections that are not simply kept or dropped, but cut down first.
//
// A server owner may see servers, but only the ones that are theirs or that
// hold a campaign they can reach. Everything else in SECTIONS is all-or-
// nothing, which is why this map has one entry rather than nine.
const TRANSFORMS = {
  servers: (servers, viewer, guildIds) =>
    (servers ?? []).filter((g) => viewer.guildIds.includes(g.id) || guildIds.has(g.id)),
};

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
    // Filtered by CAMPAIGN rather than by Discord.
    //
    // Being able to see something in that server used to be reason enough,
    // because a server could only hold one live session and it was the one you
    // were being shown. Now that two tables in one Discord can record at once,
    // that rule would hand a player at one table the other table's session —
    // its channel, its clip count, how many people are speaking in it. A
    // session belongs to a campaign, so it goes where that campaign goes.
    //
    // The guild test remains as the fallback for a session that names no
    // campaign, which is the only shape older sessions could have.
    recording: (status.recording ?? []).filter((r) =>
      r.campaignId ? maySee(viewer, r.campaignId) : guildIds.has(r.guildId)
    ),
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

  // The metrics totals are computed rather than passed through: they are this
  // viewer's own numbers, added up over the campaigns they can actually see.
  // Applied BEFORE the section table below, because a viewer who has machinery
  // as well gets the install-wide totals instead and that has to win.
  if (viewer?.can?.metrics) {
    scoped.totals = {
      campaigns: campaigns.length,
      sessions: campaigns.reduce((n, c) => n + c.sessions, 0),
      lines: campaigns.reduce((n, c) => n + c.lines, 0),
      hours: campaigns.reduce((n, c) => n + c.hours, 0),
      players: new Set(campaigns.map((c) => c.members)).size ? campaigns.reduce((n, c) => n + c.members, 0) : 0,
    };
  }

  // Everything the snapshot declared a capability for.
  //
  // Still a list of what goes IN — the loop only ever ADDS a section, and only
  // when this viewer holds the capability the section named. A section whose
  // capability nobody thought about does not appear here at all, because it
  // does not appear in SECTIONS. The queue, the schedule and the model bill are
  // machinery by that declaration: they are a list of what is about to spend
  // the GPU and the API budget, and every control over them is the owner's.
  for (const [name, capability] of Object.entries(SECTIONS)) {
    if (!viewer?.can?.[capability]) continue;
    // Absent because the snapshot did not build it for this viewer, which is
    // the same answer as "not allowed" and reaches here for the same reason.
    if (!(name in status)) continue;

    const transform = TRANSFORMS[name];
    scoped[name] = transform ? transform(status[name], viewer, guildIds) : status[name];
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
    // The session that is recording it, when one is. The page's live clock
    // finds its session with this; matching on the guild picked an arbitrary
    // one of two once a Discord could hold both.
    meetingId: campaign.meetingId ?? null,
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
    // Only to somebody who could act on it. To everybody else "who runs this"
    // is a name, which the roster already gives them, and an id, which it does
    // not — see the roster cut below.
    managerUserId: manage ? (view.managerUserId ?? null) : null,
    output: manage ? view.output : 'default',
    // Which channel, when the destination is one. Only ever to somebody who
    // may change it: to everyone else it is a fact about where this table's
    // write-ups are read, which is not the same question as what happened at
    // the table and is not theirs to be told.
    outputChannelId: manage ? (view.outputChannelId ?? null) : null,
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
          // Kept in the cut, unlike everything else here. A colour is not a
          // fact about somebody's account, it is how their name is drawn —
          // it is already on every line of a transcript and beside every
          // correction they make to a write-up, and a player who could not
          // read their own back would have no way of knowing what they had
          // chosen. The id beside it is still nulled for everybody else.
          colour: p.colour ?? null,
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
