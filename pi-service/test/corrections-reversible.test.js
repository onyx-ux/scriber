import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import { runAction } from '../src/web/actions.js';
import { buildNotesView, correctedWriteUp } from '../src/web/notes-view.js';

// A name correction used to overwrite the stored transcript. Removing the rule
// afterwards changed nothing, because there was no telling which words had
// been changed, and write-ups kept the wrong name until somebody paid to
// re-summarise them.
//
// Now every line keeps what the transcriber heard in raw_text, the corrected
// reading is worked out from that, and write-ups are corrected as they are
// read. Taking a rule away puts every line it changed back.

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-reversible-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = { summaryProvider: 'gemini', geminiApiKey: 'k' };
  const campaignId = db.createCampaign('guild-1', 'Cipher', 'dm-1');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = (lines, rawLines = null) => {
    const meetingId = db.createMeeting({
      guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'Voice',
      startedAt: '2026-09-01T19:00:00Z', audioDir: '/tmp',
    });
    db.finalizeTranscription(
      meetingId,
      lines.map((text, i) => ({
        userId: 'u', displayName: 'A', startMs: i, endMs: i + 1, text, rawText: rawLines?.[i] ?? text,
      }))
    );
    return meetingId;
  };
  const act = (name, body) => runAction({ pathname: `/actions/${name}`, body: { campaignId, ...body }, db, cfg }).payload;
  return { db, campaignId, session, act };
}

test('a transcript keeps what the transcriber heard underneath the correction', async (t) => {
  const { db, session } = await harness(t);
  const meetingId = session(['Kaelen opens the door'], ['Kaylen opens the door']);

  const row = db.raw.prepare(`SELECT text, raw_text FROM utterances WHERE meeting_id = ?`).get(meetingId);
  assert.equal(row.text, 'Kaelen opens the door');
  assert.equal(row.raw_text, 'Kaylen opens the door');
});

test('removing a correction puts back every line it changed', async (t) => {
  const { db, session, act } = await harness(t);
  const meetingId = session(['Vecks opens it', 'nothing here']);

  assert.equal(act('corrections/add', { wrong: 'Vecks', right: 'Vex' }).changed, 1);
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vex opens it');

  const res = act('corrections/remove', { wrong: 'Vecks' });
  assert.equal(res.ok, true);
  assert.equal(res.restored, 1);
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vecks opens it');
});

test('removing one rule leaves the others applied', async (t) => {
  const { db, session, act } = await harness(t);
  const meetingId = session(['Vecks and Kaylen argue']);
  act('corrections/add', { wrong: 'Vecks', right: 'Vex' });
  act('corrections/add', { wrong: 'Kaylen', right: 'Kaelen' });
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vex and Kaelen argue');

  act('corrections/remove', { wrong: 'Kaylen' });
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vex and Kaylen argue');
});

// Lines rewritten before raw_text existed have nothing underneath them. The
// honest thing is to keep them as they are, and to start keeping the original
// from the first correction applied after this change.
test('a line rewritten before this change keeps its fix when the rule goes', async (t) => {
  const { db, campaignId, session, act } = await harness(t);
  const meetingId = session(['Vex opens it']);
  db.raw.prepare(`UPDATE utterances SET raw_text = NULL WHERE meeting_id = ?`).run(meetingId);
  db.addCorrection(campaignId, 'Vecks', 'Vex');

  act('corrections/remove', { wrong: 'Vecks' });
  assert.equal(db.listUtterances(meetingId)[0].text, 'Vex opens it');
});

test('a new transcript picks up the saved rules and remembers what was heard', async (t) => {
  const { db, session, act } = await harness(t);
  act('corrections/add', { wrong: 'Vecks', right: 'Vex' });

  const later = session(['Vecks is back']);
  act('corrections/replay', {});
  assert.equal(db.listUtterances(later)[0].text, 'Vex is back');

  act('corrections/remove', { wrong: 'Vecks' });
  assert.equal(db.listUtterances(later)[0].text, 'Vecks is back');
});

// --- write-ups --------------------------------------------------------------

function writeUp(db, campaignId) {
  const meetingId = db.createMeeting({
    guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'Voice',
    startedAt: '2026-09-01T19:00:00Z', audioDir: '/tmp',
  });
  db.setSummary(meetingId, {
    tldr: 'Kaylen found the door.',
    scenes: [{ title: 'Kaylen at the gate', points: ['Kaylen paid in favours.'] }],
    partyDecisions: ['Trust Kaylen.'],
  });
  return meetingId;
}

test('a correction reaches a write-up written before it, without touching it', async (t) => {
  const { db, campaignId, act } = await harness(t);
  const meetingId = writeUp(db, campaignId);
  act('corrections/add', { wrong: 'Kaylen', right: 'Kaelen' });

  const view = buildNotesView({ db, meetingId });
  assert.equal(view.tldr, 'Kaelen found the door.');
  assert.equal(view.scenes[0].title, 'Kaelen at the gate');
  assert.deepEqual(view.scenes[0].points, ['Kaelen paid in favours.']);
  assert.deepEqual(view.partyDecisions, ['Trust Kaelen.']);
  assert.equal(correctedWriteUp(db, meetingId).tldr, 'Kaelen found the door.', '/recap and the export read the same');

  assert.match(db.getMeeting(meetingId).summary_json, /Kaylen found the door/, 'the stored write-up is not rewritten');

  act('corrections/remove', { wrong: 'Kaylen' });
  assert.equal(buildNotesView({ db, meetingId }).tldr, 'Kaylen found the door.');
});

// A table's redline is anchored to the summariser's own line. Applying a name
// correction to that line must not orphan somebody's correction of it.
test('a redline written before a name correction stays on its line', async (t) => {
  const { db, campaignId, act } = await harness(t);
  const meetingId = writeUp(db, campaignId);
  const viewer = { userId: 'saf', can: { manage: false, everything: false }, manageableCampaignIds: [] };
  db.addCampaignMember?.(campaignId, 'saf');

  runAction({
    pathname: '/actions/recap/note',
    body: { campaignId, meetingId, part: 'tldr', index: 0, body: 'Kaylen found the back door.' },
    db, cfg: {}, ctx: { viewer },
  });
  act('corrections/add', { wrong: 'Kaylen', right: 'Kaelen' });

  const view = buildNotesView({ db, meetingId });
  assert.deepEqual(view.orphaned, []);
  assert.equal(view.tldr, 'Kaelen found the back door.', 'the redline reads through, with the name fixed');
  const tldr = view.marks.find((p) => p.part === 'tldr').lines[0];
  assert.equal(tldr.base, 'Kaelen found the door.');
  assert.equal(tldr.struck, true);
});
