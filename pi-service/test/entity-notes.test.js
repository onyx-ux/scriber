import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/store/db.js';
import {
  buildEntityNotes,
  subjectNamed,
  SUBJECTS,
  sessionsToRead,
  updateEntityNotesForSession,
  entityCachePath,
  entityCachePathFor,
  SUBJECT_ORDER,
} from '../src/campaign/entity-notes.js';
import { LEDGER_SUBFOLDER as LEDGER } from '../src/export/naming.js';

// The run, which nothing used to test.
//
// mergeNpcs, renderNpcNote and reconcileAliases have carried hundreds of lines
// of tests for a while. The loop that CALLS them did not have one, because it
// lived three times over in top-level scripts that spend real money the moment
// you import them. Injecting the model is what makes this file possible: every
// test below drives a whole build — sessions, cache, merge, reconciliation,
// writing — without a network call.

const CAMPAIGN = 'Cipher';

async function world(t, { sessions = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'quill-entity-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const cfg = { obsidianExportDir: join(dir, 'vault'), dataDir: dir };

  const campaignId = db.createCampaign('guild-1', CAMPAIGN, 'dm-1');

  for (let n = 1; n <= sessions; n += 1) {
    const meeting = db.createMeeting({
      guildId: 'guild-1', campaignId, channelId: 'v', channelName: 'The Cellar',
      startedAt: `2026-0${n}-01T19:00:00Z`, audioDir: '/tmp',
    });
    db.finalizeTranscription(meeting, [
      { userId: 'p1', displayName: 'Saf', startMs: 0, endMs: 1, text: `Session ${n} happened.` },
    ]);
    db.endMeeting(meeting, `2026-0${n}-01T22:00:00Z`);
    // listCompletedMeetings wants a summary as well as a status: a session the
    // pipeline never finished is not one an extraction should read.
    db.setSummary(meeting, {
      tldr: `Session ${n}.`,
      scenes: [], npcsIntroduced: [], locationsVisited: [],
      partyDecisions: [], unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
    });
    db.setMeetingStatus(meeting, 'done');
  }

  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  return { db, cfg, dir, campaign: db.getCampaign(campaignId) };
}

// A model that answers with whatever JSON the test wants, and records what it
// was asked. Nothing here reaches the network.
function fakeModel(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (systemPrompt, userMessage) => {
    calls.push({ systemPrompt, userMessage });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : JSON.stringify(next);
  };
  fn.calls = calls;
  return fn;
}

const npcs = (...names) => ({ npcs: names.map((name) => ({ name })) });

const collect = () => {
  const events = [];
  const onEvent = (e) => events.push(e);
  onEvent.events = events;
  onEvent.ofType = (type) => events.filter((e) => e.type === type);
  onEvent.types = () => events.map((e) => e.type);
  return onEvent;
};

// ==========================================================================
// the subjects
// ==========================================================================

test('all three subjects describe the same shape', () => {
  for (const [name, subject] of Object.entries(SUBJECTS)) {
    assert.equal(subject.key, name, `${name} keys its per-session records on its own name`);
    for (const required of ['noun', 'folder', 'systemPrompt', 'userMessage', 'parse', 'merge', 'fileName', 'render', 'detail']) {
      assert.ok(subject[required], `${name} is missing ${required}`);
    }
  }
});

test('an unknown subject is refused rather than guessed at', () => {
  assert.throws(() => subjectNamed('monsters'), /unknown subject/);
  assert.equal(subjectNamed('npcs').folder, 'NPCs');
});

// ==========================================================================
// the run
// ==========================================================================

test('one model call per session, and the records merge across them', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 3 });
  const callModel = fakeModel([npcs('Meepo'), npcs('Meepo', 'Yusdrayl'), npcs('Yusdrayl')]);

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), callModel,
  });

  assert.equal(callModel.calls.length, 3, 'one call per session, not one per record');
  assert.deepEqual(result.records.map((r) => r.name).sort(), ['Meepo', 'Yusdrayl']);
  assert.deepEqual(result.records.find((r) => r.name === 'Meepo').sessions, [1, 2]);
});

