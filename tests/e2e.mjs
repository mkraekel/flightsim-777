// End-to-end integration test (QA): drives the whole app in headless Chromium.
//
// Usage (from flightsim-777/):
//   python3 -m http.server 8777 &
//   NODE_PATH=$(npm root -g) node tests/e2e.mjs [baseUrl] [--only=1,2,...]
//
// Swiftshader renders at ~1 fps, so flight phases run with the rAF loop frozen
// (sim.debug.freeze) and the sim advanced in-page through sim.debug.stepSim() — the same
// per-frame sequence main.js runs — with a real updateGlobe() render (ground height sampling,
// camera) every 0.5 s of sim time. The real rAF loop is verified separately.
// Screenshots go to tests/shots/e2e-*.png; a report is printed at the end (exit 1 on failure).
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:8777/';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean).map(Number);
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const want = (n) => !ONLY.length || ONLY.includes(n);

// ------------------------------------------------------------------ report
const results = [];
let scenario = '';
function check(name, ok, detail = '') {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ browser
function findChrome() {
  const root = '/opt/pw-browsers';
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (d.startsWith('chromium-') && fs.existsSync(p)) return p;
  }
  return undefined;
}
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) args.push(`--proxy-server=https=${proxy.replace(/^https?:\/\//, '')}`);
const browser = await chromium.launch({ executablePath: findChrome(), args });

