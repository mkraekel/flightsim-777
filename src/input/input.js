// Pilot input (Team D2): keyboard, mouse (look-around, optional mouse-yoke) and Gamepad API.
// The ONLY module with global key handlers. Writes sim.controls, sim.view, sim.paused,
// sim.simRate and toggles the drawers. See CONTRACT.md "Key bindings".
//
// Control feel: keyboard pitch/roll/rudder ramp in at a finite rate and auto-centre when
// released (optional "hold" mode keeps the deflection); throttle levers move smoothly;
// flap lever moves one detent per press with gates at 1 and 20 (key auto-repeat stops there).
// A/T backdrive: when sim.ap.thrustCmd !== null the levers are driven toward it at <= 0.25/s
// unless the pilot moved them this frame (keyboard, gamepad, or pedestal drag).

import { FLAP_DETENTS } from '../core/state.js';
import { KT, clamp, approach, wrapPi } from '../core/geo.js';
import { acknowledgeATDisc } from '../systems/alerts.js';

const VIEW_MODES = ['cockpit', 'chase', 'flyby', 'tower'];
const SIM_RATES = [1, 2, 4];
const DRAWERS = { Digit1: 'overhead', Digit2: 'pedestal', Digit3: 'cdu', Digit4: 'lower' };
const FLAP_GATES = new Set([1, 4]);          // lever indices of the 1 and 20 detents

// Rates (per second of real time) tuned for a heavy-jet feel
const R = {
  axisIn: 1.1, axisReverse: 3.5, axisCenter: 2.4,  // pitch / roll
  rudderIn: 1.2, rudderCenter: 2.5,
  tillerIn: 1.0, tillerCenter: 2.0,
  throttle: 0.4, throttleGoTo: 0.8, reverse: 0.7,
  brakeIn: 2.5, brakeOut: 4.0, speedbrake: 1.5,
  look: 1.4, atBackdrive: 0.25,
};

const st = {
  sim: null, held: new Set(), shift: false, ctrl: false,
  holdMode: false, mouseYoke: false, mouse: { x: 0, y: 0, valid: false },
  throttleTarget: null, reverseTarget: null, sbTarget: null, pilotBrake: 0,
  drag: null, gp: { prev: [], index: -1, active: false },
  afds: null, worldEl: null,
};

// --------------------------------------------------------------- helpers
const toast = (text) => st.sim && st.sim.events.emit('toast', { text });
const held = (...codes) => codes.some((c) => st.held.has(c));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

