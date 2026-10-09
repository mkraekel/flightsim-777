// iPad / touch test: emulated iPad (1180×820, touch, DPR 2). Screenshots in tests/shots/ipad-*.png,
// multi-touch drags on the yoke pad + thrust lever (CDP touch events), button taps, drawers.
// Usage: python3 -m http.server 8777 (in flightsim-777/), then
//   NODE_PATH=$(npm root -g) node tests/ipad-shots.mjs [baseUrl]
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:8777/';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'shots');
fs.mkdirSync(OUT, { recursive: true });

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
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: false, ignoreHTTPSErrors: true,
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error') console.log(t.slice(0, 300)); });
page.on('pageerror', (e) => { logs.push(`[pageerror] ${e.message}`); console.log('[pageerror]', e.message); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `ipad-${name}.png`), timeout: 180000 });
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

// --- CDP multi-touch helper
const cdp = await ctx.newCDPSession(page);
const touches = new Map();   // id -> {x,y}
async function touch(type, id, x, y) {
  // CDP: the point list is the full set of active fingers; points missing from a touchMove are released
  if (type === 'touchEnd') touches.delete(id); else touches.set(id, { x, y, id });
  const pts = [...touches.values()].map((t) => ({ x: t.x, y: t.y, id: t.id }));
  if (type === 'touchEnd') await cdp.send('Input.dispatchTouchEvent', pts.length ? { type: 'touchMove', touchPoints: pts } : { type: 'touchEnd', touchPoints: [] });
  else await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
}
async function drag(id, from, to, steps = 6) {
  await touch('touchStart', id, from.x, from.y);
  for (let i = 1; i <= steps; i++) await touch('touchMove', id, from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
}
const center = async (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, sel);
const ctl = () => page.evaluate(() => ({ ...sim.controls, throttle: [...sim.controls.throttle], reverse: [...sim.controls.reverse] }));

// ------------------------------------------------------------------ menu
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* */ } });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'emulated pointer is coarse');
await shot('menu');
const menuScroll = await page.evaluate(() => { const m = document.querySelector('#menu .menu-shell'); return { sh: m.scrollHeight, ch: m.clientHeight }; });
console.log('menu scroll', menuScroll);
await page.setViewportSize({ width: 1024, height: 768 });
await wait(500);
await shot('menu-1024');
await page.evaluate(() => { const m = document.querySelector('#menu .menu-shell'); m.scrollTop = m.scrollHeight; });
await wait(300);
await shot('menu-1024-scrolled');
await page.setViewportSize({ width: 1180, height: 820 });
await page.evaluate(() => { const m = document.querySelector('#menu .menu-shell'); m.scrollTop = 0; });

await page.selectOption('#m-dep', 'EDDF');
await page.selectOption('#m-dep-rwy', '25C');
await page.tap('#m-q [data-v="low"]');
await page.tap('#menu [data-act="start"]');
await page.waitForFunction(() => window.sim?.world?.status === 'running', null, { timeout: 120000 });
await page.waitForFunction(() => window.__globeDebug?.viewer?.scene.globe.tilesLoaded, null, { timeout: 60000, polling: 1000 }).catch(() => console.log('tiles not fully loaded'));
// SwiftShader is ~1 fps at DPR 2: render the 3D world at reduced resolution in this test only
await page.evaluate(() => { const v = window.__globeDebug?.viewer || sim.world.viewer; if (v) v.resolutionScale = Number(new URLSearchParams(location.search).get('rs') || 0.35); });
await wait(2500);
check(await page.evaluate(() => document.body.classList.contains('touch-ui')), 'touch overlay enabled');
check(await page.evaluate(() => sim.debug.loaded.touch === true), 'touch.js loaded');
await shot('cockpit');

