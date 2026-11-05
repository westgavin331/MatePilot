// Loads settings from .env (server-side only; nothing here is ever sent to the browser).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Render sets RENDER=true and RENDER_EXTERNAL_URL (e.g. https://matepilot.onrender.com) by itself.
const hosted = process.env.RENDER === 'true';
const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.RENDER_EXTERNAL_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  root,
  accessKey: process.env.ONSHAPE_ACCESS_KEY?.trim() || '',
  secretKey: process.env.ONSHAPE_SECRET_KEY?.trim() || '',
  base: (process.env.ONSHAPE_BASE || 'https://cad.onshape.com').replace(/\/+$/, ''),
  port,
  hosted,
  publicUrl,
  // Key that encrypts the login cookie. Required when hosted; any long random text.
  sessionSecret: process.env.SESSION_SECRET?.trim() || '',
  allowWrites: process.env.MATEPILOT_ALLOW_WRITES === 'true',
  // Hard lock: documents MatePilot may change. Empty = no document can be changed.
  writeDocs: (process.env.MATEPILOT_WRITE_DOCS || '').split(',').map((s) => s.trim()).filter(Boolean),
  httpsKey: process.env.HTTPS_KEY?.trim() || '',
  httpsCert: process.env.HTTPS_CERT?.trim() || '',

  // How MatePilot signs in to Onshape: 'apikey' (the key pair above) or 'oauth'
  // (you log in through the browser). Anything other than 'oauth' means 'apikey'.
  authMode: process.env.ONSHAPE_AUTH_MODE?.trim() === 'oauth' ? 'oauth' : 'apikey',
  oauthBase: (process.env.ONSHAPE_OAUTH_BASE || 'https://oauth.onshape.com').replace(/\/+$/, ''),
  oauthClientId: process.env.ONSHAPE_OAUTH_CLIENT_ID?.trim() || '',
  oauthClientSecret: process.env.ONSHAPE_OAUTH_CLIENT_SECRET?.trim() || '',
  oauthRedirectUri: process.env.ONSHAPE_OAUTH_REDIRECT_URI?.trim() || `${publicUrl}/oauth/callback`,
};

export function requireKeys() {
  if (!config.accessKey || !config.secretKey) {
    throw new Error(
      'No API keys found. Open MatePilot\\.env and fill in ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY ' +
        '(Onshape > My account > API keys).'
    );
  }
}
