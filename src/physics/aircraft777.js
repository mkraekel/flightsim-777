// Boeing 777-300ER (GE90-115B) data. ALL numbers used by the physics live here.
// Sources: scratchpad/research/physics.md (tags S#/B747/EST there). Not certified data.
// Conventions: body x fwd, y right, z down; positions relative to the CG at 25 % MAC.
// Surface signs (our convention, see docs/physics.md):
//   elevator + = trailing edge down (nose down)   stab + = nose-up trim
//   droll    + = roll right (equivalent aileron/spoiler deflection, rad)
//   rudder   + = trailing edge right (nose right)

import { DEG, KT } from '../core/geo.js';

export const GEOM = {
  S: 436.8, b: 64.8, cbar: 8.75, sweep: 31.6 * DEG, AR: 9.61, tc: 0.10,
};

export const MASS = {
  OEW: 167829, MTOW: 351535, MLW: 251290, MZFW: 237682, maxFuel: 145538,
  tankCap: { L: 29000, R: 29000, C: 87500 }, // kg usable (approx. 777-300ER split)
};

// Inertia (kg·m²) vs mass, interpolated linearly (research §2).
export const INERTIA = [
  { m: 230000, Ixx: 19e6, Iyy: 42e6, Izz: 60e6, Ixz: 1.0e6 },
  { m: 300000, Ixx: 26e6, Iyy: 51e6, Izz: 76e6, Ixz: 1.3e6 },
  { m: 351535, Ixx: 31e6, Iyy: 57e6, Izz: 87e6, Ixz: 1.5e6 },
];

// ------------------------------------------------------------ aerodynamics
// Flap/slat configurations (research §3.1). CL0 at alpha_body = 0.
// slat: 0 retracted, 0.5 sealed, 1 gapped.  k: induced drag factor 1/(pi·AR·e).
export const FLAP_TABLE = [
  { deg: 0, slat: 0.0, CL0: 0.20, CLmax: 1.45, dCD0: 0.000, dCm0: 0.00, k: 0.0404 },
  { deg: 1, slat: 0.5, CL0: 0.25, CLmax: 1.75, dCD0: 0.004, dCm0: -0.01, k: 0.0404 },
  { deg: 5, slat: 0.5, CL0: 0.45, CLmax: 1.92, dCD0: 0.010, dCm0: -0.04, k: 0.0410 },
  { deg: 15, slat: 0.5, CL0: 0.68, CLmax: 2.05, dCD0: 0.020, dCm0: -0.08, k: 0.0420 },
  { deg: 20, slat: 0.5, CL0: 0.78, CLmax: 2.15, dCD0: 0.027, dCm0: -0.10, k: 0.0440 },
  { deg: 25, slat: 1.0, CL0: 1.00, CLmax: 2.28, dCD0: 0.045, dCm0: -0.14, k: 0.0440 },
  { deg: 30, slat: 1.0, CL0: 1.10, CLmax: 2.35, dCD0: 0.060, dCm0: -0.16, k: 0.0440 },
];
// Slat gapped beyond the table value (autoslat) adds this much CLmax per unit slat.
export const SLAT_EXTRA_CLMAX = 0.20;

