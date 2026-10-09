// Boeing 777-300ER aircraft systems (Team D2) — simplified but believable.
// Pure logic, no DOM: runs in the browser main loop and under Node tests.
//
// Owns `sim.systems` (electrical, APU, hydraulics, fuel, bleed/packs, pressurization,
// anti-ice, lights, signs, ADIRU, transponder, autobrake logic, fire handles) and:
//   * fuel tank depletion: subtracts sim.engines[i].ff (computed by physics) + APU burn
//     from sim.ac.fuelKg.{L,C,R}; physics reads sim.ac.fuelKg for mass.
//   * engine start/stop state machine: sim.engines[i].startState 'OFF'|'STARTING'|'RUN'.
//     Physics spools N2 while 'STARTING' and runs the engine while 'RUN'.
//   * pilot-control automation it is responsible for: start selector spring-back,
//     speedbrake auto-deploy/stow, autobrake mode logic (RTO/1..MAX -> DISARM/OFF).
// See docs/systems.md for the full field list.

import { FLAP_DETENTS } from '../core/state.js';
import { FT, KT, clamp, lag, approach } from '../core/geo.js';

// ---------------------------------------------------------------- constants
const N2_STARTER_CUTOUT = 50;     // % N2: start selector springs back, state -> RUN
const N2_LIGHTOFF_MIN = 18;       // % N2: autostart introduces fuel above this
const DUCT_START_MIN_PSI = 20;    // bleed duct pressure needed by the air turbine starter
const APU_START_S = 60;           // APU start sequence duration (door + spool + stabilise)
const APU_COOLDOWN_S = 60;        // APU cooldown when switched OFF after bleed use
const APU_BURN_KGH = 120;         // APU fuel burn
const ADIRU_ALIGN_S = 240;        // shortened from the real 7-10 min for playability
const HYD_NOMINAL = 3000;         // psi
export const TANK_CAPACITY_KG = { L: 31000, C: 82000, R: 31000 }; // ≈ 777-300ER, total ≈ 145 t
const MAX_DIFF_PSI = 8.6;         // max cabin differential pressure
export const AUTOBRAKE_DECEL = { '1': 1.2, '2': 1.5, '3': 1.8, '4': 2.3, MAX: 3.4, RTO: 4.5 }; // m/s²

const SIDES = ['L', 'R'];
export const DOOR_NAMES = ['ENTRY 1L', 'ENTRY 2L', 'ENTRY 3L', 'ENTRY 4L', 'ENTRY 5L',
  'ENTRY 1R', 'ENTRY 2R', 'ENTRY 3R', 'ENTRY 4R', 'ENTRY 5R', 'FWD CARGO', 'AFT CARGO', 'BULK CARGO'];

// --------------------------------------------------------------- helpers
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
/** ISA static pressure (Pa) at geopotential height h (m), troposphere + lower stratosphere. */
function isaPressure(h) {
  h = clamp(num(h), -500, 25000);
  if (h <= 11000) return 101325 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
  return 22632 * Math.exp(-(h - 11000) / 6341.6);
}
/** Inverse of isaPressure for the troposphere (cabin altitudes only). */
function isaAltFromPressure(p) {
  return (1 - Math.pow(Math.max(1, p) / 101325, 1 / 5.25588)) / 2.25577e-5;
}
const PA_PER_PSI = 6894.757;

/** True when the engine is producing power (used by generators, bleeds, EDPs). */
const engRunning = (e) => !!e && e.startState === 'RUN' && num(e.n2) > 50;

