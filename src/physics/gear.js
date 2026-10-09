// Landing gear & ground interaction: gear actuator, spring-damper struts,
// tyre friction (rolling, braking with anti-skid, cornering with slip-angle
// saturation), main-bogie scrub, nose-wheel steering, brakes + autobrake (incl.
// RTO), auto ground spoilers, touchdown evaluation and crash detection.

import { clamp, lerp, approach, lag, qrot, qrotInv, vcross, KT, FPM, DEG, RAD } from '../core/geo.js';
import { GEAR as GD, SURF } from './aircraft777.js';

export function createGearState(onGround) {
  return {
    brakeP: [0, 0], steer: 0,
    ab: { setting: 'OFF', state: 'OFF', P: 0, wasAirborne: !onGround, toThrust: false, decelF: 0 },
    groundSpoiler: false,
    airborneT: onGround ? 0 : 100, mainWowT: onGround ? 100 : 0,
    prevGs: 0, decel: 0, tailT: -99, events: [],
  };
}

// ------------------------------------------------------------ gear lever
export function stepGearActuator(sim, G, onGround, dt) {
  const s = sim.surfaces;
  const down = sim.controls.gearLever !== 'UP';
  s.gearTarget = down ? 1 : onGround ? 1 : 0; // squat-switch lock prevents retraction on ground
  s.gear = approach(s.gear, s.gearTarget, 1 / SURF.gearTransitS, dt);
}

// ------------------------------------------------------- brakes & steering
const LANDING_AB = ['1', '2', '3', '4', 'MAX'];

function stepAutobrake(sim, G, ctx, dt) {
  const c = sim.controls, ab = G.ab;
  const setting = c.autobrake || 'OFF';
  if (setting !== ab.setting) {
    ab.setting = setting;
    ab.state = setting === 'OFF' || setting === 'DISARM' ? 'OFF' : 'ARMED';
    ab.P = 0;
    ab.wasAirborne = !ctx.onGround;
    ab.toThrust = false;
  }
  const thrIdle = c.throttle[0] < 0.05 && c.throttle[1] < 0.05;
  const thrAdv = c.throttle[0] > 0.1 || c.throttle[1] > 0.1;
  const pedal = Math.max(c.brakeL || 0, c.brakeR || 0);
  if (G.airborneT > 5) ab.wasAirborne = true;
  if (ab.state === 'ARMED' && setting === 'RTO') {
    if (!ctx.onGround && G.airborneT > 2) ab.state = 'OFF';
    if (ctx.onGround && (c.throttle[0] > 0.5 || c.throttle[1] > 0.5)) ab.toThrust = true;
    if (ctx.onGround && ab.toThrust && thrIdle && ctx.gsKt > GD.rtoMinKt) ab.state = 'ACTIVE';
  } else if (ab.state === 'ARMED' && LANDING_AB.includes(setting)) {
    if (ab.wasAirborne && G.mainWowT > 0.3 && ctx.gsKt > 30 && thrIdle) { ab.state = 'ACTIVE'; ab.P = 0.15; }
  }
  if (ab.state === 'ACTIVE') {
    if (pedal > 0.4 || (setting !== 'RTO' && thrAdv) || (setting === 'RTO' && (c.throttle[0] > 0.3 || c.throttle[1] > 0.3))) {
      ab.state = 'DISARMED'; ab.P = 0;
    } else if (setting === 'RTO') {
      ab.P = approach(ab.P, 1, 1, dt);
    } else if (ctx.gsKt > 3) {
      const target = GD.autobrakeDecel[setting];
      const err = target - G.decel;
      ab.P = clamp(ab.P + (0.35 * err) * dt, 0, 1);
      ab.decelTarget = target;
    }
  } else if (ab.state !== 'ACTIVE') ab.P = 0;
}

