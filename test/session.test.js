// Offline tests for the encrypted session cookie (it must work inside Onshape's frame,
// survive restarts and resist tampering) and the guard that stops other websites from using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMiddleware, rejectCrossSite, COOKIE_ATTRIBUTES, seal, runWithSession } from '../src/session.js';
import { tokenStore } from '../src/tokenStore.js';

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = () => res;
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

/** Runs the middleware on a request with the given cookie header; returns { req, res }. */
function visit(cookie, handler = () => {}) {
  const req = { headers: cookie ? { cookie } : {} };
  const res = fakeRes();
  sessionMiddleware()(req, res, () => handler(req));
  res.writeHead(200);
  return { req, res, cookie: res.headers['set-cookie']?.match(/(mp_sid=[^;]+)/)[1] };
}

test('session cookie can travel inside the Onshape frame: SameSite=None + Secure, HttpOnly, not Partitioned', () => {
  const { res } = visit(null, (req) => (req.session.userId = 'gavin'));
  const c = res.headers['set-cookie'];
  assert.match(c, /^mp_sid=[A-Za-z0-9_-]+;/);
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=None', 'Path=/']) assert.ok(c.includes(attr), `missing ${attr}`);
  assert.ok(!/Partitioned/i.test(c), 'a partitioned cookie from the login pop-up would never reach the frame');
  assert.ok(!/SameSite=(Lax|Strict)/i.test(COOKIE_ATTRIBUTES));
});

test('the login lives in the cookie, so it survives a server restart; nothing is resent if unchanged', () => {
  const tokens = { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, user: { name: 'Gavin' } };
  const first = visit(null, (req) => Object.assign(req.session, { userId: 'gavin', tokens }));
  assert.ok(!first.cookie.includes('RT'), 'tokens are encrypted, not readable in the cookie');

  const again = visit(`other=1; ${first.cookie}`);
  assert.equal(again.req.session.userId, 'gavin');
  assert.deepEqual(again.req.session.tokens, tokens);
  assert.equal(again.res.headers['set-cookie'], undefined, 'no new cookie needed');
});

test('a forged or tampered cookie gives a fresh, logged-out session', () => {
  const { cookie } = visit(null, (req) => (req.session.userId = 'gavin'));
  const value = cookie.split('=')[1];
  const flipped = value.slice(0, -2) + (value.at(-2) === 'A' ? 'B' : 'A') + value.at(-1);
  for (const c of ['mp_sid=forged', `mp_sid=${flipped}`, `mp_sid=${seal({ userId: 'x' }).slice(0, 20)}`]) {
    assert.equal(visit(c).req.session.userId, null, c);
  }
});

test('an expired session is replaced', () => {
  const old = seal({ userId: 'gavin', tokens: null, oauthState: null, createdAt: Date.now() - 8 * 24 * 3600_000 });
  assert.equal(visit(`mp_sid=${old}`).req.session.userId, null);
});

test('the token store reads and writes only the current session, and only for its own user', async () => {
  const session = { userId: 'gavin', tokens: { accessToken: 'A' } };
  await runWithSession(session, async () => {
    assert.equal((await tokenStore.get('gavin')).accessToken, 'A');
    assert.equal(await tokenStore.get('someone-else'), undefined);
    await tokenStore.set('someone-else', { accessToken: 'X' });
    assert.equal(session.tokens.accessToken, 'A');
    await tokenStore.set('gavin', { accessToken: 'B' });
    assert.equal(session.tokens.accessToken, 'B');
    await tokenStore.delete('gavin');
    assert.equal(session.tokens, null);
  });
  assert.equal(await tokenStore.get('gavin'), undefined, 'outside a request there is no session');
});

test('requests another website makes in the background are refused', () => {
  const res = fakeRes();
  let passed = false;
  rejectCrossSite()({ headers: { 'sec-fetch-site': 'cross-site' } }, res, () => (passed = true));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('the panel (same-origin), direct visits (none) and local scripts (no header) are allowed', () => {
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-site' }, {}]) {
    let passed = false;
    rejectCrossSite()({ headers }, fakeRes(), () => (passed = true));
    assert.ok(passed, JSON.stringify(headers));
  }
});
