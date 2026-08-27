// Signing in to the dashboard, without ever holding a password.
//
// You sign in with Discord. Discord asks you, Discord checks you, and hands
// this bot back a user id — which is exactly as strong a claim as "you control
// that Discord account", and that is the only identity this bot has ever cared
// about. Every permission it grants is derived from what that account owns,
// runs or plays in.
//
// So there is no password to choose, forget, reuse or leak, and nothing stored
// that a database leak would make worse: a Discord id and a username, both
// public in any server you share. The session cookie is stored as an HMAC, so
// the table cannot be turned back into a login. The OAuth access token is
// spent on one question and revoked — see web/discord-oauth.js.
//
// This module owns the two credentials that live in the browser: the session
// cookie, and the short-lived state cookie that ties one sign-in attempt to
// the browser that started it. The protocol Discord speaks lives next door;
// the hashing, the storage and the cookie attributes live here, and nothing
// outside this module reaches the credential tables. See docs/adr/0001.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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
// took. The state below is the one thing here an attacker gets to guess at
// repeatedly, and this is the kind of thing that is easy now and impossible to
// retrofit once something longer lives in the same function.
function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- one sign-in attempt ---
//
// The `state` parameter, which is the whole of OAuth's CSRF defence. A random
// value goes out on the authorize URL and into a cookie at the same moment;
// only a callback carrying both, matching, is a callback this browser actually
// asked for. Without it, anyone can hand somebody a link that quietly signs
// them into an attacker's Discord account and leaves them typing into it.
export const STATE_COOKIE = 'quill_signin';
// Not a session. See askToken -- it can only put a name in a queue.
export const ASK_COOKIE = 'quill_ask';

// Long enough to walk through Discord's screen and short enough that a stale
// tab does not carry a live attempt around for the afternoon.
export const STATE_TTL_MS = 10 * 60 * 1000;

// 32 bytes. Guessing it is not a thing anybody attempts.
//
// The mode rides along on the end rather than in a second cookie: the state is
// compared whole, so the flag cannot be edited without breaking the match, and
// the callback needs to know whether it has already retried or it can bounce
// off `consent_required` for ever. See web/auth-routes.js.
export function newState({ consent = false } = {}) {
  return `${randomBytes(32).toString('hex')}.${consent ? 'c' : 'n'}`;
}

export const askedForConsent = (state) => String(state ?? '').endsWith('.c');

