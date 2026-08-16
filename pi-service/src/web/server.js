import { createServer } from 'node:http';

import { buildStatus } from './status.js';
import { buildCampaignView } from './campaign-view.js';
import { runAction } from './actions.js';
import { buildTranscriptText } from '../pipeline/transcribe.js';
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

export function startStatusServer({ db, cfg, client, activeSessions, startedAtMs = Date.now() }) {
  if (!cfg.statusPort) return null;

  const reachability = { whisperServer: null, summariser: null };

  async function probe() {
    try {
      reachability.whisperServer = await isWhisperServerReachable(cfg);
      reachability.summariser = await isSummariserReachable(cfg);
    } catch {
      // A failed probe is itself the answer; never let it kill the timer.
    }
  }
  probe();
  const probeTimer = setInterval(probe, PROBE_INTERVAL_MS);
  probeTimer.unref?.();

  const send = (res, status, payload) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));

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

    const refusal = authorise({ req, url, cfg, mutating });
    if (refusal) {
      send(res, refusal.status, { ok: false, message: refusal.message });
      return;
    }

    if (mutating) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        send(res, 400, { ok: false, message: err.message });
        return;
      }
      const { status, payload, action } = runAction({ pathname: url.pathname, body, db, cfg });
      // Logged because these are the operations that used to leave an audit
      // trail in a Discord DM. Losing that when they moved would mean a job
      // could change state with nothing anywhere recording who did it.
      if (action) console.log(`[actions] ${action} -> ${payload.ok ? 'ok' : 'refused'}: ${payload.message}`);
      send(res, status, payload);
      return;
    }

    if (url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }

    // One campaign in full — roster, corrections, sessions. Kept out of
    // /status because that is polled every few seconds by everyone with the
    // page open, and this changes a few times a month. See web/campaign-view.js.
    if (url.pathname === '/campaign') {
      const id = Number(url.searchParams.get('id'));
      const view = Number.isInteger(id) && id > 0 ? buildCampaignView({ db, campaignId: id }) : null;
      if (!view) {
        send(res, 404, { ok: false, message: 'No such campaign.' });
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
      if (!meeting) {
        send(res, 404, { ok: false, message: 'No such session.' });
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
        buildStatus({ db, cfg, client, activeSessions, reachability, startedAtMs })
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
      server.close();
    },
  };
}
