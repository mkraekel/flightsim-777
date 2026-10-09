// 777 control stand / pedestal UI (Team D2), rendered inside #drawer-pedestal.
//  Glareshield strip : MASTER WARNING / MASTER CAUTION lights (click = reset)
//  Forward panel     : landing gear lever + gear indication, AUTOBRAKE selector, STAB/FLAP readouts
//  Control stand     : parking brake, speedbrake lever (DOWN/ARMED/UP), two thrust levers with
//                      TO/GA + A/T disconnect switches and reverse range, flap lever with gates at 1/20
//  Aft               : fuel control switches (RUN/CUTOFF, fire lights), STAB cutout (guarded),
//                      fire handles, transponder, rudder trim
// Levers are dragged vertically (pointer events); hold Ctrl while dragging a thrust lever to split them.

import { FLAP_DETENTS, AUTOBRAKE_SETTINGS } from '../core/state.js';
import { clamp } from '../core/geo.js';
import { resetMaster, acknowledgeATDisc } from '../systems/alerts.js';
import { h, createRegistry, pushButton, knob, lamp, lcd } from './overhead.js';

const REV_ZONE = 0.22;       // fraction of the thrust track used by the reverse range (below idle)
const SB_ARMED_P = 0.12;     // visual position of the ARMED detent
const SB_UP_START = 0.22;    // where the continuous DOWN..UP range starts
const toast = (sim, text) => sim.events.emit('toast', { text });
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '--');

let REG = null, HOST = null;
const drag = { thr: null, sb: null, flap: null };

// ---------------------------------------------------------- lever plumbing
/** Generic vertical drag on a track. onMove(p 0..1 bottom->top, event), onEnd(). */
function makeDraggable(handle, track, { onStart, onMove, onEnd }) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const r = track.getBoundingClientRect();
    const hr = handle.getBoundingClientRect();
    const grabOffset = e.clientY - (hr.top + hr.height / 2);
    const toP = (y) => clamp(1 - (y - grabOffset - r.top - hr.height / 2) / Math.max(1, r.height - hr.height), 0, 1);
    onStart && onStart(e);
    handle.classList.add('grab');
    const move = (ev) => onMove(toP(ev.clientY), ev);
    const up = () => {
      handle.classList.remove('grab');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd && onEnd();
      REG && REG.update();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
const setP = (el, p) => el.style.setProperty('--p', p.toFixed(4));

function scale(marks) {
  return h('div', 'pdl-scale', marks.map(([p, text, cls]) => {
    const m = h('span', 'pdl-mark' + (cls ? ' ' + cls : ''), text);
    m.style.setProperty('--p', p);
    return m;
  }));
}

// ------------------------------------------------------------ thrust levers
function canReverse(sim) {
  const c = sim.controls;
  return c.throttle[0] < 0.03 && c.throttle[1] < 0.03 && (sim.ac.onGround || (sim.ac.ra || 0) < 3);
}
const thrToP = (thr, rev) => (rev > 0.001 ? REV_ZONE * (1 - rev) : REV_ZONE + (1 - REV_ZONE) * thr);

function thrustQuadrant(reg) {
  const track = h('div', 'pdl-thr-track');
  const levers = [0, 1].map((i) => {
    const toga = h('button', 'pdl-toga', 'TO/GA');
    toga.type = 'button';
    toga.addEventListener('pointerdown', (e) => e.stopPropagation());
    toga.addEventListener('click', (e) => { e.stopPropagation(); reg.sim.controls.toga = true; toast(reg.sim, 'TO/GA'); });
    const atd = h('button', 'pdl-atdisc', '');
    atd.type = 'button'; atd.title = 'A/T disconnect';
    atd.addEventListener('pointerdown', (e) => e.stopPropagation());
    atd.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = reg.sim;
      s.controls.atDisc = true;
      if (!s.ap.atEngaged) acknowledgeATDisc(s);
    });
    const knobEl = h('div', 'pdl-thr-knob', h('span', 'pdl-thr-num', i ? '2' : '1'), toga);
    const revLever = h('div', 'pdl-rev');
    const handle = h('div', 'pdl-thr', h('div', 'pdl-thr-shaft'), revLever, knobEl, i === 0 ? atd : null);
    if (i === 1) handle.append(atd);
    atd.classList.add(i ? 'right' : 'left');
    return { handle, revLever, last: -1 };
  });
  levers.forEach((lv, i) => {
    track.append(lv.handle);
    makeDraggable(lv.handle, track, {
      onStart: (e) => { drag.thr = { both: !e.ctrlKey, i, p: thrToP(reg.sim.controls.throttle[i], reg.sim.controls.reverse[i]) }; },
      onMove: (p) => { drag.thr.p = p; applyThrustDrag(reg.sim); reg.update(); },
      onEnd: () => { drag.thr = null; },
    });
  });
  const slot = h('div', 'pdl-thr-slots', h('span', 'pdl-slot'), h('span', 'pdl-slot'));
  const marks = scale([[1, 'FULL'], [REV_ZONE + (1 - REV_ZONE) * 0.5, '·'], [REV_ZONE, 'IDLE', 'idle'], [REV_ZONE * 0.25, 'REV', 'rev']]);
  const el = h('div', 'pdl-quad', h('div', 'pdl-cap', 'THRUST'), h('div', 'pdl-thr-wrap', marks, slot, track),
    h('div', 'pdl-hint', 'drag · Ctrl = split'));
  reg.add({ el, update(sim) {
    const c = sim.controls;
    if (drag.thr) { applyThrustDrag(sim); c.throttlePilot = true; }
    levers.forEach((lv, i) => {
      const p = thrToP(c.throttle[i] || 0, c.reverse[i] || 0);
      if (Math.abs(p - lv.last) < 1e-4) return;
      lv.last = p; setP(lv.handle, p);
      lv.handle.classList.toggle('reversing', (c.reverse[i] || 0) > 0.001);
    });
  } });
  return el;
}

