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
import { createCampaign, guildsCreatableBy } from '../campaign/create.js';
import { archiveCampaign, restoreArchivedCampaign } from '../campaign/archive.js';
import { handOverCampaign } from '../campaign/handover.js';
import { requestRestore, decideRestoreRequest } from '../campaign/restore-request.js';
import { applyCorrections } from '../campaign/corrections.js';
import { ROLES } from '../pipeline/model-choice.js';
// Whose name an act happens under. Asked rather than re-derived: four actions
// here used to each decide for themselves what the operator's console is.
import { actingUserId, listInForce } from './authority.js';
import { buildViewer, LEVELS, LEVEL_WORDS, HOW_TO_RAISE } from './viewer.js';
import { TIERS, TOP_TIER, isTier, askLimitFor } from '../access/tiers.js';
// Ending somebody's sessions goes through the module that owns credentials,
// not straight at the store — see web/auth.js.
import { revokeAllSessions } from './auth.js';
import { isOperator, isPrimaryOperator, runsThisBot, mayGrantHouseTier } from '../access/operators.js';
import { joinLink } from '../delivery/dashboard-link.js';
import { isVoiceColour, voiceColour } from './palette.js';
// The token has to be unguessable, not merely unique: it is the only thing
// standing between a stranger and a table's name. Math.random is neither.
import { randomBytes } from 'node:crypto';

// How long an invite link lives. Longer than the 24 hours a DM invite gets, and
// for the opposite reason: a DM is a question put to one person who is looking
// at it now, and a link is pinned in a channel for whoever has not read it yet.
// Not forever, so a campaign that quietly ends does not leave a live door.
const INVITE_LINK_DAYS = 14;