// The dry run is the default, and it is not a way to avoid the spend — the
// model is called either way. It is a way to look before the vault is touched.
test('nothing is written unless the run was asked to write', async (t) => {
  const { db, cfg, campaign, dir } = await world(t);
  const callModel = fakeModel([npcs('Meepo'), npcs('Meepo')]);

  const dry = await buildEntityNotes({ db, cfg, campaign, subject: subjectNamed('npcs'), callModel });
  assert.equal(dry.written.length, 0);
  assert.deepEqual(await readdir(join(dir, 'vault')).catch(() => []), [], 'the vault was not touched');
  assert.equal(callModel.calls.length, 2, 'a dry run still costs the calls');
});

test('writing puts one note per record in the subject\'s own folder', async (t) => {
  const { db, cfg, campaign, dir } = await world(t);
  const callModel = fakeModel([npcs('Meepo', 'Yusdrayl'), npcs('Meepo')]);

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), callModel, write: true,
  });

  const written = await readdir(join(dir, 'vault', CAMPAIGN, 'NPCs'));
  assert.deepEqual(written.sort(), ['Meepo.md', 'Yusdrayl.md']);
  assert.equal(result.written.length, 2);

  const note = await readFile(join(dir, 'vault', CAMPAIGN, 'NPCs', 'Meepo.md'), 'utf8');
  assert.match(note, /name: "Meepo"/);
});

test('each subject writes to its own folder', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });

  await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), write: true,
    callModel: fakeModel([npcs('Meepo')]),
  });
  await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('locations'), write: true,
    callModel: fakeModel([{ locations: [{ name: 'The Vaults' }] }]),
  });

  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'NPCs')), ['Meepo.md']);
  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'Locations')), ['The Vaults.md']);
});

// ==========================================================================
// the divergences the three copies had grown
// ==========================================================================

// The location builder used to skip a transcript-less session with a bare
// `continue`, so a build that read four sessions out of six looked exactly like
// one that read six.
test('a session with no transcript is reported, not skipped silently', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 1 });
  const empty = db.createMeeting({
    guildId: 'guild-1', campaignId: campaign.id, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-09-01T19:00:00Z', audioDir: '/tmp',
  });
  db.endMeeting(empty, '2026-09-01T20:00:00Z');
  // Summarised and done, but with no utterances behind it — the shape a
  // recovered or imported session ends up in when the audio yielded nothing.
  db.setSummary(empty, {
    tldr: 'Nothing was captured.',
    scenes: [], npcsIntroduced: [], locationsVisited: [],
    partyDecisions: [], unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
  });
  db.setMeetingStatus(empty, 'done');

  const onEvent = collect();
  const callModel = fakeModel([npcs('Meepo')]);
  await buildEntityNotes({ db, cfg, campaign, subject: subjectNamed('locations'), callModel, onEvent });

  const skipped = onEvent.ofType('session-skipped');
  assert.equal(skipped.length, 1, 'the empty session said so');
  assert.equal(skipped[0].reason, 'no transcript');
  assert.equal(callModel.calls.length, 1, 'and cost nothing');
});

// Only the NPC builder used to show the first line of a response it could not
// parse. That is the difference between "no places this session" and "the
// prompt is broken".
test('an unparseable response reports what the model actually said', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 1 });
  const onEvent = collect();

  await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('locations'), onEvent,
    callModel: fakeModel(['I am afraid I cannot help with that request.']),
  });

  const [done] = onEvent.ofType('session-done');
  assert.equal(done.count, 0);
  assert.match(done.unparsed, /I am afraid I cannot help/);
});