function applyThrustDrag(sim) {
  const d = drag.thr; if (!d) return;
  const c = sim.controls;
  const idx = d.both ? [0, 1] : [d.i];
  let p = d.p;
  if (p < REV_ZONE && !canReverse(sim) && !(c.reverse[0] > 0 || c.reverse[1] > 0)) p = REV_ZONE;
  for (const i of idx) {
    if (p < REV_ZONE) { c.throttle[i] = 0; c.reverse[i] = clamp(1 - p / REV_ZONE, 0, 1); }
    else { c.reverse[i] = 0; c.throttle[i] = clamp((p - REV_ZONE) / (1 - REV_ZONE), 0, 1); }
  }
  c.throttlePilot = true;
}

// ------------------------------------------------------------- speedbrake
const sbToP = (c) => (c.speedbrakeLever > 0.001 ? SB_UP_START + (1 - SB_UP_START) * c.speedbrakeLever : c.speedbrakeArmed ? SB_ARMED_P : 0);

function speedbrake(reg) {
  const track = h('div', 'pdl-track pdl-sb-track');
  const handle = h('div', 'pdl-lever pdl-sb', h('div', 'pdl-lever-shaft'), h('div', 'pdl-sb-grip', 'SPEED BRAKE'));
  track.append(handle);
  makeDraggable(handle, track, {
    onMove: (p) => {
      const c = reg.sim.controls;
      if (p < SB_ARMED_P / 2) { c.speedbrakeLever = 0; c.speedbrakeArmed = false; }
      else if (p < (SB_ARMED_P + SB_UP_START) / 2) { c.speedbrakeLever = 0; c.speedbrakeArmed = true; }
      else { c.speedbrakeArmed = false; c.speedbrakeLever = clamp((p - SB_UP_START) / (1 - SB_UP_START), 0.02, 1); }
      reg.update();
    },
  });
  const marks = scale([[1, 'UP'], [SB_UP_START + (1 - SB_UP_START) * 0.5, '·'], [SB_ARMED_P, 'ARMED', 'armed'], [0, 'DOWN']]);
  const el = h('div', 'pdl-sbwrap', h('div', 'pdl-cap', 'SPEEDBRAKE'), h('div', 'pdl-lever-wrap', marks, track));
  let last = -1;
  reg.add({ el, update(sim) {
    const p = sbToP(sim.controls);
    if (p === last) return; last = p; setP(handle, p);
    handle.classList.toggle('armed', !!sim.controls.speedbrakeArmed);
  } });
  return el;
}

