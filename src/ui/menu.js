// Start screen, pause menu and key-binding sheet (Team B). Renders into #menu.
// Pure DOM, no Cesium. Settings (and scenery keys) persist in localStorage (try/catch).

export const MTOW_KG = 351500;
export const OEW_KG = 167800;        // 777-300ER operating empty weight (approx.)
export const MAX_FUEL_KG = 145500;   // 181,280 L usable at 0.803 kg/L
export const MAX_PAYLOAD_KG = 69000;

const LS_KEY = 'b777.settings.v1';
const SS_AUTOSTART = 'b777.autostart';

export const KEY_BINDINGS = [
  ['Flight controls', [
    ['↑ / ↓  ·  mouse yoke', 'Pitch (↓ = pull, nose up)'],
    ['← / →', 'Roll'],
    ['Z / X', 'Rudder · nosewheel below 30 kt'],
    ['Q / E', 'Tiller (on ground)'],
    ['Home / End  ·  Num 1 / 7', 'Pitch trim nose down / up'],
  ]],
  ['Thrust', [
    ['PgUp / PgDn  ·  F3 / F2  ·  Num + / −  ·  Shift+↑/↓', 'Thrust up / down'],
    ['F1 / F4', 'Idle / full'],
    ['F2 hold at idle  ·  R', 'Reverse thrust'],
    ['T', 'TO/GA'],
  ]],
  ['Configuration', [
    ['F7 / F6  ·  ] / [', 'Flaps down / up one detent'],
    ['G', 'Gear lever'],
    ['/  ·  Shift+/', 'Speedbrake cycle · arm'],
    ['.  ·  B (hold)', 'Brakes'],
    ['Shift+.  ·  P', 'Parking brake'],
  ]],
  ['Autoflight', [
    ['A', 'Autopilot engage / disconnect'],
    ['Shift+A', 'Autothrottle arm / disconnect'],
  ]],
  ['Views & panels', [
    ['C', 'Cycle view: cockpit → chase → flyby → tower'],
    ['V', 'Toggle instrument panel (cockpit view)'],
    ['Right-drag · Numpad', 'Look around'],
    ['1 / 2 / 3 / 4', 'Overhead · pedestal · CDU · lower EICAS'],
    ['Esc / Space', 'Menu / pause'],
    ['=', 'Sim rate 1× · 2× · 4×'],
  ]],
  ['Gamepad', [
    ['Left stick · triggers', 'Pitch/roll · rudder'],
    ['Right stick Y', 'Thrust'],
    ['A · B · X / Y · LB', 'Brakes · gear · flaps up / down · AP disc'],
  ]],
];

const DEFAULTS = {
  depIcao: 'EDDF', depRwy: '25C', destIcao: 'EGLL', destRwy: '27R',
  timeOfDayH: 14, windDirDeg: 250, windKt: 8, tempDevC: 0, qnhHpa: 1013, turbulence: 0,
  fuelKg: 45000, payloadKg: 32000, coldDark: false,
  scenery: 'esri', googleKey: '', ionToken: '', quality: 'medium',
};

function load() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) }; } catch (e) { return { ...DEFAULTS }; }
}
function save(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ } }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKg = (kg) => Math.round(kg).toLocaleString('en-US').replace(/,/g, ' ');
const fmtTime = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

function screws() { return '<i class="screw tl"></i><i class="screw tr"></i><i class="screw bl"></i><i class="screw br"></i>'; }

/** One "panel module" of the setup screen. */
function module(title, body, cls = '') {
  return `<section class="mm ${cls}">${screws()}<h3 class="mm__title">${title}</h3><div class="mm__body">${body}</div></section>`;
}

function field(label, control, extra = '', tag = 'label') {
  return `<${tag} class="mf ${extra}"><span class="mf__label">${label}</span>${control}</${tag}>`;
}

function rangeField(id, label, min, max, step, unit) {
  return `<label class="mf mf--range"><span class="mf__label">${label}</span>
    <span class="mf__row"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}">
    <output class="lcd" for="${id}" data-unit="${unit}"></output></span></label>`;
}