export function stepBrakesAndSteering(sim, G, ctx, dt) {
  const c = sim.controls, s = sim.surfaces;
  // measured longitudinal deceleration from ground speed
  const a = (G.prevGs - ctx.gs) / dt;
  G.prevGs = ctx.gs;
  G.decel = lag(G.decel, clamp(a, -10, 10), 0.3, dt);
  stepAutobrake(sim, G, ctx, dt);
  const park = c.parkingBrake ? 1 : 0;
  const cmd = [Math.max(c.brakeL || 0, park, G.ab.P), Math.max(c.brakeR || 0, park, G.ab.P)];
  for (let i = 0; i < 2; i++) G.brakeP[i] = lag(G.brakeP[i], clamp(cmd[i], 0, 1), GD.brakeTau, dt);
  s.brakes[0] = G.brakeP[0]; s.brakes[1] = G.brakeP[1];
  s.autobrakeState = G.ab.state;

  // nose-wheel steering: tiller authority fades with speed, pedals ±7°
  const gsKt = ctx.gsKt;
  const tMax = gsKt < 20 ? GD.tillerMax : gsKt < 60 ? lerp(GD.tillerMax, 10 * DEG, (gsKt - 20) / 40) : Math.max(0, 10 * DEG - (gsKt - 60) * 0.25 * DEG);
  const tgt = ctx.noseWow ? clamp((Number.isFinite(c.tiller) ? c.tiller : 0) * tMax + clamp(ctx.yaw, -1, 1) * GD.pedalSteerMax, -GD.tillerMax, GD.tillerMax) : 0;
  G.steer = approach(G.steer, tgt, GD.steerRate, dt);
  s.noseWheel = G.steer;

  // auto ground spoilers
  const anyRev = (c.reverse?.[0] || 0) > 0.05 || (c.reverse?.[1] || 0) > 0.05;
  const thrIdle = c.throttle[0] < 0.05 && c.throttle[1] < 0.05;
  if (ctx.mainWow && ((c.speedbrakeArmed && thrIdle && (G.ab.wasAirborne || ctx.gsKt > 60)) || anyRev || (G.ab.state === 'ACTIVE' && G.ab.setting === 'RTO'))) G.groundSpoiler = true;
  if (c.throttle[0] > 0.3 || c.throttle[1] > 0.3 || (!c.speedbrakeArmed && !anyRev && G.ab.setting !== 'RTO') || !ctx.mainWow && G.airborneT > 1) G.groundSpoiler = false;
}

// ------------------------------------------------------------ ground forces
/**
 * Strut, tyre and structure contact forces.
 * st: { q, omega, vNED, h, groundH, heading, dx (CG shift, m aft), gearPos, mass }
 * Returns { Fned, Mbody, wow, ra, struct: [{id, pen, rate, crash}], strutLoad, comp }
 */
export function computeGround(sim, G, st) {
  const Fned = [0, 0, 0], Mb = [0, 0, 0];
  const wow = { nose: false, left: false, right: false };
  const comp = { nose: 0, left: 0, right: 0 };
  const hits = [];
  let ra = Infinity;
  const ch = Math.cos(st.heading), sh = Math.sin(st.heading);
  const gearOk = st.gearPos > 0.98;

  const apply = (r, Fn) => {
    Fned[0] += Fn[0]; Fned[1] += Fn[1]; Fned[2] += Fn[2];
    const Fb = qrotInv(st.q, Fn);
    const m = vcross(r, Fb);
    Mb[0] += m[0]; Mb[1] += m[1]; Mb[2] += m[2];
  };
  const pointState = (r) => {
    const d = qrot(st.q, r);
    const pen = st.groundH - (st.h - d[2]);
    const vp = qrot(st.q, vcross(st.omega, r));
    return { pen, v: [st.vNED[0] + vp[0], st.vNED[1] + vp[1], st.vNED[2] + vp[2]] };
  };

  // --- struts
  for (const g of GD.struts) {
    const r = [g.x + st.dx, g.y, g.z];
    const ps = pointState(r);
    ra = Math.min(ra, -ps.pen);
    if (!gearOk || ps.pen <= 0) continue;
    const rate = ps.v[2];
    let Fs = g.k * ps.pen + (rate > 0 ? g.cComp : g.cExt) * rate;
    if (ps.pen > g.stroke) Fs += g.kBottom * (ps.pen - g.stroke);
    Fs = Math.max(0, Fs);
    comp[g.id] = ps.pen;
    if (Fs < 500) continue;
    wow[g.id] = true;
    // wheel axes (nose wheel steered)
    const psi = g.steer ? G.steer : 0;
    const cw = Math.cos(psi), sw = Math.sin(psi);
    const lon = [ch * cw - sh * sw, sh * cw + ch * sw];
    const lat = [-lon[1], lon[0]];
    const vl = ps.v[0] * lon[0] + ps.v[1] * lon[1];
    const vt = ps.v[0] * lat[0] + ps.v[1] * lat[1];
    const N = Fs;
    let Fl = -GD.muRoll * N * clamp(vl / 0.3, -1, 1);
    if (g.brake) {
      const side = g.id === 'left' ? 0 : 1;
      const muB = GD.muBrakeDry * (1 - 0.0025 * Math.min(Math.abs(vl), 90));
      const Fb = Math.min(G.brakeP[side] * GD.brakeFmax, muB * N);
      Fl -= Fb * clamp(vl / 0.05, -1, 1);
    }
    let Ft = -GD.muLatMax * N * Math.tanh(vt / (Math.tan(GD.slip0) * Math.abs(vl) + 0.12));
    const tot = Math.hypot(Fl, Ft), lim = GD.muPeak * N;
    if (tot > lim) { Fl *= lim / tot; Ft *= lim / tot; }
    apply(r, [Fl * lon[0] + Ft * lat[0], Fl * lon[1] + Ft * lat[1], -Fs]);
    // six-wheel bogie scrub resists yawing (reduced when aft axle steers)
    if (!g.steer) {
      const aft = Math.abs(G.steer) > 13 * DEG && st.gsKt < 20;
      const vs = st.omega[2] * GD.bogieArm;
      const Ms = -2 * GD.muLatMax * (N / 3) * GD.bogieArm * Math.tanh(vs / (Math.tan(GD.slip0) * Math.abs(vl) + 0.12)) * (aft ? GD.scrubFactorSteer : 1);
      Mb[2] += Ms;
    }
  }

  // --- structure points (tail, nacelles, wingtips, belly, nose)
  for (const p of GD.structure) {
    const r = [p.x + st.dx, p.y, p.z];
    const ps = pointState(r);
    if (ps.pen <= 0) continue;
    const rate = ps.v[2];
    const Fs = Math.max(0, GD.structK * ps.pen + GD.structC * rate);
    const vh = Math.hypot(ps.v[0], ps.v[1]);
    const f = (GD.structMu * Fs) / Math.max(vh, 0.3);
    apply(r, [-ps.v[0] * f, -ps.v[1] * f, -Fs]);
    hits.push({ id: p.id, pen: ps.pen, rate, crash: p.crash });
  }
  // belly/gear points when the gear is not down & locked count as a crash
  if (!gearOk) {
    for (const g of GD.struts) {
      const ps = pointState([g.x + st.dx, g.y, g.z - 2.2 * (1 - st.gearPos)]);
      if (ps.pen > 0 && st.gearPos > 0.05) hits.push({ id: 'gear-' + g.id, pen: ps.pen, rate: ps.v[2], crash: true });
    }
  }
  return { Fned, Mbody: Mb, wow, ra: Math.max(0, ra), hits, comp };
}

