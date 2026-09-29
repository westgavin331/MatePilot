// Step 7: create mate connectors + a fastened mate for each matched bolt.
//
// Hole connector: middle of the hole's axis (MID_AXIS_POINT; CENTROID errors on cylinders).
// Bolt connector: middle of the shaft's axis, moved along its axis so it lands exactly
// on the hole connector's position. If the two axes point opposite ways, the mate's
// "flip primary axis" is set. Result: the mate locks the bolt where it already sits.
//
// Real runs verify themselves: if the bolt or the holed part moved after the mate was
// added, the three new features are deleted again.
import { api, get, post } from './onshape.js';
import { sub, dot, scale, add, norm } from './transform.js';

// Onshape parameter ids (checked with scripts/05-featurespecs.js).
export const PARAMS = {
  originType: 'originType',
  originQuery: 'originQuery',
  transform: 'transform',
  translationZ: 'translationZ',
  mateType: 'mateType',
  mateConnectors: 'mateConnectorsQuery',
  mateFlip: 'primaryAxisAlignment',
};

const MOVE_TOLERANCE = 0.00001; // 0.01 mm
const mid = (c) => scale(add(c.start, c.end), 0.5);

function mateConnectorFeature(name, item, offsetZ = 0) {
  const parameters = [
    { btType: 'BTMParameterEnum-145', parameterId: PARAMS.originType, enumName: 'Origin type', value: 'ON_ENTITY' },
    {
      btType: 'BTMParameterQueryWithOccurrenceList-67',
      parameterId: PARAMS.originQuery,
      queries: [
        {
          btType: 'BTMInferenceQueryWithOccurrence-1083',
          inferenceType: 'MID_AXIS_POINT',
          path: item.occ.path,
          deterministicIds: [item.face.id],
        },
      ],
    },
  ];
  if (Math.abs(offsetZ) > 1e-9) {
    parameters.push(
      { btType: 'BTMParameterBoolean-144', parameterId: PARAMS.transform, value: true },
      { btType: 'BTMParameterQuantity-147', parameterId: PARAMS.translationZ, expression: `${(offsetZ * 1000).toFixed(6)} mm`, isInteger: false, value: 0, units: '' }
    );
  }
  return { btType: 'BTMMateConnector-66', featureType: 'mateConnector', name, parameters };
}

function fastenedMateFeature(name, connectorIdA, connectorIdB, flip) {
  const parameters = [
    { btType: 'BTMParameterEnum-145', parameterId: PARAMS.mateType, enumName: 'Mate type', value: 'FASTENED' },
    {
      btType: 'BTMParameterQueryWithOccurrenceList-67',
      parameterId: PARAMS.mateConnectors,
      queries: [connectorIdA, connectorIdB].map((featureId) => ({
        btType: 'BTMFeatureQueryWithOccurrence-157',
        featureId,
        path: [],
        queryData: '',
      })),
    },
  ];
  if (flip) parameters.push({ btType: 'BTMParameterBoolean-144', parameterId: PARAMS.mateFlip, value: true });
  return { btType: 'BTMMate-64', featureType: 'mate', name, parameters };
}

/** How far to slide the bolt connector along the shaft axis, and whether to flip. */
export function boltConnectorAdjustment(bolt, hole) {
  const offsetZ = dot(sub(mid(hole.world), mid(bolt.world)), bolt.world.axis);
  const flip = dot(bolt.world.axis, hole.world.axis) < 0;
  return { offsetZ, flip };
}

const realClient = {
  get,
  post,
  del: (path) => api('DELETE', path),
};

const featuresPath = (ctx) => `/assemblies/d/${ctx.documentId}/w/${ctx.wvmId}/e/${ctx.elementId}/features`;

async function occurrenceTransforms(ctx, client) {
  const def = await client.get(`/assemblies/d/${ctx.documentId}/w/${ctx.wvmId}/e/${ctx.elementId}`, { includeMateFeatures: false });
  return new Map(def.rootAssembly.occurrences.map((o) => [o.path.join('/'), o.transform]));
}

export function moved(before, after, path) {
  const a = before.get(path.join('/'));
  const b = after.get(path.join('/'));
  if (!a || !b) return false;
  // Compare translation (meters) and rotation entries.
  const t = norm([a[3] - b[3], a[7] - b[7], a[11] - b[11]]);
  const r = Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => Math.abs(a[i] - b[i])));
  return t > MOVE_TOLERANCE || r > 1e-5;
}

// Every run tags its features' names with a batch id, e.g. "MatePilot fasten 1 [mp-lq3x9a]",
// so "undo" can find the latest run's features even after a server restart.
const BATCH_TAG = /\[mp-([0-9a-z]+)\]$/;
export const newBatchId = () => Date.now().toString(36);

