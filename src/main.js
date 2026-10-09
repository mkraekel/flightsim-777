// Application shell and main loop (Team B).
//
// Boot: menu -> initGlobe -> spawnAt -> init all subsystems -> 'spawned' -> run.
// Every other team's module is loaded with dynamic import() so a missing or broken file
// degrades to a no-op instead of killing the app. Every subsystem call in the loop is
// wrapped in try/catch and logs once per subsystem.

import { createSimState } from './core/state.js';
import { DEG } from './core/geo.js';
import { AIRPORTS, findAirport, findRunway } from './world/airports.js';
import { initMenu } from './ui/menu.js';
import { initHud, updateHud } from './ui/hud.js';

const PHYS_DT = 1 / 120;
const MAX_FRAME_DT = 0.1;
const MAX_STEPS = 48;   // safety: at most 0.4 s of physics per frame (4x sim rate at 10 fps)

// ------------------------------------------------------------------ module loading

const MODULES = {
  fdm:      ['./physics/fdm.js',             ['initAircraft', 'stepPhysics']],
  afds:     ['./systems/afds.js',            ['initAFDS', 'stepAFDS', 'afdsAction']],
  fmc:      ['./systems/fmc.js',             ['initFMC', 'stepFMC', 'buildDefaultRoute']],
  nav:      ['./systems/navradio.js',        ['stepNav']],
  mcp:      ['./cockpit/mcp.js',             ['initMCP', 'updateMCP']],
  cdu:      ['./avionics/cdu.js',            ['initCDU', 'updateCDU']],
  input:    ['./input/input.js',             ['initInput', 'stepInput']],
  systems:  ['./systems/aircraftSystems.js', ['initSystems', 'stepSystems']],
  alerts:   ['./systems/alerts.js',          ['stepAlerts']],
  audio:    ['./audio/audio.js',             ['initAudio', 'resumeAudio', 'stepAudio']],
  overhead: ['./cockpit/overhead.js',        ['initOverhead', 'updateOverhead']],
  pedestal: ['./cockpit/pedestal.js',        ['initPedestal', 'updatePedestal']],
  displays: ['./avionics/displays.js',       ['initDisplays', 'updateDisplays']],
  globe:    ['./world/globe.js',             ['initGlobe', 'updateGlobe', 'spawnAt']],
  touch:    ['./input/touch.js',             ['initTouch', 'stepTouch']],
};

const api = {};            // name -> function (real or no-op)
const loaded = {};         // module key -> true/false
const failed = new Set();  // subsystems that already logged an error

const noop = () => undefined;

async function loadModules() {
  await Promise.all(Object.entries(MODULES).map(async ([key, [path, names]]) => {
    try {
      const mod = await import(path);
      loaded[key] = true;
      for (const n of names) {
        if (typeof mod[n] === 'function') api[n] = mod[n];
        else { api[n] = noop; console.warn(`[main] ${path} has no export ${n}() – using no-op`); }
      }
    } catch (err) {
      loaded[key] = false;
      console.warn(`[main] module ${path} unavailable – using no-ops`, err);
      for (const n of names) api[n] = noop;
    }
  }));
  return loaded;
}

/** Call a subsystem function; log the first error per subsystem, never throw. */
function safe(name, ...args) {
  const fn = api[name];
  if (!fn) return undefined;
  try {
    return fn(...args);
  } catch (err) {
    if (!failed.has(name)) { failed.add(name); console.error(`[main] ${name} threw (further errors suppressed)`, err); }
    return undefined;
  }
}
async function safeAsync(name, ...args) {
  try { return await safe(name, ...args); } catch (err) {
    if (!failed.has(name)) { failed.add(name); console.error(`[main] ${name} rejected`, err); }
    return undefined;
  }
}

// ------------------------------------------------------------------ app state

const $ = (id) => document.getElementById(id);
const sim = createSimState();
sim.world = { status: 'menu' };
window.sim = sim;
sim.debug = { api, loaded, failed, airports: AIRPORTS };

let menu = null;
let running = false;
let lastT = 0, acc = 0;
let lastPaused = false, lastMode = null, lastPanel = null;
let modulesReady = null;

// ------------------------------------------------------------------ drawers & body classes

const DRAWERS = ['overhead', 'pedestal', 'cdu', 'lower'];
const RIGHT_GROUP = ['overhead', 'cdu', 'lower'];

/** Toggle a drawer (also used by input.js through sim.ui or the 'drawer' event). */
function toggleDrawer(name, force) {
  const el = $(`drawer-${name}`);
  if (!el) return;
  const open = force ?? !el.classList.contains('open');
  if (open && RIGHT_GROUP.includes(name)) {
    // right-side drawers share the space: opening one closes the others
    for (const o of RIGHT_GROUP) if (o !== name) $(`drawer-${o}`)?.classList.remove('open');
  }
  el.classList.toggle('open', open);
}

