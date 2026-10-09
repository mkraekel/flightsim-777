// Crew alerting (Team D2): EICAS messages, master WARNING/CAUTION latches, takeoff/landing
// configuration warnings, overspeed, stall warning (stick shaker), EGPWS modes 1-6 and
// radio-altitude / minimums callouts. Pure logic (no DOM): runs under Node.
//
// Writes sim.alerts:
//   list: [{ id, text, level:'warning'|'caution'|'advisory'|'memo', since }] sorted for display
//   masterWarning / masterCaution: latched lights (reset with resetMaster())
//   aural: { siren, fireBell, wailer, shaker }   continuous sounds the audio module renders
//   gpws:  'PULL UP' | null   (red PFD banner, read by Team C);  pullUp: bool
//   egpws: { active:'<aural id>', pullUp, terrain, glideslope }  detailed EGPWS state
//   stickShaker, overspeed, limits:{ vmaxKt, alphaWarnDeg }
// Emits sim.events 'aural' { id, priority } for one-shot sounds & voice callouts.

import { FLAP_DETENTS } from '../core/state.js';
import { FT, KT, FPM, RAD, clamp, lag } from '../core/geo.js';

export const LEVELS = ['warning', 'caution', 'advisory', 'memo'];   // lowercase (displays convention)
const RANK = { warning: 0, caution: 1, advisory: 2, memo: 3 };

export const VMO_KT = 330;
export const MMO = 0.89;
/** Flap placard speeds (kt) per flap detent (deg), 777-300ER. */
export const FLAP_PLACARD_KT = { 1: 255, 5: 235, 15: 215, 20: 195, 25: 185, 30: 170 };
const GEAR_VLE_KT = 270, GEAR_MLE = 0.82;
/** Stick-shaker angle of attack (deg) by flap angle. */
const SHAKER_ALPHA = [[0, 11], [1, 12], [5, 12.5], [15, 13], [20, 13.5], [25, 14], [30, 14]];

/** Voice priorities (higher pre-empts lower in the audio speech queue). */
export const VOICE_PRIORITY = {
  pull_up: 10, terrain: 9, too_low_terrain: 8, too_low_gear: 8, too_low_flaps: 8, sink_rate: 7, dont_sink: 7,
  bank_angle: 6, glideslope: 5, minimums: 4, approaching_minimums: 4,
  ra2500: 3, ra1000: 3, ra500: 3, ra100: 3, ra50: 3, ra40: 3, ra30: 3, ra20: 3, ra10: 3, v1: 3, rotate: 3, positive_rate: 2,
};
/** Approximate spoken durations (s) — used to space repeated GPWS warnings. */
const VOICE_LEN = { pull_up: 1.6, terrain: 1.6, too_low_terrain: 1.6, too_low_gear: 1.6, too_low_flaps: 1.6, sink_rate: 1.6,
  dont_sink: 1.6, bank_angle: 2.2, glideslope: 1.6 };
const RA_CALLOUTS = [2500, 1000, 500, 100, 50, 40, 30, 20, 10];
const SIREN_IDS = new Set(['CONFIG FLAPS', 'CONFIG SPOILERS', 'CONFIG PARKING BRAKE', 'CONFIG STABILIZER', 'CONFIG GEAR',
  'OVERSPEED', 'CABIN ALTITUDE']);

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

// ------------------------------------------------------------------ helpers
/** Stick-shaker AoA threshold (deg) for a flap angle. */
export function stallAlphaWarnDeg(flapsDeg) {
  const f = clamp(num(flapsDeg), 0, 30);
  for (let i = 1; i < SHAKER_ALPHA.length; i++) {
    const [f0, a0] = SHAKER_ALPHA[i - 1], [f1, a1] = SHAKER_ALPHA[i];
    if (f <= f1) return a0 + (a1 - a0) * (f - f0) / (f1 - f0);
  }
  return 14;
}