// ------------------------------------------------------------ state blocks
function defaultSystems() {
  return {
    elec: {
      battery: true, apuGenSw: true, genCtrl: [true, true], driveDisc: [false, false],
      busTie: [true, true], extPwrAvail: false, extPwrOn: false,
      idgOnline: [false, false], apuGenOnline: false, extOnline: false,
      acBus: [false, false], dcPowered: false, acPowered: false, battBus: false,
      battPct: 100, powered: false, sources: [],
    },
    apu: { selector: 'OFF', state: 'OFF', n: 0, egt: 15, timer: 0, cooldown: 0, bleedUsed: false, fault: false },
    hyd: {
      // switches: primary pumps true/false, demand pumps 'AUTO'|'OFF'|'ON'
      pumps: { engL: true, engR: true, elecC1: true, elecC2: true, demL: 'AUTO', demC1: 'AUTO', demC2: 'AUTO', demR: 'AUTO' },
      run: { engL: false, engR: false, elecC1: false, elecC2: false, demL: false, demC1: false, demC2: false, demR: false },
      press: { L: 0, C: 0, R: 0 }, qty: { L: 1, C: 1, R: 1 },
    },
    fuel: {
      pumps: { lFwd: true, lAft: true, rFwd: true, rAft: true, cL: false, cR: false },
      xfeedFwd: false, xfeedAft: false,
      press: { L: false, R: false },     // engine feed manifold pressurised by a boost pump
      feedFrom: ['L', 'R'], starved: [false, false],
      burnedKg: 0, totalKg: 0, apuFeed: 'L', tempC: 15, jettison: false,
    },
    gear: { brakeTemp: new Array(12).fill(1), tirePsi: new Array(12).fill(210) },
    doors: Object.fromEntries(DOOR_NAMES.map((d) => [d, false])),
    start: { autostart: true, conIgn: false, timer: [0, 0], ignition: [false, false] },
    air: {
      packs: ['AUTO', 'AUTO'], packOn: [false, false], engBleed: [true, true], apuBleed: true,
      trimAir: true, recirc: true, isln: ['AUTO', 'AUTO', 'AUTO'], ductPsi: 0, ductSrc: '', tatC: 15, satC: 15,
    },
    press: { mode: 'AUTO', cabinAltFt: 0, cabinRateFpm: 0, diffPsi: 0, landingAltFt: null, outflow: 1, targetFt: 0 },
    antiIce: { wing: 'AUTO', eng: ['AUTO', 'AUTO'], wingOn: false, engOn: [false, false], iceDetected: false },
    lights: {
      landingL: false, landingN: false, landingR: false, taxi: false, turnoffL: false, turnoffR: false,
      strobe: false, beacon: false, nav: false, logo: false, wing: false, storm: false, dome: false,
    },
    signs: { noSmoking: 'AUTO', seatbelts: 'AUTO', noSmokingLit: false, seatbeltsLit: false, emerLights: 'ARMED' },
    adiru: { on: true, aligned: true, alignRemaining: 0, onBat: false },
    xpdr: { code: '2000', mode: 'TA/RA', ident: false, identTimer: 0 },
    autobrake: { active: false, cmd: 0, decelTarget: 0, decel: 0, disarmReason: '', rtoArmedSpeed: false },
    fire: { handle: [false, false], discharged: [false, false], timer: [0, 0], apuHandle: false },
    stabCutout: [false, false],
    flightCtl: { pfcDisc: false, tac: true },
    probeHeat: true, windowHeat: true,
    fuelOwned: true,                    // tells physics (fdm.js) that systems burns fuel & completes engine starts
    phase: 'GROUND',                    // 'GROUND' | 'TAKEOFF' | 'AIR' | 'LANDING'
    _prev: { onGround: true, gs: 0, airborneT: 0, groundT: 0 },
  };
}

/** Deep-merge `src` into `dst` (only plain objects/arrays, preserves dst references). */
function merge(dst, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
    else dst[k] = Array.isArray(v) ? v.slice() : v;
  }
  return dst;
}

// ---------------------------------------------------------- initialisation
const spawnHooks = new WeakMap();

/**
 * Initialise sim.systems. coldDark=true: everything off, GPU available.
 * coldDark=false: engines running, ready for takeoff (lights, RTO, takeoff flaps).
 * Also subscribes to 'spawned' so a re-spawn re-applies the chosen state.
 */
export function initSystems(sim, { coldDark = false } = {}) {
  const s = merge(sim.systems && sim.systems.elec ? sim.systems : (sim.systems = {}), defaultSystems());
  s.coldDark = !!coldDark;
  if (coldDark) applyColdDark(sim); else applyReadyForTakeoff(sim);
  if (sim.events && !spawnHooks.has(sim)) {
    spawnHooks.set(sim, sim.events.on('spawned', () => initSystems(sim, { coldDark: sim.systems.coldDark })));
  }
  stepSystems(sim, 0);
  return sim.systems;
}

function applyColdDark(sim) {
  const s = sim.systems, c = sim.controls;
  s.elec.battery = false; s.elec.extPwrAvail = true; s.elec.extPwrOn = false;
  s.apu.selector = 'OFF'; s.apu.state = 'OFF'; s.apu.n = 0;
  Object.assign(s.hyd.pumps, { engL: true, engR: true, elecC1: false, elecC2: false, demL: 'OFF', demC1: 'OFF', demC2: 'OFF', demR: 'OFF' });
  Object.assign(s.fuel.pumps, { lFwd: false, lAft: false, rFwd: false, rAft: false, cL: false, cR: false });
  s.adiru.on = false; s.adiru.aligned = false;
  s.xpdr.mode = 'STBY';
  for (const k of Object.keys(s.lights)) s.lights[k] = false;
  s.signs.seatbelts = 'OFF'; s.signs.noSmoking = 'OFF';
  s.press.cabinAltFt = num(sim.ac.altMSL) / FT;
  for (const d of ['ENTRY 1L', 'ENTRY 2L', 'FWD CARGO', 'AFT CARGO']) s.doors[d] = true;
  c.fuelControl = ['CUTOFF', 'CUTOFF']; c.engStart = [false, false];
  c.parkingBrake = true; c.autobrake = 'OFF'; c.flapLever = 0; c.gearLever = 'DOWN';
  c.speedbrakeLever = 0; c.speedbrakeArmed = false; c.throttle = [0, 0]; c.reverse = [0, 0];
  sim.engines.forEach((e) => { e.startState = 'OFF'; e.running = false; e.n1 = 0; e.n2 = 0; e.ff = 0; e.egt = 15; });
}

