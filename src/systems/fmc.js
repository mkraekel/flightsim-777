// Flight Management Computer (Team D1). Pure logic, no DOM.
//
// Responsibilities
//  - route management: default route builder, active-leg sequencing with turn anticipation,
//    cross-track / desired track / distance-to-go, ETA, along-route distances
//  - a pending modification buffer (fmc.mod) that the CDU edits and EXEC commits
//  - VNAV: flight phase, top of climb / top of descent (3:1 rule), descent path altitude,
//    VNAV target speeds (250 kt below 10 000 ft, 310/M.84 climb, M.84 cruise, M.84/290/250 descent)
//  - performance: stall / V-speeds / VREF / flap manoeuvre speeds from gross weight & flaps
//
// Units: route lat/lon in radians; speeds in the fields named ...Kt are knots CAS.

import {
  DEG, RAD, KT, FT, NM, G0, clamp, wrap2pi, wrapPi, wrap360,
  distance, bearing, destination, crossTrack,
} from '../core/geo.js';

// ---------------------------------------------------------------------------
// Performance data (from physics research, 777-300ER, see research/physics.md §3.1, §5)
// ---------------------------------------------------------------------------
const WING_AREA = 436.8;          // m²
const RHO0 = 1.225;
/** CLmax (1-g stall, low Mach) per flap detent. */
const CLMAX = { 0: 1.45, 1: 1.75, 5: 1.92, 15: 2.05, 20: 2.15, 25: 2.28, 30: 2.35 };
/** Flap placard speeds (kt) -300ER; 0 = VMO. */
export const FLAP_PLACARD = { 0: 330, 1: 265, 5: 245, 15: 230, 20: 225, 25: 200, 30: 180 };
/** Flap manoeuvre speed offsets from VREF30 (FMC style). */
const FLAP_MANEUVER_ADD = { 0: 80, 1: 60, 5: 40, 15: 20, 20: 20, 25: 10, 30: 5 };
export const VMO_KT = 330, MMO = 0.87;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nearestDetent = (f) => [0, 1, 5, 15, 20, 25, 30].reduce((b, d) => (Math.abs(d - f) < Math.abs(b - f) ? d : b), 0);

/** 1-g stall speed (kt, ~CAS at low altitude) for a mass (kg) and flap setting (deg). */
export function stallSpeedKt(massKg, flapsDeg) {
  const m = clamp(num(massKg, 300000), 150000, 360000);
  const cl = CLMAX[nearestDetent(num(flapsDeg))];
  return Math.sqrt((2 * m * G0) / (RHO0 * WING_AREA * cl)) / KT;
}
/** VREF for the landing flap setting (1.23·Vs1g). */
export const vrefKt = (massKg, flaps = 30) => 1.23 * stallSpeedKt(massKg, flaps);
/** Takeoff speeds: V2 = 1.15·Vs, VR = V2-7, V1 = VR-5 (matches research table within ~1 kt). */
export function computeVSpeeds(massKg, toFlaps = 15) {
  const v2 = 1.15 * stallSpeedKt(massKg, toFlaps);
  const vr = v2 - 7, v1 = vr - 5;
  return { v1: Math.round(v1), vr: Math.round(vr), v2: Math.round(v2) };
}
/** Flap manoeuvre speed (green flap labels on the PFD / VNAV target with flaps out). */
export const flapManeuverKt = (massKg, flaps) => vrefKt(massKg, 30) + FLAP_MANEUVER_ADD[nearestDetent(flaps)];
/** Minimum manoeuvre speed (top of amber band) ≈ 1.3·Vs for the current flaps. */
export const minManeuverKt = (massKg, flaps) => 1.3 * stallSpeedKt(massKg, flaps);
/** Maximum speed for the configuration (flap placard / VMO). */
export const maxSpeedKt = (flaps) => FLAP_PLACARD[nearestDetent(num(flaps))];