/** Current maximum speed (kt CAS) from Vmo/Mmo, flap placard and gear limit. */
export function maxSpeedKt(sim) {
  const ac = sim.ac, s = sim.surfaces;
  const mach = num(ac.mach), cas = num(ac.cas);
  // CAS at which Mmo is reached at the current altitude (CAS/Mach ratio is ~constant locally)
  const mmoKt = mach > 0.05 ? (cas / mach) * MMO / KT : Infinity;
  let v = Math.min(VMO_KT, mmoKt);
  const fd = num(s.flapsDeg);
  if (fd > 0.5) {
    const det = FLAP_DETENTS.find((d) => d > 0 && d >= fd - 0.5) || 30;
    v = Math.min(v, FLAP_PLACARD_KT[det] || 170);
  }
  if (num(s.gear) > 0.02) v = Math.min(v, GEAR_VLE_KT, mach > 0.05 ? (cas / mach) * GEAR_MLE / KT : Infinity);
  return v;
}

function internal(sim) {
  const a = sim.alerts;
  if (!a._i) {
    a._i = {
      known: new Map(), raPrev: null, raArmed: {}, minsArmed: { app: false, mins: false }, lastMinsT: -99,
      raRate: 0, gpwsNext: {}, prevAp: !!(sim.ap && sim.ap.apEngaged), prevAt: !!(sim.ap && sim.ap.atEngaged),
      atDisc: false, apDiscFallback: false, apWailT: 0, gearMismatchT: 0, liftoffMaxAlt: 0, prevOnGround: !!sim.ac.onGround,
      prevCas: 0, v1Done: false, vrDone: false, shakerPrev: false, overspeedPrev: false, osLatched: false,
    };
    a.aural = { siren: false, fireBell: false, wailer: false, shaker: false };
    a.egpws = { active: '', pullUp: false, terrain: false, glideslope: false };
    a.gpws = null; a.pullUp = false;
    a.stickShaker = false; a.overspeed = false; a.limits = { vmaxKt: VMO_KT, alphaWarnDeg: 11 };
    a.options = a.options || { v1Callout: true, rotateCallout: false };
  }
  return a._i;
}

function aural(sim, id, extra) {
  sim.events && sim.events.emit('aural', { id, priority: VOICE_PRIORITY[id] || 0, t: sim.time, ...extra });
}

// ------------------------------------------------------------------ main step
/** Evaluate all alerting logic for this frame. Never throws. */
export function stepAlerts(sim, dt) {
  try {
    if (!sim.alerts) sim.alerts = { list: [], masterWarning: false, masterCaution: false };
    dt = clamp(num(dt), 0, 1);
    const st = internal(sim);
    trackAutoflight(sim, st, dt);
    evaluateEnvelope(sim, st);
    const msgs = collectMessages(sim, st, dt);
    updateList(sim, st, msgs);
    stepGpws(sim, st, dt);
    stepCallouts(sim, st);
    updateAurals(sim, st, dt);
    st.prevOnGround = !!sim.ac.onGround;
  } catch (err) {
    if (!stepAlerts._warned) { console.warn('stepAlerts:', err); stepAlerts._warned = true; }
  }
}

/** Reset (extinguish) the master WARNING and/or CAUTION lights. */
export function resetMaster(sim, which = 'both') {
  const a = sim.alerts; if (!a) return;
  const st = internal(sim);
  if (which !== 'caution') {
    a.masterWarning = false;
    st.apDiscFallback = false; // fallback AP-disc message is cleared by the reset
    st.fireSilenced = true;
  }
  if (which !== 'warning') a.masterCaution = false;
}

/** Second push of the A/T disconnect switch removes the AUTOTHROTTLE DISC caution. */
export function acknowledgeATDisc(sim) {
  if (sim.alerts) internal(sim).atDisc = false;
  if (sim.ap && 'atDiscWarning' in sim.ap) sim.ap.atDiscWarning = false;
}

