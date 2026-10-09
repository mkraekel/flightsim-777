// Navigation radios (Team D1): ILS localizer / glideslope / DME. Pure logic, no DOM.
//
// Tuning: a manual NAV RAD entry (fmc.ilsManual = {freq, crsDeg}) wins; otherwise AUTO tuning
// selects the departure runway ILS while on the ground before takeoff and the arrival runway
// ILS once airborne (or after landing).
//
// Sign conventions (shared with the PFD):
//   nav.ils.locDots  + = aircraft RIGHT of the localizer course (PFD pointer shows LEFT -> fly left)
//   nav.ils.gsDots   + = aircraft ABOVE the glideslope          (PFD pointer shows DOWN -> fly down)
//   1 dot = 1.25° localizer, 0.35° glideslope; values are clamped to ±2.5 dots (pointer pegged).
//   nav.ils.locDevM / gsDevM: same signs, linear metres (used by the AFDS).

import { DEG, RAD, FT, NM, clamp, wrapPi, wrap360, distance, bearing, destination } from '../core/geo.js';
import { runwayInfo } from './fmc.js';

export const LOC_DEG_PER_DOT = 1.25;
export const GS_DEG_PER_DOT = 0.35;
const RANGE_M = 25 * NM;
const CONE = 35 * DEG;
const GPI_M = 1000 * FT;            // glidepath intercept / aim point distance past the threshold

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function findIlsByFreq(sim, freq) {
  const f = sim.fmc;
  for (const apt of [f.dest, f.origin]) {
    if (!apt || !apt.runways) continue;
    for (const r of apt.runways) {
      const ri = runwayInfo(apt, r);
      if (Math.abs(ri.ils.freq - freq) < 0.026) return { apt, rwy: r };
    }
  }
  return null;
}

/** Decide which runway's ILS is tuned. Returns {apt, rwy, crsDeg|null} or null. */
function selectIls(sim) {
  const f = sim.fmc, man = f && f.ilsManual;
  if (man && num(man.freq) > 0) {
    const hit = findIlsByFreq(sim, man.freq);
    return hit ? { ...hit, crsDeg: num(man.crsDeg, null) } : { apt: null, rwy: null, freq: man.freq };
  }
  const departing = sim.ac.onGround && (!f.wasAirborne);
  if (departing && f.origin && f.depRwy) return { apt: f.origin, rwy: f.depRwy };
  if (f.dest && (f.arrRwy || (f.dest.runways && f.dest.runways[0]))) return { apt: f.dest, rwy: f.arrRwy || f.dest.runways[0] };
  if (f.origin && f.depRwy) return { apt: f.origin, rwy: f.depRwy };
  return null;
}

export function stepNav(sim, dt) {
  const ils = sim.nav && sim.nav.ils;
  if (!ils || !(dt >= 0)) return;
  try { computeIls(sim, ils); } catch (e) { ils.valid = false; }
}

function invalidate(ils) {
  ils.valid = false; ils.locCapturable = false; ils.gsCapturable = false; ils.gsValid = false;
  ils.locDots = 0; ils.gsDots = 0; ils.locDevM = 0; ils.gsDevM = 0;
}

function computeIls(sim, ils) {
  const sel = selectIls(sim);
  if (!sel || !sel.rwy) {
    invalidate(ils); ils.ident = ''; ils.freq = sel && sel.freq ? sel.freq : 0; ils.distNm = 0; return;
  }
  const rw = runwayInfo(sel.apt, sel.rwy);
  ils.ident = rw.ils.ident; ils.freq = rw.ils.freq; ils.gsDeg = rw.ils.gsDeg;
  ils.rwyId = rw.id; ils.aptIcao = (sel.apt && sel.apt.icao) || '';
  ils.rwyLat = rw.lat; ils.rwyLon = rw.lon; ils.crsRad = rw.hdg;  // true course of the localizer
  ils.crsDeg = sel.crsDeg !== null && sel.crsDeg !== undefined ? sel.crsDeg : rw.ils.crsDeg; // magnetic, display
  ils.thrH = rw.elevFt * FT;
  ils.rwyLengthM = rw.lengthM;

  const ac = sim.ac, lat = num(ac.lat), lon = num(ac.lon);
  // Localizer antenna at the stop end of the runway.
  const locAnt = { lat: rw.endLat, lon: rw.endLon };
  const dAnt = distance(lat, lon, locAnt.lat, locAnt.lon);
  const brgToAnt = bearing(lat, lon, locAnt.lat, locAnt.lon);
  const locAng = wrapPi(rw.hdg - brgToAnt);           // + = aircraft right of course
  // Front course only, within ±35° and 25 nm.
  const front = Math.abs(locAng) < CONE;
  const dThr = distance(lat, lon, rw.lat, rw.lon);
  ils.distNm = dThr / NM;
  ils.dme = ils.distNm;
  ils.valid = front && dAnt < RANGE_M + rw.lengthM && !sim.ac.crashed;
  // Linear lateral offset from the centreline (+ = aircraft right, consistent with dots).
  ils.locDevM = dAnt * Math.sin(locAng);
  ils.locDots = clamp((locAng * RAD) / LOC_DEG_PER_DOT, -2.5, 2.5);
  ils.locCapturable = ils.valid && Math.abs((locAng * RAD) / LOC_DEG_PER_DOT) < 2.4;

  // Glideslope: antenna abeam the aim point 1000 ft past the threshold.
  const gpi = destination(rw.lat, rw.lon, rw.hdg, GPI_M);
  const dG = distance(lat, lon, gpi.lat, gpi.lon);
  const along = dG * Math.cos(wrapPi(bearing(lat, lon, gpi.lat, gpi.lon) - rw.hdg)); // + = before aim point
  const hAbove = num(ac.altMSL) - ils.thrH;
  const elev = Math.atan2(hAbove, Math.max(along, 1));
  const gs = rw.ils.gsDeg * DEG;
  ils.gsDots = clamp(((elev - gs) * RAD) / GS_DEG_PER_DOT, -2.5, 2.5);
  ils.gsDevM = hAbove - Math.tan(gs) * along;          // + = above the path (fly down)
  ils.gsValid = ils.valid && along > 0 && along < 18 * NM && elev > 0.2 * gs && elev < 2.2 * gs;
  ils.gsCapturable = ils.gsValid && Math.abs(((gs - elev) * RAD) / GS_DEG_PER_DOT) < 2.4;
  ils.alongM = along;
  ils.rwyHdgDeg = wrap360(rw.hdgDeg);
}
