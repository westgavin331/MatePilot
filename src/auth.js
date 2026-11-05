// Decides how each Onshape call is signed: with the API key pair, or with the
// logged-in user's OAuth token (ONSHAPE_AUTH_MODE in .env).
//
// Which user? The server wraps each browser request in runAsUser(userId, ...);
// every Onshape call made while handling that request picks the user up from
// AsyncLocalStorage, so assembly.js, bolts.js etc. don't need to pass it around.
import { AsyncLocalStorage } from 'node:async_hooks';
import { config, requireKeys } from './config.js';
import { tokenStore } from './tokenStore.js';
import { refreshAccessToken } from './oauth.js';

const userContext = new AsyncLocalStorage();

export const runAsUser = (userId, fn) => userContext.run({ userId }, fn);
export const currentUserId = () => userContext.getStore()?.userId ?? null;

/** Remembers, for the current request, how its latest Onshape call was signed. */
export function noteScheme(scheme) {
  const store = userContext.getStore();
  if (store) store.lastScheme = scheme;
}
export const lastScheme = () => userContext.getStore()?.lastScheme ?? null;

const loginUrl = () => `${config.publicUrl}/oauth/login`;

export class NotLoggedInError extends Error {
  constructor(message = `Not logged in to Onshape. Open ${loginUrl()} to log in.`) {
    super(message);
    this.status = 401;
    this.loginUrl = '/oauth/login';
  }
}

// Refresh this long before expiry, so a call never starts with a token about to lapse.
const REFRESH_EARLY_MS = 60 * 1000;
const refreshing = new Map(); // refresh token -> in-flight refresh promise

/**
 * Returns a usable access token for the user, refreshing it first if it is (nearly)
 * expired or if `force` is set.
 */
export async function getAccessToken(userId, { force = false, store = tokenStore, refresh = refreshAccessToken, now = Date.now } = {}) {
  if (!userId) throw new NotLoggedInError();
  const tokens = await store.get(userId);
  if (!tokens) throw new NotLoggedInError();
  if (!force && tokens.expiresAt - now() > REFRESH_EARLY_MS) return tokens.accessToken;
  if (!tokens.refreshToken) {
    await store.delete(userId);
    throw new NotLoggedInError(`Your Onshape login expired. Please log in again at ${loginUrl()}`);
  }

  // Parallel callers share one refresh. Each then saves the new tokens itself, because
  // each request carries its own copy of them (in its session cookie).
  let p = refreshing.get(tokens.refreshToken);
  if (!p) {
    p = refresh(tokens.refreshToken).finally(() => refreshing.delete(tokens.refreshToken));
    refreshing.set(tokens.refreshToken, p);
  }
  let fresh;
  try {
    fresh = await p;
  } catch (e) {
    // A refused refresh token (access revoked, or grant expired) means a new login is needed.
    if (e.status === 400 || e.status === 401) {
      await store.delete(userId);
      throw new NotLoggedInError(`Onshape no longer accepts this login. Please log in again at ${loginUrl()}`);
    }
    throw e;
  }
  await store.set(userId, { ...tokens, ...fresh });
  return fresh.accessToken;
}

/** The Authorization header for the current call: { header, scheme: 'Bearer' | 'Basic' }. */
export async function authorization({ force = false } = {}) {
  if (config.authMode === 'oauth') {
    if (!userContext.getStore()) {
      throw new NotLoggedInError('ONSHAPE_AUTH_MODE is "oauth", but command-line scripts have no browser login. Run them with ONSHAPE_AUTH_MODE=apikey, or use the panel.');
    }
    return { header: `Bearer ${await getAccessToken(currentUserId(), { force })}`, scheme: 'Bearer' };
  }
  requireKeys();
  return { header: 'Basic ' + Buffer.from(`${config.accessKey}:${config.secretKey}`).toString('base64'), scheme: 'Basic' };
}
