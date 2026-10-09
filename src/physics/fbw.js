// 777 Primary Flight Control System model (NORMAL / SECONDARY / DIRECT).
// Pitch: C*U law (column -> C* = Δnz + Vco/g·q relative to the trim reference
// speed), auto stabilizer trim, flare compensation, envelope protections.
// Roll: wheel -> roll-rate command with bank hold below 35° and bank-angle
// protection. Yaw: yaw damper, turn coordination, TAC. Plus secondary surfaces
// (flaps/slats with load relief, speedbrake/ground spoilers).
// Gains are partially model-inverting (scaled by dynamic pressure & inertia).

import { clamp, approach, lag, DEG, KT, G0, FT } from '../core/geo.js';
import { FLAP_DETENTS } from '../core/state.js';
import { GEOM, AERO, SURF, LIMITS, FBW as K, ENGINE } from './aircraft777.js';

export function createFbwState() {
  return { deI: 0, gB: 1, flareT: 0, flare: false, phiHold: 0, hold: false, pI: 0, liftoffT: 0, droll: 0 };
}

const num = (v) => (Number.isFinite(v) ? v : 0);

/** Pilot / autopilot input combination per CONTRACT. */
function effectiveInputs(sim) {
  const c = sim.controls, out = sim.ap?.out;
  const pil = { pitch: clamp(num(c.pitch), -1, 1), roll: clamp(num(c.roll), -1, 1), yaw: clamp(num(c.yaw), -1, 1) };
  if (!out || !out.active) return { ...pil, ap: false };
  if (Math.abs(pil.pitch) > 0.3 || Math.abs(pil.roll) > 0.3) c.apDisc = true;
  const pick = (p, a) => (Math.abs(p) < 0.3 ? clamp(num(a), -1, 1) : p);
  return { pitch: pick(pil.pitch, out.pitch), roll: pick(pil.roll, out.roll), yaw: pick(pil.yaw, out.yaw), ap: true };
}

export const rudderLimit = (casKt) => Math.max(SURF.rudderMin, SURF.rudderMax * Math.min(1, (SURF.rudderRatioKt / Math.max(casKt, 1)) ** 2));

