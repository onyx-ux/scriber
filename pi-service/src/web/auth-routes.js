// The three requests that make up signing in.
//
//   POST /auth/request  { name }        -> the bot DMs six digits
//   POST /auth/verify   { name, code }  -> a session cookie
//   POST /auth/logout   {}              -> the session is destroyed
//
// Kept out of the closed ACTIONS table on purpose: every action there requires
// a credential, and these are how you get one. They are also the only routes on
// this server that a stranger is meant to be able to reach, so each one is
// written to give a stranger nothing.
//
// The rule that shapes all of it: never confirm or deny that an account exists.
// "If that username is on a table here, the code is on its way" is the same
// answer whether or not it is, so this cannot be used to find out who plays
// what.
//
// Identity here is the Discord USERNAME — not a display name, not a server
// nickname, not a character name. See findKnownPerson at the foot of this file.
import {
  issueCode,
  checkCode,
  openSession,
  closeSession,
  abandonCode,
  whoWasSentACode,
  sessionCookie,
  clearedCookie,
  cookieFrom,
} from './auth.js';

// Deliberately identical for every outcome that is not a successful sign-in.
const SENT = 'If that username belongs to somebody at a table on this bot, a code is on its way to their Discord DMs.';

// A person asking for codes in a loop is either locked out or probing. Either
// way one every thirty seconds is plenty, and the limiter is keyed on the
// requested name rather than the IP so a shared LAN address does not lock a
// household out of each other's accounts.
//
// Owned by the server that created it rather than by this module. A limiter
// living in module scope is shared by every server in the process, which is
// invisible until two of them exist — in a test file, or the day somebody runs
// two bots side by side.
const REQUEST_GAP_MS = 30_000;

export function createRequestLimiter({ gapMs = REQUEST_GAP_MS } = {}) {
  const asked = new Map();
  return (key, now = Date.now()) => {
    const last = asked.get(key) ?? 0;
    if (now - last < gapMs) return true;
    asked.set(key, now);
    // Bounded by trimming what has aged out whenever it is touched. A
    // dashboard does not need an eviction policy, but it does need not to grow
    // for ever.
    if (asked.size > 500) {
      for (const [k, t] of asked) if (now - t > gapMs) asked.delete(k);
    }
    return false;
  };
}

export async function handleAuthRoute({ pathname, body, req, db, cfg, ctx, secure, tooSoon }) {
  if (pathname === '/auth/request') return requestCode({ body, db, cfg, ctx, tooSoon });
  if (pathname === '/auth/verify') return verify({ body, db, cfg, secure });
  if (pathname === '/auth/logout') return logout({ body, req, db, cfg, secure });
  return null;
}

async function requestCode({ body, db, cfg, ctx, tooSoon }) {
  const name = String(body?.name ?? '').trim().replace(/^@/, '');
  if (name.length < 2) {
    return { status: 400, payload: { ok: false, message: 'Type your Discord username — the @handle, not your display name.' } };
  }
  if (tooSoon?.(name.toLowerCase())) {
    return { status: 429, payload: { ok: true, message: SENT } };
  }

  // Resolved against people the bot already knows, never against Discord at
  // large: this must not become a way to make the bot DM a stranger.
  const person = await findKnownPerson({ ctx, name });
  if (!person) return { status: 200, payload: { ok: true, message: SENT } };

  const issued = issueCode(db, cfg, { userId: person.userId, username: person.username });
  if (!issued.ok) {
    return { status: 503, payload: { ok: false, message: 'Sign-in is not configured on this bot.' } };
  }

  const sent = await ctx?.discord?.sendCode?.({
    userId: person.userId,
    code: issued.code,
    username: person.username,
  });

  if (!sent?.ok) {
    // The one case worth breaking the uniform answer for, because it is not
    // about whether the account exists — it is about that account's DM
    // settings, and without saying so the person retries for ever.
    abandonCode(db, person.userId);
    return {
      status: 200,
      payload: {
        ok: false,
        message:
          'That account has direct messages turned off for this server, so the code cannot be delivered. ' +
          'Turn DMs on for the server and try again.',
      },
    };
  }

  return { status: 200, payload: { ok: true, message: SENT } };
}

function verify({ body, db, cfg, secure }) {
  const name = String(body?.name ?? '').trim().replace(/^@/, '');
  const code = String(body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return { status: 400, payload: { ok: false, message: 'The code is six digits.' } };
  }

  // Who did we actually send a code to under this username?
  //
  // The live code row is the record of that, so it is the only thing consulted
  // here. This used to try a transcript-display-name lookup first, which could
  // answer with a DIFFERENT person than the one the code went to — the request
  // step DMs whoever owns the username, and this step resolved whoever had
  // been recorded under it. Two accounts, one typed string, and a code that
  // could never verify.
  //
  // Deliberately not asking Discord again: only /auth/request is rate limited,
  // and putting a member search behind this route would hand a stranger an
  // unrated one.
  const person = whoWasSentACode(db, name);
  if (!person) return { status: 401, payload: { ok: false, message: 'That code is not right.' } };

  const result = checkCode(db, cfg, { userId: person.userId, code });
  if (!result.ok) return { status: 401, payload: { ok: false, message: result.message } };

  const session = openSession(db, cfg, { userId: result.userId, username: result.username });
  if (!session) {
    return { status: 503, payload: { ok: false, message: 'Sign-in is not configured on this bot.' } };
  }

  return {
    status: 200,
    payload: { ok: true, username: result.username, message: `Signed in as ${result.username}.` },
    cookie: sessionCookie(session.token, { secure }),
  };
}

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

// --- who is this ---

// Who is this, by Discord username.
//
// This used to try the local transcript table first, matching whatever display
// name a person happened to be recorded under, and only fall back to Discord.
// That made the display name an identity, which it is not: it is per-server,
// changeable at will, and frequently the character rather than the person. A
// player who typed their real username got nowhere, while somebody typing a
// display name could be routed to whoever else had used it.
//
// So there is one lookup now, against the one handle Discord treats as
// identity. Scoped to guilds the bot is in and to members of them — a username
// matching nobody the bot shares a server with resolves to nothing. See
// findAcrossGuilds in web/discord-bridge.js.
async function findKnownPerson({ ctx, name }) {
  const finder = ctx?.discord?.findKnownMember;
  if (typeof finder !== 'function') return null;

  const found = await finder({ query: name });
  return found ?? null;
}