// -------------------------------------------------------------- autoflight
function trackAutoflight(sim, st, dt) {
  const ap = sim.ap || {};
  const apOn = !!ap.apEngaged, atOn = !!ap.atEngaged;
  // The AFDS (D1) owns ap.discWarning / ap.atDiscWarning and emits the 'ap_disc'/'at_disc' aurals;
  // without it we emulate both.
  const afds = 'discWarning' in ap;
  if (st.prevAt && !atOn && !afds) { st.atDisc = true; aural(sim, 'at_disc'); }
  if (atOn) st.atDisc = false;
  if (st.prevAp && !apOn && !afds) { aural(sim, 'ap_disc'); st.apDiscFallback = true; st.apWailT = 3; }
  if (apOn) st.apDiscFallback = false;
  st.apWailT = Math.max(0, st.apWailT - dt);
  st.prevAp = apOn; st.prevAt = atOn;
}

// ---------------------------------------------------- stall & overspeed logic
function evaluateEnvelope(sim, st) {
  const a = sim.alerts, ac = sim.ac;
  const vmax = maxSpeedKt(sim);
  const alphaWarn = stallAlphaWarnDeg(sim.surfaces.flapsDeg);
  a.limits.vmaxKt = vmax; a.limits.alphaWarnDeg = alphaWarn;
  const casKt = num(ac.cas) / KT, alphaDeg = num(ac.alpha) * RAD;
  const airborne = !ac.onGround && num(ac.ra) / FT > 5;
  // overspeed with 2 kt hysteresis
  st.osLatched = st.osLatched ? casKt > vmax - 2 : casKt > vmax + 1;
  a.overspeed = st.osLatched;
  if (a.overspeed && !st.overspeedPrev) aural(sim, 'overspeed');
  st.overspeedPrev = a.overspeed;
  // stick shaker with 0.5° hysteresis, also driven by FBW stall protection flag
  const shaker = airborne && (st.shakerPrev ? alphaDeg > alphaWarn - 0.5 : alphaDeg > alphaWarn);
  a.stickShaker = shaker;
  if (shaker && !st.shakerPrev) aural(sim, 'stall');
  st.shakerPrev = shaker;
  a.airspeedLow = airborne && alphaDeg > alphaWarn - 1.5;
}

// ---------------------------------------------------------- EICAS messages
function takeoffConfig(sim, add) {
  const c = sim.controls, ac = sim.ac, s = sim.surfaces;
  const advanced = c.throttle[0] > 0.55 || c.throttle[1] > 0.55;
  const v1 = num(sim.fmc && sim.fmc.v1) > 60 ? sim.fmc.v1 : 150;
  if (!ac.onGround || !advanced || num(ac.cas) / KT > v1) return;
  const lever = FLAP_DETENTS[clamp(Math.round(num(c.flapLever)), 0, 6)];
  const toFlap = [5, 15, 20].includes(lever) && Math.abs(num(s.flapsDeg, lever) - lever) < 1.5;
  if (!toFlap) add('CONFIG FLAPS', 'warning');
  if (num(c.speedbrakeLever) > 0.05) add('CONFIG SPOILERS', 'warning');
  if (c.parkingBrake) add('CONFIG PARKING BRAKE', 'warning');
  const stab = s.stabUnits;
  if (Number.isFinite(stab) && (stab < 1.5 || stab > 11.5)) add('CONFIG STABILIZER', 'warning');
}

function landingConfig(sim, add) {
  const c = sim.controls, ac = sim.ac, s = sim.surfaces;
  if (ac.onGround || sim.systems.phase === 'TAKEOFF') return;
  const gearDown = num(s.gear, 1) > 0.99 && c.gearLever === 'DOWN';
  const raFt = num(ac.ra) / FT;
  const idle = c.throttle[0] < 0.1 && c.throttle[1] < 0.1;
  const lever = FLAP_DETENTS[clamp(Math.round(num(c.flapLever)), 0, 6)];
  if (!gearDown && (lever >= 25 || (idle && raFt < 800 && num(ac.vs) < 0))) add('CONFIG GEAR', 'warning');
}

