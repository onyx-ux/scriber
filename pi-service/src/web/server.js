import { createServer } from 'node:http';

import { buildStatus } from './status.js';
import { buildCampaignView } from './campaign-view.js';
import { buildNotesView } from './notes-view.js';
import { buildTranscriptView } from './transcript-view.js';
import { createDiscordBridge } from './discord-bridge.js';
import { buildViewer, OPERATOR, maySee, mayManage, atLeast, LEVEL_WORDS } from './viewer.js';
import { cookieFrom, readSession, closeSession, sessionCookie, clearedCookie } from './auth.js';
import { handleAuthRoute, createRequestLimiter } from './auth-routes.js';
import { scopeStatus, scopeCampaign } from './scope.js';
import { runAction } from './actions.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
import { importAudio } from '../pipeline/import-audio.js';
import { sessionLabel } from '../export/naming.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { isSummariserReachable } from '../pipeline/model-client.js';

// The dashboard's API.
//
// node:http rather than a framework — this serves a JSON document and a short
// list of actions, and adding an HTTP stack to a bot that otherwise makes only
// outbound connections should cost as little as possible.
//
// Reachability is refreshed on its own slow timer rather than per request.
// The dashboard polls every few seconds; probing the PC's whisper server at
// that rate would put a steady trickle of traffic on the LAN forever, which
// is the opposite of the "don't congest the network" goal that set the rclone
// interval to six hours.
const PROBE_INTERVAL_MS = 60_000;

// A body big enough for any action here is a body someone is playing with.
const MAX_BODY_BYTES = 64 * 1024;

// Reads and writes are authenticated differently, on purpose.
//
// While this API was read-only, "no STATUS_TOKEN set" meaning "open" was a
// reasonable default on a home LAN: the worst it leaked was how many sessions
// had been recorded. Writes end that. An unauthenticated POST can spend the
// owner's API budget, seize the PC's GPU mid-evening, or stop the queue.
//
// So writes fail CLOSED: with no token configured there is no correct
// credential to present, and rather than treat that as "open to everyone" the
// server refuses every action and says why. Turning the dashboard from a
// window into a control panel has to be something the operator did on purpose.
function authorise({ req, url, cfg, mutating }) {
  if (!mutating) {
    if (!cfg.statusToken) return null;
    const given = url.searchParams.get('token') || req.headers['x-status-token'];
    return given === cfg.statusToken ? null : { status: 401, message: 'bad token' };
  }

  if (!cfg.statusToken) {
    return {
      status: 403,
      message:
        'This bot has no STATUS_TOKEN set, so it will not accept actions from the dashboard. ' +
        'Set STATUS_TOKEN in pi-service/.env (and in the dashboard) to enable them.',
    };
  }
  const given = url.searchParams.get('token') || req.headers['x-status-token'];
  return given === cfg.statusToken ? null : { status: 401, message: 'bad token' };
}

// WHO is asking, which is a different question from whether they may ask.
//
// The token above is a door key shared by everyone who can reach the dashboard;
// this is the name on the person walking through it. Both exist because they
// answer different things, and the order matters:
//
//   1. a signed-in Discord account, if there is one. Its level comes from what
//      that account owns, runs and plays in — see web/viewer.js.
//   2. otherwise the operator's own console, which is what the token has always
//      meant and still does.
//
// Sign-in therefore NARROWS what a request can see rather than widening it,
// which is the safe direction: a bug here shows somebody too little.
//
// DASHBOARD_REQUIRE_LOGIN flips (2) off, so an install that has invited its
// players in stops handing anyone with the token the keys to the machinery. It
// is off by default on purpose — turning it on before you have signed in once
// would lock you out of your own Pi.
function identify({ req, db, cfg, client }) {
  const token = cookieFrom(req.headers.cookie);
  const session = token ? readSession(db, cfg, token) : null;

  if (session) {
    const guildsOwned = [...(client?.guilds?.cache?.values?.() ?? [])]
      .filter((g) => g.ownerId === session.userId)
      .map((g) => g.id);
    return buildViewer({ db, cfg, userId: session.userId, username: session.username, guildsOwned });
  }

  return cfg.dashboardRequireLogin ? buildViewer({ db, cfg, userId: null }) : OPERATOR;
}

