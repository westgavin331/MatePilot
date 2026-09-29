// Step 4: small vector helpers + moving part-local geometry into assembly space.
// Occurrence transforms are 16 numbers, a 4x4 matrix in row-major order, in meters.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => scale(a, 1 / norm(a));

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function applyToPoint(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

export function applyToDirection(m, d) {
  return unit([
    m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
    m[4] * d[0] + m[5] * d[1] + m[6] * d[2],
    m[8] * d[0] + m[9] * d[1] + m[10] * d[2],
  ]);
}

/**
 * Converts a face from the FeatureScript into a finite world-space cylinder:
 * { start, end, axis (start->end), radius }. For bolts, `headEnd` is 'start' or 'end'.
 */
export function faceToWorld(face, transform) {
  const at = (z) => applyToPoint(transform, add(face.origin, scale(face.axis, z)));
  const start = at(face.zMin);
  const end = at(face.zMax);
  const headAtEnd = face.bodyZMax - face.zMax > face.zMin - face.bodyZMin;
  return {
    start,
    end,
    axis: applyToDirection(transform, face.axis),
    radius: face.radius,
    headEnd: headAtEnd ? 'end' : 'start',
  };
}
