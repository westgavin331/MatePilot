// Offline tests for OAuth login, token refresh and request signing.
// global fetch is replaced with a fake, so nothing reaches Onshape.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { MemoryTokenStore } from '../src/tokenStore.js';
import { runWithSession } from '../src/session.js';
import { getAccessToken, runAsUser, lastScheme, NotLoggedInError } from '../src/auth.js';
import { authorizeUrl, exchangeCode } from '../src/oauth.js';
import { get } from '../src/onshape.js';

const NOW = 1_000_000_000_000;
const saved = { ...config };
const realFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(config, {
    oauthClientId: 'ABC=DEF+/client==',
    oauthClientSecret: 'secret&value=',
    oauthRedirectUri: 'http://localhost:3000/oauth/callback',
    oauthBase: 'https://oauth.example',
    base: 'https://cad.example',
  });
});
afterEach(() => {
  Object.assign(config, saved);
  globalThis.fetch = realFetch;
});

const fresh = (n = 1) => ({ accessToken: `new${n}`, refreshToken: `r${n}`, expiresAt: NOW + 3600_000 });

test('a token with plenty of time left is used as is (no refresh)', async () => {
  const store = new MemoryTokenStore();
  await store.set('u1', { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 30 * 60_000 });
  let refreshes = 0;
  const t = await getAccessToken('u1', { store, now: () => NOW, refresh: async () => (refreshes++, fresh()) });
  assert.equal(t, 'a');
  assert.equal(refreshes, 0);
});

test('a token with under a minute left is refreshed first, and the new one is stored', async () => {
  const store = new MemoryTokenStore();
  await store.set('u1', { accessToken: 'old', refreshToken: 'r0', expiresAt: NOW + 30_000, user: { name: 'Gavin' } });
  const t = await getAccessToken('u1', { store, now: () => NOW, refresh: async (r) => (assert.equal(r, 'r0'), fresh()) });
  assert.equal(t, 'new1');
  const stored = await store.get('u1');
  assert.equal(stored.accessToken, 'new1');
  assert.equal(stored.refreshToken, 'r1');
  assert.equal(stored.user.name, 'Gavin', 'user info survives a refresh');
});

test('many calls at once share a single refresh', async () => {
  const store = new MemoryTokenStore();
  await store.set('u1', { accessToken: 'old', refreshToken: 'r0', expiresAt: NOW - 1 });
  let refreshes = 0;
  const refresh = async () => {
    refreshes++;
    await new Promise((r) => setTimeout(r, 20));
    return fresh();
  };
  const tokens = await Promise.all(Array.from({ length: 10 }, () => getAccessToken('u1', { store, now: () => NOW, refresh })));
  assert.equal(refreshes, 1);
  assert.ok(tokens.every((t) => t === 'new1'));
});

test('parallel calls from different stores (e.g. two requests, each with its own cookie) all save the refreshed token', async () => {
  const stores = [new MemoryTokenStore(), new MemoryTokenStore()];
  for (const store of stores) await store.set('u1', { accessToken: 'old', refreshToken: 'shared', expiresAt: NOW - 1 });
  let refreshes = 0;
  const refresh = async () => (refreshes++, await new Promise((r) => setTimeout(r, 20)), fresh());
  await Promise.all(stores.map((store) => getAccessToken('u1', { store, now: () => NOW, refresh })));
  assert.equal(refreshes, 1);
  for (const store of stores) assert.equal((await store.get('u1')).accessToken, 'new1');
});

test('a refused refresh token logs you out and asks you to log in again', async () => {
  const store = new MemoryTokenStore();
  await store.set('u1', { accessToken: 'old', refreshToken: 'revoked', expiresAt: NOW - 1 });
  const refresh = async () => { throw Object.assign(new Error('invalid_grant'), { status: 400 }); };
  await assert.rejects(getAccessToken('u1', { store, now: () => NOW, refresh }), (e) => e instanceof NotLoggedInError && /log in again/.test(e.message));
  assert.equal(await store.get('u1'), undefined, 'dead tokens are forgotten');
});

test('a network error during refresh is reported but keeps the tokens (so it can retry later)', async () => {
  const store = new MemoryTokenStore();
  await store.set('u1', { accessToken: 'old', refreshToken: 'r0', expiresAt: NOW - 1 });
  const refresh = async () => { throw Object.assign(new Error('socket hang up'), { status: undefined }); };
  await assert.rejects(getAccessToken('u1', { store, now: () => NOW, refresh }), /socket hang up/);
  assert.ok(await store.get('u1'));
});

