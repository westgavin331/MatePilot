// Loads settings from .env (server-side only; nothing here is ever sent to the browser).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  root,
  accessKey: process.env.ONSHAPE_ACCESS_KEY?.trim() || '',
  secretKey: process.env.ONSHAPE_SECRET_KEY?.trim() || '',
  base: (process.env.ONSHAPE_BASE || 'https://cad.onshape.com').replace(/\/+$/, ''),
  port: Number(process.env.PORT || 3000),
  allowWrites: process.env.MATEPILOT_ALLOW_WRITES === 'true',
  // Hard lock: documents MatePilot may change. Empty = no document can be changed.
  writeDocs: (process.env.MATEPILOT_WRITE_DOCS || '').split(',').map((s) => s.trim()).filter(Boolean),
  httpsKey: process.env.HTTPS_KEY?.trim() || '',
  httpsCert: process.env.HTTPS_CERT?.trim() || '',
};

export function requireKeys() {
  if (!config.accessKey || !config.secretKey) {
    throw new Error(
      'No API keys found. Open MatePilot\\.env and fill in ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY ' +
        '(Onshape > My account > API keys).'
    );
  }
}