// Headless SwiftShader renders ~1 fps and stalls rAF, so from here on the sim is driven
// deterministically: freeze the rAF loop and step it (30 Hz) / render it explicitly.
await page.evaluate(() => { sim.debug.freeze = 'all'; });
const run = async (ms) => {
  await page.evaluate((n) => { for (let i = 0; i < n; i++) sim.debug.stepSim(1 / 30); }, Math.max(1, Math.round(ms / 1000 * 30)));
  await wait(30);
};
const render = async (times = 1) => { for (let i = 0; i < times; i++) { await page.evaluate(() => { sim.debug.renderAll(0.03); }); await wait(times > 1 ? 400 : 20); } };
const shotR = async (name, times = 1) => { await render(times); await shot(name); };

// ------------------------------------------------------------------ yoke + lever (multi-touch)
const pad = await center('#touch-ui .tc-pad');
const lever = await center('#touch-ui .tc-thr-knob');
const trk = await center('#touch-ui .tc-thr-track');
const c0 = await ctl();
await drag(1, pad, { x: pad.x + pad.w * 0.3, y: pad.y + pad.h * 0.35 });          // right + down (pull)
await drag(2, lever, { x: lever.x, y: lever.y - trk.h * 0.45 });                   // second finger: thrust up
await run(2500);
await touch('touchMove', 1, pad.x + pad.w * 0.3, pad.y + pad.h * 0.35);
await run(500);
const c1 = await ctl();
await shotR('cockpit-touching');
console.log('controls while touching', { pitch: c1.pitch, roll: c1.roll, thr: c1.throttle });
check(c1.pitch > 0.25, `yoke drag down -> pitch up (${c1.pitch.toFixed(2)})`);
check(c1.roll > 0.2, `yoke drag right -> roll right (${c1.roll.toFixed(2)})`);
check(c1.throttle[0] > c0.throttle[0] + 0.15 && Math.abs(c1.throttle[0] - c1.throttle[1]) < 1e-6, `lever drag up -> both throttles (${c0.throttle[0].toFixed(2)} -> ${c1.throttle[0].toFixed(2)})`);
await touch('touchEnd', 1);
await touch('touchEnd', 2);
await run(3000);
const c2 = await ctl();
check(Math.abs(c2.pitch) < 0.05 && Math.abs(c2.roll) < 0.05, `yoke springs back (${c2.pitch.toFixed(3)}, ${c2.roll.toFixed(3)})`);
check(Math.abs(c2.throttle[0] - c1.throttle[0]) < 0.08, `lever stays after release (${c2.throttle[0].toFixed(2)})`);

// back to idle, then into reverse (on ground)
const lever2 = await center('#touch-ui .tc-thr-knob');
await drag(3, lever2, { x: lever2.x, y: trk.y + trk.h / 2 - 2 }, 8);
await run(2000);
await touch('touchEnd', 3);
const c3 = await ctl();
check(c3.throttle[0] < 0.03, `lever back to idle (${c3.throttle[0].toFixed(3)})`);
const lever3 = await center('#touch-ui .tc-thr-knob');
await drag(4, lever3, { x: lever3.x, y: trk.y + trk.h / 2 + 4 }, 8);
await run(2500);
const c4 = await ctl();
check(c4.reverse[0] > 0.3, `reverse zone below idle on ground (${c4.reverse[0].toFixed(2)})`);
await shotR('cockpit-reverse');
await touch('touchEnd', 4);
await page.evaluate(() => { sim.controls.reverse = [0, 0]; sim.controls.throttle = [0, 0]; });