function isTypingTarget(t) {
  if (!t || !t.closest) return false;
  if (t.closest('#drawer-cdu')) return true;
  return !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** Soft link to the AFDS (Team D1) for the A / Shift+A keys; absent module = no-op. */
function afdsAction(action, value) {
  if (st.afds && typeof st.afds.afdsAction === 'function') { st.afds.afdsAction(st.sim, action, value); return true; }
  st.sim.events.emit('afds', { action, value });
  return false;
}

// ------------------------------------------------------------ discrete actions
export function moveFlaps(sim, dir, isRepeat = false) {
  const c = sim.controls;
  const cur = clamp(Math.round(num(c.flapLever)), 0, FLAP_DETENTS.length - 1);
  if (isRepeat && FLAP_GATES.has(cur)) return cur;       // gate: lift the lever again (new press)
  c.flapLever = clamp(cur + dir, 0, FLAP_DETENTS.length - 1);
  return c.flapLever;
}

export function toggleGear(sim) {
  const c = sim.controls;
  if (c.gearLever === 'DOWN') {
    if (sim.ac.onGround) { toast('Gear lever locked on the ground'); return; }
    c.gearLever = 'UP';
  } else c.gearLever = 'DOWN';
}

function speedbrakeKey(sim, arm) {
  const c = sim.controls;
  if (arm) {
    if (c.speedbrakeLever > 0.05) { st.sbTarget = 0; c.speedbrakeArmed = true; }
    else c.speedbrakeArmed = !c.speedbrakeArmed;
    toast(c.speedbrakeArmed ? 'Speedbrake ARMED' : 'Speedbrake DOWN');
    return;
  }
  c.speedbrakeArmed = false;
  st.sbTarget = c.speedbrakeLever < 0.5 ? 1 : 0;
}

function canReverse(sim) {
  const c = sim.controls;
  return c.throttle[0] < 0.03 && c.throttle[1] < 0.03 && (sim.ac.onGround || num(sim.ac.ra) < 3);
}

function apKey(sim, shift) {
  const ap = sim.ap, c = sim.controls;
  if (shift) {
    if (ap.atEngaged) { c.atDisc = true; return; }
    const discMsg = sim.alerts && sim.alerts.list.some((m) => m.text === 'AUTOTHROTTLE DISC');
    if (discMsg) { c.atDisc = true; acknowledgeATDisc(sim); return; }
    if (!afdsAction('AT_ARM')) ap.atArm = !ap.atArm;
    toast(ap.atArm ? 'A/T ARM' : 'A/T OFF');
    return;
  }
  if (ap.apEngaged || ap.discWarning) { c.apDisc = true; return; }
  afdsAction('AP_ENGAGE');
}

function cycleView(sim) {
  const i = VIEW_MODES.indexOf(sim.view.mode);
  sim.view.mode = VIEW_MODES[(i + 1) % VIEW_MODES.length];
  sim.view.lookYaw = 0; sim.view.lookPitch = 0;
  sim.events.emit('view', { mode: sim.view.mode, panel: sim.view.panel });
}

export function toggleDrawer(sim, name, force) {
  const el = typeof document !== 'undefined' && document.getElementById('drawer-' + name);
  if (!el) return;
  // Prefer the shell's toggle (main.js): it keeps the right-side drawers mutually exclusive.
  if (sim.ui && typeof sim.ui.toggleDrawer === 'function') sim.ui.toggleDrawer(name, force);
  else el.classList.toggle('open', force);
  const open = el.classList.contains('open');
  // 'id' (not 'name'): main.js' 'drawer' listener toggles by name, which would toggle twice.
  sim.events.emit('drawer', { id: name, open });
}

function onActionKey(e, sim) {
  const c = sim.controls, code = e.code;
  const plain = !e.shiftKey && !e.altKey && !e.ctrlKey;
  switch (code) {
    case 'KeyG': if (!e.repeat) toggleGear(sim); return true;
    case 'Slash': if (!e.repeat) speedbrakeKey(sim, e.shiftKey); return true;
    case 'KeyP': if (!e.repeat) togglePark(sim); return true;
    case 'Period': if (e.shiftKey && !e.repeat) togglePark(sim); return true;
    case 'KeyA': if (!e.repeat) apKey(sim, e.shiftKey); return true;
    case 'KeyT': if (!e.repeat) c.toga = true; return true;
    case 'KeyC': if (!e.repeat && plain) cycleView(sim); return plain;
    case 'KeyV': if (!e.repeat && plain) { sim.view.panel = !sim.view.panel; sim.events.emit('view', { mode: sim.view.mode, panel: sim.view.panel }); } return plain;
    case 'Escape': if (!e.repeat) sim.events.emit('menu', {}); return true;
    case 'Space':
      if (!e.repeat) { sim.paused = !sim.paused; sim.events.emit('pause', { paused: sim.paused }); toast(sim.paused ? 'PAUSED' : 'Resumed'); }
      return true;
    case 'Equal': case 'NumpadEqual':
      if (!e.repeat) { const i = SIM_RATES.indexOf(sim.simRate); sim.simRate = SIM_RATES[(i + 1) % SIM_RATES.length]; toast(`Sim rate ${sim.simRate}×`); }
      return true;
    case 'KeyR':
      if (!e.repeat) {
        if (Math.max(...c.reverse) > 0.05 || st.reverseTarget === 1) st.reverseTarget = 0;
        else if (canReverse(sim)) st.reverseTarget = 1;
        else toast('Reverse: thrust levers must be at idle, on the ground');
      }
      return true;
    case 'F1': st.throttleTarget = 0; st.reverseTarget = 0; return true;
    case 'F4': if (Math.max(...c.reverse) < 0.02) st.throttleTarget = 1; return true;
    case 'F7': case 'BracketRight': moveFlaps(sim, +1, e.repeat); return true;
    case 'F6': case 'BracketLeft': moveFlaps(sim, -1, e.repeat); return true;
    case 'KeyY': if (!e.repeat) { st.mouseYoke = !st.mouseYoke; toast(st.mouseYoke ? 'Mouse yoke ON (move the mouse over the view)' : 'Mouse yoke OFF'); } return true;
    case 'KeyH': if (!e.repeat) { st.holdMode = !st.holdMode; toast(st.holdMode ? 'Control hold mode ON (no auto-centre)' : 'Control auto-centre ON'); } return true;
    case 'Numpad5': sim.view.lookYaw = 0; sim.view.lookPitch = 0; return true;
    default:
      if (DRAWERS[code] && plain) { if (!e.repeat) toggleDrawer(sim, DRAWERS[code]); return true; }
  }
  return false;
}

function togglePark(sim) {
  sim.controls.parkingBrake = !sim.controls.parkingBrake;
  toast(sim.controls.parkingBrake ? 'Parking brake SET' : 'Parking brake RELEASED');
}

// Keys that are processed continuously in stepInput (held state); default action prevented.
const HELD_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'F2', 'F3',
  'NumpadAdd', 'NumpadSubtract', 'KeyZ', 'KeyX', 'KeyQ', 'KeyE', 'KeyB', 'Period', 'Home', 'End', 'Numpad7', 'Numpad1',
  'Numpad8', 'Numpad2', 'Numpad4', 'Numpad6', 'Numpad9', 'Numpad3']);

