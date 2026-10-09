// Team D2 systems & alerts tests: node tests/systems.test.mjs  (exits 0 on success)
import assert from 'node:assert/strict';
import { createSimState } from '../src/core/state.js';
import { FT, KT, FPM, DEG } from '../src/core/geo.js';
import { initSystems, stepSystems } from '../src/systems/aircraftSystems.js';
import { stepAlerts, resetMaster, acknowledgeATDisc, maxSpeedKt } from '../src/systems/alerts.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); }
}

/** Minimal stand-in for Team A's engine model honouring startState. */
function fakeEngines(sim, dt) {
  sim.engines.forEach((e, i) => {
    const fuel = sim.controls.fuelControl[i] === 'RUN';
    if (e.startState === 'STARTING') {
      if (fuel && e.n2 > 18) e.n2 = Math.min(63, e.n2 + 1.6 * dt);
      else e.n2 = Math.min(24, e.n2 + 2 * dt);
      e.ff = fuel && e.n2 > 18 ? 900 : 0;
    } else if (e.startState === 'RUN') {
      e.n2 += ((63 + 37 * sim.controls.throttle[i]) - e.n2) * Math.min(1, dt);
      e.ff = 1100 + 9000 * sim.controls.throttle[i];
    } else { e.n2 = Math.max(0, e.n2 - 3 * dt); e.ff = 0; }
    e.n1 = e.n2 * 0.35;
  });
}

function makeSim({ coldDark = false, fuel = { L: 20000, C: 30000, R: 20000 } } = {}) {
  const sim = createSimState();
  Object.assign(sim.ac.fuelKg, fuel);
  sim.ac.onGround = true; sim.ac.altMSL = 111;
  sim.surfaces.flapsDeg = 0; sim.surfaces.gear = 1;
  initSystems(sim, { coldDark });
  return sim;
}

function run(sim, seconds, dt = 0.1, each) {
  for (let t = 0; t < seconds; t += dt) {
    sim.time += dt;
    each && each(sim, dt);
    fakeEngines(sim, dt);
    stepSystems(sim, dt);
    stepAlerts(sim, dt);
  }
}

function recordAurals(sim) {
  const ids = [];
  sim.events.on('aural', (e) => ids.push(e.id));
  return ids;
}

console.log('systems.test.mjs');

// ------------------------------------------------------------- engine start
test('cold & dark: battery + APU start sequence', () => {
  const sim = makeSim({ coldDark: true });
  assert.equal(sim.systems.elec.dcPowered, false);
  assert.equal(sim.engines[0].startState, 'OFF');
  sim.systems.elec.battery = true;
  sim.systems.apu.selector = 'START';
  run(sim, 30);
  assert.equal(sim.systems.apu.state, 'STARTING');
  assert.equal(sim.systems.apu.selector, 'ON', 'APU selector springs back to ON');
  run(sim, 35);
  assert.equal(sim.systems.apu.state, 'RUN');
  assert.ok(sim.systems.elec.apuGenOnline && sim.systems.elec.acPowered, 'APU gen powers the AC buses');
  assert.ok(sim.systems.air.ductPsi > 25, 'APU bleed pressurises the duct');
  assert.ok(sim.alerts.list.some((m) => m.text === 'APU RUNNING'));
});

test('engine start needs bleed air', () => {
  const sim = makeSim({ coldDark: true });
  sim.systems.elec.battery = true;
  sim.controls.engStart[1] = true;
  run(sim, 5);
  assert.equal(sim.engines[1].startState, 'OFF', 'no duct pressure -> no start');
});

test('autostart: selector -> STARTING -> fuel RUN -> RUN, selector springs back', () => {
  const sim = makeSim({ coldDark: true });
  sim.systems.elec.battery = true;
  sim.systems.apu.selector = 'START';
  run(sim, 70);
  sim.controls.engStart[1] = true;                    // pull R start selector
  run(sim, 1);
  assert.equal(sim.engines[1].startState, 'STARTING');
  run(sim, 10);
  assert.ok(sim.engines[1].n2 > 18 && sim.engines[1].n2 <= 24, 'dry motoring while CUTOFF');
  sim.controls.fuelControl[1] = 'RUN';
  run(sim, 30);
  assert.equal(sim.engines[1].startState, 'RUN');
  assert.equal(sim.controls.engStart[1], false, 'selector back to NORM');
  run(sim, 5);
  assert.ok(sim.systems.elec.idgOnline[1], 'IDG R online');
  assert.ok(sim.systems.hyd.press.R > 2500, 'R hydraulic system pressurised by EDP');
  sim.controls.fuelControl[1] = 'CUTOFF';
  run(sim, 1);
  assert.equal(sim.engines[1].startState, 'OFF', 'CUTOFF shuts the engine down');
});

