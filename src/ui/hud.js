// Compact readout for the external views + toast messages (Team B).
// #hud is visible when the panel is not (chase/flyby/tower, or cockpit with V).

import { FLAP_DETENTS } from '../core/state.js';

const KT = 0.514444, FT = 0.3048, FPM = FT / 60, RAD = 180 / Math.PI;
let els = null, last = 0, toastTimer = null;

const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '---');

export function initHud(sim, hudEl, toastEl) {
  hudEl.innerHTML = `
    <div class="hud-cell"><span>IAS</span><b data-k="ias"></b><i data-k="gs"></i></div>
    <div class="hud-cell"><span>ALT</span><b data-k="alt"></b><i data-k="vs"></i></div>
    <div class="hud-cell"><span>HDG</span><b data-k="hdg"></b><i data-k="trk"></i></div>
    <div class="hud-cell"><span>N1</span><b data-k="n1"></b><i data-k="thr"></i></div>
    <div class="hud-cell"><span>FLAPS</span><b data-k="flaps"></b><i data-k="gear"></i></div>
    <div class="hud-fma"><b data-k="at"></b><b data-k="roll"></b><b data-k="pitch"></b><b data-k="ap"></b></div>
    <div class="hud-flags" data-k="flags"></div>`;
  els = {};
  hudEl.querySelectorAll('[data-k]').forEach((e) => { els[e.dataset.k] = e; });
  sim.events.on('toast', (d) => showToast(toastEl, d?.text ?? String(d ?? '')));
}

export function showToast(toastEl, text, ms = 2600) {
  if (!toastEl || !text) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

export function updateHud(sim) {
  if (!els) return;
  const now = performance.now();
  if (now - last < 100) return; // 10 Hz is plenty for text
  last = now;
  const ac = sim.ac, e = sim.engines || [], s = sim.surfaces || {}, ap = sim.ap || {};
  els.ias.textContent = fmt((ac.cas || 0) / KT);
  els.gs.textContent = `GS ${fmt((ac.gs || 0) / KT)}`;
  els.alt.textContent = fmt((ac.altMSL || 0) / FT);
  const vs = (ac.vs || 0) / FPM;
  els.vs.textContent = `${vs >= 0 ? '+' : ''}${fmt(Math.round(vs / 50) * 50)} FPM`;
  const hdg = (((ac.euler?.heading || 0) - (ac.magVar || 0)) * RAD + 360) % 360;
  els.hdg.textContent = String(Math.round(hdg) % 360 || 360).padStart(3, '0');
  els.trk.textContent = 'MAG';
  els.n1.textContent = e.length ? e.map((x) => fmt(x.n1, 1)).join(' ') : '---';
  const thr = sim.controls?.throttle || [];
  els.thr.textContent = `TLA ${thr.map((t) => fmt((t || 0) * 100)).join('/')}%`;
  const fl = Number.isFinite(s.flapsDeg) ? Math.round(s.flapsDeg) : FLAP_DETENTS[sim.controls?.flapLever || 0];
  els.flaps.textContent = fl === 0 ? 'UP' : String(fl);
  const g = s.gear ?? 1;
  els.gear.textContent = g > 0.99 ? 'GEAR DN' : g < 0.01 ? 'GEAR UP' : 'GEAR TRANSIT';
  els.gear.classList.toggle('warn', g > 0.01 && g < 0.99);
  const m = ap.modes || {};
  els.at.textContent = m.at || '';
  els.roll.textContent = m.roll || '';
  els.pitch.textContent = m.pitch || '';
  els.ap.textContent = ap.apEngaged ? 'A/P' : (ap.fdL ? 'FD' : '');
  const flags = [];
  if (sim.paused) flags.push('PAUSED');
  if (sim.simRate > 1) flags.push(`SIM ×${sim.simRate}`);
  if (sim.controls?.parkingBrake) flags.push('PARK BRK');
  if (s.speedbrake > 0.05) flags.push('SPDBRK');
  if (s.reverser?.some?.((r) => r > 0.1)) flags.push('REV');
  if (sim.alerts?.masterWarning) flags.push('<em class="red">WARNING</em>');
  else if (sim.alerts?.masterCaution) flags.push('<em class="amber">CAUTION</em>');
  if (ac.crashed) flags.push(`<em class="red">CRASH ${String(ac.crashReason || '').replace(/[<>&]/g, '')}</em>`);
  const html = flags.map((f) => (f.startsWith('<') ? f : `<span>${f}</span>`)).join('');
  if (els.flags._h !== html) { els.flags.innerHTML = html; els.flags._h = html; }
}