function applyReadyForTakeoff(sim) {
  const s = sim.systems, c = sim.controls;
  s.elec.battery = true; s.elec.extPwrAvail = false; s.elec.extPwrOn = false;
  s.apu.selector = 'OFF'; s.apu.state = 'OFF'; s.apu.n = 0;
  s.adiru.on = true; s.adiru.aligned = true; s.adiru.alignRemaining = 0;
  s.xpdr.mode = 'TA/RA';
  Object.assign(s.lights, { landingL: true, landingN: true, landingR: true, taxi: false, turnoffL: false, turnoffR: false,
    strobe: true, beacon: true, nav: true, logo: true, wing: false });
  s.signs.seatbelts = 'ON'; s.signs.noSmoking = 'AUTO';
  s.press.cabinAltFt = num(sim.ac.altMSL) / FT;
  for (const d of DOOR_NAMES) s.doors[d] = false;
  const toFlaps = num(sim.fmc && sim.fmc.toFlaps, 15);
  const idx = FLAP_DETENTS.indexOf(toFlaps);
  c.flapLever = idx > 0 ? idx : 3;
  // "Ready for takeoff": the flaps are already at the takeoff setting (initAircraft ran before this
  // and set them from the old lever, so without this they would still be travelling at brake release).
  const sf = sim.surfaces;
  if (sf && sim.ac.onGround) {
    const det = FLAP_DETENTS[c.flapLever];
    sf.flapsDeg = sf.flapsTarget = det;
    sf.slats = det === 0 ? 0 : det >= 25 ? 1 : 0.5;
  }
  c.fuelControl = ['RUN', 'RUN']; c.engStart = [false, false];
  c.parkingBrake = true; c.autobrake = 'RTO'; c.gearLever = 'DOWN';
  c.speedbrakeLever = 0; c.speedbrakeArmed = false; c.throttle = [0, 0]; c.reverse = [0, 0];
  sim.engines.forEach((e) => {
    e.startState = 'RUN'; e.running = true;
    if (num(e.n2) < 55) { e.n2 = 63; e.n1 = 21; e.egt = 420; e.ff = 1100; e.oilP = 45; }
  });
  s.fuel.pumps.cL = s.fuel.pumps.cR = num(sim.ac.fuelKg && sim.ac.fuelKg.C) > 100;
  s.hyd.press.L = s.hyd.press.C = s.hyd.press.R = HYD_NOMINAL;
  s.air.ductPsi = 38;
}

// ---------------------------------------------------------------- stepping
/** Advance all aircraft systems by dt seconds. Never throws. */
export function stepSystems(sim, dt) {
  try {
    if (!sim.systems || !sim.systems.elec) merge(sim.systems = sim.systems || {}, defaultSystems());
    dt = clamp(num(dt), 0, 1);
    stepPhase(sim, dt);
    stepElectrical(sim, dt);
    stepApu(sim, dt);
    stepBleed(sim, dt);
    stepFuel(sim, dt);
    stepEngineStart(sim, dt);
    stepFire(sim, dt);
    stepHydraulics(sim, dt);
    stepPressurization(sim, dt);
    stepMisc(sim, dt);
    stepSpeedbrake(sim);
    stepAutobrake(sim, dt);
    stepGearDoorsTemps(sim, dt);
  } catch (err) {
    if (!stepSystems._warned) { console.warn('stepSystems:', err); stepSystems._warned = true; }
  }
}

function stepPhase(sim, dt) {
  const s = sim.systems, ac = sim.ac, p = s._prev;
  const onGround = !!ac.onGround;
  if (onGround) { p.groundT += dt; p.airborneT = 0; } else { p.airborneT += dt; p.groundT = 0; }
  const casKt = num(ac.cas) / KT;
  if (onGround) s.phase = casKt > 60 && p.groundT > 5 && p.wasAir ? 'LANDING' : (casKt > 40 ? 'TAKEOFF' : 'GROUND');
  else s.phase = num(ac.ra) / FT < 400 && p.airborneT < 90 && !p.wasAir ? 'TAKEOFF' : 'AIR';
  if (!onGround && p.airborneT > 10) p.wasAir = true;
  if (onGround && casKt < 30) p.wasAir = false;
  p.onGround = onGround;
}

