// Boeing 777 EFIS control panel (captain side, glareshield). Pure DOM + CSS knobs.
// Writes sim.efis.* and sim.env.baroHpa / baroStd. Mouse: click a knob's left/right half to turn it,
// mouse wheel turns it, click the centre to push (RST / STD / CTR / TFC), click outer labels to select.
import { clamp } from '../core/geo.js';

export const ND_RANGES = [10, 20, 40, 80, 160, 320, 640];
const MODES = ['APP', 'VOR', 'MAP', 'PLN'];
const MODE_ANG = [-60, -20, 20, 60];
const RANGE_ANG = [-90, -60, -30, 0, 30, 60, 90];
const OVERLAYS = [['WXR', 'wxr'], ['STA', 'sta'], ['WPT', 'wpt'], ['ARPT', 'arpt'], ['DATA', 'data'], ['POS', 'pos'], ['TERR', 'terr']];

function rotary({ cls, title, labels, centre }) {
  const marks = labels.map(([t, a, k]) => `<button type="button" class="efis-mark" data-k="${k ?? t}" style="--a:${a}deg">${t}</button>`).join('');
  return `<div class="efis-rot ${cls}" title="${title}">
    <div class="efis-scale">${marks}</div>
    <div class="efis-knob" data-role="knob"><div class="efis-ptr"></div>
      <button type="button" class="efis-cap" data-role="push">${centre}</button></div>
    <div class="efis-name">${title}</div></div>`;
}

