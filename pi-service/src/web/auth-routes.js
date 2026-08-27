// The three requests that make up signing in.
//
//   GET  /auth/discord   -> off to Discord to be asked
//   GET  /auth/callback  -> back from Discord, with a session cookie
//   POST /auth/logout    -> the session is destroyed
//
// Two of them are browser NAVIGATIONS rather than fetches, which is what makes
// this different from every other route on this server. The page does not call
// them and read a JSON answer; it points the window at the first one and gets
// the third one back some seconds later, having been somewhere else entirely in
// between. So these answer with redirects and cookies, not payloads, and the
// only thing they ever say out loud is a short reason on the way back when
// something went wrong.
//
// Kept out of the closed ACTIONS table on purpose: every action there requires
// a credential, and these are how you get one. They are also the only routes on
// this server that a stranger is meant to be able to reach, so each one is
// written to give a stranger nothing — there is no name to type here any more,
// so there is nothing left to confirm or deny about who plays what.
import {
  openSession,
  closeSession,
  newState,
  askedForConsent,
  stateMatches,
  sessionCookie,
  stateCookie,
  clearedCookie,
  clearedStateCookie,
  cookieFrom,
  STATE_COOKIE,
} from './auth.js';
import { authorizeUrl, identifyByCode, oauthReady } from './discord-oauth.js';
import { maySignIn } from './authority.js';

export async function handleAuthRoute({ pathname, method = 'POST', url, body, req, db, cfg, secure, fetchImpl }) {
  if (method === 'GET' && pathname === '/auth/discord') return start({ cfg, secure });
  if (method === 'GET' && pathname === '/auth/callback') return callback({ url, req, db, cfg, secure, fetchImpl });
  if (method === 'POST' && pathname === '/auth/logout') return logout({ body, req, db, cfg, secure });
  return null;
}

// --- off to Discord ---

// The state goes out twice at once: on the URL, where Discord will hand it
// back, and into a cookie, where only this browser has it. A callback that
// carries both, matching, is one this browser actually started.
function start({ cfg, secure, consent = false }) {
  const ready = oauthReady(cfg);
  if (!ready.ok) return refuse(cfg, 'config', { secure });

  const state = newState({ consent });
  return {
    redirect: authorizeUrl(cfg, { state, consent }),
    cookie: stateCookie(state, { secure }),
  };
}

// --- back from Discord ---

async function callback({ url, req, db, cfg, secure, fetchImpl }) {
  const held = cookieFrom(req.headers.cookie, STATE_COOKIE);
  const given = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  // Checked before anything else is even looked at, and certainly before a
  // single request leaves for Discord. A callback nobody here started is not
  // half a sign-in to be diagnosed; it is somebody else's link, and the only
  // correct amount of work to do on it is none.
  if (!stateMatches(held, given)) return refuse(cfg, 'state', { secure });

  // "They have not authorised this app before", which is not a failure — it is
  // Discord answering prompt=none honestly. Asked properly this time, with a
  // fresh state that says so, so a Discord that keeps saying it cannot bounce
  // the browser round this loop for ever.
  if (error === 'consent_required' && !askedForConsent(held)) {
    return start({ cfg, secure, consent: true });
  }

  // Anything else Discord sends back with an `error` is the person having said
  // no, or the app being misconfigured at Discord's end. Both are final.
  if (error || !code) return refuse(cfg, error === 'access_denied' ? 'denied' : 'discord', { secure });

  const who = await identifyByCode({ cfg, code, fetchImpl });
  if (!who.ok) return refuse(cfg, who.reason === 'config' ? 'config' : 'discord', { secure });

  // Discord has said who they are. Whether this bot wants them is a separate
  // question, and it is asked BEFORE a session exists rather than after — a
  // row written and then reasoned about is a row that outlives the reasoning.
  if (!maySignIn(cfg, who.userId, db)) {
    // The only trace a turned-away sign-in leaves. No session row is written,
    // so without this line somebody being refused over and over is invisible.
    console.log(`[auth] refused ${who.username} (${who.userId}) — not on the guest list`);
    return refuse(cfg, 'notinvited', { secure });
  }

  const session = openSession(db, cfg, { userId: who.userId, username: who.username });
  if (!session) return refuse(cfg, 'secret', { secure });

  return {
    redirect: dashboard(cfg),
    // Both cookies, in one response: the attempt is spent whether or not it
    // worked, and leaving a live state behind would leave a second callback
    // able to use it.
    cookie: [clearedStateCookie({ secure }), sessionCookie(session.token, { secure })],
  };
}

// --- signing out ---

function logout({ body, req, db, cfg, secure }) {
  const token = cookieFrom(req.headers.cookie);
  const ended = closeSession(db, cfg, token, { everywhere: body?.everywhere === true });
  return {
    status: 200,
    payload: {
      ok: true,
      message: ended > 1 ? `Signed out of ${ended} sessions.` : 'Signed out.',
    },
    cookie: clearedCookie({ secure }),
  };
}

// --- where the browser ends up ---

// Back to the page they left, either way.
//
// A failed sign-in is a person standing in front of a blank browser tab on a
// URL they have never seen, and the honest thing to do is put them back where
// the button was with a word about what happened. The reason travels as a
// fragment rather than a query so nginx needs no rewrite and the page can read
// it without a round trip; the page maps it to a sentence, because these are
// five words for a machine and none of them is an explanation.
function dashboard(cfg, hash = '') {
  const home = (() => {
    if (!cfg?.dashboardUrl) return '/app/';
    try {
      return new URL('/app/', cfg.dashboardUrl).toString();
    } catch {
      return '/app/';
    }
  })();
  return `${home}${hash}`;
}

function refuse(cfg, reason, { secure = false } = {}) {
  return {
    redirect: dashboard(cfg, `#signin-error=${reason}`),
    cookie: clearedStateCookie({ secure }),
  };
}
