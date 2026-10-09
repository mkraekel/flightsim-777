// Camera modes for the out-the-window view (Team B).
// Only src/world/* touches Cesium. Frames used here:
//   body  : x forward, y right, z down (aircraft, origin at CG)
//   NED   : north, east, down (local level at the CG)
//   ECEF  : Cesium fixed frame (Cartesian3)
// sim.ac.quat rotates body -> NED.  R_ecef_body = R_ecef_ned * R_ned_body.

import { DEG, clamp, wrapPi, eulerToQuat } from '../core/geo.js';
import { AIRPORTS } from './airports.js';

/** Pilot eye relative to the CG in body axes (m): left seat, ~1.1 m above cockpit floor. */
export const EYE_BODY = [29.2, -0.55, -1.55];
/** CG height above the ground with gear compressed (research/physics.md: ~5.0 m). */
export const CG_HEIGHT_M = 5.0;

const C = () => window.Cesium;

// ---------- small 3x3 helpers (row-major arrays of 9) ----------
export function quatToMat(q) {
  let [w, x, y, z] = q;
  const n = Math.hypot(w, x, y, z);
  if (!(n > 0.5)) { w = 1; x = y = z = 0; } else { w /= n; x /= n; y /= n; z /= n; }
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
export const mulMV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** Attitude quaternion with NaN guard (falls back to the Euler angles). */
export function safeQuat(ac) {
  const q = ac.quat;
  if (q && q.length === 4 && q.every(Number.isFinite)) return q;
  const e = ac.euler || {};
  return eulerToQuat(e.roll || 0, e.pitch || 0, e.heading || 0);
}

/**
 * Aircraft frame in ECEF. Returns { pos: Cartesian3, ned: {n,e,d} (ECEF unit vectors),
 * toEcef(vBody) -> [x,y,z], toEcefDir(vNed) } .
 */
export function computeBodyFrame(sim, out = {}) {
  const Cesium = C();
  const ac = sim.ac;
  const lat = Number.isFinite(ac.lat) ? ac.lat : 0, lon = Number.isFinite(ac.lon) ? ac.lon : 0;
  const h = Number.isFinite(ac.h) ? ac.h : 0;
  out.pos = Cesium.Cartesian3.fromRadians(lon, lat, h, Cesium.Ellipsoid.WGS84, out.pos);
  out.enu = Cesium.Transforms.eastNorthUpToFixedFrame(out.pos, Cesium.Ellipsoid.WGS84, out.enu);
  const m = out.enu;
  const east = [m[0], m[1], m[2]], north = [m[4], m[5], m[6]], up = [m[8], m[9], m[10]];
  out.east = east; out.north = north; out.up = up;
  out.Rnb = quatToMat(safeQuat(ac));
  // NED -> ECEF
  out.nedToEcef = (v) => [
    north[0] * v[0] + east[0] * v[1] - up[0] * v[2],
    north[1] * v[0] + east[1] * v[1] - up[1] * v[2],
    north[2] * v[0] + east[2] * v[1] - up[2] * v[2],
  ];
  out.bodyToEcef = (v) => out.nedToEcef(mulMV(out.Rnb, v));
  return out;
}

const addP = (Cesium, p, v, res) => new Cesium.Cartesian3(p.x + v[0], p.y + v[1], p.z + v[2]);
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Point the Cesium camera from `pos` along `dir` with `upHint` (all ECEF). */
function setCam(camera, pos, dir, upHint) {
  const Cesium = C();
  const d = norm(dir);
  let r = cross(d, upHint);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = cross(d, [0, 0, 1]);
  r = norm(r);
  const u = cross(r, d);
  Cesium.Cartesian3.clone(pos, camera.position);
  camera.direction = new Cesium.Cartesian3(d[0], d[1], d[2]);
  camera.up = new Cesium.Cartesian3(u[0], u[1], u[2]);
  camera.right = new Cesium.Cartesian3(r[0], r[1], r[2]);
}

/**
 * Camera controller. One instance per viewer; call update() every frame after the
 * aircraft frame was computed.
 */
export function createCameraController(viewer) {
  const Cesium = C();
  const camera = viewer.camera;
  const st = {
    mode: null, chaseHdg: null, flyPoint: null, flyAnchor: null, towerPos: null, towerApt: null,
    smoothPos: null,
  };
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  function setFov(deg) {
    const f = camera.frustum;
    const r = clamp(deg, 1, 120) * DEG;
    if (Math.abs((f.fov || 0) - r) > 1e-4) f.fov = r;
  }

  /** Vertical FOV for the current aspect (Cesium's fov is horizontal when wider than tall). */
  function fovy() {
    const f = camera.frustum;
    const ar = f.aspectRatio || 16 / 9;
    return ar > 1 ? 2 * Math.atan(Math.tan(f.fov / 2) / ar) : f.fov;
  }

  function cockpit(sim, fr) {
    const v = sim.view;
    setFov(72 / clamp(v.zoom || 1, 0.5, 4));
    // With the panel shown the lower ~45 % of the screen is covered, so look a little down
    // (like a pilot's design eye point view) to keep the horizon in the visible upper part.
    const seat = v.panel ? -Math.atan(0.32 * Math.tan(fovy() / 2)) : -2 * DEG;
    const yaw = v.lookYaw || 0, pit = clamp((v.lookPitch || 0) + seat, -80 * DEG, 80 * DEG);
    const cp = Math.cos(pit), sp = Math.sin(pit), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fB = [cp * cy, cp * sy, -sp];
    const uB = [-sp * cy, -sp * sy, -cp];
    const eye = fr.bodyToEcef(EYE_BODY);
    setCam(camera, addP(Cesium, fr.pos, eye), fr.bodyToEcef(fB), fr.bodyToEcef(uB));
  }

  function chase(sim, fr, dt) {
    const v = sim.view, ac = sim.ac;
    setFov(60 / clamp(v.zoom || 1, 0.5, 4));
    const hdg = Number.isFinite(ac.euler?.heading) ? ac.euler.heading : 0;
    if (st.chaseHdg === null) st.chaseHdg = hdg;
    // Smooth heading following (wrap-safe), faster when the gap is large.
    st.chaseHdg = wrapPi(st.chaseHdg + wrapPi(hdg - st.chaseHdg) * (1 - Math.exp(-dt / 0.8)));
    const dist = 80 / clamp(v.zoom || 1, 0.3, 4);
    const az = st.chaseHdg + Math.PI + (v.lookYaw || 0);
    const el = clamp(9 * DEG + (v.lookPitch || 0), -5 * DEG, 85 * DEG);
    const nedOff = [Math.cos(az) * Math.cos(el) * dist, Math.sin(az) * Math.cos(el) * dist, -Math.sin(el) * dist - 4];
    let off = fr.nedToEcef(nedOff);
    let pos = addP(Cesium, fr.pos, off);
    // keep above ground
    const carto = Cesium.Cartographic.fromCartesian(pos);
    const gh = sim.env.groundValid ? sim.env.groundH : -1e9;
    if (carto && carto.height < gh + 2) {
      carto.height = gh + 2;
      pos = Cesium.Cartographic.toCartesian(carto);
    }
    const target = addP(Cesium, fr.pos, fr.nedToEcef([0, 0, -3]));
    const dir = [target.x - pos.x, target.y - pos.y, target.z - pos.z];
    setCam(camera, pos, dir, fr.up);
  }

  function flyby(sim, fr) {
    const ac = sim.ac;
    setFov(50 / clamp(sim.view.zoom || 1, 0.5, 4));
    const trk = ac.gs > 5 && Number.isFinite(ac.track) ? ac.track : (ac.euler?.heading || 0);
    const needNew = () => {
      if (!st.flyPoint) return true;
      const rel = [fr.pos.x - st.flyPoint.x, fr.pos.y - st.flyPoint.y, fr.pos.z - st.flyPoint.z];
      const dist = Math.hypot(rel[0], rel[1], rel[2]);
      const fwd = fr.nedToEcef([Math.cos(trk), Math.sin(trk), 0]);
      const past = rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2];
      return dist > 4000 || (past > 0 && dist > st.flyAnchor * 1.1);
    };
    if (needNew()) {
      const ahead = clamp((ac.gs || 0) * 7, 120, 1800);
      const side = 35 + ahead * 0.05;
      const below = ac.onGround ? 0 : 8;
      const ned = [Math.cos(trk) * ahead - Math.sin(trk) * side, Math.sin(trk) * ahead + Math.cos(trk) * side, below];
      let p = addP(Cesium, fr.pos, fr.nedToEcef(ned));
      const c = Cesium.Cartographic.fromCartesian(p);
      if (c) {
        const gh = viewer.scene.globe.getHeight(c);
        const ref = Number.isFinite(gh) ? gh : (sim.env.groundValid ? sim.env.groundH : c.height);
        if (ac.onGround || c.height < ref + 3) c.height = ref + 3;
        p = Cesium.Cartographic.toCartesian(c);
      }
      st.flyPoint = p; st.flyAnchor = Math.hypot(ahead, side);
    }
    const dir = [fr.pos.x - st.flyPoint.x, fr.pos.y - st.flyPoint.y, fr.pos.z - st.flyPoint.z];
    setCam(camera, st.flyPoint, dir, fr.up);
  }

  function tower(sim, fr) {
    const ac = sim.ac;
    const latD = ac.lat / DEG, lonD = ac.lon / DEG;
    let apt = null, bd = Infinity;
    for (const a of AIRPORTS) {
      const d = (a.lat - latD) ** 2 + ((a.lon - lonD) * Math.cos(ac.lat)) ** 2;
      if (d < bd) { bd = d; apt = a; }
    }
    if (apt && apt !== st.towerApt) { st.towerApt = apt; st.towerPos = null; }
    if (apt && !st.towerPos) {
      const c = Cesium.Cartographic.fromDegrees(apt.tower.lon, apt.tower.lat);
      const gh = viewer.scene.globe.getHeight(c);
      const base = Number.isFinite(gh) ? gh : apt.elevFt * 0.3048 + (sim.env.geoidN || 0);
      st.towerPos = Cesium.Cartesian3.fromDegrees(apt.tower.lon, apt.tower.lat, base + apt.tower.hAglM);
      st.towerFromGlobe = Number.isFinite(gh);
    }
    const tp = st.towerPos;
    const dir = [fr.pos.x - tp.x, fr.pos.y - tp.y, fr.pos.z - tp.z];
    const dist = Math.hypot(dir[0], dir[1], dir[2]);
    // keep the aircraft about the same size on screen
    setFov(clamp(2 * Math.atan(110 / Math.max(dist, 1)) / DEG, 1.5, 70) / clamp(sim.view.zoom || 1, 0.5, 4));
    const upE = Cesium.Cartesian3.normalize(tp, new Cesium.Cartesian3());
    setCam(camera, tp, dir, [upE.x, upE.y, upE.z]);
    if (!st.towerFromGlobe) st.towerPos = null; // retry until terrain under the tower is loaded
  }

  return {
    get state() { return st; },
    update(sim, fr, dt) {
      const mode = sim.view?.mode || 'cockpit';
      if (mode !== st.mode) { st.mode = mode; st.chaseHdg = null; st.flyPoint = null; st.towerPos = null; }
      if (mode === 'chase') chase(sim, fr, dt);
      else if (mode === 'flyby') flyby(sim, fr);
      else if (mode === 'tower') tower(sim, fr);
      else cockpit(sim, fr);
    },
  };
}