export function initEfisPanel(sim, el) {
  const ef = sim.efis;
  ef.ctr ??= false; ef.baroIn ??= false; ef.data ??= false; ef.pos ??= false; ef.minsResetT ??= 0;
  const root = document.createElement('div');
  root.className = 'efis';
  root.innerHTML = `
    <div class="efis-grp efis-top">
      ${rotary({ cls: 'mins', title: 'MINS', labels: [['RADIO', -50, 'RADIO'], ['BARO', 50, 'BARO']], centre: 'RST' })}
      <div class="efis-pair">
        <button type="button" class="efis-btn" data-flag="fpv">FPV</button>
        <button type="button" class="efis-btn" data-flag="mtrs">MTRS</button>
      </div>
      ${rotary({ cls: 'baro', title: 'BARO', labels: [['IN', -50, 'IN'], ['HPA', 50, 'HPA']], centre: 'STD' })}
    </div>
    <div class="efis-grp efis-mid">
      ${rotary({ cls: 'mode', title: 'MODE', labels: MODES.map((m, i) => [m, MODE_ANG[i]]), centre: 'CTR' })}
      ${rotary({ cls: 'range', title: 'RANGE', labels: ND_RANGES.map((r, i) => [String(r), RANGE_ANG[i]]), centre: 'TFC' })}
    </div>
    <div class="efis-grp efis-ovl">
      ${OVERLAYS.map(([t, f]) => `<button type="button" class="efis-btn sm" data-flag="${f}">${t}</button>`).join('')}
    </div>`;
  el.appendChild(root);

  const q = (s) => root.querySelector(s);
  const mins = q('.mins'), baro = q('.baro'), mode = q('.mode'), range = q('.range');

  // --- actions ---------------------------------------------------------
  const act = {
    mins(delta) { ef.minimumsFt = clamp(Math.round((ef.minimumsFt || 0) + delta), 0, ef.minsType === 'RADIO' ? 1000 : 15000); },
    baro(delta) {
      const env = sim.env;
      if (ef.baroIn) env.baroHpa = clamp(+((env.baroHpa * 0.02953 + delta * 0.01) / 0.02953).toFixed(3), 940, 1050);
      else env.baroHpa = clamp(Math.round(env.baroHpa) + delta, 940, 1050);
    },
    mode(delta) { const i = clamp(MODES.indexOf(ef.ndMode) + delta, 0, MODES.length - 1); ef.ndMode = MODES[i]; },
    range(delta) {
      let i = ND_RANGES.indexOf(ef.ndRangeNm); if (i < 0) i = 2;
      ef.ndRangeNm = ND_RANGES[clamp(i + delta, 0, ND_RANGES.length - 1)];
    },
  };
  const push = {
    mins() { ef.minsResetT = performance.now(); },
    baro() { sim.env.baroStd = !sim.env.baroStd; },
    mode() { ef.ctr = !ef.ctr; },
    range() { ef.tfc = !ef.tfc; },
  };
  const outer = {
    mins(k) { ef.minsType = k; },
    baro(k) { ef.baroIn = k === 'IN'; },
    mode(k) { ef.ndMode = k; },
    range(k) { ef.ndRangeNm = +k; },
  };
  const step = { mins: (e) => (e.shiftKey ? 100 : 10), baro: () => 1, mode: () => 1, range: () => 1 };

  for (const [name, node] of [['mins', mins], ['baro', baro], ['mode', mode], ['range', range]]) {
    const knob = node.querySelector('[data-role=knob]');
    knob.addEventListener('click', (e) => {
      if (e.target.closest('[data-role=push]')) { push[name](); sync(); return; }
      const r = knob.getBoundingClientRect();
      act[name]((e.clientX < r.left + r.width / 2 ? -1 : 1) * step[name](e)); sync();
    });
    node.addEventListener('wheel', (e) => { e.preventDefault(); act[name]((e.deltaY > 0 ? -1 : 1) * step[name](e)); sync(); }, { passive: false });
    node.querySelectorAll('.efis-mark').forEach((m) => m.addEventListener('click', () => { outer[name](m.dataset.k); sync(); }));
  }
  root.querySelectorAll('[data-flag]').forEach((b) => b.addEventListener('click', () => { ef[b.dataset.flag] = !ef[b.dataset.flag]; sync(); }));

  // --- visual sync ------------------------------------------------------
  const ptr = (node, deg) => node.querySelector('.efis-knob').style.setProperty('--rot', `${deg}deg`);
  let last = '';
  function sync() {
    const key = JSON.stringify([ef.minsType, ef.minimumsFt, ef.baroIn, sim.env.baroStd, sim.env.baroHpa, ef.ndMode, ef.ctr, ef.ndRangeNm, ef.tfc, ...OVERLAYS.map(([, f]) => ef[f]), ef.fpv, ef.mtrs]);
    if (key === last) return;
    last = key;
    ptr(mins, ef.minsType === 'RADIO' ? -50 : 50);
    ptr(baro, ef.baroIn ? -50 : 50);
    ptr(mode, MODE_ANG[Math.max(0, MODES.indexOf(ef.ndMode))]);
    ptr(range, RANGE_ANG[Math.max(0, ND_RANGES.indexOf(ef.ndRangeNm))]);
    for (const [node, k] of [[mins, ef.minsType], [baro, ef.baroIn ? 'IN' : 'HPA'], [mode, ef.ndMode], [range, String(ef.ndRangeNm)]]) {
      node.querySelectorAll('.efis-mark').forEach((m) => m.classList.toggle('sel', m.dataset.k === k));
    }
    q('.baro [data-role=push]').classList.toggle('on', !!sim.env.baroStd);
    q('.mode [data-role=push]').classList.toggle('on', !!ef.ctr);
    q('.range [data-role=push]').classList.toggle('on', !!ef.tfc);
    root.querySelectorAll('[data-flag]').forEach((b) => b.classList.toggle('on', !!ef[b.dataset.flag]));
    mins.title = `MINS ${ef.minsType} ${ef.minimumsFt} ft — click L/R half or wheel to set, outer labels select RADIO/BARO`;
    baro.title = `BARO ${sim.env.baroStd ? 'STD' : ef.baroIn ? (sim.env.baroHpa * 0.02953).toFixed(2) + ' in' : Math.round(sim.env.baroHpa) + ' hPa'} — wheel to set, centre = STD`;
  }
  sync();
  return { update: sync, el: root };
}