// ------------------------------------------------------------------ init
/** Install keyboard/mouse/gamepad handlers. rootEl: #app (or document.body). */
export function initInput(sim, rootEl) {
  st.sim = sim;
  if (typeof window === 'undefined') return;
  import('../systems/afds.js').then((m) => { st.afds = m; }).catch(() => {});
  const doc = rootEl && rootEl.ownerDocument ? rootEl.ownerDocument : document;
  st.worldEl = doc.getElementById('world') || rootEl || doc.body;

  window.addEventListener('keydown', (e) => {
    st.shift = e.shiftKey; st.ctrl = e.ctrlKey;
    if (isTypingTarget(e.target) || e.metaKey || e.altKey) return;
    if (e.ctrlKey && !e.code.startsWith('Arrow')) return;   // leave browser shortcuts alone
    let handled = false;
    if (HELD_KEYS.has(e.code)) { st.held.add(e.code); handled = true; }
    if (onActionKey(e, sim)) handled = true;
    if (e.code === 'F2' || e.code === 'F3' || e.code === 'PageUp' || e.code === 'PageDown') st.throttleTarget = null;
    if (handled) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    st.shift = e.shiftKey; st.ctrl = e.ctrlKey;
    st.held.delete(e.code);
  });
  window.addEventListener('blur', () => { st.held.clear(); st.drag = null; });

  // mouse look (right-button drag) and mouse-yoke position over #world
  const w = st.worldEl;
  w.addEventListener('contextmenu', (e) => e.preventDefault());
  w.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    st.drag = { x: e.clientX, y: e.clientY };
    try { w.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  w.addEventListener('pointermove', (e) => {
    const r = w.getBoundingClientRect();
    st.mouse.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    st.mouse.y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    st.mouse.valid = true;
    if (st.drag) {
      const v = sim.view;
      v.lookYaw = wrapPi(num(v.lookYaw) + (e.clientX - st.drag.x) * 0.005);
      v.lookPitch = clamp(num(v.lookPitch) - (e.clientY - st.drag.y) * 0.005, -1.4, 1.4);
      st.drag = { x: e.clientX, y: e.clientY };
    }
  });
  const endDrag = () => { st.drag = null; };
  w.addEventListener('pointerup', endDrag);
  w.addEventListener('pointercancel', endDrag);
  w.addEventListener('wheel', (e) => {
    sim.view.zoom = clamp(num(sim.view.zoom, 1) * Math.exp(-e.deltaY * 0.001), 0.4, 3);
  }, { passive: true });
  window.addEventListener('gamepadconnected', (e) => toast(`Gamepad connected: ${e.gamepad.id.slice(0, 40)}`));
}

// ------------------------------------------------------------------ step
/** Shape a keyboard axis: ramp toward ±1 while held, auto-centre when released. */
function rampAxis(cur, dirNeg, dirPos, dt, { inRate, reverseRate, centerRate, hold, limit = 1 }) {
  const dir = (dirPos ? 1 : 0) - (dirNeg ? 1 : 0);
  if (dir === 0) return hold ? cur : approach(cur, 0, centerRate, dt);
  const rate = Math.sign(cur) === -dir && Math.abs(cur) > 0.05 ? reverseRate : inRate;
  return approach(cur, dir * limit, rate, dt);
}

const deadzone = (v, dz) => (Math.abs(v) < dz ? 0 : Math.sign(v) * (Math.abs(v) - dz) / (1 - dz));
const expo = (v, e = 0.35) => v * (1 - e) + v * v * v * e;

/** Per-frame input processing (call first in the main loop). */
export function stepInput(sim, dt) {
  try {
    st.sim = sim;
    dt = clamp(num(dt), 0, 0.25);
    const dtr = dt / Math.max(1, num(sim.simRate, 1));   // control feel in real time
    const gp = readGamepad(sim);
    stepFlightControls(sim, dtr, gp);
    const pilotThr = stepThrottles(sim, dtr, gp);
    stepBrakesTrimSpeedbrake(sim, dtr, gp);
    stepLook(sim, dtr);
    stepAtBackdrive(sim, dt, pilotThr);
  } catch (err) {
    if (!stepInput._warned) { console.warn('stepInput:', err); stepInput._warned = true; }
  }
}

function stepFlightControls(sim, dt, gp) {
  const c = sim.controls, ac = sim.ac;
  const fine = st.ctrl ? 0.35 : 1;
  const kbPitch = !st.shift && held('ArrowUp', 'ArrowDown');
  const kbRoll = held('ArrowLeft', 'ArrowRight');
  const opts = { inRate: R.axisIn, reverseRate: R.axisReverse, centerRate: R.axisCenter, hold: st.holdMode, limit: fine };
  // ↓ = pull (nose up), like a yoke
  if (kbPitch || !(st.mouseYoke || (gp && gp.pitch !== null))) {
    c.pitch = rampAxis(num(c.pitch), !st.shift && held('ArrowUp'), !st.shift && held('ArrowDown'), dt, opts);
  }
  if (kbRoll || !(st.mouseYoke || (gp && gp.roll !== null))) {
    c.roll = rampAxis(num(c.roll), held('ArrowLeft'), held('ArrowRight'), dt, opts);
  }
  if (!kbPitch && st.mouseYoke && st.mouse.valid) c.pitch = approach(c.pitch, expo(deadzone(st.mouse.y, 0.04)), 6, dt);
  if (!kbRoll && st.mouseYoke && st.mouse.valid) c.roll = approach(c.roll, expo(deadzone(st.mouse.x, 0.04)), 6, dt);
  if (gp && gp.pitch !== null && !kbPitch) c.pitch = gp.pitch;
  if (gp && gp.roll !== null && !kbRoll) c.roll = gp.roll;
  // rudder pedals
  const kbYaw = held('KeyZ', 'KeyX');
  if (gp && gp.yaw !== null && !kbYaw) c.yaw = gp.yaw;
  else c.yaw = rampAxis(num(c.yaw), held('KeyZ'), held('KeyX'), dt, { inRate: R.rudderIn, reverseRate: 3, centerRate: R.rudderCenter });
  // nose-wheel tiller (Q/E), pedals also steer below 30 kt
  const tillerKeys = held('KeyQ', 'KeyE');
  if (tillerKeys && ac.onGround) c.tiller = rampAxis(num(c.tiller), held('KeyQ'), held('KeyE'), dt, { inRate: R.tillerIn, reverseRate: 2.5, centerRate: R.tillerCenter });
  else {
    const gsKt = num(ac.gs) / KT;
    const pedalSteer = ac.onGround ? c.yaw * 0.5 * clamp((30 - gsKt) / 10, 0, 1) : 0;
    c.tiller = approach(num(c.tiller), pedalSteer, R.tillerCenter, dt);
  }
  for (const k of ['pitch', 'roll', 'yaw', 'tiller']) c[k] = clamp(num(c[k]), -1, 1);
}

function stepThrottles(sim, dt, gp) {
  const c = sim.controls;
  const up = held('PageUp', 'F3', 'NumpadAdd') || (st.shift && held('ArrowUp'));
  const down = held('PageDown', 'NumpadSubtract') || (st.shift && held('ArrowDown'));
  const revKey = held('F2');
  let pilot = !!c.throttlePilot;                     // pedestal drag sets this flag
  c.throttlePilot = false;
  const rev = Math.max(c.reverse[0], c.reverse[1]);
  if (up || down || revKey) { st.throttleTarget = null; pilot = true; }
  if (up) {
    if (rev > 0) { st.reverseTarget = null; c.reverse = c.reverse.map((r) => approach(r, 0, R.reverse, dt)); }
    else c.throttle = c.throttle.map((t) => clamp(t + R.throttle * dt, 0, 1));
  }
  if (down) c.throttle = c.throttle.map((t) => clamp(t - R.throttle * dt, 0, 1));
  if (revKey) {
    if (c.throttle.some((t) => t > 0.03)) c.throttle = c.throttle.map((t) => clamp(t - R.throttle * dt, 0, 1));
    else if (canReverse(sim)) { st.reverseTarget = null; c.reverse = c.reverse.map((r) => approach(r, 1, R.reverse, dt)); }
  }
  if (gp && gp.throttleRate) {
    pilot = true; st.throttleTarget = null;
    c.throttle = c.throttle.map((t) => clamp(t + gp.throttleRate * dt, 0, 1));
  }
  if (st.throttleTarget !== null) {
    pilot = true;
    c.throttle = c.throttle.map((t) => approach(t, st.throttleTarget, R.throttleGoTo, dt));
    if (c.throttle.every((t) => t === st.throttleTarget)) st.throttleTarget = null;
  }
  if (st.reverseTarget !== null) {
    pilot = true;
    if (st.reverseTarget > 0 && !canReverse(sim)) st.reverseTarget = 0;
    c.reverse = c.reverse.map((r) => approach(r, st.reverseTarget, R.reverse, dt));
    if (c.reverse.every((r) => r === st.reverseTarget)) st.reverseTarget = null;
  }
  // reverse levers can only be up with forward levers at idle on the ground
  if (!(sim.ac.onGround || num(sim.ac.ra) < 3)) c.reverse = c.reverse.map((r) => approach(r, 0, R.reverse * 2, dt));
  return pilot;
}

function stepBrakesTrimSpeedbrake(sim, dt, gp) {
  const c = sim.controls;
  const brk = (!st.shift && held('Period')) || held('KeyB') || (gp && gp.brake);
  st.pilotBrake = brk ? approach(st.pilotBrake, 1, R.brakeIn, dt) : approach(st.pilotBrake, 0, R.brakeOut, dt);
  c.pilotBrakeL = c.pilotBrakeR = st.pilotBrake;
  // autobrake pressure is added here only when the physics does not run its own autobrake
  const ab = sim.systems && sim.systems.autobrake;
  const auto = ab && !ab.physics ? num(ab.cmd) : 0;
  c.brakeL = Math.max(st.pilotBrake, auto);
  c.brakeR = Math.max(st.pilotBrake, auto);
  // pitch trim switch (momentary)
  const nd = held('Home', 'Numpad7') || (gp && gp.trim < 0);
  const nu = held('End', 'Numpad1') || (gp && gp.trim > 0);
  c.trimSwitch = nd && !nu ? -1 : nu && !nd ? 1 : 0;
  // speedbrake lever animation toward a key-selected detent
  if (st.sbTarget !== null) {
    c.speedbrakeLever = approach(num(c.speedbrakeLever), st.sbTarget, R.speedbrake, dt);
    if (c.speedbrakeLever === st.sbTarget) st.sbTarget = null;
  }
}

function stepLook(sim, dt) {
  const v = sim.view;
  const yaw = (held('Numpad6', 'Numpad3') ? 1 : 0) - (held('Numpad4') ? 1 : 0);
  const pit = (held('Numpad8') ? 1 : 0) - (held('Numpad2') ? 1 : 0);
  if (yaw) v.lookYaw = wrapPi(num(v.lookYaw) + yaw * R.look * dt);
  if (pit) v.lookPitch = clamp(num(v.lookPitch) + pit * R.look * dt, -1.4, 1.4);
  if (held('Numpad9')) v.zoom = clamp(num(v.zoom, 1) * (1 + dt), 0.4, 3);
}

function stepAtBackdrive(sim, dt, pilotThr) {
  const cmd = sim.ap && sim.ap.thrustCmd;
  const c = sim.controls;
  if (cmd === null || cmd === undefined || !Number.isFinite(cmd) || pilotThr) return;
  if (c.reverse[0] > 0.01 || c.reverse[1] > 0.01) return;
  const target = clamp(cmd, 0, 1);
  c.throttle = c.throttle.map((t) => approach(num(t), target, R.atBackdrive, dt));
}

// ---------------------------------------------------------------- gamepad
function readGamepad(sim) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  let pad = null;
  try { pad = [...navigator.getGamepads()].find((g) => g && g.connected && g.axes.length >= 2); } catch { return null; }
  if (!pad) return null;
  const ax = (i) => num(pad.axes[i]);
  const bt = (i) => (pad.buttons[i] ? num(pad.buttons[i].value, pad.buttons[i].pressed ? 1 : 0) : 0);
  const pressed = (i) => bt(i) > 0.5;
  const prev = st.gp.prev;
  const edge = (i) => pressed(i) && !prev[i];
  const out = { pitch: null, roll: null, yaw: null, throttleRate: 0, brake: false, trim: 0 };
  const lx = deadzone(ax(0), 0.08), ly = deadzone(ax(1), 0.08);
  // sticks: only take over once moved (so an idle pad doesn't fight the keyboard)
  if (lx || ly) st.gp.active = true;
  if (st.gp.active) { out.roll = expo(lx); out.pitch = expo(ly); }
  const yaw = bt(7) - bt(6);
  if (Math.abs(yaw) > 0.05) out.yaw = yaw;
  const ry = deadzone(ax(3), 0.12);
  if (ry) out.throttleRate = -ry * 0.5;
  out.brake = pressed(0);
  if (edge(1)) toggleGear(sim);
  if (edge(2)) moveFlaps(sim, -1);
  if (edge(3)) moveFlaps(sim, +1);
  if (edge(4)) sim.controls.apDisc = true;
  out.trim = pressed(12) ? -1 : pressed(13) ? 1 : 0;
  st.gp.prev = pad.buttons.map((b) => !!(b && (b.pressed || b.value > 0.5)));
  return out;
}

