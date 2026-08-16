// MessageFlags.Ephemeral replaces the old `ephemeral: true` reply option,
// which discord.js deprecated and drops entirely in v15.
import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startCapture } from '../voice/capture.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
import { isSummariserReachable, summariserLabel, withProvider } from '../pipeline/model-client.js';
import { askCampaign, gatherContext } from '../pipeline/ask-client.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { campaignFolder, campaignFolderFor } from '../export/naming.js';
import { listTranscriptions, describeTranscription, formatDuration } from '../pipeline/progress.js';
import { withinAutoWindow, TRANSCRIBE_PREFIX } from '../pipeline/transcribe-schedule.js';
// The operations themselves, shared with the dashboard so the two surfaces
// cannot drift — see pipeline/job-actions.js.
import { transcribeAction, approveAllSummaries, providerUnusableReason } from '../pipeline/job-actions.js';
import { notifyTranscribeReady } from '../delivery/transcribe-notify.js';
import { resolveSpeakerName } from '../campaign/character-names.js';
import { applyCorrections } from '../campaign/corrections.js';
import { importAudio } from '../pipeline/import-audio.js';
import { readLedgerFile } from '../campaign/ledger.js';
import {
  resolveReadableCampaign,
  resolveMemberCampaign,
  resolveManagedCampaign,
  campaignLabel,
  campaignNameClash,
  nameIsUsable,
  findCampaign,
} from '../campaign/resolve.js';
import { refuseUnlessOwner, isOwner } from '../campaign/permissions.js';
import { resolveSessionRef, sessionRef, refSlug } from '../campaign/session-ref.js';
import { moveCampaignFolder } from '../campaign/vault-migrate.js';
import {
  CONSENT_PREFIX,
  parseConsentButton,
  buildInviteDm,
  inviteExpiry,
  discordTime,
  acceptedMessage,
  declinedMessage,
  expiredMessage,
  describeUnrecorded,
} from '../campaign/consent.js';
import { exportCampaignSite } from '../export/site.js';
import {
  notifyApprovalNeeded,
  dashboardPointer,
  APPROVE_PREFIX,
  PARK_PREFIX,
} from '../delivery/approval-notify.js';
import {
  pick,
  JOIN_NO_CHANNEL,
  JOIN_ALREADY_RECORDING,
  JOIN_STARTED,
  JOIN_FAILED,
  LEAVE_NOT_RECORDING,
  LEAVE_START,
  LEAVE_NOTHING_USABLE,
  LEAVE_SUMMARIZING_NOW,
  LEAVE_SUMMARY_QUEUED,
  HISTORY_EMPTY,
  SUMMARIZE_UNREACHABLE,
  SUMMARIZE_QUEUED,
  EXPORT_INTRO,
  SETCHARACTER_CONFIRM,
  STATUS_IDLE,
  STATUS_QUEUED_HEADER,
  RECAP_NONE,
  RECAP_HEADER,
  FUNNY_NONE,
  FUNNY_HEADER,
  SEARCH_NONE,
  SEARCH_HEADER,
  LEAVE_AWAITING_APPROVAL,
  APPROVED_CONFIRM,
  QUEUE_PAUSED,
  QUEUE_RESUMED,
  PENDING_EMPTY,
  CORRECT_APPLIED,
  UNCORRECT_APPLIED,
  WHOAMI_SET,
  WHOAMI_UNSET,
  STATS_HEADER,
  STATS_EMPTY,
  NPCS_EMPTY,
  NPCS_HEADER,
  LOCATIONS_EMPTY,
  LOCATIONS_HEADER,
  ARCHIVE_SENT,
  GENERIC_ERROR,
} from '../flavor.js';

// active sessions keyed by guildId, since one bot instance can only sensibly
// record one channel per guild at a time
export const activeSessions = new Map();

// Guilds with a /join currently in flight but not yet registered above.
// Guards the window between the "already recording?" check and the session
// actually landing in activeSessions (see handleJoin).
const startingGuilds = new Set();

// Commands a PLAYER can run anywhere.
//
// Discord calls this a user install: a player adds Quill to their own
// account and its commands follow them into any channel, including servers
// the bot has never been in. Discord makes those replies visible only to the
// caller, which suits these nine — they already reply privately.
//
// Only the read-only ones. /join needs the bot in the voice channel it is
// being asked to record, and anything that changes the campaign belongs to
// the table, not to whoever installed the app.
//
// The optional `campaign` option exists because interaction.guildId is
// useless here: run in some unrelated server it names that server, not the
// game. campaign/scope.js resolves it, and enforces that a caller can only
// reach a campaign they have actually spoken in.
const IntegrationType = { GUILD_INSTALL: 0, USER_INSTALL: 1 };
const InteractionContext = { GUILD: 0, BOT_DM: 1, PRIVATE_CHANNEL: 2 };

// The nine, by name, so the dispatcher and the autocomplete agree with the
// builders about which commands are user-installable.
const PLAYER_COMMANDS = new Set([
  'history', 'recap', 'funny', 'search', 'ask', 'stats', 'npcs', 'locations', 'archive',
]);

// The pipeline. These spend the owner's GPU, API budget and disk, so nobody
// else has a reason to reach them in any server — the dashboard is where they
// belong for day-to-day use, and these stay as the away-from-home fallback.
export const OWNER_ONLY = new Set([
  'approve', 'transcribe', 'summarise', 'pause', 'resume', 'import', 'export', 'pending',
]);

// A campaign's records. Held by whoever created the campaign, not by a Discord
// permission — see campaign/permissions.js. /campaign itself is absent because
// creating one has to be possible for someone who runs none yet; its
// subcommands do their own checks.
// /status is read-only — it says what is queued and whether the summariser is
// reachable — so a manager waiting on their own session can check without
// having to ask the owner.
export const MANAGER_ONLY = new Set(['dm', 'correct', 'uncorrect', 'corrections', 'status']);

// Commands that act on the table you are sitting at: they need a campaign you
// are on the roster for, in this server.
const MEMBER_COMMANDS = new Set(['join', 'setcharacter', 'whoami']);

// How many campaigns one Discord may hold, and how many one person may run.
//
// Creating a campaign is open to anyone — that is how a table starts using the
// bot, and requiring the owner to bless each one defeats the point. Open and
// unbounded is a different thing though: /campaign create writes a row and a
// vault folder, so in a public server it would be a free spam primitive. These
// are deliberately far above what a real server needs and far below what an
// abuser wants.
const MAX_CAMPAIGNS_PER_GUILD = 10;
const MAX_CAMPAIGNS_PER_MANAGER = 20;

// Any command that RESOLVES a campaign has to let you name one, or its own
// "re-run with the `campaign` option" refusal is an instruction you cannot
// follow. Six commands shipped without it and became unusable the moment a
// server held two tables — see the test that now enforces this.
function campaignOption(o) {
  return o
    .setName('campaign')
    .setDescription("Which campaign (only needed if you're in more than one)")
    .setRequired(false)
    .setAutocomplete(true);
}

function withCampaign(builder) {
  return builder.addStringOption(campaignOption);
}

function playerCommand(builder) {
  return withCampaign(
    builder
      .setIntegrationTypes([IntegrationType.GUILD_INSTALL, IntegrationType.USER_INSTALL])
      .setContexts([InteractionContext.GUILD, InteractionContext.BOT_DM, InteractionContext.PRIVATE_CHANNEL])
  );
}