// Only the location builder warned about this. The NPC build runs FIRST and
// writes the notes the other two link to, so it is the one where a silently
// skipped reconciliation does the most damage.
test('an empty ledger is announced for every subject, not just locations', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 1 });

  for (const subject of ['npcs', 'locations', 'characters']) {
    const onEvent = collect();
    await buildEntityNotes({
      db, cfg, campaign, subject: subjectNamed(subject), onEvent,
      extras: { roster: [{ player: 'Saf', character: 'Aurion' }] },
      callModel: fakeModel([{ [subject]: [] }]),
    });

    const [start] = onEvent.ofType('start');
    assert.equal(start.ledgerEmpty, true, `${subject} did not warn about the empty ledger`);
  }
});

// One session failing is not the run failing. A campaign is a dozen calls and
// losing all of them to one timeout is worse than a note missing a session.
test('a session whose model call fails does not take the run down', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 3 });
  const onEvent = collect();
  const callModel = fakeModel([npcs('Meepo'), new Error('504 upstream timeout'), npcs('Yusdrayl')]);

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), callModel, onEvent,
  });

  assert.deepEqual(result.records.map((r) => r.name).sort(), ['Meepo', 'Yusdrayl']);
  const [failed] = onEvent.ofType('session-failed');
  assert.equal(failed.sessionNumber, 2);
  assert.match(failed.message, /504/);
});

test('a campaign with no completed sessions refuses rather than writing an empty vault', async (t) => {
  const { db, cfg } = await world(t, { sessions: 0 });
  const campaign = db.getCampaign(db.createCampaign('guild-2', 'Fresh', 'dm-2'));

  await assert.rejects(
    () => buildEntityNotes({ db, cfg, campaign, subject: subjectNamed('npcs'), callModel: fakeModel([]) }),
    /no completed sessions/
  );
});

// ==========================================================================
// the cache
// ==========================================================================

test('a cached extraction rebuilds the notes without calling the model', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 2 });
  const cachePath = join(dir, 'npcs.json');

  const first = fakeModel([npcs('Meepo'), npcs('Meepo', 'Yusdrayl')]);
  const before = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), callModel: first, cachePath,
  });
  assert.equal(first.calls.length, 2);

  const second = fakeModel([]);
  const onEvent = collect();
  const after = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), callModel: second, cachePath, onEvent,
  });

  assert.equal(second.calls.length, 0, 'the replay spent nothing');
  assert.equal(onEvent.ofType('cache-hit').length, 1);
  assert.deepEqual(
    after.records.map((r) => r.name).sort(),
    before.records.map((r) => r.name).sort(),
    'and produced the same records'
  );
});

// ==========================================================================
// reconciliation, and the subject that deliberately skips it
// ==========================================================================

test('a spelling the vault already links is carried onto the record it matches', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });

  // The ledger is what the session recaps already link to.
  await mkdir(join(dir, 'vault', CAMPAIGN, LEDGER), { recursive: true });
  await writeFile(join(dir, 'vault', CAMPAIGN, LEDGER, 'NPCs.md'), '# NPCs\n\n- [[Kerowyn]] — a merchant\n', 'utf8');

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'),
    callModel: fakeModel([npcs('Kerowyn Hucrele')]),
  });

  const [record] = result.records;
  assert.equal(record.name, 'Kerowyn Hucrele');
  assert.ok(record.aliases.includes('Kerowyn'), 'the spelling the vault links is kept as an alias');
  assert.deepEqual(result.unresolved, []);
});

test('a spelling that matches nothing is reported rather than dropped', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });
  await mkdir(join(dir, 'vault', CAMPAIGN, LEDGER), { recursive: true });
  await writeFile(join(dir, 'vault', CAMPAIGN, LEDGER, 'NPCs.md'), '# NPCs\n\n- [[Belak]] — a druid\n', 'utf8');

  const onEvent = collect();
  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), onEvent,
    callModel: fakeModel([npcs('Meepo')]),
  });

  assert.deepEqual(result.unresolved, ['Belak']);
  assert.equal(onEvent.ofType('unresolved').length, 1);
});

