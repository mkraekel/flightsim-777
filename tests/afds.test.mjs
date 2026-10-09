// AFDS / FMC / NAV closed-loop tests with a stub point-mass + attitude model.
// Run: node tests/afds.test.mjs   (exits 0 on success)
//
// The stub mimics the contract's FBW interface: column = C* demand (full ≈ 1.5 g C*),
// wheel = roll-rate demand (full = 15°/s, bank held at neutral), engines lag the levers,
// and the A/T lever back-drive is limited to 0.25/s like Team D2's input module.

import { createSimState } from '../src/core/state.js';
import { DEG, RAD, KT, FT, NM, G0, FPM, clamp, wrapPi, wrap2pi, destination, distance, bearing } from '../src/core/geo.js';
import { initAFDS, stepAFDS, afdsAction } from '../src/systems/afds.js';
import { initFMC, stepFMC, buildDefaultRoute, computeVSpeeds, vrefKt, parseLatLon, fmtLatLon, flapManeuverKt } from '../src/systems/fmc.js';
import { stepNav } from '../src/systems/navradio.js';

// ------------------------------------------------------------------ tiny test runner
let failed = 0, passed = 0;
function check(name, cond, info = '') {
  if (cond) { passed++; console.log(`  ok   ${name}${info ? '  (' + info + ')' : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${info ? '  (' + info + ')' : ''}`); }
}
const f1 = (v) => (Math.round(v * 10) / 10).toString();

// ------------------------------------------------------------------ stub aircraft
function isa(h) {
  const T = h < 11000 ? 288.15 - 0.0065 * h : 216.65;
  const p = h < 11000 ? 101325 * Math.pow(T / 288.15, 5.25588) : 22632 * Math.exp(-G0 * (h - 11000) / (287.053 * 216.65));
  return { T, p, rho: p / (287.053 * T), a: Math.sqrt(1.4 * 287.053 * T) };
}
const S = 436.8;
function makeAircraft(o) {
  return {
    lat: (o.lat ?? 50) * DEG, lon: (o.lon ?? 8) * DEG, h: o.altFt * FT, V: o.tasKt * KT,
    gam: (o.vsFpm ?? 0) * FPM / (o.tasKt * KT), theta: 0, q: 0, phi: (o.bank ?? 0) * DEG, p: 0,
    psi: (o.hdg ?? 0) * DEG, n: o.thrust ?? 0.5, mass: o.mass ?? 280000, flaps: o.flaps ?? 0,
    gearDown: o.flaps >= 20, elev: (o.elevFt ?? 0) * FT, windN: o.windN ?? 0, windE: o.windE ?? 0,
    onGround: false, touchdownVs: null,
  };
}
const CL0 = { 0: 0.2, 1: 0.25, 5: 0.45, 15: 0.68, 20: 0.78, 25: 1.0, 30: 1.1 };
const DCD = { 0: 0, 1: 0.004, 5: 0.01, 15: 0.02, 20: 0.027, 25: 0.045, 30: 0.06 };

/** Trim alpha so the stub starts in equilibrium. */
function trim(a) {
  const { rho } = isa(a.h);
  const qbar = 0.5 * rho * a.V * a.V;
  const cl = a.mass * G0 * Math.cos(a.gam) / (qbar * S) / Math.cos(a.phi);
  const alpha = (cl - CL0[a.flaps]) / 5.6;
  a.theta = a.gam + alpha;
  const cd = 0.0165 + DCD[a.flaps] + (a.gearDown ? 0.018 : 0) + 0.0404 * (cl - 0.1) ** 2;
  const T = qbar * S * cd + a.mass * G0 * Math.sin(a.gam);
  a.n = clamp(T / thrustMax(a), 0, 1);
}
const thrustMax = (a) => 2 * 513000 * Math.pow(isa(a.h).rho / 1.225, 0.8) * (1 - 0.25 * Math.min(a.V / isa(a.h).a, 0.9));