/** Open the app, pick the departure in the menu and press START FLIGHT. */
async function boot({ dep = 'EDDF', rwy = '25C', dest = 'EGLL', destRwy = '27R', coldDark = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu [data-act="start"]');
  await page.selectOption('#m-dep', dep);
  await page.selectOption('#m-dep-rwy', rwy);
  if (dest) { await page.selectOption('#m-dest', dest).catch(() => {}); await page.selectOption('#m-dest-rwy', destRwy).catch(() => {}); }
  if (coldDark) await page.click('#menu >> text=COLD & DARK');
  await page.click('#m-q [data-v="low"]');
  await page.click('#menu [data-act="start"]');
  await page.waitForFunction(() => window.sim?.world?.status === 'running', null, { timeout: 150000 });
  // headless swiftshader produces ~0.5 fps, so CSS transitions (drawers) would take ages to start
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' });
  await page.evaluate(() => {
    window.__ev = [];
    sim.events.on('aural', (d) => __ev.push({ t: sim.time, id: d?.id }));
    sim.events.on('toast', (d) => __ev.push({ t: sim.time, toast: d?.text }));
    // Advance the sim `seconds` with fixed frame dt; render (ground sampling) every renderEvery s and
    // yield to the event loop so terrain-sample promises resolve.
    window.__run = async (seconds, dt = 1 / 30, renderEvery = 0.5, stop = null) => {
      const api = sim.debug.api; let tr = 0; const t0 = sim.time;
      while (sim.time - t0 < seconds - 1e-9) {
        sim.debug.stepSim(dt);
        tr += dt;
        if (renderEvery && tr >= renderEvery - 1e-9) { tr = 0; api.updateGlobe(sim, renderEvery); await new Promise((r) => setTimeout(r, 0)); }
        if (stop && stop()) break;
      }
      return sim.time - t0;
    };
    const R = 180 / Math.PI;
    window.__snap = () => ({
      t: +sim.time.toFixed(1), ra: +sim.ac.ra.toFixed(2), og: sim.ac.onGround, vsFpm: Math.round(sim.ac.vs * 196.85),
      altFt: Math.round(sim.ac.altMSL * 3.28084), kcas: +(sim.ac.cas * 1.94384).toFixed(1), gsKt: +(sim.ac.gs * 1.94384).toFixed(1),
      hdg: +(sim.ac.euler.heading * R).toFixed(1), pitch: +(sim.ac.euler.pitch * R).toFixed(1), roll: +(sim.ac.euler.roll * R).toFixed(1),
      crashed: sim.ac.crashed, reason: sim.ac.crashReason, n1: sim.engines.map((e) => +e.n1.toFixed(1)),
      thr: sim.controls.throttle.map((x) => +x.toFixed(2)), flaps: sim.surfaces.flapsDeg, gear: +sim.surfaces.gear.toFixed(2),
      gH: +sim.env.groundH.toFixed(2), fma: [sim.ap.modes.at, sim.ap.modes.roll, sim.ap.modes.pitch, sim.ap.modes.armedRoll, sim.ap.modes.armedPitch, sim.ap.modes.ap].join('|'),
      ap: sim.ap.apEngaged, at: sim.ap.atEngaged, warn: sim.alerts.list.filter((a) => a.level === 'warning').map((a) => a.text),
    });
  });
  return { ctx, page, errors };
}
const run = (page, s, dt, re) => page.evaluate(([a, b, c]) => __run(a, b, c), [s, dt ?? 1 / 30, re ?? 0.5]);
const snap = (page) => page.evaluate(() => __snap());
const shot = async (page, name) => {
  // let the rAF loop render (but not advance the sim) while the screenshot is taken
  const prev = await page.evaluate(() => { const p = sim.debug.freeze; if (p === 'all') sim.debug.freeze = true; sim.debug.renderAll(0); return p; });
  await wait(300);
  try { await page.screenshot({ path: path.join(OUT, `e2e-${name}.png`), timeout: 180000 }); } catch (e) { console.log(`  (screenshot ${name} failed: ${e.message.split('\n')[0]})`); }
  await page.evaluate((p) => { sim.debug.freeze = p; }, prev);
};
const finite = (o) => JSON.stringify(o).match(/null|NaN/) === null;
const relevantErrors = (errs) => errs.filter((e) => !/favicon/.test(e));

// ============================================================ 1+2+3+6+7: EDDF session
if (want(1) || want(2) || want(3) || want(6) || want(7)) {
  scenario = '1 Boot';
  console.log('\n[1] Boot at EDDF 25C');
  const t0 = Date.now();
  const { ctx, page, errors } = await boot();
  console.log(`  booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const loaded = await page.evaluate(() => sim.debug.loaded);
  check('all modules loaded', Object.values(loaded).every(Boolean) && Object.keys(loaded).length >= 14, JSON.stringify(loaded));
  // real rAF loop advances the sim
  const tA = await page.evaluate(() => sim.time); await wait(4000);
  const tB = await page.evaluate(() => sim.time);
  check('real rAF loop advances sim time', tB > tA, `${tA.toFixed(2)} -> ${tB.toFixed(2)} s`);
  await page.evaluate(() => { sim.debug.freeze = 'all'; });
  const s0 = await snap(page);
  let minRa = 1e9, maxRa = -1, maxVs = 0, gMin = 1e9, gMax = -1e9;
  for (let i = 0; i < 30; i++) {
    await run(page, 1);
    const s = await snap(page);
    minRa = Math.min(minRa, s.ra); maxRa = Math.max(maxRa, s.ra); maxVs = Math.max(maxVs, Math.abs(s.vsFpm));
    gMin = Math.min(gMin, s.gH); gMax = Math.max(gMax, s.gH);
  }
  const s1 = await snap(page);
  check('resting 30 s: on ground, not crashed', s1.og && !s1.crashed, `og=${s1.og} crashed=${s1.crashed} ${s1.reason}`);
  check('resting: RA ~ 0, no bounce', maxRa < 0.3 && maxVs < 30, `ra ${minRa}..${maxRa} m, max |vs| ${maxVs} fpm`);
  check('resting: ground height stable', gMax - gMin < 0.5, `groundH ${gMin}..${gMax}`);
  check('resting: not rolling', s1.gsKt < 1, `gs ${s1.gsKt} kt`);
  check('altitude near field elevation (364 ft)', Math.abs(s1.altFt - 364) < 60, `${s1.altFt} ft`);
  check('state finite', finite(s1));
  check('no warnings at rest', s1.warn.length === 0, s1.warn.join(','));
  check('FMC route EDDF->EGLL built', await page.evaluate(() => sim.fmc.route.length > 3 && sim.fmc.dest?.icao === 'EGLL' && sim.fmc.arrRwy?.id === '27R' && sim.fmc.depRwy?.id === '25C'),
    await page.evaluate(() => `${sim.fmc.route.map((w) => w.ident).join(' ')} dep ${sim.fmc.depRwy?.id} arr ${sim.fmc.arrRwy?.id}`));
  await shot(page, 'cockpit-ground');
  check('no console errors after boot', relevantErrors(errors).length === 0, relevantErrors(errors).slice(0, 3).join(' | '));

  // ---------------------------------------------------------------- 2 manual takeoff
  if (want(2) || want(3)) {
    scenario = '2 Takeoff';
    console.log('\n[2] Manual takeoff (keyboard)');
    await page.keyboard.press('KeyP');
    check('parking brake released (P)', await page.evaluate(() => !sim.controls.parkingBrake));
    await page.keyboard.press('F4');
    let s = await snap(page), warnSeen = new Set();
    const vr = await page.evaluate(() => sim.fmc.vr || 155);
    for (let i = 0; i < 140 && s.kcas < vr; i++) { await run(page, 0.5, 1 / 30, 1); s = await snap(page); s.warn.forEach((w) => warnSeen.add(w)); }
    check('reached VR on the runway', s.kcas >= vr && s.og && !s.crashed, `VR ${vr} kt at t=${s.t}, N1 ${s.n1}`);
    check('no CONFIG warning during takeoff roll', warnSeen.size === 0, [...warnSeen].join(','));
    check('takeoff N1 plausible', s.n1[0] > 95 && s.n1[0] < 110, `${s.n1}`);
    await page.keyboard.down('ArrowDown');
    for (let i = 0; i < 40; i++) { await run(page, 0.25, 1 / 30, 0); s = await snap(page); if (s.pitch > 7.5) break; }
    await page.keyboard.up('ArrowDown');
    let maxPitch = 0, gearUp = false;
    for (let i = 0; i < 80; i++) {
      s = await snap(page);
      maxPitch = Math.max(maxPitch, s.pitch);
      if (s.pitch < 12 && !s.og) { await page.keyboard.down('ArrowDown'); await run(page, 0.3, 1 / 30, 0); await page.keyboard.up('ArrowDown'); }
      else if (s.pitch > 17) { await page.keyboard.down('ArrowUp'); await run(page, 0.2, 1 / 30, 0); await page.keyboard.up('ArrowUp'); }
      await run(page, 0.5, 1 / 30, 1);
      if (!gearUp && s.vsFpm > 300 && s.ra > 30) { await page.keyboard.press('KeyG'); gearUp = true; }
      if (s.altFt > 1500 || s.crashed) break;
    }
    s = await snap(page);
    check('airborne & climbing, no crash', !s.og && !s.crashed && s.vsFpm > 500, `alt ${s.altFt} ft vs ${s.vsFpm} fpm ${s.reason}`);
    check('no tail strike', !(await page.evaluate(() => __ev.some((e) => /TAIL/.test(e.toast || '')))));
    check('gear lever UP (G)', await page.evaluate(() => sim.controls.gearLever === 'UP'));
    await run(page, 8, 1 / 30, 1);
    check('gear retracted', (await snap(page)).gear < 0.05, `gear ${(await snap(page)).gear}`);
    await shot(page, 'cockpit-climb');
    // flaps up stepwise while accelerating (pitch lowered with short pushes)
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 20; i++) {
        s = await snap(page);
        if (s.pitch > 10) { await page.keyboard.down('ArrowUp'); await run(page, 0.2, 1 / 30, 0); await page.keyboard.up('ArrowUp'); }
        await run(page, 0.5, 1 / 30, 1);
        const need = [0, 180, 200, 220][k] + (s.flaps > 10 ? 0 : 10);
        if (s.kcas > need) break;
      }
      await page.keyboard.press('F6');
      await run(page, 6, 1 / 30, 1);
    }
    s = await snap(page);
    check('flaps retracted stepwise (F6)', s.flaps < 0.5, `flaps ${s.flaps} lever ${await page.evaluate(() => sim.controls.flapLever)}`);
    check('still flying after cleanup', !s.crashed && !s.og && s.altFt > 1500, `alt ${s.altFt} kcas ${s.kcas}`);
    const eicas = await page.evaluate(() => ({ n1: sim.engines.map((e) => e.n1), egt: sim.engines.map((e) => e.egt), ff: sim.engines.map((e) => e.ff), fuel: sim.ac.fuelKg }));
    check('EICAS values plausible', eicas.egt.every((x) => x > 300 && x < 1100) && eicas.ff.every((x) => x > 1000 && x < 20000) && finite(eicas), JSON.stringify(eicas).slice(0, 160));
    check('aural V1 called', await page.evaluate(() => __ev.some((e) => e.id === 'v1')));
  }

  // ---------------------------------------------------------------- 3 autopilot
  if (want(3)) {
    scenario = '3 Autopilot';
    console.log('\n[3] Autopilot via MCP');
    // level off with V/S 0 hand-flown is hard by keys; just engage at the current state
    let s = await snap(page);
    await page.evaluate(() => sim.debug.renderAll(0));
    await page.click('#mcp button[aria-label="Autopilot engage left"]');
    await run(page, 1);
    s = await snap(page);
    check('A/P engaged via MCP click', s.ap, s.fma);
    check('FMA shows A/P', /A\/P/.test(s.fma), s.fma);
    // A/T + speed / heading / altitude via afdsAction and MCP UI
    await page.evaluate(() => { const a = sim.debug.api.afdsAction; a(sim, 'SPD_SET', 250); a(sim, 'HDG_SET', 300); a(sim, 'HDG_SEL'); a(sim, 'ALT_SET', 6000); });
    await page.click('#mcp button[aria-label="FLCH"]').catch(async () => page.evaluate(() => sim.debug.api.afdsAction(sim, 'FLCH')));
    if (!(await page.evaluate(() => sim.ap.atEngaged))) await page.click('#mcp button[aria-label="A/T"]');
    await run(page, 60, 1 / 30, 1);
    s = await snap(page);
    check('HDG SEL 300: heading captured', Math.abs(((s.hdg - (300 + 3)) + 540) % 360 - 180) < 6 && /HDG SEL/.test(s.fma), `true hdg ${s.hdg}, ${s.fma}`);
    check('FLCH climbing toward 6000', /FLCH SPD|ALT/.test(s.fma) && (s.vsFpm > 300 || s.altFt > 5800), `${s.altFt} ft ${s.vsFpm} fpm ${s.fma}`);
    check('A/T engaged', s.at, s.fma);
    await run(page, 60, 1 / 30, 1);
    s = await snap(page);
    check('ALT captured at 6000', Math.abs(s.altFt - 6000) < 150 && /ALT/.test(s.fma), `${s.altFt} ft ${s.fma}`);
    check('speed ~250 kt', Math.abs(s.kcas - 250) < 15, `${s.kcas} kt`);
    // LNAV / VNAV
    await page.evaluate(() => { sim.fmc.crzAltFt = 33000; sim.debug.api.afdsAction(sim, 'ALT_SET', 33000); });
    await page.click('#mcp button[aria-label="LNAV"]');
    await page.click('#mcp button[aria-label="VNAV"]');
    await run(page, 2);
    s = await snap(page);
    check('LNAV/VNAV engaged or armed', /LNAV/.test(s.fma) && /VNAV/.test(s.fma), s.fma);
    // LNAV only engages within 2.5 nm of the route: DIRECT TO the active waypoint through the CDU
    // (LEGS page, ident into the scratchpad, LSK 1L, EXEC).
    const xtk0 = await page.evaluate(() => Math.abs(sim.fmc.xtkM));
    const wpt = await page.evaluate(() => sim.fmc.route[sim.fmc.activeLeg]?.ident);
    await page.keyboard.press('Digit3');
    await page.click('#drawer-cdu button[aria-label="LEGS"]');
    await page.focus('#drawer-cdu .cdu-bezel');
    await page.keyboard.type(wpt);
    await page.click('#drawer-cdu button[aria-label="Line select key 1left"]');
    await page.click('#drawer-cdu button[aria-label="EXEC"]');
    await page.evaluate(() => sim.debug.renderAll(0));
    await shot(page, 'cdu-legs');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Digit3');
    check(`CDU DIRECT TO ${wpt} executed`, await page.evaluate(() => !sim.fmc.mod && Math.abs(sim.fmc.xtkM) < 200), await page.evaluate(() => `xtk ${sim.fmc.xtkM.toFixed(0)} m, mod ${!!sim.fmc.mod}, scratch ${document.querySelector('#drawer-cdu .cdu-screen')?.lastChild?.textContent}`));
    await run(page, 150, 1 / 30, 1);
    s = await snap(page);
    const nav = await page.evaluate(() => ({ xtk: sim.fmc.xtkM, leg: sim.fmc.activeLeg, wp: sim.fmc.route[sim.fmc.activeLeg]?.ident, dtk: sim.fmc.dtkRad * 57.3 }));
    check('LNAV active and tracking route', /\|LNAV\|/.test(s.fma) && Math.abs(nav.xtk) < Math.max(1500, xtk0), `xtk ${xtk0.toFixed(0)} -> ${nav.xtk.toFixed(0)} m, to ${nav.wp}, ${s.fma}`);
    check('VNAV climbing', /VNAV/.test(s.fma) && s.altFt > 6300, `${s.altFt} ft ${s.vsFpm} fpm ${s.fma}`);
    check('no crash / NaN in flight', !s.crashed && finite(s));
    await shot(page, 'cockpit-air-ap');
    // ND/PFD rendered something non-black
    const lit = await page.evaluate(() => ['pfd', 'nd', 'eicas'].map((id) => {
      const c = document.querySelector(`#${id} canvas`); if (!c) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
      return n;
    }));
    check('PFD/ND/EICAS canvases drawn', lit.every((n) => n > 20), lit.join(','));
  }

  // ---------------------------------------------------------------- 6 views / drawers / pause
  if (want(6) || want(7)) {
    scenario = '6 Views & UI';
    console.log('\n[6] Views, drawers, pause');
    const errBefore = relevantErrors(errors).length;
    const modes = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('KeyC');
      await page.evaluate(() => sim.debug.renderAll(0.1));
      modes.push(await page.evaluate(() => sim.view.mode + (document.body.classList.contains('view-' + sim.view.mode) ? '' : '!')));
      if (modes[i].startsWith('chase')) await shot(page, 'chase');
      if (modes[i].startsWith('flyby')) await shot(page, 'flyby');
      if (modes[i].startsWith('tower')) await shot(page, 'tower');
    }
    check('C cycles chase/flyby/tower/cockpit', modes.join(',') === 'chase,flyby,tower,cockpit', modes.join(','));
    const names = ['overhead', 'pedestal', 'cdu', 'lower'];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(`Digit${i + 1}`);
      await wait(400);
      const open = await page.evaluate(() => ['overhead', 'pedestal', 'cdu', 'lower'].filter((n) => document.getElementById('drawer-' + n).classList.contains('open')));
      check(`key ${i + 1} opens ${names[i]} drawer`, open.includes(names[i]), open.join(','));
      await shot(page, 'drawer-' + names[i]);
      await page.keyboard.press(`Digit${i + 1}`);
      await wait(350);
      check(`key ${i + 1} closes ${names[i]}`, !(await page.evaluate((n) => document.getElementById('drawer-' + n).classList.contains('open'), names[i])));
    }
    // right-side drawers are exclusive
    await page.keyboard.press('Digit1'); await page.keyboard.press('Digit3'); await wait(350);
    const both = await page.evaluate(() => ['overhead', 'cdu'].map((n) => document.getElementById('drawer-' + n).classList.contains('open')));
    check('right drawers exclusive (1 then 3)', !both[0] && both[1], JSON.stringify(both));
    await page.keyboard.press('Digit3'); await wait(300);
    // dock buttons
    await page.click('#drawer-dock [data-drawer="pedestal"]'); await wait(350);
    check('dock button opens pedestal', await page.evaluate(() => document.getElementById('drawer-pedestal').classList.contains('open')));
    await page.click('#drawer-dock [data-drawer="pedestal"]'); await wait(300);
    // V panel toggle
    await page.keyboard.press('KeyV'); await page.evaluate(() => sim.debug.renderAll(0));
    check('V hides panel (HUD shown)', await page.evaluate(() => document.body.classList.contains('panel-hidden') && getComputedStyle(document.getElementById('hud')).display !== 'none'));
    await shot(page, 'cockpit-nopanel');
    await page.keyboard.press('KeyV');
    // Esc pause menu
    await page.evaluate(() => { sim.debug.freeze = false; });
    await page.keyboard.press('Escape'); await wait(800);
    const p1 = await page.evaluate(() => ({ paused: sim.paused, open: sim.menu.isOpen() }));
    check('Esc opens pause menu', p1.paused && p1.open, JSON.stringify(p1));
    await shot(page, 'pause');
    const tp = await page.evaluate(() => sim.time); await wait(2500);
    check('sim does not advance while paused', (await page.evaluate(() => sim.time)) === tp);
    await page.keyboard.press('Escape'); await wait(800);
    const p2 = await page.evaluate(() => ({ paused: sim.paused, open: sim.menu.isOpen() }));
    check('Esc again resumes', !p2.paused && !p2.open, JSON.stringify(p2));
    await page.keyboard.press('Space'); await wait(600);
    const p3 = await page.evaluate(() => ({ paused: sim.paused, open: sim.menu.isOpen() }));
    await page.keyboard.press('Space'); await wait(600);
    const p4 = await page.evaluate(() => ({ paused: sim.paused, open: sim.menu.isOpen() }));
    check('Space pauses and resumes', p3.paused && !p4.paused && !p4.open, JSON.stringify([p3, p4]));
    check('no console errors during UI tests', relevantErrors(errors).length === errBefore, relevantErrors(errors).slice(errBefore, errBefore + 3).join(' | '));
  }
  await ctx.close();
}