// ------------------------------------------------------------ electrical
function stepElectrical(sim, dt) {
  const e = sim.systems.elec, ac = sim.ac;
  const parked = ac.onGround && num(ac.gs) < 1.0;
  if (!parked && e.extPwrAvail) { e.extPwrAvail = false; }   // GPU disconnected when the aircraft moves
  if (!e.extPwrAvail) e.extPwrOn = false;
  e.extOnline = e.extPwrAvail && e.extPwrOn;
  e.apuGenOnline = e.apuGenSw && sim.systems.apu.state === 'RUN' && sim.systems.apu.n > 95;
  const fire = sim.systems.fire;
  e.idgOnline = [0, 1].map((i) => e.genCtrl[i] && !e.driveDisc[i] && !fire.handle[i] && engRunning(sim.engines[i]));
  const anyOther = (i) => e.idgOnline[1 - i] || e.apuGenOnline || e.extOnline;
  e.acBus = [0, 1].map((i) => e.idgOnline[i] || (e.busTie[i] && anyOther(i)));
  e.acPowered = e.acBus[0] || e.acBus[1];
  // battery: charges on AC, drains slowly when it is the only source
  if (e.battery && !e.acPowered) e.battPct = clamp(e.battPct - dt * 0.02, 0, 100);
  else if (e.acPowered) e.battPct = clamp(e.battPct + dt * 0.05, 0, 100);
  e.battBus = e.battery && e.battPct > 2;
  e.dcPowered = e.acPowered || e.battBus;
  e.powered = e.dcPowered;
  e.sources = [];
  if (e.idgOnline[0]) e.sources.push('IDG L');
  if (e.idgOnline[1]) e.sources.push('IDG R');
  if (e.apuGenOnline) e.sources.push('APU');
  if (e.extOnline) e.sources.push('EXT');
  if (!e.acPowered && e.battBus) e.sources.push('BAT');
  // display aliases read by the lower-EICAS ELEC synoptic (docs/displays.md)
  e.idgL = e.idgOnline[0]; e.idgR = e.idgOnline[1]; e.apuGen = e.apuGenOnline; e.extPwr = e.extOnline;
  e.busL = e.acBus[0]; e.busR = e.acBus[1];
  e.battV = e.battery ? (e.acPowered ? 28.5 : 24 + e.battPct * 0.035) : 0;
}

// ------------------------------------------------------------------- APU
function stepApu(sim, dt) {
  const a = sim.systems.apu, el = sim.systems.elec;
  const fuelOk = totalFuel(sim) > 50 && !sim.systems.fire.apuHandle;
  if (a.selector === 'START') {
    if (a.state === 'OFF' || a.state === 'STOPPING') { if (el.dcPowered && fuelOk) { a.state = 'STARTING'; a.timer = 0; } else a.fault = true; }
    a.selector = 'ON';               // spring-loaded back to ON
  }
  if (a.selector === 'OFF' && (a.state === 'RUN' || a.state === 'STARTING')) {
    a.cooldown = a.bleedUsed && a.state === 'RUN' ? APU_COOLDOWN_S : 5; a.state = 'STOPPING';
  }
  if (!el.dcPowered || !fuelOk) { if (a.state === 'RUN' || a.state === 'STARTING') { a.state = 'STOPPING'; a.cooldown = 0; a.fault = !fuelOk; } }
  switch (a.state) {
    case 'STARTING': {
      a.timer += dt;
      const t = a.timer;
      // door opens ~10 s, light-off at ~12 s, spools to 100 % by ~50 s, stabilises until 60 s
      const nTarget = t < 10 ? 0 : t < 50 ? 100 * Math.pow((t - 10) / 40, 0.8) : 100;
      a.n = approach(a.n, nTarget, 12, dt);
      const egtTarget = t < 12 ? 15 : t < 30 ? 15 + (t - 12) * 38 : t < 50 ? 700 - (t - 30) * 12 : 440;
      a.egt = lag(a.egt, egtTarget, 1.5, dt);
      if (t >= APU_START_S) { a.state = 'RUN'; a.fault = false; }
      break;
    }
    case 'RUN':
      a.n = approach(a.n, 100, 10, dt);
      a.egt = lag(a.egt, sim.systems.air.ductSrc === 'APU' ? 480 : 400, 4, dt);
      if (sim.systems.air.ductSrc === 'APU') a.bleedUsed = true;
      break;
    case 'STOPPING':
      if (a.cooldown > 0) { a.cooldown -= dt; a.egt = lag(a.egt, 380, 6, dt); break; }
      a.n = approach(a.n, 0, 6, dt);
      a.egt = lag(a.egt, 15, 25, dt);
      if (a.n <= 0) { a.state = 'OFF'; a.bleedUsed = false; }
      break;
    default:
      a.n = approach(a.n, 0, 6, dt); a.egt = lag(a.egt, 15, 25, dt);
  }
  a.running = a.state === 'RUN';
}

// ----------------------------------------------------------- bleed & packs
function stepBleed(sim, dt) {
  const air = sim.systems.air, apu = sim.systems.apu, fire = sim.systems.fire;
  let psi = 0, src = '';
  [0, 1].forEach((i) => {
    const e = sim.engines[i];
    if (air.engBleed[i] && !fire.handle[i] && e && num(e.n2) > 45) {
      const p = 28 + clamp((num(e.n2) - 45) / 55, 0, 1) * 17;
      if (p > psi) { psi = p; src = 'ENG ' + SIDES[i]; }
    }
  });
  if (air.apuBleed && apu.state === 'RUN' && apu.n > 95 && psi < 30) { psi = Math.max(psi, 32); src = 'APU'; }
  air.ductPsi = lag(num(air.ductPsi), psi, 0.8, dt || 1);
  air.ductSrc = psi > 0 ? src : '';
  // engine start draws most of the duct air: packs are shut during start (as on the real aircraft)
  const starting = sim.engines.some((e) => e && e.startState === 'STARTING');
  air.packOn = [0, 1].map((i) => air.packs[i] !== 'OFF' && air.ductPsi > 15 && !starting);
}

