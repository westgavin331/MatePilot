// Step 5: pair bolt shafts with the holes they pass through. Pure math, all in meters.
import { sub, dot, norm, scale } from './transform.js';

export const TOL = {
  parallelCos: Math.cos((0.5 * Math.PI) / 180), // axes within 0.5 degrees
  axisDistance: 0.0001, // axis lines within 0.1 mm of each other
  maxClearance: 0.001, // hole radius at most 1 mm bigger than the shaft
  minOverlap: 0.00001, // hole and shaft must share at least 0.01 mm of length
};

/** Distance from point p to the infinite line through a with unit direction u. */
function distanceToLine(p, a, u) {
  const v = sub(p, a);
  return norm(sub(v, scale(u, dot(v, u))));
}

/**
 * Checks one bolt shaft against one hole (both world cylinders from faceToWorld).
 * Returns { ok, reason, ...measurements }. `collinear` says whether it was a near miss.
 */
export function checkPair(shaft, hole, tol = TOL) {
  const u = shaft.axis;
  const cos = Math.abs(dot(u, hole.axis));
  const mid = scale([hole.start[0] + hole.end[0], hole.start[1] + hole.end[1], hole.start[2] + hole.end[2]], 0.5);
  const distance = distanceToLine(mid, shaft.start, u);
  const clearance = hole.radius - shaft.radius;

  // Hole and shaft extents as positions along the bolt axis.
  const shaftLen = dot(sub(shaft.end, shaft.start), u);
  const h0 = dot(sub(hole.start, shaft.start), u);
  const h1 = dot(sub(hole.end, shaft.start), u);
  const overlap = Math.min(Math.max(h0, h1), shaftLen) - Math.max(Math.min(h0, h1), 0);

  const m = { distance, clearance, overlap, holeT: (h0 + h1) / 2 };
  if (cos < tol.parallelCos) return { ok: false, collinear: false, reason: 'axes not parallel', ...m };
  if (distance > tol.axisDistance) return { ok: false, collinear: false, reason: 'axes offset', ...m };
  if (clearance < 0) return { ok: false, collinear: true, reason: `hole is ${mm(-clearance)} smaller than the shaft (tapped hole?)`, ...m };
  if (clearance > tol.maxClearance) return { ok: false, collinear: true, reason: `hole is ${mm(clearance)} bigger than the shaft`, ...m };
  if (overlap < tol.minOverlap) return { ok: false, collinear: true, reason: 'on the same axis but not along the shaft', ...m };
  return { ok: true, collinear: true, reason: '', ...m };
}

export const mm = (m) => `${(m * 1000).toFixed(2)} mm`;

/**
 * bolts: [{ occ, face, world }], holes: [{ occ, face, world }]
 * Returns { matches: [{ bolt, holes: [{hole, check}], primary }], unmatchedBolts, nearMisses }.
 * `primary` is the hole closest to the bolt head, the one we mate to.
 */
export function matchBoltsToHoles(bolts, holes, tol = TOL) {
  const matches = [];
  const unmatchedBolts = [];
  const nearMisses = [];

  for (const bolt of bolts) {
    const found = [];
    for (const hole of holes) {
      const check = checkPair(bolt.world, hole.world, tol);
      if (check.ok) found.push({ hole, check });
      else if (check.collinear) nearMisses.push({ bolt, hole, check });
    }
    if (!found.length) {
      unmatchedBolts.push(bolt);
      continue;
    }
    // Sort from the head end down the shaft.
    const headAtStart = bolt.world.headEnd === 'start';
    found.sort((a, b) => (headAtStart ? a.check.holeT - b.check.holeT : b.check.holeT - a.check.holeT));
    matches.push({ bolt, holes: found, primary: found[0] });
  }
  return { matches, unmatchedBolts, nearMisses };
}
