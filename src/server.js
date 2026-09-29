// Local server: serves the panel page and does all Onshape calls for it.
// Listens on 127.0.0.1 only, so nothing outside this computer can reach it.
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

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(config.root, 'public')));

// token -> { kind: 'mate' | 'undo', ctx, ..., createdAt }. A "yes" can only do what was just shown.
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
    console.error(e);
    res.status(500).json({ error: e.message });
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
    console.error(e);
    res.status(500).json({ error: e.message });
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
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cancel', (req, res) => {
  pending.delete(req.body?.token);
  res.json({ ok: true });
});

const host = '127.0.0.1';
const onListen = (proto) => () =>
  console.log(
    `MatePilot panel: ${proto}://localhost:${config.port}/panel.html\n` +
      `Mate creation is ${config.allowWrites ? 'ON (real mates will be created)' : 'in DRY-RUN mode (nothing is written to Onshape)'}.`
  );

if (config.httpsKey && config.httpsCert) {
  https
    .createServer({ key: readFileSync(config.httpsKey), cert: readFileSync(config.httpsCert) }, app)
    .listen(config.port, host, onListen('https'));
} else {
  app.listen(config.port, host, onListen('http'));
}
