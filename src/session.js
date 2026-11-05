// Minimal browser sessions, kept entirely in an encrypted HttpOnly cookie (page scripts
// can't read it). The server stores nothing, so a restart (on Render: every deploy, and
// after 15 idle minutes) doesn't log anyone out. Only the server can read or forge the
// cookie: it is sealed with AES-256-GCM under SESSION_SECRET.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'mp_sid';
const MAX_AGE_S = 7 * 24 * 3600;

// The panel runs in a frame inside cad.onshape.com, so to the browser this cookie is a
// "third-party" cookie. SameSite=None lets it travel in that frame; browsers only accept
// SameSite=None together with Secure, which Chrome/Edge/Firefox allow on http://localhost.
// It must NOT be Partitioned: login happens in a normal pop-up window, and a partitioned
// cookie set there would never reach the frame inside Onshape.
export const COOKIE_ATTRIBUTES = `HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${MAX_AGE_S}`;

// Without SESSION_SECRET (fine on your own computer) a random key is made at start-up,
// so logins last until the server restarts. server.js insists on one when hosted.
const key = createHash('sha256').update(config.sessionSecret || randomBytes(32)).digest();

export function seal(data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The data inside a cookie, or null if it was tampered with, sealed under another key, or garbage. */
export function unseal(value) {
  try {
    const buf = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Express middleware: refuses requests that another website makes in the background
 * (the cookie above is sent with those too). Browsers label every request with
 * Sec-Fetch-Site; MatePilot's own pages, including the panel inside Onshape, are
 * 'same-origin'. Requests without the header (curl, scripts) come from this computer.
 */
export function rejectCrossSite() {
  return (req, res, next) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Requests from other websites are not allowed.' });
    }
    next();
  };
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// The session of the request being handled, so tokenStore.js can reach it without
// every Onshape call passing it along.
const requestSession = new AsyncLocalStorage();
export const currentSession = () => requestSession.getStore();
export const runWithSession = (session, fn) => requestSession.run(session, fn);

const newSession = () => ({ userId: null, oauthState: null, tokens: null, createdAt: Date.now() });

/**
 * Express middleware: sets req.session = { userId, oauthState, tokens, createdAt }.
 * If the handler changes it, the cookie is resent just before the response goes out.
 */
export function sessionMiddleware() {
  return (req, res, next) => {
    const raw = readCookie(req, COOKIE);
    let session = raw && unseal(raw);
    if (!session || Date.now() - session.createdAt > MAX_AGE_S * 1000) session = newSession();
    const before = JSON.stringify(session);

    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (JSON.stringify(session) !== before) this.setHeader('Set-Cookie', `${COOKIE}=${seal(session)}; ${COOKIE_ATTRIBUTES}`);
      return writeHead.apply(this, args);
    };

    req.session = session;
    runWithSession(session, next);
  };
}
