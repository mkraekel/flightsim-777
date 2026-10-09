// GE90-115B engine model: N2 core spool with acceleration schedule, N1 from N2,
// thrust from corrected N1 with Mattingly-style Mach/altitude lapse, reverse
// thrust with door transit, fuel flow (TSFC), EGT, start sequence and windmilling.

import { clamp, lag, approach, KT } from '../core/geo.js';
import { GEOM, ENGINE as E, SURF } from './aircraft777.js';
import { interp1, interpInv } from './aero.js';

/** Inlet stagnation ratios for the lapse model. */
export function engineEnv(air, M) {
  const theta = air.T / 288.15, delta = air.p / 101325;
  const k = 1 + 0.2 * M * M;
  const theta0 = theta * k, delta0 = delta * Math.pow(k, 3.5);
  return { M, theta, delta, theta0, delta0, sqrtTheta0: Math.sqrt(theta0) };
}

/** Max (takeoff-rated) thrust at the condition, N. */
export function fMax(env) {
  const { M, theta0, delta0 } = env;
  const hot = theta0 > E.TR ? (3 * (theta0 - E.TR)) / (1.5 + M) : 0;
  return Math.max(0, E.Fsls * delta0 * (1 - E.lapseSqrtM * Math.sqrt(Math.max(M, 0)) - hot));
}
export const n1cMax = (env) => E.n1cMaxSL + E.n1cMaxAltGain * Math.max(0, 1 - env.theta0);
/** Mechanical N1 (%) at the takeoff rating for the condition. */
export const n1MaxMech = (env) => Math.min(E.n1MechLimit, n1cMax(env) * env.sqrtTheta0);

/** Gross forward thrust (N) of a running engine at mechanical N1. */
export function thrustAtN1(n1, env) {
  const n1c = n1 / env.sqrtTheta0;
  const n1z = E.n1ZeroBase + E.n1ZeroMach * env.M;
  const fm = fMax(env);
  if (n1c >= n1z) return fm * Math.pow((n1c - n1z) / (n1cMax(env) - n1z), E.thrustExp);
  return -0.03 * E.Fsls * env.delta0 * env.M * ((n1z - n1c) / n1z);
}