// A player character is keyed on the roster, which is a fact somebody typed,
// and that beats a fuzzy match every time.
test('characters do not reconcile aliases — the roster settles it', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 1 });
  const roster = [{ player: 'Brett', character: 'BenTen' }];

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('characters'), extras: { roster },
    callModel: fakeModel([{ characters: [{ name: 'Ben Ten', player: 'Brett' }] }]),
  });

  assert.equal(subjectNamed('characters').reconcile, null);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.records[0].name, 'BenTen', 'the roster name wins over the model\'s reading');
  assert.ok(result.records[0].aliases.includes('Brett'));
});

test('a player the transcripts never mention is named as missing', async (t) => {
  const { db, cfg, campaign } = await world(t, { sessions: 1 });
  const roster = [{ player: 'Brett', character: 'BenTen' }, { player: 'Priya', character: 'Aurion' }];
  const onEvent = collect();

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('characters'), extras: { roster }, onEvent,
    callModel: fakeModel([{ characters: [{ name: 'BenTen', player: 'Brett' }] }]),
  });

  assert.deepEqual(result.missing, ['Priya']);
  assert.equal(onEvent.ofType('missing').length, 1);
});

// ==========================================================================
// the things a subject declares about its neighbours
// ==========================================================================

// A place's note names who lives there, and those link to real pages only if
// the NPC notes already exist. This was a line in one script; it is a property
// of the locations subject.
test('a locations build links to the NPC notes a previous build wrote', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });

  await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), write: true,
    callModel: fakeModel([npcs('Meepo')]),
  });

  await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('locations'), write: true,
    callModel: fakeModel([{ locations: [{ name: 'The Vaults', inhabitants: ['Meepo'] }] }]),
  });

  const note = await readFile(join(dir, 'vault', CAMPAIGN, 'Locations', 'The Vaults.md'), 'utf8');
  assert.match(note, /\[\[Meepo\]\]/, 'the inhabitant links to the note that exists');
});

// ==========================================================================
// session ordering
// ==========================================================================

// Ordered on the session number rather than the row id: a note records which
// sessions someone appeared in, and an imported recording can be filed under an
// earlier number than a row inserted after it.
test('sessions are read oldest-first by session number', async (t) => {
  const { db, campaign } = await world(t, { sessions: 3 });
  const numbers = sessionsToRead(db, campaign.id).map((m) => m.session_number ?? m.id);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
});

// Only reachable for characters, and that is worth knowing. mergeNpcs and
// mergeLocations key on the name, and every name npcFileName rejects also keys
// to nothing, so those two drop it before the write loop ever sees it.
// mergeCharacters keys on the PLAYER, so a character the model named "???"
// survives the merge and reaches the filename.
test('a name that cannot become a filename is reported and skipped, not written', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });
  const onEvent = collect();
  const roster = [{ player: 'Brett', character: null }, { player: 'Saf', character: 'Aurion' }];

  await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('characters'), write: true, onEvent, extras: { roster },
    callModel: fakeModel([
      { characters: [{ name: '???', player: 'Brett' }, { name: 'Aurion', player: 'Saf' }] },
    ]),
  });

  assert.equal(onEvent.ofType('unusable-name').length, 1, 'the unusable name said so');
  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'Characters')), ['Aurion.md']);
});

// The other two subjects never get that far, which is the guard working one
// layer earlier rather than the guard being absent.
test('a nameless record is dropped by the merge before it can reach a filename', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });
  const onEvent = collect();

  const result = await buildEntityNotes({
    db, cfg, campaign, subject: subjectNamed('npcs'), write: true, onEvent,
    callModel: fakeModel([npcs('???', 'Meepo')]),
  });

  assert.deepEqual(result.records.map((r) => r.name), ['Meepo']);
  assert.equal(onEvent.ofType('unusable-name').length, 0);
  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'NPCs')), ['Meepo.md']);
});

// ==========================================================================
// the second caller: one session at a time, from the pipeline
// ==========================================================================

