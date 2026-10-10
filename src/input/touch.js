// Touch / iPad flight controls (overlay in #touch-ui).
//
// Shown automatically on coarse-pointer devices (or after the first touch, or with ?touch=1).
// Runs AFTER stepInput each frame (main.js calls stepTouch right after it), so it overrides the
// keyboard auto-centring only while the pilot is actually using a touch control:
//   - yoke pad    : drag = column/wheel (drag down = pull / nose up, like the yoke). Springs back
//                   on release unless HOLD is latched. Multi-touch safe: each control tracks its
//                   own pointerId, so yoke + lever + rudder can be used at the same time.
//   - thrust lever: relative vertical drag, both engines; reverse zone below idle (ground only).
//                   While untouched the knob shows the real lever position, so A/T backdrive is
//                   visible. While touched it sets controls.throttlePilot (input.js then skips
//                   backdrive for that frame, like a pedestal drag).
//   - buttons     : rudder / brakes / trim (hold), flaps, gear, speedbrake, park brake, A/P, A/T,
//                   TO/GA, view, panel, menu; ✕ close buttons are injected into the drawers.
// Also: blocks page zoom/bounce gestures, one-finger look-around on the outside view,
// primes speechSynthesis + resumes WebAudio on touch (iOS needs a gesture), "rotate" hint.
//
// API: initTouch(sim, rootEl, { call }), stepTouch(sim, dt). `call(name, ...args)` is main.js's
// safe() so we can reach afdsAction / resumeAudio without importing those modules directly.

import { FLAP_DETENTS } from '../core/state.js';
import { clamp, approach, wrapPi } from '../core/geo.js';

const R = { yokeFollow: 9, yokeSpring: 3.2, thrLever: 1.6, rev: 1.4, rudderIn: 1.6, brakeIn: 2.5, brakeOut: 4, sb: 1.5 };
const REV_FRAC = 0.22;          // bottom part of the lever track = reverse range
const IDLE_GATE_PX = 16;        // extra drag needed below idle before reverse starts
const VIEW_MODES = ['cockpit', 'chase', 'flyby', 'tower'];

const st = {
  sim: null, call: () => undefined, on: false, hidden: false, built: false,
  el: null, r: {},              // overlay root and element refs
  yoke: { id: null, tx: 0, ty: 0, x: 0, y: 0, owned: false, hold: false },
  thr: { id: null, v: 0, startY: 0, startP: 0, h: 1 },
  holds: new Map(),             // pointerId -> action name for momentary buttons
  yaw: 0, yawOwned: false, brake: 0, sbTarget: null,
  look: null, lastTap: 0, frame: 0, alerts: null, primed: false, lastSig: '',
};

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const expo = (v, e = 0.4) => v * (1 - e) + v * v * v * e;
const $ = (sel, root = document) => root.querySelector(sel);
const toast = (text) => st.sim && st.sim.events.emit('toast', { text });
const running = () => !!(st.sim && st.sim.world && st.sim.world.status === 'running');

function h(tag, cls, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of [].concat(kids)) if (k != null) e.append(k);
  return e;
}
const btn = (act, label, cls = '', extra = {}) =>
  h('button', `tc-btn ${cls}`.trim(), { type: 'button', 'data-act': act, ...extra }, label);

// ------------------------------------------------------------------ init

/** Install gesture guards, detection, and build the overlay (hidden until touch is detected). */
export function initTouch(sim, rootEl, { call } = {}) {
  st.sim = sim;
  if (typeof call === 'function') st.call = call;
  if (typeof window === 'undefined' || st.built) return;
  st.built = true;
  import('../systems/alerts.js').then((m) => { st.alerts = m; }).catch(() => {});

  installGestureGuards();
  buildOverlay(rootEl || document.getElementById('app') || document.body);
  buildRotateHint();
  installLook();

  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const forced = /[?&]touch=1/.test(location.search);
  // iPads with a trackpad/Magic Keyboard report a fine pointer, so also trust the touch-point count.
  const touchScreen = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  if (coarse || forced || touchScreen) enableTouch();
  else window.addEventListener('touchstart', () => enableTouch(), { once: true, passive: true });
  // also enable on the first pointer event of type touch (pointer events without touch events)
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') enableTouch(); }, { passive: true });
}

