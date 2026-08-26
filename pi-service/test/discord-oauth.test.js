import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE, authorizeUrl, identifyByCode, oauthReady, redirectUri,
} from '../src/web/discord-oauth.js';

// The half of signing in that talks to Discord.
//
// Driven against a model of Discord's OAuth API rather than the internet, so
// the shape of every request is asserted here rather than discovered in
// production by a redirect screen that says "invalid_grant" and nothing else.

const CFG = {
  discordClientId: 'app-1',
  discordClientSecret: 'shh',
  dashboardUrl: 'http://pihouse.local:8095',
};

// Discord, as far as this module can tell. Records every call so a test can
// ask what was sent as well as what came back.
function discordApi({ codes = {}, users = {}, broken = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const sent = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url, init, sent });

    const dead = { ok: false, status: 500, json: async () => ({}) };
    if (broken.some((b) => url.includes(b))) return dead;

    if (url.endsWith('/oauth2/token')) {
      const token = codes[sent?.code];
      return token
        ? { ok: true, status: 200, json: async () => ({ access_token: token, token_type: 'Bearer' }) }
        : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    }
    if (url.endsWith('/users/@me')) {
      const bearer = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const user = users[bearer];
      return user ? { ok: true, status: 200, json: async () => user } : dead;
    }
    if (url.endsWith('/oauth2/token/revoke')) return { ok: true, status: 200, json: async () => ({}) };

    throw new Error(`the module called something unexpected: ${url}`);
  };
  const to = (part) => calls.filter((c) => c.url.includes(part));
  return { calls, fetchImpl, to };
}

// --- where Discord sends people back to ---

test('the redirect is derived from the dashboard, and overridden when it must be', async () => {
  assert.equal(redirectUri(CFG), 'http://pihouse.local:8095/api/auth/callback');
  assert.equal(
    redirectUri({ ...CFG, discordRedirectUri: 'https://quill.example/cb' }),
    'https://quill.example/cb',
    'an explicit one wins — it has to match the developer portal exactly'
  );
  assert.equal(redirectUri({ discordClientId: 'x' }), null, 'and with neither there is nowhere to come back to');
  assert.equal(redirectUri({ dashboardUrl: 'not a url' }), null, 'a malformed one is not half a redirect');
});

// Every one of these is a line somebody forgot to fill in, and "sign-in is not
// configured" sends them to read the whole .env looking for which.
test('a bot that cannot sign anybody in says which piece is missing', async () => {
  assert.equal(oauthReady(CFG).ok, true);
  assert.equal(oauthReady({ ...CFG, discordClientId: null }).missing, 'DISCORD_CLIENT_ID');
  assert.equal(oauthReady({ ...CFG, discordClientSecret: null }).missing, 'DISCORD_CLIENT_SECRET');
  assert.match(oauthReady({ ...CFG, dashboardUrl: null }).missing, /DISCORD_REDIRECT_URI/);
});

// --- off to Discord ---

test('the authorize url asks for one scope and carries the state', async () => {
  const url = new URL(authorizeUrl(CFG, { state: 'st-1' }));

  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app-1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'st-1');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri(CFG));

  // Not `email`, not `guilds`, and nothing that could act on the account.
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(SCOPE, 'identify');
});

// The difference between OAuth being nicer than typing a code and being the
// same amount of clicking: Discord shows its authorization screen every single
// time unless it is told not to.
test('a returning visitor is not asked again, and a new one is', async () => {
  assert.equal(new URL(authorizeUrl(CFG, { state: 's' })).searchParams.get('prompt'), 'none');
  assert.equal(new URL(authorizeUrl(CFG, { state: 's', consent: true })).searchParams.get('prompt'), null);
});

// --- the exchange ---

test('a code becomes an account', async (t) => {
  const api = discordApi({
    codes: { 'code-1': 'tok-1' },
    users: { 'tok-1': { id: '10000000000000001', username: 'saf', global_name: 'Saf The Bard' } },
  });

  const who = await identifyByCode({ cfg: CFG, code: 'code-1', fetchImpl: api.fetchImpl });

  assert.equal(who.ok, true);
  assert.equal(who.userId, '10000000000000001');
  // The @handle, not the display name. Everything else in this bot that says
  // "who" means the username, because a display name changes at will and is
  // frequently the character rather than the person.
  assert.equal(who.username, 'saf');
});

