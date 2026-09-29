// Reads an assembly and flattens it into a list of part occurrences
// (every place a part appears, including inside subassemblies).
import { get } from './onshape.js';

export async function getAssemblyDefinition({ documentId, wvmType, wvmId, elementId }) {
  return get(`/assemblies/d/${documentId}/${wvmType}/${wvmId}/e/${elementId}`, {
    includeMateFeatures: true,
    includeNonSolids: false,
    excludeSuppressed: true,
  });
}

const asmKey = (x) => `${x.documentId}|${x.elementId}|${x.documentMicroversion}|${x.fullConfiguration ?? x.configuration ?? ''}`;

/**
 * Returns [{ path, transform, name, ref }] for every part occurrence.
 * `path` is the occurrence path (instance ids from the top down), `transform` the
 * absolute 4x4 row-major matrix, and `ref` identifies the part in its Part Studio.
 */
/** Returns a function that finds the sub-assembly definition an Assembly instance points to. */
function subFinder(def) {
  const subs = new Map();
  for (const s of def.subAssemblies ?? []) subs.set(asmKey(s), s);
  return (inst) =>
    subs.get(asmKey(inst)) ??
    (def.subAssemblies ?? []).find(
      (s) => s.documentId === inst.documentId && s.elementId === inst.elementId && s.documentMicroversion === inst.documentMicroversion
    );
}

export function flattenParts(def) {
  const findSub = subFinder(def);
  const out = [];
  for (const occ of def.rootAssembly.occurrences ?? []) {
    let instances = def.rootAssembly.instances;
    let inst = null;
    const names = [];
    for (const id of occ.path) {
      inst = instances?.find((i) => i.id === id);
      if (!inst) break;
      names.push(inst.name);
      if (inst.type === 'Assembly') instances = findSub(inst)?.instances;
    }
    if (!inst || inst.type !== 'Part' || inst.suppressed) continue;
    out.push({
      path: occ.path,
      transform: occ.transform,
      name: names.join(' / '),
      ref: partRef(inst),
    });
  }
  return out;
}

function partRef(inst) {
  // Parts linked from another document's version are read at that version,
  // everything else at the exact microversion the assembly uses.
  const byVersion = Boolean(inst.documentVersion);
  return {
    documentId: inst.documentId,
    wvmType: byVersion ? 'v' : 'm',
    wvmId: byVersion ? inst.documentVersion : inst.documentMicroversion,
    elementId: inst.elementId,
    partId: inst.partId,
    configuration: inst.configuration ?? '',
    isStandardContent: Boolean(inst.isStandardContent),
  };
}

/** Identifies one Part Studio (at one version + configuration). */
export const studioKey = (r) => `${r.documentId}|${r.wvmType}|${r.wvmId}|${r.elementId}|${r.configuration}`;
/** Identifies one part definition (shared by all its instances). */
export const partKey = (r) => `${studioKey(r)}|${r.partId}`;

/** Groups refs by Part Studio: Map(studioKey -> { ref, partIds:Set }). */
export function groupByStudio(refs) {
  const groups = new Map();
  for (const r of refs) {
    const k = studioKey(r);
    if (!groups.has(k)) groups.set(k, { ref: r, partIds: new Set() });
    groups.get(k).partIds.add(r.partId);
  }
  return groups;
}

/**
 * Set of full occurrence paths ("id/id/...") already used by a mate, either in the top-level
 * assembly or inside any sub-assembly (a sub-assembly's mates use paths relative to it).
 */
export function matedPaths(def) {
  const findSub = subFinder(def);
  const paths = new Set();
  const walk = (instances, features, prefix, depth) => {
    for (const f of features ?? []) {
      if (f.featureType !== 'mate' || f.suppressed) continue;
      for (const e of f.featureData?.matedEntities ?? []) paths.add([...prefix, ...(e.matedOccurrence ?? [])].join('/'));
    }
    if (depth > 20) return;
    for (const i of instances ?? []) {
      if (i.type !== 'Assembly' || i.suppressed) continue;
      const s = findSub(i);
      if (s) walk(s.instances, s.features, [...prefix, i.id], depth + 1);
    }
  };
  walk(def.rootAssembly.instances, def.rootAssembly.features, [], 0);
  return paths;
}