// ------------------------------------------------------------------- flaps
const GATES = new Set([1, 4]);   // detent indices of flaps 1 and 20
const flapToP = (i) => 1 - i / (FLAP_DETENTS.length - 1);

function flapLever(reg) {
  const track = h('div', 'pdl-track pdl-flap-track');
  const handle = h('div', 'pdl-lever pdl-flap', h('div', 'pdl-lever-shaft'), h('div', 'pdl-flap-grip'));
  track.append(handle);
  FLAP_DETENTS.forEach((_, i) => {
    if (GATES.has(i)) { const g = h('span', 'pdl-gate'); g.style.setProperty('--p', flapToP(i)); track.append(g); }
  });
  makeDraggable(handle, track, {
    onStart: () => { drag.flap = { start: Math.round(reg.sim.controls.flapLever) }; },
    onMove: (p) => {
      const n = FLAP_DETENTS.length - 1;
      let target = clamp(Math.round((1 - p) * n), 0, n);
      const start = drag.flap.start;
      // gates: the lever stops at 1 and 20; release and drag again to pass
      if (target !== start) {
        const dir = Math.sign(target - start);
        for (let i = start + dir; i !== target; i += dir) if (GATES.has(i)) { target = i; break; }
      }
      reg.sim.controls.flapLever = target;
      reg.update();
    },
    onEnd: () => { drag.flap = null; },
  });
  // click on a detent label moves the lever one detent toward it
  const marks = scale(FLAP_DETENTS.map((d, i) => [flapToP(i), d === 0 ? 'UP' : String(d), GATES.has(i) ? 'gate' : '']));
  marks.addEventListener('click', (e) => {
    const m = e.target.closest('.pdl-mark'); if (!m) return;
    const i = [...marks.children].indexOf(m);
    const c = reg.sim.controls;
    c.flapLever = clamp(Math.round(c.flapLever) + Math.sign(i - Math.round(c.flapLever)), 0, FLAP_DETENTS.length - 1);
    reg.update();
  });
  const el = h('div', 'pdl-flapwrap', h('div', 'pdl-cap', 'FLAPS'), h('div', 'pdl-lever-wrap', track, marks));
  let last = -1;
  reg.add({ el, update(sim) {
    const i = clamp(Math.round(sim.controls.flapLever || 0), 0, FLAP_DETENTS.length - 1);
    if (i === last) return; last = i; setP(handle, flapToP(i));
    [...marks.children].forEach((m, j) => m.classList.toggle('sel', j === i));
  } });
  return el;
}

// -------------------------------------------------------- forward panel
function gearPanel(reg) {
  const lever = h('button', 'pdl-gear', h('span', 'pdl-gear-slot'), h('span', 'pdl-gear-handle', h('span', 'pdl-gear-wheel')));
  lever.type = 'button';
  lever.setAttribute('aria-label', 'Landing gear lever');
  lever.addEventListener('click', () => {
    const s = reg.sim, c = s.controls;
    if (c.gearLever === 'DOWN') { if (s.ac.onGround) { toast(s, 'Gear lever locked on the ground'); return; } c.gearLever = 'UP'; }
    else c.gearLever = 'DOWN';
    reg.update();
  });
  const ind = h('div', 'pdl-gearind', ['L', 'N', 'R'].map((k) => h('span', 'pdl-gbox', k === 'N' ? 'NOSE' : k)));
  const boxes = [...ind.children];
  const el = h('div', 'pdl-fwd-cell', h('div', 'pdl-cap', 'LANDING GEAR'),
    h('div', 'pdl-gear-row', h('div', 'pdl-gear-lab', h('span', '', 'UP'), h('span', '', 'DN')), lever, ind));
  let last = '';
  reg.add({ el, update(sim) {
    const g = sim.surfaces.gear ?? 1, lv = sim.controls.gearLever;
    const state = g > 0.995 ? 'down' : g < 0.005 ? 'up' : 'transit';
    const key = lv + state;
    if (key === last) return; last = key;
    lever.classList.toggle('up', lv === 'UP');
    boxes.forEach((b, i) => {
      b.className = 'pdl-gbox ' + state;
      b.textContent = state === 'down' ? 'DOWN' : state === 'up' ? 'UP' : '';
      if (i === 1 && state !== 'transit') b.textContent = state === 'down' ? 'DOWN' : 'UP';
    });
  } });
  return el;
}

