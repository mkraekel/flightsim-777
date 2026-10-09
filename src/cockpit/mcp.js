// Boeing 777 Mode Control Panel (Team D1). Renders inside #mcp and drives the AFDS via afdsAction.
//
// Left to right: A/P (L) · F/D (L) · A/T ARM L/R · CLB/CON · A/T · IAS/MACH window + selector + knob ·
// LNAV · VNAV · FLCH · A/P DISENGAGE bar · HDG/TRK switch + window + knob (BANK LIMIT ring) + HOLD ·
// V/S FPA switch + window + thumbwheel + V/S · ALT window + knob (AUTO/1000 ring) + HOLD · LOC · APP ·
// A/P (R) · F/D (R).
//
// Knobs: mouse wheel (Shift = ×10), vertical drag, click = push. Keyboard: focus a knob and use
// ArrowUp/ArrowDown (+Shift), Enter/Space to push. The panel is laid out at a fixed design size and
// scaled to fit its host box.

import { afdsAction } from '../systems/afds.js';

const DESIGN_W = 1240, DESIGN_H = 150;

const h = (tag, cls, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of [].concat(kids)) if (k) e.appendChild(k);
  return e;
};

let state = null; // { sim, el, panel, refs, cache, ro }

export function initMCP(sim, el) {
  if (!el) return;
  el.classList.add('mcp-host');
  el.innerHTML = '';
  const refs = {};
  const act = (a, v) => () => { afdsAction(sim, a, v); updateMCP(sim, true); };

  // ---------- building blocks ----------
  const button = (key, legend, action, opts = {}) => {
    const b = h('button', 'mcp-btn' + (opts.cls ? ' ' + opts.cls : ''), { type: 'button', 'aria-label': opts.aria || legend.replace('\n', ' '), 'aria-pressed': 'false', onclick: act(action, opts.value) },
      [h('span', 'mcp-bar'), opts.cap ? h('span', 'mcp-btn-legend', { text: opts.cap }) : null]);
    refs[key] = b; return b;
  };
  const toggle = (key, top, bottom, action, value, aria) => {
    const t = h('button', 'mcp-toggle', { type: 'button', 'aria-label': aria, 'aria-pressed': 'true', onclick: act(action, value) },
      [h('span', 'mcp-toggle-top', { text: top }), h('span', 'mcp-toggle-slot', {}, [h('span', 'mcp-toggle-bat')]), h('span', 'mcp-toggle-bot', { text: bottom })]);
    refs[key] = t; return t;
  };
  const legend = (text, cls = '') => h('div', 'mcp-legend ' + cls, { text });
  const windowLcd = (key, labelKey) => {
    const w = h('div', 'mcp-window', { role: 'status', 'aria-live': 'off' }, [
      labelKey ? (refs[labelKey] = h('span', 'mcp-window-label')) : null,
      (refs[key] = h('span', 'mcp-window-digits')),
    ]);
    return w;
  };
  const knob = (key, aria, onTurn, onPush, ring) => {
    const cap = h('span', 'mcp-knob-cap', {}, [h('span', 'mcp-knob-mark')]);
    const k = h('div', 'mcp-knob', { tabindex: '0', role: 'slider', 'aria-label': aria }, [cap]);
    let angle = 0;
    const turn = (clicks) => { angle += clicks * 12; cap.style.transform = `rotate(${angle}deg)`; onTurn(clicks); updateMCP(sim, true); };
    k.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); turn((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1)); }, { passive: false });
    let drag = null;
    k.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { y: e.clientY, acc: 0, moved: false }; k.setPointerCapture(e.pointerId); e.preventDefault(); k.focus({ preventScroll: true }); });
    k.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = drag.y - e.clientY; drag.y = e.clientY; drag.acc += dy;
      while (Math.abs(drag.acc) >= 6) { const s = Math.sign(drag.acc); drag.acc -= s * 6; drag.moved = true; turn(s * (e.shiftKey ? 10 : 1)); }
    });
    const end = () => { if (drag && !drag.moved && onPush) { onPush(); updateMCP(sim, true); k.classList.add('pushed'); setTimeout(() => k.classList.remove('pushed'), 140); } drag = null; };
    k.addEventListener('pointerup', end);
    k.addEventListener('pointercancel', () => { drag = null; });
    k.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { turn(e.shiftKey ? 10 : 1); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { turn(e.shiftKey ? -10 : -1); }
      else if ((e.key === 'Enter' || e.key === ' ') && onPush) { onPush(); updateMCP(sim, true); }
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    refs[key] = k;
    if (!ring) return k;
    // outer selector ring (bank limit / altitude increment)
    const r = h('div', 'mcp-ring', { tabindex: '0', role: 'button', 'aria-label': ring.aria }, [h('span', 'mcp-ring-pointer'), k]);
    r.addEventListener('wheel', (e) => { if (e.target !== r) return; e.preventDefault(); e.stopPropagation(); ring.step(e.deltaY < 0 ? 1 : -1); updateMCP(sim, true); }, { passive: false });
    r.addEventListener('click', (e) => { if (e.target !== r && !e.target.classList.contains('mcp-ring-pointer')) return; ring.step(1); updateMCP(sim, true); });
    r.addEventListener('keydown', (e) => { if (e.target !== r) return; if (e.key === 'Enter' || e.key === ' ') { ring.step(1); updateMCP(sim, true); e.preventDefault(); e.stopPropagation(); } });
    refs[key + 'Ring'] = r;
    return h('div', 'mcp-knob-wrap', {}, [r, (refs[key + 'RingLbl'] = h('div', 'mcp-ring-labels'))]);
  };
  const thumbwheel = (key, aria, onTurn) => {
    const ridges = h('span', 'mcp-wheel-ridges');
    const w = h('div', 'mcp-thumbwheel', { tabindex: '0', role: 'slider', 'aria-label': aria }, [h('span', 'mcp-wheel-legend top', { text: 'UP' }), h('span', 'mcp-wheel-body', {}, [ridges]), h('span', 'mcp-wheel-legend bot', { text: 'DN' })]);
    let off = 0;
    const turn = (c) => { off += c * 4; ridges.style.backgroundPositionY = `${off}px`; onTurn(c); updateMCP(sim, true); };
    w.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); turn((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 5 : 1)); }, { passive: false });
    let drag = null;
    w.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, acc: 0 }; w.setPointerCapture(e.pointerId); e.preventDefault(); w.focus({ preventScroll: true }); });
    w.addEventListener('pointermove', (e) => { if (!drag) return; drag.acc += drag.y - e.clientY; drag.y = e.clientY; while (Math.abs(drag.acc) >= 7) { const s = Math.sign(drag.acc); drag.acc -= s * 7; turn(s); } });
    w.addEventListener('pointerup', () => { drag = null; });
    w.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') turn(e.shiftKey ? 5 : 1); else if (e.key === 'ArrowDown') turn(e.shiftKey ? -5 : -1); else return;
      e.preventDefault(); e.stopPropagation();
    });
    refs[key] = w; return w;
  };
  const sec = (cls, kids) => h('div', 'mcp-sec ' + cls, {}, kids);
  const screw = (pos) => h('span', 'mcp-screw ' + pos);

  // ---------- panel ----------
  const BANKS = [0, 5, 10, 15, 20, 25];
  const panel = h('div', 'mcp-panel', { role: 'group', 'aria-label': 'Mode control panel' }, [
    screw('tl'), screw('tr'), screw('bl'), screw('br'),
    sec('mcp-ap', [legend('A/P'), button('apL', 'A/P', 'AP_ENGAGE', { cls: 'mcp-btn-ap', aria: 'Autopilot engage left' })]),
    sec('mcp-fd', [legend('F/D'), toggle('fdL', 'ON', 'OFF', 'FD_L', undefined, 'Flight director left')]),
    sec('mcp-atarm', [legend('A/T ARM'), h('div', 'mcp-row', {}, [
      h('div', 'mcp-col', {}, [toggle('atL', 'L', 'OFF', 'AT_ARM', 'L', 'Autothrottle arm left')]),
      h('div', 'mcp-col', {}, [toggle('atR', 'R', 'OFF', 'AT_ARM', 'R', 'Autothrottle arm right')]),
    ])]),
    sec('mcp-thr', [h('div', 'mcp-col gap', {}, [
      h('div', 'mcp-col', {}, [legend('CLB/CON'), button('clbcon', 'CLB/CON', 'CLB_CON', { cls: 'mcp-btn-sm' })]),
      h('div', 'mcp-col', {}, [legend('A/T'), button('at', 'A/T', 'AT', { cls: 'mcp-btn-sm' })]),
    ])]),
    sec('mcp-spd', [legend('IAS/MACH', 'wide'), windowLcd('spd', 'spdLbl'), h('div', 'mcp-row ctrls', {}, [
      h('div', 'mcp-col', {}, [legend('IAS\nMACH', 'tight'), button('iasmach', 'IAS/MACH', 'IAS_MACH', { cls: 'mcp-btn-xs mcp-btn-nolight', aria: 'IAS/MACH selector' })]),
      knob('spdKnob', 'Speed selector, push for speed intervention / IAS-MACH', (c) => afdsAction(sim, 'SPD_INC', c), () => afdsAction(sim, 'SPD_INTV')),
    ])]),
    sec('mcp-nav', [h('div', 'mcp-grid2', {}, [
      h('div', 'mcp-col', {}, [legend('LNAV'), button('lnav', 'LNAV', 'LNAV')]),
      h('div', 'mcp-col', {}, [legend('VNAV'), button('vnav', 'VNAV', 'VNAV')]),
      h('div', 'mcp-col', {}, [legend('FLCH'), button('flch', 'FLCH', 'FLCH')]),
    ])]),
    sec('mcp-disc', [legend('A/P\nDISENGAGE', 'tight'), (refs.discBar = h('button', 'mcp-discbar', { type: 'button', 'aria-label': 'A/P disengage bar', 'aria-pressed': 'false', onclick: act('AP_DISENGAGE_BAR') }, [h('span', 'mcp-discbar-grip')]))]),
    sec('mcp-hdg', [h('div', 'mcp-row top', {}, [legend('HDG'), button('hdgtrk', '', 'HDG_TRK', { cls: 'mcp-btn-switch mcp-btn-nolight', aria: 'HDG/TRK reference switch' }), legend('TRK')]),
      windowLcd('hdg', 'hdgLbl'),
      h('div', 'mcp-row ctrls', {}, [
        knob('hdgKnob', 'Heading/track selector, push for HDG/TRK SEL', (c) => afdsAction(sim, 'HDG_INC', c), () => afdsAction(sim, 'HDG_SEL'), {
          aria: 'Bank limit selector', step: (d) => {
            const i = BANKS.indexOf(sim.ap.sel.bankLimitDeg); afdsAction(sim, 'BANK_LIMIT', BANKS[(i + d + BANKS.length) % BANKS.length]);
          } }),
        h('div', 'mcp-col', {}, [legend('HOLD'), button('hdghold', 'HOLD', 'HDG_HOLD', { cls: 'mcp-btn-sm', aria: 'Heading hold' })]),
      ])]),
    sec('mcp-vs', [h('div', 'mcp-row top', {}, [legend('V/S'), button('vsfpa', '', 'VS_FPA', { cls: 'mcp-btn-switch mcp-btn-nolight', aria: 'V/S-FPA reference switch' }), legend('FPA')]),
      windowLcd('vs', 'vsLbl'),
      h('div', 'mcp-row ctrls', {}, [
        thumbwheel('vsWheel', 'Vertical speed thumbwheel', (c) => afdsAction(sim, 'VS_INC', c)),
        h('div', 'mcp-col', {}, [legend('V/S\nFPA', 'tight'), button('vsBtn', 'V/S', 'VS', { cls: 'mcp-btn-sm', aria: 'Vertical speed mode' })]),
      ])]),
    sec('mcp-alt', [legend('ALTITUDE', 'wide'), windowLcd('alt'), h('div', 'mcp-row ctrls', {}, [
      knob('altKnob', 'Altitude selector, push for altitude intervention', (c) => afdsAction(sim, 'ALT_INC', c), () => afdsAction(sim, 'ALT_INTV'), {
        aria: 'Altitude increment AUTO / 1000', step: () => afdsAction(sim, 'ALT_INCR_MODE') }),
      h('div', 'mcp-col', {}, [legend('HOLD'), button('althold', 'HOLD', 'ALT_HOLD', { cls: 'mcp-btn-sm', aria: 'Altitude hold' })]),
    ])]),
    sec('mcp-app', [h('div', 'mcp-col gap', {}, [
      h('div', 'mcp-col', {}, [legend('LOC'), button('loc', 'LOC', 'LOC', { cls: 'mcp-btn-sm' })]),
      h('div', 'mcp-col', {}, [legend('APP'), button('app', 'APP', 'APP', { cls: 'mcp-btn-sm' })]),
    ])]),
    sec('mcp-ap', [legend('A/P'), button('apR', 'A/P', 'AP_ENGAGE', { cls: 'mcp-btn-ap', aria: 'Autopilot engage right' })]),
    sec('mcp-fd', [legend('F/D'), toggle('fdR', 'ON', 'OFF', 'FD_R', undefined, 'Flight director right')]),
  ]);
  el.appendChild(panel);

  // ring labels
  refs.hdgKnobRingLbl.innerHTML = '<span>BANK LIMIT</span><b data-v="0">AUTO</b><b data-v="5">5</b><b data-v="10">10</b><b data-v="15">15</b><b data-v="20">20</b><b data-v="25">25</b>';
  refs.altKnobRingLbl.innerHTML = '<b data-v="auto">AUTO</b><b data-v="1000">1000</b>';

  const fit = () => {
    const w = el.clientWidth || DESIGN_W, hh = el.clientHeight || DESIGN_H;
    const s = Math.min(w / DESIGN_W, hh / DESIGN_H);
    // A host wider than the design aspect (the usual glareshield slot) stretches the panel
    // horizontally (sections spread out, like the long real MCP) instead of leaving empty bands.
    const dw = Math.min(w / s, DESIGN_W * 1.8);
    panel.style.width = `${Math.max(DESIGN_W, Math.floor(dw))}px`;
    panel.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(el);
  fit();
  state = { sim, el, panel, refs, cache: {}, ro };
  updateMCP(sim, true);
}

