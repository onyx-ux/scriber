import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config/env.js';
import { openDb } from './store/db.js';
import { commandDefs, registerCommandHandlers } from './commands/index.js';
import { startQueueWorker } from './pipeline/queue-worker.js';
import { startTranscribeWorker } from './pipeline/transcribe-worker.js';
import { recoverInterruptedMeetings } from './pipeline/recovery.js';
import { describeOpusBackend } from './voice/opus-backend.js';
import { startRetentionTimer } from './maintenance/retention.js';
import { join } from 'node:path';

// The bot runs as root inside the container, but the files it writes are
// collected over SFTP by an ordinary user on the host. Deleting a file needs
// write permission on its DIRECTORY, so with the default 022 umask every
// directory came out as root:root 755 and the collector could copy files but
// never remove them — `rclone move` silently degraded to `rclone copy` and
// nothing was ever freed from the Pi. 002 makes new files and directories
// group-writable, which (with the setgid bit on the export roots) lets the
// collector clean up after itself.
process.umask(0o002);

async function main() {
  const db = openDb(join(config.dataDir, 'db.sqlite'));

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

    startRetentionTimer(db, config);
    console.log(`Retention timer started (${config.audioRetentionDays || 'disabled'} day(s)).`);
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
