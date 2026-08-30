import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config/env.js';
import { openDb } from './store/db.js';
import { commandDefs, registerCommandHandlers, activeSessions } from './commands/index.js';
import { startQueueWorker } from './pipeline/queue-worker.js';
import { startTranscribeWorker } from './pipeline/transcribe-worker.js';
import { recoverInterruptedMeetings } from './pipeline/recovery.js';
import { migrateLedgerFolders } from './campaign/vault-migrate.js';
import { describeOpusBackend } from './voice/opus-backend.js';
import { voicePool, poolSize } from './voice/pool.js';
import { startStatusServer } from './web/server.js';
import { startRetentionTimer } from './maintenance/retention.js';
import { startBackupTimer } from './maintenance/backup-check.js';
import { backupAndSyncDatabase } from './sync/drive-sync.js';
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

  // The other microphones.
  //
  // One bot user gets one voice connection per server, so recording two tables
  // in one Discord at the same time takes a second bot USER — not a second
  // copy of this process, which would fight this one over the job queue. These
  // clients register nothing and answer nothing; they exist to hold a voice
  // connection. See voice/pool.js for the whole argument, and config/env.js
  // for what DISCORD_VOICE_TOKENS expects.
  //
  // Built (and handed to the command handlers) BEFORE any of them has logged
  // in, deliberately: registerCommandHandlers closes over the pool, and
  // voice/pool.js asks each client whether it is really in a given guild at
  // the moment somebody runs /join. A bot still connecting is simply not
  // offered yet, which is the right answer rather than a race.
  const voiceClients = config.voiceTokens.map(
    () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] })
  );
  for (const extra of voiceClients) {
    extra.on('error', (err) => console.error('[voice-client] error:', err));
  }
  const pool = voicePool(client, voiceClients);

  registerCommandHandlers(client, db, config, pool);

  // 'ready' is deprecated in discord.js v14 and only fires as 'clientReady'
  // from v15 — the gateway READY event kept the old name, hence the rename.
  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Which opus implementation prism picked. Reported because the fallback
    // is silent and limits how many people can speak at once — see
    // voice/opus-backend.js.
    console.log(describeOpusBackend());

    // Bring the extra microphones up.
    //
    // A failure here is logged and survived rather than thrown. A bad extra
    // token costs the SECOND simultaneous table and nothing else — the primary
    // is already logged in and every recording that worked yesterday still
    // works — and taking the whole bot down over it would turn "one of my
    // three tokens expired" into "nobody can record anything tonight".
    //
    // Awaited one at a time so the logs read in order, but BOUNDED: everything
    // after this block — the queue worker, the transcribe worker, the
    // dashboard — is behind it, and a login that never settles would hold all
    // of them hostage. A Pi that came up with no dashboard because one spare
    // token was wrong is a far worse night than the second table it was for.
    // Each client's own 'clientReady' is what says it is really usable, since
    // the guild cache is what /join consults, and that can land after this
    // loop has moved on.
    const bounded = (promise, ms) =>
      Promise.race([
        promise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);

    for (const [i, extra] of voiceClients.entries()) {
      const label = `voice-${i + 1}`;
      extra.once('clientReady', () =>
        console.log(`[voice] ${label} ready as ${extra.user.tag} — in ${extra.guilds.cache.size} server(s)`)
      );
      await bounded(extra.login(config.voiceTokens[i]), 30_000).catch((err) => {
        console.error(
          `[voice] ${label} could not log in (${err.message}). ` +
            'That token records nothing; the rest of the bot is unaffected.'
        );
      });
    }
    if (voiceClients.length) {
      console.log(
        `[voice] ${poolSize(pool)} bot(s) available — up to ${poolSize(pool)} table(s) recording at once per server.`
      );
    }

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

    // Backups used to fire only when a session was recorded or summarised,
    // which meant a quiet fortnight had no snapshot — while consent decisions,
    // character names and corrections all changed underneath. See
    // maintenance/backup-check.js.
    const backups = startBackupTimer(db, config, { backupAndSync: backupAndSyncDatabase });
    if (backups) {
      backups.tick();
      console.log('Backup timer started (daily snapshot, verified after each one).');
    }

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
