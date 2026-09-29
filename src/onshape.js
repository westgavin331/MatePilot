// Minimal Onshape REST client. Uses HTTP Basic auth with the API key pair.
import { config, requireKeys } from './config.js';

const API_VERSION = 'v10';

export class OnshapeError extends Error {
  constructor(status, method, path, body) {
    super(`Onshape ${method} ${path} failed: HTTP ${status} ${hint(status)}\n${String(body).slice(0, 600)}`);
    this.status = status;
    this.body = body;
  }
}

function hint(status) {
  switch (status) {
    case 401: return '(the API keys were rejected - check .env for typos or a deleted key)';
    case 403: return '(the key is missing a permission, or you cannot access this document)';
    case 404: return '(document/element/part not found - check the URL and ids)';
    case 429: return '(rate limited by Onshape)';
    default: return '';
  }
}

function authHeader() {
  requireKeys();
  return 'Basic ' + Buffer.from(`${config.accessKey}:${config.secretKey}`).toString('base64');
}

// Counts API calls made by this process (Onshape limits calls per account).
export const stats = { calls: 0 };

/**
 * Throws unless a changing request targets a document on the MATEPILOT_WRITE_DOCS list.
 * FeatureScript evaluation is a POST but only reads, so it is allowed anywhere.
 */
export function assertWriteAllowed(method, path, writeDocs = config.writeDocs) {
  if (method === 'GET' || /\/featurescript$/.test(path)) return;
  const doc = path.match(/\/d\/([0-9a-f]{24})\//)?.[1];
  if (!doc || !writeDocs.includes(doc)) {
    throw new Error(`Blocked: MatePilot is not allowed to change document ${doc ?? '(unknown)'}. Add it to MATEPILOT_WRITE_DOCS in .env to allow.`);
  }
}

/** Call an Onshape endpoint. `path` starts with '/' and excludes '/api/vN'. */
export async function api(method, path, { query, body } = {}) {
  assertWriteAllowed(method, path);
  const url = new URL(`${config.base}/api/${API_VERSION}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; ; attempt++) {
    stats.calls++;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json;charset=UTF-8; qs=0.09',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });

    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      // Never sit silently for long: give up if Onshape asks for more than 20 s.
      if (wait > 20000) throw new OnshapeError(429, method, path, `Onshape asked to wait ${Math.round(wait / 1000)} s before retrying.`);
      console.warn(`Onshape rate limit: waiting ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new OnshapeError(res.status, method, path, text);
    return text ? JSON.parse(text) : null;
  }
}

export const get = (path, query) => api('GET', path, { query });
export const post = (path, body, query) => api('POST', path, { body, query });

/** Run async `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