function autobrakePanel(reg) {
  const labels = { RTO: 'RTO', OFF: 'OFF', DISARM: 'DISARM', MAX: 'MAX AUTO' };
  const positions = AUTOBRAKE_SETTINGS.map((v) => ({ v, label: labels[v] || v }));
  return h('div', 'pdl-fwd-cell', h('div', 'pdl-cap', 'AUTOBRAKE'),
    knob(reg, { label: '', positions, span: 250, radius: 48, size: [150, 124],
      get: (s) => s.controls.autobrake,
      set: (s, v) => {
        if (v === 'RTO' && !s.ac.onGround) return;
        s.controls.autobrake = v;
        if (s.systems.autobrake) s.systems.autobrake.disarmReason = '';
      },
      lights: [{ text: 'AUTOBRAKE', color: 'amber', on: (s) => s.controls.autobrake === 'DISARM' }] }));
}

function readouts(reg) {
  return h('div', 'pdl-fwd-cell pdl-readouts', h('div', 'pdl-cap', 'STAB · FLAPS'),
    lcd(reg, { label: 'STAB', value: (s) => fmt(s.surfaces.stabUnits, 1) }),
    lcd(reg, { label: 'FLAPS', value: (s) => `${fmt(s.surfaces.flapsDeg)}→${FLAP_DETENTS[Math.round(s.controls.flapLever)] ?? '-'}` }),
    lcd(reg, { label: 'SPD BRK', value: (s) => `${fmt((s.surfaces.speedbrake || 0) * 100)}%` }),
    lcd(reg, { label: 'BRAKES', value: (s) => `${fmt(Math.max(s.controls.brakeL, s.controls.brakeR) * 100)}%` }));
}

// ----------------------------------------------------------- master lights
function masterLights(reg, side) {
  const mk = (kind) => {
    const b = h('button', `pdl-master ${kind}`, h('span', '', 'MASTER'), h('span', '', kind === 'warn' ? 'WARNING' : 'CAUTION'));
    b.type = 'button';
    b.addEventListener('click', () => { resetMaster(reg.sim, kind === 'warn' ? 'warning' : 'caution'); reg.update(); });
    return b;
  };
  const w = mk('warn'), c = mk('caut');
  const el = h('div', 'pdl-masters ' + side, w, c);
  let last = '';
  reg.add({ el, update(sim) {
    const a = sim.alerts || {};
    const key = `${!!a.masterWarning}${!!a.masterCaution}`;
    if (key === last) return; last = key;
    w.classList.toggle('lit', !!a.masterWarning);
    c.classList.toggle('lit', !!a.masterCaution);
  } });
  return el;
}

// ---------------------------------------------------------------- aft panel
function fuelControl(reg) {
  const sw = (i) => {
    const b = h('button', 'pdl-fcs', h('span', 'pdl-fcs-fire', 'FIRE'), h('span', 'pdl-fcs-lever'), h('span', 'pdl-fcs-lab', i ? 'R' : 'L'));
    b.type = 'button';
    b.setAttribute('aria-label', `Fuel control switch ${i ? 'R' : 'L'}`);
    b.addEventListener('click', () => {
      const c = reg.sim.controls;
      c.fuelControl[i] = c.fuelControl[i] === 'RUN' ? 'CUTOFF' : 'RUN';
      reg.update();
    });
    return b;
  };
  const sws = [sw(0), sw(1)];
  const el = h('div', 'pdl-aft-cell', h('div', 'pdl-cap', 'FUEL CONTROL'),
    h('div', 'pdl-fcs-row', h('div', 'pdl-fcs-legend', h('span', '', 'RUN'), h('span', '', 'CUTOFF')), sws[0], sws[1]));
  let last = '';
  reg.add({ el, update(sim) {
    const key = sim.controls.fuelControl.join() + sim.engines.map((e) => !!e.fire).join();
    if (key === last) return; last = key;
    sws.forEach((b, i) => {
      b.classList.toggle('run', sim.controls.fuelControl[i] === 'RUN');
      b.querySelector('.pdl-fcs-fire').classList.toggle('lit', !!sim.engines[i].fire);
    });
  } });
  return el;
}

