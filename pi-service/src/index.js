import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config/env.js';
import { openDb } from './store/db.js';
import { commandDefs, registerCommandHandlers } from './commands/index.js';
import { startQueueWorker } from './pipeline/queue-worker.js';
import { recoverInterruptedMeetings } from './pipeline/recovery.js';
import { startRetentionTimer } from './maintenance/retention.js';
import { join } from 'node:path';

async function main() {
  const db = openDb(join(config.dataDir, 'db.sqlite'));

  // Do this before the Discord client even logs in — no reason to make a
  // reboot recovery wait on Discord connectivity, and we don't want new
  // /join commands racing with recovery over the same meeting rows.
  await recoverInterruptedMeetings(db, config).catch((err) =>
    console.error('[startup] recovery pass failed:', err)
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  // Without this, an unhandled 'error' event on an EventEmitter throws and
  // kills the whole process — and @discordjs/voice does emit one here on
  // certain connection lifecycle races (e.g. a reconnect timer firing after
  // destroy()). Log and keep running instead of crashing mid-session.
  client.on('error', (err) => console.error('[client] error:', err));

  registerCommandHandlers(client, db, config);

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    await rest.put(Routes.applicationCommands(config.discordClientId), { body: commandDefs });
    console.log('Slash commands registered.');

    startQueueWorker(db, client, config);
    console.log('Queue worker started — will retry summarization when the PC is reachable.');

    startRetentionTimer(db, config);
    console.log(`Retention timer started (${config.audioRetentionDays || 'disabled'} day(s)).`);
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
