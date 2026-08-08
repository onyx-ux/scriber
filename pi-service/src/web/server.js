import { createServer } from 'node:http';

import { buildStatus } from './status.js';
import { isWhisperServerReachable } from '../stt/whisper.js';
import { isSummariserReachable } from '../pipeline/model-client.js';

// A tiny read-only status API for the dashboard.
//
// node:http rather than a framework — this serves exactly one JSON document
// and adding an HTTP stack to a bot that otherwise makes only outbound
// connections should cost as little as possible.
//
// Reachability is refreshed on its own slow timer rather than per request.
// The dashboard polls every few seconds; probing the PC's whisper server at
// that rate would put a steady trickle of traffic on the LAN forever, which
// is the opposite of the "don't congest the network" goal that set the rclone
// interval to six hours.
const PROBE_INTERVAL_MS = 60_000;

// GET only, one route. Anything else is a mistake or a scan.
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

  const server = createServer((req, res) => {
    // The dashboard is a static page served from another machine, so the
    // browser needs permission to read this. Safe because the payload is
    // read-only operational data with no secrets in it.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' }).end('{"error":"GET only"}');
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    // Optional shared secret. Unset means open, which is the sensible default
    // for a read-only endpoint on a home LAN; set STATUS_TOKEN if this is ever
    // reachable from anywhere else.
    if (cfg.statusToken) {
      const given = url.searchParams.get('token') || req.headers['x-status-token'];
      if (given !== cfg.statusToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"bad token"}');
        return;
      }
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url.pathname !== '/status') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
      return;
    }

    try {
      const body = JSON.stringify(
        buildStatus({ db, cfg, client, activeSessions, reachability, startedAtMs })
      );
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    } catch (err) {
      console.error('[status] failed to build snapshot:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"snapshot failed"}');
    }
  });

  // A dashboard must never be able to take the bot down.
  server.on('error', (err) => console.error('[status] server error:', err.message));
  server.listen(cfg.statusPort, cfg.statusHost, () => {
    console.log(`Status API on http://${cfg.statusHost}:${cfg.statusPort}/status`);
  });

  return () => {
    clearInterval(probeTimer);
    server.close();
  };
}