export const AERO = {
  CD0: 0.0158,          // clean, tuned so cruise thrust ≈ 58-62 kN/engine at 280 t
  CLminD: 0.10,
  CLalphaMach: [[0, 5.6], [0.2, 5.6], [0.5, 5.9], [0.7, 6.3], [0.84, 6.6], [0.9, 6.6], [1.0, 6.0]],
  CLmaxCleanMach: [[0, 1.45], [0.3, 1.45], [0.5, 1.25], [0.7, 1.05], [0.84, 0.88], [0.9, 0.80], [1.0, 0.7]],
  roundCL: 0.15,        // lift curve rounds over the last 0.15 of CL before CLmax
  postStallSlope: 0.04 / DEG, // CL lost per rad past the peak (first 6°)
  CLq: 5.5, CLad: 6.7, CLde: 0.35, CLstab: -0.75, // stab + (nose-up) = tail download
  // Pitching moment about 25 % MAC
  Cm0: 0.05, Cmalpha: -1.3, CmqMach: [[0, -21], [0.3, -21], [0.8, -25], [1, -25]], Cmad: -3.5,
  Cmde: -1.35, Cmstab: 2.8, CmGear: 0.005, CmSpoiler: 0.02,
  CmStallBump: 0.05, CmStallBreak: -0.14,
  // Drag increments
  dCDgear: 0.018, dCDgearTransit: 0.004, dCDengOut: 0.003,
  sbFlight: { CD: 0.020, CL: -0.10 }, sbGround: { CD: 0.070, CL: -0.70 },
  waveK: 20, mcritOffset: 0.108, kappaA: 0.95,
  // Ground effect
  geCL: 0.10, geCm: -0.03,
  // Lateral-directional, our sign convention. [approach M0.25, cruise M0.75]
  lat: {
    CYb: [-0.96, -0.90], CYdr: [-0.175, -0.120],
    Clb: [-0.22, -0.16], Clp: [-0.45, -0.34], Clr: [0.10, 0.13], Cldr: [-0.007, -0.008],
    Cnb: [0.15, 0.16], Cnp: [-0.12, -0.026], Cnr: [-0.30, -0.28], Cndr: [0.109, 0.100],
    Clda: [0.10, 0.06], Cnda: [-0.010, -0.004],
  },
};

// Surface limits & actuator rates (rad, rad/s)
export const SURF = {
  elevUp: 30 * DEG, elevDown: 25 * DEG, elevRate: 40 * DEG,
  rollMax: 0.35, rollRate: 60 * DEG,
  rudderMax: 27 * DEG, rudderMin: 8 * DEG, rudderRate: 50 * DEG, rudderRatioKt: 130,
  stabMin: -4 * DEG, stabMax: 11 * DEG, stabUnitsOffsetDeg: 4,
  stabRateLow: 0.5 * DEG, stabRateHigh: 0.2 * DEG,
  aileronDisplayMax: 25 * DEG,
  flapRateDeg: 2.0, slatRate: 0.15, sbRate: 0.8, gearTransitS: 10, revTransitS: 2.0,
};

// Limits / placards
export const LIMITS = {
  VMO: 330, MMO: 0.89, VLE: 270, MLE: 0.82,
  flapPlacard: { 0: 999, 1: 265, 5: 245, 15: 230, 20: 225, 25: 200, 30: 180 },
  nzMax: 2.5, nzMin: -1.0,
};

// ------------------------------------------------------------- engines
export const ENGINE = {
  Fsls: 513e3,                   // N, rated TO thrust SL static
  pos: [[6, -10.6, 1.5], [6, 10.6, 1.5]], // thrust application points (z below CG)
  TR: 1.05,                      // throttle ratio for the lapse model
  lapseSqrtM: 0.49,
  thrustExp: 1.8,                // F ∝ ((N1c - N1z)/(N1cmax - N1z))^exp
  n1ZeroBase: 10, n1ZeroMach: 62,  // zero-net-thrust corrected N1 = base + k·M
  n1cMaxSL: 104, n1cMaxAltGain: 25, n1MechLimit: 110.5,
  revFrac: 0.5, revN1: 80,
  // steady N2 -> N1 relationship (mechanical %)
  n2n1: [[0, 0], [25, 5], [50, 12], [62, 21], [66, 25.5], [71, 30], [80, 45], [88, 60], [95, 80], [100, 95], [104, 103.5], [108, 109], [112, 113]],
  idleN2: { ground: 62, flight: 66, approach: 72 },
  // acceleration limit (N2 %/s) vs N2
  accelN2: [[50, 1.5], [62, 2.6], [70, 4.0], [80, 5.6], [90, 6.5], [100, 5.5], [110, 4]],
  tauUp: 0.9, tauDown: 1.4, decelMax: 7.0,
  start: { starterN2: 27, starterRate: 1.3, lightOffN2: 20, startAccel: 1.1, windmillPerKt: 0.12 },
  tsfcSL: 7.9e-6,                // kg/(N·s) static SL
  tsfcMach: 1.3, tsfcTheta: 0.3,
  ffIdle: 306 / 3600,            // kg/s base idle term (× δ0·√θ0·(N2/62)²)
  egtVsN1c: [[0, 0], [20, 390], [30, 440], [57, 580], [80, 690], [95, 800], [104, 930], [110, 1010]],
  windmillDragCD: 0.003,
};