// ------------------------------------------------- touchdown / crash checks
function crash(sim, reason) {
  const ac = sim.ac;
  if (ac.crashed) return;
  ac.crashed = true;
  ac.crashReason = reason;
  sim.events?.emit?.('toast', { text: 'CRASH: ' + reason });
}

/** Evaluate touchdowns, tail strikes and structural contacts after each step. */
export function evaluateContacts(sim, G, gr, ctx, dt) {
  const ac = sim.ac;
  const mainWow = gr.wow.left || gr.wow.right;
  if (mainWow) {
    if (G.airborneT > 2) {
      const fpm = -ctx.vsBefore / FPM;
      G.lastTouchdownFpm = fpm;
      if (fpm > GD.crashLandingFpm) crash(sim, `Hard landing ${fpm.toFixed(0)} fpm — structural failure`);
      else if (fpm > GD.hardLandingFpm) sim.events?.emit?.('toast', { text: `HARD LANDING ${fpm.toFixed(0)} fpm` });
      else sim.events?.emit?.('toast', { text: `Touchdown ${fpm.toFixed(0)} fpm` });
      if (Math.abs(ac.euler.roll) > 12 * DEG) crash(sim, `Wing/engine strike on touchdown (bank ${(ac.euler.roll * RAD).toFixed(0)}°)`);
    }
    G.airborneT = 0;
    G.mainWowT += dt;
  } else {
    G.mainWowT = 0;
    if (!gr.wow.nose) G.airborneT += dt;
  }
  if (gr.wow.nose && !mainWow && ctx.gsKt > 60 && ctx.vsBefore < -2) crash(sim, 'Nose-gear first touchdown — nose gear collapse');
  for (const h of gr.hits) {
    if (h.crash) {
      const what = h.id.startsWith('eng') ? 'Engine nacelle ground strike' : h.id.startsWith('tip') ? 'Wingtip ground strike'
        : h.id.startsWith('gear') ? 'Gear not down & locked' : 'Fuselage contact (gear up?)';
      crash(sim, what);
    } else if (h.id === 'tail') {
      if (h.rate > 4) crash(sim, 'Severe tail strike');
      else if (sim.time - G.tailT > 5) { G.tailT = sim.time; sim.events?.emit?.('toast', { text: 'TAIL STRIKE' }); }
    }
  }
  // gear over-compression (bottoming hard) on any strut
  if (gr.comp.left > 0.85 || gr.comp.right > 0.85 || gr.comp.nose > 0.75) crash(sim, 'Landing gear collapse');
  if (mainWow && Math.abs(ac.euler.pitch) > 25 * DEG) crash(sim, 'Excessive pitch attitude on ground');
  if (ac.onGround && Math.abs(ac.euler.roll) > 20 * DEG) crash(sim, 'Excessive bank on ground');
}

export { KT };