test('not logged in (no user, or no tokens stored) gives a "please log in" error', async () => {
  const store = new MemoryTokenStore();
  await assert.rejects(getAccessToken(null, { store }), NotLoggedInError);
  await assert.rejects(getAccessToken('nobody', { store }), NotLoggedInError);
});

test('each user gets their own token slot', async () => {
  const store = new MemoryTokenStore();
  await store.set('alice', { accessToken: 'A', refreshToken: 'ra', expiresAt: NOW + 3600_000 });
  await store.set('bob', { accessToken: 'B', refreshToken: 'rb', expiresAt: NOW + 3600_000 });
  assert.equal(await getAccessToken('alice', { store, now: () => NOW }), 'A');
  assert.equal(await getAccessToken('bob', { store, now: () => NOW }), 'B');
});

test('login URL carries client id, return address and state, all URL-encoded', () => {
  const u = new URL(authorizeUrl('st8'));
  assert.equal(u.origin + u.pathname, 'https://oauth.example/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'ABC=DEF+/client==');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/oauth/callback');
  assert.equal(u.searchParams.get('state'), 'st8');
});

test('code exchange posts a URL-encoded form and never echoes secrets in errors', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), init };
    return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }), { status: 200 });
  };
  const t = await exchangeCode('the-code');
  assert.equal(sent.url, 'https://oauth.example/oauth/token');
  assert.equal(sent.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(sent.init.body));
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'the-code');
  assert.equal(form.get('client_id'), 'ABC=DEF+/client==', 'special characters survive encoding');
  assert.equal(form.get('client_secret'), 'secret&value=');
  assert.equal(t.accessToken, 'AT');
  assert.equal(t.refreshToken, 'RT');

  globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });
  await assert.rejects(exchangeCode('bad'), (e) => e.status === 400 && !e.message.includes('secret&value='));
});

test('oauth mode: calls are signed with the Bearer token; a 401 triggers exactly one refresh and retry', async () => {
  config.authMode = 'oauth';
  const session = { userId: 'u-test', tokens: { accessToken: 'stale', refreshToken: 'r0', expiresAt: Date.now() + 3600_000 } };
  const seen = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith('https://oauth.example/oauth/token')) {
      seen.push('refresh');
      return new Response(JSON.stringify({ access_token: 'renewed', refresh_token: 'r1', expires_in: 3600 }), { status: 200 });
    }
    seen.push(init.headers.Authorization);
    if (init.headers.Authorization === 'Bearer stale') return new Response('{"message":"Unauthorized"}', { status: 401 });
    return new Response('{"items":[{"name":"Doc"}]}', { status: 200 });
  };
  const r = await runWithSession(session, () => runAsUser('u-test', async () => ({ data: await get('/documents'), scheme: lastScheme() })));
  assert.deepEqual(seen, ['Bearer stale', 'refresh', 'Bearer renewed']);
  assert.equal(r.data.items[0].name, 'Doc');
  assert.equal(r.scheme, 'Bearer');
  assert.equal(session.tokens.accessToken, 'renewed', 'the refreshed token goes back into the session cookie');
});

test('oauth mode: a second 401 after refreshing is an error, not an endless loop', async () => {
  config.authMode = 'oauth';
  const session = { userId: 'u-test', tokens: { accessToken: 'stale', refreshToken: 'r0', expiresAt: Date.now() + 3600_000 } };
  let apiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth.example/')) return new Response(JSON.stringify({ access_token: 'also-bad', expires_in: 3600 }), { status: 200 });
    apiCalls++;
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  };
  await assert.rejects(runWithSession(session, () => runAsUser('u-test', () => get('/documents'))), (e) => e.status === 401);
  assert.equal(apiCalls, 2);
});

test('oauth mode: command-line scripts (no browser login) get a clear message instead of using the keys', async () => {
  config.authMode = 'oauth';
  globalThis.fetch = async () => assert.fail('must not call Onshape');
  await assert.rejects(get('/documents'), /command-line scripts have no browser login/);
});

test('apikey mode (the fallback) still signs with the key pair', async () => {
  Object.assign(config, { authMode: 'apikey', accessKey: 'AK', secretKey: 'SK' });
  let header;
  globalThis.fetch = async (url, init) => ((header = init.headers.Authorization), new Response('{}', { status: 200 }));
  const scheme = await runAsUser(null, async () => (await get('/documents'), lastScheme()));
  assert.equal(header, 'Basic ' + Buffer.from('AK:SK').toString('base64'));
  assert.equal(scheme, 'Basic');
});
