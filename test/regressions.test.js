// Offline tests for problems found while testing against real Onshape.
// A fake Onshape client stands in for the network, so nothing here touches an account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScript, fsRequestBody } from '../src/geometry.js';
import { PARAMS, createFastenedMates, findLastBatch, undoBatch } from '../src/mates.js';
import { matedPaths } from '../src/assembly.js';
import { assertWriteAllowed } from '../src/onshape.js';

const ctx = { documentId: 'd'.repeat(24), wvmType: 'w', wvmId: 'w'.repeat(24), elementId: 'e'.repeat(24) };
const MM = 0.001;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// The real test assembly's bolt and hole (shaft points +Z, hole points -Z).
function pair(n = 1) {
  const x = n * 10 * MM;
  return {
    bolt: { occ: { name: `bolt ${n}`, path: [`B${n}`] }, face: { id: 'JaG' }, world: { start: [x, 0, -4.32 * MM], end: [x, 0, 4.78 * MM], axis: [0, 0, 1], radius: 2.413 * MM } },
    hole: { occ: { name: `plate ${n}`, path: [`P${n}`] }, face: { id: 'JHC' }, world: { start: [x, 0, 3.18 * MM], end: [x, 0, 0], axis: [0, 0, -1], radius: 2.54 * MM } },
  };
}

/**
 * Fake Onshape. `statuses` is the featureStatus returned for each created feature in order
 * (default OK). `moveOnMate` makes the part at that path move once a mate exists.
 */
