import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { commandDefs } from '../src/commands/index.js';

// The README is the one document a new reader trusts about what the bot does,
// and on 2026-09-27 it was still documenting subcommands that had moved to the
// dashboard months earlier (list, history, stats, npcs, locations) and a
// /dm character and /resume that no longer existed. Nothing checked it.
//
// This does, the same way env-example agreement is checked: every slash
// command the README names has to be one the bot registers.

const README = fileURLToPath(new URL('../../README.md', import.meta.url));
const readme = await readFile(README, 'utf8');

const campaign = commandDefs.find((d) => d.name === 'campaign');
const subcommands = new Set((campaign?.options ?? []).map((o) => o.name));
const topLevel = new Set(commandDefs.map((d) => d.name));

// Commands that used to exist and are the likeliest to creep back into prose.
const RETIRED = [
  'join', 'leave', 'correct', 'uncorrect', 'corrections', 'replay', 'approve', 'pause', 'resume',
  'pending', 'stats', 'npcs', 'locations', 'history', 'list', 'dm', 'setchar', 'whoami', 'recap',
  'funny', 'ask', 'search', 'export', 'archive', 'summarise', 'summarize', 'import', 'delete',
];

test('every /campaign subcommand the README names is registered', () => {
  const named = [...readme.matchAll(/\/campaign\s+([a-z]+)/g)].map((m) => m[1]);
  assert.ok(named.length > 10, 'the README should document the subcommands');
  const unknown = [...new Set(named)].filter((n) => !subcommands.has(n));
  assert.deepEqual(unknown, [], `the README names /campaign subcommands the bot does not have: ${unknown.join(', ')}`);
});

test('the README names no retired top-level command', () => {
  // A slash command in prose or code: "/word" at a word start, not part of a
  // path like /api/status or dash/app.
  const found = [...readme.matchAll(/(?<![\w/.:-])\/([a-z]+)\b(?![/.])/g)].map((m) => m[1]);
  const retired = [...new Set(found)].filter((n) => RETIRED.includes(n) && !topLevel.has(n));
  assert.deepEqual(retired, [], `the README still names retired commands: ${retired.map((n) => `/${n}`).join(', ')}`);
});

test('the subcommand list in the README covers every registered subcommand', () => {
  const missing = [...subcommands].filter((n) => !new RegExp(`\`${n}\\b`).test(readme));
  assert.deepEqual(missing, [], `registered but undocumented: ${missing.join(', ')}`);
});