function stepAircraft(sim, a, dt) {
  const c = sim.ap.out.active ? sim.ap.out : { pitch: 0, roll: 0, yaw: 0 };
  // levers: A/T back-drive at 0.25/s
  for (let i = 0; i < 2; i++) {
    if (sim.ap.thrustCmd !== null) {
      const d = sim.ap.thrustCmd - sim.controls.throttle[i];
      sim.controls.throttle[i] += clamp(d, -0.25 * dt, 0.25 * dt);
    }
  }
  const lever = (sim.controls.throttle[0] + sim.controls.throttle[1]) / 2;
  a.n += (lever - a.n) * (1 - Math.exp(-dt / 2.5));
  const { rho, a: sos } = isa(a.h);
  const qbar = 0.5 * rho * a.V * a.V;
  // FBW: rate command
  const qCmd = c.pitch * 1.5 * G0 / (a.V + 120);
  a.q += (qCmd - a.q) * (1 - Math.exp(-dt / 0.6));
  const pCmd = c.roll * 15 * DEG;
  a.p += (pCmd - a.p) * (1 - Math.exp(-dt / 0.3));
  if (!a.onGround) {
    a.theta += a.q * dt;
    a.phi += a.p * dt;
    const alpha = a.theta - a.gam;
    const cl = CL0[a.flaps] + 5.6 * alpha;
    const L = qbar * S * cl, nz = L / (a.mass * G0);
    const cd = 0.0165 + DCD[a.flaps] + (a.gearDown ? 0.018 : 0) + 0.0404 * (cl - 0.1) ** 2 + 0.02 * sim.controls.speedbrakeLever;
    const D = qbar * S * cd, T = a.n * thrustMax(a);
    a.V += ((T - D) / a.mass - G0 * Math.sin(a.gam)) * dt;
    a.gam += (G0 / a.V) * (nz * Math.cos(a.phi) - Math.cos(a.gam)) * dt;
    a.psi = wrap2pi(a.psi + (G0 * nz * Math.sin(a.phi)) / (a.V * Math.cos(a.gam)) * dt);
    sim.ac.nz = nz; sim.ac.alpha = alpha;
  } else {
    // simple ground roll: decelerate, steer with pedal
    a.V = Math.max(0, a.V - 2.0 * dt); a.gam = 0; a.phi = 0; a.p = 0;
    a.theta = Math.max(0, a.theta - 2 * DEG * dt);
    a.psi = wrap2pi(a.psi + c.yaw * 7 * DEG * a.V / 30 * dt);
  }
  const wN = a.onGround ? 0 : a.windN, wE = a.onGround ? 0 : a.windE; // tyres stop the drift on the ground
  const vn = a.V * Math.cos(a.gam) * Math.cos(a.psi) + wN, ve = a.V * Math.cos(a.gam) * Math.sin(a.psi) + wE;
  const gs = Math.hypot(vn, ve);
  const p2 = destination(a.lat, a.lon, Math.atan2(ve, vn), gs * dt);
  a.lat = p2.lat; a.lon = p2.lon;
  a.h += a.V * Math.sin(a.gam) * dt;
  if (!a.onGround && a.h <= a.elev && a.flaps >= 20) {
    a.onGround = true; a.touchdownVs = a.V * Math.sin(a.gam) / FPM; a.h = a.elev;
  }
  // publish sensors
  const ac = sim.ac;
  Object.assign(ac, {
    lat: a.lat, lon: a.lon, h: a.h, altMSL: a.h, tas: a.V, cas: a.V * Math.sqrt(rho / 1.225), mach: a.V / sos,
    vs: a.V * Math.sin(a.gam), fpa: a.gam, gs, track: wrap2pi(Math.atan2(ve, vn)), ra: Math.max(0, a.h - a.elev),
    onGround: a.onGround, mass: a.mass,
  });
  ac.euler = { roll: a.phi, pitch: a.theta, heading: a.psi };
  ac.omega = [a.p, a.q, 0];
  ac.wow = { nose: a.onGround && a.theta < 0.5 * DEG, left: a.onGround, right: a.onGround };
  sim.surfaces.flapsDeg = a.flaps;
}

function setup(o) {
  const sim = createSimState();
  sim.time = 0;
  const a = makeAircraft(o);
  trim(a);
  sim.controls.throttle = [a.n, a.n];
  sim.engines.forEach((e) => { e.running = true; });
  stepAircraft(sim, a, 0.0001);
  initFMC(sim); initAFDS(sim);
  return { sim, a };
}

