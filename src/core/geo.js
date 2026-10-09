// Shared math, geodesy and unit helpers. Pure functions, no DOM, no Cesium.
// Conventions: angles in radians unless the name says Deg; SI units internally.
// Frames: NED (north, east, down) local-level; body x fwd, y right, z down.
// Quaternions are [w, x, y, z] and rotate body -> NED.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const KT = 0.514444;        // m/s per knot
export const FT = 0.3048;          // m per foot
export const NM = 1852;            // m per nautical mile
export const FPM = FT / 60;        // m/s per ft/min
export const G0 = 9.80665;
export const LBS = 0.45359237;     // kg per lb

// WGS84
export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const EARTH_R = 6371008.8;  // mean radius for great-circle math

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap2pi = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
export const wrapPi = (a) => { a = wrap2pi(a); return a > Math.PI ? a - 2 * Math.PI : a; };
export const wrap360 = (d) => ((d % 360) + 360) % 360;
/** Move `cur` toward `target` by at most rate*dt. */
export const approach = (cur, target, rate, dt) => {
  const d = target - cur, s = rate * dt;
  return Math.abs(d) <= s ? target : cur + Math.sign(d) * s;
};
/** First-order lag with time constant tau (s). */
export const lag = (cur, target, tau, dt) => (tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau)));

/** Meridional (M) and prime-vertical (N) radii of curvature at latitude. */
export function earthRadii(lat) {
  const s = Math.sin(lat), d = 1 - WGS84_E2 * s * s;
  const N = WGS84_A / Math.sqrt(d);
  const M = (WGS84_A * (1 - WGS84_E2)) / (d * Math.sqrt(d));
  return { M, N };
}

export function geodeticToEcef(lat, lon, h) {
  const { N } = earthRadii(lat);
  const cl = Math.cos(lat), sl = Math.sin(lat);
  return [(N + h) * cl * Math.cos(lon), (N + h) * cl * Math.sin(lon), (N * (1 - WGS84_E2) + h) * sl];
}

/** Great-circle distance (m) between two lat/lon (rad). */
export function distance(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1, dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing (rad, 0..2π) from point 1 to point 2. */
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return wrap2pi(Math.atan2(y, x));
}

/** Destination point given start, true bearing (rad) and distance (m). */
export function destination(lat, lon, brg, dist) {
  const d = dist / EARTH_R;
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
  return { lat: lat2, lon: wrapPi(lon2) };
}

/** Signed cross-track distance (m, + = right of course) of point P from great circle A->B. */
export function crossTrack(latA, lonA, latB, lonB, latP, lonP) {
  const d13 = distance(latA, lonA, latP, lonP) / EARTH_R;
  const t13 = bearing(latA, lonA, latP, lonP), t12 = bearing(latA, lonA, latB, lonB);
  return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * EARTH_R;
}

/** Local flat offset (m north, m east) of point 2 relative to point 1 — fine for < ~200 km. */
export function nedOffset(lat1, lon1, lat2, lon2) {
  const { M, N } = earthRadii(lat1);
  return { n: (lat2 - lat1) * M, e: wrapPi(lon2 - lon1) * N * Math.cos(lat1) };
}

// ---------- vectors ----------
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);

// ---------- quaternions [w,x,y,z], body -> NED ----------
export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function qnorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
export const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
/** Rotate vector v by q (body -> NED when q is the attitude quaternion). */
export function qrot(q, v) {
  const p = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q));
  return [p[1], p[2], p[3]];
}
/** Rotate NED vector into body frame. */
export const qrotInv = (q, v) => qrot(qconj(q), v);
/** Euler (roll φ, pitch θ, heading ψ; aerospace 3-2-1) -> quaternion. */
export function eulerToQuat(roll, pitch, heading) {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(heading / 2), sy = Math.sin(heading / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}
export function quatToEuler(q) {
  const [w, x, y, z] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(clamp(2 * (w * y - z * x), -1, 1));
  const heading = wrap2pi(Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)));
  return { roll, pitch, heading };
}
/** Integrate attitude quaternion with body rates [p,q,r] over dt. */
export function qintegrate(q, w, dt) {
  const [p, qq, r] = w;
  const dq = [
    0.5 * (-q[1] * p - q[2] * qq - q[3] * r),
    0.5 * (q[0] * p + q[2] * r - q[3] * qq),
    0.5 * (q[0] * qq - q[1] * r + q[3] * p),
    0.5 * (q[0] * r + q[1] * qq - q[2] * p),
  ];
  return qnorm([q[0] + dq[0] * dt, q[1] + dq[1] * dt, q[2] + dq[2] * dt, q[3] + dq[3] * dt]);
}
