// Step 3 test: show one bolt shaft and one hole, in part-local and assembly-world coordinates.
import { urlFromArgs } from '../src/url.js';
import { getAssemblyDefinition, flattenParts, partKey } from '../src/assembly.js';
import { classifyOccurrences } from '../src/bolts.js';
import { getCylinderFaces, isConcave, pickShaft } from '../src/geometry.js';
import { faceToWorld } from '../src/transform.js';

const f = (v) => (Array.isArray(v) ? `(${v.map((x) => (x * 1000).toFixed(2)).join(', ')}) mm` : `${(v * 1000).toFixed(3)} mm`);
const d = (v) => `(${v.map((x) => x.toFixed(3)).join(', ')})`;

try {
  const ctx = urlFromArgs();
  const occ = await classifyOccurrences(flattenParts(await getAssemblyDefinition(ctx)));
  const { faces, errors } = await getCylinderFaces(occ.map((o) => o.ref));
  for (const e of errors) console.warn('Could not read geometry:', e);

  const bolt = occ.find((o) => o.isBolt && pickShaft(faces.get(partKey(o.ref)) ?? []));
  const plate = occ.find((o) => !o.isBolt && (faces.get(partKey(o.ref)) ?? []).some(isConcave));

  const show = (label, o, face) => {
    const w = faceToWorld(face, o.transform);
    console.log(`\n${label}: ${o.name}  [${o.description || 'no description'}]`);
    console.log(`  face id        ${face.id}`);
    console.log(`  radius         ${f(face.radius)}   (curvature ${face.minCurvature.toFixed(1)}/m, normal points at axis: ${face.normalInward})`);
    console.log(`  LOCAL  axis    from ${f(face.origin.map((x, i) => x + face.axis[i] * face.zMin))} dir ${d(face.axis)}`);
    console.log(`  WORLD  start   ${f(w.start)}`);
    console.log(`  WORLD  end     ${f(w.end)}`);
    console.log(`  WORLD  dir     ${d(w.axis)}   head at: ${w.headEnd}`);
  };

  if (bolt) show('BOLT SHAFT', bolt, pickShaft(faces.get(partKey(bolt.ref))));
  else console.log('No bolt with a cylindrical shaft found.');
  if (plate) {
    const holes = faces.get(partKey(plate.ref)).filter(isConcave);
    console.log(`\n(${plate.name} has ${holes.length} holes; showing the first)`);
    show('HOLE', plate, holes[0]);
  } else console.log('No part with a hole found.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