// What each action costs, and therefore who may fire it.
//
// Grouped by what is actually at stake rather than by what it is called:
//
//   machinery — spends the owner's GPU, API budget or disk, or stops the queue
//               for everybody. The owner's hardware, so the owner's decision.
//   manage    — reshapes one campaign's records. Whoever runs that table.
//
// Anything not listed is machinery. That default is the point: a new action
// added later is locked to dev until somebody deliberately decides otherwise,
// which is the failure direction that does not hand a player the pause button.
const ACTION_NEEDS = {
  'roster/search': 'manage',
  'roster/invite': 'manage',
  'roster/character': 'manage',
  'roster/forget': 'manage',
  'corrections/add': 'manage',
  'corrections/remove': 'manage',
  'corrections/replay': 'manage',
  'campaign/output': 'manage',
  // Ending somebody else's session is the operator's alone. A server owner
  // has `servers` too, so gating on that would hand it to them as well.
  'access/revoke': 'everything',
};

// The two actions you may aim at yourself wherever you are welcome.
//
// /campaign setchar has always let a player name their own character, and it
// is obviously theirs to name — the dashboard being stricter than the slash
// command for the same act was an accident of grouping it with the rest of the
// roster, not a decision.
const OWN_BUSINESS = new Set(['roster/character', 'roster/forget']);

function mayAct({ pathname, body, viewer, db }) {
  const name = /^\/actions\/(.+?)\/?$/.exec(pathname)?.[1];
  if (!name) return null; // unknown path — runAction 404s it properly

  if (OWN_BUSINESS.has(name) && viewer.userId && body?.userId === viewer.userId) {
    return maySee(viewer, Number(body?.campaignId))
      ? null
      : { status: 403, message: 'That is not a table you play at.' };
  }

  const needs = ACTION_NEEDS[name] ?? 'machinery';

  if (needs === 'everything') {
    return viewer.can.everything
      ? null
      : { status: 403, message: 'Only the bot owner can change who has access.' };
  }

  if (needs === 'machinery') {
    return viewer.can.machinery && viewer.can.approvals
      ? null
      : { status: 403, message: 'That is the bot owner\'s to decide — it spends their hardware or their API budget.' };
  }

  if (!viewer.can.manage) {
    return { status: 403, message: 'You can read this campaign, but not change it.' };
  }

  // Manage actions name a campaign, and a campaign you may manage is not the
  // same set as a campaign you may see. Resolved from the body rather than
  // trusted from it: an id you cannot manage is refused whatever else is true.
  const id = Number(body?.campaignId);
  if (!Number.isInteger(id) || id <= 0) return null; // the action's own validator will say so better

  // A campaign that does not exist is refused here too, rather than waved
  // through for the action to sort out. It used to defer, on the reasoning
  // that the action would validate — and corrections/add did not, so a made-up
  // id wrote a correction row belonging to no campaign. "Not a campaign you
  // run" is true of one that does not exist, and answering it here means every
  // future manage action inherits the check instead of having to remember it.
  return mayManage(viewer, id) && db.getCampaign(id)
    ? null
    : { status: 403, message: 'That is not a campaign you run.' };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
  });
}