// ------------------------------------------------------------------- fuel
export function totalFuel(sim) {
  const f = sim.ac.fuelKg || {};
  return num(f.L) + num(f.C) + num(f.R);
}

/** Decide which tank feeds engine `i` (0=L, 1=R); returns 'L'|'C'|'R'|null. */
function feedTank(sim, i) {
  const fu = sim.systems.fuel, p = fu.pumps, tanks = sim.ac.fuelKg;
  const side = SIDES[i];
  const ctrPump = i === 0 ? p.cL : p.cR;
  if (ctrPump && num(tanks.C) > 0) return 'C';                // centre pumps override the mains
  const xfeed = fu.xfeedFwd || fu.xfeedAft;
  if (xfeed) {
    // with crossfeed open, the manifold draws from the fuller (pumped) main tank
    const other = SIDES[1 - i];
    const otherPumped = other === 'L' ? (p.lFwd || p.lAft) : (p.rFwd || p.rAft);
    if (otherPumped && num(tanks[other]) > num(tanks[side]) + 50) return other;
  }
  if (num(tanks[side]) > 1) return side;
  if (xfeed && num(tanks[SIDES[1 - i]]) > 1) return SIDES[1 - i];
  return null;
}

function stepFuel(sim, dt) {
  const fu = sim.systems.fuel, p = fu.pumps, tanks = sim.ac.fuelKg;
  if (!tanks) return;
  const pw = sim.systems.elec.acPowered;
  fu.press.L = pw && (((p.lFwd || p.lAft) && num(tanks.L) > 1) || (p.cL && num(tanks.C) > 1));
  fu.press.R = pw && (((p.rFwd || p.rAft) && num(tanks.R) > 1) || (p.cR && num(tanks.C) > 1));
  if (fu.xfeedFwd || fu.xfeedAft) { const any = fu.press.L || fu.press.R; fu.press.L = fu.press.R = any; }
  // burn: engines (physics-computed ff, kg/h) + APU, from the selected feed tank
  [0, 1].forEach((i) => {
    const e = sim.engines[i];
    const tank = feedTank(sim, i);
    fu.feedFrom[i] = tank;
    // suction feed works below ~FL250 without boost pumps; above that the engine starves
    const altFt = num(sim.ac.altMSL) / FT;
    const suctionOk = altFt < 25000;
    fu.starved[i] = !tank || (!fu.press[SIDES[i]] && !suctionOk);
    const burn = Math.max(0, num(e && e.ff)) * dt / 3600;
    if (tank && burn > 0) { tanks[tank] = Math.max(0, num(tanks[tank]) - burn); fu.burnedKg += burn; }
  });
  const apu = sim.systems.apu;
  if (apu.state === 'RUN' || (apu.state === 'STARTING' && apu.timer > 10)) {
    const tank = num(tanks.L) > 1 ? 'L' : num(tanks.C) > 1 ? 'C' : num(tanks.R) > 1 ? 'R' : null;
    fu.apuFeed = tank;
    const burn = APU_BURN_KGH * dt / 3600;
    if (tank) { tanks[tank] = Math.max(0, num(tanks[tank]) - burn); fu.burnedKg += burn; }
  }
  fu.totalKg = totalFuel(sim);
  fu.imbalanceKg = Math.abs(num(tanks.L) - num(tanks.R));
}

// ----------------------------------------------------------- engine start
/**
 * Engine state machine (autostart). Physics reacts to `startState`:
 *  'STARTING' + fuel CUTOFF   -> dry motoring (starter only, N2 ~20-25 %)
 *  'STARTING' + fuel RUN      -> starter + fuel/ignition once N2 > ~18 %, spool towards idle (~60 % N2)
 *  'RUN'                      -> normal running engine
 *  'OFF'                      -> spool down
 */
function stepEngineStart(sim, dt) {
  const c = sim.controls, st = sim.systems.start, fu = sim.systems.fuel, air = sim.systems.air;
  const dc = sim.systems.elec.dcPowered;
  [0, 1].forEach((i) => {
    const e = sim.engines[i];
    if (!e) return;
    const fuelRun = c.fuelControl[i] === 'RUN' && !sim.systems.fire.handle[i];
    const n2 = num(e.n2);
    const airOk = air.ductPsi >= DUCT_START_MIN_PSI;
    const windmill = !sim.ac.onGround && n2 > 12 && num(sim.ac.cas) / KT > 200;
    const selector = !!c.engStart[i];
    st.ignition[i] = false;
    switch (e.startState) {
      case 'RUN':
        if (!fuelRun || fu.starved[i]) { e.startState = 'OFF'; e.running = false; }
        else if (selector) c.engStart[i] = false;  // nothing to start
        break;
      case 'STARTING': {
        st.timer[i] += dt;
        const motoring = selector && airOk && dc;
        if (!motoring && !(windmill && fuelRun)) { e.startState = 'OFF'; c.engStart[i] = false; break; }
        if (fuelRun && n2 >= N2_LIGHTOFF_MIN) st.ignition[i] = true;
        if (fuelRun && n2 >= N2_STARTER_CUTOUT) { e.startState = 'RUN'; c.engStart[i] = false; st.timer[i] = 0; }
        // autostart: hung/no light-off protection -> abort after 90 s
        if (st.autostart && st.timer[i] > 90) { e.startState = 'OFF'; c.engStart[i] = false; st.timer[i] = 0; sim.systems.start.lastAbort = SIDES[i]; }
        break;
      }
      default: // 'OFF'
        if (selector && airOk && dc) { e.startState = 'STARTING'; st.timer[i] = 0; }
        else if (windmill && fuelRun && (selector || st.autostart) && n2 > 15) { e.startState = 'STARTING'; st.timer[i] = 0; } // in-flight relight
    }
    // selector pulled but no bleed air / DC: the start valve cannot open (EICAS shows it)
    st.waitingAir = st.waitingAir || [false, false];
    st.waitingAir[i] = selector && e.startState === 'OFF' && !(airOk && dc);
  });
}