// ============================================================ 4: ILS approach + autoland at EGLL 27R
if (want(4)) {
  scenario = '4 Autoland';
  console.log('\n[4] ILS 27R approach & autoland at EGLL');
  const { ctx, page, errors } = await boot({ dep: 'EGLL', rwy: '27R', dest: 'EDDF', destRwy: '25C' });
  await page.evaluate(() => { sim.debug.freeze = 'all'; });
  // Teleport: 8 nm final, 3° glidepath (~2550 ft above the threshold), 160 kt, flaps 30, gear down.
  const init = await page.evaluate(async () => {
    const { initAircraft } = await import('./src/physics/fdm.js');
    const geo = await import('./src/core/geo.js');
    const apt = sim.debug.airports.find((a) => a.icao === 'EGLL');
    const rwy = apt.runways.find((r) => r.id === '27R');
    const DEG = Math.PI / 180, NM = 1852, FT = 0.3048;
    const hdg = rwy.hdgDeg * DEG;
    const p = geo.destination(rwy.lat * DEG, rwy.lon * DEG, hdg + Math.PI, 8 * NM);
    const thrMsl = (rwy.elevFt ?? apt.elevFt) * FT;
    const hMsl = thrMsl + Math.tan(3 * DEG) * (8 * NM + 1000 * FT);
    const f = sim.fmc;
    f.origin = sim.debug.airports.find((a) => a.icao === 'EDDF'); f.depRwy = f.origin.runways.find((r) => r.id === '25C');
    f.dest = apt; f.arrRwy = rwy; f.destRwy = rwy;
    sim.debug.api.buildDefaultRoute(sim, f.origin, apt, { depRwy: f.depRwy, arrRwy: rwy });
    f.wasAirborne = true;
    const c = sim.controls;
    c.flapLever = 6; c.gearLever = 'DOWN'; c.parkingBrake = false; c.autobrake = '3'; c.speedbrakeArmed = true;
    initAircraft(sim, { lat: p.lat, lon: p.lon, h: hMsl + sim.env.geoidN, heading: hdg, onGround: false, speedKt: 160, fuelKg: 20000, payloadKg: 30000 });
    sim.ac.magVar = (apt.magVarDeg || 0) * DEG;
    // go to the FAF: LNAV leg CI/FF/RW
    const i = f.route.findIndex((w) => w.kind === 'FAF');
    if (i > 0) { f.activeLeg = i + 1; }
    const a = sim.debug.api.afdsAction;
    a(sim, 'AP_ENGAGE'); a(sim, 'SPD_SET', 150); if (!sim.ap.atEngaged) a(sim, 'AT');
    a(sim, 'HDG_SET', Math.round(rwy.hdgDeg - (apt.magVarDeg || 0))); a(sim, 'HDG_SEL'); a(sim, 'ALT_SET', 3000);
    return { hMsl, thrMsl, geoidN: sim.env.geoidN, vref: sim.fmc.vref };
  });
  await run(page, 2, 1 / 30, 0.5);
  let s = await snap(page);
  check('in-air spawn on final', !s.og && !s.crashed && Math.abs(s.altFt - 2550 - 80) < 300 && Math.abs(s.kcas - 160) < 10, `${s.altFt} ft ${s.kcas} kt ra ${s.ra} m, ${s.fma}`);
  await page.evaluate(() => sim.debug.renderAll(0));
  await page.click('#mcp button[aria-label="APP"]');
  await run(page, 2);
  s = await snap(page);
  check('APP arms/captures LOC + G/S', /LOC/.test(s.fma) && /G\/S/.test(s.fma), s.fma);
  await run(page, 30, 1 / 30, 0.5);
  s = await snap(page);
  check('LOC and G/S captured', /\|LOC\|G\/S\|/.test(s.fma), `${s.fma} ils ${await page.evaluate(() => `${sim.nav.ils.locDots.toFixed(2)}/${sim.nav.ils.gsDots.toFixed(2)}`)}`);
  await shot(page, 'approach');
  const seen = { land3: false, flare: false, rollout: false, ab: false, maxDev: 0 };
  const log = [];
  for (let i = 0; i < 600; i++) {
    await run(page, 0.5, 1 / 30, 0.5);
    s = await snap(page);
    const ils = await page.evaluate(() => [sim.nav.ils.locDots, sim.nav.ils.gsDots, sim.surfaces.autobrakeState, sim.ac.ra / 0.3048]);
    if (/LAND 3/.test(s.fma)) seen.land3 = true;
    if (/FLARE/.test(s.fma)) seen.flare = true;
    if (/ROLLOUT/.test(s.fma)) seen.rollout = true;
    if (ils[2] === 'ACTIVE') seen.ab = true;
    if (ils[3] > 200 && /G\/S/.test(s.fma)) seen.maxDev = Math.max(seen.maxDev, Math.abs(ils[0]), Math.abs(ils[1]));
    if (i % 20 === 0) log.push(`${s.t}s ${s.altFt}ft ra${Math.round(ils[3])} ${s.kcas}kt vs${s.vsFpm} ${s.fma} loc${ils[0].toFixed(2)} gs${ils[1].toFixed(2)}`);
    if (s.crashed || (s.og && s.gsKt < 5)) break;
  }
  console.log('   ' + log.join('\n   '));
  const td = await page.evaluate(() => __ev.filter((e) => /Touchdown|HARD|CRASH/.test(e.toast || '')).map((e) => e.toast));
  check('LAND 3 annunciated', seen.land3);
  check('FLARE engaged', seen.flare);
  check('ROLLOUT engaged', seen.rollout);
  check('autobrake activated', seen.ab);
  check('stays within 1 dot on LOC/GS above 200 ft', seen.maxDev < 1, `max ${seen.maxDev.toFixed(2)} dots`);
  check('landed and stopped, no crash', s.og && s.gsKt < 5 && !s.crashed, `gs ${s.gsKt} ${s.reason} ${td.join(',')}`);
  const tdFpm = Number((td.find((t) => /Touchdown|HARD/.test(t)) || '').match(/(\d+) fpm/)?.[1]);
  check('soft touchdown (< 400 fpm)', tdFpm < 400, td.join(','));
  const pos = await page.evaluate(() => { const r = sim.fmc.arrRwy; const geo = sim.nav.ils; return { locDevM: geo.locDevM, distNm: geo.distNm }; });
  check('stopped on the runway centreline', Math.abs(pos.locDevM) < 15, `lateral ${pos.locDevM.toFixed(1)} m, ${pos.distNm.toFixed(2)} nm from thr`);
  const aur = await page.evaluate(() => [...new Set(__ev.filter((e) => e.id).map((e) => e.id))]);
  for (const id of ['ra1000', 'ra500', 'ra100', 'ra50', 'ra30', 'ra10', 'approaching_minimums', 'minimums']) check(`aural '${id}'`, aur.includes(id));
  check('no GPWS/caution aurals on a stable approach', !aur.some((a) => /pull_up|sink_rate|glideslope|too_low|master_warning|config|ap_disc/.test(a)), aur.join(','));
  await shot(page, 'rollout');
  check('no console errors', relevantErrors(errors).length === 0, relevantErrors(errors).slice(0, 3).join(' | '));
  await ctx.close();
}