export function initMenu(root, { airports, onStart }) {
  const state = load();
  const ui = { root, airports, onStart, state, mode: 'setup', onResume: null, onRestart: null };
  root.innerHTML = `
    <div class="menu-shell">
      <div class="menu-setup" data-screen="setup">
        <header class="menu-head">
          <div class="brand">
            <div class="brand__mark" aria-hidden="true"><span></span></div>
            <div>
              <h1 class="brand__title">777 <b>FLIGHT DECK</b></h1>
              <p class="brand__sub">Boeing 777-300ER · GE90-115B · Fly-by-wire C*U</p>
            </div>
          </div>
          <div class="menu-head__actions">
            <button type="button" class="btn-ghost" data-act="help">KEYS</button>
          </div>
        </header>
        <div class="menu-grid">
          ${module('DEPARTURE', `
            ${field('Airport', '<select id="m-dep"></select>')}
            ${field('Runway', '<select id="m-dep-rwy"></select>')}
            <p class="mm__info" id="m-dep-info"></p>`, 'mm--dep')}
          ${module('ARRIVAL', `
            ${field('Airport', '<select id="m-dest"></select>')}
            ${field('Runway', '<select id="m-dest-rwy"></select>')}
            <p class="mm__info" id="m-dest-info"></p>`, 'mm--dest')}
          ${module('ENVIRONMENT', `
            ${rangeField('m-time', 'Local time', 0, 23.75, 0.25, 'LT')}
            <div class="mf-pair">
              ${rangeField('m-wdir', 'Wind from', 0, 359, 1, '°')}
              ${rangeField('m-wkt', 'Wind', 0, 50, 1, 'KT')}
            </div>
            <div class="mf-pair">
              ${rangeField('m-tdev', 'ISA dev', -30, 30, 1, '°C')}
              ${rangeField('m-qnh', 'QNH', 960, 1050, 1, 'HPA')}
            </div>
            ${field('Turbulence', `<div class="seg" id="m-turb">
              <button type="button" data-v="0">NONE</button><button type="button" data-v="0.25">LIGHT</button>
              <button type="button" data-v="0.5">MOD</button><button type="button" data-v="0.85">SEVERE</button></div>`, '', 'div')}`, 'mm--env')}
          ${module('WEIGHT &amp; BALANCE', `
            ${rangeField('m-fuel', 'Fuel', 5000, MAX_FUEL_KG, 500, 'KG')}
            ${rangeField('m-pay', 'Payload', 0, MAX_PAYLOAD_KG, 500, 'KG')}
            <div class="gw" id="m-gw">
              <div class="gw__row"><span>GROSS WEIGHT</span><b class="lcd" id="m-gw-val"></b></div>
              <div class="gw__bar"><i id="m-gw-fill"></i><em style="left:100%"></em></div>
              <div class="gw__row gw__row--small"><span>OEW ${fmtKg(OEW_KG)}</span><span>MTOW ${fmtKg(MTOW_KG)} KG</span></div>
            </div>`, 'mm--wb')}
          ${module('AIRCRAFT STATE', `
            <div class="choice" id="m-state">
              <button type="button" data-v="ready"><b>READY FOR TAKEOFF</b><span>Engines running, lined up</span></button>
              <button type="button" data-v="cold"><b>COLD &amp; DARK</b><span>Batteries off, full start-up</span></button>
            </div>`, 'mm--state')}
          ${module('SCENERY', `
            <div class="choice choice--3" id="m-scen">
              <button type="button" data-v="esri"><b>SATELLITE</b><span>Keyless · ESRI imagery + terrain</span></button>
              <button type="button" data-v="google"><b>GOOGLE 3D</b><span>Photorealistic 3D Tiles</span></button>
              <button type="button" data-v="ion"><b>CESIUM ION</b><span>World Terrain + Bing</span></button>
            </div>
            <div class="keyrow" data-for="google">
              ${field('Google Maps API key', '<input id="m-gkey" type="password" autocomplete="off" spellcheck="false" placeholder="AIza…">')}
              <p class="mm__note">Needs a Google Cloud key with the <b>Map Tiles API</b> enabled (billing on). Restrict it to this site's referrer. Stored only in this browser.</p>
            </div>
            <div class="keyrow" data-for="ion">
              ${field('Cesium ion access token', '<input id="m-ion" type="password" autocomplete="off" spellcheck="false" placeholder="eyJhbGci…">')}
              <p class="mm__note">Free token from ion.cesium.com. Stored only in this browser.</p>
            </div>
            ${field('Quality', `<div class="seg" id="m-q">
              <button type="button" data-v="low">LOW</button><button type="button" data-v="medium">MED</button>
              <button type="button" data-v="high">HIGH</button><button type="button" data-v="ultra">ULTRA</button></div>`, '', 'div')}`, 'mm--scen')}
        </div>
        <footer class="menu-foot">
          <p class="menu-foot__hint">Esc pauses · 1–4 open cockpit panels · C cycles views</p>
          <p class="menu-foot__status" id="m-status" role="status"></p>
          <button type="button" class="btn-start" data-act="start"><span class="btn-start__bar"></span>START FLIGHT</button>
        </footer>
      </div>

      <div class="menu-pause" data-screen="pause">
        <section class="mm mm--pause">${screws()}
          <h3 class="mm__title">PAUSED</h3>
          <div class="pause-actions">
            <button type="button" class="btn-start" data-act="resume"><span class="btn-start__bar"></span>RESUME</button>
            <button type="button" class="btn-ghost" data-act="restart-same">RESTART ON RUNWAY</button>
            <button type="button" class="btn-ghost" data-act="restart">NEW FLIGHT…</button>
            <button type="button" class="btn-ghost" data-act="help">KEY BINDINGS</button>
          </div>
        </section>
      </div>

      <div class="menu-help" data-screen="help" role="dialog" aria-label="Key bindings">
        <section class="mm mm--help">${screws()}
          <h3 class="mm__title">KEY BINDINGS</h3>
          <div class="help-grid">${KEY_BINDINGS.map(([group, rows]) => `
            <div class="help-group"><h4>${esc(group)}</h4><dl>${rows.map(([k, a]) =>
              `<dt>${k.split('  ·  ').map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</dt><dd>${esc(a)}</dd>`).join('')}</dl></div>`).join('')}
          </div>
          <div class="pause-actions"><button type="button" class="btn-ghost" data-act="help-close">CLOSE</button></div>
        </section>
      </div>
    </div>`;

  wire(ui);
  // Keys typed into the menu must not reach the global flight-control handlers.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.mode === 'help') { closeHelp(ui); e.preventDefault(); }
      else if (ui.mode === 'pause') { ui.onResume?.(); e.preventDefault(); }
    }
    e.stopPropagation();
  });
  root.addEventListener('keyup', (e) => e.stopPropagation());
  return {
    showSetup: () => setScreen(ui, 'setup'),
    showPause: (h) => { ui.onResume = h?.onResume; ui.onRestart = h?.onRestart; setScreen(ui, 'pause'); root.querySelector('[data-act="resume"]').focus(); },
    showHelp: () => openHelp(ui),
    hide: () => setScreen(ui, null),
    isOpen: () => ui.mode !== null,
    setStatus: (t, busy = true) => {
      const el = root.querySelector('#m-status'); el.textContent = t || '';
      root.classList.toggle('is-busy', !!busy && !!t);
    },
    settings: () => ({ ...ui.state }),
    consumeAutostart() {
      try { const v = sessionStorage.getItem(SS_AUTOSTART); sessionStorage.removeItem(SS_AUTOSTART); return v === '1'; } catch (e) { return false; }
    },
    requestRestart(sameRunway) {
      try { if (sameRunway) sessionStorage.setItem(SS_AUTOSTART, '1'); } catch (e) { /* ignore */ }
      location.reload();
    },
  };
}

