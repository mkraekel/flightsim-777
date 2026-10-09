// Autopilot / Flight Director System + Autothrottle (Team D1). Pure logic, no DOM.
//
// Architecture
//   sense()        reads sim.ac & co into a small sensor record (NaN-guarded)
//   handleMomentary() consumes controls.apDisc / atDisc / toga
//   transitions()  arming, captures, takeoff / autoland sequencing, envelope reversions
//   pitchLaw()     outer loop per pitch mode  -> flight-path-angle command γc (or attitude)
//   rollLaw()      outer loop per roll mode   -> bank command φc
//   innerLoops()   θc/φc -> virtual column / wheel (sim.ap.out), plus rollout pedal
//   autothrottle() A/T mode logic -> sim.ap.thrustCmd (lever target 0..1 or null)
//   annunciate()   FMA strings, AFDS status, FD bars
//
// Control interface assumptions (Team A FBW): column ≈ C* demand where full column ≈ 1.5 g of
// C* (C* = Δnz + Vco·q/g, Vco = 120 m/s); wheel ≈ roll-rate demand, full wheel ≈ 15°/s, bank held
// at neutral wheel. Integrators absorb any scaling mismatch; the FBW should keep its trim
// reference speed synchronised to the current speed while ap.out.active (no U-term fight).

import { DEG, RAD, KT, FT, FPM, G0, clamp, wrap2pi, wrapPi, wrap360, approach, lag } from '../core/geo.js';
import { minManeuverKt, maxSpeedKt, VMO_KT, MMO } from './fmc.js';

// ---- tuning constants -----------------------------------------------------------------------
const REF_LEVER = { TO: 0.95, GA: 0.95, CON: 0.92, CLB: 0.90, CRZ: 0.86 }; // A/T lever targets per thrust ref
const T_CAP = 12;            // s, altitude capture / hold time constant (vs = err / T_CAP)
const K_SPD = 0.09;          // 1/s, speed-on-elevator bandwidth
const PITCH_MAX = 25 * DEG, PITCH_MIN = -12 * DEG;
const THETA_RATE = 2.5 * DEG; // max rate of the commanded attitude (rad/s)
const PHI_RATE = 3.5 * DEG;   // max rate of the commanded bank (rad/s)
const C_STAR_FULL = 1.5;      // g of C* at full column (FBW assumption)
const V_CO = 120;             // m/s C* crossover speed
const ROLL_RATE_FULL = 15 * DEG; // rad/s at full wheel (FBW assumption)
const AT_KV = 0.15, AT_AMAX = 1.2, AT_KA = 0.10, AT_KI = 0.04, AT_KGAM = 2.2; // A/T SPD law

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// ---------------------------------------------------------------------------------------------
export function initAFDS(sim) {
  const ap = sim.ap;
  Object.assign(ap, {
    discWarning: false,        // red A/P + AUTOPILOT DISC until AP_DISC pressed again
    atDiscWarning: false,      // AUTOTHROTTLE DISC caution until A/T disc pressed again
    disengageBar: false,       // MCP A/P DISENGAGE bar pulled down (AP lockout)
    atArmL: ap.atArm !== false, atArmR: ap.atArm !== false,
    spdIntv: false,            // VNAV speed intervention (speed window open in VNAV)
    altIncr1000: false,        // ALT knob outer ring: false = AUTO (100 ft), true = 1000 ft
    vsWindowOpen: false,       // V/S window shown (V/S or FPA active)
    spdWindowBlank: false,     // speed window blank (VNAV without intervention)
    thrRef: 'TO',              // thrust reference mode shown on EICAS: TO CLB CRZ CON GA
    land: '',                  // 'LAND 3' | 'LAND 2' | 'NO AUTOLAND' | ''
    tgtSpdKt: num(ap.sel.spdKt, 250), tgtMach: null, tgtIsMach: false, // commanded speed (PFD bug)
    modeT: { at: -99, roll: -99, pitch: -99 }, // sim.time of last mode change (10 s green box)
    holdAltFt: null,           // altitude being held/captured (ALT / VNAV ALT / VNAV PTH level)
  });
  ap.sel.vsIsFpa = !!ap.sel.vsIsFpa;
  ap.fd.pitchValid = false; ap.fd.rollValid = false;
  ap._ = {
    pitchI: 0, rollI: 0, atI: 0, casDot: 0, lastCas: null, dTheta: 2 * DEG, gammaF: 0,
    thetaCmd: null, phiCmd: 0, vsCmdPrev: null, altI: 0,
    hdgHold: null, attBank: 0, togaTrack: null, casLiftoff: 0, ga: false, gaSpd: 0,
    wasOnGround: true, flareTau: 5, capturing: false, lastLever: 0, rolloutHdg: null,
  };
  syncModes(sim);
}

// ---------------------------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------------------------
function sense(sim, dt) {
  const ac = sim.ac, I = sim.ap._, e = ac.euler || {}, w = ac.omega || [];
  const tas = Math.max(num(ac.tas), 1);
  const s = {
    theta: num(e.pitch), phi: num(e.roll), hdg: num(e.heading), magVar: num(ac.magVar),
    p: num(w[0]), q: num(w[1]), r: num(w[2]),
    tas, casKt: num(ac.cas) / KT, mach: num(ac.mach), vs: num(ac.vs), gs: num(ac.gs),
    onGround: !!ac.onGround, raFt: num(ac.ra, 9999) / FT, flaps: num(sim.surfaces.flapsDeg),
    mass: num(ac.mass, 300000) || 300000, wowNose: !!(ac.wow && ac.wow.nose),
  };
  s.vsFpm = s.vs / FPM;
  s.track = s.gs > 15 ? num(ac.track, s.hdg) : s.hdg;
  s.gamma = tas > 30 ? Math.asin(clamp(s.vs / tas, -1, 1)) : num(ac.fpa);
  const env = sim.env, set = env.baroStd ? 1013.25 : num(env.baroHpa, 1013.25);
  s.altFt = num(ac.altMSL) / FT + (set - num(env.qnhHpa, 1013.25)) * 27;
  // filtered speed derivative (kt/s) and pitch-minus-path (≈ α·cosφ)
  if (I.lastCas === null) I.lastCas = s.casKt;
  const raw = dt > 0 ? (s.casKt - I.lastCas) / dt : 0;
  I.lastCas = s.casKt;
  I.casDot = lag(I.casDot, clamp(raw, -15, 15), 0.8, dt);
  s.casDot = I.casDot;
  if (!s.onGround) I.dTheta = lag(I.dTheta, clamp(s.theta - s.gamma, -5 * DEG, 15 * DEG), 1.2, dt);
  s.minSpd = minManeuverKt(s.mass, s.flaps);
  s.maxSpd = Math.min(maxSpeedKt(s.flaps), VMO_KT, s.mach > 0.3 ? s.casKt * MMO / s.mach : 999);
  s.lever = (num(sim.controls.throttle[0]) + num(sim.controls.throttle[1])) / 2;
  s.engOut = sim.engines.some((en) => !en.running) && sim.engines.some((en) => en.running);
  return s;
}

const hdgSelTrue = (sim, s) => wrap2pi(num(sim.ap.sel.hdgDeg) * DEG + s.magVar);

