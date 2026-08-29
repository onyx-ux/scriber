import { createServer } from 'node:http';

import { buildStatus } from './status.js';
import { accessRoster } from './access.js';
import { allowanceFor } from '../access/tiers.js';
import { buildCampaignView } from './campaign-view.js';
import { buildNotesView } from './notes-view.js';
import { buildTranscriptView } from './transcript-view.js';
import { createDiscordBridge } from './discord-bridge.js';
// Every question about who may do what goes through this one module — the
// door, the name, the act, the acting id, and the cut. See web/authority.js.
import {
  checkDoor,
  identify,
  mayAct,
  actingUserId,
  maySee,
  mayManage,
  LEVEL_WORDS,
  scopeStatus,
  scopeCampaign,
} from './authority.js';
import { handleAuthRoute } from './auth-routes.js';
import { sweepExpired, authSecret } from './auth.js';
import { oauthReady, redirectUri as discordRedirectUri } from './discord-oauth.js';
import { guildsCreatableBy } from '../campaign/create.js';
import { restorableBy, mayDelete } from '../campaign/archive.js';
import { pendingRestoreRequests } from '../campaign/restore-request.js';
import { notifyRestoreRequested, notifyRestoreDecided } from '../delivery/restore-notify.js';
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
// bot, and `fetchImpl` so the sign-in flow can be driven against a model of
// Discord's OAuth API rather than the internet. Both default to the real
// thing; nothing in production passes either.
export function startStatusServer({
  db, cfg, client, activeSessions, startedAtMs = Date.now(),
  discord = null, fetchImpl = undefined,
}) {
  if (!cfg.statusPort) return null;

  const reachability = { whisperServer: null, summariser: null, checkedAt: null };

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

  // Expired sessions are deleted rather than merely ignored: a table of dead
  // credentials is a table of things that could come back if a clock moved.
  // Swept hourly and checked again on every use, the same belt-and-braces the
  // consent invites get.
  //
  // The model usage log is swept on the same timer, which is what its own
  // comment in store/db.js has always claimed happened — it said "swept with
  // the auth tables" while nothing anywhere called it, so a long-running bot
  // kept every row it had ever written. The dashboard reads a fortnight back;
  // ninety days is already generous.
  const sweep = () => {
    try {
      sweepExpired(db);
    } catch (err) {
      console.error('[auth] sweep failed:', err.message);
    }
    try {
      db.pruneModelUsage();
    } catch (err) {
      console.error('[usage] prune failed:', err.message);
    }
  };
  sweep();
  const sweepTimer = setInterval(sweep, 60 * 60 * 1000);
  sweepTimer.unref?.();

  const send = (res, status, payload) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));

  // What an action may reach beyond the database and the config. Deliberately
  // small: the live recording map, so an import cannot start on top of a
  // session in progress, and one function that starts a long job.
  const ctx = {
    activeSessions,
    // Every Discord the bot is in, so an action can check a chosen server
    // against reality rather than against what the browser claimed.
    guilds: () => [...(client?.guilds?.cache?.values?.() ?? [])].map((g) => ({ id: g.id, name: g.name ?? g.id })),
    // Which Discords a given account owns. The one part of somebody's level
    // that cannot be worked out from the database, so an action that has to
    // know what a person's level WOULD be has to come through here.
    guildsOwnedBy: (userId) =>
      [...(client?.guilds?.cache?.values?.() ?? [])]
        .filter((g) => g.ownerId === userId)
        .map((g) => g.id),
    // Started, not awaited. A DM that fails costs somebody knowing promptly,
    // never the request itself.
    notifyRestore: (requestId) => {
      notifyRestoreRequested({ discordClient: client, db, cfg, requestId }).catch(() => {});
    },
    notifyRestoreDecided: ({ request, approved, name }) => {
      notifyRestoreDecided({ discordClient: client, cfg, request, approved, name }).catch(() => {});
    },
    // Fire-and-forget: the answer arrives in the next status poll, not in the
    // response to the click.
    probeNow: () => { probe(); },
    // The two things an action needs Discord itself for — finding a person by
    // the name their table knows them by, and asking them whether they may be
    // recorded. See web/discord-bridge.js.
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
    // exposed port able to be walked through a sign-in by a stranger.
    const doorman = checkDoor({ req, url, cfg, mutating });
    if (doorman) {
      send(res, doorman.status, { ok: false, message: doorman.message });
      return;
    }

    // Signing in, which is the only part of this API a BROWSER navigates to
    // rather than fetches. Two of its three routes are GETs for that reason,
    // so this is matched on the path before the method rather than after it —
    // and it has to come before `identify` below, because the whole point of
    // these routes is that the person walking through them has no identity yet.
    if (url.pathname.startsWith('/auth/')) {
      let body = {};
      if (mutating) {
        try {
          body = await readJsonBody(req);
        } catch (err) {
          send(res, 400, { ok: false, message: err.message });
          return;
        }
      }
      const answer = await handleAuthRoute({
        pathname: url.pathname, method: req.method, url, body, req, db, cfg, fetchImpl,
        // Only set Secure when the page really is on https, or the browser
        // silently discards the cookie and nobody can ever sign in on a LAN.
        secure: (req.headers['x-forwarded-proto'] ?? '') === 'https',
      });
      if (!answer) {
        send(res, 404, { ok: false, message: 'No such route.' });
        return;
      }
      // An array is two cookies in one response, which the sign-in callback
      // needs: the spent attempt is cleared and the session is opened at the
      // same moment. node:http sends one Set-Cookie header per entry.
      if (answer.cookie) res.setHeader('Set-Cookie', answer.cookie);
      if (answer.redirect) {
        // 302 rather than 303: the browser got here by GET and is going on by
        // GET, so there is no method to rewrite, and 302 is what every OAuth
        // implementation on the internet already agrees on.
        res.writeHead(302, { Location: answer.redirect }).end();
        return;
      }
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
      const { status, payload, action } = await runAction({ pathname: url.pathname, body, db, cfg, ctx: { ...ctx, viewer } });
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
        // Their own tier and what it buys. Sent to everybody rather than held
        // back: "you have four questions left today" is a thing a person needs
        // before they run out, not after.
        ...allowanceFor(db, cfg, viewer.userId),
        // Whether signing in is even possible on this install, so the page can
        // say "not configured" rather than sending somebody to Discord to be
        // told off by a screen that mentions none of this bot's settings.
        //
        // Two halves: Discord has to know this app (the OAuth credentials and
        // a redirect it will accept) and the bot has to have a key to hash the
        // session cookie with. Missing either means nobody can sign in, and the
        // page names which one rather than making the operator guess.
        ...signInReadiness(cfg),
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
      const scoped = scopeCampaign(view, viewer);
      // Deleting is a narrower authority than managing: a server owner may
      // manage a campaign in their Discord, but only whoever runs it may delete
      // it. Answered here so the page draws the button for exactly the people
      // the action would accept, rather than offering it and then refusing.
      scoped.viewerCan = {
        ...(scoped.viewerCan ?? {}),
        delete: mayDelete({
          campaign: db.getCampaign(id),
          userId: actingUserId(viewer, cfg),
          cfg,
          db,
        }),
      };

      // Where the write-ups could be sent, which is a question only Discord
      // answers. Attached AFTER scoping for the same reason canCreateIn is on
      // /status: a field added here can only ever widen a payload that has
      // already been cut to the viewer, never smuggle something past the cut.
      //
      // Only for somebody who may change the destination — to everybody else
      // it is a list of the server's channels, which is not a thing a player
      // asked about a campaign is owed.
      //
      // Fetched on open rather than on the poll. This changes when somebody
      // makes a channel, which is not five-seconds-often, and hanging the
      // campaign screen on Discord being reachable would be a poor trade for
      // a list that is stale by a minute at worst. If it cannot be had, the
      // page keeps the picker shut and says why — the same state the switch
      // was permanently in before any of this existed.
      if (mayManage(viewer, id)) {
        const channels = await ctx.discord
          ?.listChannels?.({ guildId: view.guildId })
          .catch(() => null);
        if (channels?.ok) scoped.postableChannels = channels.channels;
      }

      send(res, 200, scoped);
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

    // Who can sign in to this bot, for the page at /gatehouse/.
    //
    // Its own route rather than a section of /status, because the two are read
    // on completely different rhythms: /status twelve times a minute by
    // everyone at the table, this a few times a month by one person. Building
    // a level for every person the bot has ever seen is the most expensive
    // question this server answers, and it should be asked when somebody wants
    // the answer.
    //
    // 403 rather than a quiet empty roster: "you may not have this" and
    // "nobody has ever signed in" look identical in an empty array, and only
    // one of them is worth telling somebody.
    if (url.pathname === '/access') {
      if (!viewer.can?.everything) {
        send(res, 403, { ok: false, message: 'Only the bot owner can see who has access.' });
        return;
      }
      send(res, 200, accessRoster({ db, cfg, client, viewer }));
      return;
    }

    if (url.pathname !== '/status') {
      send(res, 404, { ok: false, message: 'not found' });
      return;
    }

    try {
      const payload = scopeStatus(
        // The viewer goes IN as well as being applied after. A section this
        // person may not read is not built, which is what stops a player's
        // five-second poll paying to assemble the access roster and the queue
        // before scopeStatus throws them away. scopeStatus still runs: it is
        // the fail-closed list of what may leave, and it stays the thing that
        // decides, the same belt-and-braces the auth sweep gets.
        buildStatus({ db, cfg, client, activeSessions, reachability, startedAtMs, viewer }),
        viewer
      );

      // Which servers this viewer could start a campaign in. Computed here
      // rather than in scopeStatus because it needs Discord, and attached
      // after scoping so it can only ever be added to a payload, never widen
      // one.
      const creatable = guildsCreatableBy({ db, viewer, guilds: ctx.guilds() });
      if (creatable.length) payload.canCreateIn = creatable;

      // Campaigns this viewer deleted and can still bring back. Only ever
      // their own, and only while the window is open.
      //
      // Asked as a single question now: a request with no acting id has nobody
      // to list campaigns FOR, and asking anyway used to reach
      // listArchivedCampaigns({ userId: undefined }) on an install whose owner
      // was never configured.
      const acting = actingUserId(viewer, cfg);
      const waiting = acting ? restorableBy({ db, cfg, userId: acting }) : [];
      // Restore tickets waiting on a decision. The operator's queue, so it
      // rides behind the same capability as the access roster.
      if (viewer.can?.everything) {
        const queue = pendingRestoreRequests({ db });
        if (queue.length) payload.restoreQueue = queue;
      }

      if (waiting.length) {
        payload.restorable = waiting.map((c) => ({
          id: c.id, name: c.name ?? c.channel_name, sessions: c.sessions, daysLeft: c.daysLeft,
        }));
      }

      const body = JSON.stringify(payload);
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
    // Said at boot for the same reason as the line above: a "Sign in with
    // Discord" button that dead-ends is invisible from here, and the cause is
    // always one unset variable or a redirect that Discord has never been told
    // about. Printed so it can be checked against the developer portal.
    const ready = oauthReady(cfg);
    console.log(
      !authSecret(cfg)
        ? 'Discord sign-in DISABLED — set STATUS_TOKEN or AUTH_SECRET to hash session cookies with.'
        : ready.ok
          ? `Discord sign-in enabled — redirect ${discordRedirectUri(cfg)}`
          : `Discord sign-in DISABLED — ${ready.missing} is not set.`
    );
  });

  // The server itself as well as the stopper, so a caller that asked for port
  // 0 can find out which port it actually got. index.js ignores both.
  return {
    server,
    // Resolves once the last request in flight has been answered, rather than
    // merely asking the server to stop and returning.
    //
    // The difference matters to whoever owns the database: closing it while a
    // handler is still mid-query throws "the database connection is not open"
    // out of an HTTP callback, where nothing is waiting to catch it. The
    // dashboard opens one request per session on the campaign screen, so there
    // are usually several in the air.
    //
    // Idle keep-alive connections are dropped explicitly — they would never end
    // on their own, and close() waits for every connection, not just the busy
    // ones. index.js ignores the return, as it always has.
    close: () => {
      clearInterval(probeTimer);
      clearInterval(sweepTimer);
      const done = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      return done;
    },
  };
}

// Whether this install can sign anybody in, in the two halves it can fail on:
// Discord has to know this app (the OAuth credentials and a redirect it will
// accept) and the bot has to have a key to hash the session cookie with.
//
// Named rather than reduced to a boolean because each half is a line somebody
// forgot to fill in, and "sign-in is not configured" sends them to read the
// whole .env looking for which one. Said here as well as at boot, because a
// dashboard is read far more often than a log.
function signInReadiness(cfg) {
  const ready = oauthReady(cfg);
  const secret = authSecret(cfg);
  return {
    signInAvailable: Boolean(ready.ok && secret),
    signInMissing: ready.missing ?? (secret ? null : 'STATUS_TOKEN or AUTH_SECRET'),
  };
}