// ------------------------------------------------------------------ pitch
function pitchLaw(sim, S, x, inp, dt) {
  const s = sim.surfaces, fb = sim.fbw, c = sim.controls;
  const normal = fb.mode === 'NORMAL';
  const col = inp.pitch;
  const dDir = col >= 0 ? -col * SURF.elevUp : -col * SURF.elevDown;
  // ground blend: 1 = direct (on ground), 0 = C*U (airborne)
  S.gB = approach(S.gB, x.mainWow ? 1 : 0, x.mainWow ? 1.0 : 0.5, dt);
  let dirEl = dDir;
  // Rotation-rate limiter + tail-strike protection on the runway and just after liftoff (main gear
  // still within a few metres): keyboard/gamepad users slam the column to full aft, which with direct
  // elevator gives ~6°/s and a tail strike. Fade the nose-up elevator above ~3°/s and when the pitch
  // predicted 1 s ahead approaches the tail-strike attitude.
  if (col > 0 && (x.mainWow || (S.gB > 0.3 && x.ra < 5))) {
    const qEx = x.q - 3 * DEG;
    if (qEx > 0) dirEl *= clamp(1 - qEx / (2 * DEG), 0, 1);
    const pred = x.pitch + Math.max(0, x.q) * 1.0;
    if (pred > 8 * DEG) dirEl *= clamp(1 - (pred - 8 * DEG) / (2 * DEG), 0, 1);
  }

  // trim reference speed / trim switch
  const sw = Math.sign(num(c.trimSwitch));
  if (x.mainWow || !normal) {
    fb.trimRefKt = x.casKt;
    if (sw && (x.mainWow || !normal)) s.stab = clamp(s.stab + sw * SURF.stabRateLow * dt, SURF.stabMin, SURF.stabMax);
  } else if (inp.ap) {
    fb.trimRefKt = x.casKt;
  } else {
    fb.trimRefKt = clamp(fb.trimRefKt + sw * K.trimRefRate * dt, x.vMinManKt, LIMITS.VMO);
  }

  if (!normal) {
    S.deI = dirEl;
    fb.law = 'DIRECT';
    return fb.mode === 'DIRECT' ? dirEl : dirEl;
  }

  // ---- C*U law
  const V = Math.max(x.tas, 50);
  const kC = 1 + K.Vco / V;
  const phiA = Math.abs(x.roll);
  const phiC = Math.min(phiA, K.bankCompMax);
  const nzReq = Math.cos(x.fpa) / Math.cos(phiC);
  const qTurn = (G0 / V) * Math.sin(phiC) * Math.tan(phiC) * Math.sign(Math.cos(x.roll));
  const cMeas = (x.nzW - nzReq) + (K.Vco / G0) * (x.q - qTurn);
  let cmd = col >= 0 ? col * K.cstarPull : col * K.cstarPush;

  // speed stability about the trim reference (U term) and envelope protections
  // speed error plus a speed-rate (phugoid damping) term
  S.casF = S.casF ?? x.casKt;
  const casRate = (x.casKt - S.casF) / K.uRateTau;
  S.casF = lag(S.casF, x.casKt, K.uRateTau, dt);
  let du = clamp(K.Ku * (x.casKt - fb.trimRefKt + K.uDamp * casRate), -K.uMax, K.uMax);
  fb.prot.stall = x.casKt < x.vMinManKt && !x.mainWow;
  if (fb.prot.stall) du -= 0.02 * (x.vMinManKt - x.casKt);
  const over = Math.max(x.casKt - LIMITS.VMO, (x.mach - LIMITS.MMO) * 600);
  fb.prot.overspeed = over > 0;
  if (over > 0) du += Math.min(0.6, K.overspeedGain * over);
  if (S.flare) du = 0;
  if (inp.ap) du = over > 0 ? Math.min(0.6, K.overspeedGain * over) : 0;
  // the speed term acts slowly (phugoid-like): short term the law holds flight path
  S.duF = lag(S.duF ?? 0, du, K.uTau, dt);
  cmd += S.duF * kC;
  const aMargin = x.alpha - (x.aShaker - 1 * DEG);
  if (aMargin > 0) cmd -= K.alphaProtGain * aMargin;
  if (x.nzW > LIMITS.nzMax) cmd -= 4 * (x.nzW - LIMITS.nzMax) * kC;
  if (x.nzW < LIMITS.nzMin) cmd += 4 * (LIMITS.nzMin - x.nzW) * kC;

  // flare compensation: gradual nose-down bias below 100 ft RA with gear down
  const raFt = x.ra / FT;
  if (raFt > K.flareRaFt + 50) S.flareArm = true; // armed once well above the flare height
  if (S.flareArm && !x.mainWow && raFt < K.flareRaFt && s.gear > 0.9 && x.vs < 0) S.flare = true;
  if (raFt > K.flareRaFt + 50 || S.gB > 0.99) S.flare = false;
  if (S.gB > 0.99) S.flareArm = false;
  S.flareT = S.flare ? S.flareT + dt : 0;
  if (S.flare) cmd += K.flareBias * clamp(S.flareT / K.flareRampS, 0, 1);

  const err = cmd - cMeas;
  const Gk = x.Iyy / (Math.max(x.qbar, 1500) * GEOM.S * GEOM.cbar * -AERO.Cmde);
  let de = S.deI - Gk * K.Kp * err;
  const sat = de < -SURF.elevUp || de > SURF.elevDown;
  if (!(sat && Math.sign(-err) === Math.sign(de))) S.deI -= Gk * K.Ki * err * dt;
  S.deI = clamp(S.deI, -SURF.elevUp, SURF.elevDown);
  if (S.gB > 0.999) S.deI = dirEl; // bumpless transfer at liftoff
  de = S.gB * dirEl + (1 - S.gB) * de;
  fb.law = S.gB > 0.5 ? 'GROUND' : S.flare ? 'FLARE' : 'CSTAR';
  fb.cstarCmd = cmd; fb.cstar = cMeas;

  // auto stabilizer trim offloads the elevator (inhibited on ground and in flare)
  if (S.gB < 0.01 && !S.flare) {
    const tgt = s.stab - s.elevator * (-AERO.Cmde / AERO.Cmstab);
    const rate = x.casKt < 230 ? SURF.stabRateLow : SURF.stabRateHigh;
    if (Math.abs(tgt - s.stab) > 0.05 * DEG) s.stab = clamp(approach(s.stab, tgt, rate, dt), SURF.stabMin, SURF.stabMax);
  }
  return de;
}

