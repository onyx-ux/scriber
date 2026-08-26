// Signing in AS Discord, rather than as somebody Discord DMed.
//
// The old flow proved you controlled an account by sending six digits to its
// DMs and asking you to type them back. It worked, and everything about it was
// a reimplementation of something Discord already does better: it needed the
// bot to share a server with you before it could find you, it needed a name
// typed exactly right, it broke entirely if you had DMs turned off for the
// server, and the six digits were only strong enough because of a fence of
// timers and attempt counters built to hold them up.
//
// OAuth deletes all of that. Discord asks you, Discord checks you, and Discord
// hands back a user id that is not a guess about who you are — it is the
// answer. Nothing is typed, nothing expires in ten minutes, and there is no
// window in which a wrong six digits is worth trying.
//
// What this module does NOT do is decide anything. It performs the exchange
// and returns a Discord id and a username; who that person is allowed to be on
// this bot is still worked out from what the account owns, runs and plays in.
// See web/viewer.js. Signing in has never granted anything here and still does
// not — it only says which account is asking.

// One scope, and it is the smallest one Discord has.
//
// `identify` returns the account's id, its username and its avatar. Not its
// email (that is `email`), not its servers (`guilds`), not the ability to do
// anything on the account's behalf. The bot already knows which servers it is
// in and who owns them — it does not need the user's copy of that list, so it
// does not ask for it, and the consent screen says so.
export const SCOPE = 'identify';

const AUTHORIZE = 'https://discord.com/oauth2/authorize';
const API = 'https://discord.com/api/v10';

// Discord answering slowly must not hold a request open for ever. Ten seconds
// is far longer than either call has ever taken and short enough that a
// browser sitting on a blank callback page gives up in human time.
const TIMEOUT_MS = 10_000;

// Where Discord sends people back to.
//
// Set DISCORD_REDIRECT_URI when the dashboard does not sit at the standard
// nginx layout, because this value has to match a string registered in the
// Discord developer portal EXACTLY — scheme, host, port and path — and a
// derived guess that is one character out fails with an "invalid redirect_uri"
// screen that says nothing about which of the two ends is wrong.
//
// Otherwise it is derived from DASHBOARD_URL, which the bot already needs for
// the links in its notification DMs. The dashboard's nginx proxies the bot's
// API at /api, so /api/auth/callback is the same route this module's callback
// is served on — see dashboard/templates/default.conf.template.
export function redirectUri(cfg) {
  if (cfg?.discordRedirectUri) return cfg.discordRedirectUri;
  if (!cfg?.dashboardUrl) return null;
  try {
    return new URL('/api/auth/callback', cfg.dashboardUrl).toString();
  } catch {
    return null;
  }
}

// Whether this install can sign anybody in, and if not, which piece is missing.
//
// Said precisely rather than as one boolean, because every one of these is a
// line somebody forgot to fill in, and "sign-in is not configured" sends them
// to read the whole .env looking for which one.
export function oauthReady(cfg) {
  if (!cfg?.discordClientId) return { ok: false, missing: 'DISCORD_CLIENT_ID' };
  if (!cfg?.discordClientSecret) return { ok: false, missing: 'DISCORD_CLIENT_SECRET' };
  if (!redirectUri(cfg)) return { ok: false, missing: 'DISCORD_REDIRECT_URI or DASHBOARD_URL' };
  return { ok: true, missing: null };
}

// Where to send somebody to be asked.
//
// `prompt=none` is the difference between OAuth being nicer than typing a code
// and being the same amount of clicking. Discord's default is to show the
// authorization screen every single time, even to somebody who approved this
// app last week; with prompt=none it sends straight back anybody who has
// already said yes to these exact scopes, and answers `error=consent_required`
// for anybody who has not. That error is not a failure — it is Discord saying
// "ask them properly", which is what the consent retry does.
export function authorizeUrl(cfg, { state, consent = false } = {}) {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', cfg.discordClientId);
  url.searchParams.set('redirect_uri', redirectUri(cfg));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  if (!consent) url.searchParams.set('prompt', 'none');
  return url.toString();
}

// The whole of the server's half: a one-use code in, an account out.
//
// Three requests to Discord, and the third one is the interesting one. The
// access token is spent immediately on a single question — who is this — and
// then handed straight back. Nothing here stores it, nothing refreshes it, and
// the bot never acts on anybody's behalf, so keeping it would be keeping a
// live credential for an account we have no further business with. Revoking is
// fire-and-forget: it is hygiene, and a failed revoke must not cost somebody
// their sign-in when the token was going to be dropped on the floor anyway.
//
// `fetchImpl` is injectable so the flow can be tested against a model of
// Discord's API rather than the internet. Nothing in production passes it.
export async function identifyByCode({ cfg, code, fetchImpl = fetch }) {
  const ready = oauthReady(cfg);
  if (!ready.ok) return { ok: false, reason: 'config' };

  const token = await exchange({ cfg, code, fetchImpl });
  if (!token) return { ok: false, reason: 'exchange' };

  const who = await whoAmI({ token, fetchImpl });
  revoke({ cfg, token, fetchImpl });

  if (!who?.id) return { ok: false, reason: 'identity' };
  return {
    ok: true,
    userId: String(who.id),
    // The @handle, deliberately, and not global_name. Everything else in this
    // bot that says "who" means the username — the roster, the access page,
    // the sign-in that came before this one — because a display name is
    // changeable at will and frequently the character rather than the person.
    username: who.username ?? String(who.id),
  };
}

async function exchange({ cfg, code, fetchImpl }) {
  const res = await form(fetchImpl, `${API}/oauth2/token`, {
    client_id: cfg.discordClientId,
    client_secret: cfg.discordClientSecret,
    grant_type: 'authorization_code',
    code,
    // Sent again here, and it must be byte-identical to the one on the
    // authorize URL: OAuth uses the repeat as proof that whoever is redeeming
    // the code is the same party that asked for it. Both come from one
    // function for exactly that reason.
    redirect_uri: redirectUri(cfg),
  });
  if (!res?.ok) return null;

  const json = await res.json().catch(() => null);
  return json?.access_token ?? null;
}

async function whoAmI({ token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

function revoke({ cfg, token, fetchImpl }) {
  form(fetchImpl, `${API}/oauth2/token/revoke`, {
    client_id: cfg.discordClientId,
    client_secret: cfg.discordClientSecret,
    token,
    token_type_hint: 'access_token',
  }).catch(() => {});
}

async function form(fetchImpl, url, fields) {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // A refused connection, a DNS failure or the ten-second timeout. All three
    // mean the same thing to the caller — Discord did not answer — and none of
    // them should throw out of an HTTP handler.
    return null;
  }
}
