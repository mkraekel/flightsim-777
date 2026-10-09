// Canvas 2D helpers shared by all glass-cockpit displays (PFD, ND, EICAS, ISFD, lower EICAS).
// Every display draws in a fixed *virtual* coordinate space (default 1000 x 1000 units) that is
// mapped onto a square, letterboxed, devicePixelRatio-sharp canvas inside its host element.
// Colors and fonts come from the CSS design tokens in styles/base.css.

const FALLBACK = {
  white: '#ffffff', green: '#3dff4a', magenta: '#ff3dff', cyan: '#3dfbff', amber: '#ffb000',
  red: '#ff2b2b', sky: '#1f78d6', ground: '#8a5a2b', grey: '#6f7378', glass: '#000000',
  font: "'B612', 'Arial Narrow', Arial, sans-serif",
  mono: "'B612 Mono', Consolas, monospace",
};

/** Display color palette (resolved once from CSS variables). */
export const C = { ...FALLBACK };
let tokensLoaded = false;

/** Read the avionics tokens from :root (call after stylesheets are applied). */
export function loadTokens() {
  if (tokensLoaded || typeof document === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
  C.white = get('--av-white', FALLBACK.white);
  C.green = get('--av-green', FALLBACK.green);
  C.magenta = get('--av-magenta', FALLBACK.magenta);
  C.cyan = get('--av-cyan', FALLBACK.cyan);
  C.amber = get('--av-amber', FALLBACK.amber);
  C.red = get('--av-red', FALLBACK.red);
  C.sky = get('--av-sky', FALLBACK.sky);
  C.ground = get('--av-ground', FALLBACK.ground);
  C.grey = get('--av-grey', FALLBACK.grey);
  C.glass = get('--glass', FALLBACK.glass);
  C.font = get('--font-avionics', FALLBACK.font);
  C.mono = get('--font-avionics-mono', FALLBACK.mono);
  // Derived shades (tape backgrounds etc.)
  C.tape = 'rgba(111,115,120,0.55)';
  C.dark = '#101214';
  tokensLoaded = !!cs.getPropertyValue('--av-white');
}

const fontCache = new Map();
/** Canvas font string for the avionics font at `size` virtual units. */
export function font(size, bold = false, mono = false) {
  const key = `${size}|${bold}|${mono}`;
  let f = fontCache.get(key);
  if (!f) { f = `${bold ? '700 ' : ''}${size}px ${mono ? C.mono : C.font}`; fontCache.set(key, f); }
  return f;
}
export function clearFontCache() { fontCache.clear(); }

/**
 * Create a square, letterboxed, DPR-crisp canvas in `el`.
 * draw(ctx, W, H) is called by render(); the context is pre-scaled to virtual units.
 * Returns { canvas, render(), resize(), visible(), destroy(), W, H }.
 */
export function createDisplay(el, draw, { W = 1000, H = 1000, square = true, className = 'av-canvas' } = {}) {
  loadTokens();
  const canvas = document.createElement('canvas');
  canvas.className = className;
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let scale = 1, dpr = 1, dirty = true;

  function resize() {
    const r = el.getBoundingClientRect();
    const cw = Math.max(1, r.width), ch = Math.max(1, r.height);
    let w, h;
    if (square) { const s = Math.min(cw, ch * (W / H)); w = s; h = s * (H / W); }
    else { w = cw; h = ch; }
    w = Math.floor(w); h = Math.floor(h);
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    scale = canvas.width / W;
    api.W = W; api.H = square ? H : (canvas.height / scale);
    dirty = true;
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { resize(); api.render(); }) : null;
  if (ro) ro.observe(el);

  const api = {
    canvas, ctx, W, H,
    // getClientRects() (not offsetParent) so position:fixed drawers still count as visible
    visible() { return el.isConnected && el.getClientRects().length > 0 && el.clientWidth > 0 && el.clientHeight > 0; },
    render() {
      if (!api.visible()) return false;
      if (dirty && canvas.width <= 1) resize();
      dirty = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.glass;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      try { draw(ctx, api.W, api.H); } catch (e) { if (!api._err) { console.error('display draw', e); api._err = true; } }
      return true;
    },
    resize,
    destroy() { if (ro) ro.disconnect(); canvas.remove(); },
  };
  resize();
  return api;
}

// ---------------------------------------------------------------- primitives

/** Draw text. opts: {color, size, bold, align, base, mono} */
export function text(ctx, str, x, y, color = C.white, size = 28, align = 'left', base = 'middle', bold = false, mono = false) {
  ctx.font = font(size, bold, mono);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(str, x, y);
}

/** Text width in virtual units. */
export function textW(ctx, str, size = 28, bold = false) {
  ctx.font = font(size, bold);
  return ctx.measureText(str).width;
}

export function line(ctx, x1, y1, x2, y2, color = C.white, w = 3) {
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

export function poly(ctx, pts, { stroke = null, fill = null, w = 3, close = true } = {}) {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  if (close) ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = w; ctx.stroke(); }
}

export function rect(ctx, x, y, w, h, { stroke = null, fill = null, lw = 3 } = {}) {
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.strokeRect(x, y, w, h); }
}

export function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function circle(ctx, x, y, r, { stroke = null, fill = null, w = 3 } = {}) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = w; ctx.stroke(); }
}

/** Diagonal hatch fill inside a rectangle (barber poles, gear transit, ground band). */
export function hatch(ctx, x, y, w, h, color, bg = null, step = 14, lw = 5, dir = 1) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, h); }
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.beginPath();
  for (let i = -h - step; i < w + h + step; i += step) {
    if (dir > 0) { ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); }
    else { ctx.moveTo(x + i, y); ctx.lineTo(x + i + h, y + h); }
  }
  ctx.stroke();
  ctx.restore();
}

/** Rectangle with black fill + stroke (readout boxes). */
export function box(ctx, x, y, w, h, color = C.white, lw = 3, fill = '#000') {
  rect(ctx, x, y, w, h, { fill, stroke: color, lw });
}

// ---------------------------------------------------------------- numbers / units

export const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
export const pad = (n, len, ch = '0') => String(n).padStart(len, ch);
/** Format heading in degrees 001..360 (Boeing shows 360 for north). */
export const fmtHdg = (deg) => { let d = Math.round(((fin(deg) % 360) + 360) % 360); if (d === 0) d = 360; return pad(d, 3); };
export const wrapDeg = (d) => ((fin(d) % 360) + 360) % 360;
export const wrap180 = (d) => { d = wrapDeg(d); return d > 180 ? d - 360 : d; };

/** Flashing helper: true during the 'on' half of a period (s), using wall clock. */
export const blink = (period = 0.5) => (performance.now() / 1000 / period) % 2 < 1;