// The cost that makes an automatic update viable at all. Before the cache was
// keyed by session, adding session 12 meant re-reading sessions 1 to 11 — so
// the pipeline would have spent O(n²) calls over a campaign's life.
test('an incremental update reads only the session it was given', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 3 });
  const cachePath = join(dir, 'npcs.json');
  const subject = subjectNamed('npcs');

  const first = fakeModel([npcs('Meepo'), npcs('Meepo'), npcs('Yusdrayl')]);
  await buildEntityNotes({ db, cfg, campaign, subject, callModel: first, cachePath, write: true });
  assert.equal(first.calls.length, 3, 'the first full build read every session');

  // A fourth session lands.
  const fourth = db.createMeeting({
    guildId: 'guild-1', campaignId: campaign.id, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-04-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(fourth, [
    { userId: 'p1', displayName: 'Saf', startMs: 0, endMs: 1, text: 'Belak appears.' },
  ]);
  db.endMeeting(fourth, '2026-04-01T22:00:00Z');
  db.setSummary(fourth, {
    tldr: 'Session 4.', scenes: [], npcsIntroduced: [], locationsVisited: [],
    partyDecisions: [], unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
  });
  db.setMeetingStatus(fourth, 'done');
  const sessionNumber = db.getMeeting(fourth).session_number ?? fourth;

  const incremental = fakeModel([npcs('Belak')]);
  const result = await buildEntityNotes({
    db, cfg, campaign, subject, callModel: incremental, cachePath, write: true,
    onlySessions: [sessionNumber],
  });

  assert.equal(incremental.calls.length, 1, 'one transcript read, not four');
  assert.deepEqual(
    result.records.map((r) => r.name).sort(),
    ['Belak', 'Meepo', 'Yusdrayl'],
    'and the earlier sessions still contribute, from the cache'
  );
  assert.deepEqual(
    (await readdir(join(dir, 'vault', CAMPAIGN, 'NPCs'))).sort(),
    ['Belak.md', 'Meepo.md', 'Yusdrayl.md']
  );
});

// A run that died partway used to cost the whole thing again.
test('a run resumes from what the cache already holds', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 3 });
  const cachePath = join(dir, 'npcs.json');
  const subject = subjectNamed('npcs');

  const died = fakeModel([npcs('Meepo'), npcs('Yusdrayl'), new Error('504 upstream timeout')]);
  await buildEntityNotes({ db, cfg, campaign, subject, callModel: died, cachePath });

  const resumed = fakeModel([npcs('Belak')]);
  const result = await buildEntityNotes({ db, cfg, campaign, subject, callModel: resumed, cachePath });

  assert.equal(resumed.calls.length, 1, 'only the session that failed was read again');
  assert.deepEqual(result.records.map((r) => r.name).sort(), ['Belak', 'Meepo', 'Yusdrayl']);
});

test('a cached session that no longer exists stops contributing', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 2 });
  const cachePath = join(dir, 'npcs.json');
  const subject = subjectNamed('npcs');

  await writeFile(
    cachePath,
    JSON.stringify([
      { sessionNumber: 1, npcs: [{ name: 'Meepo' }] },
      { sessionNumber: 2, npcs: [{ name: 'Yusdrayl' }] },
      { sessionNumber: 99, npcs: [{ name: 'A Ghost Of A Discarded Session' }] },
    ]),
    'utf8'
  );

  const result = await buildEntityNotes({ db, cfg, campaign, subject, callModel: fakeModel([]), cachePath });
  assert.deepEqual(result.records.map((r) => r.name).sort(), ['Meepo', 'Yusdrayl']);
});

test('the pipeline update runs every subject, in the order their links need', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });
  db.forTests.addCampaignMember(campaign.id, 'p1', 'Saf');
  db.setCharacterName(campaign.id, 'p1', 'Aurion');

  // One answer that satisfies all three parsers, so the test is about the run
  // visiting every subject rather than about any one prompt.
  const callModel = async () =>
    JSON.stringify({ npcs: [{ name: 'Meepo' }], locations: [{ name: 'The Vaults' }], characters: [] });

  await updateEntityNotesForSession({ db, cfg, campaign, sessionNumber: 1, callModel });

  assert.deepEqual(SUBJECT_ORDER, ['npcs', 'locations', 'characters'], 'NPCs first — the others link to them');
  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'NPCs')), ['Meepo.md']);
  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'Locations')), ['The Vaults.md']);
});

