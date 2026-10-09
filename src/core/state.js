// The single shared simulation state. Every module reads/writes fields on this
// object; ownership of each block is documented in CONTRACT.md. SI units and
// radians internally unless a field name ends in Kt, Ft, Fpm, Deg, Pct, Hpa.

export const FLAP_DETENTS = [0, 1, 5, 15, 20, 25, 30];
export const AUTOBRAKE_SETTINGS = ['RTO', 'OFF', 'DISARM', '1', '2', '3', '4', 'MAX'];

export function createEventBus() {
  const map = new Map();
  return {
    on(name, fn) { (map.get(name) || map.set(name, []).get(name)).push(fn); return () => this.off(name, fn); },
    off(name, fn) { const l = map.get(name); if (l) map.set(name, l.filter((f) => f !== fn)); },
    emit(name, data) { (map.get(name) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(name, e); } }); },
  };
}

export function createSimState() {
  return {
    time: 0,              // s of sim time since start
    paused: false,
    simRate: 1,           // 1, 2, 4 (time acceleration)
    events: createEventBus(),

    // ---- owned by physics (src/physics) ----
    ac: {
      lat: 0, lon: 0, h: 0,         // rad, rad, m WGS84 ellipsoidal height of CG
      altMSL: 0,                    // m, = h - env.geoidN (what the altimeter shows at QNH 1013 ISA)
      vNED: [0, 0, 0],              // m/s ground-relative velocity
      quat: [1, 0, 0, 0],           // body -> NED
      euler: { roll: 0, pitch: 0, heading: 0 }, // rad, heading = true heading 0..2π
      omega: [0, 0, 0],             // body rates p, q, r (rad/s)
      specificForce: [0, 0, -9.81], // body-frame accelerometer reading (m/s²)
      nz: 1,                        // load factor (g)
      alpha: 0, beta: 0,            // rad
      tas: 0, cas: 0, eas: 0,       // m/s
      mach: 0,
      gs: 0,                        // m/s ground speed
      track: 0,                     // rad true track
      vs: 0,                        // m/s vertical speed, + up
      fpa: 0,                       // rad flight path angle
      ra: 0,                        // m radio altitude (lowest gear to ground)
      onGround: true,
      wow: { nose: true, left: true, right: true },
      mass: 0, fuelKg: { L: 0, C: 0, R: 0 }, zfw: 0, cgMacPct: 25,
      magVar: 0,                    // rad, east positive (magnetic = true - magVar)
      crashed: false, crashReason: '',
    },
    surfaces: {                     // actual positions (physics/fbw writes)
      elevator: 0, aileron: 0, rudder: 0, // rad, + = trailing edge down / right rudder
      spoilerRollL: 0, spoilerRollR: 0, speedbrake: 0, // 0..1
      stab: 0,                      // rad stabilizer (trim) position, + = nose up trim
      stabUnits: 4,                 // 777 trim units 0..15 for display
      flapsDeg: 0, flapsTarget: 0, slats: 0, // slats 0..1 (0 up, 0.5 takeoff/sealed, 1 landing/gapped)
      gear: 1, gearTarget: 1,       // 0 up/locked .. 1 down/locked
      reverser: [0, 0],             // 0..1 deployed
      brakes: [0, 0],               // applied brake pressure 0..1 (L, R)
      noseWheel: 0,                 // rad steering angle
    },
    engines: [0, 1].map(() => ({
      n1: 0, n2: 0, egt: 15, ff: 0, // %, %, °C, kg/h
      thrust: 0,                    // N
      oilP: 0, oilT: 15, vib: 0,
      running: false,
      startState: 'OFF',            // 'OFF' | 'STARTING' | 'RUN'
      fire: false,
    })),
    fbw: {
      mode: 'NORMAL',               // 'NORMAL' | 'SECONDARY' | 'DIRECT'
      trimRefKt: 0,                 // trim reference speed (shown on PFD)
      prot: { stall: false, overspeed: false, bank: false, tac: true },
    },

    // ---- owned by input + pedestal (pilot controls) ----
    controls: {
      pitch: 0, roll: 0, yaw: 0,    // -1..1, pitch + = pull (nose up), roll + = right, yaw + = right pedal
      tiller: 0,                    // -1..1
      throttle: [0, 0],             // 0..1 lever position (0 idle stop, 1 full forward)
      reverse: [0, 0],              // 0..1 reverse lever (only when throttle at idle)
      flapLever: 0,                 // index into FLAP_DETENTS
      gearLever: 'DOWN',            // 'UP' | 'DOWN'
      speedbrakeLever: 0,           // 0 (down) .. 1 (UP)
      speedbrakeArmed: false,
      brakeL: 0, brakeR: 0,         // 0..1 toe brakes
      parkingBrake: true,
      autobrake: 'OFF',             // one of AUTOBRAKE_SETTINGS
      trimSwitch: 0,                // -1 nose down, 0, +1 nose up (momentary)
      rudderTrim: 0,                // -1..1
      fuelControl: ['RUN', 'RUN'],  // 'RUN' | 'CUTOFF'
      engStart: [false, false],     // engine start selector pulled
      toga: false, atDisc: false, apDisc: false, // momentary, consumers clear them
    },

    // ---- owned by AFDS/FMC (src/systems/afds.js, fmc.js) ----
    ap: {
      apEngaged: false, fdL: true, fdR: true,
      atArm: true, atEngaged: false,
      modes: { at: '', roll: '', pitch: '', armedRoll: '', armedPitch: '', ap: '' }, // FMA strings, e.g. at:'SPD', roll:'HDG SEL', pitch:'ALT'
      sel: { spdKt: 250, mach: 0.84, useMach: false, hdgDeg: 0, hdgIsTrk: false, altFt: 10000, vsFpm: 0, fpaDeg: 0, bankLimitDeg: 0 /*0 = AUTO*/ },
      fd: { pitchDeg: 0, rollDeg: 0, valid: false }, // flight director commanded attitude
      out: { pitch: 0, roll: 0, yaw: 0, active: false }, // virtual column/wheel/pedal (same scale as controls) when AP engaged
      thrustCmd: null,              // 0..1 thrust lever target when A/T active, else null
      clbCon: false,
    },
    fmc: {
      origin: null, dest: null,     // airport objects (see world/airports.js)
      route: [],                    // [{ident, lat, lon (rad), altFt|null, spdKt|null}]
      activeLeg: 0,
      crzAltFt: 35000, costIndex: 80,
      v1: 0, vr: 0, v2: 0, vref: 0, toFlaps: 15, ldgFlaps: 30, // kt / deg
      xtkM: 0, dtkRad: 0, distToGoNm: 0, todNm: null,
      vnavTargetAltFt: null, vnavTargetSpdKt: null,
    },
    nav: {
      ils: { valid: false, ident: '', freq: 0, rwyLat: 0, rwyLon: 0, crsRad: 0, gsDeg: 3, thrH: 0,
             locDots: 0, gsDots: 0, locCapturable: false, gsCapturable: false, distNm: 0 },
    },

    // ---- owned by world (Cesium) ----
    env: {
      groundH: 0,                   // m WGS84 ellipsoidal height of terrain/3D tiles under the aircraft
      groundValid: false,
      geoidN: 0,                    // m, ellipsoid - MSL offset near the aircraft (set at spawn)
      qnhHpa: 1013.25, baroStd: false, baroHpa: 1013.25,
      windDirDeg: 0, windKt: 0, tempDevC: 0, turbulence: 0,
      timeOfDayH: 12,
    },
    view: { mode: 'cockpit', panel: true, lookYaw: 0, lookPitch: 0, zoom: 1 }, // mode: 'cockpit' | 'chase' | 'flyby' | 'tower'

    // ---- owned by systems/alerts (src/systems/aircraftSystems.js) ----
    systems: {},
    alerts: { list: [], masterWarning: false, masterCaution: false },

    // ---- owned by displays (EFIS control panel) ----
    efis: { ndMode: 'MAP', ndRangeNm: 40, minimumsFt: 200, minsType: 'BARO', wxr: false, terr: false, tfc: true, sta: false, wpt: true, arpt: true, fpv: false, mtrs: false },
  };
}