export const commandDefs = [
  // Recording someone requires being at their table. Membership is the
  // bot's own roster, not Discord's member list — in a server the bot was
  // invited to, being able to see a voice channel is not permission to
  // record the game happening in it.
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Start recording this voice channel')
    .addStringOption((o) =>
      o
        .setName('campaign')
        .setDescription("Which campaign this session belongs to (only needed if you're in more than one here)")
        .setRequired(false)
        .setAutocomplete(true)
    ),
  // The campaign option here names the session rather than finding it — see
  // handleLeave. A bot holds one voice connection per Discord, so there is
  // only ever one recording to stop; being made to say which one is what stops
  // a /leave meant for the game next door.
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Stop recording, transcribe, and queue the summary')
    .addStringOption((o) =>
      o
        .setName('campaign')
        .setDescription("Which campaign you're ending (needed when the server holds more than one)")
        .setRequired(false)
        .setAutocomplete(true)
    ),
  playerCommand(
    new SlashCommandBuilder()
      .setName('history')
      .setDescription('List recent sessions')
      .addIntegerOption((o) => o.setName('count').setDescription('How many to show').setRequired(false))
  ),
  new SlashCommandBuilder()
    .setName('summarise')
    .setDescription('Retry summarisation now for a meeting (useful right after turning your PC on)')
    .addStringOption((o) =>
      o.setName('session').setDescription('e.g. Cipher_02').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName('provider')
        .setDescription('Who writes it (default: whatever SUMMARY_PROVIDER is set to)')
        .setRequired(false)
        .addChoices(
          { name: 'Gemini', value: 'gemini' },
          { name: 'Claude', value: 'anthropic' }
        )
    ),
  new SlashCommandBuilder()
    .setName('transcribe')
    .setDescription('Control when a recorded session may use the PC to transcribe')
    .addStringOption((o) =>
      o.setName('session').setDescription('e.g. Cipher_02').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName('when')
        .setDescription('Default: start now')
        .setRequired(false)
        .addChoices(
          { name: 'Now (needs the PC)', value: 'now' },
          { name: 'Remind me later', value: 'later' },
          { name: 'On the Pi instead (slow, no GPU)', value: 'pi' }
        )
    ),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Get the raw audio + transcript for a session')
    .addStringOption((o) =>
      o.setName('session').setDescription('e.g. Cipher_02').setRequired(true).setAutocomplete(true)
    ),
  withCampaign(
    new SlashCommandBuilder()
      .setName('setcharacter')
      .setDescription('Map your Discord account to your D&D character name for transcripts/notes')
      .addStringOption((o) => o.setName('name').setDescription('Character name').setRequired(true))
  ),
  withCampaign(
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show what is currently queued/retrying (e.g. waiting on your PC)')
  ),
  playerCommand(new SlashCommandBuilder().setName('recap').setDescription("Post last session's TL;DR again")),
  playerCommand(
    new SlashCommandBuilder()
      .setName('funny')
      .setDescription("Pull a random funny or memorable moment from this campaign's history")
  ),
  playerCommand(
    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search every transcript in this campaign for a word or phrase')
      .addStringOption((o) =>
        o.setName('query').setDescription('Word or phrase to look for (e.g. an NPC name)').setRequired(true)
      )
  ),
  withCampaign(
    new SlashCommandBuilder()
      .setName('correct')
      .setDescription('Fix a name whisper keeps mishearing — across all past sessions and all future ones')
      .addStringOption((o) =>
        o.setName('wrong').setDescription('What it hears (e.g. "Vecks")').setRequired(true)
      )
      .addStringOption((o) =>
        o.setName('right').setDescription('What it should be (e.g. "Vex")').setRequired(true)
      )
  ),
  withCampaign(
    new SlashCommandBuilder()
      .setName('corrections')
      .setDescription('List the saved transcript corrections for this campaign')
  ),
  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Show everything currently in the pipeline (recording, transcribing, awaiting approval)'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause summarising — queued sessions wait rather than being sent out'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume summarising after a /pause'),
  playerCommand(
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask a question about this campaign, answered from past sessions')
      .addStringOption((o) =>
        o.setName('question').setDescription('e.g. "who was the smuggler we met at the docks?"').setRequired(true)
      )
  ),
  new SlashCommandBuilder()
    .setName('import')
    .setDescription('Import a recording made outside Discord (in-person game, phone recording)')
    .addAttachmentOption((o) =>
      o.setName('file').setDescription('Audio or video file (Discord caps this at ~25MB)').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('url').setDescription('Direct download link — use this for files too big for Discord').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('speaker').setDescription('Label for the speakers (default "Table")').setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName('campaign')
        .setDescription('Which campaign this recording belongs to')
        .setRequired(false)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Release a session that is parked awaiting approval')
    .addIntegerOption((o) =>
      o.setName('meeting_id').setDescription('Meeting ID (omit to approve everything waiting)').setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName('provider')
        .setDescription('Who writes it (default: whatever SUMMARY_PROVIDER is set to)')
        .setRequired(false)
        .addChoices(
          { name: 'Gemini', value: 'gemini' },
          { name: 'Claude', value: 'anthropic' }
        )
    ),
  withCampaign(
    new SlashCommandBuilder()
      .setName('uncorrect')
      .setDescription('Remove a saved transcript correction')
      .addStringOption((o) =>
        o.setName('wrong').setDescription('The mangled text to stop correcting (must match /correct exactly)').setRequired(true)
      )
  ),
  // Subcommands rather than a pile of optional flags, because a server can
  // now hold several campaigns and "create" and "rename" are very different
  // acts to conflate behind one `name:` option — the flat version would have
  // made a typo in an existing campaign's name silently create a second one.
  //
  // Usable in DMs on purpose: campaign housekeeping is not something the table
  // needs to watch happen. A DM has no guild to infer the campaign from, so
  // `campaign` names one explicitly; in a server it defaults to the one you
  // run there.
  new SlashCommandBuilder()
    .setName('campaign')
    .setDescription('Create and set up a campaign — the Obsidian folder its session notes are filed in')
    .setDMPermission(true)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Start a new campaign in this server — you become its DM')
        .addStringOption((o) =>
          o.setName('name').setDescription('e.g. "Sunless Citadel"').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Show the campaigns in this server, who runs them, and where their notes go')
    )
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename a campaign you run (its notes folder moves with it)')
        .addStringOption((o) => o.setName('name').setDescription('The new name').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('campaign')
            .setDescription('Which campaign (only needed if you run more than one)')
            .setRequired(false)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('invite')
        .setDescription('Ask someone to join the campaign — they choose whether to be recorded')
        .addUserOption((o) => o.setName('player').setDescription('Who to invite').setRequired(true))
        .addStringOption((o) =>
          o.setName('name').setDescription('Their character, e.g. "BenTen" (optional)').setRequired(false)
        )
        .addStringOption(campaignOption)
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Take someone off the campaign — they can no longer be recorded in it')
        .addUserOption((o) => o.setName('player').setDescription('Who to remove').setRequired(true))
        .addStringOption(campaignOption)
    )
    .addSubcommand((s) =>
      s
        .setName('output')
        .setDescription('Where this campaign’s finished notes are posted')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Where the notes go')
            .setRequired(true)
            .addChoices(
              { name: 'Direct message to me', value: 'dm' },
              { name: 'A specific channel', value: 'channel' },
              { name: 'Back to the default', value: 'default' }
            )
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Which channel (with mode: A specific channel)').setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName('campaign')
            .setDescription('Which campaign (only needed if you run more than one)')
            .setRequired(false)
            .setAutocomplete(true)
        )
    ),
  // The DM's roster. /setcharacter only ever names the person running it, in
  // the server, which leaves the DM unable to fix a player who never set one
  // — and an unnamed player is not a cosmetic problem: the summariser is
  // handed Discord names, so a character called anything else reads as an NPC
  // the party met, and gets written up as one.
  //
  // DM-usable and autocompleted from the speakers actually recorded, so the
  // DM can set the table up without knowing a user id or making everyone run
  // a command.
  // `add` and `remove` take a real Discord user; `character` and `forget` take
  // an autocompleted recorded speaker. That split is deliberate. The
  // autocomplete can only offer people the bot has heard, which is exactly
  // nobody on a campaign that has not played yet — so enrolling the table
  // before the first session needs a plain user picker, and correcting a
  // misheard speaker afterwards needs the list of who was actually recorded.
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription("The DM's tools — who is at the table and who plays which character")
    .setDMPermission(true)
    .addSubcommand((s) =>
      s
        .setName('character')
        .setDescription("Set a player's character name")
        .addStringOption((o) =>
          o.setName('player').setDescription('Who (by Discord name)').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((o) =>
          o.setName('name').setDescription('Their character, e.g. "BenTen"').setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName('campaign')
            .setDescription('Which campaign (only needed if you run more than one)')
            .setRequired(false)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('roster')
        .setDescription('Show who plays what, and who still has no character set')
        .addStringOption((o) =>
          o
            .setName('campaign')
            .setDescription('Which campaign (only needed if you run more than one)')
            .setRequired(false)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('forget')
        .setDescription("Clear a player's character name, so they appear as their Discord name again")
        .addStringOption((o) =>
          o.setName('player').setDescription('Who (by Discord name)').setRequired(true).setAutocomplete(true)
        )
        .addStringOption((o) =>
          o
            .setName('campaign')
            .setDescription('Which campaign (only needed if you run more than one)')
            .setRequired(false)
            .setAutocomplete(true)
        )
    ),
  withCampaign(
    new SlashCommandBuilder()
      .setName('whoami')
      .setDescription('Show what name you currently appear as in transcripts and notes')
  ),
  playerCommand(
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Campaign-wide totals: sessions, hours, lines, and who talks the most')
  ),
  playerCommand(
    new SlashCommandBuilder().setName('npcs').setDescription('List every NPC the campaign has met so far')
  ),
  playerCommand(
    new SlashCommandBuilder().setName('locations').setDescription('List every location the campaign has visited so far')
  ),
  playerCommand(
    new SlashCommandBuilder()
      .setName('archive')
      .setDescription('Get the browsable campaign archive (a single HTML file) right now')
  ),
]
  .map((c) => c.toJSON())
  // Everything playerCommand() did not touch is pinned to GUILD_INSTALL here.
  //
  // Not decoration: a command that omits integration_types inherits the
  // APPLICATION's installation contexts, so the moment user install is
  // enabled in the Developer Portal every command silently becomes
  // user-installable. Discord confirmed all 27 that way on the first deploy.
  // /join would then be offered in servers the bot is not in, where it can
  // only fail — and the roster and pipeline commands would be offered to
  // whoever installed the app rather than to the table.
  //
  // dm_permission is the existing way /campaign and /dm say "the owner can
  // run this in a DM with the bot", so it selects the one context those two
  // need beyond GUILD.
  .map((c) =>
    c.integration_types
      ? c
      : {
          ...c,
          integration_types: [IntegrationType.GUILD_INSTALL],
          contexts: c.dm_permission
            ? [InteractionContext.GUILD, InteractionContext.BOT_DM]
            : [InteractionContext.GUILD],
        }
  );

// The campaign this command resolved to. Set by the dispatcher, which runs
// campaign/resolve.js before the handler — so a handler reads one value
// whether it was invoked in the campaign's own server, in a server holding
// three campaigns, or from a user install with no campaign in sight.
function campaign(interaction) {
  return interaction.quillCampaign ?? null;
}

function campaignId(interaction) {
  return interaction.quillCampaign?.id ?? null;
}

// Every campaign option, anywhere, is the ID as the value and the readable
// name as the label. Nothing user-visible is a snowflake, and nothing typed
// has to be one — resolve.js accepts a typed name too, for people who fill the
// box before the list loads.
function campaignChoices(campaigns, typed) {
  const wanted = String(typed || '').toLowerCase();
  return campaigns
    .map((c) => ({
      name: `${campaignLabel(c)} — ${c.sessions ?? 0} session${c.sessions === 1 ? '' : 's'}`.slice(0, 100),
      value: String(c.id),
      searchable: `${c.name || ''} ${c.channel_name || ''}`.toLowerCase(),
    }))
    .filter((c) => !wanted || c.searchable.includes(wanted))
    // Discord rejects the whole response if it carries more than 25.
    .slice(0, 25)
    .map(({ name, value }) => ({ name, value }));
}

// Which campaigns to offer for a given command's `campaign` option. Each list
// is the same one its handler will accept, so the picker can never offer
// something that is then refused.
function campaignsToOffer(interaction, db, cfg) {
  const name = interaction.commandName;
  const userId = interaction.user.id;

  if (name === 'join' || MEMBER_COMMANDS.has(name)) {
    return db.listCampaignsForMember(userId).filter((c) => c.guild_id === interaction.guildId);
  }

  // /leave can only stop what is actually being recorded, so that one campaign
  // is the entire list — offering the caller's other tables would be offering
  // a choice that is then refused. It also means the picker names the live
  // session before you commit to ending it, which is the point of asking.
  if (name === 'leave') {
    const live = activeSessions.get(interaction.guildId);
    const meeting = live ? db.getMeeting(live.meetingId) : null;
    const which = meeting?.campaign_id ? db.getCampaign(meeting.campaign_id) : null;
    return which ? [which] : [];
  }

  if (name === 'dm' || name === 'campaign' || MANAGER_ONLY.has(name)) {
    const all = interaction.guildId ? db.listCampaignsInGuild(interaction.guildId) : db.listCampaigns();
    return isOwner(userId, cfg) ? all : all.filter((c) => c.manager_user_id === userId);
  }

  // A player command's list is the caller's OWN campaigns, plus any in the
  // server they are standing in. Offering every campaign the bot knows would
  // leak their names to anyone who installed the app.
  const here = interaction.guildId ? db.listCampaignsInGuild(interaction.guildId) : [];
  const mine = db.listCampaignsForUser(userId);
  const seen = new Set();
  return [...here, ...mine].filter((c) => !seen.has(c.id) && seen.add(c.id));
}

async function handleCampaignAutocomplete(interaction, db, cfg) {
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value || '');

  if (focused.name === 'campaign') {
    return interaction.respond(campaignChoices(campaignsToOffer(interaction, db, cfg), typed));
  }

  // The session picker for /summarise, /transcribe and /export. Showing the
  // date alongside the reference is what makes it usable — nobody remembers
  // whether the one that failed was 02 or 03.
  if (focused.name === 'session') {
    const lower = typed.toLowerCase();
    const reachable = isOwner(interaction.user.id, cfg)
      ? db.listCampaigns()
      : db.listCampaignsForUser(interaction.user.id);
    const choices = [];

    for (const c of reachable) {
      for (const m of db.listRecentMeetings(c.id, 25)) {
        const ref = sessionRef(c.name || c.channel_name, m.session_number);
        if (!ref) continue;
        choices.push({
          name: `${ref} — ${(m.started_at || '').slice(0, 10)} (${m.status})`.slice(0, 100),
          value: ref,
        });
      }
    }

    return interaction.respond(choices.filter((c) => !lower || c.value.toLowerCase().includes(lower)).slice(0, 25));
  }

  if (focused.name === 'player') return handlePlayerAutocomplete(interaction, db, cfg, typed.toLowerCase());

  return interaction.respond([]);
}

// The players offered to /dm character and /dm forget are read from the
// ROSTER, not the characters table — the characters table only has rows for
// people already named, and naming the ones who aren't is the entire point.
// The value is the user id, so a Discord nickname change later doesn't strand
// the mapping.
async function handlePlayerAutocomplete(interaction, db, cfg, typed) {
  const resolved = resolveManagedCampaign(interaction, db, cfg);
  if (!resolved.campaign) return interaction.respond([]);

  const choices = db
    .listRoster(resolved.campaign.id)
    .map((r) => {
      const who = r.displayName || `user ${r.userId}`;
      return {
        // Showing the current mapping makes the roster readable from the
        // picker itself, which is where the DM is already looking.
        name: r.characterName ? `${who} → ${r.characterName}` : `${who} — no character set`,
        value: r.userId,
        searchable: `${who} ${r.characterName || ''}`.toLowerCase(),
      };
    })
    .filter((c) => !typed || c.searchable.includes(typed))
    .slice(0, 25)
    .map(({ name, value }) => ({ name: name.slice(0, 100), value }));

  return interaction.respond(choices);
}

async function handleDm(interaction, db, cfg) {
  // Gated to the campaign's manager, and the campaign resolved, before this
  // runs — see MANAGER_ONLY and the dispatcher.
  const sub = interaction.options.getSubcommand();
  const target = campaign(interaction);
  const roster = db.listRoster(target.id);
  const label = campaignLabel(target);

  if (sub === 'roster') {
    if (roster.length === 0) {
      return interaction.reply({
        content:
          `**${label}** has nobody at the table yet. Add your players with \`/dm add\` — ` +
          'they need to be on the roster before they can start a recording.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const lines = roster.map((r) => {
      const who = r.displayName ? `**${r.displayName}**` : `<@${r.userId}>`;
      const plays = r.characterName ? `plays **${r.characterName}**` : '_no character set_';
      const heard = r.lines ? `${r.lines} line${r.lines === 1 ? '' : 's'}` : '_not recorded yet_';
      return `• ${who} — ${plays}  ·  ${heard}${r.enrolled ? '' : '  ·  ⚠️ not on the roster'}`;
    });
    const unset = roster.filter((r) => !r.characterName).length;
    const strays = roster.filter((r) => !r.enrolled).length;
    return interaction.reply({
      content:
        `**Who's at the table — ${label}**\n${lines.join('\n')}` +
        (unset
          ? `\n\n_${unset} player${unset === 1 ? '' : 's'} with no character set — they'll appear under their Discord name, and a character called anything else risks being written up as an NPC. Set one with \`/dm character\`._`
          : '') +
        (strays
          ? `\n_${strays} recorded speaker${strays === 1 ? '' : 's'} not on the roster — add them with \`/dm add\` if they should be able to start a session._`
          : ''),
      flags: MessageFlags.Ephemeral,
    });
  }

  // `player` is a user id, from the autocomplete. Someone who typed a raw
  // string instead gets matched against the display names rather than a
  // confusing "not found".
  const chosen = interaction.options.getString('player');
  const entry =
    roster.find((r) => r.userId === chosen) ||
    roster.find((r) => r.displayName?.toLowerCase() === String(chosen).toLowerCase());

  if (!entry) {
    return interaction.reply({
      content:
        `I have nobody matching \`${chosen}\` at the table for **${label}**. ` +
        'Pick one from the autocomplete, or use `/dm add` if they have never been recorded.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const who = entry.displayName || `<@${entry.userId}>`;

  if (sub === 'forget') {
    const removed = db.forgetCharacterName(target.id, entry.userId);
    return interaction.reply({
      content: removed
        ? `🧹 Cleared — **${who}** will appear under their Discord name again. They're still on the roster.`
        : `**${who}** had no character name set.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = interaction.options.getString('name').trim();
  const previous = entry.characterName;
  db.setCharacterName(target.id, entry.userId, name);

  // Said plainly rather than in flavour text: this is the one command whose
  // effect is easy to misread as retroactive.
  return interaction.reply({
    content:
      `🎭 **${who}** now plays **${name}** in **${label}**.` +
      (previous && previous !== name ? `\n_Previously **${previous}**._` : '') +
      `\n\nFrom the next recording, they'll be labelled **${name}** in transcripts. ` +
      'Sessions already recorded keep the labels they were captured with — but the summariser is told both names either way, ' +
      'so neither will be mistaken for an NPC.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCampaign(interaction, db, cfg) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') return handleCampaignCreate(interaction, db, cfg);
  if (sub === 'list') return handleCampaignList(interaction, db, cfg);

  // rename and output both act on a campaign you run. The dispatcher does not
  // gate /campaign — creating one has to work for someone who runs none — so
  // these resolve and refuse for themselves.
  const resolved = resolveManagedCampaign(interaction, db, cfg);
  if (resolved.error) return interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });

  if (sub === 'invite') return handleCampaignInvite(interaction, db, cfg, resolved.campaign);
  if (sub === 'remove') return handleCampaignRemove(interaction, db, resolved.campaign);
  return sub === 'rename'
    ? handleCampaignRename(interaction, db, cfg, resolved.campaign)
    : handleCampaignOutput(interaction, db, resolved.campaign);
}

// Asking someone to join, which is also asking whether they may be recorded.
//
// The invitation is a DM rather than a channel message on purpose: the answer
// is theirs, and a public "will you consent?" with the table watching is a
// worse question than a private one.
async function handleCampaignInvite(interaction, db, cfg, target) {
  const user = interaction.options.getUser('player');
  const name = interaction.options.getString('name')?.trim();
  const label = campaignLabel(target);

  if (user.bot) {
    return interaction.reply({ content: "Bots don't play D&D, and can't consent to anything.", flags: MessageFlags.Ephemeral });
  }

  const existing = db.getConsent(target.id, user.id);
  if (existing?.state === 'granted') {
    return interaction.reply({
      content: `**${user.username}** is already at the table for **${label}** and has agreed to be recorded.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const expiresAt = inviteExpiry();
  const dm = buildInviteDm({
    campaignId: target.id,
    campaignName: label,
    inviterName: interaction.user.username,
    retentionDays: cfg.audioRetentionDays,
    expiresAt,
  });

  // Sent BEFORE the invite is recorded. A DM can be refused outright by the
  // recipient's privacy settings, and a pending invite nobody can see is worse
  // than none — it would sit there looking like the question had been asked.
  const channel = await user.createDM().catch(() => null);
  const sent = channel ? await channel.send(dm).catch(() => null) : null;

  if (!sent) {
    return interaction.reply({
      content:
        `📪 I couldn't DM **${user.username}** — their privacy settings block messages from this server, so I can't ask them.\n` +
        'They can change that in Privacy Settings, or turn DMs on for this server, and then you can invite them again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  db.inviteToCampaign(target.id, user.id, interaction.user.id, expiresAt.toISOString());
  // A character name given now is held until they accept — naming someone
  // does not put them at the table any more, answering does.
  if (name) db.setCharacterName(target.id, user.id, name);

  return interaction.reply({
    content:
      `📨 Invited **${user.username}** to **${label}**${name ? `, as **${name}**` : ''}.\n` +
      `They've been asked whether Quill may record them, and it won't until they say yes. ` +
      `The invite expires ${discordTime(expiresAt)}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCampaignRemove(interaction, db, target) {
  const user = interaction.options.getUser('player');
  const label = campaignLabel(target);

  if (user.id === target.manager_user_id) {
    return interaction.reply({
      content: "You run this campaign, so you can't take yourself off it.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const removed = db.removeFromCampaign(target.id, user.id);
  return interaction.reply({
    content: removed
      ? `🚪 **${user.username}** is off **${label}** — they can't start a session for it and won't be recorded in it.\n` +
        '_Anything they already said stays in the transcripts; this is about what happens from now on._'
      : `**${user.username}** wasn't on **${label}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCampaignCreate(interaction, db, cfg) {
  if (!interaction.guildId) {
    return interaction.reply({
      content: 'Run this in the server the game is played in — a campaign belongs to a Discord, and a DM has none.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const name = interaction.options.getString('name').trim();
  if (!name) {
    return interaction.reply({ content: '⚠️ Give the campaign a name.', flags: MessageFlags.Ephemeral });
  }

  if (!nameIsUsable(name)) {
    return interaction.reply({
      content:
        `⚠️ I can't file anything under \`${name}\`. A campaign's name becomes the folder its notes live in ` +
        'and the start of every session reference (`Cipher_02`), and that one leaves nothing behind once emoji ' +
        'and path characters are stripped. Give it at least one letter or number.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const clash = campaignNameClash(db, name);
  if (clash) {
    return interaction.reply({
      content:
        `⚠️ There's already a campaign called **${campaignLabel(clash)}**${clash.guild_id === interaction.guildId ? ' in this server' : ' on this bot'}, ` +
        `and its notes are filed in \`${campaignFolder({ channel_name: clash.name }, clash.name)}/\`. ` +
        'Two campaigns sharing a folder would interleave their session notes, so pick a different name.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isOwner(interaction.user.id, cfg)) {
    if (db.countCampaignsInGuild(interaction.guildId) >= MAX_CAMPAIGNS_PER_GUILD) {
      return interaction.reply({
        content: `⚠️ This server already has ${MAX_CAMPAIGNS_PER_GUILD} campaigns, which is as many as I'll track for one Discord.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (db.countCampaignsManagedBy(interaction.user.id) >= MAX_CAMPAIGNS_PER_MANAGER) {
      return interaction.reply({
        content: `⚠️ You already run ${MAX_CAMPAIGNS_PER_MANAGER} campaigns, which is as many as I'll let one person hold.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const id = db.createCampaign(interaction.guildId, name, interaction.user.id);
  const folder = campaignFolder({ channel_name: name }, name);

  return interaction.reply({
    content:
      `📖 **${name}** exists. You run it.\n` +
      `Session notes are filed in \`${folder}/\` as \`Session 01.md\`, \`Session 02.md\`, and referred to as \`${sessionRef(name, 1)}\`.\n\n` +
      '**Next:** add your players with `/dm add player:@them name:<their character>` — they need to be on the roster ' +
      "before they can `/join`, and a character name keeps them from being written up as an NPC. " +
      'Then `/campaign output` if you want the recaps somewhere other than the channel you record in.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCampaignList(interaction, db, cfg) {
  const campaigns = interaction.guildId
    ? db.listCampaignsInGuild(interaction.guildId)
    : campaignsToOffer(interaction, db, cfg);

  if (campaigns.length === 0) {
    return interaction.reply({
      content: interaction.guildId
        ? "No campaigns here yet. `/campaign create name:...` starts one and makes you its DM."
        : "You don't run or play in any campaigns yet.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = campaigns.map((c) => {
    const folder = campaignFolderFor(c);
    const who = c.manager_user_id ? `<@${c.manager_user_id}>` : '_unclaimed_';
    const where =
      c.output_mode === 'dm'
        ? "DM'd to the DM"
        : c.output_mode === 'channel' && c.output_channel_id
          ? `<#${c.output_channel_id}>`
          : 'the default';
    return (
      `• **${campaignLabel(c)}** — run by ${who}\n` +
      `  ${c.sessions} session${c.sessions === 1 ? '' : 's'} · notes in \`${folder}/\` → ${where}` +
      (c.name ? ` · sessions read \`${refSlug(c.name)}_01\`` : '')
    );
  });

  return interaction.reply({
    content: `📚 **Campaigns${interaction.guildId ? ' here' : ''}**\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCampaignRename(interaction, db, cfg, target) {
  const trimmed = interaction.options.getString('name').trim();
  if (!trimmed) {
    return interaction.reply({ content: '⚠️ Give the campaign a name.', flags: MessageFlags.Ephemeral });
  }

  if (!nameIsUsable(trimmed)) {
    return interaction.reply({
      content:
        `⚠️ I can't file anything under \`${trimmed}\`. A campaign's name becomes the folder its notes live in ` +
        'and the start of every session reference (`Cipher_02`), and that one leaves nothing behind once emoji ' +
        'and path characters are stripped. Give it at least one letter or number.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const clash = campaignNameClash(db, trimmed, target.id);
  if (clash) {
    return interaction.reply({
      content: `⚠️ **${campaignLabel(clash)}** already files its notes there. Pick a different name.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = target.name;
  const previousFolder = campaignFolderFor(target);
  const folder = campaignFolderFor({ ...target, name: trimmed });
  db.setCampaignName(target.id, trimmed);

  // Take the existing notes with us. Leaving them behind doesn't just look
  // untidy — the ledger is what tells the next session which NPCs the
  // campaign already knows, so an orphaned folder means every NPC met so far
  // gets re-introduced in the next recap as though they were new.
  let carried = '';
  if (previousFolder !== folder) {
    try {
      const result = await moveCampaignFolder({ cfg, from: previousFolder, to: folder });
      if (result.moved) {
        carried = `\n\n_Moved the existing \`${previousFolder}/\` folder across, notes and ledger included._`;
      }
      if (result.skipped?.length) {
        carried += `\n⚠️ Left behind in \`${previousFolder}/\` (something with the same name was already in \`${folder}/\`): ${result.skipped.join(', ')}`;
      }
    } catch (err) {
      console.error('[campaign] folder move failed:', err);
      carried = `\n\n⚠️ Couldn't move \`${previousFolder}/\` — the old notes are still there, new ones will go to \`${folder}/\`.`;
    }
  }

  return interaction.reply({
    content:
      `📖 Campaign renamed to **${trimmed}**.\n` +
      `Session notes are filed in \`${folder}/\`, and sessions now read \`${refSlug(trimmed)}_01\`.` +
      (current && current !== trimmed ? `\n\n_Previously **${current}**._` : '') +
      carried,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCampaignOutput(interaction, db, target) {
  const mode = interaction.options.getString('mode');
  const chosenChannel = interaction.options.getChannel('channel');

  if (mode === 'channel' && !chosenChannel && !interaction.channelId) {
    return interaction.reply({
      content: 'Tell me which channel with the `channel` option.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Defaulting to the channel the command was run in is the common case —
  // you are usually standing in the one you mean.
  const channelId = mode === 'channel' ? (chosenChannel?.id ?? interaction.channelId) : null;
  db.setCampaignOutput(target.id, mode === 'default' ? null : mode, channelId);

  const where =
    mode === 'dm'
      ? `📬 **${campaignLabel(target)}**'s session notes will be sent to <@${interaction.user.id}> directly.`
      : mode === 'channel'
        ? `📬 **${campaignLabel(target)}**'s session notes will be posted in <#${channelId}>.`
        : `📬 **${campaignLabel(target)}**'s session notes go wherever the bot is configured to send them by default (the session’s own channel unless set otherwise).`;
  return interaction.reply({ content: where, flags: MessageFlags.Ephemeral });
}

export function registerCommandHandlers(client, db, cfg) {
  client.on('interactionCreate', async (interaction) => {
    // Approval buttons arrive as component interactions, not commands.
    if (interaction.isButton()) {
      try {
        return await handleApprovalButton(interaction, db, cfg);
      } catch (err) {
        console.error('[button] error:', err);
        return;
      }
    }

    // Every campaign option, everywhere, is filled from here.
    if (interaction.isAutocomplete()) {
      try {
        return await handleCampaignAutocomplete(interaction, db, cfg);
      } catch (err) {
        console.error('[autocomplete] error:', err.message);
        return;
      }
    }

    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;

    // One gate for the whole command surface, so who-can-run-what is readable
    // in one place rather than scattered through the handlers.
    if (OWNER_ONLY.has(name)) {
      const refusal = refuseUnlessOwner(interaction.user.id, cfg);
      if (refusal) return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    // Resolve which campaign the command is about BEFORE the handler runs, so
    // every handler reads one value regardless of where it was invoked from.
    //
    // The tier decides the candidate list, and for MANAGER and MEMBER commands
    // that resolution IS the permission check: a command that resolves to a
    // campaign you run is a command you may run. There is no separate gate to
    // fall out of step with — see campaign/resolve.js.
    //
    // /campaign is exempt because `create` has to work for someone who runs
    // nothing yet; its subcommands resolve for themselves. The owner-tier
    // commands are exempt because they take an explicit session reference
    // instead, which carries its own campaign.
    const resolver = MANAGER_ONLY.has(name)
      ? resolveManagedCampaign
      : MEMBER_COMMANDS.has(name)
        ? resolveMemberCampaign
        : PLAYER_COMMANDS.has(name)
          ? resolveReadableCampaign
          : null;

    if (resolver) {
      const resolved = resolver(interaction, db, cfg);
      if (resolved.error) {
        return interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      interaction.quillCampaign = resolved.campaign;
    }

    try {
      // Each handler must be awaited here, not just returned — "return
      // handleX(...)" hands back the promise without keeping this try block
      // on the stack, so a rejection later on (e.g. the voice connection
      // timing out well after the initial reply) would silently become an
      // unhandled rejection instead of being caught below.
      if (interaction.commandName === 'join') return await handleJoin(interaction, db, cfg);
      if (interaction.commandName === 'leave') return await handleLeave(interaction, db, cfg);
      if (interaction.commandName === 'history') return await handleHistory(interaction, db);
      if (interaction.commandName === 'summarise') return await handleSummarizeNow(interaction, db, cfg);
      if (interaction.commandName === 'export') return await handleExport(interaction, db, cfg);
      if (interaction.commandName === 'setcharacter') return await handleSetCharacter(interaction, db);
      if (interaction.commandName === 'status') return await handleStatus(interaction, db, cfg);
      if (interaction.commandName === 'transcribe') return await handleTranscribe(interaction, db, cfg);
      if (interaction.commandName === 'recap') return await handleRecap(interaction, db);
      if (interaction.commandName === 'funny') return await handleFunny(interaction, db);
      if (interaction.commandName === 'search') return await handleSearch(interaction, db);
      if (interaction.commandName === 'pending') return await handlePending(interaction, db, cfg);
      if (interaction.commandName === 'pause') return await handlePause(interaction, db);
      if (interaction.commandName === 'resume') return await handleResume(interaction, db);
      if (interaction.commandName === 'approve') return await handleApprove(interaction, db, cfg);
      if (interaction.commandName === 'ask') return await handleAsk(interaction, db, cfg);
      if (interaction.commandName === 'import') return await handleImport(interaction, db, cfg);
      if (interaction.commandName === 'correct') return await handleCorrect(interaction, db);
      if (interaction.commandName === 'corrections') return await handleCorrections(interaction, db);
      if (interaction.commandName === 'uncorrect') return await handleUncorrect(interaction, db);
      if (interaction.commandName === 'campaign') return await handleCampaign(interaction, db, cfg);
      if (interaction.commandName === 'dm') return await handleDm(interaction, db, cfg);
      if (interaction.commandName === 'whoami') return await handleWhoAmI(interaction, db);
      if (interaction.commandName === 'stats') return await handleStats(interaction, db);
      if (interaction.commandName === 'npcs') return await handleNpcs(interaction, db, cfg);
      if (interaction.commandName === 'locations') return await handleLocations(interaction, db, cfg);
      if (interaction.commandName === 'archive') return await handleArchive(interaction, db, cfg);
    } catch (err) {
      console.error(`[command:${interaction.commandName}] error:`, err);
      const reply = { content: pick(GENERIC_ERROR, { message: err.message }), flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  });
}

async function handleJoin(interaction, db, cfg) {
  // The campaign is resolved and the roster checked by the dispatcher — see
  // MEMBER_COMMANDS. That check is the point: /join starts recording people's
  // voices, and in a server the bot was merely invited to, being able to see a
  // voice channel is not permission to record the game happening in it.
  const target = campaign(interaction);
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: pick(JOIN_NO_CHANNEL), flags: MessageFlags.Ephemeral });
  }

  // Keyed by guild rather than campaign, and correctly so: a bot can only hold
  // one voice connection per server, so two tables in one Discord genuinely
  // cannot record at the same time however the bookkeeping is arranged.
  if (activeSessions.has(interaction.guildId) || startingGuilds.has(interaction.guildId)) {
    return interaction.reply({ content: pick(JOIN_ALREADY_RECORDING), flags: MessageFlags.Ephemeral });
  }

  // Claim the guild before the first await. Everything below is async — the
  // defer, then up to ~20s waiting on the voice connection — and the session
  // isn't registered in activeSessions until the very end, so two /join
  // commands issued close together would both clear the check above and both
  // start capturing, into two different directories.
  startingGuilds.add(interaction.guildId);
  try {
    // Defer instead of replying immediately — we don't actually know the join
    // succeeded until the voice connection reaches Ready (which can take up to
    // ~20s), and claiming "recording started" before that was confirmed is
    // exactly what caused a silent failure to look like a successful /join.
    await interaction.deferReply();

    const audioDir = join(cfg.dataDir, 'audio', `${interaction.guildId}-${Date.now()}`);
    await mkdir(audioDir, { recursive: true });

    const capturedUtterances = [];

    const handle = startCapture({
      channel: voiceChannel,
      guildId: interaction.guildId,
      audioDir,
      getDisplayName: async (userId) => {
        const m = await interaction.guild.members.fetch(userId).catch(() => null);
        const discordName = m?.displayName || userId;
        // Prefer the player's set D&D character name over their Discord name,
        // so transcripts/notes read like a session recap, not a Discord log.
        // Per campaign: the same person can play in two games in one server
        // under two different names.
        return resolveSpeakerName(db, target.id, userId, discordName);
      },
      // Checked before the audio stream is opened, not after — see
      // voice/capture.js. Silence is not agreement, so anyone who has not
      // answered is skipped exactly as if they had declined.
      mayRecord: (userId) => db.mayRecord(target.id, userId),
      onUtterance: (userId, displayName, wavPath, startMs, endMs) => {
        capturedUtterances.push({ userId, displayName, wavPath, startMs, endMs });
      },
    });

    try {
      await handle.waitUntilReady();
    } catch (err) {
      handle.disconnect();
      console.error('[join] voice connection failed:', err.message);
      return interaction.editReply(pick(JOIN_FAILED, { error: err.message }));
    }

    // Only now — once the connection is actually confirmed — do we create the
    // meeting row and register the session, so a failed /join never leaves a
    // dangling "recording" meeting behind for crash-recovery to trip over.
    const meetingId = db.createMeeting({
      guildId: interaction.guildId,
      campaignId: target.id,
      channelId: interaction.channelId,
      channelName: voiceChannel.name,
      startedAt: new Date().toISOString(),
      audioDir,
    });

    // channelName/startedAtMs are carried for the status dashboard — it has
    // no other way to say WHERE the bot is sitting or for how long, and
    // re-deriving either from Discord on every poll would be wasteful.
    activeSessions.set(interaction.guildId, {
      meetingId,
      handle,
      capturedUtterances,
      audioDir,
      channelName: voiceChannel.name,
      startedAtMs: Date.now(),
    });
    // Name the campaign when the server holds more than one — otherwise the
    // table has no way to tell which game this session is being filed under,
    // and finding out a month later is finding out too late.
    const several = db.countCampaignsInGuild(interaction.guildId) > 1;
    const ref = sessionRef(campaignLabel(target), db.getMeeting(meetingId)?.session_number);

    // Who in the channel is about to be skipped. Said now, publicly, for two
    // reasons: the DM finds out before the session rather than when the
    // transcript comes back short, and the people being skipped can see that
    // they are — which is the honest half of having asked them at all.
    const unrecorded = voiceChannel.members
      .filter((m) => !m.user.bot && !db.mayRecord(target.id, m.id))
      .map((m) => m.displayName);

    await interaction.editReply(
      pick(JOIN_STARTED, { channel: voiceChannel.name }) +
        (several ? `\n_Recording **${campaignLabel(target)}**${ref ? ` — \`${ref}\`` : ''}._` : '') +
        describeUnrecorded([...unrecorded])
    );
  } finally {
    // Must run even if startCapture/createMeeting throws, or the guild would
    // be permanently unable to start a new recording.
    startingGuilds.delete(interaction.guildId);
  }
}

async function handleLeave(interaction, db, cfg) {
  const session = activeSessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: pick(LEAVE_NOT_RECORDING), flags: MessageFlags.Ephemeral });
  }

  // Stopping a recording belongs to the table being recorded.
  //
  // /leave has always been open to anyone in the server, which was near enough
  // while a server meant a campaign. With two tables it is not: the other
  // group's DM could end this one's session mid-scene, and the recording
  // cannot be resumed — /join starts a new one with a new session number.
  //
  // Membership, not management, so any player can stop it; the owner too,
  // since somebody has to be able to end a session whose table has all left.
  const recording = db.getMeeting(session.meetingId);
  const mayStop =
    !recording?.campaign_id ||
    isOwner(interaction.user.id, cfg) ||
    db.isCampaignMember(recording.campaign_id, interaction.user.id);

  if (!mayStop) {
    const theirs = db.getCampaign(recording.campaign_id);
    return interaction.reply({
      content: `🎲 I'm recording **${campaignLabel(theirs)}** right now, and you're not at that table — someone who is can stop it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // And you have to say which table you are ending.
  //
  // Unlike every other campaign option, this one does not RESOLVE anything —
  // there is only ever one session to stop, so the name is a confirmation
  // rather than a lookup. It earns its place because stopping cannot be taken
  // back: /join afterwards opens a NEW session with a new number, so a /leave
  // fired at the wrong table splits that game's evening in two and there is no
  // command that puts it back together.
  //
  // Demanded on exactly the condition /join announces the campaign on: if
  // /join told you which game it was recording, /leave asks you to say it
  // back. One table in the server and there is nothing to get wrong, so it
  // stays out of the way.
  const which = recording?.campaign_id ? db.getCampaign(recording.campaign_id) : null;
  const asked = interaction.options.getString('campaign');

  if (which) {
    // The picker sends the id, so echoing what they asked for verbatim would
    // answer a name with a number. Resolve it back to a name when we can.
    const named = asked ? findCampaign(db.listCampaignsInGuild(interaction.guildId), asked) : null;
    const wanted = named ? campaignLabel(named) : asked;

    if (asked && !findCampaign([which], asked)) {
      return interaction.reply({
        content:
          `🎲 I'm not recording **${wanted}** — this session belongs to **${campaignLabel(which)}**.\n` +
          `\`/leave campaign:${campaignLabel(which)}\` ends it. Nothing has been stopped.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!asked && db.countCampaignsInGuild(interaction.guildId) > 1) {
      return interaction.reply({
        content:
          `🎲 There's more than one table in this server, so tell me which one you're ending — I'm recording ` +
          `**${campaignLabel(which)}** right now.\n` +
          `Re-run as \`/leave campaign:${campaignLabel(which)}\`. This can't be undone: \`/join\` afterwards starts ` +
          'a new session rather than resuming this one.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  activeSessions.delete(interaction.guildId);

  await interaction.reply(pick(LEAVE_START));
  session.handle.disconnect();
  db.endMeeting(session.meetingId, new Date().toISOString());

  // Transcription is NOT started here any more. It needs the PC's GPU, and a
  // session usually ends in the evening — precisely when someone is most
  // likely to be using that PC. So the recording is queued, the owner is
  // asked, and transcribe-worker.js runs it when approved or inside the
  // automatic window. See pipeline/transcribe-schedule.js.
  db.setMeetingStatus(session.meetingId, 'awaiting_transcription');
  const job = db.enqueueTranscribeJob(session.meetingId, {
    requireApproval: cfg.transcribeRequireApproval,
  });

  const clipCount = session.capturedUtterances.length;
  const serverReachable = await isWhisperServerReachable(cfg);
  const meeting = db.getMeeting(session.meetingId);

  // Ephemeral on purpose. Clip counts, queue state and GPU scheduling are
  // operational detail for whoever runs the bot — the table just played a
  // session and does not need the plumbing narrated at them in their own
  // channel. The owner gets all of this, with buttons, in the DM below.
  // Only the thematic /join and /leave lines are public.
  await interaction.followUp({
    content:
      `📼 Recorded **${clipCount}** clips for session #${session.meetingId}.\n` +
      (cfg.transcribeRequireApproval
        ? `Transcription is queued — I've DMed you to ask when it can use the PC. Nothing touches the GPU until then.`
        : `Transcription is queued and will start when the PC is available.`),
    flags: MessageFlags.Ephemeral,
  });

  if (cfg.transcribeRequireApproval) {
    await notifyTranscribeReady({
      discordClient: interaction.client,
      cfg,
      meeting,
      jobId: job.id,
      utteranceCount: clipCount,
      serverReachable,
    });
  }
}

// applyTranscribeAction used to live here, shared by the DM buttons and
// /transcribe. It now lives in pipeline/job-actions.js, shared by those two
// AND the dashboard — see the note there about why neither surface may own
// the behaviour.
const applyTranscribeAction = (db, cfg, jobId, action) => transcribeAction(db, cfg, { jobId, action });

// A typed reference ("Cipher_02") resolved against the campaigns this caller
// may look at. The membership filter is the point: a bare meeting id named no
// campaign, so there was nothing to check and /export 16 returned whatever
// session 16 happened to be, on anyone's server.
//
// The owner reaches every campaign, since these are all owner-tier commands
// and unsticking someone else's stuck session is the job.
function resolveSession(interaction, db, cfg) {
  const reachable = isOwner(interaction.user.id, cfg)
    ? db.listCampaigns()
    : db.listCampaignsForUser(interaction.user.id);
  return resolveSessionRef(interaction.options.getString('session'), reachable, db);
}

async function handleTranscribe(interaction, db, cfg) {
  const { meeting, error } = resolveSession(interaction, db, cfg);
  if (error) return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
  const meetingId = meeting.id;
  const when = interaction.options.getString('when') || 'now';

  const job = db.getTranscribeJobForMeeting(meetingId);
  if (!job) {
    return interaction.reply({
      content: `⚠️ No transcription job for meeting #${meetingId}. It may already be transcribed — check \`/status\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const { message } = await applyTranscribeAction(db, cfg, job.id, when);
  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleHistory(interaction, db) {
  const target = campaign(interaction);
  const count = interaction.options.getInteger('count') || 10;
  const meetings = db.listRecentMeetings(target.id, count);
  if (meetings.length === 0) {
    return interaction.reply({ content: pick(HISTORY_EMPTY), flags: MessageFlags.Ephemeral });
  }
  // The session reference, not the meeting id: the reference is what the vault
  // calls the file and what every other command takes.
  const lines = meetings.map((m) => {
    const ref = sessionRef(campaignLabel(target), m.session_number);
    return `**${ref ?? `#${m.id}`}** — ${m.channel_name} — ${(m.started_at || '').slice(0, 10)} — _${m.status}_`;
  });
  await interaction.reply({
    content: `**${campaignLabel(target)}**\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSummarizeNow(interaction, db, cfg) {
  const { meeting, error } = resolveSession(interaction, db, cfg);
  if (error) return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
  const meetingId = meeting.id;
  const provider = interaction.options.getString('provider');

  // Check the provider actually being used, not the configured default, so
  // asking for one that is set up isn't refused because the other isn't.
  const effectiveCfg = withProvider(cfg, provider);
  const unusable = providerUnusableReason(effectiveCfg, provider);
  if (unusable) return interaction.reply({ content: unusable, flags: MessageFlags.Ephemeral });

  if (!(await isSummariserReachable(effectiveCfg))) {
    return interaction.reply({
      content: pick(SUMMARIZE_UNREACHABLE, { label: summariserLabel(effectiveCfg) }),
      flags: MessageFlags.Ephemeral,
    });
  }

  db.requeueSummarizeNow(meetingId, provider);
  const note = provider ? `\n_Summarising with ${summariserLabel(effectiveCfg)}._` : '';
  await interaction.reply(pick(SUMMARIZE_QUEUED, { meetingId }) + note);
}

async function handleExport(interaction, db, cfg) {
  const { meeting, error } = resolveSession(interaction, db, cfg);
  if (error) return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
  const meetingId = meeting.id;

  const utterances = db.listUtterances(meetingId);
  const transcriptText = buildTranscriptText(utterances);
  const buf = Buffer.from(transcriptText, 'utf8');
  const attachment = new AttachmentBuilder(buf, { name: `meeting-${meetingId}-transcript.txt` });

  const intro = pick(EXPORT_INTRO, {
    meetingId,
    channel: meeting.channel_name,
    date: (meeting.started_at || '').slice(0, 10),
  });
  await interaction.reply({
    content: `${intro} Raw audio lives on the Pi at \`${meeting.audio_dir}\` if you need the source files (or \`null\` if it's already been cleaned up by the retention policy).`,
    files: [attachment],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetCharacter(interaction, db) {
  const target = campaign(interaction);
  const name = interaction.options.getString('name').trim();
  db.setCharacterName(target.id, interaction.user.id, name);
  await interaction.reply({
    content:
      pick(SETCHARACTER_CONFIRM, { name }) +
      (db.countCampaignsInGuild(interaction.guildId) > 1 ? `\n_In **${campaignLabel(target)}**._` : ''),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction, db, cfg) {
  const target = campaign(interaction);

  // A manager sees THEIR campaign's queue; the owner, who is responsible for
  // the machine, sees everything. Before campaigns had ids this was the same
  // list either way — with two tables it stops being, and a manager has no
  // business reading the other game's session ids and error text.
  const owner = isOwner(interaction.user.id, cfg);
  const mine = (meetingId) => owner || db.getMeeting(meetingId)?.campaign_id === target.id;

  const jobs = db.listPendingJobs().filter((j) => mine(j.meeting_id));
  const reachable = await isSummariserReachable(cfg);
  const reachableText = reachable ? '✅ reachable' : '❌ not reachable';
  const label = summariserLabel(cfg);

  // Transcription runs before a summarise job exists, so a session being
  // ground through on the Pi shows up here and nowhere else — this is the
  // one that can legitimately take hours and prompt "is it stuck?".
  const now = Date.now();
  const transcribing = listTranscriptions()
    .filter((entry) => mine(entry.meetingId))
    .map((entry) => `- Meeting #${entry.meetingId}: ${describeTranscription(entry, now)}`);

  if (jobs.length === 0 && transcribing.length === 0) {
    return interaction.reply({
      content: pick(STATUS_IDLE, { reachable: reachableText, label }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = jobs.map((j) => {
    const age = Math.round((now - new Date(j.created_at).getTime()) / 60000);
    // For a job that failed and is backing off, when it next tries is more
    // useful than how long it has already been waiting.
    const dueMs = j.next_attempt_at ? new Date(j.next_attempt_at).getTime() - now : null;
    const retry =
      j.status === 'pending' && dueMs !== null && Number.isFinite(dueMs) && dueMs > 0
        ? `, retry in ~${formatDuration(dueMs)}`
        : '';
    return `- Meeting #${j.meeting_id}: ${j.status}, ${j.attempts} attempt(s), waiting ~${age}m${retry}${j.last_error ? ` (last error: ${j.last_error.slice(0, 100)})` : ''}`;
  });

  const sections = [pick(STATUS_QUEUED_HEADER, { reachable: reachableText, label })];
  if (!owner) sections.push(`_For **${campaignLabel(target)}**._`);
  if (transcribing.length > 0) sections.push(transcribing.join('\n'));
  if (lines.length > 0) sections.push(lines.join('\n'));

  await interaction.reply({ content: sections.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handleRecap(interaction, db) {
  const meeting = db.getLastCompletedMeeting(campaignId(interaction));
  if (!meeting) {
    return interaction.reply({ content: pick(RECAP_NONE), flags: MessageFlags.Ephemeral });
  }
  const notes = JSON.parse(meeting.summary_json || '{}');
  const date = (meeting.started_at || '').slice(0, 10);
  const header = pick(RECAP_HEADER, { channel: meeting.channel_name, date });
  await interaction.reply(`${header}\n\n${notes.tldr || '_no recap available_'}`);
}

async function handleImport(interaction, db, cfg) {
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');
  const speakerLabel = (interaction.options.getString('speaker') || 'Table').trim() || 'Table';

  const source = attachment?.url || url;
  if (!source) {
    return interaction.reply({
      content: '⚠️ Attach a `file:` or give a `url:` — one of the two is needed.',
      flags: MessageFlags.Ephemeral,
    });
  }
  // An import creates a session, so it has to say which campaign's records it
  // is joining. The owner reaches every campaign here, but "every campaign" is
  // not an answer — filing an in-person game under the wrong table is exactly
  // the mistake that is invisible until the notes are wrong.
  const resolved = resolveManagedCampaign(interaction, db, cfg);
  if (resolved.error) return interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });

  if (activeSessions.has(interaction.guildId)) {
    return interaction.reply({
      content: "⚠️ I'm recording right now — `/leave` first, then import.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Transcribing an hours-long recording on a Pi takes far longer than
  // Discord's 15-minute interaction window, so acknowledge, then report back
  // by editing the original reply as each phase completes.
  await interaction.deferReply();
  await interaction.editReply('📥 Downloading the recording…');

  const stages = {
    downloading: '📥 Downloading the recording…',
    converting: '🎛️ Converting the audio…',
    transcribing: `🎧 Transcribing with whisper — this takes a while for a long recording. I'll post the result here when it's done.`,
  };

  try {
    const result = await importAudio({
      db,
      cfg,
      guildId: resolved.campaign.guild_id,
      campaignId: resolved.campaign.id,
      channelId: interaction.channelId,
      channelName: interaction.channel?.name || 'imported',
      url: source,
      filename: attachment?.name,
      speakerLabel,
      onProgress: (stage) => {
        if (stages[stage]) interaction.editReply(stages[stage]).catch(() => {});
      },
    });

    const parked = result.job?.status === 'awaiting_approval';
    const note = parked
      ? `Parked awaiting your approval — \`/approve meeting_id:${result.meetingId}\`.`
      : 'Summarising now.';

    await interaction.editReply(
      `✅ Imported as session #${result.meetingId} — ${result.utteranceCount} lines transcribed. ${note}\n` +
        `_Every line is attributed to **${speakerLabel}**: a single recording has no per-speaker channels, so I can't tell voices apart the way I can in a voice call._`
    );

    if (parked) {
      await notifyApprovalNeeded({
        discordClient: interaction.client,
        cfg,
        meeting: db.getMeeting(result.meetingId),
        jobId: result.job.id,
        utteranceCount: result.utteranceCount,
      });
    }
  } catch (err) {
    console.error('[import] failed:', err);
    await interaction.editReply(`❌ Import failed: ${err.message}`);
  }
}

async function handleCorrect(interaction, db) {
  const wrong = interaction.options.getString('wrong').trim();
  const right = interaction.options.getString('right').trim();

  if (!wrong || !right) {
    return interaction.reply({ content: '⚠️ Both values are required.', flags: MessageFlags.Ephemeral });
  }
  if (wrong.toLowerCase() === right.toLowerCase()) {
    return interaction.reply({
      content: '⚠️ Those are the same thing — nothing to correct.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Save first so it applies to every future session, then replay it over
  // everything already transcribed. Scoped to THIS campaign — a correction is
  // a fact about one game's invented names, and rewriting another table's
  // transcripts with it would be silent corruption.
  const target = campaignId(interaction);
  db.addCorrection(target, wrong, right);
  const changed = db.rewriteUtterances(target, (text) =>
    applyCorrections(text, [{ wrong_text: wrong, correct_text: right }])
  );

  const note =
    changed > 0
      ? '\n\n_Existing summaries were generated before this fix — run `/summarise meeting_id:<id>` on a session to regenerate one with the corrected name._'
      : '';

  await interaction.reply({
    content: pick(CORRECT_APPLIED, { wrong, right, count: changed }) + note,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCorrections(interaction, db) {
  const rows = db.listCorrections(campaignId(interaction));
  if (rows.length === 0) {
    return interaction.reply({
      content: '📭 No corrections saved yet. Use `/correct` when whisper mangles a name.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const lines = rows.map((r) => `- "${r.wrong_text}" → **${r.correct_text}**`);
  await interaction.reply({
    content: `✏️ **Saved corrections** (applied automatically to every new transcript):\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleUncorrect(interaction, db) {
  const wrong = interaction.options.getString('wrong').trim();
  const removed = db.removeCorrection(campaignId(interaction), wrong);
  if (removed === 0) {
    return interaction.reply({
      content: `⚠️ No saved correction for "${wrong}" — check \`/corrections\` for the exact text.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.reply({ content: pick(UNCORRECT_APPLIED, { wrong }), flags: MessageFlags.Ephemeral });
}

async function handleWhoAmI(interaction, db) {
  const characterName = db.getCharacterName(campaignId(interaction), interaction.user.id);
  const content = characterName
    ? pick(WHOAMI_SET, { name: characterName })
    : pick(WHOAMI_UNSET, { discordName: interaction.member?.displayName || interaction.user.username });
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleStats(interaction, db) {
  const target = campaign(interaction);
  const stats = db.campaignStats(target.id);
  if (stats.totalSessions === 0) {
    return interaction.reply({ content: pick(STATS_EMPTY), flags: MessageFlags.Ephemeral });
  }

  const hours = (stats.totalMs / 3_600_000).toFixed(1);
  const header = pick(STATS_HEADER, { sessions: stats.totalSessions, hours, lines: stats.totalLines });

  const talkLines = stats.talkative.map((t, i) => `${i + 1}. **${t.display_name}** — ${t.lines} lines`).join('\n');
  const longestRef = sessionRef(campaignLabel(target), stats.longestSessionNumber);
  const longest =
    stats.longestMeetingId !== null
      ? `${(stats.longestMs / 3_600_000).toFixed(1)}h (${longestRef ?? `session #${stats.longestMeetingId}`})`
      : 'unknown';

  const content = [
    `**${campaignLabel(target)}**`,
    header,
    '',
    '**Most talkative:**',
    talkLines,
    '',
    `**Longest session:** ${longest}`,
  ].join('\n');
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// The ledger of the campaign this command resolved to. Reads the folder from
// the campaign itself rather than from its last session, so a campaign whose
// notes exist but whose sessions were all deleted still answers.
async function ledgerEntries(db, cfg, campaignRow, filename) {
  if (!campaignRow) return null;
  const folder = campaignFolderFor(campaignRow);
  const raw = await readLedgerFile(cfg, folder, filename);
  return (raw || '').split('\n').filter((l) => l.trim().startsWith('-'));
}

function ledgerReply(entries, emptyPick, headerPick) {
  if (!entries || entries.length === 0) {
    return { content: pick(emptyPick), flags: MessageFlags.Ephemeral };
  }
  let content = pick(headerPick, { list: entries.join('\n') });
  if (content.length > 1900) {
    content = `${content.slice(0, 1900)}\n… _(truncated — see the full ledger in Obsidian)_`;
  }
  return { content, flags: MessageFlags.Ephemeral };
}

async function handleNpcs(interaction, db, cfg) {
  const entries = await ledgerEntries(db, cfg, campaign(interaction), 'NPCs.md');
  await interaction.reply(ledgerReply(entries, NPCS_EMPTY, NPCS_HEADER));
}

async function handleLocations(interaction, db, cfg) {
  const entries = await ledgerEntries(db, cfg, campaign(interaction), 'Locations.md');
  await interaction.reply(ledgerReply(entries, LOCATIONS_EMPTY, LOCATIONS_HEADER));
}

async function handleArchive(interaction, db, cfg) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const path = await exportCampaignSite(db, campaignId(interaction), cfg);
  const attachment = new AttachmentBuilder(path, { name: 'campaign-archive.html' });
  await interaction.editReply({ content: pick(ARCHIVE_SENT), files: [attachment] });
}

async function handleAsk(interaction, db, cfg) {
  const question = interaction.options.getString('question').trim();

  if (db.getSetting('summarize_paused') === 'true') {
    return interaction.reply({
      content: `⏸️ Summarising is paused, so I'm not calling ${summariserLabel(cfg)}. Run \`/resume\` first.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!(await isSummariserReachable(cfg))) {
    // Not the SUMMARIZE_UNREACHABLE text — that promises a background retry,
    // and there's no queue behind /ask to retry with.
    return interaction.reply({
      content: `🔮 The oracle is dark — ${summariserLabel(cfg)} isn't reachable right now. Try again shortly.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Answering means a full model round-trip; Discord needs the ack inside 3s.
  await interaction.deferReply();

  const { summaries, excerpts } = gatherContext(db, campaignId(interaction), question, cfg);
  if (summaries.length === 0 && excerpts.length === 0) {
    return interaction.editReply(
      "📭 There's nothing in the campaign records yet — I need at least one completed session to answer questions."
    );
  }

  const answer = await askCampaign({ question, summaries, excerpts, cfg });
  const body = `🔮 **${question}**\n\n${answer}`;
  await interaction.editReply(body.length > 1990 ? `${body.slice(0, 1980)}…` : body);
}

// The invited person's answer.
//
// Both buttons are removed once pressed: the question has been answered, and
// leaving them there invites a second, contradictory click on a DM that stays
// in the inbox forever.
async function handleConsentButton(interaction, db) {
  const parsed = parseConsentButton(interaction.customId);
  if (!parsed) return interaction.update({ content: '⚠️ Unrecognised button.', components: [] });

  const campaign = db.getCampaign(parsed.campaignId);
  const label = campaignLabel(campaign) ?? 'that campaign';

  // The campaign can have been deleted, or the invite withdrawn, between the
  // DM being sent and the button being pressed.
  if (!campaign) {
    return interaction.update({ content: `⚠️ **${label}** no longer exists.`, components: [] });
  }

  const result = db.decideConsent(parsed.campaignId, interaction.user.id, parsed.granted);
  if (!result) {
    return interaction.update({
      content: `⚠️ That invitation to **${label}** is no longer open — ask whoever runs the game for a new one.`,
      components: [],
    });
  }
  if (result.state === 'expired') {
    return interaction.update({ content: expiredMessage(label), components: [] });
  }

  console.log(
    `[consent] ${interaction.user.id} ${parsed.granted ? 'agreed to' : 'declined'} recording in campaign ${campaign.id}`
  );
  return interaction.update({
    content: parsed.granted ? acceptedMessage(label) : declinedMessage(label),
    components: [],
  });
}

async function handleApprovalButton(interaction, db, cfg) {
  const { customId } = interaction;

  // The invited person answering. Handled before everything else because it
  // arrives in a DM rather than in a server, so none of the operator buttons
  // below could ever be it.
  if (customId.startsWith(CONSENT_PREFIX)) return handleConsentButton(interaction, db);

  // The operator buttons — approve, park, and the transcribe scheduling row.
  //
  // These are no longer SENT: the decisions moved to the dashboard so that
  // nothing in the pipeline depends on a Discord interaction arriving. But
  // every DM the bot has already delivered still has them sitting in
  // scrollback, and a button that silently fails is worse than one that
  // explains itself — Discord shows "interaction failed" and leaves you
  // wondering whether it worked.
  //
  // So they are answered rather than handled. The job is untouched; the
  // dashboard is where it gets decided.
  if (
    customId.startsWith(TRANSCRIBE_PREFIX) ||
    customId.startsWith(APPROVE_PREFIX) ||
    customId.startsWith(PARK_PREFIX)
  ) {
    return interaction.update({
      content:
        '🖥️ **This moved to the dashboard.**\n' +
        'Approving a transcription or a summary now happens there, so the pipeline no longer needs Discord to be ' +
        'up for anything but the game itself. Nothing has changed about this session — it is still waiting, and ' +
        'the dashboard is showing it.' +
        dashboardPointer(cfg),
      components: [],
    });
  }
}

async function handlePause(interaction, db) {
  db.setSetting('summarize_paused', 'true');
  await interaction.reply({ content: pick(QUEUE_PAUSED), flags: MessageFlags.Ephemeral });
}

async function handleResume(interaction, db) {
  db.setSetting('summarize_paused', 'false');
  await interaction.reply({ content: pick(QUEUE_RESUMED), flags: MessageFlags.Ephemeral });
}

async function handleApprove(interaction, db, cfg) {
  const meetingId = interaction.options.getInteger('meeting_id');
  const provider = interaction.options.getString('provider');

  const effectiveCfg = withProvider(cfg, provider);
  const unusable = providerUnusableReason(effectiveCfg, provider);
  if (unusable) return interaction.reply({ content: unusable, flags: MessageFlags.Ephemeral });
  const note = provider ? `\n_Summarising with ${summariserLabel(effectiveCfg)}._` : '';

  if (meetingId === null) {
    // approveAllSummaries rather than db.approveAllWaiting: the raw query
    // matches every parked job of any type, so this used to release parked
    // TRANSCRIPTIONS too — and report the count as summaries. See the note in
    // pipeline/job-actions.js.
    const { message } = approveAllSummaries(db, cfg, { provider });
    return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  const job = db.listPendingJobs().find((j) => j.meeting_id === meetingId && j.status === 'awaiting_approval');
  if (!job) {
    return interaction.reply({
      content: `⚠️ Session #${meetingId} isn't awaiting approval — check \`/pending\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  db.approveJob(job.id, provider);
  await interaction.reply({
    content: pick(APPROVED_CONFIRM, { meetingId }) + note,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePending(interaction, db, cfg) {
  const rows = db.listPipeline();
  const paused = db.getSetting('summarize_paused') === 'true';
  const pausedNote = paused ? '\n\n⏸️ _Summarising is paused — run `/resume` to continue._' : '';

  if (rows.length === 0) {
    return interaction.reply({
      content: `${pick(PENDING_EMPTY)}${pausedNote}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const reachable = await isSummariserReachable(cfg);
  const lines = rows.map((r) => {
    const date = (r.started_at || '').slice(0, 10);
    const parts = [`**#${r.id} — ${r.channel_name} (${date})**`];
    parts.push(`  • session: \`${r.meeting_status}\`${r.utterance_count ? ` — ${r.utterance_count} lines` : ''}`);

    if (r.job_status === 'awaiting_approval') {
      parts.push(`  • summary: ⏸️ **awaiting your approval** — \`/approve meeting_id:${r.id}\``);
    } else if (r.job_status === 'running') {
      parts.push('  • summary: ⚙️ running now');
    } else if (r.job_status === 'pending') {
      const age = Math.round((Date.now() - new Date(r.next_attempt_at).getTime()) / 60000);
      const when = age >= 0 ? 'due now' : `retry in ~${Math.abs(age)}m`;
      parts.push(
        `  • summary: 🕒 queued (${when}, ${r.attempts} attempt(s))${r.last_error ? `\n    last error: _${String(r.last_error).slice(0, 120)}_` : ''}`
      );
    }
    return parts.join('\n');
  });

  let content = `🔧 **Pipeline** — ${summariserLabel(cfg)} is ${reachable ? '✅ reachable' : '❌ not reachable'}\n\n${lines.join('\n\n')}${pausedNote}`;
  if (content.length > 1900) {
    const trimmed = content.slice(0, 1900);
    content = `${trimmed.slice(0, trimmed.lastIndexOf('\n'))}\n… _(truncated)_`;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function timestamp(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}`;
}

async function handleSearch(interaction, db) {
  const query = interaction.options.getString('query').trim();
  if (!query) {
    return interaction.reply({ content: pick(SEARCH_NONE, { query }), flags: MessageFlags.Ephemeral });
  }

  const rows = db.searchUtterances(campaignId(interaction), query, 25);
  if (rows.length === 0) {
    return interaction.reply({ content: pick(SEARCH_NONE, { query }), flags: MessageFlags.Ephemeral });
  }

  // Group hits under the session they came from, so the answer reads like
  // "this happened in session #3" rather than a flat wall of quotes.
  const byMeeting = new Map();
  for (const row of rows) {
    if (!byMeeting.has(row.meeting_id)) byMeeting.set(row.meeting_id, []);
    byMeeting.get(row.meeting_id).push(row);
  }

  const blocks = [];
  for (const [meetingId, hits] of byMeeting) {
    const date = (hits[0].started_at || '').slice(0, 10);
    const lines = hits.map((h) => {
      const text = h.text.length > 160 ? `${h.text.slice(0, 157)}…` : h.text;
      return `\`[${timestamp(h.start_ms)}]\` **${h.display_name}:** ${text}`;
    });
    blocks.push(`**#${meetingId} — ${hits[0].channel_name} (${date})**\n${lines.join('\n')}`);
  }

  let content = `${pick(SEARCH_HEADER, { query, count: rows.length })}\n\n${blocks.join('\n\n')}`;
  if (content.length > 1900) {
    // Cut back to a line boundary so we never truncate mid-markdown.
    const trimmed = content.slice(0, 1900);
    content = `${trimmed.slice(0, trimmed.lastIndexOf('\n'))}\n… _(more matches — try a narrower search)_`;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleFunny(interaction, db) {
  const meetings = db.listCompletedMeetings(campaignId(interaction));

  // Every funny moment from every completed session, paired with which
  // session it came from — the pool /funny picks randomly out of.
  const pool = [];
  for (const meeting of meetings) {
    const notes = JSON.parse(meeting.summary_json || '{}');
    for (const moment of notes.funnyMoments || []) {
      pool.push({ moment, channel: meeting.channel_name, date: (meeting.started_at || '').slice(0, 10) });
    }
  }

  if (pool.length === 0) {
    return interaction.reply({ content: pick(FUNNY_NONE), flags: MessageFlags.Ephemeral });
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  await interaction.reply(pick(FUNNY_HEADER, chosen));
}