// Whether this callback belongs to the browser that started it.
export function stateMatches(fromCookie, fromQuery) {
  return Boolean(fromCookie) && Boolean(fromQuery) && sameSecret(fromCookie, fromQuery);
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

// How stale "last seen" is allowed to get before it is worth a write.
//
// The dashboard polls every few seconds, and every poll carries the cookie. A
// naive touch-on-read is therefore a database write every five seconds for as
// long as anybody has the page open — for ever, onto the SD card of a
// Raspberry Pi. The field exists so somebody can see whether a session is still
// in use; five minutes is far finer than that question needs.
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export function readSession(db, cfg, token, { now = Date.now() } = {}) {
  const secret = authSecret(cfg);
  if (!secret || !token) return null;

  const row = db.getAuthSession(hmac(secret, token));
  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= now) {
    db.closeAuthSession(row.token_hash);
    return null;
  }

  const seen = row.last_seen_at ? new Date(`${row.last_seen_at}Z`).getTime() : 0;
  if (!Number.isFinite(seen) || now - seen > TOUCH_AFTER_MS) db.touchAuthSession(row.token_hash);

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

// --- the cookies ---
//
// HttpOnly so a script on the page cannot read either of them, SameSite=Lax so
// they are not sent from another site's form post, Path=/ so they cover the API
// and the page alike. Secure only when the page is actually on https: setting
// it on a LAN dashboard served over http would mean the browser silently
// discards the cookie and nobody can ever sign in.
//
// Lax rather than Strict is load-bearing for the state cookie specifically.
// The callback is a top-level GET navigation arriving from discord.com, which
// Lax allows and Strict does not — under Strict the cookie would not be sent
// back and every single sign-in would fail its own CSRF check.
function bake(name, value, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  return [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

export const sessionCookie = (token, opts = {}) => bake(COOKIE, token, opts);
export const askCookie = (token, opts = {}) => bake(ASK_COOKIE, token, { maxAgeMs: ASK_TTL_MS, ...opts });
export const stateCookie = (state, opts = {}) => bake(STATE_COOKIE, state, { maxAgeMs: STATE_TTL_MS, ...opts });

const cleared = (name, { secure = false } = {}) =>
  `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

export const clearedCookie = (opts) => cleared(COOKIE, opts);
// Spent on the first callback that reads it, successful or not. A state that
// still works after it has been answered is a state that works twice.
export const clearedStateCookie = (opts) => cleared(STATE_COOKIE, opts);
export const clearedAskCookie = (opts) => cleared(ASK_COOKIE, opts);

// --- the one credential that grants nothing ---
//
// Somebody turned away at the door has no session, by design: web/auth-routes
// checks the guest list BEFORE it writes a row, because a row written and then
// reasoned about is a row that outlives the reasoning. That leaves a real
// problem for a Request an invite button — the person pressing it is, as far
// as the server is concerned, nobody at all, and a button that posts its own
// user id is a button that lets anybody put any name in the queue.
//
// So the callback hands back a short-lived signed note saying only "Discord
// confirmed this is user X, called Y". It is not a session and cannot become
// one. Everything that reads a session reads COOKIE via readSession; nothing
// anywhere reads this except askedBy below, and the single thing askedBy is
// allowed to do is write a request row.
//
// Stateless on purpose. A refused sign-in writes NOTHING until the button is
// pressed, so somebody who bounces off the door and leaves has left no trace
// but the log line -- which is the behaviour that was there before this
// existed, and worth keeping for everyone who never asks.
const ASK_TTL_MS = 30 * 60 * 1000;

export function askToken(cfg, { userId, username = null, now = Date.now() } = {}) {
  const secret = authSecret(cfg);
  if (!secret || !userId) return null;

  // Base64url, so a username with a comma, a dot or a non-ASCII character in
  // it cannot break the field separator. Discord allows all three.
  const name = Buffer.from(String(username ?? ''), 'utf8').toString('base64url');
  const body = `${String(userId)}.${name}.${now + ASK_TTL_MS}`;
  return `${body}.${hmac(secret, body)}`;
}

// Who this note says asked -- or null, which every caller must treat as "no
// idea who this is" rather than as an error worth explaining. A forged note
// and an expired one are the same answer on purpose: telling the two apart out
// loud would say whether a signature was right, which is a thing worth
// guessing at.
export function askedBy(cfg, token, { now = Date.now() } = {}) {
  const secret = authSecret(cfg);
  if (!secret || !token) return null;

  const parts = String(token).split('.');
  if (parts.length !== 4) return null;

  const [userId, name, expiresAt, signature] = parts;
  if (!sameSecret(hmac(secret, `${userId}.${name}.${expiresAt}`), signature)) return null;
  if (!Number(expiresAt) || Number(expiresAt) < now) return null;

  const username = Buffer.from(name, 'base64url').toString('utf8');
  return { userId, username: username || null };
}

export function cookieFrom(header, name = COOKIE) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

// The two things somebody outside this module used to reach past it for.
//
// Every other function here goes through auth.js because the hashing lives
// here — a caller cannot look a session up without knowing how it was stored.
// But ending a person's sessions and sweeping the expired ones do not need the
// secret, so callers reached straight into the store for them: actions.js and
// server.js.
//
// That is the credential table being read and written from three modules
// rather than one. Nothing was wrong with any single call — it is that "where
// do sessions get destroyed" had three answers, and a rule about credentials
// added here would not have covered two of them.

// Sign somebody out of the dashboard, everywhere at once.
//
// Distinct from closeSession(everywhere) above, which ends the sessions of
// whoever is holding a particular cookie. This ends a NAMED person's, which is
// the operator revoking somebody else's access rather than anyone logging
// themselves out — and it deliberately touches nothing but sessions. Revoking
// access and deleting somebody's history are different acts, and only one of
// them belongs on a button.
export function revokeAllSessions(db, userId) {
  return db.closeAllAuthSessions(userId);
}

// Delete dead sessions rather than merely ignoring them.
//
// A table of dead credentials is a table of things that could come back if a
// clock moved. Swept on a timer and checked again on every use, the same
// belt-and-braces the consent invites get.
export function sweepExpired(db) {
  return db.sweepAuth();
}
