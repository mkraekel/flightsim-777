// Aerodynamic model: lift (flap/slat table, nonlinear stall), drag polar with
// configuration and compressibility increments, ground effect, side force and
// the six stability-derivative moments. Pure functions, no state.

import { clamp, DEG } from '../core/geo.js';
import { GEOM, AERO, FLAP_TABLE, SLAT_EXTRA_CLMAX } from './aircraft777.js';

/** Piecewise-linear interpolation in a [[x, y], ...] table (clamped ends). */
export function interp1(tab, x) {
  if (!(x > tab[0][0])) return tab[0][1];
  const n = tab.length - 1;
  if (x >= tab[n][0]) return tab[n][1];
  let i = 0;
  while (x > tab[i + 1][0]) i++;
  const [x0, y0] = tab[i], [x1, y1] = tab[i + 1];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** Inverse of a monotonic table (y -> x). */
export function interpInv(tab, y) {
  return interp1(tab.map(([a, b]) => [b, a]), y);
}

const lerpRow = (a, b, t) => {
  const r = {};
  for (const k of Object.keys(a)) r[k] = a[k] + (b[k] - a[k]) * t;
  return r;
};

/** Flap/slat configuration row for the actual surface positions. */
export function flapRow(flapsDeg, slats) {
  let row;
  if (flapsDeg <= 1) {
    row = lerpRow(FLAP_TABLE[0], FLAP_TABLE[1], clamp(slats / 0.5, 0, 1));
    row.slat = clamp(slats, 0, 0.5);
  } else {
    let i = 1;
    while (i < FLAP_TABLE.length - 2 && flapsDeg > FLAP_TABLE[i + 1].deg) i++;
    const a = FLAP_TABLE[i], b = FLAP_TABLE[i + 1];
    row = lerpRow(a, b, clamp((flapsDeg - a.deg) / (b.deg - a.deg), 0, 1));
  }
  const ds = slats - row.slat;
  row.CLmax += ds > 0 ? SLAT_EXTRA_CLMAX * ds : 0.4 * ds;
  return row;
}

export const clAlpha = (M) => interp1(AERO.CLalphaMach, M);

/** Effective CLmax for configuration row and Mach. */
export function clMaxFor(row, M) {
  return row.CLmax - (1.45 - interp1(AERO.CLmaxCleanMach, M));
}

/**
 * Static lift curve. Linear to (CLmax - 0.15), parabolic rounding to the peak,
 * then a post-stall drop of 0.04/deg for 6°, slower beyond, blending into a
 * flat-plate curve at very high |alpha|.
 */
export function liftCurve(alpha, CL0, CLa, CLmax) {
  const aLin = (CLmax - AERO.roundCL - CL0) / CLa;
  const dPk = (2 * AERO.roundCL) / CLa;
  const aPk = aLin + dPk;
  const fp = 1.05 * Math.sin(2 * alpha); // flat plate
  let CL;
  if (alpha < -0.35) {
    CL = Math.max(CL0 + CLa * -0.35, -1.0);
    const t = clamp((-alpha - 0.35) / 0.4, 0, 1);
    CL = CL * (1 - t) + fp * t;
  } else if (alpha <= aLin) {
    CL = Math.max(CL0 + CLa * alpha, -1.0);
  } else if (alpha <= aPk) {
    const d = alpha - aLin;
    CL = CL0 + CLa * aLin + CLa * d - (CLa / (2 * dPk)) * d * d;
  } else {
    const post = alpha - aPk;
    const d1 = Math.min(post, 6 * DEG);
    CL = CLmax - AERO.postStallSlope * d1 - 0.8 * Math.max(0, post - 6 * DEG);
    CL = Math.max(CL, fp);
  }
  return { CL, aLin, aPk, aShaker: aLin + 0.45 * dPk };
}

/**
 * Compute aerodynamic coefficients, body forces (N) and moments (N·m).
 * in: { alpha, beta, V, mach, qbar, p, q, r, alphaDot, elevator, stab, droll,
 *       rudder, flapsDeg, slats, gear, sb, hWing, xcg, engOut, stallAsym }
 */
export function computeAero(a) {
  const { S, b, cbar } = GEOM;
  const M = clamp(a.mach || 0, 0, 0.98);
  const Vn = Math.max(a.V, 30); // floor for rate non-dimensionalisation
  const row = flapRow(a.flapsDeg, a.slats);
  const CLa = clAlpha(M);
  const CLmax = clMaxFor(row, M);
  const alpha = clamp(a.alpha, -Math.PI / 2, Math.PI / 2);
  const beta = clamp(a.beta, -0.5, 0.5);

  // --- ground effect (McCormick)
  const hb = (16 * Math.max(a.hWing, 0.5)) / b;
  const phi = Number.isFinite(a.hWing) ? (hb * hb) / (1 + hb * hb) : 1;
  const geFlap = clamp(a.flapsDeg / 15, 0, 1);

  // --- lift
  const lc = liftCurve(alpha, row.CL0 + AERO.geCL * (1 - phi) * geFlap, CLa, CLmax + AERO.geCL * (1 - phi) * geFlap);
  const qh = (a.q * cbar) / (2 * Vn), adh = (clamp(a.alphaDot, -0.5, 0.5) * cbar) / (2 * Vn);
  const sb = clamp(a.sb, 0, 1);
  const sbCL = sb <= 0.6 ? (AERO.sbFlight.CL * sb) / 0.6 : AERO.sbFlight.CL + ((AERO.sbGround.CL - AERO.sbFlight.CL) * (sb - 0.6)) / 0.4;
  const sbCD = sb <= 0.6 ? (AERO.sbFlight.CD * sb) / 0.6 : AERO.sbFlight.CD + ((AERO.sbGround.CD - AERO.sbFlight.CD) * (sb - 0.6)) / 0.4;
  const CLwing = lc.CL + sbCL * clamp(lc.CL / 1.2, 0.3, 1.5);
  const CL = CLwing + AERO.CLq * qh + AERO.CLad * adh + AERO.CLde * a.elevator + AERO.CLstab * a.stab;
  const stalled = alpha > lc.aPk;
  const post = Math.max(0, alpha - lc.aPk);

  // --- drag
  const cosL = Math.cos(GEOM.sweep);
  const Mdd = AERO.kappaA / cosL - GEOM.tc / (cosL * cosL) - clamp(CL, 0, 1.2) / (10 * cosL ** 3);
  const Mcrit = Mdd - AERO.mcritOffset;
  const CDw = M > Mcrit ? AERO.waveK * (M - Mcrit) ** 4 : 0;
  const gear = clamp(a.gear, 0, 1);
  const CDi = row.k * (CLwing - AERO.CLminD) ** 2 * phi;
  let CD = AERO.CD0 + row.dCD0 + CDi + CDw + sbCD + AERO.dCDgear * gear +
    (gear > 0.02 && gear < 0.98 ? AERO.dCDgearTransit : 0) + AERO.dCDengOut * (a.engOut || 0);
  CD = Math.max(CD, 0.02 + 1.7 * Math.sin(alpha) ** 2 * (stalled || alpha < -0.3 ? 1 : 0.4));
  CD += 0.3 * Math.sin(beta) ** 2;

  // --- side force
  const t = clamp((M - 0.25) / 0.5, 0, 1);
  const L = (k) => AERO.lat[k][0] + (AERO.lat[k][1] - AERO.lat[k][0]) * t;
  const CY = L('CYb') * beta + L('CYdr') * a.rudder;

  // --- pitching moment
  const Cmq = interp1(AERO.CmqMach, M);
  const bump = Math.exp(-(((alpha - lc.aPk) / (2 * DEG)) ** 2));
  const brk = clamp((post - 1.5 * DEG) / (5 * DEG), 0, 1);
  const alphaM = clamp(alpha, -0.5, 0.7);
  const Cm = AERO.Cm0 + AERO.Cmalpha * alphaM + Cmq * qh + AERO.Cmad * adh + AERO.Cmde * a.elevator +
    AERO.Cmstab * a.stab + row.dCm0 + AERO.CmGear * gear + AERO.CmSpoiler * sb +
    AERO.CmStallBump * bump + AERO.CmStallBreak * brk + AERO.geCm * (1 - phi) * geFlap +
    CLwing * ((a.xcg ?? 0.25) - 0.25);

  // --- roll / yaw
  const ph = (a.p * b) / (2 * Vn), rh = (a.r * b) / (2 * Vn);
  const stallRoll = (a.stallAsym || 0) * 0.025 * clamp(post / (4 * DEG), 0, 1);
  const Cl = L('Clb') * beta + L('Clp') * ph + L('Clr') * rh + L('Clda') * a.droll + L('Cldr') * a.rudder + stallRoll;
  const Cn = L('Cnb') * beta + L('Cnp') * ph + L('Cnr') * rh + L('Cnda') * a.droll + L('Cndr') * a.rudder;

  // --- forces in body axes (wind -> body)
  const qS = a.qbar * S;
  const Lf = qS * CL, Df = qS * CD, Yf = qS * CY;
  const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sbe = Math.sin(beta);
  const F = [-Df * ca * cb + Lf * sa, -Df * sbe + Yf, -Df * sa * cb - Lf * ca];
  const Mo = [qS * b * Cl, qS * cbar * Cm, qS * b * Cn];

  // --- warnings
  const shaker = lc.CL >= 0.92 * CLmax || alpha >= lc.aShaker;
  const buffetLow = clamp((alpha - lc.aLin) / (lc.aPk - lc.aLin + 1e-6), 0, 1.5);
  const buffetHigh = M > 0.6 ? clamp((CLwing - (CLmax - 0.12)) / 0.15, 0, 1) : 0;
  const buffet = clamp(Math.max(buffetLow * 0.7, buffetHigh, CDw > 0.004 ? (CDw - 0.004) * 60 : 0), 0, 1);

  return {
    CL, CD, CY, Cl, Cm, Cn, CLwing, F, M: Mo,
    CLmax, aPk: lc.aPk, aShaker: lc.aShaker, aLin: lc.aLin, CLa, row,
    stalled, shaker, buffet, phiGE: phi, Mcrit,
    lat: { Clda: L('Clda'), Clp: L('Clp'), Cndr: L('Cndr'), Cnda: L('Cnda'), Clb: L('Clb'), Cnb: L('Cnb') },
  };
}