// ---------------------------------------------------------------------------
// Minimal standard atmosphere for CAS <-> Mach conversions (FMC display only)
// ---------------------------------------------------------------------------
function isaP(hM) {
  if (hM <= 11000) return 101325 * Math.pow(1 - 2.25577e-5 * hM, 5.25588);
  return 22632.06 * Math.exp(-G0 * (hM - 11000) / (287.053 * 216.65));
}
const A0 = 340.294;
/** CAS (kt) -> Mach at pressure altitude (ft). */
export function casToMach(casKt, altFt) {
  const p = isaP(num(altFt) * FT), vc = num(casKt) * KT;
  const qc = 101325 * (Math.pow(1 + 0.2 * (vc / A0) ** 2, 3.5) - 1);
  return Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
}
/** Mach -> CAS (kt) at pressure altitude (ft). */
export function machToCas(mach, altFt) {
  const p = isaP(num(altFt) * FT);
  const qc = p * (Math.pow(1 + 0.2 * num(mach) ** 2, 3.5) - 1);
  return (A0 * Math.sqrt(5 * (Math.pow(qc / 101325 + 1, 2 / 7) - 1))) / KT;
}

// ---------------------------------------------------------------------------
// Airports / runways (contract format; tolerant of the raw research format too)
// ---------------------------------------------------------------------------
/** Normalised runway geometry in radians/metres: {id, lat, lon, hdg, lengthM, elevFt, endLat, endLon, ils}. */
export function runwayInfo(apt, rwy) {
  if (!rwy) return null;
  const lat = num(rwy.lat) * DEG, lon = num(rwy.lon) * DEG;
  const hdgDeg = num(rwy.hdgDeg, num(rwy.hdgT, 0));
  const lengthM = num(rwy.lengthM, num(rwy.lenFt, 10000) * FT);
  const elevFt = num(rwy.elevFt, num(apt && apt.elevFt, 0));
  let endLat, endLon;
  if (Number.isFinite(rwy.endLat) && Number.isFinite(rwy.endLon)) { endLat = rwy.endLat * DEG; endLon = rwy.endLon * DEG; }
  else { const e = destination(lat, lon, hdgDeg * DEG, lengthM); endLat = e.lat; endLon = e.lon; }
  const startLat = Number.isFinite(rwy.startLat) ? rwy.startLat * DEG : lat;
  const startLon = Number.isFinite(rwy.startLon) ? rwy.startLon * DEG : lon;
  const ils = rwy.ils || {};
  const magVar = num(apt && apt.magVarDeg, 0);
  return {
    id: String(rwy.id || ''), lat, lon, hdg: hdgDeg * DEG, hdgDeg, lengthM, elevFt, endLat, endLon, startLat, startLon,
    ils: {
      freq: num(ils.freq, synthIlsFreq((apt && apt.icao) || '', rwy.id)),
      ident: ils.ident || ('I' + String((apt && apt.icao) || 'XXXX').slice(1, 3) + String(rwy.id || '').slice(0, 1)).slice(0, 4),
      gsDeg: num(ils.gsDeg, 3),
      crsDeg: num(ils.crsDeg, Math.round(wrap360(hdgDeg - magVar)) || 360),
    },
  };
}
function synthIlsFreq(icao, id) {
  let h = 7; for (const c of String(icao) + String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 108.1 + (h % 20) * 0.2; // odd tenths in the ILS band
}
const findRwy = (apt, id) => (apt && apt.runways ? apt.runways.find((r) => r.id === id) : null) || null;

/** Pick a runway: the one most into the wind; with calm wind the one closest to `prefHdg` (rad). */
export function pickRunway(apt, windDirDeg, windKt, prefHdg = null) {
  if (!apt || !apt.runways || !apt.runways.length) return null;
  let best = apt.runways[0], bs = -Infinity;
  for (const r of apt.runways) {
    const h = num(r.hdgDeg, num(r.hdgT, 0)) * DEG;
    let s = 0;
    if (num(windKt) > 3) s += num(windKt) * Math.cos(h - num(windDirDeg) * DEG) * 10;
    if (prefHdg !== null) s += Math.cos(h - prefHdg) * 5;
    s += num(r.lengthM, 0) / 10000; // tie-break: longer
    if (s > bs) { bs = s; best = r; }
  }
  return best;
}

// Deterministic pronounceable 5-letter waypoint names from coordinates.
function fixName(lat, lon, salt = 0) {
  const C = 'BDFGKLMNPRSTVZ', V = 'AEIOU';
  let h = (Math.floor(lat * RAD * 600) * 73856093) ^ (Math.floor(lon * RAD * 600) * 19349663) ^ (salt * 83492791);
  h >>>= 0;
  let s = '';
  for (let i = 0; i < 5; i++) {
    const set = i % 2 === 0 ? C : V;
    s += set[h % set.length]; h = Math.floor(h / set.length) + (i + 1) * 7919;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Init / route building
// ---------------------------------------------------------------------------
export function initFMC(sim) {
  const f = sim.fmc;
  Object.assign(f, {
    depRwy: f.depRwy || null, arrRwy: f.arrRwy || null,
    legFrom: null,                 // {lat, lon} start of the active leg (radians)
    mod: null,                     // pending modification {route, activeLeg, legFrom, origin, dest, depRwy, arrRwy}
    routeVersion: 0,
    phase: 'PREFLIGHT',            // PREFLIGHT TAKEOFF CLIMB CRUISE DESCENT APPROACH DONE
    grossWtKg: null,               // pilot-entered GW (null -> use sim.ac.mass)
    reserveKg: 5000, flightNo: '', toThrust: 'TO', accelHtFt: 1000,
    vOverride: false, vrefOverride: false,
    calc: { v1: 0, vr: 0, v2: 0, vref25: 0, vref30: 0 },
    vnavTargetMach: null, pathAltFt: null, pathVsFpm: 0, tocNm: null,
    alongToDestNm: null, todDistFromDestNm: null, etaActiveH: null, etaDestH: null,
    fuelAtDestKg: null, legDistNm: [], ilsManual: null, msg: '', wasAirborne: false,
    airports: f.airports || null, // optional airport DB injected by the shell/CDU (array of contract airports)
  });
  if (sim.events && !f._spawnHooked) {
    f._spawnHooked = true;
    sim.events.on('spawned', ({ airport, runway } = {}) => onSpawned(sim, airport, runway));
  }
}

function onSpawned(sim, airport, runway) {
  const f = sim.fmc;
  if (airport) { f.origin = airport; f.depRwy = runway || pickRunway(airport, sim.env.windDirDeg, sim.env.windKt); }
  f.phase = 'PREFLIGHT'; f.wasAirborne = false; f.mod = null;
  if (f.origin && f.dest) buildDefaultRoute(sim, f.origin, f.dest);
  else if (f.origin && f.depRwy) {
    // No destination yet: route is just the departure runway and the runway-heading fix.
    const rw = runwayInfo(f.origin, f.depRwy);
    const end = destination(rw.endLat, rw.endLon, rw.hdg, 10 * NM);
    f.route = [
      { ident: 'RW' + rw.id, lat: rw.lat, lon: rw.lon, altFt: null, spdKt: null, kind: 'RWY' },
      { ident: 'DP' + rw.id, lat: end.lat, lon: end.lon, altFt: null, spdKt: null, kind: 'DEP' },
    ];
    activateRoute(sim, 1, { lat: rw.lat, lon: rw.lon });
  }
  updatePerf(sim);
  // Preflight MCP set-up (FCOM procedure): V2 in the speed window, runway heading.
  const ap = sim.ap;
  if (ap && ap.sel && f.depRwy) {
    const rw = runwayInfo(f.origin, f.depRwy);
    ap.sel.useMach = false;
    if (f.v2 > 0) ap.sel.spdKt = f.v2;
    ap.sel.hdgDeg = Math.round(wrap360(rw.hdgDeg - num(sim.ac.magVar) * RAD)) || 360;
  }
}

/** Resolve an airport given an object or ICAO string (needs fmc.airports for strings). */
export function resolveAirport(sim, a) {
  if (!a) return null;
  if (typeof a === 'object') return a;
  const k = String(a).trim().toUpperCase();
  return (sim.fmc.airports || []).find((x) => x.icao === k) || null;
}

/**
 * Build the default route origin -> dest:
 *   RWxx (departure threshold) -> DPxx (runway end + 10 nm on runway heading)
 *   -> great-circle fixes every ~100 nm -> CIxx (20 nm final) -> FFxx (FAF, 10 nm, field+3000 ft) -> RWxx.
 * If `opts.intoMod` the result is written to the pending modification instead of the active route.
 */
export function buildDefaultRoute(sim, origin, dest, opts = {}) {
  const f = sim.fmc;
  origin = resolveAirport(sim, origin); dest = resolveAirport(sim, dest);
  if (!origin || !dest) return null;
  let depRwy = opts.depRwy || (f.depRwy && findRwy(origin, f.depRwy.id) === f.depRwy ? f.depRwy : null);
  const gcBrg = bearing(origin.lat * DEG, origin.lon * DEG, dest.lat * DEG, dest.lon * DEG);
  if (!depRwy) depRwy = pickRunway(origin, sim.env.windDirDeg, sim.env.windKt, gcBrg);
  let arrRwy = opts.arrRwy || (f.arrRwy && findRwy(dest, f.arrRwy.id) === f.arrRwy ? f.arrRwy : null);
  if (!arrRwy) arrRwy = pickRunway(dest, sim.env.windDirDeg, sim.env.windKt, gcBrg);
  const d = runwayInfo(origin, depRwy), a = runwayInfo(dest, arrRwy);
  const route = [];
  route.push({ ident: 'RW' + d.id, lat: d.lat, lon: d.lon, altFt: null, spdKt: null, kind: 'RWY' });
  const dp = destination(d.endLat, d.endLon, d.hdg, 10 * NM);
  route.push({ ident: 'DP' + d.id, lat: dp.lat, lon: dp.lon, altFt: null, spdKt: null, kind: 'DEP' });
  const back = wrap2pi(a.hdg + Math.PI);
  const ci = destination(a.lat, a.lon, back, 20 * NM);
  const ff = destination(a.lat, a.lon, back, 10 * NM);
  // enroute great-circle points
  const total = distance(dp.lat, dp.lon, ci.lat, ci.lon);
  const n = Math.max(0, Math.ceil(total / (100 * NM)) - 1);
  if (total > 40 * NM) {
    const brg0 = bearing(dp.lat, dp.lon, ci.lat, ci.lon);
    for (let i = 1; i <= n; i++) {
      // walk the great circle by re-aiming at the target each step (keeps on the GC)
      const prev = route[route.length - 1];
      const remain = distance(prev.lat, prev.lon, ci.lat, ci.lon);
      const step = remain / (n - i + 2);
      const p = destination(prev.lat, prev.lon, i === 1 ? brg0 : bearing(prev.lat, prev.lon, ci.lat, ci.lon), step);
      route.push({ ident: fixName(p.lat, p.lon, i), lat: p.lat, lon: p.lon, altFt: null, spdKt: null, kind: 'WPT' });
    }
  }
  const fafAlt = Math.round((a.elevFt + 3000) / 100) * 100;
  // Arriving from the far side of the field: add a downwind / base transition so LNAV does not
  // have to make a U-turn onto final (abeam the threshold and abeam CI, offset 8 nm).
  const prev = route[route.length - 1];
  const inbound = bearing(prev.lat, prev.lon, ci.lat, ci.lon);
  if (Math.abs(wrapPi(a.hdg - inbound)) > 100 * DEG) {
    // which side of the extended centreline (threshold -> CI) the route arrives from
    const side = crossTrack(a.lat, a.lon, ci.lat, ci.lon, prev.lat, prev.lon) >= 0 ? 1 : -1;
    const offBrg = wrap2pi(back + side * Math.PI / 2);
    const dw = destination(a.lat, a.lon, offBrg, 8 * NM);
    const bs = destination(ci.lat, ci.lon, offBrg, 8 * NM);
    route.push({ ident: fixName(dw.lat, dw.lon, 91), lat: dw.lat, lon: dw.lon, altFt: null, spdKt: null, kind: 'WPT' });
    route.push({ ident: fixName(bs.lat, bs.lon, 92), lat: bs.lat, lon: bs.lon, altFt: null, spdKt: null, kind: 'WPT' });
  }
  route.push({ ident: 'CI' + a.id, lat: ci.lat, lon: ci.lon, altFt: Math.round((a.elevFt + 5000) / 100) * 100, spdKt: null, kind: 'CI', altType: 'A' });
  route.push({ ident: 'FF' + a.id, lat: ff.lat, lon: ff.lon, altFt: fafAlt, spdKt: null, kind: 'FAF' });
  route.push({ ident: 'RW' + a.id, lat: a.lat, lon: a.lon, altFt: Math.round(a.elevFt + 50), spdKt: null, kind: 'RWY' });

  const pkg = { route, activeLeg: 1, legFrom: { lat: d.lat, lon: d.lon }, origin, dest, depRwy, arrRwy };
  if (opts.intoMod) { f.mod = pkg; return pkg; }
  applyPackage(sim, pkg);
  return route;
}

function applyPackage(sim, pkg) {
  const f = sim.fmc;
  f.origin = pkg.origin; f.dest = pkg.dest; f.depRwy = pkg.depRwy; f.arrRwy = pkg.arrRwy;
  f.route = pkg.route;
  // On the ground the active leg stays the runway leg; airborne, keep the chosen leg.
  activateRoute(sim, clamp(pkg.activeLeg, 0, Math.max(0, pkg.route.length - 1)), pkg.legFrom);
}

function activateRoute(sim, idx, from) {
  const f = sim.fmc;
  f.activeLeg = idx;
  f.legFrom = from || (idx > 0 && f.route[idx - 1] ? { lat: f.route[idx - 1].lat, lon: f.route[idx - 1].lon } : { lat: sim.ac.lat, lon: sim.ac.lon });
  f.routeVersion++;
  f.legDistNm = f.route.map((w, i) => (i === 0 ? 0 : distance(f.route[i - 1].lat, f.route[i - 1].lon, w.lat, w.lon) / NM));
}

// ---------------------------------------------------------------------------
// Modification buffer (CDU edits -> EXEC)
// ---------------------------------------------------------------------------
const cloneRoute = (r) => r.map((w) => ({ ...w }));
/** Start (or continue) a modification; returns the mod package. */
export function beginMod(sim) {
  const f = sim.fmc;
  if (!f.mod) {
    f.mod = { route: cloneRoute(f.route || []), activeLeg: f.activeLeg, legFrom: f.legFrom ? { ...f.legFrom } : null,
      origin: f.origin, dest: f.dest, depRwy: f.depRwy, arrRwy: f.arrRwy };
  }
  return f.mod;
}
export function execMod(sim) {
  const f = sim.fmc;
  if (!f.mod) return false;
  const pkg = f.mod; f.mod = null;
  applyPackage(sim, pkg);
  updatePerf(sim);
  return true;
}
export function eraseMod(sim) { sim.fmc.mod = null; }

/** Direct-to route index `idx` from present position (in the mod buffer). */
export function directTo(sim, idx) {
  const m = beginMod(sim);
  if (idx < 0 || idx >= m.route.length) return false;
  // drop legs before the target (keep one previous point as history)
  m.activeLeg = idx;
  m.legFrom = { lat: sim.ac.lat, lon: sim.ac.lon };
  return true;
}
/** Delete a waypoint from the mod route. */
export function deleteWaypoint(sim, idx) {
  const m = beginMod(sim);
  if (idx <= 0 || idx >= m.route.length - 1) return false; // keep origin & destination runways
  m.route.splice(idx, 1);
  if (m.activeLeg > idx) m.activeLeg--;
  else if (m.activeLeg === idx) m.legFrom = { lat: sim.ac.lat, lon: sim.ac.lon };
  return true;
}
/** Insert a waypoint {ident, lat, lon} before index `idx` in the mod route. */
export function insertWaypoint(sim, idx, wpt) {
  const m = beginMod(sim);
  idx = clamp(idx, 1, m.route.length);
  m.route.splice(idx, 0, { altFt: null, spdKt: null, kind: 'WPT', ...wpt });
  if (m.activeLeg >= idx && m.activeLeg !== idx) m.activeLeg++;
  if (m.activeLeg === idx) m.legFrom = { lat: sim.ac.lat, lon: sim.ac.lon };
  return true;
}
/** Remove everything between `fromIdx` (exclusive) and `toIdx` (exclusive) – a "link" up. */
export function linkTo(sim, fromIdx, toIdx) {
  const m = beginMod(sim);
  if (toIdx <= fromIdx + 1) return false;
  m.route.splice(fromIdx + 1, toIdx - fromIdx - 1);
  if (m.activeLeg > fromIdx) m.activeLeg = Math.max(fromIdx + 1, m.activeLeg - (toIdx - fromIdx - 1));
  if (m.activeLeg === fromIdx + 1) m.legFrom = { lat: m.route[fromIdx].lat, lon: m.route[fromIdx].lon };
  return true;
}

/** Parse "N5003.0E00834.0" / "N50E008" style coordinates -> {lat, lon} (rad) or null. */
export function parseLatLon(s) {
  const m = /^([NS])(\d{2})(\d{2}(?:\.\d+)?)?([EW])(\d{3})(\d{2}(?:\.\d+)?)?$/.exec(String(s).trim().toUpperCase());
  if (!m) return null;
  const lat = (Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0)) * (m[1] === 'S' ? -1 : 1);
  const lon = (Number(m[5]) + (m[6] ? Number(m[6]) / 60 : 0)) * (m[4] === 'W' ? -1 : 1);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: lat * DEG, lon: lon * DEG };
}
/** Format lat/lon (rad) as N5003.0E00834.0. */
export function fmtLatLon(lat, lon) {
  const f = (v, w, p, n) => {
    const a = Math.abs(v * RAD), d = Math.floor(a), m = (a - d) * 60;
    return (v >= 0 ? p : n) + String(d).padStart(w, '0') + m.toFixed(1).padStart(4, '0');
  };
  return f(lat, 2, 'N', 'S') + f(lon, 3, 'E', 'W');
}

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------
export function stepFMC(sim, dt) {
  const f = sim.fmc;
  if (!f || !(dt >= 0)) return;
  if (f.phase === undefined) initFMC(sim);
  try {
    updatePerf(sim);
    updateLeg(sim);
    updatePhase(sim);
    updateVnav(sim);
  } catch (e) {
    // never throw from the step function
    if (!f._errLogged) { f._errLogged = true; console.error('stepFMC', e); }
  }
}

function grossWeight(sim) {
  return num(sim.fmc.grossWtKg, 0) > 0 ? sim.fmc.grossWtKg : num(sim.ac.mass, 0) > 0 ? sim.ac.mass : 300000;
}

function updatePerf(sim) {
  const f = sim.fmc, gw = grossWeight(sim);
  const v = computeVSpeeds(gw, f.toFlaps || 15);
  f.calc.v1 = v.v1; f.calc.vr = v.vr; f.calc.v2 = v.v2;
  // landing weight estimate: current weight (good enough once airborne)
  f.calc.vref25 = Math.round(vrefKt(gw, 25)); f.calc.vref30 = Math.round(vrefKt(gw, 30));
  if (!f.vOverride) { f.v1 = v.v1; f.vr = v.vr; f.v2 = v.v2; }
  if (!f.vrefOverride) f.vref = f.ldgFlaps === 25 ? f.calc.vref25 : f.calc.vref30;
}

function updateLeg(sim) {
  const f = sim.fmc, ac = sim.ac, route = f.route || [];
  if (route.length < 2 || f.activeLeg <= 0 && !f.legFrom) {
    f.xtkM = 0; f.distToGoNm = 0; f.alongToDestNm = null; return;
  }
  if (f.activeLeg >= route.length) f.activeLeg = route.length - 1;
  if (!f.legFrom) f.legFrom = { lat: route[Math.max(0, f.activeLeg - 1)].lat, lon: route[Math.max(0, f.activeLeg - 1)].lon };
  const to = route[f.activeLeg], from = f.legFrom;
  const lat = num(ac.lat), lon = num(ac.lon);
  const legLen = distance(from.lat, from.lon, to.lat, to.lon);
  const dtg = distance(lat, lon, to.lat, to.lon);
  const xtk = legLen > 50 ? crossTrack(from.lat, from.lon, to.lat, to.lon, lat, lon) : 0;
  const crs = legLen > 50 ? legCourseAt(from, to, lat, lon, legLen) : bearing(lat, lon, to.lat, to.lon);
  // signed along-track distance remaining to the TO waypoint (negative once passed abeam)
  const alongRem = dtg * Math.cos(bearing(lat, lon, to.lat, to.lon) - crs);
  f.xtkM = xtk;
  f.dtkRad = crs;
  f.distToGoNm = dtg / NM;

  // Sequencing with turn anticipation (only airborne; never past the last waypoint).
  if (!ac.onGround && f.activeLeg < route.length - 1) {
    const next = route[f.activeLeg + 1];
    const nextCrs = bearing(to.lat, to.lon, next.lat, next.lon);
    const crsAtTo = wrap2pi(bearing(to.lat, to.lon, from.lat, from.lon) + Math.PI); // inbound course at TO
    const dTurn = Math.abs(wrapPi(nextCrs - crsAtTo));
    const v = Math.max(num(ac.gs, 0), 60);
    const R = (v * v) / (G0 * Math.tan(25 * DEG));
    const anticip = clamp(R * Math.tan(Math.min(dTurn, 120 * DEG) / 2), 0.1 * NM, 8 * NM);
    if (alongRem < anticip) {
      activateRoute(sim, f.activeLeg + 1, { lat: to.lat, lon: to.lon });
      return updateLeg(sim);
    }
  }
  // along-route distance to destination
  let rem = dtg / NM; // FMC convention: direct distance to the active waypoint + remaining legs
  for (let i = f.activeLeg + 1; i < route.length; i++) rem += f.legDistNm[i] || 0;
  f.alongToDestNm = rem;
}

// Course of the great circle from->to at the point abeam the aircraft.
function legCourseAt(from, to, lat, lon, legLen) {
  const brgToP = bearing(from.lat, from.lon, lat, lon);
  const d13 = distance(from.lat, from.lon, lat, lon);
  const crs0 = bearing(from.lat, from.lon, to.lat, to.lon);
  const along = d13 * Math.cos(brgToP - crs0);
  const p = destination(from.lat, from.lon, crs0, clamp(along, 0, legLen - 1));
  return bearing(p.lat, p.lon, to.lat, to.lon);
}

function indAltFt(sim) {
  const e = sim.env;
  const set = e.baroStd ? 1013.25 : num(e.baroHpa, 1013.25);
  return num(sim.ac.altMSL) / FT + (set - num(e.qnhHpa, 1013.25)) * 27;
}

function updatePhase(sim) {
  const f = sim.fmc, ac = sim.ac, alt = indAltFt(sim);
  const gsKt = num(ac.gs) / KT;
  const fieldFt = f.depRwy ? num(f.depRwy.elevFt, num(f.origin && f.origin.elevFt, 0)) : 0;
  if (ac.onGround) {
    if (f.wasAirborne && f.phase !== 'PREFLIGHT') f.phase = 'DONE';
    else f.phase = gsKt > 40 ? 'TAKEOFF' : 'PREFLIGHT';
    return;
  }
  f.wasAirborne = true;
  const crz = num(f.crzAltFt, 35000);
  const tod = f.todNm;
  const ciIdx = (f.route || []).findIndex((w) => w.kind === 'CI');
  if (f.phase === 'PREFLIGHT' || f.phase === 'TAKEOFF') {
    if (alt - fieldFt > num(f.accelHtFt, 1000)) f.phase = 'CLIMB';
    else { f.phase = 'TAKEOFF'; return; }
  }
  if (f.phase === 'CLIMB' && alt > crz - 150) f.phase = 'CRUISE';
  if ((f.phase === 'CLIMB' || f.phase === 'CRUISE') && tod !== null && tod <= 0 && sim.ap.sel.altFt < alt - 300) f.phase = 'DESCENT';
  if (f.phase === 'DESCENT' && ((ciIdx > 0 && f.activeLeg > ciIdx) || num(sim.surfaces.flapsDeg) > 0)) f.phase = 'APPROACH';
}

function updateVnav(sim) {
  const f = sim.fmc, ac = sim.ac, alt = indAltFt(sim);
  const route = f.route || [];
  const crz = num(f.crzAltFt, 35000);
  const gw = grossWeight(sim);
  const flaps = num(sim.surfaces.flapsDeg);
  const gsKt = Math.max(num(ac.gs) / KT, 0);
  // ---- path geometry (3:1 from the FAF constraint back to cruise altitude) ----
  const fafIdx = route.findIndex((w) => w.kind === 'FAF');
  if (f.alongToDestNm !== null && route.length > 2 && f.dest) {
    const destElev = num(route[route.length - 1].altFt, num(f.dest.elevFt, 0) + 50);
    let dFafDest = 0, fafAlt = destElev;
    if (fafIdx > 0) {
      for (let i = fafIdx + 1; i < route.length; i++) dFafDest += f.legDistNm[i] || 0;
      fafAlt = num(route[fafIdx].altFt, destElev + 3000);
    }
    // 3:1 rule from the FAF constraint, plus ~5 nm to decelerate to 250 kt at 10 000 ft
    const todFromDest = dFafDest + Math.max(0, crz - fafAlt) / 1000 * 3 + (crz > 12000 ? 5 : 0);
    f.todDistFromDestNm = todFromDest;
    f.todNm = f.alongToDestNm - todFromDest;
    const rem = f.alongToDestNm;
    let pAlt;
    if (rem <= dFafDest) pAlt = destElev + (fafAlt - destElev) * (dFafDest > 0 ? rem / dFafDest : 0);
    else pAlt = Math.min(crz, descentPathAlt(rem - dFafDest, fafAlt, crz));
    f.pathAltFt = pAlt;
    // path vertical speed (ft/min): 1000 ft per 3 nm on the descent, GS path inside the FAF
    const grad = rem <= dFafDest && dFafDest > 0 ? (fafAlt - destElev) / dFafDest : 1000 / 3;
    f.pathVsFpm = rem > todFromDest ? 0 : -(gsKt / 60) * grad;
    // top of climb estimate: ~3.3 nm per 1000 ft
    f.tocNm = f.phase === 'CLIMB' || f.phase === 'TAKEOFF' || f.phase === 'PREFLIGHT' ? Math.max(0, (crz - alt) / 1000 * 3.3) : null;
    const tToGo = gsKt > 60 ? rem / gsKt : rem / 480;
    f.etaDestH = wrap24(num(sim.env.timeOfDayH, 12) + tToGo);
    f.etaActiveH = wrap24(num(sim.env.timeOfDayH, 12) + (gsKt > 60 ? f.distToGoNm / gsKt : f.distToGoNm / 480));
    const ff = sim.engines.reduce((s, e) => s + num(e.ff), 0);
    const fuel = num(ac.fuelKg.L) + num(ac.fuelKg.C) + num(ac.fuelKg.R);
    f.fuelAtDestKg = Math.max(0, fuel - (ff > 0 ? ff : 7000) * tToGo);
  } else {
    f.todNm = null; f.pathAltFt = null; f.pathVsFpm = 0; f.tocNm = null; f.etaDestH = null; f.etaActiveH = null;
  }
  // ---- target altitude ----
  const phase = f.phase;
  if (phase === 'DESCENT' || phase === 'APPROACH') f.vnavTargetAltFt = f.pathAltFt !== null ? Math.round(f.pathAltFt) : null;
  else f.vnavTargetAltFt = crz;
  // ---- target speed ----
  const placard = maxSpeedKt(flaps) - 5;
  const flapMan = flapManeuverKt(gw, flaps);
  let spd = 250, mach = null;
  if (phase === 'PREFLIGHT' || phase === 'TAKEOFF') spd = num(f.v2, 160) + 15;
  else if (phase === 'CLIMB') {
    if (alt < 10000 - 300) spd = Math.max(250, flaps > 0 ? Math.min(flapMan, placard) : Math.min(flapMan, 300));
    else { spd = 310; mach = 0.84; }
    if (flaps > 0) spd = Math.min(Math.max(spd, flapMan), placard);
  } else if (phase === 'CRUISE') { spd = 310; mach = 0.84; }
  else if (phase === 'DESCENT') {
    if (alt < 11000) spd = 240; // decelerate to 250 restriction with margin
    else { spd = 290; mach = 0.84; }
    if (flaps > 0) spd = Math.min(spd, Math.max(flapMan, placard - 10));
  } else if (phase === 'APPROACH') {
    if (flaps >= 25) spd = num(f.vref, 150) + 5;
    else spd = Math.min(Math.max(flapMan, flaps > 0 ? 0 : 210), placard, 240);
  } else spd = 250;
  // When the Mach target governs (above crossover) report the equivalent CAS, so the PFD bug and
  // the AFDS use the same number.
  const m = num(ac.mach), cas = num(ac.cas) / KT;
  if (mach !== null && m > 0.3 && cas > 100) { const k = cas * mach / m; if (k < spd) spd = k; else mach = null; }
  else mach = mach !== null && m > 0.3 ? mach : null;
  f.vnavTargetSpdKt = Math.round(clamp(spd, 100, 340));
  f.vnavTargetMach = mach; // non-null only while the Mach target governs
}

/** Altitude on the 3:1 descent path `d` nm before the FAF, with a 5 nm level decel segment at 10 000 ft. */
function descentPathAlt(d, fafAlt, crz) {
  if (crz <= 12000 || fafAlt >= 10000) return fafAlt + (d / 3) * 1000;
  const d10 = ((10000 - fafAlt) / 1000) * 3;
  if (d <= d10) return fafAlt + (d / 3) * 1000;
  if (d <= d10 + 5) return 10000;
  return 10000 + ((d - d10 - 5) / 3) * 1000;
}

const wrap24 = (h) => ((h % 24) + 24) % 24;

/** Format decimal hours as "1432.5z". */
export function fmtZulu(h) {
  if (h === null || !Number.isFinite(h)) return '----.-z';
  const tot = Math.round(h * 600) / 10; // tenths of minutes
  const hh = Math.floor(tot / 60) % 24, mm = tot - Math.floor(tot / 60) * 60;
  return String(hh).padStart(2, '0') + mm.toFixed(1).padStart(4, '0') + 'z';
}

/** Altitude helper shared with the CDU (indicated altitude incl. baro setting). */
export { indAltFt as fmcIndicatedAltFt };
