import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ACTIONS } from '../src/web/actions.js';

// Discord is the entryway. The dashboard is the powerhouse.
//
// This file replaces test/dashboard-optional.test.js, which asserted the
// opposite arrangement: that anything somebody below dev could do on the
// dashboard had to exist as a slash command too, so that the web page stayed
// genuinely skippable. Every dashboard action had to earn a Discord twin, and a
// new one could not ship until it had one.
//
// That has been retired on the operator's own call, and it is worth writing
// down why rather than leaving a deleted file behind. Two reasons:
//
//   * It was a tax on the wrong thing. The dashboard is where this bot is
//     actually operated — the queue, the compendium, the transcripts, the
//     gatehouse, the bill — and none of that has, or wants, a slash command.
//     Parity meant every new control paid for itself twice.
//   * It ran out of room and did so silently. /campaign is at Discord's hard
//     ceiling of 25 subcommands. The rule was therefore no longer "add the
//     command too" but "delete one of these to add anything", which is not a
//     design principle, it is a wall.
//
// What survives is the half that was always load-bearing, and it is narrower
// and sharper: THE ACTS THAT MAKE SOMEBODY A PARTICIPANT STAY IN DISCORD.
// A player at the table agreed to play D&D. They did not agree to open a web
// page, hold a session, or be administered. Starting a recording, ending one,
// answering the consent question, naming their character and reading what was
// written about their evening are theirs, and they happen where they are.
//
// Everything above that line — managing, correcting, approving, metering,
// admitting — may live on the dashboard alone.

const COMMANDS = fileURLToPath(new URL('../src/commands/index.js', import.meta.url));

// The floor. Each of these is something a person at the table does for
// themselves, and each must be reachable without a browser.
const ENTRYWAY = {
  join: 'start recording this session',
  leave: 'stop recording it',
  consent: 'answer whether they may be recorded, and withdraw',
  setchar: 'say what their character is called',
  recap: 'read what happened last time',
  whoami: 'find out what the bot thinks they are',
  create: 'claim a campaign for a table that has none',
};

test('everything a player does for themselves is in Discord', async () => {
  const source = await readFile(COMMANDS, 'utf8');
  const registered = new Set([...source.matchAll(/setName\((["'])([a-z-]+)\1\)/g)].map((m) => m[2]));

  for (const [command, why] of Object.entries(ENTRYWAY)) {
    assert.ok(registered.has(command), `/${command} is the way to ${why}, and is not registered`);
  }
});

// The specific hole the retired file was written for, kept because it is still
// true and still worth defending: correcting a misheard name is the most common
// thing a DM does with a transcription bot, and it is a five-second act in the
// middle of a session. Making somebody open a browser for it would be absurd
// even in a world where the browser is the main tool.
test('correcting a misheard name does not require a web browser', async () => {
  const source = await readFile(COMMANDS, 'utf8');

  for (const sub of ['correct', 'uncorrect', 'corrections', 'replay']) {
    assert.match(source, new RegExp(`setName\\('${sub}'\\)`), `/campaign ${sub} is missing`);
  }
});

// Discord's own ceiling, asserted rather than discovered.
//
// A command may hold 25 options and a subcommand is an option, so the 26th
// throws inside discord.js's builder at import time — which surfaces as the
// whole bot failing to start, with a message ("Invalid Array length") that says
// nothing about subcommands. Found the hard way while adding one.
//
// Left at exactly 25 rather than a smaller number: the ceiling is the fact
// worth pinning, and a test that fails one command early would just be a
// different arbitrary wall.
test('/campaign has not outgrown what Discord will accept', async () => {
  const source = await readFile(COMMANDS, 'utf8');
  const subcommands = [...source.matchAll(/addSubcommand\(\(s\)/g)].length;

  assert.ok(
    subcommands <= 25,
    `/campaign has ${subcommands} subcommands; Discord allows 25. The bot will not start. ` +
      'Merge two into one with an option, or move something to the dashboard, which is where ' +
      'most things belong now anyway.'
  );
});

// Not a parity list any more — a map of what has a Discord shortcut, kept so
// that "is there a quick way to do this mid-session" has an answer somebody can
// read. A dashboard action absent from here is fine and needs no excuse.
const ALSO_IN_DISCORD = {
  'roster/invite': '/campaign invite',
  'roster/character': '/campaign setchar',
  'roster/forget': '/campaign remove',
  'campaign/output': '/campaign output',
  'campaign/create': '/campaign create',
  'campaign/delete': '/campaign delete',
  'campaign/restore': '/campaign restore',
  'corrections/add': '/campaign correct',
  'corrections/remove': '/campaign uncorrect',
  'corrections/replay': '/campaign replay',
};

test('every Discord shortcut named here is really registered', async () => {
  const source = await readFile(COMMANDS, 'utf8');
  const registered = new Set([...source.matchAll(/setName\((["'])([a-z-]+)\1\)/g)].map((m) => m[2]));

  for (const command of new Set(Object.values(ALSO_IN_DISCORD))) {
    assert.ok(registered.has(command.split(' ')[1]), `${command} is named here but is not registered`);
  }
});

test('the shortcut map does not name an action that no longer exists', () => {
  const gone = Object.keys(ALSO_IN_DISCORD).filter((a) => !(a in ACTIONS));
  assert.deepEqual(gone, [], 'an action listed here has been removed or renamed');
});