// ---------------------------------------------------------------------------------------------
// Mode setters
// ---------------------------------------------------------------------------------------------
function setRoll(sim, m) {
  const ap = sim.ap;
  if (ap.modes.roll === m) return;
  ap.modes.roll = m; ap.modeT.roll = sim.time; ap._.rollI *= 0.5;
  if (m === 'HDG HOLD' || m === 'TRK HOLD') ap._.hdgHold = null;
  if (m === 'LNAV' && ap.modes.armedRoll === 'LNAV') ap.modes.armedRoll = '';
  if (m === 'LOC' && ap.modes.armedRoll === 'LOC') ap.modes.armedRoll = '';
}
function setPitch(sim, m, s) {
  const ap = sim.ap, I = ap._;
  if (ap.modes.pitch === m) return;
  // leaving VNAV: the MCP speed window opens with the FMC target speed (no surprise speed change)
  if (ap.modes.pitch.startsWith('VNAV') && !m.startsWith('VNAV') && !ap.spdIntv) {
    if (ap.tgtIsMach && ap.tgtMach) { ap.sel.useMach = true; ap.sel.mach = Math.round(ap.tgtMach * 1000) / 1000; }
    else if (ap.tgtSpdKt > 0) { ap.sel.useMach = false; ap.sel.spdKt = Math.round(ap.tgtSpdKt); }
    ap.spdWindowBlank = false;
  }
  ap.modes.pitch = m; ap.modeT.pitch = sim.time;
  I.altI = 0;
  if (m === 'V/S' || m === 'FPA') ap.vsWindowOpen = true; else ap.vsWindowOpen = false;
  if (!m.startsWith('VNAV')) ap.spdIntv = false;
  if (m === 'G/S' && ap.modes.armedPitch === 'G/S') ap.modes.armedPitch = '';
  if (m.startsWith('VNAV') && ap.modes.armedPitch === 'VNAV') ap.modes.armedPitch = '';
  if (s) atFollowPitch(sim, s);
}
function setAT(sim, m) {
  const ap = sim.ap, I = ap._;
  if (!ap.atArm) return;
  if (!ap.atEngaged) { ap.atEngaged = true; ap.atDiscWarning = false; }
  if (ap.modes.at === m) return;
  if (m === 'SPD' || m === 'THR') I.atI = I.lastLever; // bumpless
  ap.modes.at = m; ap.modeT.at = sim.time;
}
/** A/T mode that goes with the current pitch mode. */
function atFollowPitch(sim, s) {
  const ap = sim.ap, pm = ap.modes.pitch;
  if (!ap.atEngaged) return;
  const dir = sign(num(ap.sel.altFt) - s.altFt);
  if (pm === 'FLCH SPD') setAT(sim, dir >= 0 ? 'THR' : 'IDLE');
  else if (pm === 'VNAV SPD') setAT(sim, vnavClimbing(sim, s) ? 'THR REF' : 'IDLE');
  else if (pm === 'VNAV PTH') setAT(sim, vnavDescending(sim, s) ? 'IDLE' : 'SPD');
  else if (pm === 'TO/GA') setAT(sim, ap._.ga ? 'THR' : 'THR REF');
  else if (pm === 'FLARE') { /* keep */ }
  else setAT(sim, 'SPD');
}
const vnavClimbing = (sim, s) => s.altFt < num(sim.fmc.crzAltFt, 35000) - 150 && !['DESCENT', 'APPROACH'].includes(sim.fmc.phase);
const vnavDescending = (sim, s) => ['DESCENT', 'APPROACH'].includes(sim.fmc.phase) && num(sim.ap.sel.altFt) < s.altFt - 100;

function anyFd(sim) { return !!(sim.ap.fdL || sim.ap.fdR); }
const routeOk = (sim) => Array.isArray(sim.fmc.route) && sim.fmc.route.length >= 2 && sim.fmc.activeLeg > 0;

/** Default modes when the AP or an FD comes on with nothing active. */
function defaultModes(sim, s) {
  const ap = sim.ap;
  if (s.onGround) {
    if (anyFd(sim)) { if (!ap.modes.roll) setRoll(sim, 'TO/GA'); if (!ap.modes.pitch) setPitch(sim, 'TO/GA'); }
    return;
  }
  if (!ap.modes.roll) {
    if (Math.abs(s.phi) > 5 * DEG) { setRoll(sim, 'ATT'); ap._.attBank = clamp(s.phi, -30 * DEG, 30 * DEG); }
    else setRoll(sim, ap.sel.hdgIsTrk ? 'TRK HOLD' : 'HDG HOLD');
  }
  if (!ap.modes.pitch) {
    if (ap.sel.vsIsFpa) ap.sel.fpaDeg = Math.round(s.gamma * RAD * 10) / 10;
    else ap.sel.vsFpm = Math.round(s.vsFpm / 100) * 100;
    setPitch(sim, ap.sel.vsIsFpa ? 'FPA' : 'V/S', s);
  }
}

function clearFlightModes(sim) {
  const m = sim.ap.modes;
  m.roll = ''; m.pitch = ''; m.armedRoll = ''; m.armedPitch = '';
  sim.ap.land = ''; sim.ap.vsWindowOpen = false; sim.ap.spdIntv = false; sim.ap._.ga = false;
}

// ---------------------------------------------------------------------------------------------
// Engage / disconnect
// ---------------------------------------------------------------------------------------------
function apDisconnect(sim, warn = true) {
  const ap = sim.ap;
  if (!ap.apEngaged) return;
  ap.apEngaged = false;
  ap.out.active = false; ap.out.pitch = 0; ap.out.roll = 0; ap.out.yaw = 0;
  ap._.pitchI = 0; ap._.rollI = 0;
  if (warn) { ap.discWarning = true; sim.events.emit('aural', { id: 'ap_disc' }); }
  if (!anyFd(sim)) {
    clearFlightModes(sim);
    if (ap.atEngaged && ['THR', 'THR REF', 'IDLE', 'HOLD'].includes(ap.modes.at) && !sim.ac.onGround) setAT(sim, 'SPD');
  }
  if (ap.land) ap.land = '';
}
function atDisconnect(sim, warn = true) {
  const ap = sim.ap;
  if (!ap.atEngaged) return;
  ap.atEngaged = false; ap.modes.at = ''; ap.thrustCmd = null;
  if (warn) { ap.atDiscWarning = true; sim.events.emit('aural', { id: 'at_disc' }); }
}
function toast(sim, text) { sim.events.emit('toast', { text }); }