/** Mechanical N1 producing thrust F (N) at the condition (bisection). */
export function n1ForThrust(F, env) {
  let lo = 15, hi = E.n1MechLimit;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (thrustAtN1(mid, env) < F) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export const n1FromN2 = (n2) => interp1(E.n2n1, n2);
export const n2FromN1 = (n1) => interpInv(E.n2n1, n1);
export const groundIdleN1 = () => n1FromN2(E.idleN2.ground);

/** Thrust-lever (0..1) to commanded mechanical N1. Lever 0 = ground-idle N1 base. */
export function leverToN1(lever, env) {
  const base = groundIdleN1();
  return base + clamp(lever, 0, 1) * (n1MaxMech(env) - base);
}
export function n1ToLever(n1, env) {
  const base = groundIdleN1();
  return clamp((n1 - base) / (n1MaxMech(env) - base), 0, 1);
}

/** Idle N2 for the current phase (ground / flight / approach idle). */
export function idleN2(onGround, flapsDeg, gearDown) {
  if (onGround) return E.idleN2.ground;
  return flapsDeg >= 24 || gearDown ? E.idleN2.approach : E.idleN2.flight;
}

/** TSFC kg/(N·s) at condition. */
export const tsfc = (env) => E.tsfcSL * (1 + E.tsfcMach * env.M) * Math.pow(env.theta, E.tsfcTheta);

export function createEngineState(running) {
  const n2 = running ? E.idleN2.ground : 0;
  return { lit: running, n2, n1: running ? n1FromN2(n2) : 0, egt: running ? 420 : 15, rev: 0, oilT: running ? 80 : 15 };
}

/** Initialise engine state + sim.engines to a steady N1 (running) or off. */
export function setEngineSteady(sim, es, i, running, n1, env, tAmbC) {
  es.lit = running;
  es.n1 = running ? n1 : 0;
  es.n2 = running ? n2FromN1(n1) : 0;
  es.egt = running ? tAmbC + interp1(E.egtVsN1c, n1 / env.sqrtTheta0) : tAmbC;
  es.oilT = running ? 85 : tAmbC;
  es.rev = 0;
  const se = sim.engines[i];
  se.running = running;
  se.startState = running ? 'RUN' : 'OFF';
}

function stepSpool(es, se, ctl, ctx, i, dt) {
  const idle = ctx.idleN2;
  const fuelOk = ctx.fuelAvail[i] && ctl.fuelControl[i] !== 'CUTOFF' && !se.fire;
  // cutoff / starvation / fire switch, or systems commanding the engine OFF -> flameout
  if (es.lit && (!fuelOk || se.startState === 'OFF')) es.lit = false;
  if (!es.lit) {
    const starting = se.startState === 'STARTING';
    const wm = E.start.windmillPerKt * Math.max(0, ctx.casKt);
    const tgt = Math.max(wm, starting ? E.start.starterN2 : 0);
    es.n2 = tgt > es.n2 ? approach(es.n2, tgt, E.start.starterRate, dt) : lag(es.n2, tgt, 6, dt);
    if (fuelOk && es.n2 >= E.start.lightOffN2 && (starting || (se.startState === 'RUN' && es.n2 > 50))) es.lit = true;
    return;
  }
  if (es.n2 < idle - 0.5) {
    // light-off -> idle acceleration (self-sustaining, starter assisted)
    es.n2 = Math.min(idle, es.n2 + E.start.startAccel * dt * (es.n2 < 45 ? 1 : 1.4));
    return;
  }
  const cmdN2 = Math.max(idle, n2FromN1(ctx.n1cmd[i]));
  const d = cmdN2 - es.n2;
  const rate = d > 0 ? Math.min(interp1(E.accelN2, es.n2), d / E.tauUp) : Math.max(-E.decelMax, d / E.tauDown);
  es.n2 += rate * dt;
}

/**
 * Advance both engines one step. ctx: { env, air, qbar, casKt, onGround, revAllowed,
 * flapsDeg, gearDown, fuelAvail[2], tAmbC }. Writes sim.engines and
 * sim.surfaces.reverser; returns per-engine net thrust (N, along body x).
 */
export function stepEngines(sim, states, ctx, dt) {
  const ctl = sim.controls, env = ctx.env;
  ctx.idleN2 = idleN2(ctx.onGround, ctx.flapsDeg, ctx.gearDown);
  const thrust = [0, 0];
  const n1Idle = n1FromN2(ctx.idleN2);
  ctx.n1cmd = [0, 0];
  for (let i = 0; i < 2; i++) {
    const es = states[i], se = sim.engines[i];
    const lever = Number.isFinite(ctl.throttle[i]) ? ctl.throttle[i] : 0;
    const revLever = Number.isFinite(ctl.reverse?.[i]) ? ctl.reverse[i] : 0;
    // reverser doors: deploy only with lever at idle and on the ground
    const revCmd = revLever > 0.05 && lever < 0.05 && ctx.revAllowed && es.lit ? 1 : 0;
    es.rev = approach(es.rev, revCmd, 1 / SURF.revTransitS, dt);
    ctx.n1cmd[i] = es.rev > 0.9 && revCmd
      ? n1Idle + clamp(revLever, 0, 1) * (E.revN1 - n1Idle)
      : es.rev > 0.05 ? n1Idle : leverToN1(lever, env);

    stepSpool(es, se, ctl, ctx, i, dt);
    es.n2 = clamp(es.n2, 0, 115);
    let n1t = n1FromN2(es.n2);
    if (!es.lit && !ctx.onGround) n1t = Math.max(n1t, 0.09 * Math.max(0, ctx.casKt));
    es.n1 = lag(es.n1, n1t, es.lit ? 0.25 : 2, dt);

    // thrust
    let F;
    if (es.lit && es.n2 >= ctx.idleN2 - 1) F = thrustAtN1(es.n1, env);
    else if (es.lit) F = thrustAtN1(es.n1, env) * clamp((es.n2 - 40) / 22, 0, 1);
    else F = -E.windmillDragCD * ctx.qbar * GEOM.S * (ctx.onGround ? 0 : 1);
    const Fnet = F > 0 ? F * (1 - es.rev) - F * es.rev * E.revFrac : F;
    thrust[i] = Fnet;

    // fuel flow (kg/h)
    let ff = 0;
    if (es.lit) {
      const idleTerm = E.ffIdle * env.delta0 * env.sqrtTheta0 * (es.n2 / 62) ** 3;
      ff = (tsfc(env) * Math.max(F, 0) + idleTerm) * 3600;
    }
    // EGT
    const n1c = es.n1 / env.sqrtTheta0;
    let egtT = ctx.tAmbC;
    if (es.lit) {
      egtT = ctx.tAmbC + interp1(E.egtVsN1c, n1c);
      if (es.n2 < ctx.idleN2 - 0.5) egtT += 380 * Math.sin(Math.PI * clamp((es.n2 - 20) / (ctx.idleN2 - 20), 0, 1));
    }
    es.egt = lag(es.egt, egtT, es.lit ? 2.5 : 25, dt);
    es.oilT = lag(es.oilT, es.n2 > 5 ? 40 + 0.9 * es.n2 : ctx.tAmbC, 90, dt);

    se.n1 = es.n1; se.n2 = es.n2; se.egt = es.egt; se.ff = ff; se.thrust = Fnet;
    se.oilP = es.n2 > 5 ? 15 + 0.8 * es.n2 : 0;
    se.oilT = es.oilT;
    se.vib = es.n2 > 5 ? 0.2 + 0.008 * es.n1 : 0;
    se.running = es.lit && es.n2 >= ctx.idleN2 - 2;
    se.reverser = es.rev;
    // Without a systems module the physics completes the start itself.
    if (!sim.systems?.fuelOwned && se.startState === 'STARTING' && es.lit && es.n2 > 50) se.startState = 'RUN';
    sim.surfaces.reverser[i] = es.rev;
  }
  return thrust;
}

export { KT };