// ------------------------------------------------------------------- fire
function stepFire(sim, dt) {
  const f = sim.systems.fire;
  [0, 1].forEach((i) => {
    if (f.handle[i] && f.discharged[i]) {
      f.timer[i] += dt;
      if (f.timer[i] > 4 && sim.engines[i]) sim.engines[i].fire = false; // bottle extinguishes the fire
    }
    if (!f.handle[i]) { f.discharged[i] = false; f.timer[i] = 0; }
  });
}

// ------------------------------------------------------------ hydraulics
function stepHydraulics(sim, dt) {
  const h = sim.systems.hyd, p = h.pumps, r = h.run;
  const ac = sim.systems.elec.acPowered, duct = sim.systems.air.ductPsi > 15;
  const eng = [0, 1].map((i) => engRunning(sim.engines[i]) || num(sim.engines[i] && sim.engines[i].n2) > 40);
  // demand: flaps or gear moving / large control activity
  const s = sim.surfaces;
  const demand = Math.abs(num(s.flapsDeg) - num(s.flapsTarget)) > 0.2 || Math.abs(num(s.gear) - num(s.gearTarget)) > 0.01;
  const auto = (sel, needed) => sel === 'ON' || (sel === 'AUTO' && needed);
  r.engL = p.engL && eng[0] && !sim.systems.fire.handle[0];
  r.engR = p.engR && eng[1] && !sim.systems.fire.handle[1];
  r.elecC1 = p.elecC1 && ac;
  r.elecC2 = p.elecC2 && ac;
  r.demL = ac && auto(p.demL, !r.engL || demand || !sim.ac.onGround && sim.controls.flapLever > 0);
  r.demR = ac && auto(p.demR, !r.engR || demand || !sim.ac.onGround && sim.controls.flapLever > 0);
  r.demC1 = duct && auto(p.demC1, demand || !(r.elecC1 || r.elecC2));
  r.demC2 = duct && auto(p.demC2, demand && !sim.ac.onGround || !(r.elecC1 || r.elecC2));
  const tgt = {
    L: r.engL || r.demL ? HYD_NOMINAL : 0,
    C: r.elecC1 || r.elecC2 || r.demC1 || r.demC2 ? HYD_NOMINAL : 0,
    R: r.engR || r.demR ? HYD_NOMINAL : 0,
  };
  for (const k of ['L', 'C', 'R']) {
    const target = tgt[k] ? tgt[k] + 60 * Math.sin(sim.time * 0.7 + k.charCodeAt(0)) * 0.3 : 0;
    h.press[k] = clamp(lag(num(h.press[k]), target, tgt[k] ? 1.2 : 5, dt || 1e-3), 0, 3200);
  }
  h.lowPress = { L: h.press.L < 1200, C: h.press.C < 1200, R: h.press.R < 1200 };
  // display shape: hyd.{L,C,R}.{press,qty,pumps}
  h.L = { press: h.press.L, qty: h.qty.L, pumps: { EDP: r.engL, ACMP: r.demL } };
  h.C = { press: h.press.C, qty: h.qty.C, pumps: { 'ACMP C1': r.elecC1, 'ACMP C2': r.elecC2, 'ADP C1': r.demC1, 'ADP C2': r.demC2 } };
  h.R = { press: h.press.R, qty: h.qty.R, pumps: { EDP: r.engR, ACMP: r.demR } };
}