// ---------------------------------------------------------------------------------------------
// MCP actions
// ---------------------------------------------------------------------------------------------
export function afdsAction(sim, action, value) {
  const ap = sim.ap;
  if (!ap._) initAFDS(sim);
  const s = sense(sim, 0);
  const sel = ap.sel, m = ap.modes;
  const air = !s.onGround;
  switch (action) {
    case 'AP_ENGAGE': {
      if (value === false) { apDisconnect(sim, true); break; }
      if (value === 'toggle' && ap.apEngaged) { apDisconnect(sim, true); break; }
      if (ap.apEngaged) break; // pushing an engaged A/P does nothing (as on the aircraft)
      if (!air) { toast(sim, 'A/P not available on the ground'); break; }
      if (ap.disengageBar) { toast(sim, 'A/P DISENGAGE bar is down'); break; }
      if (sim.fbw && sim.fbw.mode && sim.fbw.mode !== 'NORMAL') { toast(sim, 'A/P inoperative (PFC ' + sim.fbw.mode + ')'); break; }
      if (sim.ac.crashed) break;
      ap.apEngaged = true; ap.discWarning = false;
      ap._.pitchI = 0; ap._.rollI = 0; ap._.thetaCmd = s.theta; ap._.phiCmd = s.phi;
      // ground-only FD modes are meaningless now
      if (m.roll === 'TO/GA' && !ap._.togaTrack) ap._.togaTrack = s.track;
      defaultModes(sim, s);
      break;
    }
    case 'AP_DISC': apDisconnect(sim, true); break;
    case 'AP_DISENGAGE_BAR':
      ap.disengageBar = value === undefined ? !ap.disengageBar : !!value;
      if (ap.disengageBar) apDisconnect(sim, true);
      break;
    case 'FD_L': case 'FD_R': {
      const key = action === 'FD_L' ? 'fdL' : 'fdR';
      const was = anyFd(sim);
      ap[key] = value === undefined ? !ap[key] : !!value;
      if (!was && anyFd(sim) && !ap.apEngaged) defaultModes(sim, s);
      if (!anyFd(sim) && !ap.apEngaged) {
        clearFlightModes(sim);
        if (ap.atEngaged && air) setAT(sim, 'SPD');
      }
      break;
    }
    case 'AT_ARM': {
      if (value === 'L') ap.atArmL = !ap.atArmL;
      else if (value === 'R') ap.atArmR = !ap.atArmR;
      else { const v = value === undefined ? !ap.atArm : !!value; ap.atArmL = v; ap.atArmR = v; }
      ap.atArm = ap.atArmL || ap.atArmR;
      if (!ap.atArm) atDisconnect(sim, true);
      break;
    }
    case 'AT_DISC': if (ap.atEngaged) atDisconnect(sim, true); else ap.atDiscWarning = false; break;
    case 'AT':
      if (!ap.atArm) break;
      if (!ap.atEngaged) { ap.atEngaged = true; ap.atDiscWarning = false; ap.modes.at = ''; }
      if (s.onGround && !m.at) setAT(sim, 'THR REF');
      else atFollowPitch(sim, s);
      break;
    case 'CLB_CON':
      if (air) ap.thrRef = s.engOut ? 'CON' : 'CLB'; // CLB with both engines, CON with an engine out
      break;
    case 'IAS_MACH': toggleIasMach(sim, s); break;
    case 'SPD_INTV':
      if (m.pitch.startsWith('VNAV')) {
        ap.spdIntv = !ap.spdIntv;
        if (ap.spdIntv) { if (ap.tgtIsMach) { sel.useMach = true; sel.mach = round3(ap.tgtMach); } else { sel.useMach = false; sel.spdKt = Math.round(ap.tgtSpdKt); } }
      } else toggleIasMach(sim, s);
      break;
    case 'LNAV':
      if (!routeOk(sim)) { toast(sim, 'LNAV: no active route'); break; }
      if (m.armedRoll === 'LNAV') { m.armedRoll = ''; break; }
      if (m.roll === 'LNAV') break;
      if (air && s.raFt > 50 && Math.abs(num(sim.fmc.xtkM)) < 2.5 * 1852) setRoll(sim, 'LNAV');
      else m.armedRoll = 'LNAV';
      break;
    case 'VNAV':
      if (!routeOk(sim) || !(num(sim.fmc.crzAltFt) > 0)) { toast(sim, 'VNAV: enter route and CRZ ALT'); break; }
      if (m.armedPitch === 'VNAV') { m.armedPitch = ''; break; }
      if (m.pitch.startsWith('VNAV')) break;
      if (!air || s.raFt < 400) { m.armedPitch = 'VNAV'; break; }
      engageVnav(sim, s);
      break;
    case 'FLCH':
      if (!air) break;
      if (Math.abs(num(sel.altFt) - s.altFt) < 100) { captureAlt(sim, s, 'ALT', s.altFt); break; }
      if (m.pitch === 'TO/GA') ap._.ga = false;
      if (sel.useMach === false && ap.spdWindowBlank) sel.spdKt = Math.round(s.casKt);
      setPitch(sim, 'FLCH SPD');
      if (ap.atArm) { if (!ap.atEngaged) ap.atEngaged = true; atFollowPitch(sim, s); }
      clearApproachIfGs(sim);
      break;
    case 'HDG_SEL':
      if (air) { setRoll(sim, sel.hdgIsTrk ? 'TRK SEL' : 'HDG SEL'); if (m.armedRoll === 'LNAV') m.armedRoll = ''; }
      break;
    case 'HDG_HOLD':
      if (air) { setRoll(sim, sel.hdgIsTrk ? 'TRK HOLD' : 'HDG HOLD'); if (m.armedRoll === 'LNAV') m.armedRoll = ''; }
      break;
    case 'HDG_TRK': {
      const drift = wrapPi(s.track - s.hdg) * RAD;
      sel.hdgIsTrk = value === undefined ? !sel.hdgIsTrk : !!value;
      sel.hdgDeg = Math.round(wrap360(num(sel.hdgDeg) + (sel.hdgIsTrk ? drift : -drift))) || 360;
      const map = { 'HDG SEL': 'TRK SEL', 'TRK SEL': 'HDG SEL', 'HDG HOLD': 'TRK HOLD', 'TRK HOLD': 'HDG HOLD' };
      if (map[m.roll] && (m.roll.startsWith('TRK') !== sel.hdgIsTrk)) setRoll(sim, map[m.roll]);
      break;
    }
    case 'VS_FPA':
      sel.vsIsFpa = value === undefined ? !sel.vsIsFpa : !!value;
      if (m.pitch === 'V/S' || m.pitch === 'FPA') {
        if (sel.vsIsFpa) sel.fpaDeg = Math.round(s.gamma * RAD * 10) / 10; else sel.vsFpm = Math.round(s.vsFpm / 100) * 100;
        setPitch(sim, sel.vsIsFpa ? 'FPA' : 'V/S', s);
      }
      break;
    case 'VS':
      if (!air) break;
      if (sel.vsIsFpa) sel.fpaDeg = Math.round(s.gamma * RAD * 10) / 10; else sel.vsFpm = Math.round(s.vsFpm / 100) * 100;
      setPitch(sim, sel.vsIsFpa ? 'FPA' : 'V/S', s);
      clearApproachIfGs(sim);
      break;
    case 'ALT_HOLD':
      if (!air) break;
      captureAlt(sim, s, 'ALT', Math.round(s.altFt));
      clearApproachIfGs(sim);
      break;
    case 'ALT_INTV': // ALT knob push: VNAV altitude intervention (resume climb/descent)
      if (m.pitch === 'VNAV ALT' || m.pitch === 'VNAV PTH') {
        const d = num(sel.altFt) - s.altFt;
        if (Math.abs(d) > 200) {
          if (d > 0 && num(sim.fmc.crzAltFt) < sel.altFt) sim.fmc.crzAltFt = Math.round(sel.altFt);
          if (d < 0 && sim.fmc.phase === 'CRUISE') sim.fmc.crzAltFt = Math.round(sel.altFt);
          setPitch(sim, d > 0 ? 'VNAV SPD' : 'VNAV PTH', s); ap.holdAltFt = null;
        }
      }
      break;
    case 'LOC':
      if (m.roll === 'LOC' && m.pitch !== 'G/S' && !ap.land) { setRoll(sim, ap.sel.hdgIsTrk ? 'TRK HOLD' : 'HDG HOLD'); break; }
      if (m.armedRoll === 'LOC') { m.armedRoll = ''; if (m.armedPitch === 'G/S') m.armedPitch = ''; break; }
      if (m.roll !== 'LOC') m.armedRoll = 'LOC';
      break;
    case 'APP':
      if (ap.land) break;
      if (m.armedPitch === 'G/S' || (m.armedRoll === 'LOC' && m.armedPitch === 'G/S')) {
        m.armedPitch = ''; if (m.armedRoll === 'LOC') m.armedRoll = ''; break;
      }
      if (m.roll !== 'LOC') m.armedRoll = 'LOC';
      if (m.pitch !== 'G/S') m.armedPitch = 'G/S';
      break;
    case 'TOGA': toga(sim, s); break;
    case 'SPD_SET': {
      const v = num(value, NaN); if (!Number.isFinite(v)) break;
      if (v < 2) { sel.useMach = true; sel.mach = round3(clamp(v, 0.4, 0.95)); }
      else { sel.useMach = false; sel.spdKt = Math.round(clamp(v, 100, 399)); }
      break;
    }
    case 'SPD_INC': {
      const d = num(value, 0);
      if (ap.spdWindowBlank) break;
      if (sel.useMach) sel.mach = round3(clamp(num(sel.mach, 0.8) + d * 0.001, 0.4, 0.95));
      else sel.spdKt = Math.round(clamp(num(sel.spdKt, 250) + d, 100, 399));
      break;
    }
    case 'HDG_SET': if (Number.isFinite(value)) sel.hdgDeg = Math.round(wrap360(value)) || 360; break;
    case 'HDG_INC': sel.hdgDeg = Math.round(wrap360(num(sel.hdgDeg) + num(value))) || 360; break;
    case 'ALT_SET': if (Number.isFinite(value)) sel.altFt = Math.round(clamp(value, 0, 50000) / 100) * 100; break;
    case 'ALT_INC': {
      const step = ap.altIncr1000 ? 1000 : 100;
      const d = num(value, 0);
      // a "delta" of ±1 knob click maps to one increment; larger deltas are taken as feet
      const ft = Math.abs(d) < 50 ? d * step : d;
      sel.altFt = clamp(Math.round((num(sel.altFt) + ft) / 100) * 100, 0, 50000);
      break;
    }
    case 'ALT_INCR_MODE': ap.altIncr1000 = value === undefined ? !ap.altIncr1000 : !!value; break;
    case 'VS_SET':
      if (sel.vsIsFpa) sel.fpaDeg = clamp(Math.round(num(value) * 10) / 10, -9.9, 9.9);
      else sel.vsFpm = clamp(Math.round(num(value) / 100) * 100, -8000, 6000);
      break;
    case 'VS_INC': {
      if (!ap.vsWindowOpen) break;
      const d = num(value, 0);
      if (sel.vsIsFpa) sel.fpaDeg = clamp(Math.round((num(sel.fpaDeg) + d * 0.1) * 10) / 10, -9.9, 9.9);
      else {
        const cur = num(sel.vsFpm);
        const step = Math.abs(cur) < 1000 || (Math.abs(cur) === 1000 && sign(d) !== sign(cur)) ? 50 : 100;
        const ft = Math.abs(d) < 50 ? d * step : d;
        sel.vsFpm = clamp(Math.round((cur + ft) / 50) * 50, -8000, 6000);
      }
      break;
    }
    case 'BANK_LIMIT': sel.bankLimitDeg = [0, 5, 10, 15, 20, 25].includes(num(value)) ? num(value) : 0; break;
    default: return false; // unknown action
  }
  return true; // action recognised (it may still have been refused by an interlock)
}
const round3 = (v) => Math.round(v * 1000) / 1000;