// ------------------------------------------------------------------ buttons
const flap0 = (await ctl()).flapLever;
await page.tap('#touch-ui [data-act="flapDn"]');
await run(400);
check((await ctl()).flapLever === Math.min(6, flap0 + 1), `flaps + (${flap0} -> ${(await ctl()).flapLever})`);
await page.tap('#touch-ui [data-act="flapUp"]');
await run(400);
check((await ctl()).flapLever === flap0, 'flaps −');
const pb0 = (await ctl()).parkingBrake;
await page.tap('#touch-ui [data-act="park"]');
await run(400);
check((await ctl()).parkingBrake === !pb0, 'parking brake toggles');
// hold rudder + brakes together
const rud = await center('#touch-ui [data-hold="rudR"]');
const brk = await center('#touch-ui [data-hold="brake"]');
await touch('touchStart', 5, rud.x, rud.y);
await touch('touchStart', 6, brk.x, brk.y);
await run(2000);
const c5 = await ctl();
check(c5.yaw > 0.3, `rudder R hold (${c5.yaw.toFixed(2)})`);
check(c5.brakeL > 0.5, `brakes hold (${c5.brakeL.toFixed(2)})`);
await touch('touchEnd', 5); await touch('touchEnd', 6);
await run(2000);
const c6 = await ctl();
check(Math.abs(c6.yaw) < 0.1, `rudder recentres (${c6.yaw.toFixed(2)})`);
// trim
const tr = await center('#touch-ui [data-hold="trimUp"]');
await touch('touchStart', 7, tr.x, tr.y);
await run(800);
check((await ctl()).trimSwitch === 1, 'trim nose up while held');
await touch('touchEnd', 7);
await run(800);
check((await ctl()).trimSwitch === 0, 'trim switch released');
// A/P engage
await page.tap('#touch-ui [data-act="ap"]');
await run(800);
console.log('AP engaged after tap:', await page.evaluate(() => sim.ap.apEngaged));

// ------------------------------------------------------------------ drawers
for (const name of ['overhead', 'cdu', 'pedestal', 'lower']) {
  await page.tap(`#drawer-dock [data-drawer="${name}"]`);
  await run(500); await wait(700);   // CSS slide-in transition (real time)
  check(await page.evaluate((n) => document.getElementById(`drawer-${n}`).classList.contains('open'), name), `${name} drawer opens by tap`);
  await shotR(`drawer-${name}`);
  await page.tap(`#drawer-${name} > .drawer-close`);
  await wait(400);
  check(!(await page.evaluate((n) => document.getElementById(`drawer-${n}`).classList.contains('open'), name)), `${name} drawer closes with ✕`);
}
// CDU key by tap
await page.tap('#drawer-dock [data-drawer="cdu"]');
await run(1000);
const key = await page.$('#drawer-cdu button');
if (key) { await key.tap(); check(true, 'CDU key tappable'); }
await page.tap('#drawer-cdu > .drawer-close');

// ------------------------------------------------------------------ views
await page.tap('#touch-ui [data-act="view"]');
await run(3500);
check(await page.evaluate(() => sim.view.mode === 'chase'), 'VIEW button -> chase');
await shotR('chase', 10);
// one-finger look-around on the outside view
const y0 = await page.evaluate(() => sim.view.lookYaw);
await drag(8, { x: 590, y: 300 }, { x: 700, y: 300 });
await touch('touchEnd', 8);
check(Math.abs((await page.evaluate(() => sim.view.lookYaw)) - y0) > 0.2, 'touch look-around');
await page.evaluate(() => { sim.view.mode = 'cockpit'; sim.view.lookYaw = 0; sim.view.lookPitch = 0; });
await run(2000);

// other iPad sizes
for (const [w, hgt] of [[1024, 768], [1366, 1024]]) {
  await page.setViewportSize({ width: w, height: hgt });
  await run(3000);
  await shotR(`cockpit-${w}`, 4);
  const over = await page.evaluate(() => {
    const p = document.querySelector('#touch-ui .tc-pad').getBoundingClientRect();
    const t = document.querySelector('#touch-ui .tc-thr').getBoundingClientRect();
    const ck = document.getElementById('main-panel').getBoundingClientRect();
    const g = document.getElementById('glareshield').getBoundingClientRect();
    return { padBottom: p.bottom, thrBottom: t.bottom, panelTop: g.top, padTop: p.top, scrollW: document.documentElement.scrollWidth, mp: ck.height };
  });
  check(over.padBottom <= over.panelTop + 1 && over.thrBottom <= over.panelTop + 1 && over.padTop > 50, `${w}x${hgt}: controls above the panel ${JSON.stringify(over)}`);
}
await page.setViewportSize({ width: 820, height: 1180 });
await run(1200);
await shotR('portrait');
check(await page.evaluate(() => getComputedStyle(document.getElementById('rotate-hint')).display !== 'none'), 'portrait shows rotate hint');

fs.writeFileSync(path.join(OUT, 'ipad-console.log'), logs.join('\n'));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