/**
 * pairs: [{ bolt, hole }] (world-matched entries from the pipeline).
 * With dryRun, nothing is sent. Stops at the first pair that fails (after undoing
 * that pair's features). Returns { batchId, results, error }.
 */
export async function createFastenedMates(ctx, pairs, { dryRun = true, log = () => {}, client = realClient, batchId = newBatchId() } = {}) {
  if (ctx.wvmType !== 'w') throw new Error('Mates can only be added in a workspace, not a version.');
  const base = featuresPath(ctx);
  const results = [];
  const tag = ` [mp-${batchId}]`;

  for (let i = 0; i < pairs.length; i++) {
    const { bolt, hole } = pairs[i];
    const n = i + 1;
    const { offsetZ, flip } = boltConnectorAdjustment(bolt, hole);
    const features = [];

    const addFeature = async (feature) => {
      if (dryRun) {
        results.push({ dryRun: true, url: base, feature });
        return `DRYRUN_${results.length}`;
      }
      const res = await client.post(base, { feature });
      const id = res?.feature?.featureId;
      if (!id) throw new Error(`Onshape did not return a feature id for "${feature.name}"`);
      features.push(id);
      const status = res.featureState?.featureStatus;
      if (status !== 'OK') throw new Error(`Onshape marked "${feature.name}" as ${status ?? 'unknown'}`);
      return id;
    };

    try {
      const before = dryRun ? null : await occurrenceTransforms(ctx, client);
      const holeMc = await addFeature(mateConnectorFeature(`MatePilot hole ${n}${tag}`, hole));
      const boltMc = await addFeature(mateConnectorFeature(`MatePilot bolt ${n}${tag}`, bolt, offsetZ));
      await addFeature(fastenedMateFeature(`MatePilot fasten ${n}${tag}`, holeMc, boltMc, flip));
      if (!dryRun) {
        const after = await occurrenceTransforms(ctx, client);
        if (moved(before, after, bolt.occ.path) || moved(before, after, hole.occ.path)) throw new Error('the mate moved a part');
      }
    } catch (e) {
      await deleteFeatures(ctx, features, client);
      const error = `Mate ${n} (${bolt.occ.name} → ${hole.occ.name}) failed and was undone: ${e.message}. Stopped here; ${n - 1} earlier mate(s) were kept.`;
      results.push({ pair: n, ok: false, error });
      log(error);
      return { batchId, results, error };
    }

    if (dryRun) log(`[dry run] ${bolt.occ.name} → ${hole.occ.name} (bolt connector shift ${(offsetZ * 1000).toFixed(3)} mm, flip ${flip})`);
    else {
      results.push({ pair: n, ok: true, featureIds: features });
      log(`Mated ${bolt.occ.name} → ${hole.occ.name}`);
    }
  }
  return { batchId, results, error: null };
}

/** Deletes features (mates before connectors). Returns ids that could not be deleted. */
export async function deleteFeatures(ctx, featureIds, client = realClient) {
  const failed = [];
  for (const id of [...featureIds].reverse()) {
    try {
      await client.del(`${featuresPath(ctx)}/featureid/${encodeURIComponent(id)}`);
    } catch (e) {
      failed.push(id);
      console.error(`Could not delete feature ${id}: ${e.message}`);
    }
  }
  return failed;
}

/** Finds the features from MatePilot's most recent run in this assembly. */
export async function findLastBatch(ctx, client = realClient) {
  const { features } = await client.get(featuresPath(ctx));
  let latest = null;
  for (const f of features) {
    const b = f.name?.match(BATCH_TAG)?.[1];
    if (b && (!latest || parseInt(b, 36) > parseInt(latest, 36))) latest = b;
  }
  if (!latest) return { batchId: null, features: [] };
  // Order: connectors before the mates that use them, so reverse-order deletion is safe.
  const batch = features.filter((f) => f.name?.match(BATCH_TAG)?.[1] === latest);
  batch.sort((a, b) => (a.featureType === 'mate') - (b.featureType === 'mate'));
  return { batchId: latest, features: batch.map((f) => ({ featureId: f.featureId, name: f.name, featureType: f.featureType })) };
}

/** Deletes the given batch's features and confirms they are gone. */
export async function undoBatch(ctx, batch, { dryRun = true, client = realClient } = {}) {
  if (dryRun) return { dryRun: true, deleted: 0, wouldDelete: batch.features.map((f) => f.name), leftover: [] };
  await deleteFeatures(ctx, batch.features.map((f) => f.featureId), client);
  const { features } = await client.get(featuresPath(ctx));
  const remaining = new Set(features.map((f) => f.featureId));
  const leftover = batch.features.filter((f) => remaining.has(f.featureId)).map((f) => f.name);
  return { dryRun: false, deleted: batch.features.length - leftover.length, leftover };
}