function toggleIasMach(sim, s) {
  const sel = sim.ap.sel;
  const ratio = s.casKt > 50 && s.mach > 0.1 ? s.mach / s.casKt : 0.84 / 290;
  if (sel.useMach) { sel.useMach = false; sel.spdKt = Math.round(clamp(num(sel.mach) / ratio, 100, 399)); }
  else { sel.useMach = true; sel.mach = round3(clamp(num(sel.spdKt) * ratio, 0.4, 0.95)); }
}

function clearApproachIfGs(sim) {
  const m = sim.ap.modes;
  if (m.armedPitch === 'G/S') m.armedPitch = '';
  if (m.armedPitch === 'FLARE') m.armedPitch = '';
}

function captureAlt(sim, s, mode, altFt) {
  sim.ap.holdAltFt = altFt;
  sim.ap._.capturing = Math.abs(altFt - s.altFt) > 30;
  sim.ap.modes.pitch === mode ? null : setPitch(sim, mode, s);
  if (sim.ap.atEngaged && ['THR', 'THR REF', 'IDLE', 'HOLD'].includes(sim.ap.modes.at)) setAT(sim, 'SPD');
}

function engageVnav(sim, s) {
  const ap = sim.ap;
  ap.holdAltFt = null;
  if (vnavDescending(sim, s)) setPitch(sim, sim.fmc.pathAltFt !== null ? 'VNAV PTH' : 'VNAV SPD', s);
  else if (vnavClimbing(sim, s) && num(ap.sel.altFt) > s.altFt + 100) setPitch(sim, 'VNAV SPD', s);
  else {
    const crz = num(sim.fmc.crzAltFt, 35000);
    const lvl = Math.abs(s.altFt - crz) < 300 ? crz : Math.round(s.altFt);
    ap.holdAltFt = lvl; setPitch(sim, Math.abs(lvl - crz) < 1 ? 'VNAV PTH' : 'VNAV ALT', s);
  }
  if (ap.atArm && !ap.atEngaged) { ap.atEngaged = true; atFollowPitch(sim, s); }
}

function toga(sim, s) {
  const ap = sim.ap, I = ap._;
  if (s.onGround) {
    if (s.gs / KT > 80 || sim.fmc.wasAirborne && sim.fmc.phase === 'DONE') return; // inhibited at high speed / after landing
    ap.thrRef = 'TO'; I.ga = false;
    if (anyFd(sim)) { setRoll(sim, 'TO/GA'); setPitch(sim, 'TO/GA'); }
    if (ap.atArm) setAT(sim, 'THR REF');
    return;
  }
  // In flight: go-around if flaps out or G/S captured
  if (!(s.flaps > 0 || ap.modes.pitch === 'G/S' || ap.modes.pitch === 'FLARE')) return;
  if (ap.modes.pitch === 'TO/GA' && I.ga) { // second push: full GA thrust
    if (ap.atArm) setAT(sim, 'THR REF');
    return;
  }
  I.ga = true; I.togaTrack = s.track; I.gaSpd = Math.max(s.casKt, num(ap.sel.spdKt));
  ap.thrRef = 'GA'; ap.land = '';
  ap.modes.armedRoll = ''; ap.modes.armedPitch = '';
  setRoll(sim, 'TO/GA'); setPitch(sim, 'TO/GA');
  if (ap.atArm) setAT(sim, 'THR');
}

// ---------------------------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------------------------
export function stepAFDS(sim, dt) {
  const ap = sim.ap;
  if (!ap) return;
  if (!ap._) initAFDS(sim);
  if (!(dt > 0)) return;
  dt = Math.min(dt, 0.5);
  try {
    const s = sense(sim, dt);
    handleMomentary(sim, s);
    transitions(sim, s, dt);
    const pc = pitchLaw(sim, s, dt);
    const phiC = rollLaw(sim, s, dt);
    innerLoops(sim, s, dt, pc, phiC);
    autothrottle(sim, s, dt, pc);
    annunciate(sim, s);
    ap._.wasOnGround = s.onGround;
  } catch (e) {
    if (!ap._.err) { ap._.err = true; console.error('stepAFDS', e); }
    ap.out.active = false;
  }
}

function handleMomentary(sim, s) {
  const c = sim.controls, ap = sim.ap;
  if (c.apDisc) {
    c.apDisc = false;
    if (ap.apEngaged) apDisconnect(sim, true); else ap.discWarning = false;
  }
  if (c.atDisc) {
    c.atDisc = false;
    if (ap.atEngaged) atDisconnect(sim, true); else ap.atDiscWarning = false;
  }
  if (c.toga) { c.toga = false; toga(sim, s); }
}