// ------------------------------------------------------------------- roll
function rollLaw(sim, S, x, inp, dt) {
  const fb = sim.fbw, w = inp.roll;
  const dDir = w * SURF.rollMax;
  if (fb.mode !== 'NORMAL' || S.gB > 0.999) {
    S.hold = false; S.pI = 0; fb.prot.bank = false;
    return fb.mode === 'NORMAL' ? dDir : dDir;
  }
  let pCmd;
  if (Math.abs(w) > 0.05) {
    pCmd = w * K.pMax;
    S.hold = false;
  } else {
    if (!S.hold) { S.hold = true; S.phiHold = x.roll + x.p * 0.8; }
    pCmd = clamp(K.KphiHold * (S.phiHold - x.roll), -K.pMax / 2, K.pMax / 2);
  }
  const phiA = Math.abs(x.roll), sg = Math.sign(x.roll);
  fb.prot.bank = phiA > K.bankProt;
  if (fb.prot.bank) {
    if (S.hold) S.phiHold = sg * K.bankRollback;
    else if (Math.sign(w) === sg) pCmd -= sg * K.bankProtGain * (phiA - K.bankProt);
  }
  if (inp.ap && phiA > K.bankProt) pCmd -= sg * 1.0 * (phiA - K.bankProt);
  const V = Math.max(x.tas, 50);
  const qSb = Math.max(x.qbar, 1500) * GEOM.S * GEOM.b;
  const Clda = x.lat.Clda;
  const ff = (-x.lat.Clp * (pCmd * GEOM.b) / (2 * V)) / Clda;
  const err = pCmd - x.p;
  S.pI = clamp(S.pI + K.KiRoll * err * dt, -0.15, 0.15);
  const d = ff + (x.Ixx * K.KpRoll * err) / (qSb * Clda) + S.pI;
  return S.gB * dDir + (1 - S.gB) * d;
}

// -------------------------------------------------------------------- yaw
function yawLaw(sim, S, x, inp, droll) {
  const fb = sim.fbw, c = sim.controls;
  const lim = rudderLimit(x.casKt);
  let dr = inp.yaw * lim + clamp(num(c.rudderTrim), -1, 1) * 0.55 * SURF.rudderMax;
  const qSb = Math.max(x.qbar, 800) * GEOM.S * GEOM.b;
  const Cndr = x.lat.Cndr;
  // TAC: cancel ~90 % of the thrust-asymmetry yaw moment
  const Nt = ENGINE.pos.reduce((acc, p, i) => acc - p[1] * x.thrust[i], 0);
  const revOut = sim.surfaces.reverser[0] > 0.02 || sim.surfaces.reverser[1] > 0.02;
  const tacOn = fb.prot.tac !== false && fb.mode !== 'DIRECT' && x.casKt > K.tacMinKt && !revOut;
  fb.tacActive = tacOn && Math.abs(Nt) > 0.1 * ENGINE.Fsls * 10.6;
  if (tacOn) dr += (-K.tacFrac * Nt) / (qSb * Cndr);
  // yaw damper + turn coordination (airborne)
  if (fb.mode !== 'DIRECT' && S.gB < 0.5 && x.casKt > 60) {
    const V = Math.max(x.tas, 50);
    const rC = (G0 * Math.sin(x.roll) * Math.cos(x.pitch)) / V;
    const nDes = -K.KrYD * (x.r - rC) + K.KbetaYD * x.beta;
    dr += clamp((x.Izz * nDes) / (qSb * Cndr) - (x.lat.Cnda * droll) / Cndr, -K.ydMax, K.ydMax);
  }
  return clamp(dr, -lim, lim);
}