// Best-effort, like the archive-page regeneration next to it. A session that
// was transcribed, summarised and posted is a finished session.
test('a subject that throws does not stop the others or the caller', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 1 });
  const events = [];

  let call = 0;
  const callModel = async () => {
    call += 1;
    if (call === 1) throw new Error('the model refused');
    return JSON.stringify({ locations: [{ name: 'The Vaults' }], characters: [] });
  };

  await updateEntityNotesForSession({
    db, cfg, campaign, sessionNumber: 1, callModel, onEvent: (e) => events.push(e),
  });

  assert.deepEqual(await readdir(join(dir, 'vault', CAMPAIGN, 'Locations')), ['The Vaults.md']);
  assert.ok(
    events.some((e) => e.type === 'session-failed'),
    'the failure was reported rather than swallowed'
  );
});

test('the extraction cache lives inside the vault, out of Obsidian\'s way', async (t) => {
  const { cfg } = await world(t, { sessions: 1 });
  const path = entityCachePath(cfg, 'Cipher', subjectNamed('npcs'));

  assert.match(path, /Cipher/);
  assert.match(path, /\.entity-cache/, 'dot-prefixed so Obsidian ignores it');
  assert.match(path, /npcs\.json$/);
});

// The trap the .env.example walks you straight into.
//
// The three CLI builders were documented without --cache, so a hand-built
// vault had no cached extraction behind it. Turn ENTITY_NOTES_AFTER_SESSION on
// after that and the first session to finish rebuilt every note it touched
// from that ONE session -- Meepo.md went from `sessions: [1, 2, 3]` to
// `sessions: [4]`, and the cache was then overwritten with only session 4, so
// the history could not be recovered without paying for every transcript
// again.
//
// An incremental run has no way to know what the notes on disk already say. So
// with nothing cached to merge against, it must not write over them.
test('an incremental update with nothing cached behind it refuses to rewrite the notes', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 3 });
  const subject = subjectNamed('npcs');
  const notePath = join(dir, 'vault', CAMPAIGN, 'NPCs', 'Meepo.md');

  // A hand-built vault: every session read, notes written, no cache kept.
  await buildEntityNotes({
    db, cfg, campaign, subject, write: true,
    callModel: fakeModel([npcs('Meepo'), npcs('Meepo'), npcs('Meepo')]),
  });
  assert.match(await readFile(notePath, 'utf8'), /sessions: \[1, 2, 3\]/);

  // A fourth session finishes and the pipeline updates incrementally.
  const fourth = db.createMeeting({
    guildId: 'guild-1', campaignId: campaign.id, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-04-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(fourth, [
    { userId: 'p1', displayName: 'Saf', startMs: 0, endMs: 1, text: 'Meepo again.' },
  ]);
  db.endMeeting(fourth, '2026-04-01T22:00:00Z');
  db.setSummary(fourth, {
    tldr: 'Session 4.', scenes: [], npcsIntroduced: [], locationsVisited: [],
    partyDecisions: [], unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
  });
  db.setMeetingStatus(fourth, 'done');

  const onEvent = collect();
  const callModel = fakeModel([npcs('Meepo')]);
  const result = await buildEntityNotes({
    db, cfg, campaign, subject, write: true, onEvent, callModel,
    cachePath: join(dir, 'never-written.json'),
    onlySessions: [db.getMeeting(fourth).session_number ?? fourth],
  });

  assert.equal(callModel.calls.length, 0, 'and refused before spending anything');

  assert.match(
    await readFile(notePath, 'utf8'),
    /sessions: \[1, 2, 3\]/,
    'the note built from the whole campaign survived'
  );
  assert.deepEqual(result.written, [], 'and the run wrote nothing');

  const [refused] = onEvent.ofType('incremental-refused');
  assert.ok(refused, 'the run said why it wrote nothing');
  assert.deepEqual(refused.uncovered, [1, 2, 3], 'naming the sessions it had no record of');
});