test('ready-for-takeoff state', () => {
  const sim = makeSim();
  run(sim, 1);
  assert.ok(sim.engines.every((e) => e.startState === 'RUN'));
  assert.ok(sim.systems.elec.acBus.every(Boolean));
  assert.equal(sim.controls.autobrake, 'RTO');
  assert.ok(['L', 'C', 'R'].every((k) => sim.systems.hyd.press[k] > 2500));
  assert.ok(!sim.alerts.list.some((m) => m.level === 'warning' || m.level === 'caution'),
    'no warnings/cautions: ' + sim.alerts.list.map((m) => m.text).join(','));
});

// --------------------------------------------------------------- fuel burn
test('fuel depletion from the centre tank, then the mains', () => {
  const sim = makeSim({ fuel: { L: 20000, C: 600, R: 20000 } });
  sim.controls.throttle = [0.5, 0.5];          // ff ≈ 5600 kg/h each
  sim.ac.onGround = false; sim.ac.altMSL = 3000; sim.ac.ra = 3000;
  const before = sim.ac.fuelKg.L + sim.ac.fuelKg.C + sim.ac.fuelKg.R;
  run(sim, 300, 0.1);
  const f = sim.ac.fuelKg;
  assert.equal(f.C, 0, 'centre tank used first');
  assert.ok(f.L < 20000 && Math.abs(f.L - f.R) < 50, 'mains burn evenly afterwards');
  const burned = before - (f.L + f.C + f.R);
  assert.ok(Math.abs(burned - sim.systems.fuel.burnedKg) < 1, 'burn bookkeeping');
  assert.ok(burned > 850 && burned < 1000, `burn ≈ 2×5600 kg/h × 300 s, got ${burned.toFixed(0)}`);
});

test('crossfeed balances an imbalance', () => {
  const sim = makeSim({ fuel: { L: 15000, C: 0, R: 18000 } });
  sim.systems.fuel.xfeedFwd = true;
  sim.controls.throttle = [0.8, 0.8];
  run(sim, 200, 0.2);
  assert.ok(sim.ac.fuelKg.R < 18000 && Math.abs(sim.ac.fuelKg.L - 15000) < 1, 'both engines feed from the heavier R tank');
});

// ------------------------------------------------------------- warnings
test('takeoff config warnings with thrust advanced', () => {
  const sim = makeSim();
  const ids = recordAurals(sim);
  sim.controls.flapLever = 0;
  sim.surfaces.flapsDeg = 0;
  sim.controls.throttle = [0.8, 0.8];
  run(sim, 0.5);
  const texts = sim.alerts.list.map((m) => m.text);
  assert.ok(texts.includes('CONFIG PARKING BRAKE'));
  assert.ok(texts.includes('CONFIG FLAPS'));
  assert.equal(sim.alerts.list[0].level, 'warning', 'warnings sorted first');
  assert.ok(sim.alerts.masterWarning && sim.alerts.aural.siren);
  assert.ok(ids.includes('config'));
  sim.controls.parkingBrake = false; sim.controls.flapLever = 3; sim.surfaces.flapsDeg = 15;
  run(sim, 0.5);
  assert.ok(!sim.alerts.list.some((m) => m.text.startsWith('CONFIG')));
  assert.equal(sim.alerts.aural.siren, false);
});

test('overspeed and stick shaker', () => {
  const sim = makeSim();
  sim.ac.onGround = false; sim.ac.ra = 10000 * FT; sim.ac.altMSL = 10000 * FT; sim.ac.mach = 0.6;
  sim.ac.cas = 340 * KT;
  run(sim, 0.3);
  assert.ok(sim.alerts.overspeed && sim.alerts.list.some((m) => m.text === 'OVERSPEED'));
  sim.ac.cas = 250 * KT; sim.surfaces.flapsDeg = 30; sim.surfaces.gear = 1;
  assert.equal(maxSpeedKt(sim), 170, 'flap 30 placard');
  sim.surfaces.flapsDeg = 0; sim.surfaces.gear = 0; sim.controls.gearLever = 'UP'; sim.controls.flapLever = 0;
  sim.ac.alpha = 12 * DEG;
  run(sim, 0.3);
  assert.equal(sim.alerts.overspeed, false);
  assert.ok(sim.alerts.stickShaker && sim.alerts.aural.shaker);
  sim.ac.alpha = 4 * DEG;
  run(sim, 0.3);
  assert.equal(sim.alerts.stickShaker, false);
});

