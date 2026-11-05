// Serves the panel page and does all Onshape calls for it. On your own computer it
// listens on 127.0.0.1 only; when hosted (Render) it must accept outside connections.
import express from 'express';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { assertIds } from './url.js';
import { scanAssembly } from './pipeline.js';
import { createFastenedMates, findLastBatch, undoBatch } from './mates.js';
import { mm } from './match.js';
import { sessionMiddleware, rejectCrossSite } from './session.js';
import { authorizeUrl, exchangeCode, fetchUser } from './oauth.js';
import { runAsUser, lastScheme } from './auth.js';
import { get } from './onshape.js';
import { randomBytes } from 'node:crypto';

// Hosted on the open internet: refuse settings that are only safe on your own computer.
if (config.hosted) {
  if (config.authMode !== 'oauth') {
    throw new Error('Hosted MatePilot must use ONSHAPE_AUTH_MODE=oauth: with API keys, anyone who finds the address would be acting as you in Onshape.');
  }
  if (config.sessionSecret.length < 32) {
    throw new Error('Set SESSION_SECRET (at least 32 random characters) so logins survive restarts and cannot be forged.');
  }
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(sessionMiddleware());
app.use(express.static(path.join(config.root, 'public')));

// ---- OAuth login ----

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px">${body}</body>`;

// Step 1: send the browser to Onshape's approval page.
app.get('/oauth/login', (req, res) => {
  try {
    req.session.oauthState = randomBytes(24).toString('base64url');
    res.redirect(authorizeUrl(req.session.oauthState));
  } catch (e) {
    res.status(500).send(page('Login error', `<p>${escapeHtml(e.message)}</p>`));
  }
});

// Step 2: Onshape sends the browser back here with a one-time code.
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const expected = req.session.oauthState;
  req.session.oauthState = null; // one use only
  if (error) return res.status(400).send(page('Login cancelled', `<p>Onshape said: ${escapeHtml(error)}</p><p><a href="/oauth/login">Try again</a></p>`));
  if (!code || !expected || state !== expected) {
    return res.status(400).send(page('Login failed', '<p>This login link was not started here or has already been used.</p><p><a href="/oauth/login">Start again</a></p>'));
  }
  try {
    const tokens = await exchangeCode(String(code));
    const user = await fetchUser(tokens.accessToken);
    // Step 3: keep the tokens in the encrypted session cookie (only the server can read it).
    req.session.userId = user.id;
    req.session.tokens = { ...tokens, user };
    res.redirect('/oauth/status');
  } catch (e) {
    console.error(e.message);
    res.status(502).send(page('Login failed', `<p>${escapeHtml(e.message)}</p><p><a href="/oauth/login">Try again</a></p>`));
  }
});

// Shows who is logged in. Never shows the tokens themselves.
app.get('/oauth/status', (req, res) => {
  const t = req.session.tokens;
  if (!t) return res.send(page('MatePilot', `<p>Not logged in to Onshape. <a href="/oauth/login">Log in</a></p><p>Auth mode: <b>${config.authMode}</b></p>`));
  const mins = Math.round((t.expiresAt - Date.now()) / 60000);
  // Opened as the panel's login pop-up: tell the panel, then close. (Onshape's login pages
  // may cut the link to the panel; the panel also checks /api/whoami on its own.)
  const closePopup = `<script>if (window.opener) { try { window.opener.postMessage({ matepilot: 'login-changed' }, location.origin); } catch {} document.body.insertAdjacentHTML('beforeend', '<p>This window will close…</p>'); setTimeout(() => window.close(), 1200); }</script>`;
  res.send(page('MatePilot', `<p>✅ Logged in to Onshape as <b>${escapeHtml(t.user.name)}</b>.</p>` +
    `<p>Access token ${mins > 0 ? `valid for about ${mins} more minutes` : 'expired (will refresh on next use)'}; refresh token ${t.refreshToken ? 'stored' : '<b>missing</b>'}.</p>` +
    `<p>Auth mode: <b>${config.authMode}</b></p><p><a href="/oauth/logout">Log out</a></p>` + closePopup));
});

// Every /api request runs as the user its browser session belongs to (null if nobody
// is logged in). Onshape calls made while handling it use that user's token.
app.use('/api', rejectCrossSite());
app.use('/api', (req, res, next) => runAsUser(req.session.userId, next));

// Lets the panel ask whether it needs a login. Answered from memory: no Onshape call.
app.get('/api/whoami', (req, res) => {
  const t = req.session.tokens;
  res.json({ authMode: config.authMode, loggedIn: config.authMode === 'apikey' || Boolean(t), user: t?.user?.name ?? null });
});

/** Sends an error as JSON; "not logged in" becomes a 401 with a login link. */
function fail(res, e) {
  if (e.status === 401 && e.loginUrl) return res.status(401).json({ error: e.message, login: e.loginUrl });
  console.error(e);
  res.status(500).json({ error: e.message });
}

