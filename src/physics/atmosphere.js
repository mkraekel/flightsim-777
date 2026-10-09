// ISA atmosphere, airspeed conversions, wind profile and Dryden-like turbulence.
// Pure functions (plus a small seeded turbulence generator). SI units throughout.
// Anyone may import this module (CONTRACT.md).

import { G0, KT, DEG, clamp } from '../core/geo.js';

export const ISA = {
  T0: 288.15, p0: 101325, rho0: 1.225, a0: 340.294,
  R: 287.053, gamma: 1.4, L: 0.0065, hTrop: 11000, Ttrop: 216.65, pTrop: 22632.06,
};
const R_EARTH_GP = 6356766; // m, radius used for geopotential altitude

/** Standard-day temperature (K) and pressure (Pa) at geometric altitude h (m). */
function isaStd(h) {
  const H = (R_EARTH_GP * h) / (R_EARTH_GP + h); // geopotential altitude
  if (H <= ISA.hTrop) {
    const T = ISA.T0 - ISA.L * H;
    return { T, p: ISA.p0 * Math.pow(T / ISA.T0, G0 / (ISA.L * ISA.R)) };
  }
  if (H <= 20000) {
    return { T: ISA.Ttrop, p: ISA.pTrop * Math.exp((-G0 * (H - ISA.hTrop)) / (ISA.R * ISA.Ttrop)) };
  }
  // 20-32 km: +1 K/km
  const p20 = ISA.pTrop * Math.exp((-G0 * (20000 - ISA.hTrop)) / (ISA.R * ISA.Ttrop));
  const T = ISA.Ttrop + 0.001 * (Math.min(H, 32000) - 20000);
  return { T, p: p20 * Math.pow(T / ISA.Ttrop, -G0 / (0.001 * ISA.R)) };
}

/** ISA (+ deviation) at MSL altitude: { T (K), p (Pa), rho (kg/m³), a (m/s) }. */
export function isa(hMSL, tempDevC = 0) {
  const s = isaStd(Number.isFinite(hMSL) ? hMSL : 0);
  const T = Math.max(150, s.T + (tempDevC || 0));
  return { T, p: s.p, rho: s.p / (ISA.R * T), a: Math.sqrt(ISA.gamma * ISA.R * T) };
}

/** Standard-atmosphere altitude (m) at which the static pressure equals p (Pa). */
export function altitudeFromPressure(p) {
  if (p >= ISA.pTrop) return (ISA.T0 / ISA.L) * (1 - Math.pow(p / ISA.p0, (ISA.L * ISA.R) / G0));
  return ISA.hTrop - (ISA.R * ISA.Ttrop / G0) * Math.log(p / ISA.pTrop);
}

/** Pressure altitude (m) of a point at hMSL when the sea-level pressure is qnhHpa. */
export function pressureAltitude(hMSL, qnhHpa = 1013.25) {
  return hMSL + altitudeFromPressure((qnhHpa || 1013.25) * 100);
}

/** Atmosphere actually experienced by the aircraft (QNH-aware pressure). */
export function airAt(hMSL, tempDevC = 0, qnhHpa = 1013.25) {
  const hp = pressureAltitude(hMSL, qnhHpa);
  return { ...isa(hp, tempDevC), hp };
}

export function machFromTas(tas, hMSL, tempDevC = 0) { return tas / isa(hMSL, tempDevC).a; }
export function tasFromMach(mach, hMSL, tempDevC = 0) { return mach * isa(hMSL, tempDevC).a; }

/** Compressible CAS from Mach and static pressure. */
export function casFromMachP(M, p) {
  const qc = p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return ISA.a0 * Math.sqrt(5 * (Math.pow(qc / ISA.p0 + 1, 2 / 7) - 1));
}
/** Mach from CAS and static pressure. */
export function machFromCasP(cas, p) {
  const r = cas / ISA.a0;
  const qc = ISA.p0 * (Math.pow(1 + 0.2 * r * r, 3.5) - 1);
  return Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
}

export function casFromTas(tas, hMSL, tempDevC = 0) {
  const at = isa(hMSL, tempDevC);
  return casFromMachP(tas / at.a, at.p);
}
export function tasFromCas(cas, hMSL, tempDevC = 0) {
  const at = isa(hMSL, tempDevC);
  return machFromCasP(cas, at.p) * at.a;
}
export function easFromTas(tas, hMSL, tempDevC = 0) {
  return tas * Math.sqrt(isa(hMSL, tempDevC).rho / ISA.rho0);
}

// ---------------------------------------------------------------- wind ----
const Z0 = 0.03; // m roughness length (open terrain / airport)

/**
 * Mean wind as NED vector (m/s). env.windDirDeg is the direction the wind blows
 * FROM (true), env.windKt its speed as reported at 10 m and above. Below 10 m
 * AGL the speed follows a logarithmic boundary-layer profile.
 */
export function windNED(env, hAGL) {
  const spd = (env && Number.isFinite(env.windKt) ? env.windKt : 0) * KT;
  if (spd <= 0) return [0, 0, 0];
  const h = Math.max(hAGL, Z0 * 1.5);
  const f = clamp(Math.log(h / Z0) / Math.log(10 / Z0), 0, 1);
  const d = (env.windDirDeg || 0) * DEG;
  return [-spd * f * Math.cos(d), -spd * f * Math.sin(d), 0];
}

// ---------------------------------------------------------- turbulence ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Dryden-like turbulence: three first-order Gauss-Markov velocity gusts (NED)
 * plus a roll-rate gust. Intensity 0..1 maps to sigma_w 0..3 m/s (1 ≈ severe).
 * Length scales follow MIL-F-8785C (shorter near the ground).
 */
export function createTurbulence(seed = 777) {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(1e-12, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const st = { u: 0, v: 0, w: 0, p: 0, rnd, gauss };
  st.step = (intensity, V, hAGL, dt) => {
    const I = clamp(intensity || 0, 0, 1);
    if (I <= 0) { st.u = st.v = st.w = st.p = 0; return st; }
    const hft = Math.max(10, hAGL / 0.3048);
    const Lw = hft < 1000 ? hft * 0.3048 : 533;
    const Lu = hft < 1000 ? (hft / Math.pow(0.177 + 0.000823 * hft, 1.2)) * 0.3048 : 533;
    const sw = 3.0 * I;
    const su = hft < 1000 ? sw / Math.pow(0.177 + 0.000823 * hft, 0.4) : sw;
    const Vs = Math.max(V, 10);
    const upd = (x, sigma, L) => {
      const a = Math.exp((-Vs * dt) / Math.max(L, 5));
      return a * x + sigma * Math.sqrt(1 - a * a) * gauss();
    };
    st.u = upd(st.u, Math.min(su, 2 * sw), Lu);
    st.v = upd(st.v, Math.min(su, 2 * sw), Lu);
    st.w = upd(st.w, sw, Lw);
    st.p = upd(st.p, 0.025 * I, 30); // rad/s roll gust
    return st;
  };
  return st;
}