function engineMessages(sim, add) {
  const c = sim.controls, ac = sim.ac, sys = sim.systems;
  const phaseActive = !ac.onGround || c.throttle.some((t) => t > 0.5);
  sim.engines.forEach((e, i) => {
    const L = i === 0 ? 'L' : 'R';
    if (e.fire) add(`FIRE ENG ${L}`, 'warning');
    const cutoff = c.fuelControl[i] === 'CUTOFF' || (sys.fire && sys.fire.handle[i]);
    if (!cutoff && e.startState !== 'RUN' && phaseActive && num(e.n2) < 55) add(`ENG FAIL ${L}`, 'caution');
    if (cutoff && !ac.onGround) add(`ENG SHUTDOWN ${L}`, 'advisory');
    if (e.startState === 'RUN' && sys.fuel && !sys.fuel.press[L]) add(`FUEL PRESS ENG ${L}`, 'caution');
    if (e.startState === 'RUN' && sys.air && !sys.air.engBleed[i]) add(`BLEED OFF ENG ${L}`, 'advisory');
  });
}

function systemsMessages(sim, add, st, dt) {
  const sys = sim.systems, c = sim.controls, ac = sim.ac;
  if (!sys || !sys.elec) return;
  const anyEng = sim.engines.some((e) => e.startState === 'RUN');
  const active = !ac.onGround || anyEng;
  if (sys.press && sys.press.cabinAltFt > 10000) add('CABIN ALTITUDE', 'warning');
  // hydraulics / electrics
  if (active) {
    for (const k of ['L', 'C', 'R']) if (sys.hyd.press[k] < 1200) add(`HYD PRESS SYS ${k}`, 'caution');
    [0, 1].forEach((i) => {
      const L = i === 0 ? 'L' : 'R';
      if (!sys.elec.acBus[i]) add(`ELEC AC BUS ${L}`, 'caution');
      if (sim.engines[i].startState === 'RUN' && !sys.elec.idgOnline[i]) add(`ELEC GEN OFF ${L}`, 'advisory');
    });
  }
  if (!sys.elec.battery && sys.elec.acPowered) add('BATTERY OFF', 'caution');
  // fuel
  const f = ac.fuelKg || {};
  if (sys.fuel && (num(f.L) + num(f.R)) > 0 && (num(f.L) < 2000 || num(f.R) < 2000)) add('FUEL QTY LOW', 'caution');
  if (sys.fuel && sys.fuel.imbalanceKg > 1500) add('FUEL IMBALANCE', 'advisory');
  // speedbrake extended (airborne, low or with thrust)
  const raFt = num(ac.ra) / FT;
  const lever = FLAP_DETENTS[clamp(Math.round(num(c.flapLever)), 0, 6)];
  if (!ac.onGround && num(c.speedbrakeLever) > 0.05 &&
      ((raFt > 15 && raFt < 800) || lever >= 25 || c.throttle.some((t) => t > 0.4))) add('SPEEDBRAKE EXTENDED', 'caution');
  // gear disagree: lever and gear position differ for more than 20 s
  const gearPos = num(sim.surfaces.gear, 1);
  const mismatch = (c.gearLever === 'DOWN' && gearPos < 0.99) || (c.gearLever === 'UP' && gearPos > 0.01);
  st.gearMismatchT = mismatch ? st.gearMismatchT + dt : 0;
  if (st.gearMismatchT > 20) add('GEAR DISAGREE', 'caution');
  if (c.autobrake === 'DISARM') add('AUTOBRAKE', 'caution');
  if (sim.alerts.airspeedLow) add('AIRSPEED LOW', 'caution');
  // air
  sys.air.packs.forEach((p, i) => { if (p === 'OFF' && sys.elec.dcPowered) add(`PACK ${i ? 'R' : 'L'}`, 'advisory'); });
  if (!sys.start.autostart) add('AUTOSTART OFF', 'advisory');
  if (!ac.onGround && sys.xpdr.mode === 'STBY') add('TCAS OFF', 'advisory');
  if (sys.elec.dcPowered && !sys.adiru.on && (anyEng || !ac.onGround)) add('NAV ADIRU INERTIAL', 'caution');
}