function syncDock() {
  for (const n of DRAWERS) {
    const open = $(`drawer-${n}`)?.classList.contains('open');
    document.querySelector(`#drawer-dock [data-drawer="${n}"]`)?.classList.toggle('on', !!open);
    document.body.classList.toggle(`drawer-${n}-open`, !!open);
  }
}

function setupShell() {
  $('drawer-dock').addEventListener('click', (e) => {
    const b = e.target.closest('[data-drawer]');
    if (b) { toggleDrawer(b.dataset.drawer); b.blur(); }
  });
  const mo = new MutationObserver(syncDock);
  for (const n of DRAWERS) { const el = $(`drawer-${n}`); if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] }); }
  sim.ui = { toggleDrawer, openMenu: () => openPause(), drawers: DRAWERS };
  sim.events.on('drawer', (d) => toggleDrawer(d?.name, d?.open));
  sim.events.on('menu', () => openPause());
  syncDock();
}

function syncBodyClasses() {
  const v = sim.view;
  if (v.mode !== lastMode || v.panel !== lastPanel) {
    const b = document.body;
    for (const m of ['cockpit', 'chase', 'flyby', 'tower']) b.classList.toggle(`view-${m}`, v.mode === m);
    b.classList.toggle('panel-hidden', !(v.mode === 'cockpit' && v.panel));
    if (lastMode !== null && v.mode !== lastMode) sim.events.emit('view', { mode: v.mode });
    lastMode = v.mode; lastPanel = v.panel;
    // canvases inside resized boxes need a layout pass
    window.dispatchEvent(new Event('resize'));
  }
}

// ------------------------------------------------------------------ pause menu

function openPause() {
  if (!running) return;
  sim.paused = true;
  lastPaused = true;
  menu.showPause({
    onResume: () => { menu.hide(); sim.paused = false; lastPaused = false; },
    onRestart: (same) => menu.requestRestart(same),
  });
}

function watchPause() {
  // input.js toggles sim.paused on Esc/Space. Show the pause card when it becomes paused.
  if (sim.paused !== lastPaused) {
    lastPaused = sim.paused;
    if (sim.paused && !menu.isOpen()) openPause();
    else if (!sim.paused && menu.isOpen()) menu.hide();
  }
}

/** Minimal keyboard handling only used when input.js failed to load. */
function installFallbackKeys() {
  console.warn('[main] input.js missing: installing fallback keys (Esc, C, V, 1-4, =)');
  window.addEventListener('keydown', (e) => {
    if (menu.isOpen() && e.key !== 'Escape') return;
    const k = e.key;
    if (k === 'Escape' || k === ' ') { if (sim.paused) { menu.hide(); sim.paused = false; } else openPause(); e.preventDefault(); }
    else if (k === 'c' || k === 'C') { const m = ['cockpit', 'chase', 'flyby', 'tower']; sim.view.mode = m[(m.indexOf(sim.view.mode) + 1) % m.length]; }
    else if (k === 'v' || k === 'V') sim.view.panel = !sim.view.panel;
    else if (k >= '1' && k <= '4') toggleDrawer(DRAWERS[+k - 1]);
    else if (k === '=') sim.simRate = sim.simRate >= 4 ? 1 : sim.simRate * 2;
  });
}

// ------------------------------------------------------------------ boot