/** Run with physics at 120 Hz and AFDS at the frame rate dtFrame (sample & hold). */
function run(sim, a, seconds, dtFrame = 1 / 30, probe = null) {
  const steps = Math.round(seconds / dtFrame);
  for (let i = 0; i < steps; i++) {
    stepNav(sim, dtFrame); stepFMC(sim, dtFrame); stepAFDS(sim, dtFrame);
    const n = Math.max(1, Math.round(dtFrame * 120));
    for (let k = 0; k < n; k++) stepAircraft(sim, a, dtFrame / n);
    sim.time += dtFrame;
    if (probe) probe(sim, a, sim.time);
  }
}
const altFt = (a) => a.h / FT;
const casKt = (sim) => sim.ac.cas / KT;
const engageAP = (sim) => { afdsAction(sim, 'AP_ENGAGE'); };

// ================================================================== tests
console.log('FMC performance');
{
  const v = computeVSpeeds(300000, 15);
  check('V2 at 300 t F15 ≈ 164 kt', Math.abs(v.v2 - 164) <= 2, `V1 ${v.v1} VR ${v.vr} V2 ${v.v2}`);
  check('VREF30 at 251 t ≈ 150 kt', Math.abs(vrefKt(251000, 30) - 150) <= 2, f1(vrefKt(251000, 30)));
  const ll = parseLatLon('N5003.0E00834.0');
  check('lat/lon entry parse', ll && Math.abs(ll.lat * RAD - 50.05) < 1e-6 && fmtLatLon(ll.lat, ll.lon) === 'N5003.0E00834.0');
}

console.log('ALT hold');
{
  const { sim, a } = setup({ altFt: 10200, tasKt: 300, hdg: 90, vsFpm: 600 });
  sim.ap.sel.altFt = 10000; sim.ap.sel.spdKt = Math.round(casKt(sim));
  engageAP(sim); afdsAction(sim, 'ALT_HOLD'); sim.ap.holdAltFt = 10000; afdsAction(sim, 'AT');
  let maxErrLate = 0, vsSign = 0, flips = 0, lastFlipT = 0;
  run(sim, a, 150, 1 / 30, (s, ac, t) => {
    if (t > 60) maxErrLate = Math.max(maxErrLate, Math.abs(altFt(ac) - 10000));
    const sg = Math.sign(Math.round(s.ac.vs / FPM / 50));
    if (sg && sg !== vsSign) { if (vsSign) { flips++; lastFlipT = t; } vsSign = sg; }
  });
  check('pitch mode ALT', sim.ap.modes.pitch === 'ALT' && sim.ap.modes.ap === 'A/P');
  check('holds within 20 ft after 60 s', maxErrLate < 20, `max err ${f1(maxErrLate)} ft`);
  check('no sustained oscillation', flips <= 3 || lastFlipT < 60, `${flips} V/S reversals`);
  check('AP outputs within authority', Math.abs(sim.ap.out.pitch) < 0.6);
}

console.log('HDG SEL turn');
for (const dtF of [1 / 30, 0.1]) {
  const { sim, a } = setup({ altFt: 12000, tasKt: 320, hdg: 0 });
  sim.ap.sel.altFt = 12000; sim.ap.sel.spdKt = Math.round(casKt(sim));
  engageAP(sim); afdsAction(sim, 'ALT_HOLD'); afdsAction(sim, 'AT');
  afdsAction(sim, 'HDG_SET', 90); afdsAction(sim, 'HDG_SEL');
  let maxBank = 0, maxHdg = 0, altDev = 0;
  run(sim, a, 120, dtF, (s, ac) => {
    maxBank = Math.max(maxBank, Math.abs(ac.phi * RAD));
    maxHdg = Math.max(maxHdg, wrapPi(ac.psi) * RAD);
    altDev = Math.max(altDev, Math.abs(altFt(ac) - 12000));
  });
  const fin = wrapPi(a.psi - 90 * DEG) * RAD;
  check(`turn to 090 (frame dt ${f1(dtF * 1000)} ms)`, Math.abs(fin) < 1, `final err ${f1(fin)}°`);
  check('  overshoot < 3°', maxHdg - 90 < 3, `max hdg ${f1(maxHdg)}`);
  check('  bank ≤ auto limit 25° (+1° overshoot)', maxBank < 26, `max bank ${f1(maxBank)}°`);
  check('  altitude kept in turn ±60 ft', altDev < 60, `${f1(altDev)} ft`);
}