function memoMessages(sim, add) {
  const sys = sim.systems, c = sim.controls;
  if (!sys || !sys.elec || !sys.elec.dcPowered) return;
  if (c.parkingBrake) add('PARKING BRAKE SET', 'memo');
  if (c.speedbrakeArmed) add('SPEEDBRAKE ARMED', 'memo');
  if (c.autobrake && !['OFF', 'DISARM'].includes(c.autobrake)) add(`AUTOBRAKE ${c.autobrake}`, 'memo');
  if (sys.apu.state === 'RUN') add('APU RUNNING', 'memo');
  if (sys.elec.extOnline) add('EXT PWR ON', 'memo');
  if (sys.signs.seatbeltsLit) add('SEATBELTS ON', 'memo');
  if (sys.signs.noSmokingLit) add('NO SMOKING ON', 'memo');
  if (sys.antiIce.engOn.some(Boolean)) add('ENG ANTI-ICE', 'memo');
  if (sys.antiIce.wingOn) add('WING ANTI-ICE', 'memo');
  if (sys.adiru.on && !sys.adiru.aligned) add('ADIRU ALIGN', 'memo');
  if (sys.fuel.xfeedFwd || sys.fuel.xfeedAft) add('CROSSFEED OPEN', 'memo');
  sim.engines.forEach((e, i) => { if (e.startState === 'STARTING') add(`ENG ${i ? 'R' : 'L'} START`, 'memo'); });
}

function collectMessages(sim, st, dt) {
  const out = new Map();
  const add = (text, level) => { if (!out.has(text)) out.set(text, level); };
  takeoffConfig(sim, add);
  landingConfig(sim, add);
  if (sim.alerts.overspeed) add('OVERSPEED', 'warning');
  const ap = sim.ap || {};
  if (ap.discWarning || st.apDiscFallback) add('AUTOPILOT DISC', 'warning');
  if ('atDiscWarning' in ap ? ap.atDiscWarning : st.atDisc) add('AUTOTHROTTLE DISC', 'caution');
  engineMessages(sim, add);
  systemsMessages(sim, add, st, dt);
  memoMessages(sim, add);
  return out;
}

/** Merge the current message set into sim.alerts.list, latch master lights for new items. */
function updateList(sim, st, msgs) {
  const a = sim.alerts, now = num(sim.time);
  const inhibitCaution = sim.systems && sim.systems.phase === 'TAKEOFF'; // T/O inhibit for cautions
  let newWarning = null, newCaution = false;
  for (const [text, level] of msgs) {
    if (!st.known.has(text)) {
      st.known.set(text, { since: now, level });
      if (level === 'warning') newWarning = newWarning || text;
      if (level === 'caution' && !inhibitCaution) newCaution = true;
    }
  }
  for (const text of [...st.known.keys()]) if (!msgs.has(text)) st.known.delete(text);
  if (newWarning) {
    a.masterWarning = true;
    if (newWarning.startsWith('FIRE')) st.fireSilenced = false;
    // config/overspeed/cabin have their own siren; AP disc its wailer; fire the bell
    aural(sim, 'master_warning', { cause: newWarning });
    if (newWarning.startsWith('CONFIG')) aural(sim, newWarning === 'CONFIG GEAR' ? 'gear_horn' : 'config');
  }
  if (newCaution) { a.masterCaution = true; aural(sim, 'master_caution'); }
  a.list = [...st.known.entries()]
    .map(([text, v]) => ({ id: text, text, level: v.level, since: v.since }))
    .sort((x, y) => RANK[x.level] - RANK[y.level] || y.since - x.since || (x.text < y.text ? -1 : 1));
  if (!a.list.some((m) => m.level === 'warning')) a.masterWarning = false;
  if (!a.list.some((m) => m.level === 'caution')) a.masterCaution = false;
}

// ------------------------------------------------------------------- EGPWS
function gpwsSay(sim, st, id, interval) {
  const next = st.gpwsNext[id] ?? -1;
  if (sim.time >= next) {
    aural(sim, id);
    st.gpwsNext[id] = sim.time + (interval || VOICE_LEN[id] || 2) + 0.4;
  }
}