async function startFlight(s) {
  menu.setStatus('Loading modules…');
  // iOS Safari: unlock WebAudio + speech synchronously inside the START tap, before any await.
  const audioEarly = !!api.resumeAudio;
  if (audioEarly) { safe('initAudio', sim); safe('resumeAudio'); }
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch { /* no speech */ }
  await modulesReady;
  if (!loaded.globe) throw new Error('world/globe.js failed to load');
  const dep = findAirport(s.depIcao) || AIRPORTS[0];
  const depRwy = findRunway(dep, s.depRwy);
  const dest = s.destIcao ? findAirport(s.destIcao) : null;
  const destRwy = dest ? findRunway(dest, s.destRwy) : null;

  // environment from the menu
  Object.assign(sim.env, {
    windDirDeg: s.windDirDeg, windKt: s.windKt, tempDevC: s.tempDevC, turbulence: s.turbulence,
    qnhHpa: s.qnhHpa, baroHpa: s.qnhHpa, baroStd: false, timeOfDayH: s.timeOfDayH,
  });

  // Audio must be created/resumed inside the user gesture (the START click).
  if (!audioEarly) { safe('initAudio', sim); safe('resumeAudio'); }

  menu.setStatus('Starting 3D world…');
  const googleKey = s.scenery === 'google' ? s.googleKey : '';
  const ionToken = s.scenery === 'ion' ? s.ionToken : '';
  await api.initGlobe(sim, $('world'), { googleKey, ionToken, quality: s.quality });

  menu.setStatus(`Loading terrain at ${dep.icao} ${depRwy.id}…`);
  await api.spawnAt(sim, dep, depRwy, { fuelKg: s.fuelKg, payloadKg: s.payloadKg, coldDark: s.coldDark, timeOfDayH: s.timeOfDayH });
  sim.world.status = 'running';
  sim.world.settings = { ...s, googleKey: undefined, ionToken: undefined };

  menu.setStatus('Powering up systems…');
  safe('initSystems', sim, { coldDark: !!s.coldDark });
  safe('initAFDS', sim);
  safe('initFMC', sim);
  sim.fmc.origin = dep;
  sim.fmc.originRwy = depRwy;
  sim.fmc.depRwy = depRwy;          // fmc.js / navradio.js / cdu.js use depRwy / arrRwy
  if (dest) {
    sim.fmc.dest = dest;
    sim.fmc.destRwy = destRwy;
    sim.fmc.arrRwy = destRwy || null;
    safe('buildDefaultRoute', sim, dep, dest, { depRwy, arrRwy: destRwy || undefined });
  }
  safe('initInput', sim, $('app'));
  if (!loaded.input) installFallbackKeys();
  safe('initDisplays', sim, {
    pfdEl: $('pfd'), ndEl: $('nd'), eicasEl: $('eicas'), lowerEl: $('drawer-lower'), isfdEl: $('isfd'), efisEl: $('efis-l'),
  });
  safe('initMCP', sim, $('mcp'));
  safe('initCDU', sim, $('drawer-cdu'));
  safe('initOverhead', sim, $('drawer-overhead'));
  safe('initPedestal', sim, $('drawer-pedestal'));

  sim.events.emit('spawned', { airport: dep, runway: depRwy });
  sim.events.emit('toast', { text: `${dep.icao} RWY ${depRwy.id}${dest ? ` → ${dest.icao}` : ''} · ${s.coldDark ? 'cold & dark' : 'ready for takeoff'}` });

  menu.setStatus('', false);
  menu.hide();
  document.body.classList.remove('booting');
  sim.paused = false; lastPaused = false;
  running = true;
  lastT = performance.now();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ main loop

/** Advance the simulation logic by one frame of dt seconds (sim time), in contract order. */
function stepSim(dt) {
  sim.time += dt;
  safe('stepInput', sim, dt);
  safe('stepTouch', sim, dt);      // touch overlay (overrides keyboard auto-centre while in use)
  safe('stepNav', sim, dt);
  safe('stepFMC', sim, dt);
  safe('stepAFDS', sim, dt);
  acc += dt;
  let n = 0;
  while (acc >= PHYS_DT && n < MAX_STEPS) { safe('stepPhysics', sim, PHYS_DT); acc -= PHYS_DT; n++; }
  if (n >= MAX_STEPS) acc = 0;   // drop backlog rather than spiral
  safe('stepSystems', sim, dt);
  safe('stepAlerts', sim, dt);
  safe('stepAudio', sim, dt);
}

function renderAll(dt) {
  safe('updateGlobe', sim, dt);
  safe('updateDisplays', sim, dt);
  safe('updateMCP', sim);
  safe('updateCDU', sim);
  safe('updateOverhead', sim);
  safe('updatePedestal', sim);
  try { updateHud(sim); } catch (e) { if (!failed.has('hud')) { failed.add('hud'); console.error(e); } }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtFrame = Math.min(MAX_FRAME_DT, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  watchPause();
  syncBodyClasses();
  // sim.debug.freeze: test hook - the rAF loop keeps rendering but the sim only advances
  // through sim.debug.stepSim() (lets headless tests run faster than real time).
  if (sim.debug.freeze === 'all') return;   // test hook: no sim, no rendering (tests render explicitly)
  const advance = !sim.paused && !sim.debug.freeze;
  const dt = advance ? dtFrame * (sim.simRate || 1) : 0;
  if (advance) stepSim(dt);
  // Paused: the sim does not advance (contract), but keep rendering alive.
  renderAll(dt);
}
sim.debug.stepSim = stepSim;
sim.debug.renderAll = renderAll;

// ------------------------------------------------------------------ entry

function boot() {
  setupShell();
  initHud(sim, $('hud'), $('toast'));
  menu = initMenu($('menu'), { airports: AIRPORTS, onStart: (s) => startFlight(s).catch((err) => {
    console.error('[main] start failed', err);
    menu.setStatus(`Could not start: ${err.message || err}`, false);
    throw err;
  }) });
  sim.menu = menu;
  modulesReady = loadModules();
  modulesReady.then(() => safe('initTouch', sim, $('app'), { call: safe }));
  syncBodyClasses();
  if (menu.consumeAutostart()) {
    // "Restart on runway" from the pause menu: start straight away with the saved settings.
    // (No user gesture here, so audio resumes on the first click/key instead.)
    window.addEventListener('pointerdown', () => safe('resumeAudio'), { once: true });
    window.addEventListener('keydown', () => safe('resumeAudio'), { once: true });
    startFlight(menu.settings()).catch((err) => menu.setStatus(`Could not start: ${err.message || err}`, false));
  }
}

boot();