const setText = (cache, key, node, text) => { if (cache[key] !== text) { cache[key] = text; node.textContent = text; } };
const setOn = (cache, key, node, on, cls = 'on') => {
  if (cache[key] !== on) { cache[key] = on; node.classList.toggle(cls, on); if (node.hasAttribute('aria-pressed')) node.setAttribute('aria-pressed', String(on)); }
};

export function updateMCP(sim, force = false) {
  if (!state || !state.refs) return;
  const { refs: r, cache: c } = state;
  if (force) { /* fall through; cache prevents redundant DOM writes */ }
  const ap = sim.ap, m = ap.modes, sel = ap.sel;
  // windows
  let spd = '';
  if (!ap.spdWindowBlank) spd = sel.useMach ? '.' + String(Math.round((sel.mach || 0) * 1000)).padStart(3, '0') : String(Math.round(sel.spdKt || 0));
  setText(c, 'spd', r.spd, spd);
  setText(c, 'spdLbl', r.spdLbl, ap.spdWindowBlank ? '' : sel.useMach ? 'MACH' : 'IAS');
  setText(c, 'hdg', r.hdg, String(Math.round(sel.hdgDeg || 0) % 360 || 360).padStart(3, '0'));
  setText(c, 'hdgLbl', r.hdgLbl, sel.hdgIsTrk ? 'TRK' : 'HDG');
  let vs = '';
  if (ap.vsWindowOpen) {
    if (sel.vsIsFpa) { const v = sel.fpaDeg || 0; vs = (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(1); }
    else { const v = Math.round(sel.vsFpm || 0); vs = v === 0 ? '0' : (v > 0 ? '+' : '-') + String(Math.abs(v)); }
  }
  setText(c, 'vs', r.vs, vs);
  setText(c, 'vsLbl', r.vsLbl, ap.vsWindowOpen ? (sel.vsIsFpa ? 'FPA' : 'V/S') : '');
  setText(c, 'alt', r.alt, String(Math.round(sel.altFt || 0)));
  // switch positions
  setOn(c, 'fdL', r.fdL, !!ap.fdL); setOn(c, 'fdR', r.fdR, !!ap.fdR);
  setOn(c, 'atL', r.atL, ap.atArmL !== false && !!ap.atArm); setOn(c, 'atR', r.atR, ap.atArmR !== false && !!ap.atArm);
  setOn(c, 'hdgtrk', r.hdgtrk, !!sel.hdgIsTrk, 'flipped');
  setOn(c, 'vsfpa', r.vsfpa, !!sel.vsIsFpa, 'flipped');
  setOn(c, 'disc', r.discBar, !!ap.disengageBar, 'down');
  // mode lights
  setOn(c, 'apL', r.apL, !!ap.apEngaged); setOn(c, 'apR', r.apR, !!ap.apEngaged);
  setOn(c, 'at', r.at, !!ap.atEngaged);
  setOn(c, 'clbcon', r.clbcon, false);
  setOn(c, 'lnav', r.lnav, m.roll === 'LNAV' || m.armedRoll === 'LNAV');
  setOn(c, 'vnav', r.vnav, m.pitch.startsWith('VNAV') || m.armedPitch === 'VNAV');
  setOn(c, 'flch', r.flch, m.pitch === 'FLCH SPD');
  setOn(c, 'hdghold', r.hdghold, m.roll === 'HDG HOLD' || m.roll === 'TRK HOLD');
  setOn(c, 'vsBtn', r.vsBtn, m.pitch === 'V/S' || m.pitch === 'FPA');
  setOn(c, 'althold', r.althold, m.pitch === 'ALT');
  const app = (m.armedPitch === 'G/S' || m.pitch === 'G/S' || m.pitch === 'FLARE' || !!ap.land);
  setOn(c, 'app', r.app, app);
  setOn(c, 'loc', r.loc, !app && (m.roll === 'LOC' || m.armedRoll === 'LOC'));
  // ring selections
  const bank = String(sel.bankLimitDeg || 0);
  if (c.bank !== bank) { c.bank = bank; r.hdgKnobRingLbl.querySelectorAll('b').forEach((b) => b.classList.toggle('sel', b.dataset.v === bank)); r.hdgKnobRing.style.setProperty('--ring-rot', `${[0, 5, 10, 15, 20, 25].indexOf(+bank) * 24 - 60}deg`); }
  const inc = ap.altIncr1000 ? '1000' : 'auto';
  if (c.inc !== inc) { c.inc = inc; r.altKnobRingLbl.querySelectorAll('b').forEach((b) => b.classList.toggle('sel', b.dataset.v === inc)); r.altKnobRing.style.setProperty('--ring-rot', inc === 'auto' ? '-24deg' : '24deg'); }
}