// ============================================================ 5: cold & dark start through the UI
if (want(5)) {
  scenario = '5 Cold & dark';
  console.log('\n[5] Cold & dark start');
  const { ctx, page, errors } = await boot({ coldDark: true });
  await page.evaluate(() => { sim.debug.freeze = 'all'; });
  let st = await page.evaluate(() => ({ e: sim.engines.map((e) => e.startState), n2: sim.engines.map((e) => e.n2), dc: sim.systems.elec?.dcPowered }));
  check('cold & dark: engines off, no DC', st.e.every((x) => x === 'OFF') && st.n2.every((x) => x < 1) && !st.dc, JSON.stringify(st));
  await page.keyboard.press('Digit1'); await wait(400);
  await page.click('#drawer-overhead button[aria-label="BATTERY "]');
  await run(page, 1);
  check('BATTERY on -> DC powered', await page.evaluate(() => !!sim.systems.elec.dcPowered));
  const apuKnob = page.locator('#drawer-overhead [role="slider"][aria-label="APU"]');
  await apuKnob.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await run(page, 1);
  check('APU selector START', await page.evaluate(() => ['START', 'ON'].includes(sim.systems.apu.selector) && sim.systems.apu.state !== 'OFF'), await page.evaluate(() => `${sim.systems.apu.selector}/${sim.systems.apu.state}`));
  for (let i = 0; i < 12 && !(await page.evaluate(() => sim.systems.apu.state === 'RUN')); i++) await run(page, 10, 1 / 15, 2);
  check('APU running', await page.evaluate(() => sim.systems.apu.state === 'RUN'), await page.evaluate(() => `${sim.systems.apu.state} N ${sim.systems.apu.n?.toFixed?.(0)}`));
  // bleed: make sure APU bleed is on
  if (!(await page.evaluate(() => sim.systems.air.apuBleed))) await page.click('#drawer-overhead button[aria-label="APU BLEED "]');
  await run(page, 3);
  check('duct pressure from APU', await page.evaluate(() => sim.systems.air.ductPsi >= 20), await page.evaluate(() => `${sim.systems.air.ductPsi?.toFixed?.(0)} psi ${sim.systems.air.ductSrc}`));
  await shot(page, 'overhead-apu');
  for (const [i, side] of [[1, 'R'], [0, 'L']]) {
    await page.keyboard.press('Digit1'); await wait(100);
    if (!(await page.evaluate(() => document.getElementById('drawer-overhead').classList.contains('open')))) await page.keyboard.press('Digit1');
    const k = page.locator(`#drawer-overhead [role="slider"][aria-label="START ${side}"]`);
    await k.focus(); await page.keyboard.press('ArrowRight');
    await run(page, 1);
    check(`START ${side} selected -> STARTING`, await page.evaluate((j) => sim.engines[j].startState === 'STARTING', i), await page.evaluate((j) => sim.engines[j].startState, i));
    await run(page, 8, 1 / 15, 2);
    await page.keyboard.press('Digit2'); await wait(400);
    await page.click(`#drawer-pedestal [aria-label="Fuel control switch ${side}"]`);
    check(`fuel control ${side} RUN`, await page.evaluate((j) => sim.controls.fuelControl[j] === 'RUN', i));
    for (let t = 0; t < 10 && !(await page.evaluate((j) => sim.engines[j].startState === 'RUN', i)); t++) await run(page, 10, 1 / 15, 2);
    const e = await page.evaluate((j) => ({ s: sim.engines[j].startState, n2: sim.engines[j].n2, n1: sim.engines[j].n1, egt: sim.engines[j].egt }), i);
    check(`engine ${side} RUN`, e.s === 'RUN' && e.n2 > 50, JSON.stringify(e));
    await page.keyboard.press('Digit2'); await wait(300);
  }
  await run(page, 20, 1 / 15, 2);
  const fin = await page.evaluate(() => ({ e: sim.engines.map((e) => [e.startState, +e.n1.toFixed(1), +e.n2.toFixed(1), Math.round(e.egt)]), gens: sim.systems.elec?.sources, ac: sim.ac.onGround && !sim.ac.crashed }));
  check('both engines stable at idle', fin.e.every((x) => x[0] === 'RUN' && x[2] > 55 && x[2] < 75) && fin.ac, JSON.stringify(fin));
  await shot(page, 'cold-dark-done');
  check('no console errors', relevantErrors(errors).length === 0, relevantErrors(errors).slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();

// ------------------------------------------------------------------ report
const fails = results.filter((r) => !r.ok);
console.log('\n================ E2E REPORT ================');
let cur = '';
for (const r of results) {
  if (r.scenario !== cur) { cur = r.scenario; const sc = results.filter((x) => x.scenario === cur); console.log(`${cur}: ${sc.filter((x) => x.ok).length}/${sc.length}`); }
  if (!r.ok) console.log(`   FAIL ${r.name}  ${r.detail}`);
}
console.log(`TOTAL ${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