console.log('V/S and ALT capture');
{
  const { sim, a } = setup({ altFt: 10000, tasKt: 330, hdg: 0 });
  sim.ap.sel.altFt = 14000; sim.ap.sel.spdKt = Math.round(casKt(sim));
  engageAP(sim); afdsAction(sim, 'AT');
  afdsAction(sim, 'VS'); afdsAction(sim, 'VS_SET', 1500);
  let vsAt = null, maxAlt = 0, minSpd = 999, maxSpd = 0;
  run(sim, a, 200, 1 / 30, (s, ac, t) => {
    if (Math.abs(t - 60) < 0.02) vsAt = s.ac.vs / FPM;
    maxAlt = Math.max(maxAlt, altFt(ac));
    if (t > 20) { minSpd = Math.min(minSpd, casKt(s)); maxSpd = Math.max(maxSpd, casKt(s)); }
  });
  check('V/S tracks 1500 fpm', Math.abs(vsAt - 1500) < 100, `${f1(vsAt)} fpm at t=60`);
  check('captured ALT 14000', sim.ap.modes.pitch === 'ALT' && Math.abs(altFt(a) - 14000) < 20, `${sim.ap.modes.pitch} ${f1(altFt(a))}`);
  check('capture overshoot < 60 ft', maxAlt - 14000 < 60, `${f1(maxAlt - 14000)} ft`);
  check('A/T SPD holds speed ±6 kt', maxSpd - sim.ap.sel.spdKt < 6 && sim.ap.sel.spdKt - minSpd < 6, `${f1(minSpd)}..${f1(maxSpd)} kt`);
}

console.log('FLCH climb / descent');
{
  const { sim, a } = setup({ altFt: 8000, tasKt: 290, hdg: 0 });
  sim.ap.sel.spdKt = 280; sim.ap.sel.altFt = 18000;
  engageAP(sim); afdsAction(sim, 'FLCH');
  check('FLCH engages A/T THR', sim.ap.modes.pitch === 'FLCH SPD' && sim.ap.modes.at === 'THR', sim.ap.modes.at);
  let spdErr = 0, maxAlt = 0;
  run(sim, a, 600, 1 / 30, (s, ac, t) => {
    if (t > 40 && s.ap.modes.pitch === 'FLCH SPD') spdErr = Math.max(spdErr, Math.abs(casKt(s) - 280));
    maxAlt = Math.max(maxAlt, altFt(ac));
  });
  check('climb speed held ±5 kt', spdErr < 5, `max err ${f1(spdErr)} kt`);
  check('levels at 18000 (ALT, A/T SPD)', sim.ap.modes.pitch === 'ALT' && sim.ap.modes.at === 'SPD' && Math.abs(altFt(a) - 18000) < 30, `${f1(altFt(a))} ft ${sim.ap.modes.at}`);
  check('no overshoot > 100 ft', maxAlt - 18000 < 100, f1(maxAlt - 18000));
  // descent
  sim.ap.sel.altFt = 9000; afdsAction(sim, 'FLCH');
  let sawHold = false; spdErr = 0;
  run(sim, a, 500, 1 / 30, (s, ac, t) => {
    if (s.ap.modes.at === 'HOLD') sawHold = true;
    if (s.ap.modes.pitch === 'FLCH SPD' && s.time > 0) spdErr = Math.max(spdErr, Math.abs(casKt(s) - 280));
  });
  check('FLCH descent IDLE -> HOLD', sawHold);
  check('descent speed held ±8 kt', spdErr < 8, f1(spdErr));
  check('levels at 9000', sim.ap.modes.pitch === 'ALT' && Math.abs(altFt(a) - 9000) < 30, f1(altFt(a)));
}