// End-to-end check: lists your 5 newest documents and says how the call was signed.
app.get('/api/me/documents', async (req, res) => {
  try {
    const r = await get('/documents', { limit: 5, sortColumn: 'modifiedAt', sortOrder: 'desc' });
    const user = req.session.tokens?.user?.name ?? null;
    res.json({
      authMode: config.authMode,
      signedWith: lastScheme() === 'Bearer' ? 'OAuth token (Bearer)' : 'API keys (Basic)',
      user,
      documents: (r.items ?? []).map((d) => d.name),
    });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/oauth/logout', (req, res) => {
  req.session.userId = null;
  req.session.tokens = null;
  res.redirect('/oauth/status');
});

// token -> { kind: 'mate' | 'undo', ctx, ..., createdAt }. A "yes" can only do what was just shown.
// Kept in memory on purpose: if the server restarts in between, the panel says to scan again.
const pending = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;

function contextFrom(body) {
  assertIds(body, ['documentId', 'workspaceId', 'elementId']);
  return { documentId: body.documentId, wvmType: 'w', wvmId: body.workspaceId, elementId: body.elementId };
}

app.post('/api/scan', async (req, res) => {
  try {
    const ctx = contextFrom(req.body);
    const r = await scanAssembly(ctx);

    const pairs = r.matches.map((m) => ({ bolt: m.bolt, hole: m.primary.hole, others: m.holes.slice(1).map((h) => h.hole), check: m.primary.check }));
    const token = randomUUID();
    if (pairs.length) pending.set(token, { kind: 'mate', ctx, pairs, createdAt: Date.now() });

    res.json({
      token: pairs.length ? token : null,
      allowWrites: config.allowWrites,
      partCount: r.occurrences.length,
      boltCount: r.bolts.length + r.boltsWithoutShaft.length,
      alreadyMated: r.alreadyMated.length,
      pairs: pairs.map((p, i) => ({
        n: i + 1,
        bolt: p.bolt.occ.name,
        boltDescription: p.bolt.occ.description,
        hole: p.hole.occ.name,
        holeDiameter: mm(p.hole.world.radius * 2),
        clearance: mm(p.check.clearance),
        alsoThrough: p.others.map((h) => h.occ.name),
      })),
      unmatched: r.unmatchedBolts.map((b) => b.occ.name),
      nearMisses: r.nearMisses.map((n) => `${n.bolt.occ.name} ↔ ${n.hole.occ.name}: ${n.check.reason}`),
      warnings: [
        ...r.boltsWithoutShaft.map((o) => `Couldn't find a shaft on ${o.name}`),
        ...r.geometryErrors.map((e) => `Couldn't read geometry for part ${e.partId}: ${e.message}`),
      ],
      highlight: pairs.map((p) => ({ selectionType: 'ENTITY', selectionId: p.hole.face.id, occurrencePath: p.hole.occ.path })),
    });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/confirm', async (req, res) => {
  const job = pending.get(req.body?.token);
  if (!job || Date.now() - job.createdAt > PENDING_TTL_MS) {
    pending.delete(req.body?.token);
    return res.status(400).json({ error: 'Nothing waiting for confirmation (or it expired). Run the scan again.' });
  }
  pending.delete(req.body.token);
  const dryRun = !config.allowWrites;
  try {
    if (job.kind === 'undo') {
      const r = await undoBatch(job.ctx, job.batch, { dryRun });
      return res.json({ kind: 'undo', ...r });
    }
    const log = [];
    const { results, error } = await createFastenedMates(job.ctx, job.pairs, { dryRun, log: (m) => log.push(m) });
    if (dryRun) console.log('[dry run] would send:\n' + JSON.stringify(results, null, 2));
    const created = dryRun ? job.pairs.length : results.filter((r) => r.ok).length;
    res.json({ kind: 'mate', dryRun, created, error, log });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/undo', async (req, res) => {
  try {
    const ctx = contextFrom(req.body);
    const batch = await findLastBatch(ctx);
    if (!batch.features.length) return res.json({ token: null, features: [] });
    const token = randomUUID();
    pending.set(token, { kind: 'undo', ctx, batch, createdAt: Date.now() });
    const mates = batch.features.filter((f) => f.featureType === 'mate').length;
    res.json({ token, allowWrites: config.allowWrites, mates, features: batch.features.map((f) => f.name) });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/cancel', (req, res) => {
  pending.delete(req.body?.token);
  res.json({ ok: true });
});

const host = config.hosted ? '0.0.0.0' : '127.0.0.1';
const onListen = (proto) => () =>
  console.log(
    `MatePilot panel: ${config.hosted ? config.publicUrl : `${proto}://localhost:${config.port}`}/panel.html\n` +
      `Mate creation is ${config.allowWrites ? 'ON (real mates will be created)' : 'in DRY-RUN mode (nothing is written to Onshape)'}.`
  );

if (config.httpsKey && config.httpsCert) {
  https
    .createServer({ key: readFileSync(config.httpsKey), cert: readFileSync(config.httpsCert) }, app)
    .listen(config.port, host, onListen('https'));
} else {
  app.listen(config.port, host, onListen('http'));
}
