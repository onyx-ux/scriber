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
// "If that name is on a table here, the code is on its way" is the same answer
// whether or not it is, so this cannot be used to find out who plays what.
import { issueCode, checkCode, openSession, closeSession, sessionCookie, clearedCookie, cookieFrom } from './auth.js';

// Deliberately identical for every outcome that is not a successful sign-in.
const SENT = 'If that name belongs to somebody at a table on this bot, a code is on its way to their Discord DMs.';

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
    return { status: 400, payload: { ok: false, message: 'Type the Discord name you use here.' } };
  }
  if (tooSoon?.(name.toLowerCase())) {
    return { status: 429, payload: { ok: true, message: SENT } };
  }

  // Resolved against people the bot already knows, never against Discord at
  // large: this must not become a way to make the bot DM a stranger.
  const person = await findKnownPerson({ db, ctx, name });
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
    db.dropAuthCode(person.userId);
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

  // The code was issued against a user id, so the name has to resolve to the
  // same person it was sent to. Looked up in the local tables only — by this
  // point the account is one the bot has already DMed.
  const person = findLocalPerson(db, name);
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

// People the bot has actually seen: anybody with a consent record, a character
// name, or a transcribed line. Matched case-insensitively against the display
// name transcripts are filed under.
//
// A local match is tried first because it costs nothing and covers everyone who
// has ever played. Discord's member search is the fallback, for the player who
// has been invited but has not spoken yet.
function findLocalPerson(db, name) {
  const wanted = name.toLowerCase();
  const rows = db.raw
    .prepare(
      `SELECT DISTINCT u.user_id AS userId, u.display_name AS username
         FROM utterances u
        WHERE lower(u.display_name) = ?
        LIMIT 2`
    )
    .all(wanted);

  // Two people at different tables sharing a display name is a real thing, and
  // guessing which one is worse than refusing: the wrong person would get a
  // code for somebody else's account.
  return rows.length === 1 ? rows[0] : null;
}

async function findKnownPerson({ db, ctx, name }) {
  const local = findLocalPerson(db, name);
  if (local) return local;

  const finder = ctx?.discord?.findKnownMember;
  if (typeof finder !== 'function') return null;

  // Scoped to guilds the bot is in, and to members of them. A name that
  // matches nobody the bot shares a server with resolves to nothing.
  const found = await finder({ query: name });
  return found ?? null;
}