function enableTouch() {
  if (st.on) return;
  st.on = true;
  document.body.classList.add('touch-ui');
  window.dispatchEvent(new Event('resize'));   // canvases re-measure if layout changed
}

/** Stop pinch-zoom, double-tap zoom, rubber-band scrolling; prime audio on touch. */
function installGestureGuards() {
  const prevent = (e) => e.preventDefault();
  // Safari's proprietary pinch events
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, prevent, { passive: false });
  // block page scroll/bounce except inside scrollable UI (menu, drawers)
  document.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length > 1) { e.preventDefault(); return; }
    const t = e.target;
    if (t && t.closest && t.closest('#menu, .drawer, [data-scroll]')) return;
    e.preventDefault();
  }, { passive: false });
  // (double-tap zoom is disabled by touch-action in touch.css; preventing touchend would eat clicks)
  // iOS: audio may only start/resume inside a gesture. touchend + click are both "activations".
  const unlock = () => {
    primeSpeech();
    if (running()) st.call('resumeAudio');
  };
  document.addEventListener('touchend', unlock, { capture: true, passive: true });
  document.addEventListener('click', unlock, { capture: true, passive: true });
  document.addEventListener('contextmenu', (e) => { if (st.on && !(e.target.closest && e.target.closest('input, textarea'))) e.preventDefault(); });
}

/** Speak an empty, silent utterance once inside a user gesture: unlocks speechSynthesis on iOS. */
export function primeSpeech() {
  if (st.primed || typeof window === 'undefined' || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
  st.primed = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0; u.rate = 2;
    window.speechSynthesis.speak(u);
  } catch { /* not supported */ }
}

// ------------------------------------------------------------------ DOM