// -------------------------------------------------------- secondary surfaces
function stepSecondary(sim, x, G, dt) {
  const s = sim.surfaces, c = sim.controls;
  const idx = clamp(Math.round(c.flapLever || 0), 0, FLAP_DETENTS.length - 1);
  let det = FLAP_DETENTS[idx];
  s.flapLoadRelief = false;
  if (!x.mainWow) {
    let j = idx;
    while (j > 0 && FLAP_DETENTS[j] >= 25 && x.casKt > LIMITS.flapPlacard[FLAP_DETENTS[j]] + 5) j--;
    if (j !== idx) { det = FLAP_DETENTS[j]; s.flapLoadRelief = true; }
  }
  s.flapsTarget = det;
  const slow = det <= 1 && s.flapsDeg <= 1;
  s.flapsDeg = approach(s.flapsDeg, det, slow ? 0.3 : SURF.flapRateDeg, dt);
  let slatT = det === 0 ? 0 : det >= 25 ? 1 : 0.5;
  if (det > 0 && det < 25 && !x.mainWow && x.shaker) slatT = 1; // autoslat
  s.slats = approach(s.slats, slatT, SURF.slatRate, dt);
  const lever = clamp(c.speedbrakeLever || 0, 0, 1);
  const sbT = G.groundSpoiler ? 1 : x.mainWow ? lever : lever * 0.6;
  s.speedbrake = approach(s.speedbrake, sbT, SURF.sbRate, dt);
}

/**
 * Run the flight-control laws. x: air/inertial data from fdm (casKt, tas, mach,
 * qbar, alpha, beta, nzW, fpa, roll, pitch, p, q, r, vs, ra, mainWow, aShaker,
 * vMinManKt, Ixx, Iyy, Izz, lat, thrust[], shaker). Writes sim.surfaces/sim.fbw.
 * Returns the equivalent roll-surface deflection used by aero.
 */
export function stepFBW(sim, S, x, G, dt) {
  const s = sim.surfaces, fb = sim.fbw;
  if (!fb.prot) fb.prot = { stall: false, overspeed: false, bank: false, tac: true };
  if (!['NORMAL', 'SECONDARY', 'DIRECT'].includes(fb.mode)) fb.mode = 'NORMAL';
  const inp = effectiveInputs(sim);
  stepSecondary(sim, x, G, dt);
  const de = clamp(pitchLaw(sim, S, x, inp, dt), -SURF.elevUp, SURF.elevDown);
  const drC = clamp(rollLaw(sim, S, x, inp, dt), -SURF.rollMax, SURF.rollMax);
  s.elevator = lag(approach(s.elevator, de, SURF.elevRate, dt), de, 0.03, dt);
  S.droll = approach(S.droll, drC, SURF.rollRate, dt);
  const dr = yawLaw(sim, S, x, inp, S.droll);
  s.rudder = approach(s.rudder, dr, SURF.rudderRate, dt);
  // display mapping of the lumped roll surface
  const rn = S.droll / SURF.rollMax;
  s.aileron = rn * SURF.aileronDisplayMax;
  s.spoilerRollR = clamp((rn - 0.15) / 0.85, 0, 1);
  s.spoilerRollL = clamp((-rn - 0.15) / 0.85, 0, 1);
  s.stabUnits = s.stab / DEG + SURF.stabUnitsOffsetDeg;
  return S.droll;
}

export { KT };
