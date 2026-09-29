import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPair, matchBoltsToHoles } from '../src/match.js';
import { faceToWorld, applyToPoint, applyToDirection, IDENTITY } from '../src/transform.js';
import { decodeFs, isConcave, pickShaft } from '../src/geometry.js';
import { isBoltDescription } from '../src/bolts.js';

const MM = 0.001;
// A cylinder along Z from z0 to z1 (mm), centered at (x, y) mm.
const cyl = (x, y, z0, z1, r, extra = {}) => ({
  start: [x * MM, y * MM, z0 * MM],
  end: [x * MM, y * MM, z1 * MM],
  axis: [0, 0, 1],
  radius: r * MM,
  headEnd: 'end',
  ...extra,
});

// #10-32 bolt: shaft radius 2.413 mm, clearance hole radius 2.54 mm.
const shaft = cyl(10, 20, 0, 50, 2.413);

test('aligned clearance hole along the shaft matches', () => {
  assert.equal(checkPair(shaft, cyl(10, 20, 40, 46, 2.54)).ok, true);
});

test('hole axis pointing the opposite way still matches', () => {
  const hole = { ...cyl(10, 20, 46, 40, 2.54), axis: [0, 0, -1] };
  assert.equal(checkPair(shaft, hole).ok, true);
});

test('hole offset sideways does not match', () => {
  const r = checkPair(shaft, cyl(10.5, 20, 40, 46, 2.54));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'axes offset');
});

test('hole smaller than the shaft is a near miss', () => {
  const r = checkPair(shaft, cyl(10, 20, 40, 46, 2.0));
  assert.equal(r.ok, false);
  assert.equal(r.collinear, true);
});

test('much bigger hole does not match', () => {
  assert.equal(checkPair(shaft, cyl(10, 20, 40, 46, 5)).ok, false);
});

test('hole on the same line but past the end of the shaft does not match', () => {
  const r = checkPair(shaft, cyl(10, 20, 60, 66, 2.54));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not along the shaft/);
});

test('tilted hole does not match', () => {
  const a = (5 * Math.PI) / 180;
  const hole = { ...cyl(10, 20, 40, 46, 2.54), axis: [Math.sin(a), 0, Math.cos(a)] };
  assert.equal(checkPair(shaft, hole).reason, 'axes not parallel');
});

test('bolt through two plates: primary is the hole nearest the head', () => {
  const bolt = { world: shaft }; // head at z=50 end
  const low = { name: 'low', world: cyl(10, 20, 0, 6, 2.54) };
  const high = { name: 'high', world: cyl(10, 20, 40, 46, 2.54) };
  const { matches } = matchBoltsToHoles([bolt], [low, high]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].holes.length, 2);
  assert.equal(matches[0].primary.hole.name, 'high');
});

test('transform moves local geometry into world space', () => {
  // Rotate 90 degrees about X (local Z -> world +Y), then move by (0.1, 0, 0).
  const m = [1, 0, 0, 0.1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  assert.deepEqual(applyToPoint(m, [0, 0, 1]), [0.1, 1, 0]);
  assert.deepEqual(applyToDirection(m, [0, 0, 1]), [0, 1, 0]);
  const face = { origin: [0, 0, 0], axis: [0, 0, 1], radius: 0.002, zMin: 0.01, zMax: 0.05, bodyZMin: 0.01, bodyZMax: 0.055 };
  const w = faceToWorld(face, IDENTITY);
  assert.deepEqual(w.start, [0, 0, 0.01]);
  assert.equal(w.headEnd, 'end');
});

test('bolt shaft is the longest convex cylinder; holes are concave', () => {
  const head = { minCurvature: 0, zMin: 0, zMax: 5 };
  const body = { minCurvature: 0, zMin: -50, zMax: 0 };
  const bore = { minCurvature: -400, zMin: -60, zMax: 0 };
  assert.equal(pickShaft([head, body, bore]), body);
  assert.equal(isConcave(bore), true);
  assert.equal(isConcave(body), false);
});

test('bolt keyword detection', () => {
  assert.equal(isBoltDescription('#10-32 x 2-1/4" L BHCS (Steel, Black Oxide)'), true);
  assert.equal(isBoltDescription('Socket Head Cap Screw M5 x 20'), true);
  assert.equal(isBoltDescription('Hex Bolt 1/4-20'), true);
  assert.equal(isBoltDescription('Aluminum Hex Shaft 1/2"'), false);
  assert.equal(isBoltDescription('Bolted plate'), false);
  assert.equal(isBoltDescription('Screwdriver holder'), false);
});

test('FeatureScript result decoding', () => {
  const raw = {
    btType: 'BTFSValueArray-1499',
    value: [
      {
        btType: 'BTFSValueMap-2062',
        value: [
          { key: { btType: 'BTFSValueString-1422', value: 'radius' }, value: { btType: 'BTFSValueNumber-772', value: 0.0025 } },
          { key: { btType: 'BTFSValueString-1422', value: 'ok' }, value: { btType: 'BTFSValueBoolean-1195', value: true } },
        ],
      },
    ],
  };
  assert.deepEqual(decodeFs(raw), [{ radius: 0.0025, ok: true }]);
});

test('mate dry run: hole connector, shifted bolt connector, flipped fastened mate; sends nothing', async () => {
  const { createFastenedMates } = await import('../src/mates.js');
  const ctx = { documentId: 'd', wvmType: 'w', wvmId: 'w', elementId: 'e' };
  // Shaft z -4.32..4.78 pointing +Z; hole z 3.18..0 pointing -Z (numbers from the real test assembly).
  const bolt = { occ: { name: 'bolt', path: ['B1'] }, face: { id: 'JaG' }, world: cyl(0, 0, -4.32, 4.78, 2.413) };
  const hole = { occ: { name: 'plate', path: ['P1'] }, face: { id: 'JHC' }, world: { ...cyl(0, 0, 3.18, 0, 2.54), axis: [0, 0, -1] } };
  const { results: reqs } = await createFastenedMates(ctx, [{ bolt, hole }], { dryRun: true });
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0].feature.parameters[1].queries[0].deterministicIds[0], 'JHC');
  const boltMc = reqs[1].feature.parameters;
  assert.deepEqual(boltMc[1].queries[0].path, ['B1']);
  assert.equal(boltMc.find((p) => p.parameterId === 'translationZ').expression, '1.360000 mm'); // hole centre 1.59 - shaft centre 0.23
  const mate = reqs[2].feature.parameters;
  assert.equal(mate[0].value, 'FASTENED');
  assert.deepEqual(mate[1].queries.map((q) => q.featureId), ['DRYRUN_1', 'DRYRUN_2']);
  assert.equal(mate.find((p) => p.parameterId === 'primaryAxisAlignment').value, true);
  await assert.rejects(createFastenedMates({ ...ctx, wvmType: 'v' }, [{ bolt, hole }]));
});