function stabCutout(reg) {
  const sw = (i) => {
    const guard = h('span', 'pdl-guard');
    const b = h('button', 'pdl-gsw', h('span', 'pdl-gsw-lever'), guard);
    b.type = 'button';
    let open = false;
    b.addEventListener('click', () => {
      const s = reg.sim.systems;
      if (!open && !s.stabCutout[i]) { open = true; b.classList.add('open'); return; }
      s.stabCutout[i] = !s.stabCutout[i];
      if (!s.stabCutout[i]) { open = false; b.classList.remove('open'); }
      reg.update();
    });
    return { b, wrap: h('div', 'ow-ctl', b, h('div', 'ow-ctl-label', i ? 'R' : 'C')) };
  };
  const s = [sw(0), sw(1)];
  const el = h('div', 'pdl-aft-cell', h('div', 'pdl-cap', 'STAB'), h('div', 'pdl-row', s[0].wrap, s[1].wrap), h('div', 'pdl-sub', 'NORM · CUTOUT'));
  let last = '';
  reg.add({ el, update(sim) {
    const key = sim.systems.stabCutout.join();
    if (key === last) return; last = key;
    s.forEach((x, i) => x.b.classList.toggle('cut', !!sim.systems.stabCutout[i]));
  } });
  return el;
}

function fireHandles(reg) {
  const f = (s) => s.systems.fire;
  const handle = (label, i) => {
    const b = h('button', 'pdl-fire', h('span', 'pdl-fire-t', label));
    b.type = 'button';
    b.title = 'Click: pull · click again: discharge bottle · right-click: stow';
    b.addEventListener('click', () => {
      const fi = f(reg.sim);
      if (i === 'apu') { fi.apuHandle = !fi.apuHandle; if (fi.apuHandle) reg.sim.systems.apu.selector = 'OFF'; }
      else if (!fi.handle[i]) fi.handle[i] = true;
      else if (!fi.discharged[i]) { fi.discharged[i] = true; toast(reg.sim, `ENG ${i ? 'R' : 'L'} fire bottle discharged`); }
      reg.update();
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const fi = f(reg.sim);
      if (i === 'apu') fi.apuHandle = false; else fi.handle[i] = false;
      reg.update();
    });
    return b;
  };
  const hs = [handle('ENG L', 0), handle('APU', 'apu'), handle('ENG R', 1)];
  const el = h('div', 'pdl-aft-cell', h('div', 'pdl-cap', 'FIRE'), h('div', 'pdl-row', hs));
  let last = '';
  reg.add({ el, update(sim) {
    const fi = f(sim);
    const key = [fi.handle.join(), fi.discharged.join(), fi.apuHandle, sim.engines.map((e) => !!e.fire).join()].join('|');
    if (key === last) return; last = key;
    [0, 2].forEach((k, j) => {
      hs[k].classList.toggle('pulled', !!fi.handle[j]);
      hs[k].classList.toggle('disch', !!fi.discharged[j]);
      hs[k].classList.toggle('lit', !!sim.engines[j].fire);
    });
    hs[1].classList.toggle('pulled', !!fi.apuHandle);
  } });
  return el;
}