function buildOverlay(root) {
  let el = document.getElementById('touch-ui');
  if (!el) { el = h('div', '', { id: 'touch-ui' }); root.append(el); }
  el.setAttribute('aria-label', 'Touch flight controls');
  el.innerHTML = '';
  const r = st.r;

  // top bars
  const left = h('div', 'tc-bar tc-bar--left', {}, [
    btn('menu', 'MENU', 'tc-btn--menu', { 'aria-label': 'Pause / menu' }),
    btn('view', 'VIEW', '', { 'aria-label': 'Cycle view' }),
    (r.panel = btn('panel', 'PANEL', '', { 'aria-label': 'Toggle instrument panel' })),
    (r.hide = btn('hide', 'HIDE', 'tc-btn--hide', { 'aria-label': 'Hide touch controls', 'aria-pressed': 'false' })),
  ]);
  const right = h('div', 'tc-bar tc-bar--right tc-fly', {}, [
    (r.ap = btn('ap', 'A/P', 'tc-annun', { 'aria-label': 'Autopilot engage / disconnect' })),
    (r.at = btn('at', 'A/T', 'tc-annun', { 'aria-label': 'Autothrottle arm / disconnect' })),
    (r.toga = btn('toga', 'TO/GA', '', { 'aria-label': 'TO/GA' })),
  ]);

  // yoke pad + side column
  r.knob = h('div', 'tc-knob');
  r.pad = h('div', 'tc-pad', { role: 'application', 'aria-label': 'Yoke: drag down to pull, sideways to roll' }, [
    h('i', 'tc-cross tc-cross--h'), h('i', 'tc-cross tc-cross--v'), h('i', 'tc-ring'),
    h('span', 'tc-pad-lbl tc-pad-lbl--t', {}, 'PUSH'), h('span', 'tc-pad-lbl tc-pad-lbl--b', {}, 'PULL'),
    r.knob,
  ]);
  const yokeSide = h('div', 'tc-col', {}, [
    (r.hold = btn('hold', 'HOLD', 'tc-annun tc-btn--s', { 'aria-pressed': 'false', 'aria-label': 'Hold yoke position' })),
    btn('trimDn', h('span', '', {}, ['TRIM', h('small', '', {}, 'NOSE DN')]), 'tc-btn--s tc-hold', { 'data-hold': 'trimDn', 'aria-label': 'Trim nose down (hold)' }),
    btn('trimUp', h('span', '', {}, ['TRIM', h('small', '', {}, 'NOSE UP')]), 'tc-btn--s tc-hold', { 'data-hold': 'trimUp', 'aria-label': 'Trim nose up (hold)' }),
  ]);
  const rudder = h('div', 'tc-rudder', {}, [
    btn('rudL', '◀ RUDDER', 'tc-hold', { 'data-hold': 'rudL', 'aria-label': 'Left rudder (hold)' }),
    btn('rudR', 'RUDDER ▶', 'tc-hold', { 'data-hold': 'rudR', 'aria-label': 'Right rudder (hold)' }),
  ]);
  const leftCluster = h('div', 'tc-left tc-fly', {}, [h('div', 'tc-yoke', {}, [r.pad, yokeSide]), rudder]);

  // thrust lever
  r.thrKnob = h('div', 'tc-thr-knob', {}, h('span', '', {}, '≡'));
  r.thrFill = h('i', 'tc-thr-fill');
  r.thrTrack = h('div', 'tc-thr-track', { role: 'slider', 'aria-label': 'Thrust levers', 'aria-valuemin': '-1', 'aria-valuemax': '1' }, [
    h('i', 'tc-thr-rev'), r.thrFill, h('i', 'tc-thr-idle'),
    h('span', 'tc-thr-mk tc-thr-mk--full', {}, 'FULL'), h('span', 'tc-thr-mk tc-thr-mk--idle', {}, 'IDLE'),
    (r.revLbl = h('span', 'tc-thr-mk tc-thr-mk--rev', {}, 'REV')),
    r.thrKnob,
  ]);
  r.thrRead = h('div', 'tc-thr-read', {}, '');
  const thr = h('div', 'tc-thr', {}, [h('div', 'tc-cap', {}, 'THRUST'), r.thrTrack, r.thrRead]);

  // configuration grid
  r.flapVal = h('b', '', {}, '0');
  const cfg = h('div', 'tc-cfg', {}, [
    h('div', 'tc-flaps', {}, [
      h('div', 'tc-cap', {}, 'FLAPS'),
      h('div', 'tc-flaps-row', {}, [
        btn('flapUp', '−', 'tc-btn--sq', { 'aria-label': 'Flaps up one detent' }),
        h('div', 'tc-flap-read', {}, [r.flapVal, (r.flapAct = h('small', '', {}, ''))]),
        btn('flapDn', '+', 'tc-btn--sq', { 'aria-label': 'Flaps down one detent' }),
      ]),
    ]),
    h('div', 'tc-grid', {}, [
      (r.gear = btn('gear', 'GEAR', 'tc-annun', { 'aria-label': 'Gear lever' })),
      (r.sb = btn('sb', 'SPD BRK', 'tc-annun', { 'aria-label': 'Speedbrake: down, armed, up' })),
      (r.park = btn('park', 'PARK BRK', 'tc-annun', { 'aria-label': 'Parking brake' })),
      (r.brake = btn('brake', 'BRAKES', 'tc-annun tc-hold', { 'data-hold': 'brake', 'aria-label': 'Wheel brakes (hold)' })),
    ]),
  ]);
  const rightCluster = h('div', 'tc-right tc-fly', {}, [cfg, thr]);

  el.append(left, right, leftCluster, rightCluster);
  st.el = el;

  // tap actions
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.classList.contains('tc-hold')) return;
    onAction(b.dataset.act);
    b.blur();
  });
  // momentary (hold) buttons: tracked per pointer
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-hold]');
    if (!b) return;
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    st.holds.set(e.pointerId, b.dataset.hold);
    b.classList.add('down');
    st.call('resumeAudio');
  });
  const endHold = (e) => {
    const name = st.holds.get(e.pointerId);
    if (!name) return;
    st.holds.delete(e.pointerId);
    if (![...st.holds.values()].includes(name)) el.querySelector(`[data-hold="${name}"]`)?.classList.remove('down');
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, endHold);

  installYoke(r.pad);
  installLever(r.thrTrack);
  injectDrawerClose();
}

function buildRotateHint() {
  if (document.getElementById('rotate-hint')) return;
  const hint = h('div', '', { id: 'rotate-hint', role: 'alert' }, [
    h('div', 'rh-card', {}, [
      h('div', 'rh-icon', { 'aria-hidden': 'true' }, h('i')),
      h('p', 'rh-title', {}, 'Rotate to landscape'),
      h('p', 'rh-sub', {}, 'The flight deck is laid out for a landscape screen.'),
      h('button', 'tc-btn rh-btn', { type: 'button' }, 'CONTINUE IN PORTRAIT'),
    ]),
  ]);
  hint.querySelector('button').addEventListener('click', () => document.body.classList.add('portrait-ok'));
  document.body.append(hint);
}

