// Onshape OAuth2: the login redirect, exchanging the returned code for tokens,
// and refreshing an expired access token. See onshape-public.github.io/docs/auth/oauth/
import { config } from './config.js';

export function requireOAuthConfig() {
  if (!config.oauthClientId || !config.oauthClientSecret) {
    throw new Error('ONSHAPE_OAUTH_CLIENT_ID and ONSHAPE_OAUTH_CLIENT_SECRET must be set in .env');
  }
}

/** The Onshape page where you approve MatePilot's access. `state` guards against forged callbacks. */
export function authorizeUrl(state) {
  requireOAuthConfig();
  const url = new URL(`${config.oauthBase}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.oauthClientId);
  url.searchParams.set('redirect_uri', config.oauthRedirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(fields) {
  requireOAuthConfig();
  // Form-encoded body; URLSearchParams URL-encodes each value (Onshape requires this).
  const body = new URLSearchParams({ ...fields, client_id: config.oauthClientId, client_secret: config.oauthClientSecret });
  const res = await fetch(`${config.oauthBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never include tokens or secrets in errors; Onshape's error body has neither.
    const err = new Error(`Onshape token request (${fields.grant_type}) failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const t = JSON.parse(text);
  return {
    accessToken: t.access_token,
    // A refresh response may omit refresh_token; the caller keeps the old one then.
    refreshToken: t.refresh_token ?? fields.refresh_token ?? null,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  };
}

export const exchangeCode = (code) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.oauthRedirectUri });

export const refreshAccessToken = (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** Who the token belongs to: { id, name }. */
export async function fetchUser(accessToken) {
  const res = await fetch(`${config.base}/api/users/sessioninfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Could not read your Onshape user info: HTTP ${res.status}`);
  const u = await res.json();
  return { id: u.id, name: u.name };
}
