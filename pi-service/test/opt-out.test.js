import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { createCampaign } from '../src/campaign/create.js';
import { canOptOut, readsAsNoOptOut } from '../src/campaign/opt-out.js';
import { stopRecording, resumeRecording } from '../src/campaign/withdrawal.js';
import { describeUnrecorded } from '../src/campaign/consent.js';
import { createDiscordBridge } from '../src/web/discord-bridge.js';

// Whether a player may choose not to be recorded is asked once, of whoever
// makes the campaign. These are the rules that answer has to hold to — and the
// first of them is that a campaign nobody answered it for behaves exactly as
// every campaign did before the question existed.

const DM = '30000000000000003';
const RHI = '50000000000000005';

async function table(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-optout-'));
  const db = openDb(join(dir, 'db.sqlite'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return db;
}

// A Discord that remembers every DM it was asked to send.
function discord(db) {
  const sent = [];
  const client = {
    users: {
      fetch: async (id) => ({
        id, username: 'rhi', bot: false,
        createDM: async () => ({ send: async (message) => { sent.push({ to: id, message }); return {}; } }),
      }),
    },
  };
  return { sent, bridge: createDiscordBridge({ client, db, cfg: { audioRetentionDays: 14 } }) };
}

test('a campaign made without saying is one where players may opt out', async (t) => {
  const db = await table(t);
  const made = createCampaign({ db, cfg: {}, guildId: 'g', userId: DM, name: 'Cipher' });

  assert.equal(made.optOut, true);
  assert.equal(canOptOut(db.getCampaign(made.id)), true);
  assert.equal(db.mayRecord(made.id, DM), false, 'and nobody is recorded for having made it');
});

test('only an explicit no turns the opt-out off', () => {
  for (const v of [false, 'no', 'false', 0, '0']) assert.equal(readsAsNoOptOut(v), true, String(v));
  for (const v of [undefined, null, '', 'yes', true, 'nope', 1]) assert.equal(readsAsNoOptOut(v), false, String(v));
  assert.equal(canOptOut({}), true, 'and a campaign from before the column is an ordinary one');
});

test('with the opt-out on, inviting somebody asks them and records nothing', async (t) => {
  const db = await table(t);
  const { id } = createCampaign({ db, cfg: {}, guildId: 'g', userId: DM, name: 'Cipher' });
  const { sent, bridge } = discord(db);

  const said = await bridge.invite({ campaignId: id, userId: RHI, inviterName: 'kez' });
  assert.equal(said.ok, true);
  assert.equal(sent.length, 1, 'one DM, with the question in it');
  assert.equal(db.getConsent(id, RHI).state, 'pending');
  assert.equal(db.mayRecord(id, RHI), false, 'silence is still not agreement');
});

test('with it off, inviting somebody records them and sends them nothing', async (t) => {
  const db = await table(t);
  const { id } = createCampaign({ db, cfg: {}, guildId: 'g', userId: DM, name: 'Cipher', optOut: false });
  const { sent, bridge } = discord(db);

  assert.equal(db.mayRecord(id, DM), true, 'whoever answered for the table is at it');

  const said = await bridge.invite({ campaignId: id, userId: RHI, characterName: 'Marn', inviterName: 'kez' });
  assert.equal(said.ok, true);
  assert.equal(said.added, true);
  assert.match(said.message, /telling them the game is recorded is yours to do/);
  assert.deepEqual(sent, [], 'no outbound correspondence');
  assert.equal(db.mayRecord(id, RHI), true);
  assert.equal(db.getCharacterName(id, RHI), 'Marn');
});

test('with it off, somebody nobody added is still not recorded', async (t) => {
  const db = await table(t);
  const { id } = createCampaign({ db, cfg: {}, guildId: 'g', userId: DM, name: 'Cipher', optOut: false });

  // The capture path asks mayRecord and nothing else, and the switch does not
  // reach it: a stranger in the voice channel is skipped here as anywhere.
  assert.equal(db.mayRecord(id, RHI), false);
  assert.match(describeUnrecorded({ unasked: ['rhi'] }, { optOut: false }), /not on this campaign's roster/);
  assert.doesNotMatch(describeUnrecorded({ unasked: ['rhi'] }, { optOut: false }), /agreed|consent/);
});

test('with it off, there is no stopping it for yourself', async (t) => {
  const db = await table(t);
  const { id } = createCampaign({ db, cfg: {}, guildId: 'g', userId: DM, name: 'Cipher', optOut: false });
  db.setConsent(id, RHI, true);

  const refused = stopRecording(db, { campaignId: id, userId: RHI });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /records everyone at the table/);
  assert.match(refused.message, /\/campaign remove/, 'and it says who can');
  assert.equal(db.mayRecord(id, RHI), true, 'nothing changed');

  // The same call at an ordinary table, so this is the switch and not a fault.
  const other = createCampaign({ db, cfg: {}, guildId: 'g', userId: DM, name: 'Other' });
  db.setConsent(other.id, RHI, true);
  assert.equal(stopRecording(db, { campaignId: other.id, userId: RHI }).ok, true);
  assert.equal(db.mayRecord(other.id, RHI), false);
  assert.equal(resumeRecording(db, { campaignId: other.id, userId: RHI }).ok, true);
});