console.log('A/T speed change');
{
  const { sim, a } = setup({ altFt: 10000, tasKt: 290, hdg: 0 });
  sim.ap.sel.altFt = 10000;
  engageAP(sim); afdsAction(sim, 'ALT_HOLD'); afdsAction(sim, 'AT');
  afdsAction(sim, 'SPD_SET', 250);
  run(sim, a, 30);
  afdsAction(sim, 'SPD_SET', 300);
  let maxSpd = 0, t300 = null;
  run(sim, a, 150, 1 / 30, (s, ac, t) => { maxSpd = Math.max(maxSpd, casKt(s)); if (t300 === null && casKt(s) > 298) t300 = t; });
  check('accelerates to 300 kt', Math.abs(casKt(sim) - 300) < 2, f1(casKt(sim)));
  check('overshoot < 4 kt', maxSpd - 300 < 4, f1(maxSpd - 300));
  check('A/T mode SPD', sim.ap.modes.at === 'SPD');
}

console.log('ILS approach: LOC/GS capture, autoland');
{
  // Fake destination: runway 25 at 50°N 8°E, heading 250°, elevation 300 ft, 15 kt crosswind.
  const thr = { lat: 50, lon: 8 };
  const dest = { icao: 'TEST', elevFt: 300, magVarDeg: 0, lat: 50, lon: 8, runways: [
    { id: '25', lat: thr.lat, lon: thr.lon, hdgDeg: 250, lengthM: 3500, elevFt: 300, ils: { freq: 110.1, ident: 'ITST', gsDeg: 3 } }] };
  const crs = 250 * DEG;
  // start 16 nm out on the extended centreline, 2 nm left (south), heading 280 (30° intercept)
  const onCl = destination(thr.lat * DEG, thr.lon * DEG, crs + Math.PI, 16 * NM);
  const st = destination(onCl.lat, onCl.lon, crs + Math.PI / 2, -2 * NM);
  const { sim, a } = setup({ lat: st.lat * RAD, lon: st.lon * RAD, altFt: 3000, tasKt: 160, hdg: 280, flaps: 30, mass: 230000, elevFt: 300, windN: 0, windE: 0 });
  // crosswind from the left (from 160°): wind vector toward 340°
  a.windN = 15 * KT * Math.cos(340 * DEG); a.windE = 15 * KT * Math.sin(340 * DEG);
  sim.fmc.dest = dest; sim.fmc.arrRwy = dest.runways[0]; sim.fmc.wasAirborne = true;
  sim.ap.sel.altFt = 3000; sim.ap.sel.spdKt = Math.round(vrefKt(230000, 30) + 5);
  engageAP(sim); afdsAction(sim, 'ALT_HOLD'); afdsAction(sim, 'AT');
  afdsAction(sim, 'HDG_SET', 280); afdsAction(sim, 'HDG_SEL');
  afdsAction(sim, 'APP');
  stepNav(sim, 0.01);
  check('sign convention: left of course -> locDots < 0, below G/S -> gsDots < 0 (Team C)',
    sim.nav.ils.locDots < -1 && sim.nav.ils.gsDots < -1 && sim.nav.ils.locDevM < 0, `${f1(sim.nav.ils.locDots)} / ${f1(sim.nav.ils.gsDots)}`);
  let tLoc = null, tGs = null, land3 = false, flare = false, idle = false, rollout = false;
  let maxLocAfter = 0, maxGsAfter = 0, locOvershootDots = 0, side0 = null;
  run(sim, a, 700, 1 / 30, (s, ac, t) => {
    const m = s.ap.modes, ils = s.nav.ils;
    if (tLoc === null && m.roll === 'LOC') { tLoc = t; side0 = Math.sign(ils.locDots); }
    if (tLoc !== null && side0 && !ac.onGround && Math.sign(ils.locDots) === -side0) locOvershootDots = Math.max(locOvershootDots, Math.abs(ils.locDots));
    if (tGs === null && m.pitch === 'G/S') tGs = t;
    if (tLoc !== null && t > tLoc + 60 && !ac.onGround && ac.h - ac.elev > 200 * FT) maxLocAfter = Math.max(maxLocAfter, Math.abs(ils.locDots));
    if (tGs !== null && t > tGs + 30 && !ac.onGround && ac.h - ac.elev > 200 * FT) maxGsAfter = Math.max(maxGsAfter, Math.abs(ils.gsDots));
    if (s.ap.modes.ap === 'LAND 3') land3 = true;
    if (m.pitch === 'FLARE') flare = true;
    if (m.pitch === 'FLARE' && m.at === 'IDLE') idle = true;
    if (m.roll === 'ROLLOUT') rollout = true;
    // the pilot's job: nothing (autoland)
  });
  check('LOC captured', tLoc !== null, `t=${f1(tLoc)} s`);
  check('LOC overshoot < 0.3 dot', locOvershootDots < 0.3, f1(locOvershootDots));
  check('LOC tracking < 0.1 dot', maxLocAfter < 0.1, f1(maxLocAfter));
  check('G/S captured after LOC', tGs !== null && tGs > tLoc, `t=${f1(tGs)} s`);
  check('G/S tracking < 0.25 dot', maxGsAfter < 0.25, f1(maxGsAfter));
  check('LAND 3 annunciated', land3);
  check('FLARE at ~50 ft, A/T IDLE', flare && idle);
  check('touchdown sink rate < 360 fpm', a.touchdownVs !== null && a.touchdownVs > -360, `${f1(a.touchdownVs)} fpm`);
  check('ROLLOUT engaged', rollout);
  const yOff = Math.abs(sim.nav.ils.locDevM);
  check('on centreline after rollout (< 5 m)', yOff < 5, `${f1(yOff)} m`);
}