/** A visible ✕ on every drawer (re-injected if a module re-renders the drawer). */
function injectDrawerClose() {
  for (const name of ['overhead', 'pedestal', 'cdu', 'lower']) {
    const d = document.getElementById(`drawer-${name}`);
    if (!d || d.querySelector(':scope > .drawer-close')) continue;
    const b = h('button', 'drawer-close', { type: 'button', 'aria-label': `Close ${name} panel`, title: 'Close' }, '✕');
    b.addEventListener('click', (e) => { e.stopPropagation(); setDrawer(name, false); });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.append(b);
  }
}

function setDrawer(name, open) {
  const sim = st.sim;
  if (sim.ui && typeof sim.ui.toggleDrawer === 'function') sim.ui.toggleDrawer(name, open);
  else if (sim.events) sim.events.emit('drawer', { name, open });
}

// ------------------------------------------------------------------ yoke

function installYoke(pad) {
  const y = st.yoke;
  const set = (e) => {
    const r = pad.getBoundingClientRect();
    const rad = Math.max(20, r.width / 2 - 26);
    y.tx = clamp((e.clientX - (r.left + r.width / 2)) / rad, -1, 1);
    y.ty = clamp((e.clientY - (r.top + r.height / 2)) / rad, -1, 1);
  };
  pad.addEventListener('pointerdown', (e) => {
    if (y.id !== null) return;                     // one finger flies the yoke
    e.preventDefault();
    y.id = e.pointerId;
    try { pad.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!y.owned) { y.x = num(st.sim.controls.roll); y.y = num(st.sim.controls.pitch); }
    y.owned = true;
    set(e);
    pad.classList.add('active');
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === y.id) set(e); });
  const end = (e) => {
    if (e.pointerId !== y.id) return;
    y.id = null;
    pad.classList.remove('active');
    if (!y.hold) { y.tx = 0; y.ty = 0; }
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(t, end);
}

function stepYoke(sim, dt) {
  const y = st.yoke, c = sim.controls;
  if (!y.owned) return;
  const touching = y.id !== null;
  const rate = touching || y.hold ? R.yokeFollow : R.yokeSpring;
  y.x = approach(y.x, y.tx, rate, dt);
  y.y = approach(y.y, y.ty, rate, dt);
  c.roll = clamp(expo(y.x), -1, 1);
  c.pitch = clamp(expo(y.y), -1, 1);      // drag down (+y) = pull = nose up
  // released and centred: hand the axes back to keyboard / gamepad / AP
  if (!touching && !y.hold && Math.abs(y.x) < 1e-3 && Math.abs(y.y) < 1e-3) { y.owned = false; c.roll = 0; c.pitch = 0; }
}

// ------------------------------------------------------------------ thrust lever

// lever value v: -1 full reverse .. 0 idle .. +1 full forward; p: 0 bottom .. 1 top of track
const vToP = (v) => (v >= 0 ? REV_FRAC + v * (1 - REV_FRAC) : REV_FRAC + v * REV_FRAC);

function canReverse(sim) {
  return !!(sim.ac.onGround || num(sim.ac.ra, 99) < 3);
}