test('the exchange sends exactly what Discord requires', async () => {
  const api = discordApi({ codes: { 'code-1': 'tok-1' }, users: { 'tok-1': { id: '1', username: 'saf' } } });
  await identifyByCode({ cfg: CFG, code: 'code-1', fetchImpl: api.fetchImpl });

  const [exchange] = api.to('/oauth2/token');
  assert.equal(exchange.init.method, 'POST');
  assert.match(exchange.init.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.deepEqual(exchange.sent, {
    client_id: 'app-1',
    client_secret: 'shh',
    grant_type: 'authorization_code',
    code: 'code-1',
    redirect_uri: 'http://pihouse.local:8095/api/auth/callback',
  });

  // OAuth uses the repeated redirect_uri as proof that whoever is redeeming
  // the code is the party that asked for it, so the two have to be identical.
  assert.equal(exchange.sent.redirect_uri, new URL(authorizeUrl(CFG, { state: 's' })).searchParams.get('redirect_uri'));
});

test('the identity call carries the token as a bearer and nothing else', async () => {
  const api = discordApi({ codes: { c: 'tok-1' }, users: { 'tok-1': { id: '1', username: 'saf' } } });
  await identifyByCode({ cfg: CFG, code: 'c', fetchImpl: api.fetchImpl });

  const [me] = api.to('/users/@me');
  assert.equal(me.init.method, undefined, 'a GET');
  assert.equal(me.init.headers.Authorization, 'Bearer tok-1');
});

// The token is spent on one question and handed straight back. Nothing here
// stores it, nothing refreshes it, and the bot never acts on anybody's behalf,
// so keeping it would be keeping a live credential for an account we have no
// further business with.
test('the access token is revoked and never returned', async () => {
  const api = discordApi({ codes: { c: 'tok-1' }, users: { 'tok-1': { id: '1', username: 'saf' } } });
  const who = await identifyByCode({ cfg: CFG, code: 'c', fetchImpl: api.fetchImpl });

  const [revoke] = api.to('/oauth2/token/revoke');
  assert.ok(revoke, 'the token is handed back');
  assert.equal(revoke.sent.token, 'tok-1');
  assert.equal(JSON.stringify(who).includes('tok-1'), false, 'and never leaves this module');
});

// A revoke is hygiene. Failing it must not cost somebody their sign-in over a
// token that was going to be dropped on the floor anyway.
test('a failed revoke does not fail the sign-in', async () => {
  const api = discordApi({
    codes: { c: 'tok-1' },
    users: { 'tok-1': { id: '1', username: 'saf' } },
    broken: ['/oauth2/token/revoke'],
  });

  assert.equal((await identifyByCode({ cfg: CFG, code: 'c', fetchImpl: api.fetchImpl })).ok, true);
});

// --- when it does not work ---

test('a code Discord will not honour is not a sign-in', async () => {
  const api = discordApi({ codes: {} });
  const who = await identifyByCode({ cfg: CFG, code: 'stale', fetchImpl: api.fetchImpl });

  assert.deepEqual(who, { ok: false, reason: 'exchange' });
  assert.equal(api.to('/users/@me').length, 0, 'and nothing is asked about anybody');
});

test('a token that buys no identity is not a sign-in', async () => {
  const api = discordApi({ codes: { c: 'tok-1' }, users: {} });
  assert.deepEqual(await identifyByCode({ cfg: CFG, code: 'c', fetchImpl: api.fetchImpl }), { ok: false, reason: 'identity' });
});

// A refused connection, a DNS failure or the ten-second timeout. All three mean
// the same thing, and none of them may throw out of an HTTP handler.
test('Discord being unreachable is an answer, not an exception', async () => {
  const exploding = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(
    await identifyByCode({ cfg: CFG, code: 'c', fetchImpl: exploding }),
    { ok: false, reason: 'exchange' }
  );
});

test('an install with no OAuth credentials never calls Discord at all', async () => {
  const api = discordApi({ codes: { c: 'tok-1' } });
  const who = await identifyByCode({ cfg: { dashboardUrl: CFG.dashboardUrl }, code: 'c', fetchImpl: api.fetchImpl });

  assert.deepEqual(who, { ok: false, reason: 'config' });
  assert.equal(api.calls.length, 0);
});