// ------------------------------------------------------------------ help
/** Key binding list for menus / help overlays. */
export function getBindingsHelp() {
  return [
    { keys: '↑ / ↓', action: 'Pitch (↓ = pull, nose up); Ctrl = fine' },
    { keys: '← / →', action: 'Roll' },
    { keys: 'Z / X', action: 'Rudder (also nose-wheel below 30 kt)' },
    { keys: 'Q / E', action: 'Nose-wheel tiller (ground)' },
    { keys: 'PgUp / PgDn, F3 / F2, Num + / −, Shift+↑/↓', action: 'Thrust levers' },
    { keys: 'F1 / F4', action: 'Thrust idle / full' },
    { keys: 'F2 (hold at idle), R', action: 'Reverse thrust' },
    { keys: 'F7 / F6, ] / [', action: 'Flaps down / up one detent (gates at 1 and 20)' },
    { keys: 'G', action: 'Gear lever' },
    { keys: '/  ·  Shift+/', action: 'Speedbrake UP/DOWN  ·  ARM' },
    { keys: '. or B (hold)', action: 'Brakes' },
    { keys: 'Shift+. or P', action: 'Parking brake' },
    { keys: 'Home / End (Num 7 / 1)', action: 'Pitch trim nose down / up' },
    { keys: 'A  ·  Shift+A', action: 'Autopilot engage/disconnect  ·  A/T arm/disconnect' },
    { keys: 'T', action: 'TO/GA' },
    { keys: 'C  ·  V', action: 'Cycle view  ·  toggle panel' },
    { keys: 'Right-drag, Num 4/6/8/2, Num 5', action: 'Look around, reset view' },
    { keys: '1 / 2 / 3 / 4', action: 'Overhead / pedestal / CDU / lower EICAS' },
    { keys: 'Y  ·  H', action: 'Mouse-yoke mode  ·  control hold (no auto-centre)' },
    { keys: 'Esc  ·  Space  ·  =', action: 'Menu  ·  pause  ·  sim rate 1×/2×/4×' },
    { keys: 'Gamepad', action: 'L-stick pitch/roll, triggers rudder, R-stick Y thrust, A brakes, B gear, X/Y flaps, LB AP disc' },
  ];
}

/** Test/debug helper: current internal input state. */
export function getInputState() { return { holdMode: st.holdMode, mouseYoke: st.mouseYoke, held: [...st.held] }; }
