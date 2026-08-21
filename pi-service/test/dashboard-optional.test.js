import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ACTIONS } from '../src/web/actions.js';

// The dashboard has to stay optional.
//
// Not "nice to have" optional — genuinely skippable. Quill is a Discord bot,
// and the people at the table did not agree to run a web page; some of them
// will never open one. The moment something can ONLY be done on the dashboard,
// the dashboard stops being a convenience and becomes a dependency, and a
// self-hosted bot has quietly grown a second thing that must be working.
//
// This is not the same claim as permission-alignment.test.js, which maps each
// slash command to the dashboard level that can do the same thing. That asks
// "does the dashboard agree with Discord about who". This asks "is there
// anything you can only do here", which is the question that decides whether
// somebody can ignore the web page entirely.
//
// The rule is deliberately narrow. Dev-only machinery — pausing the queue,
// choosing a model, importing a recording, discarding a failed session — is the
// operator's own console, and the operator is the person who chose to run all
// this. It is everything a NON-dev can reach that must also exist in Discord.

const COMMANDS = fileURLToPath(new URL('../src/commands/index.js', import.meta.url));

// Every action a viewer below dev can reach, and the Discord command that does
// the same job. `null` would mean the dashboard is load-bearing for that act.
const REACHABLE_WITHOUT_DEV = {
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

  // A convenience with no command of its own, and it needs none: Discord's
  // own user picker is what /campaign invite takes, so the web page searching
  // members is solving a problem Discord does not have.
  'roster/search': '/campaign invite',
};

// The operator's console. Dashboard-only is allowed here — but it is listed
// rather than assumed, so moving an action out of dev has to be noticed.
const DEV_ONLY = new Set([
  'pause', 'transcribe', 'import', 'session/discard',
  'summary/approve', 'summary/approve-all', 'summary/park', 'summary/again',
  'model/choose', 'health/probe', 'access/revoke',
  // Deciding a restore request is the operator reviewing their own queue.
  // The requester never needs this; they file the ticket from Discord.
  'campaign/restore-review',
]);

test('every action is classified — no action escapes this file unnoticed', () => {
  const known = new Set([...Object.keys(REACHABLE_WITHOUT_DEV), ...DEV_ONLY]);
  const actual = Object.keys(ACTIONS);

  const unclassified = actual.filter((a) => !known.has(a));
  assert.deepEqual(unclassified, [], 'a new dashboard action has to be declared dev-only or given a Discord equal');

  const stale = [...known].filter((a) => !actual.includes(a));
  assert.deepEqual(stale, [], 'an action listed here no longer exists');
});

test('nothing a non-dev can do is dashboard-only', () => {
  const orphans = Object.entries(REACHABLE_WITHOUT_DEV)
    .filter(([, command]) => !command)
    .map(([action]) => action);

  assert.deepEqual(
    orphans,
    [],
    'these can only be done on the dashboard, which makes the dashboard compulsory for whoever needs them'
  );
});

// The claim above is only worth anything if the commands it names exist.
test('every Discord command named here is really registered', async () => {
  const source = await readFile(COMMANDS, 'utf8');
  const registered = new Set([...source.matchAll(/setName\((["'])([a-z-]+)\1\)/g)].map((m) => m[2]));

  for (const command of new Set(Object.values(REACHABLE_WITHOUT_DEV))) {
    const sub = command.split(' ')[1];
    assert.ok(registered.has(sub), `${command} is named as the way out of the dashboard but is not registered`);
  }
});

// The specific hole this file was written for. Correcting a misheard name is
// the most common thing a DM does with a transcription bot, and it lived only
// on the dashboard — which meant the dashboard was never really optional,
// whatever anybody said about it.
test('correcting a misheard name does not require a web browser', async () => {
  const source = await readFile(COMMANDS, 'utf8');

  for (const sub of ['correct', 'uncorrect', 'corrections', 'replay']) {
    assert.match(source, new RegExp(`setName\\('${sub}'\\)`), `/campaign ${sub} is missing`);
  }
});