function installLever(track) {
  const t = st.thr;
  track.addEventListener('pointerdown', (e) => {
    if (t.id !== null) return;
    e.preventDefault();
    t.id = e.pointerId;
    try { track.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const r = track.getBoundingClientRect();
    t.h = Math.max(40, r.height - 44);              // knob travel
    t.v = actualLever(st.sim);
    // tap outside the knob: jump the grab point there (but not into reverse)
    const knobP = vToP(t.v);
    const tapP = clamp(1 - (e.clientY - r.top - 22) / t.h, 0, 1);
    if (Math.abs(tapP - knobP) * t.h > 40) t.v = pToV(Math.max(tapP, REV_FRAC), t.v);
    t.startY = e.clientY; t.startP = vToP(t.v);
    track.classList.add('active');
  });
  track.addEventListener('pointermove', (e) => {
    if (e.pointerId !== t.id) return;
    const p = clamp(t.startP - (e.clientY - t.startY) / t.h, 0, 1);
    t.v = pToV(p, t.v);
  });
  const end = (e) => {
    if (e.pointerId !== t.id) return;
    t.id = null;
    track.classList.remove('active');
  };
  for (const ty of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ty, end);
}

/** Track position -> lever value, with an idle gate before the reverse range. */
function pToV(p, prevV) {
  if (p >= REV_FRAC) return (p - REV_FRAC) / (1 - REV_FRAC);
  const gate = IDLE_GATE_PX / Math.max(40, st.thr.h);
  if (prevV >= 0 && REV_FRAC - p < gate) return 0;          // held at the idle stop
  if (!canReverse(st.sim)) return 0;
  return -clamp((REV_FRAC - p - (prevV < 0 ? 0 : gate)) / Math.max(1e-3, REV_FRAC - gate), 0, 1);
}

function actualLever(sim) {
  const c = sim.controls;
  const rev = Math.max(num(c.reverse[0]), num(c.reverse[1]));
  if (rev > 0.01) return -rev;
  return (num(c.throttle[0]) + num(c.throttle[1])) / 2;
}

function stepLever(sim, dt) {
  const t = st.thr, c = sim.controls;
  if (t.id === null) return;
  if (t.v < 0 && !canReverse(sim)) t.v = 0;
  const thrT = Math.max(0, t.v), revT = Math.max(0, -t.v);
  const rev = Math.max(c.reverse[0], c.reverse[1]);
  if (revT > 0 || rev > 0.01) {
    c.throttle = c.throttle.map((x) => approach(num(x), 0, R.thrLever * 2, dt));
    if (c.throttle.every((x) => x < 0.03)) c.reverse = c.reverse.map((r) => approach(num(r), revT, R.rev, dt));
  } else {
    c.throttle = c.throttle.map((x) => approach(num(x), thrT, R.thrLever, dt));
  }
  c.throttlePilot = true;    // input.js: pilot moved the levers this frame -> no A/T backdrive
}

// ------------------------------------------------------------------ discrete actions

function onAction(act) {
  const sim = st.sim;
  if (!sim) return;
  const c = sim.controls, ap = sim.ap;
  switch (act) {
    case 'menu':
      if (sim.ui && sim.ui.openMenu) sim.ui.openMenu(); else sim.events.emit('menu', {});
      break;
    case 'view': {
      const i = VIEW_MODES.indexOf(sim.view.mode);
      sim.view.mode = VIEW_MODES[(i + 1) % VIEW_MODES.length];
      sim.view.lookYaw = 0; sim.view.lookPitch = 0;
      toast(`View: ${sim.view.mode}`);
      break;
    }
    case 'panel': sim.view.panel = !sim.view.panel; if (sim.view.mode !== 'cockpit') { sim.view.mode = 'cockpit'; sim.view.panel = true; } break;
    case 'hide':
      st.hidden = !st.hidden;
      document.body.classList.toggle('touch-ctl-hidden', st.hidden);
      st.r.hide.textContent = st.hidden ? 'SHOW' : 'HIDE';
      st.r.hide.setAttribute('aria-pressed', String(st.hidden));
      break;
    case 'hold': {
      const y = st.yoke;
      y.hold = !y.hold;
      if (y.hold && !y.owned) { y.owned = true; y.x = y.tx = num(c.roll); y.y = y.ty = num(c.pitch); }
      if (!y.hold && y.id === null) { y.tx = 0; y.ty = 0; }
      toast(y.hold ? 'Yoke HOLD: stays where you leave it' : 'Yoke springs back to centre');
      break;
    }
    case 'ap':
      if (ap.apEngaged || ap.discWarning) c.apDisc = true;
      else st.call('afdsAction', sim, 'AP_ENGAGE');
      break;
    case 'at': {
      if (ap.atEngaged) { c.atDisc = true; break; }
      const discMsg = sim.alerts && sim.alerts.list.some((m) => m.text === 'AUTOTHROTTLE DISC');
      if (discMsg) { c.atDisc = true; if (st.alerts && st.alerts.acknowledgeATDisc) st.alerts.acknowledgeATDisc(sim); break; }
      st.call('afdsAction', sim, 'AT_ARM');
      toast(ap.atArm ? 'A/T ARM' : 'A/T OFF');
      break;
    }
    case 'toga': c.toga = true; toast('TO/GA'); break;
    case 'flapUp': case 'flapDn': {
      const cur = clamp(Math.round(num(c.flapLever)), 0, FLAP_DETENTS.length - 1);
      c.flapLever = clamp(cur + (act === 'flapDn' ? 1 : -1), 0, FLAP_DETENTS.length - 1);
      break;
    }
    case 'gear':
      if (c.gearLever === 'DOWN') {
        if (sim.ac.onGround) { toast('Gear lever locked on the ground'); break; }
        c.gearLever = 'UP';
      } else c.gearLever = 'DOWN';
      break;
    case 'sb':     // DOWN -> ARMED -> UP -> DOWN
      if (c.speedbrakeLever > 0.5) { c.speedbrakeArmed = false; st.sbTarget = 0; toast('Speedbrake DOWN'); }
      else if (c.speedbrakeArmed) { c.speedbrakeArmed = false; st.sbTarget = 1; toast('Speedbrake UP'); }
      else { c.speedbrakeArmed = true; st.sbTarget = 0; toast('Speedbrake ARMED'); }
      break;
    case 'park':
      c.parkingBrake = !c.parkingBrake;
      toast(c.parkingBrake ? 'Parking brake SET' : 'Parking brake RELEASED');
      break;
    default: break;
  }
}

/** Momentary controls (rudder, brakes, trim) — written after input.js so they win while held. */
function stepHolds(sim, dt) {
  const c = sim.controls;
  const held = new Set(st.holds.values());
  // rudder pedals
  const dir = (held.has('rudR') ? 1 : 0) - (held.has('rudL') ? 1 : 0);
  if (dir) {
    if (!st.yawOwned) { st.yaw = num(c.yaw); st.yawOwned = true; }
    st.yaw = approach(st.yaw, dir, R.rudderIn, dt);
    c.yaw = st.yaw;
  } else st.yawOwned = false;                     // input.js recentres from here
  // brakes
  st.brake = held.has('brake') ? approach(st.brake, 1, R.brakeIn, dt) : approach(st.brake, 0, R.brakeOut, dt);
  if (st.brake > 0) {
    c.pilotBrakeL = Math.max(num(c.pilotBrakeL), st.brake);
    c.pilotBrakeR = Math.max(num(c.pilotBrakeR), st.brake);
    c.brakeL = Math.max(num(c.brakeL), st.brake);
    c.brakeR = Math.max(num(c.brakeR), st.brake);
  }
  // trim switch
  const nu = held.has('trimUp'), nd = held.has('trimDn');
  if (nu !== nd) c.trimSwitch = nu ? 1 : -1;
  // speedbrake lever animation
  if (st.sbTarget !== null) {
    c.speedbrakeLever = approach(num(c.speedbrakeLever), st.sbTarget, R.sb, dt);
    if (c.speedbrakeLever === st.sbTarget) st.sbTarget = null;
  }
}

// ------------------------------------------------------------------ look-around on the outside view

function installLook() {
  const w = document.getElementById('world');
  if (!w) return;
  w.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !st.sim || st.look) return;
    const now = performance.now();
    if (now - st.lastTap < 300) { st.sim.view.lookYaw = 0; st.sim.view.lookPitch = 0; st.lastTap = 0; return; }  // double-tap resets
    st.lastTap = now;
    st.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { w.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  w.addEventListener('pointermove', (e) => {
    const l = st.look;
    if (!l || e.pointerId !== l.id) return;
    const v = st.sim.view;
    v.lookYaw = wrapPi(num(v.lookYaw) - (e.clientX - l.x) * 0.006);
    v.lookPitch = clamp(num(v.lookPitch) + (e.clientY - l.y) * 0.006, -1.4, 1.4);
    l.x = e.clientX; l.y = e.clientY;
  });
  const end = (e) => { if (st.look && e.pointerId === st.look.id) st.look = null; };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) w.addEventListener(t, end);
}