function fakeOnshape({ statuses = [], moveOnMate = null, ids = [], features = [] } = {}) {
  const calls = [];
  let created = 0;
  const live = [...features];
  const transform = (p) => (moveOnMate === p && live.some((f) => f.featureType === 'mate') ? [1, 0, 0, 0.002, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : IDENTITY);
  return {
    calls,
    live,
    async get(path) {
      calls.push(['GET', path]);
      if (path.endsWith('/features')) return { features: live };
      return { rootAssembly: { occurrences: ['B1', 'P1', 'B2', 'P2'].map((p) => ({ path: [p], transform: transform(p) })) } };
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      const featureId = ids[created] ?? `F${created + 1}`;
      const status = statuses[created] ?? 'OK';
      created++;
      live.push({ featureId, name: body.feature.name, featureType: body.feature.featureType });
      return { feature: { featureId }, featureState: { featureStatus: status } };
    },
    async del(path) {
      calls.push(['DELETE', path]);
      const id = decodeURIComponent(path.split('/featureid/')[1]);
      const i = live.findIndex((f) => f.featureId === id);
      if (i >= 0) live.splice(i, 1);
    },
  };
}

test('FeatureScript request sends queries as an object, not an array (array gave HTTP 400)', () => {
  const body = fsRequestBody(['JHD']);
  assert.equal(Array.isArray(body.queries), false);
  assert.deepEqual(body.queries, {});
});

test('FeatureScript avoids the reserved word "box", the unavailable evBoundingBox and the TransientId cast', () => {
  const s = buildScript(['JHD']);
  assert.doesNotMatch(s, /\bvar box\b/);
  assert.doesNotMatch(s, /evBoundingBox/);
  assert.doesNotMatch(s, /as TransientId/);
  assert.match(s, /evBox3d/);
});

test('mate connectors use MID_AXIS_POINT (CENTROID errors on cylindrical faces)', async () => {
  const { results } = await createFastenedMates(ctx, [pair()], { dryRun: true });
  const inference = results.filter((r) => r.feature.featureType === 'mateConnector').map((r) => r.feature.parameters[1].queries[0].inferenceType);
  assert.deepEqual(inference, ['MID_AXIS_POINT', 'MID_AXIS_POINT']);
});

test('every parameter id MatePilot sends exists in Onshape\'s feature specs (there is no "ownerPart")', () => {
  // From scripts/05-featurespecs.js against the real account.
  const known = new Set(['originType', 'originQuery', 'originAdditionalQuery', 'realign', 'primaryAxisQuery', 'secondaryAxisQuery', 'transform',
    'translationX', 'translationY', 'translationZ', 'rotationType', 'rotation', 'flipPrimary', 'secondaryAxisType', 'mateType',
    'mateConnectorsQuery', 'mateOffsetEnabled', 'primaryAxisAlignment', 'secondaryAxisAlignment']);
  for (const [k, v] of Object.entries(PARAMS)) assert.ok(known.has(v), `${k} = ${v} is not a real parameter`);
});

test('an ERROR feature status is a failure even though nothing moved, and its features are deleted', async () => {
  const fake = fakeOnshape({ statuses: ['ERROR'] });
  const { error, results } = await createFastenedMates(ctx, [pair()], { dryRun: false, client: fake });
  assert.match(error, /ERROR/);
  assert.equal(results[0].ok, false);
  assert.equal(fake.live.length, 0, 'the errored feature must be deleted');
});

test('a mate that comes back ERROR after two OK connectors deletes all three', async () => {
  const fake = fakeOnshape({ statuses: ['OK', 'OK', 'ERROR'] });
  await createFastenedMates(ctx, [pair()], { dryRun: false, client: fake });
  assert.equal(fake.live.length, 0);
  const deletes = fake.calls.filter((c) => c[0] === 'DELETE').map((c) => c[1].split('/featureid/')[1]);
  assert.deepEqual(deletes, ['F3', 'F2', 'F1'], 'mate is deleted before the connectors it uses');
});

test('feature ids containing "/" are URL-encoded when deleting', async () => {
  const fake = fakeOnshape({ statuses: ['ERROR'], ids: ['MsOcj3/EsXO74yG9N'] });
  await createFastenedMates(ctx, [pair()], { dryRun: false, client: fake });
  const del = fake.calls.find((c) => c[0] === 'DELETE')[1];
  assert.match(del, /featureid\/MsOcj3%2FEsXO74yG9N$/);
  assert.equal(fake.live.length, 0);
});

test('a mate that moves a part is undone', async () => {
  const fake = fakeOnshape({ moveOnMate: 'B1' });
  const { error } = await createFastenedMates(ctx, [pair()], { dryRun: false, client: fake });
  assert.match(error, /moved a part/);
  assert.equal(fake.live.length, 0);
});

test('after a failure it stops, keeps earlier good mates, and does not try later ones', async () => {
  const fake = fakeOnshape({ statuses: ['OK', 'OK', 'OK', 'ERROR'] });
  const { results, error } = await createFastenedMates(ctx, [pair(1), pair(2), pair(3)], { dryRun: false, client: fake });
  assert.ok(error);
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  assert.equal(fake.live.length, 3, 'only the first pair\'s three features remain');
});

test('undo finds only the newest tagged batch and deletes mates before connectors', async () => {
  const fake = fakeOnshape({
    features: [
      { featureId: 'old', name: 'MatePilot fasten 1', featureType: 'mate' }, // made before batch tags existed
      { featureId: 'a1', name: 'MatePilot hole 1 [mp-aaa]', featureType: 'mateConnector' },
      { featureId: 'b1', name: 'MatePilot hole 1 [mp-bbb]', featureType: 'mateConnector' },
      { featureId: 'b3', name: 'MatePilot fasten 1 [mp-bbb]', featureType: 'mate' },
      { featureId: 'b2', name: 'MatePilot bolt 1 [mp-bbb]', featureType: 'mateConnector' },
      { featureId: 'u1', name: 'Fastened 1', featureType: 'mate' }, // the user's own mate
    ],
  });
  const batch = await findLastBatch(ctx, fake);
  assert.equal(batch.batchId, 'bbb');
  assert.deepEqual(batch.features.map((f) => f.featureId).sort(), ['b1', 'b2', 'b3']);

  const dry = await undoBatch(ctx, batch, { dryRun: true, client: fake });
  assert.equal(dry.wouldDelete.length, 3);
  assert.equal(fake.calls.filter((c) => c[0] === 'DELETE').length, 0, 'dry run deletes nothing');

  const r = await undoBatch(ctx, batch, { dryRun: false, client: fake });
  assert.equal(r.deleted, 3);
  assert.deepEqual(r.leftover, []);
  assert.equal(fake.calls.find((c) => c[0] === 'DELETE')[1].split('/featureid/')[1], 'b3', 'mate deleted first');
  assert.deepEqual(fake.live.map((f) => f.featureId), ['old', 'a1', 'u1'], 'older batches and the user\'s mates are untouched');
});

test('undo with nothing from MatePilot returns an empty batch', async () => {
  const fake = fakeOnshape({ features: [{ featureId: 'u1', name: 'Fastened 1', featureType: 'mate' }] });
  assert.deepEqual(await findLastBatch(ctx, fake), { batchId: null, features: [] });
});

test('bolts that already have a mate are recognised (so re-running never duplicates mates)', () => {
  const def = {
    rootAssembly: {
      features: [
        { featureType: 'mate', suppressed: false, featureData: { matedEntities: [{ matedOccurrence: ['B1'] }, { matedOccurrence: ['P1'] }] } },
        { featureType: 'mate', suppressed: true, featureData: { matedEntities: [{ matedOccurrence: ['B9'] }] } },
      ],
    },
  };
  const paths = matedPaths(def);
  assert.ok(paths.has('B1'));
  assert.ok(!paths.has('B9'), 'suppressed mates do not count');
});

test('bolts mated inside a sub-assembly count as already mated (chassis: 92 of 93 were)', () => {
  const sub = { documentId: 'D', elementId: 'S', documentMicroversion: 'M', configuration: 'default', fullConfiguration: 'default',
    instances: [{ id: 'bolt', type: 'Part' }, { id: 'plate', type: 'Part' }],
    features: [{ featureType: 'mate', suppressed: false, featureData: { matedEntities: [{ matedOccurrence: ['bolt'] }, { matedOccurrence: ['plate'] }] } }] };
  const def = {
    rootAssembly: {
      instances: [{ id: 'mod1', type: 'Assembly', documentId: 'D', elementId: 'S', documentMicroversion: 'M', configuration: 'default', fullConfiguration: 'default' },
                  { id: 'mod2', type: 'Assembly', documentId: 'D', elementId: 'S', documentMicroversion: 'M', configuration: 'default', fullConfiguration: 'default' },
                  { id: 'loose', type: 'Part' }],
      features: [],
    },
    subAssemblies: [sub],
  };
  const paths = matedPaths(def);
  assert.ok(paths.has('mod1/bolt'));
  assert.ok(paths.has('mod2/bolt'), 'every instance of the sub-assembly counts');
  assert.ok(!paths.has('bolt'), 'paths are made absolute');
  assert.ok(!paths.has('loose'));
});

test('write lock: only allow-listed documents can be changed; reads and FeatureScript are always allowed', () => {
  const allowed = ['a'.repeat(24)];
  const path = (doc, tail) => `/assemblies/d/${doc}/w/${'w'.repeat(24)}/e/${'e'.repeat(24)}${tail}`;
  assert.doesNotThrow(() => assertWriteAllowed('POST', path('a'.repeat(24), '/features'), allowed));
  assert.throws(() => assertWriteAllowed('POST', path('b'.repeat(24), '/features'), allowed), /Blocked/);
  assert.throws(() => assertWriteAllowed('DELETE', path('b'.repeat(24), '/features/featureid/x'), allowed), /Blocked/);
  assert.throws(() => assertWriteAllowed('POST', path('a'.repeat(24), '/features'), []), /Blocked/, 'empty list blocks everything');
  assert.doesNotThrow(() => assertWriteAllowed('GET', path('b'.repeat(24), '/features'), []));
  assert.doesNotThrow(() => assertWriteAllowed('POST', `/partstudios/d/${'b'.repeat(24)}/m/${'m'.repeat(24)}/e/${'e'.repeat(24)}/featurescript`, []));
});

test('FeatureScript rate limit (429) stops the scan with a clear message and makes no per-part retries', async () => {
  const { getCylinderFaces } = await import('../src/geometry.js');
  let calls = 0;
  const evaluate = async () => {
    calls++;
    throw Object.assign(new Error('HTTP 429'), { status: 429, body: 'Onshape asked to wait 83307 s before retrying.' });
  };
  const refs = ['A', 'B', 'C'].map((partId) => ({ documentId: 'd', wvmType: 'v', wvmId: 'v', elementId: 'e', partId, configuration: '' }));
  await assert.rejects(getCylinderFaces(refs, { evaluate, fallback: null }), /limit on geometry reads.*24 hour/);
  assert.equal(calls, 1, 'one studio, one call: no part-by-part retries after a 429');
});

test('no access (403) to a part studio is reported without retrying each part', async () => {
  const { getCylinderFaces } = await import('../src/geometry.js');
  let calls = 0;
  const evaluate = async () => {
    calls++;
    throw Object.assign(new Error('HTTP 403'), { status: 403 });
  };
  const refs = ['A', 'B'].map((partId) => ({ documentId: 'd', wvmType: 'v', wvmId: 'v', elementId: 'e', partId, configuration: '' }));
  const { errors } = await getCylinderFaces(refs, { evaluate, fallback: null });
  assert.equal(calls, 1);
  assert.deepEqual(errors.map((e) => e.partId), ['A', 'B']);
});

test('when FeatureScript is rate-limited, geometry comes from body details instead', async () => {
  const { getCylinderFaces } = await import('../src/geometry.js');
  const evaluate = async () => { throw Object.assign(new Error('HTTP 429'), { status: 429, body: '' }); };
  const fallback = async (ref, ids) => ids.map((partId) => ({ partId, faces: [{ id: 'JHC' }] }));
  const refs = [{ documentId: 'd', wvmType: 'w', wvmId: 'w', elementId: 'e', partId: 'JHD', configuration: '' }];
  const r = await getCylinderFaces(refs, { evaluate, fallback });
  assert.equal(r.source, 'bodydetails');
  assert.equal([...r.faces.values()][0][0].id, 'JHC');
});

test('body details: the real test plate hole is concave and the real bolt shaft is convex, with correct extents', async () => {
  const { facesFromBodyDetails, isConcave, pickShaft } = await import('../src/geometry.js');
  const v = (x, y, z) => ({ x, y, z });
  const box = (a, b) => ({ minCorner: v(...a), maxCorner: v(...b) });
  // Values copied from Onshape's bodydetails for the test document (meters).
  const plate = { faces: [
    { id: 'JHC', orientation: false, box: box([-0.00254, -0.00254, 0], [0.00254, 0.00254, 0.003175]),
      surface: { type: 'CYLINDER', radius: 0.00254, origin: v(0, 0, 0.003175), axis: v(0, 0, -1) } },
    { id: 'top', orientation: true, box: box([-0.0127, -0.0127, 0.003175], [0.0127, 0.0127, 0.003175]), surface: { type: 'PLANE' } },
  ] };
  const bolt = { faces: [
    { id: 'JTK', orientation: true, box: box([-0.004585, -0.004585, 0], [0.004585, 0.004585, 0.00051]),
      surface: { type: 'CYLINDER', radius: 0.004585, origin: v(0, 0, 0.0025654), axis: v(0, 0, -1) } },
    { id: 'JaG', orientation: true, box: box([-0.002413, -0.002413, -0.0091], [0.002413, 0.002413, 0]),
      surface: { type: 'CYLINDER', radius: 0.002413, origin: v(0, 0, -0.009525), axis: v(0, 0, 1) } },
    { id: 'head', orientation: true, box: box([-0.0048, -0.0048, 0], [0.0048, 0.0048, 0.0025]), surface: { type: 'PLANE' } },
  ] };
  const [hole] = facesFromBodyDetails(plate);
  assert.equal(isConcave(hole), true);
  assert.ok(Math.abs(hole.zMax - hole.zMin - 0.003175) < 1e-9, 'hole runs the full plate thickness');
  const shaft = pickShaft(facesFromBodyDetails(bolt));
  assert.equal(shaft.id, 'JaG', 'the long thin cylinder is the shaft, not the head');
  assert.equal(isConcave(shaft), false);
  assert.ok(shaft.bodyZMax - shaft.zMax > shaft.zMin - shaft.bodyZMin, 'head is at the +axis end');
});
