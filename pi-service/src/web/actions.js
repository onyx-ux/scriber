// What the dashboard is allowed to ask the bot to do.
//
// The status API was read-only by design, and that was the whole reason it
// could be left unauthenticated on a home LAN: the worst a stranger could do
// was read how many sessions you had recorded. This file ends that, so it is
// deliberately a closed list rather than a router — there is no path here that
// reaches an arbitrary db method, and adding one has to be a decision someone
// makes on purpose.
//
// The operations themselves live in pipeline/job-actions.js, shared with the
// Discord commands. This layer only does the part that is about HTTP: is the
// path known, is the body the right shape, what status code does the answer
// deserve.
import {
  approveSummary,
  approveAllSummaries,
  parkSummary,
  resummarise,
  discardSession,
  transcribeAction,
  setPaused,
  addCorrection,
  removeCorrection,
  setCharacter,
  forgetCharacter,
} from '../pipeline/job-actions.js';
import { ACTION_NOW, ACTION_LATER, ACTION_PI } from '../pipeline/transcribe-schedule.js';
import { applyCorrections } from '../campaign/corrections.js';

// An id arriving over HTTP is a string from a JSON body written by a page that
// could have been edited. "12abc" must not become 12.
function positiveInt(raw) {
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const jobId = (body) => positiveInt(body?.jobId);
const campaignId = (body) => positiveInt(body?.campaignId);

// A Discord snowflake, loosely. Not validated against Discord — the bot has no
// way to ask — but it must at least be a plausible id rather than free text,
// or a typo silently creates a roster entry for a person who does not exist.
function userId(body) {
  const raw = String(body?.userId ?? '').trim();
  return /^\d{5,25}$/.test(raw) ? raw : null;
}

function badRequest(message) {
  return { status: 400, payload: { ok: false, message } };
}

const TRANSCRIBE_ACTIONS = new Set([ACTION_NOW, ACTION_LATER, ACTION_PI]);

export const ACTIONS = {
  'summary/approve': (db, cfg, body) => {
    const id = jobId(body);
    if (!id) return badRequest('A numeric jobId is required.');
    return { status: 200, payload: approveSummary(db, cfg, { jobId: id, provider: body.provider ?? null }) };
  },

  // Separate from the single approve, and not just a loop over it, because
  // "release everything" is the one click here that can spend real money
  // without naming what it spent it on. It reports the count back.
  'summary/approve-all': (db, cfg, body) => ({
    status: 200,
    payload: approveAllSummaries(db, cfg, { provider: body.provider ?? null }),
  }),

  'summary/park': (db, cfg, body) => {
    const id = jobId(body);
    if (!id) return badRequest('A numeric jobId is required.');
    return { status: 200, payload: parkSummary(db, { jobId: id }) };
  },

  'transcribe': (db, cfg, body) => {
    const id = jobId(body);
    if (!id) return badRequest('A numeric jobId is required.');
    const action = String(body.action ?? ACTION_NOW);
    if (!TRANSCRIBE_ACTIONS.has(action)) {
      return badRequest(`Unknown action "${action}". Expected one of: ${[...TRANSCRIBE_ACTIONS].join(', ')}.`);
    }
    return { status: 200, payload: transcribeAction(db, cfg, { jobId: id, action }) };
  },

  'summary/again': (db, cfg, body) => {
    const id = positiveInt(body?.meetingId);
    if (!id) return badRequest('A numeric meetingId is required.');
    return { status: 200, payload: resummarise(db, cfg, { meetingId: id, provider: body.provider ?? null }) };
  },

  'session/discard': (db, cfg, body) => {
    const id = positiveInt(body?.meetingId);
    if (!id) return badRequest('A numeric meetingId is required.');
    return { status: 200, payload: discardSession(db, { meetingId: id }) };
  },

  // --- a campaign's records ---

  'corrections/add': (db, cfg, body) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    return {
      status: 200,
      // The rewrite is passed in rather than done in SQL: SQLite's REPLACE()
      // is case-sensitive and has no word boundaries, so "vecks" would miss
      // "Vecks" and correcting a short name would corrupt longer words that
      // contain it. See campaign/corrections.js.
      payload: addCorrection(db, {
        campaignId: id,
        wrong: body.wrong,
        right: body.right,
        rewrite: (text, from, to) => applyCorrections(text, [{ wrong_text: from, correct_text: to }]),
      }),
    };
  },

  'corrections/remove': (db, cfg, body) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    return { status: 200, payload: removeCorrection(db, { campaignId: id, wrong: body.wrong }) };
  },

  'roster/character': (db, cfg, body) => {
    const id = campaignId(body);
    const who = userId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    if (!who) return badRequest('A Discord user id is required — that is a number, not a username.');
    return { status: 200, payload: setCharacter(db, { campaignId: id, userId: who, name: body.name }) };
  },

  'roster/forget': (db, cfg, body) => {
    const id = campaignId(body);
    const who = userId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    if (!who) return badRequest('A Discord user id is required.');
    return { status: 200, payload: forgetCharacter(db, { campaignId: id, userId: who }) };
  },

  // Importing a recording made somewhere else — a phone on the table, a
  // Craig export, an in-person session.
  //
  // Started and left running, rather than awaited. Downloading, converting and
  // transcribing an hours-long recording takes hours, and the Discord version
  // of this spent real effort fighting the 15-minute interaction window by
  // editing its own reply as each phase completed. An HTTP request cannot do
  // even that, and should not try: the job is kicked off, the response says so
  // immediately, and progress appears in the same "Working on" card as every
  // other transcription.
  'import': (db, cfg, body, ctx) => {
    const id = campaignId(body);
    const url = String(body?.url ?? '').trim();
    if (!id) return badRequest('A numeric campaignId is required.');
    if (!/^https?:\/\/\S+$/i.test(url)) return badRequest('A http(s) URL to the recording is required.');

    const campaign = db.getCampaign(id);
    if (!campaign) return badRequest('No such campaign.');

    // A recording in flight owns the audio pipeline; a second one writing into
    // it at the same time is how two sessions end up interleaved.
    if (ctx?.activeSessions?.has(campaign.guild_id)) {
      return { status: 409, payload: { ok: false, message: '⚠️ That server is recording right now — stop it first.' } };
    }

    ctx.startImport({
      campaignId: id,
      guildId: campaign.guild_id,
      url,
      speakerLabel: String(body?.speaker ?? '').trim() || 'Table',
    });

    return {
      status: 202,
      payload: {
        ok: true,
        message:
          '📥 Import started. Downloading, converting and transcribing a long recording takes a while — ' +
          'it will appear under "Working on", and the notes arrive the usual way.',
      },
    };
  },

  'pause': (db, cfg, body) => {
    // Explicit rather than a toggle. A toggle sent twice by a double-click, or
    // by two tabs open on the same page, lands on the opposite of what the
    // person who clicked it saw.
    if (typeof body?.paused !== 'boolean') {
      return badRequest('`paused` must be true or false — this sets a state, it does not toggle one.');
    }
    return { status: 200, payload: setPaused(db, { queue: String(body.queue ?? ''), paused: body.paused }) };
  },
};

// `/actions/<name>` → the handler above. Returns null for anything unknown so
// the server can 404 it rather than guessing.
export function findAction(pathname) {
  const match = /^\/actions\/(.+?)\/?$/.exec(pathname || '');
  const name = match?.[1];
  return name && Object.hasOwn(ACTIONS, name) ? { name, run: ACTIONS[name] } : null;
}

// `ctx` carries the few things an action needs that are neither the database
// nor the config — the live recording map, and the way to start a background
// import. Passed in rather than imported so this module stays testable without
// a running bot, and so the list of what an action can reach stays short and
// visible.
export function runAction({ pathname, body, db, cfg, ctx = {} }) {
  const action = findAction(pathname);
  if (!action) return { status: 404, payload: { ok: false, message: 'No such action.' } };

  try {
    const result = action.run(db, cfg, body ?? {}, ctx);
    return { ...result, action: action.name };
  } catch (err) {
    // A failed action must never take the bot down, and must never hand the
    // caller a stack trace — this port can be published.
    console.error(`[actions] ${action.name} failed:`, err);
    return { status: 500, payload: { ok: false, message: 'That action failed. Check the bot log.' }, action: action.name };
  }
}