test('A/T disconnect caution + master caution reset', () => {
  const sim = makeSim();
  sim.ac.onGround = false; sim.ac.ra = 5000 * FT; sim.ac.altMSL = 5000 * FT; sim.ac.cas = 250 * KT;
  sim.controls.gearLever = 'UP'; sim.surfaces.gear = 0; sim.controls.flapLever = 0; sim.controls.parkingBrake = false;
  sim.systems._prev.airborneT = 200; sim.systems._prev.wasAir = true;
  sim.ap.atEngaged = true;
  run(sim, 0.5);
  sim.ap.atEngaged = false;
  const ids = recordAurals(sim);
  run(sim, 0.5);
  assert.ok(sim.alerts.list.some((m) => m.text === 'AUTOTHROTTLE DISC' && m.level === 'caution'));
  assert.ok(sim.alerts.masterCaution && ids.includes('at_disc'));
  resetMaster(sim);
  assert.equal(sim.alerts.masterCaution, false);
  acknowledgeATDisc(sim);
  run(sim, 0.2);
  assert.ok(!sim.alerts.list.some((m) => m.text === 'AUTOTHROTTLE DISC'));
});

// ----------------------------------------------------------- GPWS & callouts
/** Fly a stabilised 3° approach from `startRa` ft down to touchdown on a field at `elevFt`. */
function approach(sim, { startRa = 3000, elevFt = 364, vsFpm = -750 } = {}) {
  const ids = recordAurals(sim);
  sim.ac.onGround = false; sim.ac.cas = 150 * KT; sim.ac.mach = 0.23;
  sim.controls.gearLever = 'DOWN'; sim.surfaces.gear = 1; sim.controls.flapLever = 6; sim.surfaces.flapsDeg = 30;
  sim.controls.parkingBrake = false; sim.controls.autobrake = '3'; sim.controls.speedbrakeArmed = true;
  sim.systems._prev.airborneT = 600; sim.systems._prev.wasAir = true;
  let ra = startRa;
  sim.ac.ra = ra * FT; sim.ac.altMSL = (elevFt + ra) * FT; sim.ac.vs = vsFpm * FPM;
  run(sim, 0.1);
  ids.length = 0;
  run(sim, (startRa / -vsFpm) * 60 + 2, 0.05, (s, dt) => {
    ra = Math.max(0, ra + vsFpm * dt / 60);
    s.ac.ra = ra * FT; s.ac.altMSL = (elevFt + ra) * FT; s.ac.vs = ra > 0 ? vsFpm * FPM : 0;
    s.ac.onGround = ra <= 0;
  });
  return ids;
}

test('RA callouts + RADIO minimums sequence on a stabilised approach', () => {
  const sim = makeSim();
  sim.efis.minsType = 'RADIO'; sim.efis.minimumsFt = 200;
  const ids = approach(sim);
  const expected = ['ra2500', 'ra1000', 'ra500', 'approaching_minimums', 'minimums', 'ra100', 'ra50', 'ra40', 'ra30', 'ra20', 'ra10'];
  assert.deepEqual(ids.filter((i) => i.startsWith('ra') || i.includes('minimums')), expected);
  assert.ok(!ids.some((i) => ['sink_rate', 'pull_up', 'terrain', 'too_low_gear', 'too_low_flaps', 'glideslope'].includes(i)),
    'no GPWS alerts on a normal approach: ' + ids.join(','));
});

test('BARO minimums (DA 564 ft, field 364 ft) and coincident 100 suppression', () => {
  const sim = makeSim();
  sim.efis.minsType = 'BARO'; sim.efis.minimumsFt = 564;
  const ids = approach(sim, { elevFt: 364 });
  const seq = ids.filter((i) => i.startsWith('ra') || i.includes('minimums'));
  assert.deepEqual(seq.slice(0, 5), ['ra2500', 'ra1000', 'ra500', 'approaching_minimums', 'minimums']);
  const sim2 = makeSim();
  sim2.efis.minsType = 'RADIO'; sim2.efis.minimumsFt = 100;
  const ids2 = approach(sim2).filter((i) => i.startsWith('ra') || i.includes('minimums'));
  assert.ok(ids2.includes('minimums') && !ids2.includes('ra100'), 'MINIMUMS replaces ONE HUNDRED: ' + ids2.join(','));
});

