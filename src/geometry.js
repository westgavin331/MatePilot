// Steps 2-3: read every cylindrical face of the given parts with one FeatureScript
// call per Part Studio. All numbers come back unitless in meters, in part-local space.
import { get, post, pool } from './onshape.js';
import { groupByStudio, studioKey } from './assembly.js';

// For each cylindrical face we return:
//   id           face id (used for highlighting and for mate queries)
//   origin/axis  the cylinder's axis line; radius
//   zMin/zMax    where the face actually starts/ends along that axis (bounding box (evBox3d)
//                taken in the cylinder's own coordinate system)
//   bodyZMin/Max same, for the whole part (tells us which end a bolt's head is on)
//   minCurvature negative => concave (a hole), per evFaceCurvature
//   normalInward second opinion on concavity: surface normal points at the axis
export const buildScript = (partIds) => `
function(context is Context, queries is map)
{
    var result = [];
    for (var pid in ${JSON.stringify(partIds)})
    {
        var body = qTransient(pid);
        var faces = evaluateQuery(context, qGeometry(qOwnedByBody(body, EntityType.FACE), GeometryType.CYLINDER));
        var rows = [];
        for (var f in faces)
        {
            var cyl = evSurfaceDefinition(context, { "face" : f });
            var cs = cyl.coordSystem;
            var faceBox = evBox3d(context, { "topology" : f, "cSys" : cs, "tight" : true });
            var bodyBox = evBox3d(context, { "topology" : body, "cSys" : cs, "tight" : true });
            var curv = evFaceCurvature(context, { "face" : f, "parameter" : vector(0.5, 0.5) });
            var tp = evFaceTangentPlane(context, { "face" : f, "parameter" : vector(0.5, 0.5) });
            var rel = tp.origin - cs.origin;
            var radial = rel - dot(rel, cs.zAxis) * cs.zAxis;
            rows = append(rows, {
                "id" : transientQueriesToStrings(f),
                "origin" : cs.origin / meter,
                "axis" : cs.zAxis,
                "radius" : cyl.radius / meter,
                "zMin" : faceBox.minCorner[2] / meter,
                "zMax" : faceBox.maxCorner[2] / meter,
                "bodyZMin" : bodyBox.minCorner[2] / meter,
                "bodyZMax" : bodyBox.maxCorner[2] / meter,
                "minCurvature" : curv.minCurvature * meter,
                "normalInward" : dot(tp.normal, radial) < 0 * meter
            });
        }
        result = append(result, { "partId" : pid, "faces" : rows });
    }
    return result;
}`;

/** Converts Onshape's typed FeatureScript result JSON into plain JS values. */
export function decodeFs(v) {
  if (v === null || typeof v !== 'object') return v;
  const t = String(v.btType ?? v.typeName ?? '');
  if (t.includes('Map')) {
    const o = {};
    for (const { key, value } of v.value ?? []) o[decodeFs(key)] = decodeFs(value);
    return o;
  }
  if (t.includes('Array')) return (v.value ?? []).map(decodeFs);
  if (t.includes('Undefined')) return undefined;
  return v.value;
}

// Onshape wants `queries` as an object; an array gets HTTP 400.
export const fsRequestBody = (partIds) => ({ script: buildScript(partIds), queries: {} });

async function evalStudio(ref, partIds) {
  const res = await post(
    `/partstudios/d/${ref.documentId}/${ref.wvmType}/${ref.wvmId}/e/${ref.elementId}/featurescript`,
    fsRequestBody(partIds),
    { configuration: ref.configuration }
  );
  const errors = (res.notices ?? []).filter((n) => n.level === 'ERROR').map((n) => `${n.message} (line ${n.stackTrace?.[0]?.line})`);
  if (!res.result) throw new Error(`FeatureScript failed: ${errors.join('; ') || 'no result'}`);
  return decodeFs(res.result);
}

// ---- Fallback source: the regular "body details" endpoint (general API quota). ----
// For a cylinder, orientation=false means the face points toward the axis (a hole),
// matching evFaceCurvature's sign. Face ids are the same ones FeatureScript returns.

const vec = (v) => [v.x, v.y, v.z];

