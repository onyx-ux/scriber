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
  replayCorrections,
  setCharacter,
  forgetCharacter,
  setOutput,
} from '../pipeline/job-actions.js';
import { ACTION_NOW, ACTION_LATER, ACTION_PI } from '../pipeline/transcribe-schedule.js';
import { applyCorrections } from '../campaign/corrections.js';
import { ROLES } from '../pipeline/model-choice.js';

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
        // Only ever true when the operator has been shown how many lines it
        // would rewrite and said yes anyway — see the blast-radius guard in
        // job-actions.js. A rewrite cannot be undone, so the number has to be
        // seen before it happens rather than reported after.
        force: body.force === true,
      }),
    };
  },

  'corrections/remove': (db, cfg, body) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    return { status: 200, payload: removeCorrection(db, { campaignId: id, wrong: body.wrong }) };
  },

  'corrections/replay': (db, cfg, body) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    return {
      status: 200,
      // applyCorrections takes the whole rule list in one pass, so a line is
      // rewritten once however many rules touch it — looping the single-rule
      // rewrite would count the same line several times and, worse, let one
      // rule's output feed the next rule's input.
      payload: replayCorrections(db, {
        campaignId: id,
        rewrite: (text, rules) => applyCorrections(text, rules),
      }),
    };
  },

  // Sign somebody out of the dashboard, everywhere at once.
  //
  // This does not remove them from a campaign and does not touch a single
  // transcript -- it ends their sessions, so the next thing they do needs a
  // fresh code from the bot. Revoking access and deleting somebody's history
  // are different acts, and only one of them belongs on a button.
  'access/revoke': (db, cfg, body) => {
    const userId = String(body?.userId ?? '').trim();
    if (!userId) return badRequest('A userId is required.');

    const ended = db.closeAllAuthSessions(userId);
    return {
      status: 200,
      payload: {
        ok: true,
        ended,
        message: ended
          ? `Signed out of ${ended} session${ended === 1 ? '' : 's'}. They can sign back in with a new code.`
          : 'They had no sessions open.',
      },
    };
  },

  'campaign/output': (db, cfg, body) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    return { status: 200, payload: setOutput(db, { campaignId: id, mode: body.mode }) };
  },

  // Who in this campaign's server matches what was typed.
  //
  // A POST rather than a GET, and that is a security decision rather than a
  // REST one: reads on this API are open when no STATUS_TOKEN is set, which is
  // a defensible default for "how many sessions have been recorded" and an
  // indefensible one for "list me the members of this Discord". Actions fail
  // closed, so this inherits the right posture by being one.
  'roster/search': (db, cfg, body, ctx) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');

    const campaign = db.getCampaign(id);
    if (!campaign) return badRequest('No such campaign.');
    if (typeof ctx?.discord?.findPeople !== 'function') {
      return { status: 200, payload: { ok: false, message: '⚠️ This bot cannot look people up right now.' } };
    }

    return ctx.discord
      .findPeople({ guildId: campaign.guild_id, query: body.query })
      .then((result) => ({ status: result.ok ? 200 : 400, payload: result }));
  },

  // Ask somebody whether they may be recorded.
  //
  // The one dashboard action whose effect is a message to a human being, so it
  // is the one that must not report success before Discord has accepted it —
  // see discord-bridge.js, where the DM is sent before the invite is recorded.
  'roster/invite': (db, cfg, body, ctx) => {
    const id = campaignId(body);
    const who = userId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    if (!who) return badRequest('A Discord user id is required — that is a number, not a username.');
    if (typeof ctx?.discord?.invite !== 'function') {
      return { status: 200, payload: { ok: false, message: '⚠️ This bot cannot send invitations right now.' } };
    }

    return ctx.discord
      .invite({
        campaignId: id,
        userId: who,
        characterName: String(body.name ?? '').trim() || null,
        inviterName: 'the dashboard',
      })
      .then((result) => ({ status: result.ok ? 200 : 400, payload: result }));
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

  // Ask the bot to look again, now.
  //
  // Reachability is refreshed on a slow timer so the dashboard's polling does
  // not put a steady trickle of traffic on the LAN. That is right for the
  // steady state and wrong for the one moment it matters: you have just walked
  // over and turned the PC on, and the page will keep saying "unreachable" for
  // up to a minute. This is the button that answers "is it back yet".
  'health/probe': (db, cfg, body, ctx) => {
    if (typeof ctx?.probeNow !== 'function') {
      return { status: 200, payload: { ok: false, message: '⚠️ This bot cannot re-check on demand.' } };
    }
    ctx.probeNow();
    return {
      status: 202,
      payload: { ok: true, message: '📡 Checking the transcriber and the summariser now — the dots update in a moment.' },
    };
  },

  // Which model does which job, without a redeploy.
  //
  // Machinery, so dev only — it moves the owner's API spend. Stored in
  // settings rather than the env file because the reason to change a model is
  // usually that something is failing right now, and editing .env on the Pi
  // and restarting is not a thing anybody does mid-session.
  'model/choose': (db, cfg, body) => {
    const role = String(body?.role ?? '');
    if (!ROLES.includes(role)) {
      return badRequest(`Unknown role "${role}". Expected one of: ${ROLES.join(', ')}.`);
    }

    const model = String(body?.model ?? '').trim();
    // Cleared rather than set to a name, which puts the env file back in
    // charge — there has to be a way back to the default.
    if (!model) {
      db.setSetting(`model_${role}`, '');
      return {
        status: 200,
        payload: { ok: true, message: `↩️ ${role} is back to whatever the config says.` },
      };
    }

    // Deliberately not validated against a list of "real" model names. A bot
    // cannot know what a provider offers without asking, the answer changes
    // under you, and refusing a model that exists is worse than accepting one
    // that does not — a wrong name fails loudly on the next call and can be
    // corrected in the same place it was typed.
    if (!/^[a-z0-9.\-]{3,60}$/i.test(model)) {
      return badRequest('That does not look like a model name.');
    }

    db.setSetting(`model_${role}`, model);
    return {
      status: 200,
      payload: {
        ok: true,
        model,
        message:
          `🧠 ${role === 'ask' ? 'Questions' : 'Session notes'} will use **${model}** from the next call on.` +
          (role === 'summary' ? ' Anything already queued keeps the model it was queued with.' : ''),
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
// Most actions are a database write and answer immediately. The few that talk
// to Discord — inviting somebody, looking a name up — cannot, so this returns
// whatever the handler returned: a result, or a promise of one.
//
// Deliberately not `async`. Every existing caller and every existing test reads
// the result synchronously, and making them all `await` a value that is not a
// promise would be a large diff whose only purpose is to accommodate two new
// handlers. `await` on a plain object is a no-op, so the server can await
// unconditionally and both shapes work.
export function runAction({ pathname, body, db, cfg, ctx = {} }) {
  const action = findAction(pathname);
  if (!action) return { status: 404, payload: { ok: false, message: 'No such action.' } };

  const failed = (err) => {
    // A failed action must never take the bot down, and must never hand the
    // caller a stack trace — this port can be published.
    console.error(`[actions] ${action.name} failed:`, err);
    return { status: 500, payload: { ok: false, message: 'That action failed. Check the bot log.' }, action: action.name };
  };

  try {
    const result = action.run(db, cfg, body ?? {}, ctx);
    return typeof result?.then === 'function'
      ? result.then((settled) => ({ ...settled, action: action.name }), failed)
      : { ...result, action: action.name };
  } catch (err) {
    return failed(err);
  }
}
