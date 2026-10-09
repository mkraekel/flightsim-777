// Team B screenshot test: menu, cockpit view, chase view at EDDF.
// Usage: python3 -m http.server 8777 (in flightsim-777/), then
//   NODE_PATH=$(npm root -g) node tests/world-shots.mjs [baseUrl]
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
// Route only https through the agent proxy so the local http server is reached directly.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) args.push(`--proxy-server=https=${proxy.replace(/^https?:\/\//, '')}`);
const browser = await chromium.launch({ executablePath: findChrome(), args });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error' || m.type() === 'warning') console.log(t.slice(0, 300)); });
page.on('pageerror', (e) => { logs.push(`[pageerror] ${e.message}`); console.log('[pageerror]', e.message); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* */ } });
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2500);
await page.screenshot({ path: path.join(OUT, 'world-menu.png') });

// help sheet
await page.click('#menu [data-act="help"]');
await wait(300);
await page.screenshot({ path: path.join(OUT, 'world-help.png') });
await page.keyboard.press('Escape');
await page.click('#menu [data-act="help-close"]').catch(() => {});

await page.selectOption('#m-dep', 'EDDF');
await page.selectOption('#m-dep-rwy', '25C');
await page.click(`#m-q [data-v="${process.env.QUALITY || 'low'}"]`);
await page.click('#menu [data-act="start"]');
const t0 = Date.now();
await page.waitForFunction(() => window.sim?.world?.status === 'running', null, { timeout: 120000 });
console.log('spawned after', (Date.now() - t0) / 1000, 's');
const tilesReady = () => page.waitForFunction(() => window.__globeDebug?.viewer?.scene.globe.tilesLoaded, null, { timeout: 90000, polling: 1000 }).catch(() => console.log('tiles not fully loaded'));
await tilesReady();
await wait(Number(process.env.SETTLE || 3000));
const info = await page.evaluate(() => ({
  ac: { lat: sim.ac.lat * 57.2958, lon: sim.ac.lon * 57.2958, h: sim.ac.h, hdg: sim.ac.euler.heading * 57.2958 },
  env: { groundH: sim.env.groundH, geoidN: sim.env.geoidN, valid: sim.env.groundValid },
  model: sim.world.model, scenery: sim.world.scenery, loaded: sim.debug.loaded,
}));
console.log(JSON.stringify(info));
await page.screenshot({ path: path.join(OUT, 'world-cockpit.png') });

await page.evaluate(() => { sim.view.mode = 'chase'; });
await wait(3000); await tilesReady();
await page.screenshot({ path: path.join(OUT, 'world-chase.png') });

await page.evaluate(() => { sim.view.lookYaw = Math.PI / 2; sim.view.lookPitch = 0.1; });
await wait(3000); await tilesReady();
await page.screenshot({ path: path.join(OUT, 'world-chase-side.png') });

await page.evaluate(() => { sim.view.mode = 'tower'; sim.view.lookYaw = 0; sim.view.lookPitch = 0; });
await wait(3000); await tilesReady();
await page.screenshot({ path: path.join(OUT, 'world-tower.png') });

await page.evaluate(() => { sim.view.mode = 'cockpit'; document.getElementById('drawer-pedestal').classList.add('open'); });
await wait(1500);
await page.screenshot({ path: path.join(OUT, 'world-drawer.png') });

fs.writeFileSync(path.join(OUT, 'world-console.log'), logs.join('\n'));
await browser.close();