console.log('FMC route / LNAV');
{
  const origin = { icao: 'ORIG', elevFt: 300, magVarDeg: 0, lat: 50, lon: 8, runways: [
    { id: '07', lat: 50, lon: 8, hdgDeg: 70, lengthM: 3500, elevFt: 300 }] };
  const dest = { icao: 'DEST', elevFt: 100, magVarDeg: 0, lat: 52, lon: 13, runways: [
    { id: '25', lat: 52, lon: 13, hdgDeg: 250, lengthM: 3500, elevFt: 100 }] };
  const { sim, a } = setup({ lat: 50.05, lon: 8.3, altFt: 6000, tasKt: 280, hdg: 20 });
  buildDefaultRoute(sim, origin, dest);
  const r = sim.fmc.route;
  check('default route RW07 -> DP07 -> ... -> CI25 FF25 RW25', r[0].ident === 'RW07' && r[1].ident === 'DP07' && r[r.length - 1].ident === 'RW25' && r[r.length - 2].ident === 'FF25' && r.length >= 6,
    r.map((w) => w.ident).join(' '));
  check('FAF at field +3000 ft', r[r.length - 2].altFt === 3100);
  sim.ap.sel.altFt = 6000; sim.ap.sel.spdKt = Math.round(casKt(sim));
  engageAP(sim); afdsAction(sim, 'ALT_HOLD'); afdsAction(sim, 'AT');
  afdsAction(sim, 'LNAV');
  const armed = sim.ap.modes.armedRoll === 'LNAV' || sim.ap.modes.roll === 'LNAV';
  check('LNAV armed/engaged', armed, sim.ap.modes.roll + '/' + sim.ap.modes.armedRoll);
  let startLeg = sim.fmc.activeLeg, maxXtkLate = 0;
  run(sim, a, 1500, 1 / 20, (s, ac, t) => { if (t > 400 && s.ap.modes.roll === 'LNAV') maxXtkLate = Math.max(maxXtkLate, Math.abs(s.fmc.xtkM)); });
  check('LNAV engaged', sim.ap.modes.roll === 'LNAV');
  check('legs sequenced', sim.fmc.activeLeg > startLeg + 1, `leg ${startLeg} -> ${sim.fmc.activeLeg}`);
  check('cross-track after intercept < 0.3 nm', maxXtkLate < 0.3 * NM, `${f1(maxXtkLate / NM)} nm`);
  check('T/D computed', Number.isFinite(sim.fmc.todNm), f1(sim.fmc.todNm));
}

