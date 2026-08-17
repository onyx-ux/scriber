// Signing in to the dashboard, without ever holding a password.
//
// You type the Discord name the bot already knows you by. The bot DMs you six
// digits. Typing them back proves you can read that account's DMs, which is
// exactly as strong a claim as "you control that Discord account" — and that is
// the only identity this bot has ever cared about. Every permission it grants is
// derived from what that account owns, runs or plays in.
//
// So there is no password to choose, forget, reuse or leak, and nothing stored
// that a database leak would make worse: a Discord id and a username, both
// public in any server you share. The code is stored as an HMAC and the session
// cookie is stored as an HMAC, so neither table can be turned back into a
// credential.
//
// The six digits are only strong enough because of the fence around them: one
// live code per person, ten minutes, five attempts, and the row is destroyed on
// the first success. Remove any one of those and six digits is a number you can
// guess.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const COOKIE = 'quill_session';

// The key everything here is hashed with.
//
// STATUS_TOKEN by default, because an install that has one already has a secret
// the operator chose and keeps out of git, and adding a second thing to
// configure is how people end up running with a default. AUTH_SECRET overrides
// it for an install that wants them separate.
//
// A bot with neither cannot sign anybody in, and says so rather than falling
// back to a constant — a hardcoded key here would mean every Quill install in
// the world could mint sessions for every other one.
export function authSecret(cfg) {
  return cfg?.authSecret || cfg?.statusToken || null;
}

const hmac = (secret, value) => createHmac('sha256', secret).update(String(value)).digest('hex');

// Comparison that does not leak how much of the value was right via how long it
// took. Overkill for six digits behind an attempt counter, and exactly the kind
// of thing that is easy now and impossible to retrofit once something longer
// lives in the same function.
function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// Six digits, uniformly. randomInt rather than Math.random: this is a
// credential, and the difference costs nothing.
export function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// --- asking for a code ---

export function issueCode(db, cfg, { userId, username, now = Date.now(), code = newCode() } = {}) {
  const secret = authSecret(cfg);
  if (!secret) return { ok: false, message: 'This bot has no sign-in secret configured.' };

  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  db.putAuthCode(userId, username, hmac(secret, `${userId}:${code}`), expiresAt);

  // The code is returned so the caller can DM it and then forget it. It is
  // never written anywhere, never logged, and never returned over HTTP.
  return { ok: true, code, expiresAt };
}

// --- proving you got it ---

const REFUSED = {
  none: 'That code has expired or was never asked for. Ask for a new one.',
  expired: 'That code has expired. Ask for a new one.',
  spent: 'Too many wrong tries. Ask for a new code.',
  wrong: 'That code is not right.',
};

export function checkCode(db, cfg, { userId, code, now = Date.now() } = {}) {
  const secret = authSecret(cfg);
  if (!secret) return { ok: false, reason: 'none', message: REFUSED.none };

  const row = db.getAuthCode(userId);
  if (!row) return { ok: false, reason: 'none', message: REFUSED.none };

  if (new Date(row.expires_at).getTime() <= now) {
    db.dropAuthCode(userId);
    return { ok: false, reason: 'expired', message: REFUSED.expired };
  }

  // Checked BEFORE comparing, so a burnt code cannot be tested one more time.
  if (row.attempts >= MAX_ATTEMPTS) {
    db.dropAuthCode(userId);
    return { ok: false, reason: 'spent', message: REFUSED.spent };
  }

  if (!sameSecret(row.code_hash, hmac(secret, `${userId}:${String(code ?? '').trim()}`))) {
    db.countAuthAttempt(userId);
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      reason: 'wrong',
      attemptsLeft: Math.max(0, left),
      message: left > 0 ? `${REFUSED.wrong} ${left} ${left === 1 ? 'try' : 'tries'} left.` : REFUSED.spent,
    };
  }

  // Spent on first success. A code that still works after it has been used is
  // a code that works twice.
  db.dropAuthCode(userId);
  return { ok: true, userId, username: row.username };
}

// --- the session ---

export function openSession(db, cfg, { userId, username, now = Date.now() } = {}) {
  const secret = authSecret(cfg);
  if (!secret) return null;

  // 32 bytes, so guessing a session is not a thing anybody attempts. Only its
  // HMAC is stored, so a copy of the database is not a drawer full of logins.
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  db.openAuthSession(hmac(secret, token), userId, username, expiresAt);
  return { token, expiresAt };
}

export function readSession(db, cfg, token, { now = Date.now() } = {}) {
  const secret = authSecret(cfg);
  if (!secret || !token) return null;

  const row = db.getAuthSession(hmac(secret, token));
  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= now) {
    db.closeAuthSession(row.token_hash);
    return null;
  }

  db.touchAuthSession(row.token_hash);
  return { userId: row.user_id, username: row.username, expiresAt: row.expires_at };
}

// Signing out destroys the row, which is the whole of it: there is no other
// copy of the credential anywhere, so deleting the hash makes the cookie in the
// browser permanently meaningless.
export function closeSession(db, cfg, token, { everywhere = false } = {}) {
  const secret = authSecret(cfg);
  if (!secret || !token) return 0;

  if (!everywhere) return db.closeAuthSession(hmac(secret, token));

  const row = db.getAuthSession(hmac(secret, token));
  return row ? db.closeAllAuthSessions(row.user_id) : 0;
}

// --- the cookie ---
//
// HttpOnly so a script on the page cannot read it, SameSite=Lax so it is not
// sent from another site's form post, Path=/ so it covers the API and the page
// alike. Secure only when the page is actually on https: setting it on a LAN
// dashboard served over http would mean the browser silently discards the
// cookie and nobody can ever sign in.
export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  return [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

export const clearedCookie = ({ secure = false } = {}) =>
  `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

export function cookieFrom(header) {
  for (const part of String(header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=') || null;
  }
  return null;
}
