// Building the vault's per-entity notes: one run, three subjects.
//
// The NPCs, the places and the party each get one Obsidian note per name, read
// from the FULL session transcripts rather than the per-session summaries. What
// differs between them is the prompt, how records merge across sessions, and
// how a note reads. What does NOT differ is everything else — find the
// completed sessions, call the model once per session, cache the raw
// extraction, merge, reconcile against the spellings the vault already links,
// report what was found, write the files.
//
// That "everything else" used to be written three times, in three top-level
// scripts with no tests, while the parts it called carried several hundred
// lines of them. The bugs were all in the copies:
//
//   * the NPC builder printed a reason when a session was skipped and showed
//     the first line of anything it could not parse; the location builder
//     skipped silently with a bare `continue`.
//   * only the location builder warned that an absent ledger means alias
//     reconciliation is silently skipped — the failure its own comment records
//     as "how [[Kerowyn]] nearly got orphaned". The NPC builder runs FIRST and
//     writes the notes the other two link to, and had no such warning.
//
// So the run lives here, once, and a subject is a description rather than a
// copy — see NPC_SUBJECT, LOCATION_SUBJECT and CHARACTER_SUBJECT next to the
// prompts they belong to.
//
// Nothing here writes to the console. The run emits events and returns what it
// found; the CLI renders them (scripts/lib/render-entity-run.mjs) and the
// pipeline ignores most of them. That is what makes the run testable at all:
// the model is injected, so a test drives a whole build without spending a
// penny or needing the network.
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { buildTranscriptText } from '../pipeline/transcribe.js';
import { callModel as defaultCallModel } from '../pipeline/model-client.js';
import { campaignFolder } from '../export/naming.js';
import { readKnownEntityNames } from './ledger.js';
import { rosterNames } from './character-names.js';
import { NPC_SUBJECT } from './npc-extract.js';
import { LOCATION_SUBJECT } from './location-extract.js';
import { CHARACTER_SUBJECT } from './character-extract.js';

// Reading thousands of lines of raw transcript is not the summariser's job.
// A session can take minutes on a large context, and a run is a dozen of them.
const MODEL_TIMEOUT_MS = 20 * 60 * 1000;

export const SUBJECTS = {
  npcs: NPC_SUBJECT,
  locations: LOCATION_SUBJECT,
  characters: CHARACTER_SUBJECT,
};

export function subjectNamed(name) {
  const subject = SUBJECTS[String(name ?? '').toLowerCase()];
  if (!subject) {
    throw new Error(`unknown subject "${name}" — expected one of: ${Object.keys(SUBJECTS).join(', ')}`);
  }
  return subject;
}

// The sessions a build reads, oldest first.
//
// Ordered on the session number rather than the row id because a note records
// which sessions a character appeared in, and an imported recording can be
// filed under an earlier number than a row inserted before it.
export function sessionsToRead(db, campaignId) {
  return db
    .listCompletedMeetings(campaignId)
    .slice()
    .sort((a, b) => (a.session_number ?? a.id) - (b.session_number ?? b.id));
}

