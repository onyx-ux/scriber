// MessageFlags.Ephemeral replaces the old `ephemeral: true` reply option,
// which discord.js deprecated and drops entirely in v15.
import { SlashCommandBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startCapture } from '../voice/capture.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
import { isSummariserReachable, summariserLabel } from '../pipeline/model-client.js';
import { askCampaign, askAllowance, gatherContext } from '../pipeline/ask-client.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { campaignFolder, campaignFolderFor } from '../export/naming.js';
import { TRANSCRIBE_PREFIX } from '../pipeline/transcribe-schedule.js';
import { notifyTranscribeReady } from '../delivery/transcribe-notify.js';
import { resolveSpeakerName } from '../campaign/character-names.js';
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
import { isOwner } from '../campaign/permissions.js';
import { createCampaign } from '../campaign/create.js';
import { handleCorrect, handleUncorrect, handleCorrections, handleReplay } from './corrections.js';
// Naming a character is a rule, not a write: it decides what the name is, and
// whether that name will appear in anything. Both callers go through here so
// the dashboard and /setchar cannot drift — see pipeline/job-actions.js.
import { setCharacter } from '../pipeline/job-actions.js';
import { handleCampaignDelete, handleCampaignRestore } from './archive.js';
import { handleRestoreModal } from './restore-request.js';
import { notifyRestoreRequested } from '../delivery/restore-notify.js';
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
  WITHDRAW_PREFIX,
  parseWithdrawButton,
  buildStandingMessage,
  buildStoppedMessage,
  buildResumedMessage,
  buildManagerNotice,
} from '../campaign/consent.js';
import { standing, stopRecording, resumeRecording } from '../campaign/withdrawal.js';
import { exportCampaignSite } from '../export/site.js';
import {
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
  HISTORY_EMPTY,
  SUMMARIZE_UNREACHABLE,
  EXPORT_INTRO,
  SETCHARACTER_CONFIRM,
  RECAP_NONE,
  RECAP_HEADER,
  FUNNY_NONE,
  FUNNY_HEADER,
  SEARCH_NONE,
  SEARCH_HEADER,
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

// What a PLAYER can run anywhere.
//
// Discord calls this a user install: a player adds Quill to their own account
// and its commands follow them into any channel, including servers the bot has
// never been in. Discord shows those replies only to whoever ran them, which
// suits the read subcommands — they already reply privately.
//
// The optional `campaign` option exists because interaction.guildId is useless
// there: run in some unrelated server it names that server, not the game.
// campaign/resolve.js resolves it, and enforces that a caller can only reach a
// campaign they have actually spoken in.
const IntegrationType = { GUILD_INSTALL: 0, USER_INSTALL: 1 };
const InteractionContext = { GUILD: 0, BOT_DM: 1, PRIVATE_CHANNEL: 2 };

// Which tier each part of the surface sits in.
//
// These used to be sets of COMMAND names, back when there were twenty-seven of
// them. The pipeline commands are gone — approve, pause, transcribe, import
// and the rest live on the dashboard now — and everything that remains is a
// subcommand of /campaign, so the tier is decided by the subcommand.
//
// The tier is enforced by RESOLUTION, not by a separate gate: a subcommand
// that resolves to a campaign you run is a subcommand you may run. There is no
// second check to fall out of step with. See campaign/resolve.js.

// READ. The ones a player takes with them: a user-installed app can run these
// anywhere, and the resolver restricts them to campaigns the caller has
// actually played in.
const PLAYER_SUBCOMMANDS = new Set([
  'recap', 'funny', 'search', 'ask', 'history', 'stats', 'npcs', 'locations', 'archive', 'export',
  // `consent` sits at this tier rather than MEMBER on purpose. It has to work
  // in a DM — the invitation arrived in one, and someone withdrawing may
  // reasonably not want to do it in front of the table — and MEMBER refuses
  // outside a server. It is also the one command that must remain reachable by
  // a person who has just told the bot to stop recording them.
  'consent',
]);

// MEMBER. Acts on the table you are sitting at, so it needs a campaign you are
// on the roster for, in this server.
const MEMBER_SUBCOMMANDS = new Set(['setchar', 'whoami']);

// MANAGE. Reshaping a campaign's records belongs to whoever runs the game —
// held by whoever created it, not by a Discord permission.
//
// `create` and `list` are absent on purpose: creating has to work for someone
// who runs nothing yet, and listing shows what is here. Both resolve for
// themselves.
export const MANAGER_SUBCOMMANDS = new Set([
  'rename', 'invite', 'remove', 'output',
  // Corrections reshape the record itself, which makes them the same
  // authority as renaming the campaign rather than a lesser one.
  'correct', 'uncorrect', 'corrections', 'replay',
  // Deleting is the manager tier too. Restoring is deliberately absent: an
  // archived campaign cannot be resolved -- that is what archiving it means
  // -- so its handler finds its own and scopes to what the caller ran.
  'delete',
]);

// /join and /leave are the only commands left outside /campaign, because they
// are the only two that must be run from inside the voice channel being
// recorded. /join needs a campaign you are on the roster for; /leave does its
// own check against the session actually running (see handleLeave).
const MEMBER_COMMANDS = new Set(['join']);

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

// /campaign carries USER_INSTALL because its READ subcommands are the ones a
// player takes with them, and Discord sets integration types per command
// rather than per subcommand. Nothing is opened up by that: each subcommand
// still resolves its own campaign through its own tier, and a stranger who
// installs the app reaches only campaigns they have actually spoken in.
function campaignCommand(builder) {
  return builder
    .setIntegrationTypes([IntegrationType.GUILD_INSTALL, IntegrationType.USER_INSTALL])
    .setContexts([InteractionContext.GUILD, InteractionContext.BOT_DM, InteractionContext.PRIVATE_CHANNEL]);
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
  // Everything else, under one command.
  //
  // There used to be twenty-seven top-level commands. A player who installed
  // the app, or anyone opening the picker in a server the bot was invited to,
  // saw the lot — including `approve`, `pause`, `import`, `transcribe` and the
  // rest of the pipeline, which spends the owner's GPU and API budget and has
  // nothing to do with playing D&D. Those have moved to the dashboard, and
  // what remains is the game: one command, and the two that start and stop a
  // recording.
  //
  // Subcommands rather than a pile of optional flags, because a server can now
  // hold several campaigns and "create" and "rename" are very different acts
  // to conflate behind one `name:` option — the flat version would have made a
  // typo in an existing campaign's name silently create a second one.
  //
  // User-installable, and that is load-bearing rather than convenient: the
  // read subcommands are the ones a player takes with them, and Discord sets
  // integration types per COMMAND, not per subcommand. Folding the reads in
  // here means the whole command carries USER_INSTALL. Nothing is opened up by
  // that — every subcommand resolves its own campaign through the same three
  // tiers, and resolution IS the permission check (see campaign/resolve.js) —
  // but it is the reason this one command answers to all three.
  campaignCommand(
    new SlashCommandBuilder()
      .setName('campaign')
      .setDescription('Your campaign — its notes, its people, and its records')
      .setDMPermission(true)

      // --- running a campaign ---
      .addSubcommand((s) =>
        s
          .setName('create')
          .setDescription('Start a new campaign in this server — you become its DM')
          .addStringOption((o) => o.setName('name').setDescription('e.g. "Sunless Citadel"').setRequired(true))
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
          .addStringOption(campaignOption)
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
          .addStringOption(campaignOption)
      )

      // --- deleting one, and changing your mind ---
      //
      // `confirm` is a required option rather than a yes/no, because typing the
      // name is the safety mechanism: it makes the hand slow down and look at
      // which campaign this actually is. `restore` resolves nothing, like
      // `create` and `list` — an archived campaign is invisible to the resolver
      // by design, so a subcommand that goes looking for one has to do it
      // itself.
      .addSubcommand((s) =>
        s
          .setName('delete')
          .setDescription('Delete a campaign you run — recoverable for 30 days')
          .addStringOption((o) =>
            o
              .setName('confirm')
              .setDescription('Type the campaign’s name exactly, to be sure this is the one')
              .setRequired(true)
          )
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('restore')
          .setDescription('Bring back a campaign you deleted in the last 30 days')
          .addStringOption((o) =>
            o.setName('campaign').setDescription('Which one — leave empty to see what is waiting').setRequired(false)
          )
      )

      // --- what Whisper keeps getting wrong ---
      //
      // Flat rather than a `correction` subcommand group: the dispatcher and
      // both permission tiers key off the bare subcommand name, so a group
      // would put `correction list` and `correction remove` through the routes
      // and tiers belonging to the top-level `list` and `remove`.
      .addSubcommand((s) =>
        s
          .setName('correct')
          .setDescription('Teach Quill a name it keeps mishearing — applies to old transcripts and new')
          .addStringOption((o) =>
            o.setName('heard').setDescription('What it writes, e.g. "Kaylen"').setRequired(true)
          )
          .addStringOption((o) =>
            o.setName('write').setDescription('What it should write, e.g. "Kaelen"').setRequired(true)
          )
          .addBooleanOption((o) =>
            o
              .setName('confirm')
              .setDescription('Apply it even if it would rewrite a large share of the campaign')
              .setRequired(false)
          )
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('uncorrect')
          .setDescription('Drop a correction — lines already rewritten stay rewritten')
          .addStringOption((o) =>
            o.setName('heard').setDescription('The wrong text it was matching on').setRequired(true)
          )
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('corrections')
          .setDescription('List the corrections saved for this campaign')
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('replay')
          .setDescription('Re-apply every correction over this campaign’s existing transcripts')
          .addStringOption(campaignOption)
      )

      // --- your own name at the table ---
      .addSubcommand((s) =>
        s
          .setName('setchar')
          .setDescription('Map your Discord account to your D&D character name for transcripts and notes')
          .addStringOption((o) => o.setName('name').setDescription('Character name').setRequired(true))
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('whoami')
          .setDescription('Show what name you currently appear as in transcripts and notes')
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('consent')
          .setDescription('See whether you are being recorded, and stop it or take back what you have said')
          .addStringOption(campaignOption)
      )

      // --- reading the campaign back ---
      .addSubcommand((s) =>
        s.setName('recap').setDescription("Post last session's TL;DR again").addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('funny')
          .setDescription("Pull a random funny or memorable moment from this campaign's history")
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('search')
          .setDescription('Search every transcript in this campaign for a word or phrase')
          .addStringOption((o) =>
            o.setName('query').setDescription('Word or phrase to look for (e.g. an NPC name)').setRequired(true)
          )
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('ask')
          .setDescription('Ask a question about this campaign, answered from past sessions')
          .addStringOption((o) =>
            o.setName('question').setDescription('e.g. "who was the smuggler we met at the docks?"').setRequired(true)
          )
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('history')
          .setDescription('List recent sessions')
          .addIntegerOption((o) => o.setName('count').setDescription('How many to show').setRequired(false))
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('export')
          .setDescription('Get the transcript for a session as a file')
          .addStringOption((o) =>
            o.setName('session').setDescription('e.g. Cipher_02').setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName('stats')
          .setDescription('Campaign-wide totals: sessions, hours, lines, and who talks the most')
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('npcs')
          .setDescription('List every NPC the campaign has met so far')
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('locations')
          .setDescription('List every location the campaign has visited so far')
          .addStringOption(campaignOption)
      )
      .addSubcommand((s) =>
        s
          .setName('archive')
          .setDescription('Get the browsable campaign archive (a single HTML file) right now')
          .addStringOption(campaignOption)
      )
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
  const sub = interaction.options.getSubcommand(false);
  const userId = interaction.user.id;

  if (MEMBER_COMMANDS.has(name) || MEMBER_SUBCOMMANDS.has(sub)) {
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

  if (MANAGER_SUBCOMMANDS.has(sub)) {
    const all = interaction.guildId ? db.listCampaignsInGuild(interaction.guildId) : db.listCampaigns();
    return isOwner(userId, cfg, db) ? all : all.filter((c) => c.manager_user_id === userId);
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
    const reachable = isOwner(interaction.user.id, cfg, db)
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

  // The `player` picker went with /dm, which autocompleted from the speakers
  // the bot happened to have recorded. The roster is managed on the dashboard
  // now, where it can list everyone with their consent state — including the
  // people the bot has never heard, who are exactly the ones whose names need
  // setting. /campaign invite and remove take a real Discord user picker.
  return interaction.respond([]);
}

// The whole surface, minus the two commands that have to be run from inside a
// voice channel.
//
// The campaign is already resolved by the dispatcher for every subcommand that
// needs one, through the tier that subcommand sits in — so these handlers read
// interaction.quillCampaign and do not re-check anything. The exceptions are
// the two at the top, which deliberately resolve nothing: `create` has to work
// for someone who runs no campaign yet, and `list` says what is here.
const CAMPAIGN_ROUTES = {
  create: (i, db, cfg) => handleCampaignCreate(i, db, cfg),
  list: (i, db, cfg) => handleCampaignList(i, db, cfg),

  rename: (i, db, cfg) => handleCampaignRename(i, db, cfg, campaign(i)),
  output: (i, db) => handleCampaignOutput(i, db, campaign(i)),
  invite: (i, db, cfg) => handleCampaignInvite(i, db, cfg, campaign(i)),
  remove: (i, db) => handleCampaignRemove(i, db, campaign(i)),

  delete: (i, db, cfg) => handleCampaignDelete(i, db, cfg, campaign(i)),
  restore: (i, db, cfg) => handleCampaignRestore(i, db, cfg),

  correct: (i, db) => handleCorrect(i, db, campaign(i)),
  uncorrect: (i, db) => handleUncorrect(i, db, campaign(i)),
  corrections: (i, db) => handleCorrections(i, db, campaign(i)),
  replay: (i, db) => handleReplay(i, db, campaign(i)),

  setchar: (i, db) => handleSetCharacter(i, db),
  whoami: (i, db) => handleWhoAmI(i, db),
  consent: (i, db, cfg) => handleConsent(i, db, cfg),

  recap: (i, db) => handleRecap(i, db),
  funny: (i, db) => handleFunny(i, db),
  search: (i, db) => handleSearch(i, db),
  ask: (i, db, cfg) => handleAsk(i, db, cfg),
  history: (i, db) => handleHistory(i, db),
  export: (i, db, cfg) => handleExport(i, db, cfg),
  stats: (i, db) => handleStats(i, db),
  npcs: (i, db, cfg) => handleNpcs(i, db, cfg),
  locations: (i, db, cfg) => handleLocations(i, db, cfg),
  archive: (i, db, cfg) => handleArchive(i, db, cfg),
};

async function handleCampaign(interaction, db, cfg) {
  const route = CAMPAIGN_ROUTES[interaction.options.getSubcommand()];
  // Unreachable through Discord, which only sends subcommands the bot
  // registered — but a route missing from the table above would otherwise fail
  // as "cannot read property of undefined" with nothing naming the cause.
  if (!route) {
    return interaction.reply({ content: "⚠️ I don't know that subcommand.", flags: MessageFlags.Ephemeral });
  }
  return route(interaction, db, cfg);
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
  // does not put them at the table any more, answering does. Its mayRecord is
  // ignored on purpose: of course an invitee has not agreed yet, and the reply
  // below already says the recording waits on them.
  if (name) setCharacter(db, { campaignId: target.id, userId: user.id, name });

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

  // Every rule about names, clashes and ceilings lives in campaign/create.js,
  // because the dashboard performs the same act and a second copy would drift.
  const made = createCampaign({
    db,
    cfg,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    name: interaction.options.getString('name'),
  });

  if (!made.ok) {
    return interaction.reply({ content: made.message, flags: MessageFlags.Ephemeral });
  }

  return interaction.reply({
    content:
      `📖 **${made.name}** exists. You run it.\n` +
      `Session notes are filed in \`${made.folder}/\` as \`Session 01.md\`, \`Session 02.md\`, and referred to as \`${sessionRef(made.name, 1)}\`.\n\n` +
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

    // The restore ticket's three answers come back as a modal submission.
    if (interaction.isModalSubmit?.()) {
      try {
        return await handleRestoreModal(interaction, db, cfg, {
          notify: ({ requestId }) =>
            notifyRestoreRequested({ discordClient: client, db, cfg, requestId }),
        });
      } catch (err) {
        console.error('[modal] error:', err);
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
    // Everything but /join and /leave is a subcommand now, so the subcommand
    // is what decides the tier and the handler. getSubcommand(false) rather
    // than the throwing form: /join and /leave have none.
    const sub = interaction.options.getSubcommand(false);

    // Resolve which campaign this is about BEFORE the handler runs, so every
    // handler reads one value regardless of where it was invoked from.
    //
    // The tier decides the candidate list, and that resolution IS the
    // permission check: a subcommand that resolves to a campaign you run is a
    // subcommand you may run. There is no separate gate to fall out of step
    // with — see campaign/resolve.js.
    //
    // `create` and `list` resolve nothing here: creating has to work for
    // someone who runs no campaign yet, and listing shows what is here. The
    // read subcommands that take an explicit session reference carry their own
    // campaign, so `export` resolves through the READ tier for its candidate
    // list and then narrows by reference.
    const resolver = MANAGER_SUBCOMMANDS.has(sub)
      ? resolveManagedCampaign
      : MEMBER_COMMANDS.has(name) || MEMBER_SUBCOMMANDS.has(sub)
        ? resolveMemberCampaign
        : PLAYER_SUBCOMMANDS.has(sub) && sub !== 'export'
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
      if (name === 'join') return await handleJoin(interaction, db, cfg);
      if (name === 'leave') return await handleLeave(interaction, db, cfg);
      if (name === 'campaign') return await handleCampaign(interaction, db, cfg);
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
    // Split by WHY they are not being recorded, because the two need opposite
    // things from the DM. Someone who has never been asked needs an invite;
    // someone who used /campaign consent to turn recording off has already
    // answered, and inviting them again is pestering them with a button.
    const silent = voiceChannel.members.filter((m) => !m.user.bot && !db.mayRecord(target.id, m.id));
    const unrecorded = {
      unasked: silent.filter((m) => db.getConsent(target.id, m.id)?.state !== 'declined').map((m) => m.displayName),
      declined: silent.filter((m) => db.getConsent(target.id, m.id)?.state === 'declined').map((m) => m.displayName),
    };

    await interaction.editReply(
      pick(JOIN_STARTED, { channel: voiceChannel.name }) +
        (several ? `\n_Recording **${campaignLabel(target)}**${ref ? ` — \`${ref}\`` : ''}._` : '') +
        describeUnrecorded(unrecorded)
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
    isOwner(interaction.user.id, cfg, db) ||
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

// A typed reference ("Cipher_02") resolved against the campaigns this caller
// may look at. The membership filter is the point: a bare meeting id named no
// campaign, so there was nothing to check and /export 16 returned whatever
// session 16 happened to be, on anyone's server.
//
// The owner reaches every campaign, since these are all owner-tier commands
// and unsticking someone else's stuck session is the job.
function resolveSession(interaction, db, cfg) {
  const reachable = isOwner(interaction.user.id, cfg, db)
    ? db.listCampaigns()
    : db.listCampaignsForUser(interaction.user.id);
  return resolveSessionRef(interaction.options.getString('session'), reachable, db);
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
  const result = setCharacter(db, {
    campaignId: target.id,
    userId: interaction.user.id,
    name: interaction.options.getString('name'),
  });

  if (!result.ok) {
    return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    content:
      pick(SETCHARACTER_CONFIRM, { name: result.name }) +
      // Every line of that flavour text promises the name will show up in the
      // transcripts. For somebody who has not agreed to be recorded that is
      // simply untrue — capture skips them entirely (voice/capture.js), so the
      // name goes nowhere. Say so, in the same terms /join uses for the people
      // it is not recording.
      unrecordedCaveat(result.consent) +
      (db.countCampaignsInGuild(interaction.guildId) > 1 ? `\n_In **${campaignLabel(target)}**._` : ''),
    flags: MessageFlags.Ephemeral,
  });
}

// Addressed to the player themselves, unlike describeUnrecorded in
// campaign/consent.js, which is written for whoever is running the session.
function unrecordedCaveat(consent) {
  if (consent === 'granted') return '';
  if (consent === 'declined') {
    return (
      "\n🔇 _Recording is off for you in this campaign by your own choice, so this name won't appear anywhere yet. " +
      '`/campaign consent` turns it back on whenever you want._'
    );
  }
  return (
    "\n🔇 _You haven't agreed to be recorded in this campaign yet, so nothing you say is captured and this name " +
    "won't appear anywhere. Answer the invite in your DMs, or ask whoever runs the table for one._"
  );
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

  // The one place somebody who is not the owner can spend the owner's API
  // budget. Checked before the defer so a refusal is a plain ephemeral reply
  // rather than a "thinking…" that turns into a no.
  const allowance = askAllowance(db, cfg, interaction.user.id);
  if (!allowance.allowed) {
    return interaction.reply({ content: `🔮 ${allowance.message}`, flags: MessageFlags.Ephemeral });
  }

  // Answering means a full model round-trip; Discord needs the ack inside 3s.
  await interaction.deferReply();

  const { summaries, excerpts } = gatherContext(db, campaignId(interaction), question, cfg);
  if (summaries.length === 0 && excerpts.length === 0) {
    return interaction.editReply(
      "📭 There's nothing in the campaign records yet — I need at least one completed session to answer questions."
    );
  }

  // Counted before the call, not after: a question that fails still costs a
  // slot, or a failing model is an unlimited one.
  db.countAsk(interaction.user.id);

  const answer = await askCampaign({ question, summaries, excerpts, cfg, db });
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

// --- taking consent back -------------------------------------------------
//
// Everything in this flow is ephemeral. Whether you are being recorded, and
// whether you have decided to stop, is nobody else's business — least of all
// the channel's, where it would read as an announcement and turn a private
// decision into an event other people have opinions about.

async function handleConsent(interaction, db, cfg) {
  const campaignRow = campaign(interaction);
  const now = standing(db, {
    campaignId: campaignRow.id,
    userId: interaction.user.id,
    retentionDays: cfg.audioRetentionDays ?? null,
  });

  await interaction.reply({
    ...buildStandingMessage(now, campaignLabel(campaignRow)),
    flags: MessageFlags.Ephemeral,
  });
}

// The buttons under it. Each one edits the message it came from rather than
// posting a new one, so the flow is a single card that changes rather than a
// thread of decisions left in somebody's DMs.
async function handleWithdrawButton(interaction, db, cfg) {
  const parsed = parseWithdrawButton(interaction.customId);
  if (!parsed) return interaction.update({ content: '⚠️ Unrecognised button.', components: [] });

  const campaignRow = db.getCampaign(parsed.campaignId);
  if (!campaignRow) {
    return interaction.update({ content: '⚠️ That campaign no longer exists.', components: [] });
  }
  const label = campaignLabel(campaignRow);
  const userId = interaction.user.id;

  if (parsed.action === 'resume') {
    const result = resumeRecording(db, { campaignId: parsed.campaignId, userId });
    if (!result.ok) return interaction.update({ content: result.message, components: [] });
    console.log(`[consent] ${userId} resumed recording in campaign ${parsed.campaignId}`);
    return interaction.update({ content: buildResumedMessage(label), components: [] });
  }

  // parsed.action === 'stop'
  const result = stopRecording(db, { campaignId: parsed.campaignId, userId });
  if (!result.ok) return interaction.update({ content: result.message, components: [] });

  const after = standing(db, { campaignId: parsed.campaignId, userId });
  console.log(`[consent] ${userId} stopped recording in campaign ${parsed.campaignId}`);
  await interaction.update({ content: buildStoppedMessage(label, after), components: [] });

  // Only when something actually changed. Re-pressing the button on a card that
  // has been sitting open for a week should not DM the DM a second time.
  if (!result.alreadyStopped) await tellManager(interaction, campaignRow, label);
}

async function tellManager(interaction, campaignRow, label) {
  if (!campaignRow.manager_user_id || campaignRow.manager_user_id === interaction.user.id) return;
  try {
    const manager = await interaction.client.users.fetch(campaignRow.manager_user_id);
    await manager.send(
      buildManagerNotice({
        campaignName: label,
        who: interaction.user.displayName || interaction.user.username,
      })
    );
  } catch (err) {
    // A manager with DMs closed must not turn a completed withdrawal into a
    // failure. The decision stands; this is a courtesy.
    console.warn(`[consent] could not tell the manager of campaign ${campaignRow.id}: ${err.message}`);
  }
}

async function handleApprovalButton(interaction, db, cfg) {
  const { customId } = interaction;

  if (customId.startsWith(WITHDRAW_PREFIX)) return handleWithdrawButton(interaction, db, cfg);

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