/** Converts one body's cylindrical faces from body details into FeatureScript-shaped faces. */
export function facesFromBodyDetails(body) {
  const corners = (box) => {
    const [a, b] = [vec(box.minCorner), vec(box.maxCorner)];
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]);
  };
  const along = (pts, origin, axis) => pts.map((p) => (p[0] - origin[0]) * axis[0] + (p[1] - origin[1]) * axis[1] + (p[2] - origin[2]) * axis[2]);
  const bodyCorners = body.faces.filter((f) => f.box).flatMap((f) => corners(f.box));

  return body.faces
    .filter((f) => f.surface?.type === 'CYLINDER' && f.box)
    .map((f) => {
      const origin = vec(f.surface.origin);
      const axis = vec(f.surface.axis);
      // An axis-aligned box projected onto the axis: exact for axis-aligned holes,
      // slightly generous for angled ones.
      const z = along(corners(f.box), origin, axis);
      const bz = along(bodyCorners, origin, axis);
      return {
        id: f.id,
        origin,
        axis,
        radius: f.surface.radius,
        zMin: Math.min(...z),
        zMax: Math.max(...z),
        bodyZMin: Math.min(...bz),
        bodyZMax: Math.max(...bz),
        minCurvature: f.orientation ? 0 : -1 / f.surface.radius,
        normalInward: !f.orientation,
      };
    });
}

async function bodyDetailsStudio(ref, partIds) {
  const res = await get(`/partstudios/d/${ref.documentId}/${ref.wvmType}/${ref.wvmId}/e/${ref.elementId}/bodydetails`, {
    configuration: ref.configuration,
  });
  return (res.bodies ?? []).filter((b) => partIds.includes(b.id)).map((b) => ({ partId: b.id, faces: facesFromBodyDetails(b) }));
}

/**
 * Reads cylinder faces with FeatureScript; if Onshape's FeatureScript limit is hit,
 * finishes with the body-details endpoint instead. Returns { faces, errors, source }.
 */
export async function getCylinderFaces(refs, { evaluate = evalStudio, fallback = bodyDetailsStudio } = {}) {
  try {
    return { ...(await getCylinderFacesWith(refs, evaluate)), source: 'featurescript' };
  } catch (e) {
    if (!e.rateLimited || !fallback) throw e;
    console.warn(e.message + ' Using body details instead.');
    return { ...(await getCylinderFacesWith(refs, fallback)), source: 'bodydetails' };
  }
}

/**
 * Returns { faces: Map(partKey -> [face]), errors: [{ studio, partId, message }] }.
 * Throws if Onshape's rate limit is hit: a partial scan would look like
 * "no holes found", which is misleading.
 */
async function getCylinderFacesWith(refs, evaluate) {
  const faces = new Map();
  const errors = [];
  const groups = [...groupByStudio(refs).values()];
  let rateLimited = null;

  await pool(groups, 3, async ({ ref, partIds }) => {
    if (rateLimited) return;
    const ids = [...partIds];
    const fail = (id, e) => errors.push({ studio: studioKey(ref), partId: id, message: e.message.replace(/\s+/g, ' ').slice(0, 300) });
    let rows;
    try {
      rows = await evaluate(ref, ids);
    } catch (e) {
      if (e.status === 429) return void (rateLimited = e);
      // No access (403) or not found (404) won't change part by part; don't spend calls retrying.
      if (e.status === 403 || e.status === 404 || ids.length === 1) return ids.forEach((id) => fail(id, e));
      // One bad part can fail the whole batch; retry parts one at a time.
      rows = [];
      for (const id of ids) {
        if (rateLimited) return;
        try {
          rows.push(...(await evaluate(ref, [id])));
        } catch (e2) {
          if (e2.status === 429) return void (rateLimited = e2);
          fail(id, e2);
        }
      }
    }
    for (const r of rows) faces.set(`${studioKey(ref)}|${r.partId}`, r.faces ?? []);
  });

  if (rateLimited) {
    const secs = Number(String(rateLimited.body).match(/wait (\d+) s/)?.[1]);
    const when = secs ? ` Onshape says to try again in about ${Math.ceil(secs / 3600)} hour(s).` : '';
    throw Object.assign(new Error(`Onshape's limit on geometry reads has been reached, so the scan stopped.${when}`), { rateLimited: true });
  }
  return { faces, errors };
}

/** A hole is a concave cylinder. */
export const isConcave = (face) => face.minCurvature < -1e-9;

/** A bolt's shaft is its longest convex cylinder (the head is shorter and wider). */
export function pickShaft(faces) {
  let best = null;
  for (const f of faces) {
    if (isConcave(f)) continue;
    if (!best || f.zMax - f.zMin > best.zMax - best.zMin) best = f;
  }
  return best;
}