// One sentence for every dead token — never used, revoked, expired, or invented
// on the spot. Telling them apart would tell a stranger which guesses were warm.
const DEAD_LINK = 'That invitation is not good any more. Ask whoever runs the game for a new link.';

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

    const ended = revokeAllSessions(db, userId);
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

  // Put somebody on the guest list.
  //
  // This grants nothing. It opens the front door for an account and stops
  // there — what they see once they are through is still worked out from what
  // that account owns, runs and plays in, so admitting the wrong person shows
  // them an empty dashboard rather than somebody else's campaign. That is the
  // whole reason this button is allowed to exist: web/viewer.js was built so
  // that no list could hand out a level, and this list cannot.
  //
  // Discord is asked whether the id is real before a row is written. Eighteen
  // digits with no check digit means a typo is still a well-formed id, and a
  // line admitting an account that does not exist is one nobody can explain a
  // year later.
  'access/invite': async (db, cfg, body, ctx) => {
    const id = userId(body);
    if (!id) return badRequest('A Discord user id is required — 17 or 18 digits.');

    const note = String(body?.note ?? '').trim().slice(0, 200) || null;

    let username = String(body?.username ?? '').trim() || null;
    if (typeof ctx?.discord?.lookUp === 'function') {
      const found = await ctx.discord.lookUp({ userId: id });
      if (!found.ok) return { status: 400, payload: { ok: false, message: found.message } };
      username = found.username ?? username;
    }

    db.setInvited(id, { username, setBy: actingUserId(ctx?.viewer, cfg), note });
    return {
      status: 200,
      payload: {
        ok: true,
        userId: id,
        username,
        message: `${username || id} can sign in. What they see is still their own.`,
      },
    };
  },

  // Take somebody off it, and out of the building.
  //
  // Admission and revocation ARE different acts -- access/revoke above is the
  // other one, for ending a session without withdrawing the welcome. But
  // striking a name off a guest list while the person keeps walking around for
  // another month is not striking a name off a guest list. maySignIn is asked
  // when a session is opened and never again, so removing alone would change
  // nothing until the session expired.
  //
  // It still does not happen quietly: the reply says how many sessions it
  // ended, because "removed" and "removed, and three devices just lost the
  // page" deserve different reactions.
  'access/uninvite': (db, cfg, body) => {
    const id = userId(body);
    if (!id) return badRequest('A Discord user id is required.');

    // Somebody admitted by the environment or by being the owner cannot be
    // struck off here, and deleting nothing while reporting success would be
    // the worst available answer.
    if (!db.isInvited(id)) {
      return {
        status: 400,
        payload: {
          ok: false,
          message:
            'That name is not on the list this page can edit. It is admitted by DASHBOARD_ALLOWED_USERS ' +
            'or by being OWNER_USER_ID, and only pi-service/.env can change either.',
        },
      };
    }

    db.clearInvited(id);
    const ended = revokeAllSessions(db, id, { reason: 'removed' });

    // Taking the last name off does not shut the door harder, it removes the
    // door. Reporting "off the list" and nothing else would be true and would
    // leave somebody believing they had just tightened access at the exact
    // moment they opened it to every Discord account there is.
    const emptied = !listInForce(cfg, db);

    return {
      status: 200,
      payload: {
        ok: true,
        ended,
        emptied,
        message:
          (ended
            ? `Off the list, and signed out of ${ended} session${ended === 1 ? '' : 's'}.`
            : 'Off the list. They had no sessions open.') +
          (emptied
            ? ' That was the last name on it — with no list, ANY Discord account can now sign in.'
            : ''),
      },
    };
  },

  // Hold somebody below the level they resolve to.
  //
  // This is the only action in this file that touches a level, and it is worth
  // saying exactly what it can and cannot do, because the name invites the
  // wrong reading.
  //
  // It sets a CEILING. Every level below dev is derived from a fact -- Discord
  // says you own that server, this campaign names you as its manager, you
  // actually spoke at that table -- and none of those becomes true because a
  // row was written here. So a level ABOVE what somebody resolves to is
  // refused, with the thing that would actually raise it, rather than accepted
  // and silently ignored. What the owner of the hardware can always do is
  // decide to show a person less than they have earned, and that is this.
  //
  // Clearing the ceiling is the empty string, not a level, so "back to whatever
  // is true of them" cannot be confused with "hold them at the level they
  // happen to be at today".
  'access/level': (db, cfg, body, ctx) => {
    const id = userId(body);
    if (!id) return badRequest('A Discord user id is required.');

    const raw = String(body?.level ?? '').trim();
    if (raw && !LEVELS.includes(raw)) {
      return badRequest(`Not a level. They are: ${LEVELS.join(', ')}.`);
    }

    // An operator cannot be held down, for the same reason they are always on
    // their own guest list: the only way back from that click is SSH.
    //
    // It would also be a control that lies. buildViewer ignores a cap on
    // anybody it calls dev, so the click would report success and change
    // nothing at all — worse than a refusal that says where the real switch is.
    //
    // Three routes in now, and the refusal has to name the right one. The
    // house tier is the only one with a switch on this page, so that refusal
    // points at the Tier column rather than at a text editor on the Pi.
    if (runsThisBot(db, cfg, id)) {
      const which = isOperator(cfg, id)
        ? (isPrimaryOperator(cfg, id) ? 'OWNER_USER_ID' : 'OPERATOR_USER_IDS')
        : null;
      return {
        status: 400,
        payload: {
          ok: false,
          message: which
            ? `That account is an operator, named by ${which}. Holding an operator below ` +
              'their own level is a click you could not undo from this page, and a cap on an ' +
              `operator is ignored anyway — change ${which} in pi-service/.env if you mean it.`
            : `That account is on tier ${TOP_TIER}, the house, which makes it an operator — and a ` +
              'cap on an operator is ignored. Move them off the house tier first, in the Tier ' +
              'column, and their level will resolve to whatever is actually true of them.',
        },
      };
    }

    // `dev` is not on this column's menu, and refusing it here is what keeps
    // that true of the API as well as of the dropdown. There is one way to
    // appoint an operator — the house tier, next door — and a second way would
    // be a second thing to remember to take away.
    if (raw === 'dev') {
      return { status: 400, payload: { ok: false, message: HOW_TO_RAISE.dev } };
    }

    const guildsOwned = ctx?.guildsOwnedBy?.(id) ?? [];
    const { derivedLevel } = buildViewer({ db, cfg, userId: id, guildsOwned });

    // One control, one answer, and which column it lands in follows from where
    // the answer sits relative to what is actually true of them. Above is a
    // floor, below is a ceiling, and their own level is neither — it clears
    // whichever opinion was there.
    //
    // The store clears the other column on each write, so a person can never
    // hold both. That matters more than it looks: a floor of creator under a
    // ceiling of player is two instructions that cannot both be obeyed, and
    // buildViewer would quietly pick one while the page drew the other.
    const setBy = actingUserId(ctx?.viewer, cfg);
    const wanted = raw || derivedLevel;
    const direction =
      LEVELS.indexOf(wanted) > LEVELS.indexOf(derivedLevel) ? 'up'
      : LEVELS.indexOf(wanted) < LEVELS.indexOf(derivedLevel) ? 'down'
      : 'level';

    if (direction === 'up') db.setGrant(id, wanted, { setBy });
    else if (direction === 'down') db.setCap(id, wanted, { setBy });
    else db.setCap(id, null, { setBy });

    return {
      status: 200,
      payload: {
        ok: true,
        level: wanted,
        derivedLevel,
        message:
          direction === 'level'
            ? `Back to ${derivedLevel} — whatever is true of their account is what they see.`
            : direction === 'down'
              ? `Held at ${wanted}: sees ${LEVEL_WORDS[wanted]}. They resolve to ${derivedLevel}, so this is a ceiling you can lift.`
              // The caveat rides on the message rather than living only in a
              // help panel, because "raised to creator" reads like "given a
              // campaign" and is not.
              : `Raised to ${wanted}: sees ${LEVEL_WORDS[wanted]}. This adds controls, not campaigns — ` +
                `${HOW_TO_RAISE[wanted]}`,
      },
    };
  },

  // Move somebody between tiers.
  //
  // The one control on this page that goes up as well as down, and the reason
  // is in access/tiers.js: a level answers "what may they see" and is derivable
  // from facts, so granting one would be inventing a fact. A tier answers "how
  // much of my GPU and my API bill may they spend", which no fact in the world
  // answers -- it is the person paying deciding what they will pay, and that is
  // a decision, not a lookup.
  // "No thank you." Clears the ask without admitting them and without marking
  // them in any way -- they can ask again, because this is a decision about a
  // queue rather than a ban. Admitting somebody is the other button, and it
  // keeps the date they asked on.
  'access/dismiss': (db, cfg, body) => {
    const id = userId(body);
    if (!id) return badRequest('A Discord user id is required.');

    const cleared = db.dismissRequest(id);
    return {
      status: 200,
      payload: {
        ok: true,
        cleared: cleared > 0,
        message: cleared
          ? 'Cleared. They can ask again, and nothing about them was written down.'
          : 'Nobody by that id was waiting.',
      },
    };
  },

  'access/tier': (db, cfg, body, ctx) => {
    const id = userId(body);
    if (!id) return badRequest('A Discord user id is required.');

    // Asked BEFORE the Number(), which is not the same check. Number(null) is
    // 0 and Number('') is 0, and 0 is a real tier now -- so coercing first
    // turns a body with no tier in it at all into "put them on the free tier",
    // which is a decision nobody made.
    if (!isTier(body?.tier)) return badRequest(`Not a tier. They are ${TIERS.join(', ')}.`);
    const tier = Number(body.tier);

    // Every operator is always on the top tier, for the same reason they are
    // always on their own guest list. Every ceiling here exists to stop
    // somebody spending the operator's money; an operator spending it is the
    // thing being protected, not the thing being stopped.
    if (isOperator(cfg, id)) {
      const which = isPrimaryOperator(cfg, id) ? 'OWNER_USER_ID' : 'OPERATOR_USER_IDS';
      return {
        status: 400,
        payload: {
          ok: false,
          message:
            `That account is an operator, named by ${which}, and is always tier ${TOP_TIER} — ` +
            'a bot that can rate-limit the people who run it out of their own API key is a ' +
            'bot with a trap in it.',
        },
      };
    }

    // The house tier is the one tier that is not only about money: being on it
    // makes somebody an operator. So handing it out — or taking it back — is
    // reserved to an operator the CONFIG FILE names, not merely to anybody
    // currently holding the dev level.
    //
    // Both directions, deliberately. If a house-tier operator could not be
    // appointed by another but could be removed by one, "who runs this bot"
    // would still be a question the dashboard could answer on its own.
    const acting = actingUserId(ctx?.viewer, cfg);
    const alreadyHouse = Number(db.tierOf?.(id)) === TOP_TIER;
    if ((tier === TOP_TIER || alreadyHouse) && !mayGrantHouseTier(cfg, acting)) {
      return {
        status: 403,
        payload: {
          ok: false,
          message:
            `Tier ${TOP_TIER} is the house, and it makes an operator. Only somebody named in ` +
            'pi-service/.env — OWNER_USER_ID or OPERATOR_USER_IDS — can hand it out or take it ' +
            'back. An operator appointed from this page who could appoint more would be a role ' +
            'that grows with nobody’s hand on it.',
        },
      };
    }

    db.setTier(id, tier, { setBy: acting });

    const asks = askLimitFor(cfg, tier);
    return {
      status: 200,
      payload: {
        ok: true,
        tier,
        // The house tier says the loud part first. It is the one tier whose
        // effect is not a number, and somebody clicking down a column of
        // spending ceilings should not discover afterwards that they handed
        // over the machinery.
        message:
          (tier === TOP_TIER
            ? `Tier ${TOP_TIER} — the house. They now run this bot: the queue, the models, every ` +
              'campaign, and the guest list. Move them off it to take that back. '
            : alreadyHouse
              ? `Tier ${tier}. They no longer run this bot — their level goes back to whatever is ` +
                'actually true of them. '
              : `Tier ${tier}. `) +
          (asks > 0
            ? `${asks} question${asks === 1 ? '' : 's'} a day on /campaign ask.`
            : 'Questions on /campaign ask are unlimited.') +
          (Object.keys(cfg?.tierAskLimits ?? {}).length
            ? ''
            : ' Every tier is worth the same until TIER_ASK_LIMITS is set in pi-service/.env.'),
      },
    };
  },

  // Start a campaign without going to Discord.
  //
  // Who it belongs to comes from the session, never from the body: a manager id
  // the caller could name is a manager id the caller could forge, and the
  // campaign's owner is the one field here that decides who may change it
  // afterwards.
  //
  // The server is checked against what this viewer may create in for the same
  // reason. Every rule after that -- the name, the folder clash, the ceilings --
  // is the slash command's, because it is literally the same function.
  // Deleting a campaign, which does not delete it.
  //
  // The typed name is checked here rather than trusted from the page: a
  // confirmation the client can skip is a confirmation that is not there. Who
  // is asking comes from the session for the same reason it does on create.
  'campaign/delete': (db, cfg, body, ctx) => {
    const viewer = ctx?.viewer ?? null;
    const userId = actingUserId(viewer, cfg);
    if (!userId) {
      return { status: 403, payload: { ok: false, message: 'Sign in before deleting a campaign.' } };
    }

    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');

    const result = archiveCampaign({ db, cfg, campaignId: id, userId, typedName: body?.confirm });
    return { status: result.ok ? 200 : 200, payload: result };
  },

  // Asking for a campaign back, or -- if you are the person who decides
  // these -- simply doing it.
  //
  // The web page must not be a way around the review. Deleting is the
  // creator's decision and restoring is not, so anybody who is not the
  // operator files a ticket here exactly as they would in Discord, answers
  // and all.
  'campaign/restore': (db, cfg, body, ctx) => {
    const viewer = ctx?.viewer ?? null;
    const userId = actingUserId(viewer, cfg);
    if (!userId) {
      return { status: 403, payload: { ok: false, message: 'Sign in before asking about a campaign.' } };
    }

    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');

    if (runsThisBot(db, cfg, userId)) {
      return { status: 200, payload: restoreArchivedCampaign({ db, cfg, campaignId: id, userId }) };
    }

    const filed = requestRestore({
      db, cfg, campaignId: id, userId,
      requesterName: viewer?.username ?? null,
      reason: body?.reason,
      whyDeleted: body?.whyDeleted,
      takingOwnership: body?.takingOwnership,
    });

    // Best-effort, like every other DM here: a request that was filed is
    // filed whether or not Discord delivered the note about it, and it is
    // waiting on the dashboard either way.
    if (filed.ok) ctx?.notifyRestore?.(filed.requestId);
    return { status: 200, payload: filed };
  },

  // Deciding one. The operator's alone -- checked again in the domain layer,
  // because this is the gate the whole ticket exists to be.
  'campaign/restore-review': (db, cfg, body, ctx) => {
    const viewer = ctx?.viewer ?? null;
    const decidedBy = actingUserId(viewer, cfg);

    const requestId = Number(body?.requestId);
    if (!Number.isInteger(requestId) || requestId <= 0) return badRequest('A numeric requestId is required.');

    const decided = decideRestoreRequest({
      db, cfg, requestId, decidedBy, approve: body?.approve === true || body?.approve === 'true',
    });

    if (decided.ok) ctx?.notifyRestoreDecided?.(decided);
    return { status: 200, payload: decided };
  },
  'campaign/create': async (db, cfg, body, ctx) => {
    const viewer = ctx?.viewer ?? null;

    // With login off there is no session, and the page is the operator by
    // definition -- so the campaign belongs to whoever the bot calls its owner.
    const userId = actingUserId(viewer, cfg);
    if (!userId) {
      return {
        status: 403,
        payload: {
          ok: false,
          message: 'Sign in before starting a campaign — it has to belong to somebody.',
        },
      };
    }

    const guildId = String(body?.guildId ?? '').trim();
    // Asked again here rather than trusted from the picker: the browser sends
    // a guild id, and a guild id is eighteen digits anybody can type. This is
    // the check that actually holds, and the one on /status is only what makes
    // the dialog useful.
    const allowed = await guildsCreatableBy({
      viewer,
      guilds: ctx?.guilds?.() ?? [],
      isMember: (g, u) => ctx?.discord?.isMemberOf?.(g, u, { fresh: true }) ?? false,
    });
    if (!allowed.some((g) => g.id === guildId)) {
      return badRequest(
        allowed.length
          ? 'Pick one of the servers you can start a campaign in.'
          : 'You are not in a server this bot is in — add it to your Discord, or ask whoever runs that server to.'
      );
    }

    const made = createCampaign({ db, cfg, guildId, userId, name: body?.name });
    if (!made.ok) return { status: 200, payload: { ok: false, message: made.message } };

    return {
      status: 200,
      payload: {
        ok: true,
        campaignId: made.id,
        name: made.name,
        message: `📖 **${made.name}** exists. Notes are filed in \`${made.folder}/\`. Invite your players from the table tab.`,
      },
    };
  },

  // Handing a campaign to somebody else at the table.
  //
  // Gated at `manage` by ACTION_NEEDS and then narrowed here, the same two-step
  // campaign/delete uses: a Discord server's owner reaches `manage` for every
  // campaign in their server, and owning the Discord a game is played in is not
  // running the game. campaign/handover.js holds the real check.
  //
  // The one action on this bot that creates a `creator`, and it does it without
  // granting anything: it changes who runs the campaign, and buildViewer
  // derives the level from that the next time it is asked.
  'campaign/manager': (db, cfg, body, ctx) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');

    const acting = actingUserId(ctx?.viewer, cfg);
    if (!acting) {
      return { status: 403, payload: { ok: false, message: 'Sign in before handing a campaign over.' } };
    }

    const to = userId(body);
    if (!to) return badRequest('A Discord user id is required.');

    const result = handOverCampaign({ db, cfg, campaignId: id, userId: acting, toUserId: to });
    // 'not-yours' is the only refusal here that is about authority rather than
    // about the request, and it is the one worth a 403 — the page draws this
    // control for whoever may manage a campaign, which is wider than the set
    // this action accepts.
    return {
      status: result.ok ? 200 : result.reason === 'not-yours' ? 403 : 400,
      payload: result,
    };
  },

  'campaign/output': (db, cfg, body, ctx) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');

    // Only 'channel' needs Discord, and only 'channel' waits for it. Moving the
    // write-ups to a DM or back to the channel you played in is a database
    // write and stays one — a dropped gateway connection must not stand
    // between somebody with a guest at the table and making the notes private.
    if (String(body?.mode ?? '') !== 'channel') {
      return { status: 200, payload: setOutput(db, { campaignId: id, mode: body.mode }) };
    }

    const campaign = db.getCampaign(id);
    if (!campaign) return badRequest('No such campaign.');

    // No bridge, or a bridge that cannot answer, both arrive at setOutput with
    // no `postable` list — which refuses and says so, rather than writing an id
    // nothing has vouched for.
    const asked =
      typeof ctx?.discord?.listChannels === 'function'
        ? ctx.discord.listChannels({ guildId: campaign.guild_id }).catch(() => null)
        : Promise.resolve(null);

    return asked.then((res) => ({
      status: 200,
      payload: setOutput(db, {
        campaignId: id,
        mode: 'channel',
        channelId: body.channelId,
        postable: res?.ok ? res.channels : null,
      }),
    }));
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

  // --- the invite link -------------------------------------------------------
  //
  // The other way onto a roster. roster/invite needs a Discord user id, so the
  // person running the table has to find each player in a member list first;
  // this hands them one address they can paste into whatever the table already
  // uses, and each player says yes for themselves at the other end.
  //
  // Three rules the four actions below are built to keep:
  //
  //   * the token is the whole of the authority, so it is random, revocable and
  //     dated, and a bad one is refused in exactly the same words as an expired
  //     one — anything else tells a stranger which strings are real;
  //   * holding a link is not being asked on somebody's behalf. Accepting still
  //     records consent under the SESSION's user id, never one from the body;
  //   * the manager can pull it. A link that cannot be withdrawn is a door left
  //     open in a house you no longer remember the layout of.

  // Make one, or hand back the one already out. Deliberately not a fresh token
  // per press: three live links for one table is three things to remember to
  // revoke, and the DM pressing this twice means "show me the link" both times.
  'invite/link': (db, cfg, body, ctx) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    const campaign = db.getCampaign(id);
    if (!campaign) return badRequest('No such campaign.');

    let row = db.liveInviteLinkFor(id);
    if (!row) {
      row = db.createInviteLink({
        token: randomBytes(18).toString('base64url'),
        campaignId: id,
        createdBy: actingUserId(ctx?.viewer, cfg),
        expiresAt: new Date(Date.now() + INVITE_LINK_DAYS * 86400_000).toISOString(),
      });
    }

    return {
      status: 200,
      payload: {
        ok: true,
        token: row.token,
        // Null on an install with no DASHBOARD_URL. The page says so rather
        // than printing half an address somebody would paste anyway.
        url: joinLink(cfg, row.token),
        expiresAt: row.expires_at,
        campaignId: id,
      },
    };
  },

  'invite/revoke': (db, cfg, body) => {
    const id = campaignId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    if (!db.getCampaign(id)) return badRequest('No such campaign.');
    const pulled = db.revokeInviteLinks(id);
    return {
      status: 200,
      payload: {
        ok: true,
        revoked: pulled,
        message: pulled
          ? '🔗 That link is dead. Anyone still holding it gets nothing; make a new one to invite anybody else.'
          : 'There was no live link to pull.',
      },
    };
  },

  // What the person arriving is shown before they agree to anything.
  //
  // Reveals the campaign's name to whoever holds the token, which is the point
  // of a token — you cannot ask somebody to join a table you refuse to name.
  // Nothing else: not the roster, not the sessions, not who else was asked.
  'invite/peek': (db, cfg, body, ctx) => {
    const link = db.getLiveInviteLink(body?.token);
    const campaign = link ? db.getCampaign(link.campaign_id) : null;
    if (!campaign) return { status: 404, payload: { ok: false, message: DEAD_LINK } };

    const who = actingUserId(ctx?.viewer, cfg);
    return {
      status: 200,
      payload: {
        ok: true,
        campaignId: campaign.id,
        campaignName: campaign.name || campaign.channel_name || 'the table',
        // So the screen can say "you are already at this table" rather than
        // asking somebody to join something they are halfway through.
        alreadyIn: Boolean(who) && db.mayRecord(campaign.id, who),
        characterName: who ? db.getCharacterName(campaign.id, who) : null,
        retentionDays: cfg?.audioRetentionDays ?? 0,
      },
    };
  },

  // Saying yes, and saying what to call you.
  //
  // The one action here that writes a consent row for a person who was never
  // individually asked, so it is the one that most needs its user id to be
  // beyond argument: it comes from the session, and there is no code path that
  // reads body.userId. An operator console with no Discord session cannot use
  // this at all — actingUserId would hand it the owner's id, and agreeing to be
  // recorded is not something the owner does on a player's behalf.
  'invite/accept': (db, cfg, body, ctx) => {
    const who = ctx?.viewer?.userId;
    if (!who) return { status: 403, payload: { ok: false, message: 'Sign in with Discord first.' } };

    const link = db.getLiveInviteLink(body?.token);
    const campaign = link ? db.getCampaign(link.campaign_id) : null;
    if (!campaign) return { status: 404, payload: { ok: false, message: DEAD_LINK } };

    // Yes has to be typed out. `consent !== true` refuses on anything else a
    // body could carry — missing, "true", 1, null — because the failure
    // direction of a loose read here is somebody being recorded who never said
    // so, and that is the one bug in this file that cannot be apologised for.
    const agreed = body?.consent === true;

    // The same call /campaign consent makes, so somebody arriving by link ends
    // up in exactly the state somebody arriving by DM does. Declining is
    // recorded too, and is not a no-op: it is an answer on file that stops the
    // capture path cold, rather than the silence that merely also stops it.
    db.setConsent(campaign.id, who, agreed);

    // The name is taken either way, and that is deliberate.
    //
    // Naming a character enrols somebody, so this does put a player who said no
    // onto the roster — which is correct here rather than in spite of it. Being
    // at a table and being recorded at one are separate facts in this schema and
    // always have been (see setConsent, which enrols on yes and leaves a no
    // exactly where it stands): mayRecord is the only gate the capture path
    // asks, and it still answers no. What the roster gains is a person the DM
    // can see, named the way the table names them, marked as not recorded — and
    // that is a more useful thing for everyone than a silence.
    const name = String(body?.name ?? '').trim();
    const named = name ? setCharacter(db, { campaignId: campaign.id, userId: who, name }) : null;
    if (named && named.ok === false) return { status: 400, payload: named };

    return {
      status: 200,
      payload: {
        ok: true,
        campaignId: campaign.id,
        campaignName: campaign.name || campaign.channel_name || 'the table',
        recorded: agreed,
        characterName: named?.name ?? db.getCharacterName(campaign.id, who) ?? null,
      },
    };
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

  // What colour this person's name is written in, in this campaign's
  // transcripts.
  //
  // Own business, filed next to roster/character because it behaves the same
  // way: yours to set for yourself wherever you play, and the manager can set
  // one for a player who never opens the dashboard. A table where four of the
  // five voices are the default ink is not what anybody asked for.
  //
  // The slug is checked against the palette rather than stored as given. It
  // becomes a class name on a page, so an unchecked string is markup written
  // by whoever sent the request — and a slug outside the table would render as
  // nothing anyway, which is a silent no-op wearing the shape of an answer.
  // An empty colour is not a refusal but a request: it clears what was there.
  'roster/colour': (db, cfg, body) => {
    const id = campaignId(body);
    const who = userId(body);
    if (!id) return badRequest('A numeric campaignId is required.');
    if (!who) return badRequest('A Discord user id is required.');

    const asked = String(body?.colour ?? '').trim();
    if (asked && !isVoiceColour(asked)) return badRequest('That is not one of the colours.');

    db.setVoiceColour(id, who, asked || null);

    // Every action here says what it did: server.js writes it to the audit
    // log that replaced the Discord DM trail, and the dashboard toasts it.
    // Without one the log read "ok: undefined" and the toast said "HTTP 200".
    const picked = voiceColour(asked);
    return {
      status: 200,
      payload: {
        ok: true,
        campaignId: id,
        userId: who,
        colour: asked || null,
        message: picked
          ? `Written in ${picked.shade} ${picked.name.toLowerCase()} from now on.`
          : 'Back to the page\u2019s own ink.',
      },
    };
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
    //
    // Asked about the CAMPAIGN now, not its Discord. The map is keyed by
    // meeting rather than guild (a Discord can record two tables at once —
    // see commands/index.js), so the old `.has(guild_id)` would not merely be
    // imprecise, it would answer no every time and the guard would be gone.
    // Narrower and correct: importing into one table while ANOTHER table in
    // the same server is mid-session was never the danger this describes.
    if ([...(ctx?.activeSessions?.values?.() ?? [])].some((s) => s.campaignId === campaign.id)) {
      return { status: 409, payload: { ok: false, message: '⚠️ That campaign is recording right now — stop it first.' } };
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