// The same refusal, for the reason that is harder to notice: a cache file that
// is present but unreadable. readCache swallows the parse error and answers
// null, which is indistinguishable from "first run" -- so a corrupt cache used
// to destroy the notes exactly as a missing one did.
test('an unreadable cache is refused rather than treated as a first run', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 2 });
  const subject = subjectNamed('npcs');
  const cachePath = join(dir, 'npcs.json');

  await buildEntityNotes({
    db, cfg, campaign, subject, write: true, cachePath,
    callModel: fakeModel([npcs('Meepo'), npcs('Meepo')]),
  });
  await writeFile(cachePath, '{ this was truncated mid-write', 'utf8');

  const onEvent = collect();
  const result = await buildEntityNotes({
    db, cfg, campaign, subject, write: true, cachePath, onEvent,
    onlySessions: [2],
    callModel: fakeModel([npcs('Meepo')]),
  });

  assert.deepEqual(result.written, []);
  assert.equal(onEvent.ofType('incremental-refused').length, 1);
  assert.match(
    await readFile(join(dir, 'vault', CAMPAIGN, 'NPCs', 'Meepo.md'), 'utf8'),
    /sessions: \[1, 2\]/
  );
});

// The other half of the same fix.
//
// Refusing to write is only right if there is a way to stop it happening, and
// there was not: the pipeline cached to <vault>/<campaign>/.entity-cache/ while
// the CLI cached to wherever --cache pointed, which was nowhere by default. The
// two paths could only agree if somebody typed the pipeline's path by hand.
//
// So both sides now ask the same function where a campaign's cache lives, and
// one full build by hand is all it takes for the automatic updates to work.
test('a build by hand leaves the cache the pipeline picks up', async (t) => {
  const { db, cfg, campaign, dir } = await world(t, { sessions: 3 });
  const subject = subjectNamed('npcs');
  const notePath = join(dir, 'vault', CAMPAIGN, 'NPCs', 'Meepo.md');

  // What the CLI does with no --cache given.
  await buildEntityNotes({
    db, cfg, campaign, subject, write: true,
    cachePath: entityCachePathFor(db, cfg, campaign, subject),
    callModel: fakeModel([npcs('Meepo'), npcs('Meepo'), npcs('Meepo')]),
  });
  assert.match(await readFile(notePath, 'utf8'), /sessions: \[1, 2, 3\]/);

  // And then a session finishes with ENTITY_NOTES_AFTER_SESSION on.
  const fourth = db.createMeeting({
    guildId: 'guild-1', campaignId: campaign.id, channelId: 'v', channelName: 'The Cellar',
    startedAt: '2026-04-01T19:00:00Z', audioDir: '/tmp',
  });
  db.finalizeTranscription(fourth, [
    { userId: 'p1', displayName: 'Saf', startMs: 0, endMs: 1, text: 'Meepo returns.' },
  ]);
  db.endMeeting(fourth, '2026-04-01T22:00:00Z');
  db.setSummary(fourth, {
    tldr: 'Session 4.', scenes: [], npcsIntroduced: [], locationsVisited: [],
    partyDecisions: [], unresolvedThreads: [], followUps: [], lootAndRewards: [], funnyMoments: [],
  });
  db.setMeetingStatus(fourth, 'done');

  const onEvent = collect();
  await updateEntityNotesForSession({
    db, cfg, campaign, subjects: ['npcs'], onEvent,
    sessionNumber: db.getMeeting(fourth).session_number ?? fourth,
    callModel: fakeModel([npcs('Meepo')]),
  });

  assert.deepEqual(onEvent.ofType('incremental-refused'), [], 'the pipeline found the cache');
  assert.match(
    await readFile(notePath, 'utf8'),
    /sessions: \[1, 2, 3, 4\]/,
    'and added the new session to the history rather than replacing it'
  );
});