// ------------------------------------------------------------- landing gear
// Strut contact points at full extension, relative to CG (m, body axes).
export const GEAR = {
  struts: [
    { id: 'nose', x: 28.6, y: 0, z: 5.30, k: 9.0e5, cComp: 1.4e5, cExt: 2.8e5, stroke: 0.45, kBottom: 1.5e7, steer: true, brake: false },
    { id: 'left', x: -2.6, y: -5.49, z: 5.30, k: 5.0e6, cComp: 6.5e5, cExt: 1.3e6, stroke: 0.55, kBottom: 6e7, steer: false, brake: true },
    { id: 'right', x: -2.6, y: 5.49, z: 5.30, k: 5.0e6, cComp: 6.5e5, cExt: 1.3e6, stroke: 0.55, kBottom: 6e7, steer: false, brake: true },
  ],
  // Non-gear points. crash: contact is a crash; tail: tail-strike.
  structure: [
    { id: 'tail', x: -33.0, y: 0, z: -0.4, crash: false },
    { id: 'engL', x: 7.0, y: -10.6, z: 3.85, crash: true },
    { id: 'engR', x: 7.0, y: 10.6, z: 3.85, crash: true },
    { id: 'tipL', x: -14.0, y: -32.4, z: -1.4, crash: true },
    { id: 'tipR', x: -14.0, y: 32.4, z: -1.4, crash: true },
    { id: 'bellyF', x: 12.0, y: 0, z: 3.1, crash: true },
    { id: 'bellyA', x: -10.0, y: 0, z: 3.1, crash: true },
    { id: 'noseCone', x: 33.0, y: 0, z: 1.8, crash: true },
  ],
  structK: 2.5e7, structC: 2.5e6, structMu: 0.5,
  muRoll: 0.015, muBrakeDry: 0.55, muLatMax: 0.6, slip0: 6 * DEG, muPeak: 0.8,
  brakeFmax: 1.25e6,             // N per main bogie at full pressure (then friction-limited)
  brakeTau: 0.35,
  bogieArm: 1.45, scrubFactorSteer: 0.35,
  tillerMax: 70 * DEG, pedalSteerMax: 7 * DEG, steerRate: 30 * DEG,
  autobrakeDecel: { 1: 1.22, 2: 1.52, 3: 1.83, 4: 2.2, MAX: 3.35 },
  rtoMinKt: 85,
  hardLandingFpm: 600, crashLandingFpm: 1200,
};

// ------------------------------------------------------------- FBW gains
export const FBW = {
  Vco: 120,                // m/s, C* crossover speed
  cstarPull: 1.8, cstarPush: 1.8,
  Kp: 0.30, Ki: 0.35,      // C* error -> pitch accel (rad/s² per g), integral (elevator)
  Ku: 0.010, uMax: 0.25, uTau: 0.5, // speed stability: Δnz per kt off trim ref (g), cap, lag (s)
  uDamp: 7, uRateTau: 1.0, // phugoid damping: s of speed-rate lead, rate filter (s)
  trimRefRate: 4,          // kt/s with trim switch held
  alphaProtGain: 40,       // C* per rad beyond (alpha_shaker - margin)
  overspeedGain: 0.02,     // Δnz per kt above VMO
  flareBias: -0.08, flareRampS: 5, flareRaFt: 100,
  bankCompMax: 30 * DEG, bankProt: 35 * DEG, bankRollback: 30 * DEG, bankProtGain: 0.6,
  pMax: 15 * DEG, KpRoll: 2.5, KiRoll: 0.6, KphiHold: 0.6,
  KrYD: 1.2, KbetaYD: 0.8, ydMax: 8 * DEG, tacFrac: 0.9, tacMinKt: 70,
  tailstrikePitch: 9.0 * DEG,
};

export const SPEEDS = { KT };