/** Glideslope deviation in dots, + = aircraft BELOW the glide path (fly up). */
function gsBelowDots(sim) {
  const ils = sim.nav && sim.nav.ils;
  if (!ils || !ils.valid) return 0;
  return -num(ils.gsDots); // navradio: gsDots + = ABOVE the path
}

function stepGpws(sim, st, dt) {
  const a = sim.alerts, ac = sim.ac, c = sim.controls, g = a.egpws;
  const raFt = num(ac.ra) / FT, sinkFpm = -num(ac.vs) / FPM, casKt = num(ac.cas) / KT;
  // terrain closure rate (ft/min) from filtered RA derivative
  if (st.raPrevG != null && dt > 0) st.raRate = lag(st.raRate, (raFt - st.raPrevG) / dt * 60, 0.8, dt);
  st.raPrevG = raFt;
  const closure = -st.raRate;
  g.pullUp = false; g.terrain = false; g.glideslope = false; g.active = '';
  a.gpws = null; a.pullUp = false;
  if (ac.onGround || raFt < 30 || raFt > 2500 || (sim.systems && sim.systems.elec && sim.systems.elec.dcPowered === false)) {
    if (ac.onGround) { st.liftoffMaxAlt = 0; }
    return;
  }
  const lever = FLAP_DETENTS[clamp(Math.round(num(c.flapLever)), 0, 6)];
  const gearDown = num(sim.surfaces.gear, 1) > 0.99;
  const landingFlaps = lever >= 25;
  const takeoff = sim.systems && sim.systems.phase === 'TAKEOFF';
  let mode = '';
  // Mode 1: excessive descent rate
  const sinkLimit = 1500 + (raFt - 50) * (3500 / 2400);
  const pullLimit = 1800 + (raFt - 50) * (5800 / 2400);
  if (sinkFpm > pullLimit && raFt > 50) mode = 'pull_up';
  else if (sinkFpm > sinkLimit) mode = 'sink_rate';
  // Mode 2: excessive terrain closure
  const m2Limit = landingFlaps && gearDown ? (raFt < 790 ? 3000 + (raFt - 30) * 3 : Infinity) : (raFt < 1650 ? 2000 + (raFt - 30) * (4000 / 1620) : Infinity);
  if (!takeoff && closure > m2Limit && closure > sinkFpm * 1.3 + 300) {
    st.terrainT = (st.terrainT || 0) + dt;
    mode = st.terrainT > 1.6 && closure > m2Limit * 1.15 ? 'pull_up' : (mode === 'pull_up' ? mode : 'terrain');
  } else st.terrainT = 0;
  // Mode 3: altitude loss after takeoff
  const altFt = num(ac.altMSL) / FT;
  if (takeoff && raFt < 1500) {
    st.liftoffMaxAlt = Math.max(st.liftoffMaxAlt || altFt, altFt);
    const loss = st.liftoffMaxAlt - altFt;
    if (!mode && loss > Math.max(20, raFt * 0.1) && sinkFpm > 100) mode = 'dont_sink';
  }
  // Mode 4: unsafe terrain clearance (not on takeoff)
  if (!mode && !takeoff && sinkFpm > -200) {
    if (!gearDown && c.gearLever !== 'DOWN') {
      if (raFt < 500 && casKt < 190) mode = 'too_low_gear';
      else if (raFt < 1000 && casKt >= 190 && sinkFpm > 0) mode = 'too_low_terrain';
    } else if (!landingFlaps && raFt < 245 && casKt < 159) mode = 'too_low_flaps';
  }
  // Mode 5: below glideslope
  const dots = gsBelowDots(sim);
  if (!mode && gearDown && raFt < 1000 && dots > 1.3) {
    g.glideslope = true;
    gpwsSay(sim, st, 'glideslope', clamp(3.2 - (dots - 1.3) * 1.2, 1.6, 3.2));
  }
  // Mode 6: bank angle
  const bank = Math.abs(num(ac.euler && ac.euler.roll)) * RAD;
  if (!mode && bank > 35) gpwsSay(sim, st, 'bank_angle', 2.4);
  if (mode) {
    gpwsSay(sim, st, mode);
    g.active = mode;
    g.pullUp = mode === 'pull_up';
    g.terrain = mode === 'terrain' || mode === 'too_low_terrain';
    a.pullUp = g.pullUp;
    a.gpws = g.pullUp ? 'PULL UP' : null;
  }
}

