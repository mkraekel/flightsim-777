// 6-DOF flight dynamics for the 777-300ER. Rigid body with quaternion attitude,
// body-frame forces/moments, NED translational dynamics on the WGS84 ellipsoid
// (transport-rate terms included), semi-implicit Euler at a fixed 1/120 s step.
// Runs FBW -> secondary surfaces -> gear actuators -> brakes -> engines -> aero ->
// ground contact -> integration -> outputs. Fills sim.ac / surfaces / engines / fbw.

import {
  DEG, KT, FT, G0, clamp, lag, wrap2pi, earthRadii, qrot, qrotInv, qintegrate, qnorm,
  eulerToQuat, quatToEuler, vcross, FPM,
} from '../core/geo.js';
import { FLAP_DETENTS } from '../core/state.js';
import { airAt, windNED, createTurbulence, casFromMachP, machFromCasP, ISA } from './atmosphere.js';
import { GEOM, MASS, INERTIA, ENGINE, GEAR, LIMITS, SURF } from './aircraft777.js';
import { computeAero, flapRow, clMaxFor } from './aero.js';
import { engineEnv, stepEngines, createEngineState, setEngineSteady, n1ForThrust, n1ToLever, thrustAtN1, n1FromN2, idleN2 } from './engines.js';
import { createGearState, stepGearActuator, stepBrakesAndSteering, computeGround, evaluateContacts } from './gear.js';
import { createFbwState, stepFBW } from './fbw.js';

const STORE = new WeakMap();
const fin = (v) => Number.isFinite(v);
const finArr = (a) => Array.isArray(a) && a.every(fin);

// ------------------------------------------------------------ helpers
export function inertiaFor(m) {
  const t = INERTIA;
  let i = 0;
  while (i < t.length - 2 && m > t[i + 1].m) i++;
  const a = t[i], b = t[i + 1], f = (m - a.m) / (b.m - a.m);
  const L = (k) => a[k] + (b[k] - a[k]) * f;
  return { Ixx: L('Ixx'), Iyy: L('Iyy'), Izz: L('Izz'), Ixz: L('Ixz') };
}

const totalFuel = (fk) => (fk.L || 0) + (fk.C || 0) + (fk.R || 0);
const cgShift = (sim) => (((fin(sim.ac.cgMacPct) ? sim.ac.cgMacPct : 25) - 25) / 100) * GEOM.cbar;

function newState(sim, onGround) {
  return {
    eng: [createEngineState(true), createEngineState(true)],
    gear: createGearState(onGround),
    fbw: createFbwState(),
    turb: createTurbulence(777),
    lastGround: fin(sim.env.groundH) ? sim.env.groundH : 0,
    nzW: 1, alphaPrev: 0, alphaDot: 0, thrust: [0, 0], stallAsym: 0,
    aero: null, snap: null, vsPrev: 0,
  };
}

function getState(sim) {
  let F = STORE.get(sim);
  if (!F) {
    F = newState(sim, sim.ac.onGround);
    // adopt whatever engine state is in sim (stepPhysics without initAircraft)
    sim.engines.forEach((e, i) => { F.eng[i].lit = !!e.running; F.eng[i].n2 = e.n2 || 0; F.eng[i].n1 = e.n1 || 0; });
    F.fbw.gB = sim.ac.onGround ? 1 : 0;
    F.lastGround = fin(sim.env.groundH) ? sim.env.groundH : sim.ac.h - 5;
    STORE.set(sim, F);
  }
  return F;
}