console.log('Disconnects & interlocks');
{
  const { sim, a } = setup({ altFt: 10000, tasKt: 280, hdg: 0 });
  const aurals = [];
  sim.events.on('aural', (e) => aurals.push(e.id));
  sim.ac.onGround = true; afdsAction(sim, 'AP_ENGAGE');
  check('AP cannot engage on ground', !sim.ap.apEngaged);
  sim.ac.onGround = false; engageAP(sim);
  check('AP engages in flight with HDG HOLD / V/S', sim.ap.apEngaged && sim.ap.modes.roll === 'HDG HOLD' && sim.ap.modes.pitch === 'V/S');
  sim.controls.apDisc = true; run(sim, a, 0.1);
  check('apDisc disconnects + ap_disc aural + warning', !sim.ap.apEngaged && aurals.includes('ap_disc') && sim.ap.discWarning && !sim.controls.apDisc);
  sim.controls.apDisc = true; run(sim, a, 0.1);
  check('second press silences warning', !sim.ap.discWarning);
  afdsAction(sim, 'AT'); sim.controls.atDisc = true; run(sim, a, 0.1);
  check('A/T disconnect + at_disc aural', !sim.ap.atEngaged && aurals.includes('at_disc') && sim.ap.thrustCmd === null);
  afdsAction(sim, 'VNAV');
  check('VNAV refused without route', !sim.ap.modes.pitch.startsWith('VNAV'));
  // NaN robustness
  sim.ac.cas = NaN; sim.ac.euler = { roll: NaN, pitch: undefined, heading: 0 };
  let threw = false; try { stepAFDS(sim, 1 / 30); stepFMC(sim, 1 / 30); stepNav(sim, 1 / 30); } catch { threw = true; }
  check('no throw on NaN state', !threw);
}

console.log('Takeoff: TO/GA, HOLD at 80 kt, VNAV/LNAV arm');
{
  const origin = { icao: 'ORIG', elevFt: 300, magVarDeg: 0, lat: 50, lon: 8, runways: [
    { id: '07', lat: 50, lon: 8, hdgDeg: 70, lengthM: 3500, elevFt: 300 }] };
  const dest = { icao: 'DEST', elevFt: 100, magVarDeg: 0, lat: 52, lon: 13, runways: [
    { id: '25', lat: 52, lon: 13, hdgDeg: 250, lengthM: 3500, elevFt: 100 }] };
  const sim = createSimState(); initFMC(sim); initAFDS(sim);
  sim.ac.onGround = true; sim.ac.lat = 50 * DEG; sim.ac.lon = 8 * DEG; sim.ac.altMSL = 300 * FT; sim.ac.mass = 300000;
  sim.events.emit('spawned', { airport: origin, runway: origin.runways[0] });
  sim.fmc.dest = dest; buildDefaultRoute(sim, origin, dest);
  stepAFDS(sim, 0.05);
  check('FD on ground shows TO/GA | TO/GA', sim.ap.modes.roll === 'TO/GA' && sim.ap.modes.pitch === 'TO/GA' && sim.ap.modes.ap === 'FLT DIR');
  check('MCP speed preset to V2', sim.ap.sel.spdKt === sim.fmc.v2 && sim.fmc.v2 > 140, String(sim.ap.sel.spdKt));
  afdsAction(sim, 'LNAV'); afdsAction(sim, 'VNAV');
  check('LNAV/VNAV armed on ground', sim.ap.modes.armedRoll === 'LNAV' && sim.ap.modes.armedPitch === 'VNAV');
  sim.controls.toga = true; stepAFDS(sim, 0.05);
  check('TO/GA -> THR REF', sim.ap.modes.at === 'THR REF' && sim.ap.thrustCmd > 0.9);
  sim.ac.cas = 85 * KT; sim.ac.gs = 85 * KT; stepAFDS(sim, 0.05);
  check('HOLD at 80 kt', sim.ap.modes.at === 'HOLD' && sim.ap.thrustCmd === null);
}