// -------------------------------------------------------- pressurization
function stepPressurization(sim, dt) {
  const pr = sim.systems.press, air = sim.systems.air;
  const altM = num(sim.ac.altMSL), altFt = altM / FT;
  const pAmb = isaPressure(altM);
  const packs = air.packOn[0] || air.packOn[1];
  // landing field elevation: FMC destination when known, else origin / current
  const dest = sim.fmc && (sim.fmc.dest || sim.fmc.origin);
  pr.landingAltFt = dest && Number.isFinite(dest.elevFt) ? dest.elevFt : pr.landingAltFt ?? 0;
  let target;
  if (sim.ac.onGround) target = altFt;
  else {
    // schedule: cabin ≈ 0.2 × aircraft altitude, max 8000 ft, limited by max differential pressure
    const minCabinP = Math.min(isaPressure(pr.landingAltFt * FT), pAmb + MAX_DIFF_PSI * PA_PER_PSI);
    target = Math.max(Math.min(8000, Math.max(pr.landingAltFt, altFt * 0.2)), isaAltFromPressure(minCabinP) / FT);
    target = Math.min(target, altFt);
  }
  if (!packs && !sim.ac.onGround) target = altFt;      // no air supply: cabin leaks up towards ambient
  pr.targetFt = target;
  const climbRate = packs ? 500 : 2000, descRate = packs ? 350 : 2000;  // fpm
  const prev = num(pr.cabinAltFt, altFt);
  pr.cabinAltFt = approach(prev, target, (target > prev ? climbRate : descRate) / 60, dt);
  pr.cabinRateFpm = dt > 0 ? lag(num(pr.cabinRateFpm), (pr.cabinAltFt - prev) / dt * 60, 2, dt) : 0;
  pr.diffPsi = Math.max(0, (isaPressure(pr.cabinAltFt * FT) - pAmb) / PA_PER_PSI);
  pr.outflow = sim.ac.onGround ? 1 : clamp(1 - pr.diffPsi / MAX_DIFF_PSI, 0.05, 1);
}

// ---------------------------------------------- ADIRU, signs, anti-ice, xpdr
function stepMisc(sim, dt) {
  const s = sim.systems, ac = sim.ac;
  // ADIRU
  const ad = s.adiru;
  if (!ad.on || !s.elec.dcPowered) { ad.aligned = false; ad.alignRemaining = ad.on ? ADIRU_ALIGN_S : 0; }
  else if (!ad.aligned) {
    if (!ad.alignRemaining) ad.alignRemaining = ADIRU_ALIGN_S;
    if (ac.onGround && num(ac.gs) < 1) ad.alignRemaining = Math.max(0, ad.alignRemaining - dt);
    if (ad.alignRemaining <= 0) ad.aligned = true;
  }
  ad.onBat = ad.on && !s.elec.acPowered && s.elec.battBus;
  // passenger signs (AUTO logic)
  const altFt = num(ac.altMSL) / FT;
  const low = altFt < 10300 || sim.controls.gearLever === 'DOWN' || sim.controls.flapLever > 0;
  const powered = s.elec.dcPowered;
  s.signs.seatbeltsLit = powered && (s.signs.seatbelts === 'ON' || (s.signs.seatbelts === 'AUTO' && (low || s.press.cabinAltFt > 10000)));
  s.signs.noSmokingLit = powered && (s.signs.noSmoking === 'ON' || (s.signs.noSmoking === 'AUTO' && (sim.controls.gearLever === 'DOWN' || altFt < 10300)));
  // anti-ice: AUTO uses the ice detectors (sim.env.icing set by weather, optional)
  const sat = 15 - 1.98 * altFt / 1000 + num(sim.env && sim.env.tempDevC);
  s.antiIce.iceDetected = !!(sim.env && sim.env.icing) && sat < 8 && sat > -40;
  const duct = s.air.ductPsi > 10;
  s.antiIce.wingOn = duct && !ac.onGround && (s.antiIce.wing === 'ON' || (s.antiIce.wing === 'AUTO' && s.antiIce.iceDetected));
  s.antiIce.engOn = [0, 1].map((i) => engRunning(sim.engines[i]) &&
    (s.antiIce.eng[i] === 'ON' || (s.antiIce.eng[i] === 'AUTO' && s.antiIce.iceDetected)));
  // transponder IDENT lasts 18 s
  if (s.xpdr.ident) { s.xpdr.identTimer += dt; if (s.xpdr.identTimer > 18) { s.xpdr.ident = false; s.xpdr.identTimer = 0; } }
  // lights need power
  s.lights.powered = powered;
}

// ------------------------------------------------------ speedbrake automation
function stepSpeedbrake(sim) {
  const c = sim.controls, ac = sim.ac, s = sim.systems;
  const idle = c.throttle[0] < 0.08 && c.throttle[1] < 0.08;
  const p = s._prev;
  if (ac.onGround) {
    // auto-deploy on landing (armed + idle) or on RTO (reverse levers raised above ~85 kt)
    const rto = num(ac.cas) / KT > 85 && (c.reverse[0] > 0.1 || c.reverse[1] > 0.1);
    if ((c.speedbrakeArmed && idle && (p.wasAir || p.sbDeployedOnce)) || rto) {
      if (c.speedbrakeLever < 1) { c.speedbrakeLever = 1; p.sbAutoDeployed = true; }
      c.speedbrakeArmed = false;
    }
    // auto-stow when either thrust lever is advanced
    if (p.sbAutoDeployed && (c.throttle[0] > 0.35 || c.throttle[1] > 0.35)) { c.speedbrakeLever = 0; p.sbAutoDeployed = false; }
  } else {
    p.sbAutoDeployed = false;
  }
}