test('GPWS mode 1 sink rate / pull up, mode 4 too low gear', () => {
  const sim = makeSim();
  sim.ac.onGround = false; sim.ac.cas = 220 * KT; sim.systems._prev.airborneT = 600; sim.systems._prev.wasAir = true;
  sim.ac.ra = 1500 * FT; sim.ac.altMSL = 1600 * FT; sim.ac.vs = -4200 * FPM;
  sim.controls.gearLever = 'UP'; sim.surfaces.gear = 0; sim.controls.flapLever = 0; sim.surfaces.flapsDeg = 0;
  let ids = recordAurals(sim);
  run(sim, 0.2);
  assert.ok(ids.includes('sink_rate'), ids.join(','));
  sim.ac.vs = -7000 * FPM;
  run(sim, 3);
  assert.ok(ids.includes('pull_up') && sim.alerts.gpws === 'PULL UP' && sim.alerts.egpws.pullUp);
  const sim2 = makeSim();
  sim2.ac.onGround = false; sim2.ac.cas = 160 * KT; sim2.systems._prev.airborneT = 600; sim2.systems._prev.wasAir = true;
  sim2.ac.ra = 400 * FT; sim2.ac.altMSL = 500 * FT; sim2.ac.vs = -800 * FPM;
  sim2.controls.gearLever = 'UP'; sim2.surfaces.gear = 0; sim2.controls.flapLever = 4; sim2.surfaces.flapsDeg = 20;
  ids = recordAurals(sim2);
  run(sim2, 0.3);
  assert.ok(ids.includes('too_low_gear'), ids.join(','));
  assert.ok(sim2.alerts.list.some((m) => m.text === 'CONFIG GEAR'), 'idle + low + gear up -> CONFIG GEAR');
});

test('autobrake applies after touchdown and speedbrake auto-deploys', () => {
  const sim = makeSim();
  sim.efis.minimumsFt = 200; sim.efis.minsType = 'RADIO';
  approach(sim);
  sim.ac.onGround = true; sim.ac.gs = 70; sim.ac.cas = 70;
  run(sim, 0.5, 0.05, (s, dt) => { s.ac.gs -= 0.5 * dt; s.ac.cas = s.ac.gs; });
  assert.equal(sim.controls.speedbrakeLever, 1, 'speedbrakes deployed');
  assert.ok(sim.systems.autobrake.active && sim.systems.autobrake.cmd > 0.2, 'autobrake commanding');
  sim.controls.pilotBrakeL = 1;
  run(sim, 0.2);
  assert.equal(sim.controls.autobrake, 'DISARM');
  assert.ok(sim.alerts.list.some((m) => m.text === 'AUTOBRAKE'));
});

test('robust against NaN state', () => {
  const sim = makeSim();
  sim.ac.cas = NaN; sim.ac.ra = NaN; sim.engines[0].ff = NaN; sim.ac.vs = undefined;
  run(sim, 0.5);
  assert.ok(Number.isFinite(sim.ac.fuelKg.L));
});

test('display-facing shapes (docs/displays.md)', () => {
  const sim = makeSim();
  run(sim, 1);
  const s = sim.systems;
  assert.ok(s.elec.idgL && s.elec.idgR && s.elec.busL && s.elec.busR && s.elec.battV > 20);
  assert.ok(['L', 'C', 'R'].every((k) => s.hyd[k].press > 2500 && s.hyd[k].qty > 0.5 && s.hyd[k].pumps));
  assert.equal(s.gear.brakeTemp.length, 12); assert.equal(s.gear.tirePsi.length, 12);
  assert.ok(Number.isFinite(s.air.tatC) && Number.isFinite(s.fuel.tempC) && 'ENTRY 1L' in s.doors);
  assert.ok(sim.alerts.list.every((m) => ['warning', 'caution', 'advisory', 'memo'].includes(m.level)));
  assert.ok(sim.alerts.gpws === null || typeof sim.alerts.gpws === 'string');
  assert.equal(s.fuelOwned, true);
});

// Integration with Team A's physics when present: cold & dark -> APU -> engine start with the real engine model
let fdm = null;
try { fdm = await import('../src/physics/fdm.js'); } catch { /* physics not available */ }
if (fdm) test('integration: real engine model start from cold & dark', () => {
  const sim = createSimState();
  fdm.initAircraft(sim, { lat: 0.87, lon: 0.15, h: 120, heading: 1, onGround: true, enginesRunning: false });
  initSystems(sim, { coldDark: true });
  const go = (sec) => { for (let t = 0; t < sec; t += 1 / 30) { for (let k = 0; k < 4; k++) fdm.stepPhysics(sim, 1 / 120); sim.time += 1 / 30; stepSystems(sim, 1 / 30); stepAlerts(sim, 1 / 30); } };
  sim.systems.elec.battery = true; sim.systems.apu.selector = 'START'; go(65);
  assert.equal(sim.systems.apu.state, 'RUN');
  sim.controls.engStart[1] = true; go(6);
  sim.controls.fuelControl[1] = 'RUN'; go(50);
  assert.equal(sim.engines[1].startState, 'RUN');
  assert.ok(sim.engines[1].n2 > 55, 'N2 at idle');
  const before = sim.ac.fuelKg.R; go(30);
  assert.ok(sim.ac.fuelKg.R < before, 'systems burns the running engine\'s fuel');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