// ---------------------------------------------------------------------------------------------
// Transitions: arming, captures, sequencing, reversions
// ---------------------------------------------------------------------------------------------
function transitions(sim, s, dt) {
  const ap = sim.ap, I = ap._, m = ap.modes, ils = sim.nav.ils, fmc = sim.fmc;

  // --- automatic AP disconnects ---
  if (ap.apEngaged) {
    const upset = Math.abs(s.phi) > 45 * DEG || s.theta > 30 * DEG || s.theta < -20 * DEG;
    const fbwBad = sim.fbw && sim.fbw.mode && sim.fbw.mode !== 'NORMAL';
    const stall = sim.fbw && sim.fbw.prot && sim.fbw.prot.stall;
    if (upset || fbwBad || stall || sim.ac.crashed || ap.disengageBar) apDisconnect(sim, true);
    else if (s.onGround && m.roll !== 'ROLLOUT' && m.armedRoll !== 'ROLLOUT' && !I.wasOnGround) apDisconnect(sim, true); // landed without autoland
  }

  // --- takeoff ---
  if (s.onGround) {
    if (m.at === 'THR REF' && s.casKt > 80 && ap.thrRef === 'TO') setAT(sim, 'HOLD');
    if (!anyFd(sim) && !ap.apEngaged && m.roll === 'TO/GA') clearFlightModes(sim);
    if (anyFd(sim) && !m.roll && !m.pitch && !fmc.wasAirborne) defaultModes(sim, s);
    I.togaTrack = null; I.casLiftoff = s.casKt;
    if (!ap.apEngaged && m.roll === 'ROLLOUT') clearFlightModes(sim);
  } else if (I.wasOnGround) {
    // lift-off
    I.togaTrack = s.track; I.casLiftoff = s.casKt;
  }
  if (!s.onGround) {
    const aglFt = s.raFt;
    if (m.armedRoll === 'LNAV' && aglFt > 50 && Math.abs(num(fmc.xtkM)) < 2.5 * 1852 && routeOk(sim)) setRoll(sim, 'LNAV');
    if (m.armedPitch === 'VNAV' && aglFt > 400 && routeOk(sim)) engageVnav(sim, s);
    if (ap.thrRef === 'TO' && aglFt > 1500) ap.thrRef = 'CLB';
    if (m.at === 'HOLD' && m.pitch === 'TO/GA' && !I.ga && aglFt > 400 && ap.atEngaged) { /* stays HOLD (FCOM) */ }
    // thrust reference by phase
    if (ap.thrRef !== 'TO' && ap.thrRef !== 'GA' && ap.thrRef !== 'CON') {
      ap.thrRef = fmc.phase === 'CRUISE' ? 'CRZ' : 'CLB';
    }
    if (ap.thrRef === 'GA' && m.pitch !== 'TO/GA' && s.flaps < 20) ap.thrRef = 'CLB';
    if (s.engOut && ap.thrRef === 'CLB' && fmc.phase === 'CRUISE') ap.thrRef = 'CON';
  }

  // --- MCP automatic IAS/MACH changeover (crossover) ---
  const sel = ap.sel;
  if (!s.onGround && s.mach > 0.3 && !ap.spdWindowBlank) {
    if (!sel.useMach && s.vsFpm > 300 && s.mach * num(sel.spdKt) / Math.max(s.casKt, 1) > 0.8405) { sel.useMach = true; sel.mach = 0.84; }
    else if (sel.useMach && s.vsFpm < -300 && s.casKt * num(sel.mach) / s.mach > 310.5) { sel.useMach = false; sel.spdKt = 310; }
  }

  // --- localizer / glideslope capture ---
  if (m.armedRoll === 'LOC' && ils.locCapturable && !s.onGround) {
    const yR = num(ils.locDevM); // + right of course
    const ydot = s.gs * Math.sin(wrapPi(s.track - num(ils.crsRad)));
    const closing = sign(ydot) === -sign(yR);
    const trkOk = Math.abs(wrapPi(s.track - num(ils.crsRad))) < 120 * DEG;
    if (trkOk && (Math.abs(yR) < 60 || (closing && Math.abs(yR) < Math.abs(ydot) * 14 + 60))) {
      setRoll(sim, 'LOC');
    }
  }
  if (m.armedPitch === 'G/S' && ils.gsCapturable && m.roll === 'LOC' && !s.onGround) {
    const z = num(ils.gsDevM); // + above path
    const zdot = s.vs + s.gs * Math.tan(num(ils.gsDeg, 3) * DEG); // rate of change of height above path
    const converging = sign(z) === -sign(zdot);
    if (Math.abs(z) < 15 || (converging && Math.abs(z) < Math.abs(zdot) * 6 + 15)) {
      setPitch(sim, 'G/S', s);
      if (ap.atEngaged) setAT(sim, 'SPD');
    }
  }

  // --- altitude capture from climbs/descents ---
  const capModes = ['V/S', 'FPA', 'FLCH SPD', 'TO/GA'];
  if (!s.onGround && capModes.includes(m.pitch) && !(m.pitch === 'TO/GA' && s.raFt < 400)) {
    const tgt = num(sel.altFt), err = tgt - s.altFt, vsFt = s.vs / FT;
    const toward = sign(err) === sign(vsFt) && Math.abs(vsFt) > 0.5;
    if ((toward && Math.abs(err) <= Math.max(Math.abs(vsFt) * T_CAP, 40)) || (m.pitch === 'FLCH SPD' && Math.abs(err) < 40)) {
      captureAlt(sim, s, 'ALT', tgt);
    }
  }
  // --- VNAV sub-mode logic ---
  if (m.pitch.startsWith('VNAV')) vnavTransitions(sim, s);

  // --- speed envelope reversions (V/S, FPA) ---
  if ((m.pitch === 'V/S' || m.pitch === 'FPA') && !s.onGround) {
    const climbing = m.pitch === 'V/S' ? num(sel.vsFpm) > 0 : num(sel.fpaDeg) > 0;
    if (climbing && s.casKt < s.minSpd - 5 && s.casDot < 0) { setPitch(sim, 'FLCH SPD', s); if (ap.atEngaged) setAT(sim, 'THR'); }
  }

  // --- A/T: IDLE -> HOLD, HOLD wake-up ---
  if (ap.atEngaged) {
    if (m.at === 'IDLE' && s.lever < 0.03 && !s.onGround && m.pitch !== 'FLARE' && m.roll !== 'ROLLOUT' && I.idleT > 1.0) setAT(sim, 'HOLD');
    I.idleT = m.at === 'IDLE' ? num(I.idleT) + dt : 0;
    if (m.at === 'HOLD' && !s.onGround && m.pitch !== 'TO/GA' && s.casKt < s.minSpd) setAT(sim, 'SPD');
    if (m.pitch === 'VNAV PTH' && m.at !== 'SPD' && vnavDescending(sim, s) && s.casKt < ap.tgtSpdKt - 12) setAT(sim, 'SPD');
    // A/T disconnects automatically when reverse thrust is selected after landing
    if (s.onGround && (num(sim.controls.reverse[0]) > 0.05 || num(sim.controls.reverse[1]) > 0.05)) atDisconnect(sim, false);
  }

  // --- autoland sequencing ---
  autoland(sim, s);
}