console.log('Full flight: VNAV climb -> cruise -> T/D descent -> ILS autoland');
{
  const origin = { icao: 'ORIG', elevFt: 300, magVarDeg: 0, lat: 50, lon: 8, runways: [
    { id: '07', lat: 50, lon: 8, hdgDeg: 70, lengthM: 3500, elevFt: 300 }] };
  const dest = { icao: 'DEST', elevFt: 100, magVarDeg: 0, lat: 52, lon: 13, runways: [
    { id: '25', lat: 52, lon: 13, hdgDeg: 250, lengthM: 3500, elevFt: 100 }] };
  // just after lift-off: 1300 ft, flaps 15, TO/GA with LNAV/VNAV armed
  const { sim, a } = setup({ lat: 50.01, lon: 8.03, altFt: 1300, tasKt: 175, hdg: 70, flaps: 15, vsFpm: 1500, mass: 260000, elevFt: 100 });
  sim.fmc.origin = origin; sim.fmc.depRwy = origin.runways[0];
  buildDefaultRoute(sim, origin, dest); sim.fmc.crzAltFt = 24000; sim.fmc.wasAirborne = true; sim.fmc.phase = 'TAKEOFF';
  sim.ap.sel.altFt = 24000; sim.ap.sel.spdKt = sim.fmc.v2;
  sim.ap.modes.roll = 'TO/GA'; sim.ap.modes.pitch = 'TO/GA'; sim.ap._.togaTrack = 70 * DEG; sim.ap._.casLiftoff = 170;
  sim.ap.atEngaged = true; sim.ap.modes.at = 'HOLD';
  afdsAction(sim, 'LNAV'); afdsAction(sim, 'VNAV'); engageAP(sim);
  const seen = new Set();
  const det = [0, 1, 5, 15, 20, 25, 30];
  let maxCrzDev = 0, appArmed = false, tCrz = null, last = '';
  const log = [];
  run(sim, a, 3200, 1 / 20, (s, ac, t) => {
    if (s.fmc.phase === 'CRUISE' && tCrz === null) tCrz = t;
    const st = [s.fmc.phase, s.ap.modes.at, s.ap.modes.roll, s.ap.modes.pitch, s.ap.modes.armedRoll, s.ap.modes.armedPitch, 'L' + s.fmc.activeLeg].join('|');
    if (st !== last) { last = st; log.push(`${t.toFixed(0)} ${st} alt ${altFt(ac).toFixed(0)} cas ${casKt(s).toFixed(0)} tgt ${s.ap.tgtSpdKt.toFixed(0)} vs ${(s.ac.vs / FPM).toFixed(0)} path ${s.fmc.pathAltFt?.toFixed(0)} fl ${ac.flaps}`); }
    const m = s.ap.modes, cas = casKt(s), i = det.indexOf(ac.flaps);
    seen.add(s.fmc.phase + ':' + m.pitch);
    // scripted pilot: flaps on schedule, MCP altitude for descent, APP on approach
    if (s.fmc.phase === 'CLIMB' && ac.flaps > 0 && cas > flapManeuverKt(ac.mass, det[i - 1])) ac.flaps = det[i - 1];
    if (s.fmc.phase === 'CRUISE' && s.fmc.todNm < 10) afdsAction(s, 'ALT_SET', 3000);
    // speedbrake when the FMC asks for drag / the aircraft is high on the path
    const high = s.fmc.pathAltFt !== null && altFt(ac) > s.fmc.pathAltFt + 400 && s.fmc.phase !== 'CRUISE';
    s.controls.speedbrakeLever = (s.fmc.msg === 'DRAG REQUIRED' || high) && s.ap.modes.pitch !== 'G/S' ? 1 : 0;
    if (s.fmc.phase === 'CRUISE' && m.pitch === 'VNAV PTH' && s.fmc.todNm > 2 && t > tCrz + 60) maxCrzDev = Math.max(maxCrzDev, Math.abs(altFt(ac) - 24000));
    if (s.fmc.phase === 'APPROACH') {
      if (!appArmed) { appArmed = true; afdsAction(s, 'APP'); }
      if (ac.flaps < 20 && cas < s.ap.tgtSpdKt + 3 && i < 4) ac.flaps = det[i + 1];
      if (m.pitch === 'G/S' && ac.flaps < 30) { ac.flaps = 30; ac.gearDown = true; }
    }
  });
  check('VNAV SPD climb with THR REF', seen.has('CLIMB:VNAV SPD'));
  check('VNAV PTH level at cruise (±30 ft)', seen.has('CRUISE:VNAV PTH') && maxCrzDev < 30, f1(maxCrzDev));
  check('VNAV PTH descent after T/D', seen.has('DESCENT:VNAV PTH'));
  check('approach -> G/S -> FLARE', seen.has('APPROACH:G/S') && seen.has('APPROACH:FLARE'));
  check('landed on centreline with autoland', a.onGround && a.touchdownVs > -400 && Math.abs(sim.nav.ils.locDevM) < 8 && sim.ap.modes.roll === 'ROLLOUT',
    `td ${f1(a.touchdownVs)} fpm, y ${f1(sim.nav.ils.locDevM)} m`);
  if (failed || process.env.VERBOSE) console.log(log.join('\n'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
