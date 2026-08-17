import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { buildViewer } from '../src/web/viewer.js';

// The same person, asking the same question, two different ways.
//
// Quill has two front doors — slash commands and a dashboard — and each grew
// its own idea of who may do what. Discord sorts by RESOLVER (which campaigns a
// command can even find for you); the dashboard sorts by LEVEL (what your
// Discord account owns, runs and plays in). Nothing forced them to agree, and
// where they disagreed it was by accident rather than on purpose.
//
// This file is the map between them, written down so it cannot drift quietly.
// Every row is a claim about both surfaces at once, so moving a command between
// tiers on one side fails here until somebody has decided what it means on the
// other.

// Discord tier -> the dashboard level that can do the equivalent thing.
//
// `null` means the command has no dashboard equivalent at all, which is a fine
// answer — /join has to be run from inside the voice channel, and no web page
// can be.
const EQUIVALENT = {
  player: 'player',   // reads scoped to campaigns you have played in
  member: 'player',   // acts on you, at a table you are at
  manager: 'creator', // reshapes a campaign — whoever runs it
};

// Every subcommand, its Discord tier, and what the dashboard calls the same
// authority. Kept exhaustive on purpose: a new subcommand fails the last test
// in this file until it is listed, which is the only way a map like this stays
// true.
const COMMANDS = {
  create: { tier: 'open', dashboard: null, why: 'an unclaimed campaign has to be claimable by somebody' },
  list: { tier: 'open', dashboard: 'player', why: 'seeing what is here is not a privilege' },

  rename: { tier: 'manager', dashboard: null, why: 'Discord only — no dashboard control exists' },
  invite: { tier: 'manager', dashboard: 'creator', why: 'roster/invite' },
  remove: { tier: 'manager', dashboard: null, why: 'Discord only' },
  output: { tier: 'manager', dashboard: 'creator', why: 'campaign/output' },

  setchar: { tier: 'member', dashboard: 'player', why: 'roster/character, on yourself' },
  whoami: { tier: 'member', dashboard: null, why: 'the dashboard shows this without asking' },
  consent: { tier: 'player', dashboard: null, why: 'deliberately Discord-only — see below' },

  recap: { tier: 'player', dashboard: 'player', why: 'the notes reader' },
  funny: { tier: 'player', dashboard: 'player', why: 'the notes reader' },
  history: { tier: 'player', dashboard: 'player', why: 'the session list' },
  npcs: { tier: 'player', dashboard: 'player', why: 'the facts rail' },
  locations: { tier: 'player', dashboard: 'player', why: 'the facts rail' },
  archive: { tier: 'player', dashboard: 'player', why: 'the exported site' },

  // The four that do NOT line up, each for a stated reason rather than an
  // oversight. Listed here so the disagreement is a decision on the record.
  stats: {
    tier: 'player',
    dashboard: 'owner',
    aligned: false,
    why: 'hours and line counts are capacity numbers; the dashboard keeps them for whoever runs the server',
  },
  search: {
    tier: 'player',
    dashboard: 'creator',
    aligned: false,
    why: 'searching returns transcript lines, and the dashboard gives players notes rather than the verbatim record',
  },
  export: {
    tier: 'player',
    dashboard: 'creator',
    aligned: false,
    why: 'attaches a full transcript in Discord — same mismatch as search',
  },
  ask: {
    tier: 'player',
    dashboard: 'dev',
    aligned: false,
    why: 'every invocation spends the owner\'s API budget, which the dashboard treats as the owner\'s alone',
  },
};

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-align-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// --- the map is complete ---

test('every /campaign subcommand appears in the alignment map', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.DISCORD_CLIENT_ID ||= 'x';
  process.env.GEMINI_API_KEY ||= 'x';
  const { commandDefs } = await import('../src/commands/index.js');

  const subs = commandDefs
    .find((c) => c.name === 'campaign')
    .options.filter((o) => o.type === 1)
    .map((o) => o.name);

  const missing = subs.filter((s) => !COMMANDS[s]);
  const stale = Object.keys(COMMANDS).filter((s) => !subs.includes(s));

  assert.deepEqual(missing, [], 'a new subcommand needs a decision about the dashboard, not a default');
  assert.deepEqual(stale, [], 'a removed subcommand should leave this map');
});

test('the Discord tiers in the map are the tiers the code actually uses', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.DISCORD_CLIENT_ID ||= 'x';
  process.env.GEMINI_API_KEY ||= 'x';
  const { MANAGER_SUBCOMMANDS } = await import('../src/commands/index.js');

  const claimed = Object.entries(COMMANDS).filter(([, v]) => v.tier === 'manager').map(([k]) => k).sort();
  assert.deepEqual(claimed, [...MANAGER_SUBCOMMANDS].sort());
});

// --- where they agree, they agree for a reason ---

test('every aligned command maps to the level the dashboard grants', () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (spec.aligned === false || spec.dashboard === null || spec.tier === 'open') continue;
    assert.equal(
      EQUIVALENT[spec.tier],
      spec.dashboard,
      `${name}: Discord tier "${spec.tier}" and dashboard level "${spec.dashboard}" have drifted`
    );
  }
});

// Each deliberate mismatch has to say why. An `aligned: false` with no reason
// is an oversight wearing a decision's clothes.
test('every deliberate mismatch carries its reason', () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (spec.aligned !== false) continue;
    assert.ok(spec.why && spec.why.length > 30, `${name} is marked misaligned without saying why`);
  }
});

// --- and the levels behave as the map claims ---

test('a player can reach a player-level thing and not a creator-level one', async (t) => {
  const db = await harness(t);
  const cid = db.createCampaign('guild-1', 'Cipher', 'someone-else');
  const meeting = db.createMeeting({
    guildId: 'guild-1', campaignId: cid, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-08-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(meeting, [
    { userId: 'player-1', displayName: 'Saf', startMs: 0, endMs: 1, text: 'hi' },
  ]);

  const viewer = buildViewer({ db, cfg: { ownerUserId: 'dev' }, userId: 'player-1' });
  assert.equal(viewer.level, 'player');
  assert.equal(viewer.campaignIds.includes(cid), true, 'a player-level read reaches their own table');
  assert.equal(viewer.manageableCampaignIds.includes(cid), false, 'a creator-level write does not');
});

// /campaign consent is deliberately Discord-only and must stay that way: the
// dashboard is a place the person recording you can see, and a withdrawal
// screen that lives there is a withdrawal screen somebody can watch you use.
test('consent has no dashboard equivalent, on purpose', () => {
  assert.equal(COMMANDS.consent.dashboard, null);
});