// ------------------------------------------------------------------ per frame

/** Call right after stepInput(sim, dt). Never throws. */
export function stepTouch(sim, dt) {
  try {
    st.sim = sim;
    dt = clamp(num(dt), 0, 0.25);
    const dtr = dt / Math.max(1, num(sim.simRate, 1));   // control feel in real time
    stepYoke(sim, dtr);
    stepLever(sim, dtr);
    stepHolds(sim, dtr);
    if (st.on) render(sim);
    if ((st.frame++ % 90) === 0) injectDrawerClose();
  } catch (err) {
    if (!stepTouch._warned) { console.warn('stepTouch:', err); stepTouch._warned = true; }
  }
}

/** Update knob / lever / annunciators. Only touches the DOM when something changed. */
function render(sim) {
  const r = st.r, c = sim.controls, ap = sim.ap, y = st.yoke;
  // yoke knob: finger/spring position while owned, otherwise the actual column/wheel
  const kx = y.owned ? y.x : num(c.roll), ky = y.owned ? y.y : num(c.pitch);
  r.pad.style.setProperty('--kx', kx.toFixed(3));
  r.pad.style.setProperty('--ky', ky.toFixed(3));
  // lever: finger while touched, else real lever (shows A/T backdrive)
  const lv = st.thr.id !== null ? st.thr.v : actualLever(sim);
  r.thrTrack.style.setProperty('--p', vToP(lv).toFixed(4));

  const rev = Math.max(c.reverse[0], c.reverse[1]);
  const n1 = (num(sim.engines[0]?.n1) + num(sim.engines[1]?.n1)) / 2;
  const gearPos = num(sim.surfaces.gear, 1);
  const gearTxt = c.gearLever === 'UP' ? (gearPos < 0.02 ? 'UP' : 'TRANSIT') : (gearPos > 0.98 ? 'DOWN' : 'TRANSIT');
  const sbTxt = c.speedbrakeLever > 0.05 ? 'UP' : c.speedbrakeArmed ? 'ARMED' : 'DOWN';
  const flapDeg = FLAP_DETENTS[clamp(Math.round(num(c.flapLever)), 0, FLAP_DETENTS.length - 1)];
  const flapAct = Math.round(num(sim.surfaces.flapsDeg));
  const at = ap.atEngaged ? 'on' : ap.atArm ? 'arm' : '';
  const atDrive = ap.thrustCmd !== null && ap.thrustCmd !== undefined && st.thr.id === null;
  const revOk = canReverse(sim);
  const sig = [n1.toFixed(0), rev > 0.01, gearTxt, sbTxt, flapDeg, flapAct, c.parkingBrake, ap.apEngaged, at, atDrive, revOk,
    sim.view.panel, sim.view.mode, y.hold].join('|');
  if (sig === st.lastSig) return;
  st.lastSig = sig;

  r.thrRead.textContent = rev > 0.01 ? `REV ${Math.round(rev * 100)}%` : `N1 ${n1.toFixed(0)}%`;
  r.thrTrack.classList.toggle('at-drive', atDrive);
  r.thrTrack.classList.toggle('rev-ok', revOk);
  r.revLbl.textContent = revOk ? 'REV' : 'REV · GND';
  r.flapVal.textContent = String(flapDeg);
  r.flapAct.textContent = flapAct !== flapDeg ? `${flapAct}°` : '';
  setAnnun(r.gear, gearTxt === 'DOWN' ? 'on' : gearTxt === 'TRANSIT' ? 'amber' : '', `GEAR ${gearTxt === 'DOWN' ? 'DN' : gearTxt === 'UP' ? 'UP' : '···'}`);
  setAnnun(r.sb, sbTxt === 'UP' ? 'amber' : sbTxt === 'ARMED' ? 'on' : '', `SPD BRK ${sbTxt === 'DOWN' ? 'DN' : sbTxt === 'ARMED' ? 'ARM' : 'UP'}`);
  setAnnun(r.park, c.parkingBrake ? 'amber' : '', c.parkingBrake ? 'PARK SET' : 'PARK BRK');
  setAnnun(r.ap, ap.apEngaged ? 'on' : '', 'A/P');
  setAnnun(r.at, at === 'on' ? 'on' : at === 'arm' ? 'arm' : '', at === 'arm' ? 'A/T ARM' : 'A/T');
  setAnnun(r.hold, y.hold ? 'on' : '', 'HOLD');
  r.hold.setAttribute('aria-pressed', String(y.hold));
  r.panel.classList.toggle('on', sim.view.mode === 'cockpit' && sim.view.panel);
}

function setAnnun(b, state, text) {
  b.classList.toggle('on', state === 'on');
  b.classList.toggle('amber', state === 'amber');
  b.classList.toggle('arm', state === 'arm');
  if (b.textContent !== text) b.textContent = text;
}

/** Test/debug helper. */
export function getTouchState() {
  return { on: st.on, hidden: st.hidden, yoke: { ...st.yoke }, lever: { id: st.thr.id, v: st.thr.v }, holds: [...st.holds.values()] };
}
