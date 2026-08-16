import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config/env.js';
import { openDb } from './store/db.js';
import { commandDefs, registerCommandHandlers, activeSessions } from './commands/index.js';
import { startQueueWorker } from './pipeline/queue-worker.js';
import { startTranscribeWorker } from './pipeline/transcribe-worker.js';
import { recoverInterruptedMeetings } from './pipeline/recovery.js';
import { migrateLedgerFolders } from './campaign/vault-migrate.js';
import { describeOpusBackend } from './voice/opus-backend.js';
import { startStatusServer } from './web/server.js';
import { startRetentionTimer } from './maintenance/retention.js';
import { join } from 'node:path';

// The umask that makes those files collectable over SFTP is set in
// config/env.js, so the vault scripts get it too — see the note there.

const startedAtMs = Date.now();

async function main() {
  const db = openDb(join(config.dataDir, 'db.sqlite'));

  // Campaigns that predate campaign management go to the bot owner. Without
  // this every existing campaign reads as unclaimed, and the first person to
  // run /campaign in one would take it over — including in a server the owner
  // set up long before the idea of a manager existed.
  if (config.ownerUserId) {
    const adopted = db.adoptUnmanagedCampaigns(config.ownerUserId);
    if (adopted) console.log(`[campaigns] ${adopted} unmanaged campaign(s) assigned to the bot owner`);
  }

  // Before anything reads a ledger. A half-migrated ledger silently loses
  // its dedupe and re-introduces every NPC the campaign has ever met.
  for (const step of await migrateLedgerFolders({ db, cfg: config }).catch((err) => {
    console.error('[startup] vault migration failed:', err);
    return [];
  })) {
    if (!step.to) console.warn(`[vault] left ${step.from} alone — ${step.reason}`);
    else console.log(`[vault] moved ${step.moved.length} ledger file(s) into ${step.to}`);
    if (step.skipped?.length) console.warn(`[vault] not overwritten in ${step.to}: ${step.skipped.join(', ')}`);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  // Without this, an unhandled 'error' event on an EventEmitter throws and
  // kills the whole process — and @discordjs/voice does emit one here on
  // certain connection lifecycle races (e.g. a reconnect timer firing after
  // destroy()). Log and keep running instead of crashing mid-session.
  client.on('error', (err) => console.error('[client] error:', err));

  registerCommandHandlers(client, db, config);

  // 'ready' is deprecated in discord.js v14 and only fires as 'clientReady'
  // from v15 — the gateway READY event kept the old name, hence the rename.
  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Which opus implementation prism picked. Reported because the fallback
    // is silent and limits how many people can speak at once — see
    // voice/opus-backend.js.
    console.log(describeOpusBackend());

    // Runs after login (not before, like it used to) specifically so it can
    // resolve real Discord display names via the now-cached guilds — a
    // recovered transcript used to fall back to bare user IDs for every
    // speaker because no client was available yet at this point.
    await recoverInterruptedMeetings(db, config, client).catch((err) =>
      console.error('[startup] recovery pass failed:', err)
    );

    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    await rest.put(Routes.applicationCommands(config.discordClientId), { body: commandDefs });
    console.log('Slash commands registered.');

    startQueueWorker(db, client, config);
    console.log('Queue worker started — will retry summarization when the PC is reachable.');

    startTranscribeWorker(db, client, config);
    console.log(
      `Transcribe worker started — auto window ${config.transcribeWindowStartHour}:00-${config.transcribeWindowEndHour}:00 ` +
        `${config.transcribeWeekdaysOnly ? 'weekdays' : 'daily'} (${config.scheduleTimeZone}).`
    );

    startStatusServer({ db, cfg: config, client, activeSessions, startedAtMs });

    startRetentionTimer(db, config);
    console.log(`Retention timer started (${config.audioRetentionDays || 'disabled'} day(s)).`);

    // An invitation nobody answered stops being one after a day. Swept hourly
    // as well as checked when a button is pressed: the button check is what
    // makes it safe, and the sweep is what stops a table's roster filling with
    // questions that were never going to be answered.
    const sweepInvites = () => {
      try {
        const expired = db.expireStaleInvites();
        if (expired) console.log(`[consent] ${expired} unanswered invitation(s) expired`);
      } catch (err) {
        console.warn(`[consent] invite sweep failed: ${err.message}`);
      }
    };
    sweepInvites();
    setInterval(sweepInvites, 60 * 60 * 1000).unref?.();
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
