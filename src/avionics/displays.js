// Display manager: creates the captain PFD/ND, upper & lower EICAS, ISFD and the EFIS control panel,
// and redraws them at ~30 Hz (wall clock), skipping elements that are hidden.
import { createPFD } from './pfd.js';
import { createND } from './nd.js';
import { createEICAS, createLowerEICAS } from './eicas.js';
import { createISFD } from './isfd.js';
import { initEfisPanel } from './efisPanel.js';
import { loadTokens, clearFontCache } from './gfx.js';

const FRAME_MS = 1000 / 30;
let displays = [];
let efis = null;
let lastDraw = -Infinity;

export function initDisplays(sim, { pfdEl, ndEl, eicasEl, lowerEl, isfdEl, efisEl } = {}) {
  loadTokens();
  displays = [];
  const add = (el, make) => {
    if (!el) return;
    el.classList.add('av-host');
    try { displays.push(make(el, sim)); } catch (e) { console.error('display init', e); }
  };
  add(pfdEl, createPFD);
  add(ndEl, createND);
  add(eicasEl, createEICAS);
  add(isfdEl, createISFD);
  if (lowerEl) { lowerEl.classList.add('av-lower'); try { displays.push(createLowerEICAS(lowerEl, sim)); } catch (e) { console.error('lower EICAS init', e); } }
  if (efisEl) { try { efis = initEfisPanel(sim, efisEl); } catch (e) { console.error('EFIS panel init', e); } }
  // Redraw once the avionics font (B612) is ready so the first frames are not in a fallback font.
  if (typeof document !== 'undefined' && document.fonts) {
    const redraw = () => { clearFontCache(); displays.forEach((d) => { d.resize(); d.render(); }); };
    document.fonts.load('32px B612').then(redraw, () => {});
    document.fonts.ready.then(redraw, () => {});
  }
  displays.forEach((d) => d.render());
}

/** Throttled to ~30 Hz on wall-clock time so it also works when paused or time-accelerated. */
export function updateDisplays(sim, dt) {
  const now = performance.now();
  if (now - lastDraw < FRAME_MS - 2) return;
  lastDraw = now;
  for (const d of displays) d.render();   // render() itself skips hidden elements
  if (efis) efis.update();
}