// ------------------------------------------------------------- autobrake
function stepAutobrake(sim, dt) {
  const c = sim.controls, ac = sim.ac, ab = sim.systems.autobrake, p = sim.systems._prev;
  const sel = c.autobrake;
  const gs = num(ac.gs), casKt = num(ac.cas) / KT;
  // measured deceleration (filtered)
  const decel = dt > 0 ? -(gs - num(p.gs)) / dt : 0;
  ab.decel = lag(num(ab.decel), clamp(decel, -10, 10), 0.4, dt || 1e-3);
  p.gs = gs;
  const idle = c.throttle[0] < 0.08 && c.throttle[1] < 0.08;
  const pilotBrake = Math.max(num(c.pilotBrakeL), num(c.pilotBrakeR));
  ab.disarmReason = ab.disarmReason || '';
  // RTO: after a normal takeoff it switches to OFF
  if (sel === 'RTO' && !ac.onGround && p.airborneT > 3) c.autobrake = 'OFF';
  let active = false;
  if (ac.onGround && gs > 1.5 * KT) {
    if (sel === 'RTO') active = casKt > 85 && idle && p.groundT > 2 || (ab.active && ab.target === 'RTO');
    else if (['1', '2', '3', '4', 'MAX'].includes(sel)) active = idle && (p.wasAir || ab.active);
  }
  // disarm: pilot braking or thrust advance during an autobrake application
  if (ab.active && (pilotBrake > 0.6 || (!idle && c.throttle.some((t) => t > 0.3)) ||
      (c.speedbrakeLever < 0.1 && p.sbWasUp && sel !== 'RTO'))) {
    c.autobrake = 'DISARM'; ab.disarmReason = pilotBrake > 0.6 ? 'BRAKES' : 'THRUST'; active = false;
  }
  p.sbWasUp = c.speedbrakeLever > 0.5;
  // physics (gear.js) applies the autobrake pressure itself and reports surfaces.autobrakeState;
  // when present we follow it for the mode logic (DISARM caution) and do not command brakes.
  const phys = sim.surfaces && sim.surfaces.autobrakeState;
  if (phys) {
    if (phys === 'DISARMED' && ['1', '2', '3', '4', 'MAX', 'RTO'].includes(c.autobrake)) { c.autobrake = 'DISARM'; ab.disarmReason = 'PHYSICS'; }
    ab.active = phys === 'ACTIVE'; ab.cmd = 0; ab.physics = true;
    return;
  }
  if (!ac.onGround || gs <= 1.5 * KT) active = false;
  ab.active = active;
  ab.target = active ? sel : '';
  ab.decelTarget = active ? AUTOBRAKE_DECEL[sel] || 0 : 0;
  if (active) {
    // PI-ish controller on deceleration (MAX/RTO = full pressure)
    const err = ab.decelTarget - ab.decel;
    const base = sel === 'RTO' || sel === 'MAX' ? 1 : ab.decelTarget / 4.5;
    ab.i = clamp(num(ab.i) + err * 0.08 * dt, -0.5, 0.6);
    ab.cmd = clamp(base + err * 0.15 + ab.i, 0, 1);
  } else { ab.cmd = 0; ab.i = 0; }
}

// ------------------------------------------- brakes, tyres, doors, temperatures
function stepGearDoorsTemps(sim, dt) {
  const s = sim.systems, ac = sim.ac, g = s.gear;
  // brake temperature index (0..10 as on the GEAR synoptic): heats with brake energy, cools slowly
  const gs = Math.max(0, num(ac.gs));
  const brakes = (sim.surfaces && sim.surfaces.brakes) || [sim.controls.brakeL, sim.controls.brakeR];
  for (let k = 0; k < 12; k++) {
    const side = k < 6 ? 0 : 1;
    const heat = ac.onGround ? num(brakes[side]) * gs * 0.0016 * (0.9 + 0.2 * ((k * 7) % 3) / 2) : 0;
    const cool = (num(g.brakeTemp[k], 1) - 1) * (ac.onGround ? 0.004 : 0.012);
    g.brakeTemp[k] = clamp(num(g.brakeTemp[k], 1) + (heat - cool) * dt, 0, 10);
    g.tirePsi[k] = 205 + 2 * ((k * 5) % 4) + g.brakeTemp[k] * 2;
  }
  // doors: open at the gate in cold & dark; the ground crew closes them when the beacon goes ON
  if (s.lights.beacon || !ac.onGround) for (const d of DOOR_NAMES) s.doors[d] = false;
  // temperatures (ISA + deviation), TAT with full ram rise
  const altM = num(ac.altMSL);
  const satK = 288.15 - 0.0065 * Math.min(altM, 11000) + num(sim.env && sim.env.tempDevC);
  s.air.satC = satK - 273.15;
  s.air.tatC = satK * (1 + 0.2 * num(ac.mach) ** 2) - 273.15;
  s.fuel.tempC = lag(num(s.fuel.tempC, 15), Math.max(s.air.tatC, -45) + 5, 1800, dt || 1e-3);
}

// -------------------------------------------------------------- utilities
/** Convenience used by overhead/pedestal/tests: is the engine i ready (RUN)? */
export function engineIsRunning(sim, i) { return engRunning(sim.engines[i]); }
/** Flap angle (deg) of the current lever detent. */
export const flapLeverDeg = (sim) => FLAP_DETENTS[clamp(Math.round(num(sim.controls.flapLever)), 0, FLAP_DETENTS.length - 1)];
