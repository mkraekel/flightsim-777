// Physics acceptance tests for the 777-300ER FDM (Team A).
// Run: node tests/physics.test.mjs  -> prints a numeric report, exits 0 on pass.

import { createSimState } from '../src/core/state.js';
import { DEG, KT, FT, FPM, NM, wrapPi, distance } from '../src/core/geo.js';
import { initAircraft, stepPhysics, solveTrim, _fdmState } from '../src/physics/fdm.js';
import { isa, casFromTas, tasFromCas, machFromTas, pressureAltitude, ISA } from '../src/physics/atmosphere.js';
import { engineEnv, n1ForThrust, n1ToLever, thrustAtN1, leverToN1 } from '../src/physics/engines.js';
import { MASS } from '../src/physics/aircraft777.js';

const DT = 1 / 120;
const results = [];
let failures = 0;
function check(name, value, lo, hi, unit = '') {
  const ok = Number.isFinite(value) && value >= lo && value <= hi;
  if (!ok) failures++;
  results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${Number.isFinite(value) ? value.toFixed(2) : value} ${unit}  [${lo} .. ${hi}]`);
  return ok;
}
const section = (t) => results.push(`\n${t}`);
const info = (t) => results.push(`        ${t}`);

/** New sim with mass split into payload/fuel. */
function mkSim({ massKg, fuelKg = 60000, flap = 0, gear = 'DOWN', onGround = true, speedKt = 0, altFt = 0, hdg = 0 }) {
  const sim = createSimState();
  sim.env.groundH = 0; sim.env.groundValid = true;
  sim.controls.flapLever = flap;
  sim.controls.gearLever = gear;
  sim.controls.parkingBrake = false;
  const payload = massKg - MASS.OEW - fuelKg;
  initAircraft(sim, { lat: 50 * DEG, lon: 8 * DEG, h: onGround ? 0 : altFt * FT, heading: hdg, onGround, speedKt, fuelKg, payloadKg: payload });
  return sim;
}
function run(sim, seconds, fn) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (fn && fn(sim, i * DT) === false) return i * DT;
    stepPhysics(sim, DT);
    sim.time += DT;
  }
  return seconds;
}
const kt = (v) => v / KT;
const deg = (v) => v / DEG;
const altFt = (sim) => sim.ac.altMSL / FT;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Simple pilot: column for a target flight-path angle (rad) using C*U law. */
function fpaPilot(sim, fpaT, st) {
  const e = fpaT - sim.ac.fpa;
  st.i = clamp((st.i || 0) + e * DT * 1.5, -0.5, 0.5);
  return clamp(6 * e + st.i, -1, 1);
}
/** Simple autothrottle used by the test pilot. */
function speedPilot(sim, casKt, st) {
  const e = casKt - kt(sim.ac.cas);
  st.ti = clamp((st.ti ?? 0.4) + e * DT * 0.02, 0, 1);
  const lv = clamp(st.ti + 0.04 * e, 0, 1);
  sim.controls.throttle = [lv, lv];
}

// --------------------------------------------------------------- 0 atmosphere
section('0) Atmosphere / air data');
{
  const a = isa(11000);
  check('ISA T at 11 km geometric (K)', a.T, 216.6, 216.9);
  check('ISA p at 11 km (Pa)', a.p, 22600, 22700);
  const tas = tasFromCas(310 * KT, 31560 * FT);
  check('M at 310 KCAS / FL315.6 (crossover)', machFromTas(tas, 31560 * FT), 0.835, 0.845);
  check('pressure alt @ MSL, QNH 1000 hPa (ft)', pressureAltitude(0, 1000) / FT, 340, 375);
}

// --------------------------------------------------------------- 1 takeoff
section('1) Takeoff 300 t, flaps 15, TO thrust, VR 160 KCAS');
{
  const sim = mkSim({ massKg: 300000, fuelKg: 90000, flap: 3 });
  sim.controls.speedbrakeArmed = false;
  const st = {};
  let liftX = null, liftV = null, x35 = null, v35 = null, rotT = null, maxPitch = 0, tailStrike = false;
  const p0 = { lat: sim.ac.lat, lon: sim.ac.lon };
  const dist = () => distance(p0.lat, p0.lon, sim.ac.lat, sim.ac.lon);
  sim.events.on('toast', (e) => { if (/TAIL/.test(e.text)) tailStrike = true; });
  let vsAt = null;
  run(sim, 60, (s, t) => {
    s.controls.throttle = [1, 1];
    const cas = kt(s.ac.cas), th = deg(s.ac.euler.pitch), q = deg(s.ac.omega[1]);
    if (rotT === null && cas >= 160) rotT = t;
    if (rotT !== null) {
      const thT = Math.min(15, 2.6 * (t - rotT));
      const qT = thT < 15 ? 2.6 : 0;
      s.controls.pitch = s.ac.onGround
        ? clamp(0.35 + 0.12 * (thT - th) - 0.25 * (q - qT), -1, 1)
        : clamp(0.06 * (thT - th) - 0.12 * (q - qT), -1, 1);
    }
    if (s.ac.onGround) s.controls.yaw = clamp(-deg(wrapPi(s.ac.euler.heading)) * 0.5, -1, 1);
    maxPitch = Math.max(maxPitch, th);
    if (liftX === null && rotT !== null && !s.ac.onGround) { liftX = dist(); liftV = cas; }
    if (x35 === null && s.ac.ra > 35 * FT) { x35 = dist(); v35 = cas; }
    if (liftX !== null && t - rotT > 20 && vsAt === null) vsAt = s.ac.vs / FPM;
    if (s.ac.ra > 400 * FT) s.controls.gearLever = 'UP';
  });
  info(`rotation started ${rotT?.toFixed(1)} s, liftoff at ${liftV?.toFixed(1)} KCAS, 35 ft at ${v35?.toFixed(1)} KCAS`);
  check('liftoff distance (m)', liftX ?? NaN, 1500, 2400, 'm');
  check('distance to 35 ft (m)', x35 ?? NaN, 1800, 2800, 'm');
  info(`FAR-style AEO field length 1.15 x d35 = ${(1.15 * x35).toFixed(0)} m`);
  check('V at 35 ft (KCAS) ~ V2+', v35 ?? NaN, 160, 185, 'kt');
  check('climb rate 20 s after rotation (fpm)', vsAt ?? NaN, 1500, 4500, 'fpm');
  check('max pitch (deg)', maxPitch, 10, 18, 'deg');
  check('no tail strike / crash', tailStrike || sim.ac.crashed ? 0 : 1, 1, 1);
  info(`after 60 s: alt ${altFt(sim).toFixed(0)} ft, CAS ${kt(sim.ac.cas).toFixed(0)} kt, N1 ${sim.engines[0].n1.toFixed(1)} %, FF ${(sim.engines[0].ff / 1000).toFixed(1)} t/h/eng, EGT ${sim.engines[0].egt.toFixed(0)} °C`);
}

// --------------------------------------------------------------- 2 cruise
section('2) Cruise FL350 M0.84, 280 t, hands-off 120 s');
{
  const h = 35000 * FT;
  const cas = casFromTas(0.84 * isa(h).a, h) / KT;
  const sim = mkSim({ massKg: 280000, fuelKg: 80000, flap: 0, gear: 'UP', onGround: false, speedKt: cas, altFt: 35000 });
  const thr = sim.engines[0].thrust / 1000, ff = sim.engines[0].ff / 1000;
  info(`trim: CAS ${cas.toFixed(1)} kt, alpha ${deg(sim.ac.alpha).toFixed(2)}°, pitch ${deg(sim.ac.euler.pitch).toFixed(2)}°, N1 ${sim.engines[0].n1.toFixed(1)} %, EGT ${sim.engines[0].egt.toFixed(0)} °C, stab ${sim.surfaces.stabUnits.toFixed(2)} u, lever ${sim.controls.throttle[0].toFixed(3)}`);
  check('thrust per engine (kN)', thr, 50, 62, 'kN');
  check('fuel flow per engine (t/h)', ff, 3.2, 3.8, 't/h');
  check('cruise pitch attitude (deg)', deg(sim.ac.euler.pitch), 1.5, 3.5, 'deg');
  const h0 = altFt(sim);
  let maxDev = 0, maxRoll = 0;
  run(sim, 120, () => { maxDev = Math.max(maxDev, Math.abs(altFt(sim) - h0)); maxRoll = Math.max(maxRoll, Math.abs(deg(sim.ac.euler.roll))); });
  check('max altitude deviation hands-off (ft)', maxDev, 0, 200, 'ft');
  check('Mach after 120 s', sim.ac.mach, 0.83, 0.85);
  check('max bank hands-off (deg)', maxRoll, 0, 1);
  const s2 = mkSim({ massKg: 280000, fuelKg: 80000, flap: 0, gear: 'UP', onGround: false, speedKt: cas, altFt: 35000 });
  info(`max climb thrust available at FL350 M0.84: ${(thrustAtN1(leverToN1(1, engineEnv(isa(h), 0.84)), engineEnv(isa(h), 0.84)) / 1000).toFixed(0)} kN/eng`);
  void s2;
}

// --------------------------------------------------------------- 3 approach
section('3) Approach 250 t, flaps 30, gear down, 3° glide path');
{
  const sim = mkSim({ massKg: 250000, fuelKg: 20000, flap: 6, gear: 'DOWN', onGround: false, speedKt: 150, altFt: 2000 });
  const vref = 1.23 * sim.ac.vs1gKt;
  check('Vs1g flaps 30 (KCAS)', sim.ac.vs1gKt, 110, 125, 'kt');
  check('Vref30 = 1.23 Vs1g (KCAS)', vref, 140, 152, 'kt');
  const vapp = vref + 5;
  const hMSL = 1500 * FT;
  const tr = solveTrim(sim, { tas: tasFromCas(vapp * KT, hMSL), hMSL, gamma: -3 * DEG });
  const env = engineEnv(isa(hMSL), tr.mach);
  const n1 = n1ForThrust(tr.thrust / 2, env);
  info(`Vapp ${vapp.toFixed(1)} kt: alpha ${deg(tr.alpha).toFixed(2)}°, pitch ${deg(tr.alpha - 3 * DEG).toFixed(2)}°, thrust ${(tr.thrust / 2000).toFixed(1)} kN/eng`);
  check('N1 on 3° path at Vref+5 (%)', n1, 50, 68, '%');
  check('approach pitch attitude (deg)', deg(tr.alpha - 3 * DEG), 0, 3.5, 'deg');
  // fly it: fixed lever from trim, hold -3° with the column
  const sim2 = mkSim({ massKg: 250000, fuelKg: 20000, flap: 6, gear: 'DOWN', onGround: false, speedKt: vapp, altFt: 2500 });
  const lv = n1ToLever(n1, env);
  const st = {};
  let vMin = 999, vMax = 0;
  run(sim2, 60, (s, t) => {
    s.controls.throttle = [lv, lv];
    s.controls.pitch = fpaPilot(s, -3 * DEG, st);
    if (t > 20) { vMin = Math.min(vMin, kt(s.ac.cas)); vMax = Math.max(vMax, kt(s.ac.cas)); }
  });
  info(`fixed-lever 3° descent: CAS ${vMin.toFixed(1)}..${vMax.toFixed(1)} kt, VS ${(sim2.ac.vs / FPM).toFixed(0)} fpm, N1 ${sim2.engines[0].n1.toFixed(1)} %, FF ${sim2.engines[0].ff.toFixed(0)} kg/h`);
  check('speed stays within Vapp ±8 kt on fixed thrust', Math.max(Math.abs(vMin - vapp), Math.abs(vMax - vapp)), 0, 8, 'kt');
}

// --------------------------------------------------------------- 4 stall
section('4) Stall (clean, 280 t, idle, 10000 ft)');
{
  // (a) DIRECT law: pilot keeps raising the nose until the wing stalls
  const sim = mkSim({ massKg: 280000, fuelKg: 60000, flap: 0, gear: 'UP', onGround: false, speedKt: 220, altFt: 10000 });
  sim.fbw.mode = 'DIRECT';
  const F = _fdmState(sim);
  let maxCL = 0, aAtMax = 0, vAtMax = 0, stallT = null, shakerKt = null, h0 = 0, hMin = 1e9, recT = null, maxAlpha = 0;
  const st = {};
  run(sim, 120, (s, t) => {
    s.controls.throttle = [0, 0];
    const a = F.aero;
    if (!a) return;
    if (shakerKt === null && s.ac.stallWarning) shakerKt = kt(s.ac.cas);
    if (stallT === null) {
      // hold level until stall: column integrator on vertical speed, ramp aft
      st.c = clamp((st.c ?? 0) + -s.ac.vs * 0.01 * DT, -1, 1);
      s.controls.pitch = clamp(st.c + (-s.ac.vs) * 0.02 - deg(s.ac.omega[1]) * 0.05, -1, 1);
      if (a.CLwing > maxCL) { maxCL = a.CLwing; aAtMax = s.ac.alpha; vAtMax = kt(s.ac.cas); }
      maxAlpha = Math.max(maxAlpha, s.ac.alpha);
      if (s.ac.alpha > a.aPk + 2 * DEG) { stallT = t; h0 = altFt(s); }
    } else {
      // recovery: nose down, TO thrust, wings level
      s.controls.pitch = s.ac.alpha > a.aShaker - 2 * DEG ? -0.7 : clamp(-s.ac.fpa * 4 - 0.1, -1, 0.5);
      s.controls.throttle = [1, 1];
      s.controls.roll = clamp(-s.ac.euler.roll * 2, -1, 1);
      hMin = Math.min(hMin, altFt(s));
      if (recT === null && s.ac.alpha < a.aShaker - 2 * DEG && s.ac.vs > -5) recT = t - stallT;
      maxAlpha = Math.max(maxAlpha, s.ac.alpha);
    }
  });
  info(`DIRECT law: CLmax ${maxCL.toFixed(3)} at alpha ${deg(aAtMax).toFixed(1)}° and ${vAtMax.toFixed(0)} KCAS; shaker at ${shakerKt?.toFixed(0)} KCAS; max alpha ${deg(maxAlpha).toFixed(1)}°`);
  check('CLmax reached (clean, M~0.3)', maxCL, 1.35, 1.5);
  check('alpha at CLmax (deg)', deg(aAtMax), 12, 17, 'deg');
  check('recovery time to unstalled & VS>-1000 (s)', recT ?? NaN, 1, 25, 's');
  check('altitude loss in recovery (ft)', h0 - hMin, 100, 3000, 'ft');
  // (b) NORMAL law: full aft column at idle -> protections keep alpha near the shaker
  const s2 = mkSim({ massKg: 280000, fuelKg: 60000, flap: 0, gear: 'UP', onGround: false, speedKt: 220, altFt: 10000 });
  const F2 = _fdmState(s2);
  let amax = 0, apk = 0, minCas = 999;
  run(s2, 60, (s) => {
    s.controls.throttle = [0, 0];
    s.controls.pitch = 1;
    amax = Math.max(amax, s.ac.alpha); apk = F2.aero?.aPk || 0; minCas = Math.min(minCas, kt(s.ac.cas));
  });
  info(`NORMAL law, full aft column at idle for 60 s: max alpha ${deg(amax).toFixed(1)}° (stall alpha ${deg(apk).toFixed(1)}°), min CAS ${minCas.toFixed(0)} kt, Vs1g ${s2.ac.vs1gKt.toFixed(0)} kt`);
  check('NORMAL law max alpha - stall alpha (deg)', deg(amax - apk), -4, 1.0, 'deg');
}

// --------------------------------------------------------------- 5 roll
section('5) Roll performance (full wheel)');
for (const [label, cfg] of [['clean 250 KCAS, 10000 ft', { flap: 0, gear: 'UP', speedKt: 250 }], ['flaps 30, 145 KCAS', { flap: 6, gear: 'DOWN', speedKt: 145 }]]) {
  const sim = mkSim({ massKg: 250000, fuelKg: 40000, onGround: false, altFt: 10000, ...cfg });
  const st = {};
  let t30 = null, pMax = 0;
  const lv = sim.controls.throttle[0];
  run(sim, 20, (s, t) => {
    s.controls.throttle = [lv, lv];
    s.controls.roll = t30 === null ? 1 : 0;
    pMax = Math.max(pMax, deg(s.ac.omega[0]));
    if (t30 === null && deg(s.ac.euler.roll) >= 30) { t30 = t; st.hold = 0; }
  });
  const phiEnd = deg(sim.ac.euler.roll);
  info(`${label}: 0->30° in ${t30?.toFixed(2)} s, max roll rate ${pMax.toFixed(1)} °/s, bank 20 s later ${phiEnd.toFixed(1)}°`);
  check(`time to 30° bank, ${label} (s)`, t30 ?? NaN, 2.5, 5.5, 's');
  check(`bank held after release, ${label} (deg)`, phiEnd, 26, 36, 'deg');
}
{
  // bank-angle protection: hold full wheel 15 s, then release
  const sim = mkSim({ massKg: 250000, fuelKg: 40000, onGround: false, altFt: 10000, flap: 0, gear: 'UP', speedKt: 250 });
  let phMax = 0;
  run(sim, 15, (s) => { s.controls.roll = 1; phMax = Math.max(phMax, deg(s.ac.euler.roll)); });
  run(sim, 20, (s) => { s.controls.roll = 0; });
  info(`bank protection: full wheel 15 s -> ${phMax.toFixed(1)}°, released 20 s -> ${deg(sim.ac.euler.roll).toFixed(1)}°`);
  check('bank after release from >35° (rollback to ~30)', deg(sim.ac.euler.roll), 25, 34, 'deg');
}
{
  // pitch response: full aft column at approach speed
  const sim = mkSim({ massKg: 250000, fuelKg: 30000, onGround: false, altFt: 3000, flap: 6, gear: 'DOWN', speedKt: 150 });
  let qMax = 0, nzMax = 0;
  run(sim, 4, (s) => { s.controls.pitch = 1; qMax = Math.max(qMax, deg(s.ac.omega[1])); nzMax = Math.max(nzMax, s.ac.nz); });
  info(`full aft column @150 kt F30: max q ${qMax.toFixed(1)} °/s, max nz ${nzMax.toFixed(2)} g`);
  check('pitch rate with full column at approach (°/s)', qMax, 4, 8, '°/s');
  const s3 = mkSim({ massKg: 280000, fuelKg: 60000, onGround: false, altFt: 20000, flap: 0, gear: 'UP', speedKt: 320 });
  let nz3 = 0;
  run(s3, 6, (s) => { s.controls.pitch = 1; nz3 = Math.max(nz3, s.ac.nz); });
  check('max nz full column 320 kt (g)', nz3, 2.0, 2.6, 'g');
  // neutral column after a pitch input holds the new flight path (U term inactive, e.g. AP column)
  const s4 = mkSim({ massKg: 250000, fuelKg: 30000, onGround: false, altFt: 5000, flap: 0, gear: 'UP', speedKt: 250 });
  run(s4, 3, (s) => { s.controls.pitch = 0.4; });
  s4.ap.out = { pitch: 0, roll: 0, yaw: 0, active: true };
  run(s4, 2, (s) => { s.controls.pitch = 0; });
  const g1 = deg(s4.ac.fpa);
  run(s4, 10, (s) => { s.controls.pitch = 0; });
  info(`flight path after pull: ${g1.toFixed(2)}°, 10 s later (neutral column) ${deg(s4.ac.fpa).toFixed(2)}°`);
  check('flight-path drift with neutral column, 10 s (deg)', Math.abs(deg(s4.ac.fpa) - g1), 0, 0.5, 'deg');
  // manual: speed stability returns toward the trim reference speed
  const s5 = mkSim({ massKg: 250000, fuelKg: 30000, onGround: false, altFt: 5000, flap: 0, gear: 'UP', speedKt: 250 });
  const lv5 = s5.controls.throttle[0];
  run(s5, 60, (s, t) => { s.controls.throttle = t < 20 ? [lv5 + 0.15, lv5 + 0.15] : [lv5, lv5]; });
  info(`speed stability: +thrust 20 s then back, hands-off: CAS after 60 s ${kt(s5.ac.cas).toFixed(1)} kt (trim ref 250), alt +${(altFt(s5) - 5000).toFixed(0)} ft`);
  check('speed returns toward trim ref (kt)', Math.abs(kt(s5.ac.cas) - 250), 0, 6, 'kt');
}

// --------------------------------------------------------------- 6 engine failure
section('6) Engine failure at V2+10 (300 t, flaps 15, TO thrust)');
for (const tac of [true, false]) {
  const sim = mkSim({ massKg: 300000, fuelKg: 90000, flap: 3, gear: 'UP', onGround: false, speedKt: 175, altFt: 1500 });
  sim.fbw.prot.tac = tac;
  const hdg0 = sim.ac.euler.heading;
  const st = {};
  let maxBeta = 0, maxRoll = 0, maxHdg = 0, rud = 0;
  run(sim, 40, (s, t) => {
    s.controls.throttle = [1, 1];
    if (t > 2) s.controls.fuelControl[0] = 'CUTOFF';
    s.controls.pitch = fpaPilot(s, 1.5 * DEG, st); // shallow climb
    if (t > 2) {
      maxBeta = Math.max(maxBeta, Math.abs(deg(s.ac.beta)));
      maxRoll = Math.max(maxRoll, Math.abs(deg(s.ac.euler.roll)));
      maxHdg = Math.max(maxHdg, Math.abs(deg(wrapPi(s.ac.euler.heading - hdg0))));
      rud = Math.max(rud, Math.abs(deg(s.surfaces.rudder)));
    }
  });
  info(`TAC ${tac ? 'ON ' : 'OFF'}: hands-off 38 s -> max heading change ${maxHdg.toFixed(1)}°, max bank ${maxRoll.toFixed(1)}°, max sideslip ${maxBeta.toFixed(1)}°, max rudder ${rud.toFixed(1)}°, ROC ${(sim.ac.vs / FPM).toFixed(0)} fpm, N1 L/R ${sim.engines[0].n1.toFixed(0)}/${sim.engines[1].n1.toFixed(0)}`);
  if (tac) {
    check('TAC: heading change hands-off (deg)', maxHdg, 0, 10, 'deg');
    check('TAC: max sideslip (deg)', maxBeta, 0, 3, 'deg');
    check('TAC: engine 1 spooled down (N1 %)', sim.engines[0].n1, 0, 35, '%');
  } else check('no TAC: rudder only from yaw damper -> larger sideslip (deg)', maxBeta, 1.5, 30, 'deg');
}

// --------------------------------------------------------------- 7 landing
section('7) Landing 250 t, flaps 30, autobrake 3, reversers');
{
  const sim = mkSim({ massKg: 250000, fuelKg: 20000, flap: 6, gear: 'DOWN', onGround: false, speedKt: 150, altFt: 1000 });
  const vref = 1.23 * sim.ac.vs1gKt, vapp = vref + 5;
  sim.controls.autobrake = '3';
  sim.controls.speedbrakeArmed = true;
  const st = {}, sp = {};
  let tdV = null, tdFpm = null, x50 = null, xTd = null, stopX = null, phase = 'app', toasts = [];
  sim.events.on('toast', (e) => toasts.push(e.text));
  const p0 = { lat: sim.ac.lat, lon: sim.ac.lon };
  const dist = () => distance(p0.lat, p0.lon, sim.ac.lat, sim.ac.lon);
  run(sim, 150, (s, t) => {
    const ra = s.ac.ra / FT;
    if (phase === 'app') {
      s.controls.pitch = fpaPilot(s, -3 * DEG, st);
      speedPilot(s, vapp, sp);
      if (ra < 50 && x50 === null) x50 = dist();
      if (ra < 45) phase = 'flare';
    } else if (phase === 'flare') {
      st.ft = (st.ft ?? 0) + DT;
      st.th0 = st.th0 ?? deg(s.ac.euler.pitch);
      const thT = st.th0 + Math.min(3.5, st.ft * 2.0);
      s.controls.pitch = clamp(0.15 + 0.3 * (thT - deg(s.ac.euler.pitch)) - 0.12 * deg(s.ac.omega[1]), -1, 1);
      if (ra < 20) s.controls.throttle = [0, 0]; else speedPilot(s, vapp, sp);
      if (s.ac.wow.left || s.ac.wow.right) { phase = 'roll'; tdV = kt(s.ac.cas); xTd = dist(); }
    } else {
      s.controls.throttle = [0, 0];
      s.controls.pitch = s.ac.wow.nose ? 0 : -0.15;
      const gsKt = kt(s.ac.gs);
      s.controls.reverse = gsKt > 70 ? [1, 1] : gsKt > 15 ? [0.1, 0.1] : [0, 0];
      s.controls.yaw = clamp(-deg(wrapPi(s.ac.euler.heading)) * 0.3, -1, 1);
      if (gsKt < 1 && stopX === null) { stopX = dist(); return false; }
    }
  });
  const fd = _fdmState(sim);
  tdFpm = fd.gear.lastTouchdownFpm;
  info(`Vapp ${vapp.toFixed(0)} kt, touchdown ${tdV?.toFixed(0)} KCAS at ${tdFpm?.toFixed(0)} fpm, toasts: ${toasts.join(' | ')}`);
  check('touchdown sink rate (fpm)', tdFpm ?? NaN, 30, 600, 'fpm');
  check('ground roll touchdown -> stop, AB3 + rev (m)', stopX - xTd, 900, 1800, 'm');
  check('landing distance from 50 ft (m)', stopX - x50, 1200, 2300, 'm');
  check('no crash', sim.ac.crashed ? 0 : 1, 1, 1);
  info(`autobrake state at stop: ${sim.surfaces.autobrakeState}, speedbrake ${sim.surfaces.speedbrake.toFixed(2)}`);
}
{
  // RTO at 100 kt
  const sim = mkSim({ massKg: 300000, fuelKg: 90000, flap: 3 });
  sim.controls.autobrake = 'RTO';
  let x0 = null, abort = false;
  const p0 = { lat: sim.ac.lat, lon: sim.ac.lon };
  const dist = () => distance(p0.lat, p0.lon, sim.ac.lat, sim.ac.lon);
  run(sim, 120, (s) => {
    s.controls.yaw = clamp(-deg(wrapPi(s.ac.euler.heading)) * 0.5, -1, 1);
    if (!abort) { s.controls.throttle = [1, 1]; if (kt(s.ac.cas) >= 120) { abort = true; x0 = dist(); } }
    else { s.controls.throttle = [0, 0]; s.controls.reverse = kt(s.ac.gs) > 60 ? [1, 1] : [0, 0]; if (s.ac.gs < 0.5) return false; }
  });
  info(`RTO from 120 kt: stop distance ${(dist() - x0).toFixed(0)} m, autobrake ${sim.surfaces.autobrakeState}`);
  check('RTO stop distance from 120 kt (m)', dist() - x0, 300, 1100, 'm');
}

// --------------------------------------------------------------- 8 taxi
section('8) Ground handling: taxi turn with full tiller (250 t)');
{
  const sim = mkSim({ massKg: 250000, fuelKg: 30000, flap: 0 });
  const sp = {};
  let rMeas = null, gsT = 0;
  run(sim, 60, (s, t) => {
    const tgt = t < 30 ? 15 : 8;
    const e = tgt - kt(s.ac.gs);
    sp.i = clamp((sp.i ?? 0.05) + e * DT * 0.01, 0, 0.4);
    s.controls.throttle = [clamp(sp.i + 0.02 * e, 0, 0.5), clamp(sp.i + 0.02 * e, 0, 0.5)];
    s.controls.brakeL = s.controls.brakeR = e < -3 ? 0.3 : 0;
    s.controls.tiller = t > 30 ? 1 : 0;
    if (t > 50) { rMeas = s.ac.gs / Math.abs(s.ac.omega[2]); gsT = kt(s.ac.gs); }
  });
  info(`straight 15 kt N1 ${sim.engines[0].n1.toFixed(1)}%; turning at ${gsT.toFixed(1)} kt, yaw rate ${deg(sim.ac.omega[2]).toFixed(1)} °/s, nosewheel ${deg(sim.surfaces.noseWheel).toFixed(0)}°`);
  check('turn radius at CG with full tiller (m)', rMeas ?? NaN, 15, 45, 'm');
  check('stays upright / no crash', sim.ac.crashed ? 0 : 1, 1, 1);
}
{
  // static: parked, engines idle, parking brake -> no creep
  const sim = mkSim({ massKg: 250000, fuelKg: 30000, flap: 0 });
  sim.controls.parkingBrake = true;
  run(sim, 30);
  check('parked creep with parking brake (m/s)', sim.ac.gs, 0, 0.02, 'm/s');
  check('static pitch on ground (deg)', deg(sim.ac.euler.pitch), -1, 1, 'deg');
}


// --------------------------------------------------------------- 9 engines
section('9) Engines (GE90-115B): spool, start, static data');
{
  let sim = mkSim({ massKg: 250000, fuelKg: 30000 });
  sim.controls.parkingBrake = true;
  run(sim, 20, (s) => { s.controls.throttle = [1, 1]; });
  const e = sim.engines[0], Fto = e.thrust;
  info(`TO static SL ISA: thrust ${(Fto / 1000).toFixed(0)} kN, N1 ${e.n1.toFixed(1)} %, N2 ${e.n2.toFixed(1)} %, EGT ${e.egt.toFixed(0)} °C, FF ${(e.ff / 1000).toFixed(1)} t/h`);
  check('static TO thrust per engine (kN)', Fto / 1000, 490, 515, 'kN');
  check('static TO fuel flow (t/h)', e.ff / 1000, 14, 17, 't/h');
  sim = mkSim({ massKg: 250000, fuelKg: 30000 });
  sim.controls.parkingBrake = true;
  info(`ground idle: N1 ${sim.engines[0].n1.toFixed(1)} %, N2 ${sim.engines[0].n2.toFixed(1)} %, EGT ${sim.engines[0].egt.toFixed(0)} °C, FF ${sim.engines[0].ff.toFixed(0)} kg/h, thrust ${(sim.engines[0].thrust / 1000).toFixed(1)} kN`);
  let t95 = null;
  run(sim, 20, (s, t) => { s.controls.throttle = [1, 1]; if (t95 === null && s.engines[0].thrust > 0.95 * Fto) t95 = t; });
  check('ground idle -> 95 % TO thrust (s)', t95 ?? NaN, 7, 11, 's');
  let tdn = null;
  run(sim, 15, (s, t) => { s.controls.throttle = [0, 0]; if (tdn === null && s.engines[0].n1 < 25) tdn = t; });
  check('TO -> idle (N1 < 25 %) (s)', tdn ?? NaN, 4, 8, 's');
  // approach idle -> go-around
  const a1 = mkSim({ massKg: 250000, fuelKg: 20000, flap: 6, onGround: false, speedKt: 145, altFt: 1500 });
  run(a1, 10, (s) => { s.controls.throttle = [0, 0]; });
  const n1ai = a1.engines[0].n1;
  let tga = null;
  run(a1, 12, (s, t) => { s.controls.throttle = [1, 1]; if (tga === null && s.engines[0].n1 > 0.95 * leverToN1(1, engineEnv(isa(s.ac.altMSL), s.ac.mach))) tga = t; });
  info(`approach idle N1 ${n1ai.toFixed(1)} % -> 95 % GA N1 in ${tga?.toFixed(1)} s`);
  check('approach idle -> 95 % GA N1 (s)', tga ?? NaN, 4, 8, 's');
  // systems commanding startState OFF on a running engine -> flameout
  const fo = mkSim({ massKg: 250000, fuelKg: 30000 });
  fo.engines[1].startState = 'OFF';
  run(fo, 15);
  check('startState OFF while running -> flameout (N2 %)', fo.engines[1].n2 < 30 && !fo.engines[1].running ? 1 : 0, 1, 1);
  // start sequence
  const st = mkSim({ massKg: 250000, fuelKg: 30000 });
  initAircraft(st, { lat: 0.8, lon: 0.1, h: 0, heading: 0, onGround: true, enginesRunning: false });
  st.controls.fuelControl = ['CUTOFF', 'CUTOFF'];
  st.engines[0].startState = 'STARTING';
  let egtPk = 0, tIdle = null;
  run(st, 120, (s, t) => {
    if (s.engines[0].n2 >= 25) s.controls.fuelControl[0] = 'RUN';
    egtPk = Math.max(egtPk, s.engines[0].egt);
    if (tIdle === null && s.engines[0].running) tIdle = t;
  });
  info(`start: idle after ${tIdle?.toFixed(0)} s, peak start EGT ${egtPk.toFixed(0)} °C, state ${st.engines[0].startState}`);
  check('engine start to stable idle (s)', tIdle ?? NaN, 35, 80, 's');
  check('engine 2 stays off (N2 %)', st.engines[1].n2, 0, 1, '%');
}

// --------------------------------------------------------------- 10 crash / robustness
section('10) Touchdown / crash detection and robustness');
{
  for (const [fpm, expectCrash] of [[950, false], [1500, true]]) {
    const hard = mkSim({ massKg: 250000, fuelKg: 20000, flap: 6, onGround: false, speedKt: 145, altFt: 25 });
    const toasts = [];
    hard.events.on('toast', (e) => toasts.push(e.text));
    hard.ac.vNED[2] = fpm * FPM;
    run(hard, 4, (s) => { s.controls.throttle = [0, 0]; s.controls.pitch = 0.1; });
    info(`touchdown at ~${fpm} fpm: crashed=${hard.ac.crashed} ${hard.ac.crashReason} | ${toasts.join(' | ')}`);
    check(`${fpm} fpm touchdown -> ${expectCrash ? 'crash' : 'hard-landing toast'}`, (hard.ac.crashed === expectCrash && (expectCrash || toasts.some((t) => /HARD/.test(t)))) ? 1 : 0, 1, 1);
  }
  const gu = mkSim({ massKg: 250000, fuelKg: 20000, flap: 6, gear: 'UP', onGround: false, speedKt: 150, altFt: 30 });
  const stp = {};
  run(gu, 30, (s) => { s.controls.throttle = [0, 0]; s.controls.pitch = fpaPilot(s, -1 * DEG, stp); if (s.ac.crashed) return false; });
  info(`gear-up landing: crashed=${gu.ac.crashed} (${gu.ac.crashReason})`);
  check('gear-up landing detected as crash', gu.ac.crashed ? 1 : 0, 1, 1);
  // severe turbulence + crosswind on the ground and in the air: no NaN, no crash
  const tb = mkSim({ massKg: 280000, fuelKg: 60000, flap: 0, gear: 'UP', onGround: false, speedKt: 280, altFt: 8000 });
  tb.env.turbulence = 1; tb.env.windKt = 40; tb.env.windDirDeg = 270;
  let nzMin = 9, nzMax = -9;
  run(tb, 60, (s) => { nzMin = Math.min(nzMin, s.ac.nz); nzMax = Math.max(nzMax, s.ac.nz); });
  info(`severe turbulence 60 s: nz ${nzMin.toFixed(2)}..${nzMax.toFixed(2)} g, alt ${altFt(tb).toFixed(0)} ft, bank ${deg(tb.ac.euler.roll).toFixed(1)}°`);
  check('turbulence: state finite & flying', Number.isFinite(tb.ac.h) && !tb.ac.crashed ? 1 : 0, 1, 1);
  const cw = mkSim({ massKg: 250000, fuelKg: 30000 });
  cw.env.windKt = 30; cw.env.windDirDeg = 90; cw.controls.parkingBrake = true; cw.env.turbulence = 0.5;
  run(cw, 30);
  check('parked in 30 kt crosswind: no movement (m/s)', cw.ac.gs, 0, 0.05, 'm/s');
  // NaN injection is recovered
  const nn = mkSim({ massKg: 250000, fuelKg: 30000, onGround: false, speedKt: 250, altFt: 5000, flap: 0, gear: 'UP' });
  nn.controls.pitch = NaN;
  run(nn, 2);
  nn.ac.vNED = [NaN, 0, 0];
  run(nn, 2, (s) => { s.controls.pitch = 0; });
  check('NaN guard keeps state finite', Number.isFinite(nn.ac.lat) && Number.isFinite(nn.ac.h) && Number.isFinite(nn.ac.vNED[0]) ? 1 : 0, 1, 1);
  // time acceleration: 4x calls per frame equal to 1x physics
  const t0 = performance.now();
  const perf = mkSim({ massKg: 280000, fuelKg: 60000, onGround: false, speedKt: 280, altFt: 30000, flap: 0, gear: 'UP' });
  run(perf, 60);
  const ms = (performance.now() - t0) / (60 * 120);
  info(`cost per stepPhysics call: ${(ms * 1000).toFixed(1)} µs`);
  check('stepPhysics cost (µs) budget', ms * 1000, 0, 200, 'µs');
}

console.log('777-300ER physics test report' + results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