function vnavTransitions(sim, s) {
  const ap = sim.ap, m = ap.modes, fmc = sim.fmc, sel = ap.sel;
  const crz = num(fmc.crzAltFt, 35000), mcp = num(sel.altFt), vsFt = s.vs / FT;
  const band = (err) => Math.abs(err) <= Math.max(Math.abs(vsFt) * T_CAP, 40) && sign(err) === sign(vsFt);
  if (m.pitch === 'VNAV SPD' && vnavClimbing(sim, s)) {
    const tgt = Math.min(crz, mcp);
    if (band(tgt - s.altFt) || Math.abs(tgt - s.altFt) < 40) captureAlt(sim, s, tgt === crz ? 'VNAV PTH' : 'VNAV ALT', tgt);
  }
  // descent path speed management: unable to hold speed on the path -> VNAV SPD; back on path -> PTH
  if (m.pitch === 'VNAV PTH' && ap.holdAltFt === null && vnavDescending(sim, s)) {
    fmc.msg = s.casKt > ap.tgtSpdKt + 8 ? 'DRAG REQUIRED' : fmc.msg === 'DRAG REQUIRED' ? '' : fmc.msg;
    // hold the path while the speed is within +15 kt (or below VMO); beyond that give up the path
    if (s.casKt > Math.min(ap.tgtSpdKt + 15, s.maxSpd) && s.casDot > 0.1) setPitch(sim, 'VNAV SPD', s);
  } else if (m.pitch === 'VNAV SPD' && vnavDescending(sim, s) && fmc.pathAltFt !== null
    && s.altFt < fmc.pathAltFt + 150 && s.casKt < ap.tgtSpdKt + 5) {
    setPitch(sim, 'VNAV PTH', s);
  } else if (fmc.msg === 'DRAG REQUIRED') fmc.msg = '';
  if (m.pitch === 'VNAV SPD' && !vnavClimbing(sim, s) || (m.pitch === 'VNAV PTH' && vnavDescending(sim, s) && ap.holdAltFt === null)) {
    // descending: capture the MCP altitude
    if (mcp < s.altFt && (band(mcp - s.altFt) || Math.abs(mcp - s.altFt) < 40)) captureAlt(sim, s, 'VNAV ALT', mcp);
    if (m.pitch === 'VNAV SPD' && !vnavDescending(sim, s) && !vnavClimbing(sim, s)) captureAlt(sim, s, 'VNAV PTH', Math.round(s.altFt));
  } else if (m.pitch === 'VNAV ALT' || m.pitch === 'VNAV PTH') {
    const held = num(ap.holdAltFt, s.altFt);
    // resume climb when the MCP altitude is raised (simplified – no knob push required)
    if (vnavClimbing(sim, s) && mcp > held + 100 && held < crz - 100) { ap.holdAltFt = null; setPitch(sim, 'VNAV SPD', s); }
    // start the descent at T/D once the MCP altitude has been lowered
    else if (vnavDescending(sim, s) && mcp < held - 100 && (fmc.todNm === null || fmc.todNm <= 0.5)) {
      ap.holdAltFt = null; setPitch(sim, fmc.pathAltFt !== null ? 'VNAV PTH' : 'VNAV SPD', s);
      if (m.pitch === 'VNAV PTH') atFollowPitch(sim, s);
    }
    // VNAV ALT at the cruise altitude becomes VNAV PTH
    if (m.pitch === 'VNAV ALT' && Math.abs(held - crz) < 50) { ap.modes.pitch = 'VNAV PTH'; }
  }
}

function autoland(sim, s) {
  const ap = sim.ap, m = ap.modes, I = ap._;
  const both = m.roll === 'LOC' && m.pitch === 'G/S';
  if (ap.apEngaged && !s.onGround && s.raFt < 1500 && (both || ap.land)) {
    if (!ap.land) {
      const engOk = sim.engines.every((e) => e.running !== false);
      ap.land = engOk ? 'LAND 3' : 'LAND 2';
      m.armedPitch = 'FLARE'; m.armedRoll = 'ROLLOUT';
    }
  } else if (ap.apEngaged && !s.onGround && s.raFt < 1500 && (m.armedRoll === 'LOC' || m.armedPitch === 'G/S')) {
    ap.land = 'NO AUTOLAND';
  } else if (!ap.apEngaged || s.raFt >= 1600) {
    if (ap.land && m.roll !== 'ROLLOUT') ap.land = '';
  }
  if (ap.land === 'LAND 3' || ap.land === 'LAND 2') {
    if (m.pitch === 'G/S' && s.raFt < 50 && !s.onGround) {
      I.flareTau = clamp(50 / Math.max(-s.vs / FT - 2, 3), 3, 8);
      m.armedPitch = ''; setPitch(sim, 'FLARE');
    }
    if (m.pitch === 'FLARE' && s.raFt < 25 && ap.atEngaged && m.at !== 'IDLE') setAT(sim, 'IDLE');
    if (s.onGround && m.armedRoll === 'ROLLOUT') {
      m.armedRoll = ''; setRoll(sim, 'ROLLOUT'); I.rolloutHdg = null;
      if (ap.atEngaged) setAT(sim, 'IDLE');
    }
    if (s.onGround && m.pitch === 'FLARE' && s.wowNose) setPitch(sim, '');
  }
}

// ---------------------------------------------------------------------------------------------
// Pitch outer loops: return { gamma } (flight path command) or { theta } (attitude command)
// ---------------------------------------------------------------------------------------------
function targetSpeed(sim, s) {
  const ap = sim.ap, sel = ap.sel, fmc = sim.fmc, m = ap.modes;
  let kt = num(sel.spdKt, 250), mach = null;
  const vnav = m.pitch.startsWith('VNAV') && !ap.spdIntv;
  ap.spdWindowBlank = vnav;
  if (vnav) {
    kt = num(fmc.vnavTargetSpdKt, kt);
    if (fmc.vnavTargetMach && s.mach > 0.3) {
      const k = s.casKt * fmc.vnavTargetMach / s.mach;
      if (k < kt) { kt = k; mach = fmc.vnavTargetMach; }
    }
  } else if (m.pitch === 'TO/GA' && !s.onGround) {
    if (ap._.ga) kt = ap._.gaSpd;
    else { const v2 = num(fmc.v2, 0) > 0 ? fmc.v2 : num(sel.spdKt, 160); kt = clamp(Math.max(v2 + 15, ap._.casLiftoff), v2 + 15, v2 + 25); }
  } else if (sel.useMach) {
    mach = num(sel.mach, 0.84);
    kt = s.mach > 0.1 ? s.casKt * mach / s.mach : kt;
  }
  // envelope limits
  if (!s.onGround) kt = clamp(kt, s.minSpd, Math.max(s.minSpd, s.maxSpd - 5));
  ap.tgtSpdKt = kt; ap.tgtMach = mach; ap.tgtIsMach = mach !== null;
  return kt;
}

/** Speed-on-elevator law: path angle that drives the speed error to zero with time constant 1/K_SPD. */
function speedOnElevator(sim, s, tgtKt, gMin, gMax) {
  const ratio = s.tas / Math.max(s.casKt * KT, 30);
  const vdot = s.casDot * KT * ratio;                   // m/s² (TAS)
  const e = (s.casKt - tgtKt) * KT * ratio;            // + = too fast
  const g = s.gamma + (vdot + K_SPD * e) / G0;
  return clamp(g, gMin, gMax);
}

const vsToGamma = (vsMs, s) => Math.asin(clamp(vsMs / s.tas, -0.5, 0.5));