function setScreen(ui, name) {
  if (name !== 'help') ui.prev = name;
  ui.mode = name;
  ui.root.dataset.screen = name || '';
  ui.root.hidden = !name;
  document.body.classList.toggle('menu-open', !!name);
}
function openHelp(ui) { ui.back = ui.mode; setScreen(ui, 'help'); }
function closeHelp(ui) { setScreen(ui, ui.back || null); }

function airportOptions(airports, sel, allowNone) {
  return (allowNone ? '<option value="">— No destination —</option>' : '') + airports.map((a) =>
    `<option value="${a.icao}" ${a.icao === sel ? 'selected' : ''}>${a.icao} · ${esc(a.city || a.name)}</option>`).join('');
}
function runwayOptions(apt, sel) {
  if (!apt) return '<option value="">—</option>';
  return apt.runways.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>RWY ${r.id} · ${Math.round(r.lengthM)} m</option>`).join('');
}
function runwayInfo(apt, id) {
  if (!apt) return 'Free flight · no route built';
  const r = apt.runways.find((x) => x.id === id) || apt.runways[0];
  const ils = r.ils ? `ILS ${r.ils.ident} ${r.ils.freq.toFixed(2)}${r.ils.simOnly ? '*' : ''}` : '';
  return `${esc(apt.name)} · ELEV ${apt.elevFt} FT · HDG ${Math.round(r.hdgDeg)}°T · ${ils}`;
}

function wire(ui) {
  const { root, airports, state } = ui;
  const $ = (s) => root.querySelector(s);
  const find = (icao) => airports.find((a) => a.icao === icao) || null;
  const commit = () => save(state);

  const dep = $('#m-dep'), depR = $('#m-dep-rwy'), dst = $('#m-dest'), dstR = $('#m-dest-rwy');
  if (!find(state.depIcao)) state.depIcao = airports[0].icao;
  dep.innerHTML = airportOptions(airports, state.depIcao, false);
  dst.innerHTML = airportOptions(airports, state.destIcao, true);
  const refreshRwys = () => {
    const a = find(state.depIcao), b = find(state.destIcao);
    if (!a.runways.some((r) => r.id === state.depRwy)) state.depRwy = a.runways[0].id;
    if (b && !b.runways.some((r) => r.id === state.destRwy)) state.destRwy = b.runways[0].id;
    depR.innerHTML = runwayOptions(a, state.depRwy);
    dstR.innerHTML = runwayOptions(b, state.destRwy);
    dstR.disabled = !b;
    $('#m-dep-info').textContent = runwayInfo(a, state.depRwy);
    $('#m-dest-info').textContent = runwayInfo(b, state.destRwy);
  };
  dep.addEventListener('change', () => { state.depIcao = dep.value; refreshRwys(); commit(); });
  dst.addEventListener('change', () => { state.destIcao = dst.value; refreshRwys(); commit(); });
  depR.addEventListener('change', () => { state.depRwy = depR.value; refreshRwys(); commit(); });
  dstR.addEventListener('change', () => { state.destRwy = dstR.value; refreshRwys(); commit(); });
  refreshRwys();

  // ranges with LCD readouts
  const ranges = [
    ['#m-time', 'timeOfDayH', (v) => `${fmtTime(v)}`],
    ['#m-wdir', 'windDirDeg', (v) => String(Math.round(v)).padStart(3, '0')],
    ['#m-wkt', 'windKt', (v) => String(v)],
    ['#m-tdev', 'tempDevC', (v) => (v > 0 ? '+' : '') + v],
    ['#m-qnh', 'qnhHpa', (v) => String(v)],
    ['#m-fuel', 'fuelKg', (v) => fmtKg(v)],
    ['#m-pay', 'payloadKg', (v) => fmtKg(v)],
  ];
  const updGw = () => {
    const gw = OEW_KG + state.fuelKg + state.payloadKg;
    const over = gw > MTOW_KG;
    $('#m-gw-val').textContent = `${fmtKg(gw)} KG`;
    const f = $('#m-gw-fill');
    f.style.width = `${Math.min(100, ((gw - OEW_KG) / (MTOW_KG - OEW_KG)) * 100)}%`;
    $('#m-gw').classList.toggle('is-over', over);
    $('#m-gw-val').title = over ? 'Above maximum takeoff weight' : '';
  };
  for (const [sel, key, fmt] of ranges) {
    const el = $(sel), out = el.parentElement.querySelector('output');
    el.value = state[key];
    const upd = () => { state[key] = +el.value; out.textContent = fmt(+el.value); if (key === 'fuelKg' || key === 'payloadKg') updGw(); };
    el.addEventListener('input', upd);
    el.addEventListener('change', commit);
    upd();
  }

  // segmented / choice groups
  const group = (sel, key, map = (v) => v, unmap = (v) => String(v), after) => {
    const g = $(sel);
    const sync = () => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === unmap(state[key])));
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state[key] = map(b.dataset.v); sync(); commit(); after?.();
    });
    sync();
  };
  group('#m-turb', 'turbulence', (v) => +v, (v) => String(v));
  group('#m-q', 'quality');
  group('#m-state', 'coldDark', (v) => v === 'cold', (v) => (v ? 'cold' : 'ready'));
  const syncKeys = () => root.querySelectorAll('.keyrow').forEach((k) => { k.hidden = k.dataset.for !== state.scenery; });
  group('#m-scen', 'scenery', (v) => v, (v) => v, syncKeys);
  syncKeys();
  const gk = $('#m-gkey'), ik = $('#m-ion');
  gk.value = state.googleKey || ''; ik.value = state.ionToken || '';
  gk.addEventListener('input', () => { state.googleKey = gk.value.trim(); commit(); });
  ik.addEventListener('input', () => { state.ionToken = ik.value.trim(); commit(); });

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'start') {
      if (state.scenery === 'google' && !state.googleKey) { $('#m-status').textContent = 'Enter a Google Maps API key or choose Satellite.'; gk.focus(); return; }
      if (state.scenery === 'ion' && !state.ionToken) { $('#m-status').textContent = 'Enter a Cesium ion token or choose Satellite.'; ik.focus(); return; }
      commit();
      b.disabled = true;
      Promise.resolve(ui.onStart?.({ ...state })).catch((err) => {
        $('#m-status').textContent = `Start failed: ${err?.message || err}`;
      }).finally(() => { b.disabled = false; });
    } else if (act === 'resume') ui.onResume?.();
    else if (act === 'restart') ui.onRestart?.(false);
    else if (act === 'restart-same') ui.onRestart?.(true);
    else if (act === 'help') openHelp(ui);
    else if (act === 'help-close') closeHelp(ui);
  });
  setScreen(ui, 'setup');
}