// `discord` is injectable so the HTTP layer can be tested without a logged-in
// bot. It defaults to the real bridge; nothing in production passes it.
export function startStatusServer({
  db, cfg, client, activeSessions, startedAtMs = Date.now(),
  discord = null,
}) {
  if (!cfg.statusPort) return null;

  const reachability = { whisperServer: null, summariser: null, checkedAt: null };

  // Owned here rather than by the auth module, so two servers in one process
  // do not share one limiter — see createRequestLimiter.
  const tooSoon = createRequestLimiter();

  // Guarded against overlap: the on-demand probe below is a button anyone can
  // hold down, and each call opens two sockets with their own timeouts.
  let probing = false;
  async function probe() {
    if (probing) return;
    probing = true;
    try {
      reachability.whisperServer = await isWhisperServerReachable(cfg);
      reachability.summariser = await isSummariserReachable(cfg);
      reachability.checkedAt = new Date().toISOString();
    } catch {
      // A failed probe is itself the answer; never let it kill the timer.
    } finally {
      probing = false;
    }
  }
  probe();
  const probeTimer = setInterval(probe, PROBE_INTERVAL_MS);
  probeTimer.unref?.();

  // Expired codes and sessions are deleted rather than merely ignored: a table
  // of dead credentials is a table of things that could come back if a clock
  // moved. Swept hourly and checked again on every use, the same belt-and-
  // braces the consent invites get.
  db.sweepAuth();
  const sweepTimer = setInterval(() => {
    try {
      db.sweepAuth();
    } catch (err) {
      console.error('[auth] sweep failed:', err.message);
    }
  }, 60 * 60 * 1000);
  sweepTimer.unref?.();

  const send = (res, status, payload) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));

  // What an action may reach beyond the database and the config. Deliberately
  // small: the live recording map, so an import cannot start on top of a
  // session in progress, and one function that starts a long job.
  const ctx = {
    activeSessions,
    // Fire-and-forget: the answer arrives in the next status poll, not in the
    // response to the click.
    probeNow: () => { probe(); },
    // The things an action needs Discord itself for — finding a person by the
    // name their table knows them by, asking them whether they may be
    // recorded, and delivering a sign-in code. See web/discord-bridge.js.
    discord: discord ?? createDiscordBridge({ client, db, cfg }),
    // Started, not awaited. Downloading, converting and transcribing an
    // hours-long recording takes hours; the HTTP response says "started" and
    // progress shows up in the status snapshot like any other transcription.
    startImport({ campaignId, guildId, url, speakerLabel }) {
      console.log(`[import] starting for campaign ${campaignId} from ${url}`);
      importAudio({
        db,
        cfg,
        guildId,
        campaignId,
        channelId: null,
        channelName: 'imported',
        url,
        speakerLabel,
        onProgress: (stage) => console.log(`[import] ${stage}`),
      })
        .then((result) => console.log(`[import] finished — session #${result.meetingId}`))
        // Nothing is awaiting this, so an unhandled rejection here would take
        // the whole process down rather than failing one import.
        .catch((err) => console.error('[import] failed:', err));
    },
  };

  const server = createServer(async (req, res) => {
    // The dashboard may be served from another machine, so the browser needs
    // permission to talk to this. The allow-list is explicit about methods and
    // the token header now that POST exists — a wildcard that lets any page on
    // the internet fire actions at a LAN bot is a different thing entirely
    // from one that lets it read a session count.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Status-Token');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const mutating = req.method === 'POST';

    if (req.method !== 'GET' && !mutating) {
      send(res, 405, { ok: false, message: 'GET or POST only.' });
      return;
    }

    // Signing in still goes through the door.
    //
    // These three routes are how somebody without an IDENTITY gets one, which
    // is a different thing from being allowed to reach the API at all — and
    // the proxy adds the token to every request, so a browser on the dashboard
    // has it either way. Skipping the check here would leave a bot on an
    // exposed port able to be told "DM this person a code" by a stranger, at
    // whatever rate the limiter allowed.
    const doorman = authorise({ req, url, cfg, mutating });
    if (doorman) {
      send(res, doorman.status, { ok: false, message: doorman.message });
      return;
    }

    if (mutating && url.pathname.startsWith('/auth/')) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        send(res, 400, { ok: false, message: err.message });
        return;
      }
      const answer = await handleAuthRoute({
        pathname: url.pathname, body, req, db, cfg, ctx, tooSoon,
        // Only set Secure when the page really is on https, or the browser
        // silently discards the cookie and nobody can ever sign in on a LAN.
        secure: (req.headers['x-forwarded-proto'] ?? '') === 'https',
      });
      if (!answer) {
        send(res, 404, { ok: false, message: 'No such route.' });
        return;
      }
      if (answer.cookie) res.setHeader('Set-Cookie', answer.cookie);
      send(res, answer.status, answer.payload);
      return;
    }

    // Who is asking. Everything below is filtered by this rather than by the
    // token, so a signed-in player sees their games and nothing else.
    const viewer = identify({ req, db, cfg, client });

    if (mutating) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        send(res, 400, { ok: false, message: err.message });
        return;
      }

      const denial = mayAct({ pathname: url.pathname, body, viewer, db });
      if (denial) {
        send(res, denial.status, { ok: false, message: denial.message });
        return;
      }

      // Awaited unconditionally: most actions answer synchronously and `await`
      // on a plain object is a no-op, but the ones that talk to Discord cannot.
      const { status, payload, action } = await runAction({ pathname: url.pathname, body, db, cfg, ctx });
      // Logged because these are the operations that used to leave an audit
      // trail in a Discord DM. Losing that when they moved would mean a job
      // could change state with nothing anywhere recording who did it.
      if (action) {
        console.log(
          `[actions] ${action} by ${viewer.username ?? 'operator'} (${viewer.level}) -> ` +
            `${payload.ok ? 'ok' : 'refused'}: ${payload.message}`
        );
      }
      send(res, status, payload);
      return;
    }

    if (url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }

    // Who the page is talking to, so it can draw itself for them before it
    // asks for anything else.
    if (url.pathname === '/me') {
      send(res, 200, {
        signedIn: Boolean(viewer.userId),
        // Their own id, so the page can tell "this row is you" from "this row
        // is somebody else" without guessing from a display name.
        userId: viewer.userId,
        username: viewer.username,
        level: viewer.level,
        sees: LEVEL_WORDS[viewer.level],
        can: viewer.can,
        campaigns: viewer.campaignIds.length,
        loginRequired: Boolean(cfg.dashboardRequireLogin),
        // Whether signing in is even possible on this install, so the page can
        // say "not configured" instead of failing at the code step.
        signInAvailable: Boolean(cfg.authSecret || cfg.statusToken),
      });
      return;
    }

    // One campaign in full — roster, corrections, sessions. Kept out of
    // /status because that is polled every few seconds by everyone with the
    // page open, and this changes a few times a month. See web/campaign-view.js.
    if (url.pathname === '/campaign') {
      const id = Number(url.searchParams.get('id'));
      const view = Number.isInteger(id) && id > 0 ? buildCampaignView({ db, campaignId: id }) : null;
      // A campaign this viewer may not see answers 404, not 403. "You are not
      // allowed to see campaign 7" tells a stranger that campaign 7 exists,
      // which is the thing they were trying to find out.
      if (!view || !maySee(viewer, id)) {
        send(res, 404, { ok: false, message: 'No such campaign.' });
        return;
      }
      send(res, 200, scopeCampaign(view, viewer));
      return;
    }

    // One session's notes. The recap used to be readable only where it was
    // posted — a Discord message that scrolls away — or in the exported
    // markdown on whichever machine the vault syncs to. Neither is a way to
    // look something up.
    if (url.pathname === '/notes') {
      const id = Number(url.searchParams.get('meeting'));
      const view = Number.isInteger(id) && id > 0 ? buildNotesView({ db, meetingId: id }) : null;
      if (!view || !maySee(viewer, view.campaignId)) {
        send(res, 404, { ok: false, message: 'No such session.' });
        return;
      }
      send(res, 200, view);
      return;
    }

    // The transcript as plain text — what /export attached to a Discord
    // message. Served rather than downloaded-by-link because the page cannot
    // add the auth header to a plain <a href>, and a transcript is exactly the
    // thing that should not be reachable without one.
    if (url.pathname === '/transcript') {
      const id = Number(url.searchParams.get('meeting'));
      const meeting = Number.isInteger(id) && id > 0 ? db.getMeeting(id) : null;
      if (!meeting || !maySee(viewer, meeting.campaign_id)) {
        send(res, 404, { ok: false, message: 'No such session.' });
        return;
      }
      // A recap is the table's shared account of an evening. A transcript is
      // every word five people said, and being at the table is not the same as
      // being handed that — so players get the notes and not this.
      if (!viewer.can.transcripts) {
        send(res, 403, { ok: false, message: 'You can read the notes for this session, but not the transcript.' });
        return;
      }

      // Two readers of the same transcript, and they want different things.
      // A file you keep is plain text — the default, and what /export always
      // attached. A page you search wants the lines apart: clock, speaker,
      // words, plus who talked most. Same URL, because it is the same
      // transcript, and one of them would otherwise be a second route that
      // could drift from this one on auth.
      if (url.searchParams.get('format') === 'json') {
        send(res, 200, buildTranscriptView({ db, meetingId: id }));
        return;
      }

      const text = buildTranscriptText(db.listUtterances(id));
      res
        .writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${sessionLabel(meeting)}.txt"`,
        })
        .end(text || '(no transcript yet)');
      return;
    }

    if (url.pathname !== '/status') {
      send(res, 404, { ok: false, message: 'not found' });
      return;
    }

    try {
      const body = JSON.stringify(
        scopeStatus(buildStatus({ db, cfg, client, activeSessions, reachability, startedAtMs }), viewer)
      );
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    } catch (err) {
      console.error('[status] failed to build snapshot:', err.message);
      send(res, 500, { ok: false, message: 'snapshot failed' });
    }
  });

  // A dashboard must never be able to take the bot down.
  server.on('error', (err) => console.error('[status] server error:', err.message));
  server.listen(cfg.statusPort, cfg.statusHost, () => {
    console.log(`Status API on http://${cfg.statusHost}:${cfg.statusPort}/status`);
    // Said out loud at boot because a dashboard whose buttons all fail with
    // 403 looks broken, and the cause — one unset variable — is invisible
    // from the page.
    console.log(
      cfg.statusToken
        ? 'Dashboard actions enabled (STATUS_TOKEN is set).'
        : 'Dashboard actions DISABLED — set STATUS_TOKEN to allow approvals from the dashboard.'
    );
  });

  // The server itself as well as the stopper, so a caller that asked for port
  // 0 can find out which port it actually got. index.js ignores both.
  return {
    server,
    close: () => {
      clearInterval(probeTimer);
      clearInterval(sweepTimer);
      server.close();
    },
  };
}