async function readCache(cachePath) {
  if (!cachePath) return null;
  return readFile(cachePath, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

// One build, start to finish.
//
// `write` is off by default and that is not a courtesy — the transcripts cost a
// real model call per session either way, so the dry run exists to check the
// extraction before it touches the vault, not to avoid the spend. `cachePath`
// is what makes a second look free: the raw per-session extraction is saved,
// and replaying it rebuilds the notes offline.
export async function buildEntityNotes({
  db,
  cfg,
  campaign,
  subject,
  extras = {},
  cachePath = null,
  // Which sessions this run is allowed to read. null means all of them; the
  // pipeline passes the one that just finished.
  onlySessions = null,
  write = false,
  // The one real seam. In production this is the model; in tests it is a
  // function that returns canned JSON, which is the only reason the run above
  // can be tested at all.
  callModel = defaultCallModel,
  timeoutMs = MODEL_TIMEOUT_MS,
  onEvent = () => {},
}) {
  const campaignId = campaign.id;
  const meetings = sessionsToRead(db, campaignId);

  if (meetings.length === 0) {
    const err = new Error(`no completed sessions for ${campaign.name ?? campaignId}`);
    err.code = 'NO_SESSIONS';
    throw err;
  }

  const campaignName = db.getCampaignName(campaignId);
  const folder = campaignFolder(meetings[0], campaignName);

  // The spellings the vault's existing [[links]] use. Handed to the model so it
  // carries them into aliases rather than orphaning links the ledger and the
  // session recaps already contain.
  const ledger = await readKnownEntityNames(cfg, folder);
  const existingNames = [...ledger.npcs, ...ledger.locations];

  onEvent({
    type: 'start',
    subject: subject.key,
    campaignName: campaignName || meetings[0].channel_name,
    folder,
    sessions: meetings.map((m) => m.session_number ?? m.id),
    existingNames,
    // The warning that was in exactly one of the three copies. It belongs to
    // every subject: the ledger lives on Drive between sessions, so an absent
    // one here silently skips reconciliation for whichever build ran.
    ledgerEmpty: existingNames.length === 0,
  });

  // What has already been read, and what still has to be.
  //
  // The cache used to be all-or-nothing: present meant "call nothing", absent
  // meant "call for every session". That made a run which died on session nine
  // of twelve cost the first eight again, and it made an incremental update
  // impossible — the pipeline would have re-read every transcript in the
  // campaign to add one session, which is O(n²) calls over a campaign's life.
  //
  // So it is keyed by session instead. A session already in the cache is not
  // read again; anything else is; and `onlySessions` narrows what "anything
  // else" means to the one session that just finished.
  const cached = await readCache(cachePath);
  const have = new Map((cached ?? []).map((entry) => [entry.sessionNumber, entry]));
  if (cached) onEvent({ type: 'cache-hit', path: cachePath, sessions: [...have.keys()] });

  const wanted = onlySessions
    ? meetings.filter((m) => onlySessions.includes(m.session_number ?? m.id))
    : meetings;

  const outDir = join(cfg.obsidianExportDir, folder, subject.folder);

  // An incremental run merges the session it was handed with what the cache
  // remembers of every earlier one. With nothing cached for those, the merge
  // is not an update -- it is a rebuild from one evening, and writing it
  // replaces a campaign's history with that evening.
  //
  // Seen for real, and the documentation walked you into it: the three CLI
  // builders were written up without --cache, so a hand-built vault had no
  // cached extraction behind it at all. Turning ENTITY_NOTES_AFTER_SESSION on
  // afterwards took Meepo.md from `sessions: [1, 2, 3]` to `sessions: [4]` and
  // then saved a cache holding only session 4, so the history could not be
  // rebuilt without paying for every transcript again. A cache file that is
  // present but unreadable does the same thing more quietly -- readCache
  // answers null for a truncated file exactly as it does for a missing one.
  //
  // So the run refuses, and refuses BEFORE calling the model: a session it may
  // not write up is not one worth spending on. The CLI now defaults --cache to
  // the same path the pipeline uses, so one full build is all it takes to make
  // this stop happening.
  if (onlySessions) {
    const reading = new Set(wanted.map((m) => m.session_number ?? m.id));
    const uncovered = meetings
      .map((m) => m.session_number ?? m.id)
      .filter((n) => !have.has(n) && !reading.has(n));

    if (uncovered.length) {
      onEvent({ type: 'incremental-refused', uncovered, cachePath });
      return {
        campaignName, folder, outDir,
        records: [], unresolved: [], missing: [], written: [],
        sessions: meetings.length,
      };
    }
  }

  let extracted = 0;
  for (const meeting of wanted) {
    const sessionNumber = meeting.session_number ?? meeting.id;
    if (have.has(sessionNumber)) continue;

    const utterances = db.listUtterances(meeting.id);

    // Said out loud for every subject. One of the three copies used to skip a
    // transcript-less session with a bare `continue`, so a build that quietly
    // read four sessions out of six looked exactly like one that read six.
    if (utterances.length === 0) {
      onEvent({ type: 'session-skipped', sessionNumber, reason: 'no transcript' });
      continue;
    }

    const transcript = buildTranscriptText(utterances);
    onEvent({ type: 'session-start', sessionNumber, lines: utterances.length, bytes: transcript.length });

    const started = Date.now();
    let text;
    try {
      text = await callModel(
        subject.systemPrompt,
        subject.userMessage({
          transcript,
          sessionNumber,
          date: (meeting.started_at || '').slice(0, 10),
          existingNames,
          extras,
        }),
        cfg,
        timeoutMs
      );
    } catch (err) {
      // One session failing is not the run failing. A four-hour campaign is a
      // dozen calls and losing all of them to one timeout would be worse than
      // a note that is missing a session.
      onEvent({ type: 'session-failed', sessionNumber, message: err.message });
      continue;
    }

    const records = subject.parse(text);
    onEvent({
      type: 'session-done',
      sessionNumber,
      count: records.length,
      elapsedMs: Date.now() - started,
      // The other half of the divergence: a model that wraps its JSON in prose
      // returns nothing parseable, and knowing what it said instead is the
      // difference between "no NPCs this session" and "the prompt is broken".
      unparsed: records.length === 0 && text.trim() ? text.trim().slice(0, 120).replace(/\s+/g, ' ') : null,
    });
    have.set(sessionNumber, { sessionNumber, [subject.key]: records });
    extracted += 1;
  }

  // Oldest first, and only sessions that still exist — a cache outlives the
  // campaign's shape, and a discarded session should not go on contributing to
  // a character's history.
  const perSession = meetings
    .map((m) => have.get(m.session_number ?? m.id))
    .filter(Boolean);

  // Written whenever something new was read, not only on the first run. That
  // is what makes a failed run resumable and an incremental update cheap.
  if (cachePath && extracted > 0) {
    await mkdir(dirname(cachePath), { recursive: true }).catch(() => {});
    await writeFile(cachePath, JSON.stringify(perSession, null, 2), 'utf8');
    onEvent({ type: 'cache-saved', path: cachePath, sessions: perSession.length });
  }

  const records = subject.merge(perSession, extras);

  // Not every subject reconciles. A player character is keyed on the roster,
  // which is a fact somebody typed, and that beats a fuzzy match every time.
  let unresolved = [];
  if (subject.reconcile) {
    ({ unresolved } = subject.reconcile(records, existingNames));
    if (unresolved.length) onEvent({ type: 'unresolved', names: unresolved });
  }

  if (records.unmatched?.length) onEvent({ type: 'unmatched', records: records.unmatched });

  const missing = subject.missing?.(records, extras) ?? [];
  if (missing.length) onEvent({ type: 'missing', names: missing });

  // Anything already in the ledger can be linked; anything else stays plain
  // text so the vault does not fill with links to notes that will never exist.
  //
  // Locations also link to whoever lives there, so a locations build reads the
  // NPC notes that a previous one wrote. Declared by the subject rather than
  // hard-coded here.
  const alsoKnown = await readSiblingNotes(cfg, folder, subject);
  const knownEntities = [...ledger.npcs, ...ledger.locations, ...alsoKnown, ...records.map((r) => r.name)];

  const written = [];

  for (const record of records) {
    const filename = subject.fileName(record.name);
    if (!filename) {
      onEvent({ type: 'unusable-name', name: record.name });
      continue;
    }

    onEvent({ type: 'record', record, detail: subject.detail(record), filename });

    if (write) {
      await mkdir(outDir, { recursive: true });
      await writeFile(
        join(outDir, filename),
        subject.render(record, { campaign: campaignName, knownEntities }),
        'utf8'
      );
      written.push(filename);
    }
  }

  onEvent({ type: 'finished', write, outDir, written: written.length, found: records.length });

  return { campaignName, folder, outDir, records, unresolved, missing, written, sessions: meetings.length };
}

// Where a campaign's raw per-session extraction lives between runs.
//
// Inside the vault rather than beside the database, because it belongs to the
// campaign's notes: it is what the per-entity pages were built FROM, it syncs
// to Drive with everything else, and restoring a vault restores the ability to
// rebuild the pages without paying for every transcript again.
//
// Dot-prefixed so Obsidian leaves it alone.
export function entityCachePath(cfg, folder, subject) {
  return join(cfg.obsidianExportDir, folder, '.entity-cache', `${subject.key}.json`);
}

// Where THIS campaign's cache lives, asked once by everybody who needs it.
//
// The path depends on the campaign's vault folder, which is only known after
// the sessions have been read -- so both callers used to work it out for
// themselves, and only one of them did. The pipeline cached to
// <vault>/<campaign>/.entity-cache/; the CLI cached to wherever --cache
// pointed, which was nowhere by default, because the documented commands never
// passed it. The two could only agree if somebody typed the pipeline's path in
// by hand, and nothing said they had to.
//
// That is what turned an incremental update into a rebuild from one session.
// One function, so a hand-built vault and an automatic update are the same
// campaign's cache by construction rather than by coincidence.
//
// Null when the campaign has no completed sessions: there is no folder to name
// yet, and nothing to cache either.
export function entityCachePathFor(db, cfg, campaign, subject) {
  const meetings = sessionsToRead(db, campaign.id);
  if (meetings.length === 0) return null;
  return entityCachePath(cfg, campaignFolder(meetings[0], db.getCampaignName(campaign.id)), subject);
}

// The order the subjects have to run in.
//
// A place's note names who lives there, and the party's note is written last
// because both of the others are things it can link to. Running them the other
// way round produces pages full of plain text where links belong, and nothing
// goes back to fix them.
export const SUBJECT_ORDER = ['npcs', 'locations', 'characters'];

// One session's worth of update, after the pipeline has finished with it.
//
// This is the second caller of the run, and it is what makes the seam real
// rather than hypothetical: before it existed, `queue-worker.tick()` READ the
// per-entity notes for their alias lists but never wrote them, so the thing it
// depended on was only ever as current as the last time somebody remembered to
// run three scripts by hand.
//
// Cost is bounded on purpose. The cache is keyed by session, so this reads ONE
// transcript per subject however long the campaign has been running — three
// model calls after a session, not three per session ever recorded.
//
// Best-effort throughout, like the archive-page regeneration next to it in the
// queue worker: a session that was transcribed, summarised and posted is a
// finished session, and a model that would not answer about its NPCs must not
// turn that into a failure.
export async function updateEntityNotesForSession({
  db,
  cfg,
  campaign,
  sessionNumber,
  subjects = SUBJECT_ORDER,
  callModel = defaultCallModel,
  onEvent = () => {},
}) {
  const results = [];

  for (const name of subjects) {
    const subject = subjectNamed(name);
    try {
      const cachePath = entityCachePathFor(db, cfg, campaign, subject);
      if (!cachePath) break; // no completed sessions yet, so nothing to update

      results.push(
        await buildEntityNotes({
          db,
          cfg,
          campaign,
          subject,
          extras: extrasFor(db, campaign.id, name),
          cachePath,
          onlySessions: [sessionNumber],
          write: true,
          callModel,
          onEvent,
        })
      );
    } catch (err) {
      onEvent({ type: 'subject-failed', subject: name, message: err.message });
    }
  }

  return results;
}

// What each subject needs beyond the transcript, taken from the database
// rather than from a command line.
//
// The CLI can be told who plays whom; the pipeline cannot ask, so it uses the
// roster the DM already set with /dm character. A campaign with no roster set
// gets no character notes, which is the right answer — there is nothing to key
// them on.
function extrasFor(db, campaignId, name) {
  if (name === 'npcs') return { playerCharacters: rosterNames(db, campaignId) };
  if (name === 'characters') {
    return {
      roster: db
        .listRoster(campaignId)
        .filter((r) => r.characterName)
        .map((r) => ({ player: r.displayName, character: r.characterName })),
    };
  }
  return {};
}

// Notes a build should be able to link to but did not create itself.
//
// A place's note names its inhabitants, and those have pages of their own —
// written by the NPC build that ran before it. Reading the folder is how the
// location builder always did this; it is here so the reason is written down
// once instead of being a line only one of the three scripts happened to have.
async function readSiblingNotes(cfg, folder, subject) {
  if (!subject.linksTo?.length) return [];

  const found = [];
  for (const sibling of subject.linksTo) {
    const names = await readdir(join(cfg.obsidianExportDir, folder, sibling))
      .then((files) => files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')))
      .catch(() => []);
    found.push(...names);
  }
  return found;
}