// ---------------------------------------------------------------- callouts
function baroAltFt(sim) {
  const env = sim.env || {};
  let alt = num(sim.ac.altMSL) / FT;
  if (!env.baroStd) alt += (num(env.baroHpa, 1013.25) - num(env.qnhHpa, 1013.25)) * 27.3;
  else alt += (1013.25 - num(env.qnhHpa, 1013.25)) * 27.3;
  return alt;
}

function stepCallouts(sim, st) {
  const ac = sim.ac, a = sim.alerts;
  const raFt = num(ac.ra) / FT;
  const prev = st.raPrev;
  st.raPrev = raFt;
  const descending = num(ac.vs) < -0.25;
  const airborne = !ac.onGround;
  // V1 / rotate on the takeoff roll
  const casKt = num(ac.cas) / KT, fmc = sim.fmc || {};
  if (ac.onGround && casKt < 40) { st.v1Done = false; st.vrDone = false; }
  if (ac.onGround && sim.controls.throttle.some((t) => t > 0.5)) {
    if (a.options.v1Callout && !st.v1Done && fmc.v1 > 60 && st.prevCas < fmc.v1 && casKt >= fmc.v1) { st.v1Done = true; aural(sim, 'v1'); }
    if (a.options.rotateCallout && !st.vrDone && fmc.vr > 60 && st.prevCas < fmc.vr && casKt >= fmc.vr) { st.vrDone = true; aural(sim, 'rotate'); }
  }
  st.prevCas = casKt;
  if (prev == null) { for (const T of RA_CALLOUTS) st.raArmed[T] = raFt > T + rearm(T); return; }
  // minimums
  const efis = sim.efis || {};
  const mins = num(efis.minimumsFt, 0);
  const radio = efis.minsType === 'RADIO';
  const value = radio ? raFt : baroAltFt(sim);
  const m = st.minsArmed;
  if (value > mins + 180) { m.app = true; m.mins = true; }
  const gpwsBusy = a.egpws.active === 'pull_up' || a.egpws.active === 'terrain';
  if (mins > 0 && airborne && descending && raFt < 2600) {
    if (m.app && value <= mins + 80) { m.app = false; if (!gpwsBusy) aural(sim, 'approaching_minimums'); }
    if (m.mins && value <= mins) { m.mins = false; st.lastMinsT = sim.time; st.minsRa = raFt; if (!gpwsBusy) aural(sim, 'minimums'); }
  }
  // radio-altitude callouts
  for (const T of RA_CALLOUTS) {
    if (raFt > T + rearm(T)) st.raArmed[T] = true;
    if (st.raArmed[T] && airborne && descending && prev > T && raFt <= T) {
      st.raArmed[T] = false;
      const coincident = sim.time - st.lastMinsT < 2 && Math.abs(num(st.minsRa) - T) < 20;
      if (!coincident && !gpwsBusy) aural(sim, 'ra' + T);
    }
  }
}
const rearm = (T) => Math.max(20, T * 0.08);

// ------------------------------------------------------------------- aurals
function updateAurals(sim, st, dt) {
  const a = sim.alerts, ap = sim.ap || {};
  const texts = new Set(a.list.map((m) => m.text));
  const sirenCond = [...texts].some((t) => SIREN_IDS.has(t));
  const fire = [...texts].some((t) => t.startsWith('FIRE'));
  a.aural.siren = sirenCond;
  a.aural.fireBell = fire && a.masterWarning && !st.fireSilenced;
  a.aural.wailer = 'discWarning' in ap ? !!ap.discWarning : st.apWailT > 0;
  a.aural.shaker = !!a.stickShaker;
}