function altHoldGamma(sim, s, dt) {
  const ap = sim.ap, I = ap._;
  const tgt = num(ap.holdAltFt, s.altFt);
  const err = tgt - s.altFt;
  if (Math.abs(err) < 25) I.capturing = false;
  if (!I.capturing && Math.abs(err) < 100) I.altI = clamp(I.altI + err * dt / 3000, -3, 3); // ft/s, slow trim term
  let vsCmd = err / T_CAP + (I.capturing ? 0 : I.altI);  // ft/s
  vsCmd = clamp(vsCmd, -100, 100);
  return vsToGamma(rateLimitVs(I, vsCmd * FT, s, dt), s);
}
// limit the commanded vertical speed change to ~0.08 g
function rateLimitVs(I, vsCmd, s, dt) {
  if (I.vsCmdPrev === null) I.vsCmdPrev = s.vs;
  I.vsCmdPrev = approach(I.vsCmdPrev, vsCmd, 0.08 * G0, dt);
  return I.vsCmdPrev;
}

function pitchLaw(sim, s, dt) {
  const ap = sim.ap, I = ap._, m = ap.modes, sel = ap.sel, fmc = sim.fmc, ils = sim.nav.ils;
  const tgt = targetSpeed(sim, s);
  let out = null;
  switch (m.pitch) {
    case 'ALT': case 'VNAV ALT':
      out = { gamma: altHoldGamma(sim, s, dt) }; break;
    case 'V/S':
      out = { gamma: vsToGamma(rateLimitVs(I, num(sel.vsFpm) * FPM, s, dt), s) }; break;
    case 'FPA':
      out = { gamma: clamp(num(sel.fpaDeg) * DEG, -10 * DEG, 10 * DEG) }; I.vsCmdPrev = s.vs; break;
    case 'FLCH SPD': {
      const up = num(sel.altFt) >= s.altFt;
      out = { gamma: up ? speedOnElevator(sim, s, tgt, vsToGamma(0, s), 15 * DEG) : speedOnElevator(sim, s, tgt, -12 * DEG, 0) };
      I.vsCmdPrev = s.vs; break;
    }
    case 'VNAV SPD': {
      const up = vnavClimbing(sim, s);
      out = { gamma: up ? speedOnElevator(sim, s, tgt, 0, 15 * DEG) : speedOnElevator(sim, s, tgt, -12 * DEG, 0) };
      I.vsCmdPrev = s.vs; break;
    }
    case 'VNAV PTH': {
      if (ap.holdAltFt !== null) { out = { gamma: altHoldGamma(sim, s, dt) }; break; }
      // descent path: feed-forward path V/S + altitude error correction, with speed protection
      const pAlt = num(fmc.pathAltFt, s.altFt);
      let vs = num(fmc.pathVsFpm) * FPM + (pAlt - s.altFt) * FT / 20;
      const over = s.casKt - (tgt + 8);
      if (over > 0) vs += over * 0.6;                     // too fast: shallower (m/s per kt)
      if (s.casKt < tgt - 15) vs -= (tgt - 15 - s.casKt) * 0.3;
      vs = clamp(vs, -6000 * FPM, 0);
      out = { gamma: vsToGamma(rateLimitVs(I, vs, s, dt), s) };
      break;
    }
    case 'G/S': {
      const gsAng = num(ils.gsDeg, 3) * DEG;
      const z = num(ils.gsDevM);                        // m above the path
      const vs = -s.gs * Math.tan(gsAng) - clamp(z / 7, -6, 6);
      out = { gamma: vsToGamma(rateLimitVs(I, vs, s, dt), s) };
      break;
    }
    case 'FLARE': {
      // exponential flare: sink rate proportional to height, ~2 ft/s at touchdown
      const vsFt = -(Math.max(s.raFt, 0) / I.flareTau) - 2;
      I.vsCmdPrev = vsFt * FT;
      out = { gamma: vsToGamma(vsFt * FT, s) };
      break;
    }
    case 'TO/GA':
      if (s.onGround) out = { theta: 8 * DEG };
      else {
        out = { gamma: speedOnElevator(sim, s, tgt, I.ga ? 2 * DEG : 1 * DEG, 15 * DEG), thetaMax: 15 * DEG };
        if (s.raFt < 30 && !I.ga) out = { theta: Math.min(Math.max(s.theta, 8 * DEG), 15 * DEG), thetaMax: 15 * DEG };
      }
      I.vsCmdPrev = s.vs;
      break;
    default:
      if (s.onGround) out = { theta: m.roll === 'ROLLOUT' ? 0 : s.theta };
      else out = null;
      I.vsCmdPrev = s.vs;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Roll outer loops -> bank command
// ---------------------------------------------------------------------------------------------
function autoBankLimit(s) {
  const tasKt = s.tas / KT;
  return clamp(25 - (tasKt - 350) / 15, 15, 25) * DEG; // 25° up to 350 KTAS, 15° by 500 KTAS
}
function bankLimit(sim, s) {
  const b = num(sim.ap.sel.bankLimitDeg);
  return b > 0 ? Math.min(b * DEG, 25 * DEG) : autoBankLimit(s);
}
/** Track loop gain so the heading/track error decays with ~10 s time constant regardless of speed. */
const trackGain = (s) => clamp(s.tas / (G0 * 10), 0.8, 3.2);

/** Path-following: lateral offset y (+ right of course), course crs -> bank command. */
function lateralLaw(s, y, crs, tau, maxIntercept, lim) {
  const gs = Math.max(s.gs, 40);
  const ydotDes = -y / tau;
  const trkCmd = crs + Math.asin(clamp(ydotDes / gs, -Math.sin(maxIntercept), Math.sin(maxIntercept)));
  return clamp(trackGain(s) * wrapPi(trkCmd - s.track), -lim, lim);
}

function rollLaw(sim, s, dt) {
  const ap = sim.ap, I = ap._, m = ap.modes, fmc = sim.fmc, ils = sim.nav.ils;
  const lim = bankLimit(sim, s);
  switch (m.roll) {
    case 'HDG SEL':
      return clamp(trackGain(s) * wrapPi(hdgSelTrue(sim, s) - s.hdg), -lim, lim);
    case 'TRK SEL':
      return clamp(trackGain(s) * wrapPi(hdgSelTrue(sim, s) - s.track), -lim, lim);
    case 'HDG HOLD': case 'TRK HOLD': {
      const ref = m.roll === 'HDG HOLD' ? s.hdg : s.track;
      if (I.hdgHold === null) {
        if (Math.abs(s.phi) < 3 * DEG) I.hdgHold = ref; else return 0;
      }
      return clamp(trackGain(s) * wrapPi(I.hdgHold - ref), -lim, lim);
    }
    case 'LNAV':
      return lateralLaw(s, num(fmc.xtkM), num(fmc.dtkRad), 30, 45 * DEG, 25 * DEG);
    case 'LOC':
      return lateralLaw(s, num(ils.locDevM), num(ils.crsRad), s.raFt < 300 ? 14 : 20, 30 * DEG, s.raFt < 200 ? 5 * DEG : 25 * DEG);
    case 'ATT':
      return clamp(I.attBank, -30 * DEG, 30 * DEG);
    case 'TO/GA':
      if (s.onGround || I.togaTrack === null) return 0;
      return clamp(trackGain(s) * wrapPi(I.togaTrack - s.track), -15 * DEG, 15 * DEG);
    case 'ROLLOUT':
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Inner loops: commanded attitude -> virtual column / wheel / pedal
// ---------------------------------------------------------------------------------------------
function innerLoops(sim, s, dt, pc, phiCRaw) {
  const ap = sim.ap, I = ap._, out = ap.out;
  // ---- commanded attitude (also drives the FD bars) ----
  let thetaTarget;
  if (!pc) thetaTarget = s.theta;
  else if (pc.theta !== undefined) thetaTarget = pc.theta;
  else thetaTarget = pc.gamma + I.dTheta;
  thetaTarget = clamp(thetaTarget, PITCH_MIN, pc && pc.thetaMax ? pc.thetaMax : PITCH_MAX);
  if (I.thetaCmd === null || !Number.isFinite(I.thetaCmd)) I.thetaCmd = s.theta;
  const prevTheta = I.thetaCmd;
  I.thetaCmd = approach(I.thetaCmd, thetaTarget, THETA_RATE, dt);
  const thetaRate = (I.thetaCmd - prevTheta) / dt;
  const prevPhi = num(I.phiCmd);
  I.phiCmd = approach(prevPhi, clamp(phiCRaw, -30 * DEG, 30 * DEG), PHI_RATE, dt);
  const phiRate = (I.phiCmd - prevPhi) / dt;

  const engaged = ap.apEngaged && !sim.ac.crashed && (!s.onGround || ap.modes.roll === 'ROLLOUT');
  out.active = engaged;
  if (!engaged) { out.pitch = 0; out.roll = 0; out.yaw = 0; I.pitchI = 0; I.rollI = 0; return; }

  // ---- pitch: desired pitch rate -> C* column ----
  const V = Math.max(s.tas, 50);
  const colPerQ = (V + V_CO) / (C_STAR_FULL * G0);     // column per rad/s of steady pitch rate
  const eTh = I.thetaCmd - s.theta;
  const qd = clamp(0.9 * eTh + thetaRate, -3 * DEG, 3 * DEG);
  I.pitchI = clamp(I.pitchI + 0.35 * eTh * dt, -0.35, 0.35);
  let col = colPerQ * (qd + 0.6 * (qd - s.q)) + I.pitchI;
  if (s.onGround) { col = s.wowNose ? 0 : -0.06; I.pitchI = 0; } // de-rotate gently after touchdown
  out.pitch = clamp(col, -0.6, 0.6);

  // ---- roll: desired roll rate -> wheel ----
  const ePhi = I.phiCmd - s.phi;
  const pd = clamp(0.8 * ePhi + phiRate, -5 * DEG, 5 * DEG);
  // integrate only once the bank command is steady (prevents wind-up during roll-in)
  if (Math.abs(phiRate) < 0.2 * DEG && Math.abs(ePhi) < 4 * DEG) I.rollI = clamp(I.rollI + 0.25 * ePhi * dt, -0.2, 0.2);
  let wheel = (pd + 0.5 * (pd - s.p)) / ROLL_RATE_FULL + I.rollI;
  if (s.onGround) { wheel = 0; I.rollI = 0; }
  out.roll = clamp(wheel, -0.6, 0.6);

  // ---- yaw: rollout steering on the localizer (pedals steer the nose wheel on the ground) ----
  out.yaw = 0;
  if (ap.modes.roll === 'ROLLOUT' && s.onGround) {
    const ils = sim.nav.ils, crs = num(ils.crsRad, s.hdg);
    const yR = ils.valid ? num(ils.locDevM) : 0;
    const hdgCmd = crs + clamp(-yR * 0.4, -4, 4) * DEG;
    out.yaw = clamp(0.25 * wrapPi(hdgCmd - s.hdg) * RAD - 0.35 * s.r * RAD, -1, 1);
  }
}

// ---------------------------------------------------------------------------------------------
// Autothrottle
// ---------------------------------------------------------------------------------------------
function autothrottle(sim, s, dt, pc) {
  const ap = sim.ap, I = ap._, m = ap.modes;
  I.lastLever = s.lever;
  if (!ap.atEngaged || !ap.atArm) { ap.thrustCmd = null; if (!ap.atArm) { ap.atEngaged = false; m.at = ''; } return; }
  if (!m.at) setAT(sim, s.onGround ? 'THR REF' : 'SPD');
  const refLever = REF_LEVER[ap.thrRef] || REF_LEVER.CLB;
  let cmd = null;
  switch (m.at) {
    case 'THR REF': cmd = refLever; break;
    case 'IDLE': cmd = 0; break;
    case 'HOLD': cmd = null; break;
    case 'THR': {
      // thrust for a target climb/descent rate (FLCH small changes, go-around 2000 fpm)
      const dAlt = num(ap.sel.altFt) - s.altFt;
      let vsTgt;
      if (I.ga || m.pitch === 'TO/GA') vsTgt = 2000;
      else vsTgt = sign(dAlt) * clamp(Math.abs(dAlt), 1000, 4000);
      if (vsTgt > 0 && Math.abs(dAlt) >= 4000 && !I.ga) { I.atI = approach(I.atI, refLever, 0.1, dt); cmd = I.atI; break; } // full climb thrust
      // slow integrator: the elevator holds speed, thrust only shapes the climb/descent rate
      I.atI = clamp(I.atI + 0.00003 * (vsTgt - s.vsFpm) * dt, 0, refLever);
      cmd = I.atI;
      if (sign(dAlt) < 0 && Math.abs(dAlt) > 3000 && m.pitch === 'FLCH SPD') { setAT(sim, 'IDLE'); cmd = 0; }
      break;
    }
    case 'SPD':
    default: {
      // speed error -> commanded acceleration (kt/s) -> lever via PI on acceleration error,
      // with flight-path feed-forward so climbs/descents do not first cost speed.
      const tgt = ap.tgtSpdKt;
      const e = tgt - s.casKt;
      const aCmd = clamp(AT_KV * e, -AT_AMAX, AT_AMAX);
      const aErr = aCmd - s.casDot;
      const gam = pc && pc.gamma !== undefined ? pc.gamma : s.gamma;
      const ff = AT_KGAM * clamp(gam, -0.1, 0.1);
      const hi = Math.min(refLever, 1), lo = 0;
      const unsat = I.atI + ff + AT_KA * aErr;
      if (!((unsat >= hi && aErr > 0) || (unsat <= lo && aErr < 0))) I.atI += AT_KI * aErr * dt;
      I.atI = clamp(I.atI, -0.3, 1.1);
      cmd = clamp(I.atI + ff + AT_KA * aErr, lo, hi);
      break;
    }
  }
  ap.thrustCmd = cmd === null ? null : clamp(cmd, 0, 1);
}

// ---------------------------------------------------------------------------------------------
// FMA / FD
// ---------------------------------------------------------------------------------------------
function syncModes(sim) {
  const m = sim.ap.modes;
  for (const k of ['at', 'roll', 'pitch', 'armedRoll', 'armedPitch', 'ap']) if (typeof m[k] !== 'string') m[k] = '';
}

function annunciate(sim, s) {
  const ap = sim.ap, m = ap.modes, I = ap._;
  syncModes(sim);
  const fd = anyFd(sim);
  if (ap.apEngaged) m.ap = ap.land || 'A/P';
  else if (fd && (m.roll || m.pitch)) m.ap = 'FLT DIR';
  else m.ap = '';
  if (!ap.atEngaged) m.at = '';
  // FD bars: absolute commanded attitude
  ap.fd.pitchDeg = I.thetaCmd * RAD;
  ap.fd.rollDeg = I.phiCmd * RAD;
  ap.fd.pitchValid = fd && !!m.pitch && m.pitch !== 'FLARE';
  ap.fd.rollValid = fd && !!m.roll && m.roll !== 'ROLLOUT';
  ap.fd.valid = ap.fd.pitchValid || ap.fd.rollValid;
}

/** Utility for displays: is the given speed in Mach? */
export function afdsTargetSpeed(sim) { return { kt: sim.ap.tgtSpdKt, mach: sim.ap.tgtMach, isMach: sim.ap.tgtIsMach }; }