/** Characteristic speeds (CAS kt) for the current config/weight. */
function speedBands(sim, air, mass) {
  const s = sim.surfaces;
  const row = flapRow(s.flapsDeg, s.slats);
  const W = mass * G0;
  const sqd = Math.sqrt(air.p / ISA.p0);
  let M = 0.3, vsE = 0;
  for (let i = 0; i < 3; i++) {
    vsE = Math.sqrt((2 * W) / (ISA.rho0 * GEOM.S * clMaxFor(row, M)));
    M = vsE / (ISA.a0 * sqd);
  }
  const vs = casFromMachP(M, air.p) / KT;
  const mmoCas = casFromMachP(LIMITS.MMO, air.p) / KT;
  let vmax = Math.min(LIMITS.VMO, mmoCas);
  const det = FLAP_DETENTS.find((d) => d >= s.flapsDeg - 0.5) ?? 30;
  if (s.flapsDeg > 0.5 || s.slats > 0.05) vmax = Math.min(vmax, LIMITS.flapPlacard[Math.max(1, det)]);
  if (s.gear > 0.02) vmax = Math.min(vmax, LIMITS.VLE, casFromMachP(LIMITS.MLE, air.p) / KT);
  return { vs, vShaker: vs * 1.043, vMinMan: vs * 1.19, vmax, mmoCas };
}

// ------------------------------------------------------------ trim
/**
 * Solve steady wings-level flight at TAS `tas` and flight-path angle `gamma`
 * (rad) with elevator neutral: returns { alpha, stab, thrust (total N) }.
 */