function transponder(reg) {
  const x = (s) => s.systems.xpdr;
  const digits = [0, 1, 2, 3].map((d) => {
    const b = h('button', 'pdl-xd', '0');
    b.type = 'button';
    const bump = (dir) => {
      const code = (x(reg.sim).code || '2000').padStart(4, '0').split('');
      code[d] = String((+code[d] + dir + 8) % 8);
      x(reg.sim).code = code.join('');
      reg.update();
    };
    b.addEventListener('click', () => bump(1));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); bump(-1); });
    b.addEventListener('wheel', (e) => { e.preventDefault(); bump(e.deltaY > 0 ? -1 : 1); }, { passive: false });
    return b;
  });
  const ident = pushButton(reg, { label: 'IDENT', top: { text: 'ID', color: 'white', on: (s) => x(s).ident },
    click: (s) => { x(s).ident = true; x(s).identTimer = 0; } });
  const modes = ['STBY', 'XPNDR', 'TA ONLY', 'TA/RA'].map((m) => ({ v: m, label: m }));
  const el = h('div', 'pdl-aft-cell pdl-xpdr', h('div', 'pdl-cap', 'TRANSPONDER'),
    h('div', 'pdl-row', h('div', 'pdl-xcode', digits),
      knob(reg, { label: 'MODE', positions: modes, span: 160, radius: 40, size: [124, 92], get: (s) => x(s).mode, set: (s, v) => { x(s).mode = v; } }), ident));
  let last = '';
  reg.add({ el, update(sim) {
    const c = (x(sim).code || '2000').padStart(4, '0');
    if (c === last) return; last = c;
    digits.forEach((b, i) => { b.textContent = c[i]; });
  } });
  return el;
}

function rudderTrim(reg) {
  const ind = h('span', 'pdl-rt-ind');
  const bar = h('div', 'pdl-rt-scale', ind);
  const btn = (txt, d) => {
    const b = h('button', 'pdl-rt-btn', txt); b.type = 'button';
    b.addEventListener('click', () => { const c = reg.sim.controls; c.rudderTrim = clamp((c.rudderTrim || 0) + d, -1, 1); reg.update(); });
    return b;
  };
  const center = h('button', 'pdl-rt-btn', 'CTR'); center.type = 'button';
  center.addEventListener('click', () => { reg.sim.controls.rudderTrim = 0; reg.update(); });
  const el = h('div', 'pdl-aft-cell', h('div', 'pdl-cap', 'RUDDER TRIM'), bar, h('div', 'pdl-row tight', btn('◀ L', -0.05), center, btn('R ▶', 0.05)));
  let last = null;
  reg.add({ el, update(sim) {
    const v = sim.controls.rudderTrim || 0;
    if (v === last) return; last = v;
    ind.style.left = `${50 + v * 46}%`;
  } });
  return el;
}

function parkingBrake(reg) {
  const b = h('button', 'pdl-park', h('span', 'pdl-park-handle', 'PARK'), h('span', 'pdl-park-lab', 'PARKING BRAKE'));
  b.type = 'button';
  b.addEventListener('click', () => { reg.sim.controls.parkingBrake = !reg.sim.controls.parkingBrake; reg.update(); });
  const el = h('div', 'pdl-parkwrap', b, lamp(reg, { text: 'SET', color: 'amber', on: (s) => s.controls.parkingBrake }));
  let last = null;
  reg.add({ el, update(sim) {
    const v = !!sim.controls.parkingBrake;
    if (v === last) return; last = v;
    b.classList.toggle('set', v);
  } });
  return el;
}

// --------------------------------------------------------------- public API
/** Build the pedestal inside `el` (#drawer-pedestal). */
export function initPedestal(sim, el) {
  if (!el) return;
  REG = createRegistry(sim);
  HOST = el;
  el.classList.add('pdl-host');
  el.replaceChildren();
  const root = h('div', 'pdl',
    h('div', 'pdl-glare', masterLights(REG, 'capt'), h('div', 'pdl-glare-title', 'CONTROL STAND'), masterLights(REG, 'fo')),
    h('div', 'pdl-body',
      h('div', 'pdl-fwd', gearPanel(REG), autobrakePanel(REG), readouts(REG)),
      h('div', 'pdl-stand',
        h('div', 'pdl-stand-left', parkingBrake(REG), speedbrake(REG)),
        thrustQuadrant(REG),
        flapLever(REG)),
      h('div', 'pdl-aft', fuelControl(REG), stabCutout(REG), fireHandles(REG), transponder(REG), rudderTrim(REG)),
    ));
  el.append(root);
  REG.update();
}

/** Refresh lever positions & lights (call once per frame). */
export function updatePedestal(sim) {
  if (!REG) return;
  if (HOST && HOST.id === 'drawer-pedestal' && !HOST.classList.contains('open') && !drag.thr) return;
  REG.sim = sim;
  REG.update();
}
