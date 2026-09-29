// Ties steps 1-5 together: assembly -> bolts -> cylinder faces -> world space -> matches.
import { getAssemblyDefinition, flattenParts, partKey, matedPaths } from './assembly.js';
import { classifyOccurrences } from './bolts.js';
import { getCylinderFaces, isConcave, pickShaft } from './geometry.js';
import { faceToWorld } from './transform.js';
import { matchBoltsToHoles } from './match.js';

export async function scanAssembly(ctx, log = () => {}) {
  const def = await getAssemblyDefinition(ctx);
  const occurrences = flattenParts(def);
  log(`Found ${occurrences.length} part instances. Reading descriptions...`);

  await classifyOccurrences(occurrences);
  // Bolts that already have a mate are left alone, so re-running never duplicates mates.
  const mated = matedPaths(def);
  const alreadyMated = occurrences.filter((o) => o.isBolt && mated.has(o.path.join('/')));
  for (const o of alreadyMated) o.isBolt = false;
  const boltOccs = occurrences.filter((o) => o.isBolt);
  log(`${boltOccs.length} unmated bolts (${alreadyMated.length} already mated). Reading hole geometry...`);

  const { faces, errors } = await getCylinderFaces(occurrences.map((o) => o.ref));

  const bolts = [];
  const holes = [];
  const boltsWithoutShaft = [];
  for (const occ of occurrences) {
    const partFaces = faces.get(partKey(occ.ref)) ?? [];
    if (occ.isBolt) {
      const face = pickShaft(partFaces);
      if (face) bolts.push({ occ, face, world: faceToWorld(face, occ.transform) });
      else boltsWithoutShaft.push(occ);
    } else if (!alreadyMated.includes(occ)) {
      for (const face of partFaces.filter(isConcave)) holes.push({ occ, face, world: faceToWorld(face, occ.transform) });
    }
  }

  const result = matchBoltsToHoles(bolts, holes);
  return { occurrences, alreadyMated, bolts, holes, boltsWithoutShaft, geometryErrors: errors, ...result };
}