export function solveTrim(sim, { tas, hMSL, gamma = 0, mass }) {
  const air = airAt(hMSL, sim.env.tempDevC || 0, sim.env.qnhHpa || 1013.25);
  const s = sim.surfaces;
  const M = tas / air.a, qbar = 0.5 * air.rho * tas * tas;
  const m = mass ?? sim.ac.mass, W = m * G0;
  const res = (x) => {
    const [al, st, T] = x;
    const th = al + gamma;
    const a = computeAero({ alpha: al, beta: 0, V: tas, mach: M, qbar, p: 0, q: 0, r: 0, alphaDot: 0, elevator: 0, stab: st, droll: 0, rudder: 0, flapsDeg: s.flapsDeg, slats: s.slats, gear: s.gear, sb: 0, hWing: Infinity, xcg: 0.25 + cgShift(sim) / GEOM.cbar, engOut: 0 });
    return [(a.F[0] + T - W * Math.sin(th)) / W, (a.F[2] + W * Math.cos(th)) / W, (a.M[1] + T * ENGINE.pos[0][2]) / (W * 10)];
  };
  let x = [0.05, 0.0, 0.1 * W];
  for (let it = 0; it < 30; it++) {
    const r0 = res(x);
    if (Math.hypot(...r0) < 1e-9) break;
    const h = [1e-4, 1e-4, 10];
    const J = [0, 1, 2].map((j) => { const xp = x.slice(); xp[j] += h[j]; const r = res(xp); return r.map((v, i) => (v - r0[i]) / h[j]); });
    // J[j][i] = d r_i / d x_j  -> solve sum_j J[j][i] dx_j = -r_i (Cramer)
    const A = [[J[0][0], J[1][0], J[2][0]], [J[0][1], J[1][1], J[2][1]], [J[0][2], J[1][2], J[2][2]]];
    const det3 = (m3) => m3[0][0] * (m3[1][1] * m3[2][2] - m3[1][2] * m3[2][1]) - m3[0][1] * (m3[1][0] * m3[2][2] - m3[1][2] * m3[2][0]) + m3[0][2] * (m3[1][0] * m3[2][1] - m3[1][1] * m3[2][0]);
    const D = det3(A);
    if (!fin(D) || Math.abs(D) < 1e-18) break;
    const b = r0.map((v) => -v);
    const dx = [0, 1, 2].map((k) => det3(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
    x = [clamp(x[0] + dx[0], -0.2, 0.3), clamp(x[1] + dx[1], -0.15, 0.25), x[2] + dx[2]];
  }
  return { alpha: x[0], stab: x[1], thrust: x[2], mach: M, qbar };
}

// ------------------------------------------------------------ init
/**
 * Place the aircraft. lat/lon/heading in radians; h = ground ellipsoidal height
 * when onGround, else CG ellipsoidal height; speedKt is CAS (airborne) or ground
 * speed (on ground). Optional: enginesRunning (default true).
 */
export function initAircraft(sim, { lat, lon, h, heading, onGround = true, speedKt = 0, fuelKg = 60000, payloadKg = 30000, enginesRunning = true } = {}) {
  const ac = sim.ac, s = sim.surfaces, c = sim.controls, env = sim.env;
  const F = newState(sim, onGround);
  STORE.set(sim, F);
  ac.lat = fin(lat) ? lat : 0; ac.lon = fin(lon) ? lon : 0;
  const hdg = wrap2pi(fin(heading) ? heading : 0);
  const fuel = clamp(fuelKg, 0, MASS.maxFuel);
  const side = Math.min(fuel / 2, MASS.tankCap.L);
  ac.fuelKg = { L: side, C: fuel - 2 * side, R: side };
  ac.zfw = MASS.OEW + Math.max(0, payloadKg);
  ac.mass = ac.zfw + fuel;
  ac.crashed = false; ac.crashReason = '';
  ac.omega = [0, 0, 0];
  const dx = cgShift(sim);

  // surfaces from lever positions
  const det = FLAP_DETENTS[clamp(Math.round(c.flapLever || 0), 0, FLAP_DETENTS.length - 1)];
  s.flapsDeg = s.flapsTarget = det;
  s.slats = det === 0 ? 0 : det >= 25 ? 1 : 0.5;
  s.gear = s.gearTarget = onGround || c.gearLever !== 'UP' ? 1 : 0;
  s.speedbrake = 0; s.reverser = [0, 0]; s.brakes = [0, 0]; s.noseWheel = 0;
  s.elevator = 0; s.aileron = 0; s.rudder = 0; s.spoilerRollL = s.spoilerRollR = 0;
  sim.fbw.mode = sim.fbw.mode || 'NORMAL';
  sim.fbw.prot = { stall: false, overspeed: false, bank: false, tac: sim.fbw.prot?.tac !== false };

  if (onGround) {
    const gH = fin(h) ? h : env.groundH || 0;
    F.lastGround = gH;
    const W = ac.mass * G0;
    const [n, ml] = GEAR.struts;
    const xn = n.x + dx, xm = ml.x + dx;
    const fN = -xm / (xn - xm);
    const cN = (fN * W) / n.k, cM = ((1 - fN) * W) / (2 * ml.k);
    const sth = (cM - cN) / (xn - xm), th = Math.asin(sth);
    ac.h = gH - xm * sth + ml.z * Math.cos(th) - cM;
    ac.quat = eulerToQuat(0, th, hdg);
    const v = Math.max(0, speedKt) * KT;
    ac.vNED = [v * Math.cos(hdg), v * Math.sin(hdg), 0];
    // takeoff stabilizer trim (green band) from a trim solution near V2
    const air = airAt(gH - (env.geoidN || 0), env.tempDevC || 0, env.qnhHpa || 1013.25);
    const sb = speedBands(sim, air, ac.mass);
    const tr = solveTrim(sim, { tas: Math.max(sb.vs * 1.2, 120) * KT, hMSL: gH - (env.geoidN || 0) });
    s.stab = clamp(fin(tr.stab) ? tr.stab : 0.01, -2 * DEG, 4 * DEG);
    F.fbw.gB = 1;
    sim.fbw.trimRefKt = speedKt;
    const eEnv = engineEnv(air, 0);
    for (let i = 0; i < 2; i++) setEngineSteady(sim, F.eng[i], i, enginesRunning, n1FromN2(ENGINE.idleN2.ground), eEnv, air.T - 273.15);
    if (enginesRunning) c.throttle = [0, 0];
  } else {
    ac.h = fin(h) ? h : 3000;
    F.lastGround = fin(env.groundH) ? env.groundH : 0;
    const hMSL = ac.h - (env.geoidN || 0);
    const air = airAt(hMSL, env.tempDevC || 0, env.qnhHpa || 1013.25);
    const tas = machFromCasP(Math.max(speedKt, 100) * KT, air.p) * air.a;
    const tr = solveTrim(sim, { tas, hMSL });
    s.stab = clamp(tr.stab, SURF.stabMin, SURF.stabMax);
    ac.quat = eulerToQuat(0, tr.alpha, hdg);
    ac.vNED = [tas * Math.cos(hdg), tas * Math.sin(hdg), 0];
    F.fbw.gB = 0;
    F.fbw.deI = 0;
    sim.fbw.trimRefKt = speedKt;
    const eEnv = engineEnv(air, tas / air.a);
    const n1 = n1ForThrust(tr.thrust / 2, eEnv);
    for (let i = 0; i < 2; i++) setEngineSteady(sim, F.eng[i], i, enginesRunning, Math.max(n1, n1FromN2(idleN2(false, s.flapsDeg, s.gear > 0.9))), eEnv, air.T - 273.15);
    if (enginesRunning) { const lv = n1ToLever(n1, eEnv); c.throttle = [lv, lv]; }
    F.alphaPrev = tr.alpha;
  }
  ac.onGround = onGround;
  ac.wow = { nose: onGround, left: onGround, right: onGround };
  ac.ra = onGround ? 0 : Math.max(0, ac.h - F.lastGround - GEAR.struts[1].z);
  ac.vs = 0; ac.fpa = 0;
  // fill sim.engines (thrust, ff, egt...) for the initial state without advancing it
  {
    const air = airAt(ac.h - (env.geoidN || 0), env.tempDevC || 0, env.qnhHpa || 1013.25);
    const tas = Math.hypot(...ac.vNED), M = tas / air.a;
    F.thrust = stepEngines(sim, F.eng, {
      env: engineEnv(air, M), air, qbar: 0.5 * air.rho * tas * tas, casKt: casFromMachP(M, air.p) / KT, onGround,
      revAllowed: onGround, flapsDeg: s.flapsDeg, gearDown: s.gear > 0.9, fuelAvail: [true, true], tAmbC: air.T - 273.15,
    }, 1e-9);
  }
  updateOutputs(sim, F, null);
  F.snap = snapshot(ac);
  return sim;
}

// ------------------------------------------------------------ step
function snapshot(ac) {
  return { lat: ac.lat, lon: ac.lon, h: ac.h, vNED: ac.vNED.slice(), quat: ac.quat.slice(), omega: ac.omega.slice() };
}

function burnFuel(sim, dt) {
  if (sim.systems && sim.systems.fuelOwned) return;
  const fk = sim.ac.fuelKg;
  sim.engines.forEach((e, i) => {
    let burn = ((e.ff || 0) / 3600) * dt;
    const sideK = i === 0 ? 'L' : 'R';
    const fromC = Math.min(burn, Math.max(0, fk.C));
    fk.C -= fromC; burn -= fromC;
    fk[sideK] = Math.max(0, fk[sideK] - burn);
  });
}

/** Advance the flight model by dt (s). Fixed 1/120 s expected. */
export function stepPhysics(sim, dt) {
  if (!(dt > 0)) return;
  dt = Math.min(dt, 0.05);
  const F = getState(sim);
  const ac = sim.ac, s = sim.surfaces, env = sim.env;
  if (ac.crashed) { ac.vNED = [0, 0, 0]; ac.omega = [0, 0, 0]; return; }
  try {
    stepCore(sim, F, dt);
  } catch (e) {
    if (typeof console !== 'undefined') console.error('stepPhysics', e);
  }
  // NaN guard
  if (!(fin(ac.lat) && fin(ac.lon) && fin(ac.h) && finArr(ac.vNED) && finArr(ac.quat) && finArr(ac.omega) && fin(s.stab) && fin(s.elevator))) {
    const sn = F.snap;
    if (sn) Object.assign(ac, { lat: sn.lat, lon: sn.lon, h: sn.h, vNED: sn.vNED.slice(), quat: sn.quat.slice(), omega: [0, 0, 0] });
    if (!fin(s.stab)) s.stab = 0;
    if (!fin(s.elevator)) s.elevator = 0;
    F.fbw = createFbwState(); F.fbw.gB = ac.onGround ? 1 : 0;
  } else F.snap = snapshot(ac);
}

function stepCore(sim, F, dt) {
  const ac = sim.ac, s = sim.surfaces, env = sim.env, c = sim.controls;
  if (env.groundValid && fin(env.groundH)) F.lastGround = env.groundH;
  const gH = F.lastGround;
  const fuel = totalFuel(ac.fuelKg);
  const mass = (ac.zfw || MASS.OEW) + fuel;
  ac.mass = mass;
  const I = inertiaFor(mass);
  const dx = cgShift(sim);

  // --- air data
  const hMSL = ac.h - (env.geoidN || 0);
  const air = airAt(hMSL, env.tempDevC || 0, env.qnhHpa || 1013.25);
  const hCG = ac.h - gH;
  const wind = windNED(env, Math.max(hCG, 0.5));
  const tasPrev = Math.hypot(ac.vNED[0] - wind[0], ac.vNED[1] - wind[1], ac.vNED[2] - wind[2]);
  const tb = F.turb.step(env.turbulence || 0, tasPrev, Math.max(hCG, 5), dt);
  const tScale = clamp((hCG - 3) / 20, 0, 1); // no turbulence while rolling on the ground
  const vAir = [ac.vNED[0] - wind[0] - tb.u * tScale, ac.vNED[1] - wind[1] - tb.v * tScale, ac.vNED[2] - wind[2] - tb.w * tScale];
  const vb = qrotInv(ac.quat, vAir);
  const tas = Math.hypot(vb[0], vb[1], vb[2]);
  const alpha = tas > 2 ? Math.atan2(vb[2], vb[0]) : 0;
  const beta = tas > 2 ? Math.asin(clamp(vb[1] / tas, -1, 1)) : 0;
  const M = tas / air.a, qbar = 0.5 * air.rho * tas * tas;
  const cas = casFromMachP(M, air.p);
  F.alphaDot = lag(F.alphaDot, clamp((alpha - F.alphaPrev) / dt, -2, 2), 0.05, dt);
  F.alphaPrev = alpha;
  const casKt = cas / KT;
  const bands = speedBands(sim, air, mass);
  const mainWow = ac.wow.left || ac.wow.right;
  const eul = quatToEuler(ac.quat);
  const [p, q, r] = ac.omega;
  const aeroPrev = F.aero || computeAero({ alpha, beta, V: tas, mach: M, qbar, p, q, r, alphaDot: 0, elevator: 0, stab: s.stab, droll: 0, rudder: 0, flapsDeg: s.flapsDeg, slats: s.slats, gear: s.gear, sb: 0, hWing: Infinity, xcg: 0.25, engOut: 0 });

  // --- flight controls
  const x = {
    casKt, tas, mach: M, qbar, alpha, beta, nzW: F.nzW, fpa: ac.fpa || 0, roll: eul.roll, pitch: eul.pitch,
    p, q, r, vs: ac.vs || 0, ra: ac.ra || 0, mainWow, aShaker: aeroPrev.aShaker, vMinManKt: bands.vMinMan,
    Ixx: I.Ixx, Iyy: I.Iyy, Izz: I.Izz, lat: aeroPrev.lat, thrust: F.thrust, shaker: aeroPrev.shaker,
  };
  const droll = stepFBW(sim, F.fbw, x, F.gear, dt);
  stepGearActuator(sim, F.gear, mainWow, dt);
  const gs = Math.hypot(ac.vNED[0], ac.vNED[1]);
  const yawEff = sim.ap?.out?.active && Math.abs(c.yaw || 0) < 0.3 ? sim.ap.out.yaw || 0 : c.yaw || 0;
  stepBrakesAndSteering(sim, F.gear, { gs, gsKt: gs / KT, onGround: mainWow, mainWow, noseWow: ac.wow.nose, yaw: yawEff }, dt);

  // --- engines & fuel
  const eEnv = engineEnv(air, M);
  const fk = ac.fuelKg, owned = !!(sim.systems && sim.systems.fuelOwned);
  const fuelAvail = [owned ? fuel > 0 : fk.C > 0 || fk.L > 0, owned ? fuel > 0 : fk.C > 0 || fk.R > 0];
  const thrust = stepEngines(sim, F.eng, {
    env: eEnv, air, qbar, casKt, onGround: mainWow, revAllowed: mainWow || (ac.ra || 99) < 3,
    flapsDeg: s.flapsDeg, gearDown: s.gear > 0.9, fuelAvail, tAmbC: air.T - 273.15,
  }, dt);
  F.thrust = thrust;
  burnFuel(sim, dt);

  // --- aerodynamics
  const engOut = F.eng.filter((e) => !e.lit).length;
  if (!F.aero?.stalled) F.stallAsym = F.turb.rnd() < 0.5 ? -1 : 1;
  const aero = computeAero({
    alpha, beta, V: tas, mach: M, qbar, p: p - tb.p * tScale, q, r, alphaDot: F.alphaDot,
    elevator: s.elevator, stab: s.stab, droll, rudder: s.rudder, flapsDeg: s.flapsDeg, slats: s.slats,
    gear: s.gear, sb: s.speedbrake, hWing: hCG - 1.5, xcg: 0.25 + dx / GEOM.cbar, engOut, stallAsym: F.stallAsym,
  });
  F.aero = aero;
  const Fb = aero.F.slice(), Mb = aero.M.slice();
  ENGINE.pos.forEach((pe, i) => {
    const rp = [pe[0] + dx, pe[1], pe[2]];
    Fb[0] += thrust[i];
    const m = vcross(rp, [thrust[i], 0, 0]);
    Mb[0] += m[0]; Mb[1] += m[1]; Mb[2] += m[2];
  });

  // --- ground
  const gr = computeGround(sim, F.gear, { q: ac.quat, omega: ac.omega, vNED: ac.vNED, h: ac.h, groundH: gH, heading: eul.heading, dx, gearPos: s.gear, gsKt: gs / KT });
  const FgB = qrotInv(ac.quat, gr.Fned);
  for (let i = 0; i < 3; i++) { Fb[i] += FgB[i]; Mb[i] += gr.Mbody[i]; }

  // --- integrate (semi-implicit Euler)
  integrate(ac, Fb, Mb, mass, I, dt);
  F.nzW = lag(F.nzW, ((Fb[0] / mass) * Math.sin(alpha) - (Fb[2] / mass) * Math.cos(alpha)) / G0, 0.06, dt);
  ac.specificForce = [Fb[0] / mass, Fb[1] / mass, Fb[2] / mass];

  // --- outputs & contact evaluation
  const vsBefore = ac.vs;
  ac.wow = gr.wow;
  ac.onGround = gr.wow.left || gr.wow.right || gr.wow.nose;
  ac.ra = gr.ra;
  updateOutputs(sim, F, { air, tas, cas, M, alpha, beta, wind, bands, aero, hMSL });
  evaluateContacts(sim, F.gear, gr, { vsBefore, gsKt: gs / KT }, dt);
}

function integrate(ac, Fb, Mb, m, I, dt) {
  // rotational: I ω' = M - ω × Iω  (with Ixz)
  const [p, q, r] = ac.omega;
  const Iw = [I.Ixx * p - I.Ixz * r, I.Iyy * q, I.Izz * r - I.Ixz * p];
  const wxIw = vcross(ac.omega, Iw);
  const R = [Mb[0] - wxIw[0], Mb[1] - wxIw[1], Mb[2] - wxIw[2]];
  const det = I.Ixx * I.Izz - I.Ixz * I.Ixz;
  const pd = (I.Izz * R[0] + I.Ixz * R[2]) / det;
  const rd = (I.Ixz * R[0] + I.Ixx * R[2]) / det;
  const qd = R[1] / I.Iyy;
  ac.omega = [p + pd * dt, q + qd * dt, r + rd * dt];

  // translational in NED, with transport-rate (curvature) terms
  const lat = ac.lat, h = ac.h;
  const { M: Rm, N: Rn } = earthRadii(lat);
  const [vN, vE, vD] = ac.vNED;
  const tl = Math.tan(clamp(lat, -1.55, 1.55));
  const g = G0 * (6371000 / (6371000 + h)) ** 2;
  const aB = [Fb[0] / m, Fb[1] / m, Fb[2] / m];
  const a = qrot(ac.quat, aB);
  const aN = a[0] - (vE * vE * tl) / (Rn + h) + (vN * vD) / (Rm + h);
  const aE = a[1] + (vE * vN * tl) / (Rn + h) + (vE * vD) / (Rn + h);
  const aD = a[2] + g - (vE * vE) / (Rn + h) - (vN * vN) / (Rm + h);
  ac.vNED = [vN + aN * dt, vE + aE * dt, vD + aD * dt];

  // attitude relative to the local-level frame
  const wNav = [ac.vNED[1] / (Rn + h), -ac.vNED[0] / (Rm + h), (-ac.vNED[1] * tl) / (Rn + h)];
  const wNavB = qrotInv(ac.quat, wNav);
  ac.quat = qnorm(qintegrate(ac.quat, [ac.omega[0] - wNavB[0], ac.omega[1] - wNavB[1], ac.omega[2] - wNavB[2]], dt));

  // position on the ellipsoid
  ac.lat = clamp(lat + (ac.vNED[0] / (Rm + h)) * dt, -1.565, 1.565);
  let lon = ac.lon + (ac.vNED[1] / ((Rn + h) * Math.cos(ac.lat))) * dt;
  if (lon > Math.PI) lon -= 2 * Math.PI; else if (lon < -Math.PI) lon += 2 * Math.PI;
  ac.lon = lon;
  ac.h = h - ac.vNED[2] * dt;
}

function updateOutputs(sim, F, d) {
  const ac = sim.ac, env = sim.env;
  ac.euler = quatToEuler(ac.quat);
  const [vN, vE, vD] = ac.vNED;
  ac.gs = Math.hypot(vN, vE);
  ac.track = ac.gs > 0.5 ? wrap2pi(Math.atan2(vE, vN)) : ac.euler.heading;
  ac.vs = -vD;
  ac.fpa = Math.atan2(-vD, Math.max(ac.gs, 0.1));
  ac.altMSL = ac.h - (env.geoidN || 0);
  if (!d) {
    const air = airAt(ac.altMSL, env.tempDevC || 0, env.qnhHpa || 1013.25);
    const vb = qrotInv(ac.quat, ac.vNED);
    const tas = Math.hypot(...vb);
    ac.tas = tas; ac.mach = tas / air.a;
    ac.cas = casFromMachP(ac.mach, air.p); ac.eas = tas * Math.sqrt(air.rho / ISA.rho0);
    ac.alpha = tas > 2 ? Math.atan2(vb[2], vb[0]) : 0; ac.beta = 0;
    ac.nz = 1; ac.specificForce = [0, 0, -G0];
    ac.satC = air.T - 273.15; ac.tatC = air.T * (1 + 0.2 * ac.mach ** 2) - 273.15;
    const b = speedBands(sim, air, ac.mass);
    Object.assign(ac, { vs1gKt: b.vs, vShakerKt: b.vShaker, vMinManKt: b.vMinMan, vMaxKt: b.vmax });
    ac.stallWarning = false; ac.buffet = 0;
    return;
  }
  ac.tas = d.tas; ac.mach = d.M; ac.cas = d.cas; ac.eas = d.tas * Math.sqrt(d.air.rho / ISA.rho0);
  ac.alpha = d.alpha; ac.beta = d.beta;
  ac.nz = -ac.specificForce[2] / G0;
  ac.satC = d.air.T - 273.15;
  ac.tatC = d.air.T * (1 + 0.2 * d.M * d.M) - 273.15;
  ac.pressureAltM = d.air.hp;
  ac.windNED = d.wind;
  ac.vs1gKt = d.bands.vs; ac.vShakerKt = d.bands.vShaker; ac.vMinManKt = d.bands.vMinMan; ac.vMaxKt = d.bands.vmax;
  ac.stallWarning = !ac.onGround && d.aero.shaker;
  ac.stalled = !ac.onGround && d.aero.stalled;
  ac.buffet = ac.onGround ? 0 : d.aero.buffet;
  ac.CL = d.aero.CL; ac.CD = d.aero.CD;
}

/** Debug/test access to the internal FDM state. */
export function _fdmState(sim) { return STORE.get(sim); }
export { FPM, FT };
