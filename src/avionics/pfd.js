// Boeing 777 Primary Flight Display, drawn on a 1000x1000 virtual canvas.
// Layout (left->right): speed tape | attitude (ADI) | altitude tape | V/S. FMA strip on top,
// heading arc at the bottom. All values come from the shared sim state (SI) and are converted here.
import { KT, FT, FPM, RAD, G0, clamp, lag } from '../core/geo.js';
import {
  C, createDisplay, text, textW, line, poly, rect, roundRectPath, circle, hatch, box,
  fin, pad, fmtHdg, wrapDeg, wrap180, blink,
} from './gfx.js';

// ---------------------------------------------------------------- geometry (virtual units)
const CX = 480, CY = 430;                 // attitude centre
const ADI = { x: 262, y: 168, w: 436, h: 520, r: 34 };
const PX_DEG = 8.6;                       // pitch scaling (units per degree)
const SPD = { x: 108, y: 168, w: 100, h: 520, kt: 4.4 };   // speed tape, units per kt
const ALT = { x: 750, y: 168, w: 118, h: 520, ft: 0.54 };  // altitude tape, units per ft
const VSI = { x: 892, y: 228, w: 76, h: 404 };
const HDG = { cx: CX, cy: 1215, r: 420 };
const FMA = { x: 214, y: 6, w: 532, h: 92 };

// ---------------------------------------------------------------- performance helpers
const S_WING = 436.8;                     // m², 777-300ER reference area
const CLMAX = [[0, 1.45], [1, 1.6], [5, 1.75], [15, 1.95], [20, 2.05], [25, 2.2], [30, 2.4]];
const FLAP_PLACARD = [[0, 330], [1, 255], [5, 235], [15, 215], [20, 195], [25, 185], [30, 170]];
const VMO = 330, MMO = 0.89, VLE = 270;
const MANEUVER_OFS = [[0, 80, 'UP'], [1, 60, '1'], [5, 40, '5'], [15, 20, '15'], [20, 10, '20']];

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/**
 * 1-g stall speed (kt, ≈ CAS/EAS) from mass and flap angle — the single place this is computed.
 * Vs1g = sqrt(2 m g / (rho0 S CLmax(flaps))).
 */
export function stallSpeedKt(massKg, flapsDeg) {
  const m = fin(massKg, 0) > 1000 ? massKg : 250000;
  const cl = interp(CLMAX, clamp(fin(flapsDeg), 0, 30));
  return Math.sqrt((2 * m * G0) / (1.225 * S_WING * cl)) / KT;
}

/** CAS (kt) corresponding to a Mach number at a pressure altitude (m), ISA. */
export function casForMach(mach, hM) {
  const h = clamp(fin(hM), -500, 20000);
  const T = h < 11000 ? 288.15 - 0.0065 * h : 216.65;
  const p = h < 11000 ? 101325 * Math.pow(T / 288.15, 5.25588) : 22632 * Math.exp(-(h - 11000) / 6341.6);
  const qc = p * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  return 661.47 * Math.sqrt(5 * (Math.pow(qc / 101325 + 1, 2 / 7) - 1));
}

/** Altitude the altimeter shows (ft) for the current baro setting. */
export function indicatedAltFt(sim) {
  const env = sim.env || {};
  const setting = env.baroStd ? 1013.25 : fin(env.baroHpa, 1013.25);
  return fin(sim.ac.altMSL) / FT + (setting - fin(env.qnhHpa, 1013.25)) * 27.3;
}

// ---------------------------------------------------------------- data extraction
function readData(sim, st) {
  const ac = sim.ac, ap = sim.ap || {}, efis = sim.efis || {}, surf = sim.surfaces || {};
  const magVarDeg = fin(ac.magVar) * RAD;
  const d = {
    cas: Math.max(0, fin(ac.cas) / KT), mach: fin(ac.mach), alt: indicatedAltFt(sim),
    vs: fin(ac.vs) / FPM, pitch: fin(ac.euler?.pitch) * RAD, roll: fin(ac.euler?.roll) * RAD,
    hdg: wrapDeg(fin(ac.euler?.heading) * RAD - magVarDeg), trk: wrapDeg(fin(ac.track) * RAD - magVarDeg),
    ra: fin(ac.ra) / FT, onGround: !!ac.onGround, flaps: fin(surf.flapsDeg), gear: fin(surf.gear, 1),
    fpa: fin(ac.fpa) * RAD, gs: fin(ac.gs) / KT, alpha: fin(ac.alpha) * RAD,
    ay: -fin(ac.specificForce?.[1]) / G0, nz: fin(ac.nz, 1), ap, efis, sim,
  };
  // speed trend: filtered dCAS/dt * 10 s
  const t = fin(sim.time);
  const dt = t - st.lastT;
  if (dt > 0 && dt < 1) st.acc = lag(st.acc, (d.cas - st.lastCas) / dt, 0.8, dt);
  else if (dt !== 0) st.acc = 0;
  st.lastT = t; st.lastCas = d.cas;
  d.trend = d.onGround && d.cas < 30 ? 0 : st.acc * 10;
  // speed limits
  const vs1g = stallSpeedKt(ac.mass, d.flaps);
  d.vref30 = fin(sim.fmc?.vref) > 0 && fin(sim.fmc?.ldgFlaps, 30) === 30 ? sim.fmc.vref : 1.23 * stallSpeedKt(ac.mass, 30);
  d.vss = vs1g * Math.sqrt(clamp(d.nz, 0.6, 2.5)) * 1.03;  // stick shaker
  d.vminMan = d.vss * Math.sqrt(1.3);
  const hP = fin(ac.altMSL);
  let vmax = Math.min(VMO, casForMach(MMO, hP), interp(FLAP_PLACARD, d.flaps));
  if (d.gear > 0.02) vmax = Math.min(vmax, VLE);
  d.vmax = vmax;
  d.vmaxMan = d.alt > 20000 ? Math.min(vmax - 5, casForMach(MMO - 0.03, hP)) : null;
  // selected speed (kt) & display string
  const sel = ap.sel || {};
  const vnavSpd = /VNAV/.test(ap.modes?.pitch || '') && sim.fmc?.vnavTargetSpdKt;
  if (sel.useMach && !vnavSpd) {
    d.selSpd = d.mach > 0.1 ? d.cas * fin(sel.mach, 0.84) / d.mach : casForMach(fin(sel.mach, 0.84), hP);
    d.selSpdTxt = '.' + pad(Math.round(fin(sel.mach) * 1000), 3);
  } else {
    d.selSpd = vnavSpd || fin(sel.spdKt, 250);
    d.selSpdTxt = String(Math.round(d.selSpd));
  }
  // takeoff phase tracking (V1/VR shown until 1500 ft RA)
  if (d.onGround) st.toPhase = true;
  else if (d.ra > 1500) st.toPhase = false;
  d.toPhase = st.toPhase;
  return d;
}

// ---------------------------------------------------------------- attitude
function drawAttitude(ctx, d) {
  ctx.save();
  roundRectPath(ctx, ADI.x, ADI.y, ADI.w, ADI.h, ADI.r);
  ctx.clip();
  ctx.translate(CX, CY);
  ctx.rotate(-d.roll / RAD);
  const py = d.pitch * PX_DEG;
  // sky / ground
  ctx.fillStyle = C.sky; ctx.fillRect(-900, -1600 + py, 1800, 1600);
  ctx.fillStyle = C.ground; ctx.fillRect(-900, py, 1800, 1600);
  line(ctx, -900, py, 900, py, C.white, 3);
  // pitch ladder (2.5° steps, labels every 10°), clipped to a central window
  ctx.save();
  ctx.beginPath(); ctx.rect(-160, -205, 320, 380); ctx.clip();
  for (let p = -90; p <= 90; p += 2.5) {
    if (p === 0) continue;
    const y = py - p * PX_DEG;
    if (y < -200 || y > 168) continue;
    const major = p % 10 === 0, half = p % 5 === 0;
    const w = major ? 82 : half ? 42 : 20;
    line(ctx, -w, y, w, y, C.white, 3);
    if (major) {
      text(ctx, String(Math.abs(p)), -w - 10, y, C.white, 28, 'right');
      text(ctx, String(Math.abs(p)), w + 10, y, C.white, 28, 'left');
    }
  }
  ctx.restore();
  // pitch limit indicator (amber eyebrow) — flaps out
  if (d.flaps > 0.5 && !d.onGround) {
    const aShaker = 14 + d.flaps * 0.08;
    const pli = clamp(d.pitch + (aShaker - d.alpha), d.pitch - 25, d.pitch + 25);
    const y = py - pli * PX_DEG;
    ctx.strokeStyle = C.amber; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-70, y + 18); ctx.lineTo(-50, y); ctx.lineTo(50, y); ctx.lineTo(70, y + 18);
    for (const s of [-1, 1]) for (const xx of [24, 40]) { ctx.moveTo(s * xx, y); ctx.lineTo(s * (xx + 8), y - 14); }
    ctx.moveTo(0, y); ctx.lineTo(0, y - 18);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRollScale(ctx, d) {
  const R = 228;
  ctx.save();
  ctx.translate(CX, CY);
  ctx.strokeStyle = C.white; ctx.lineWidth = 3;
  // fixed arc + ticks
  ctx.beginPath(); ctx.arc(0, 0, R, (-90 - 60) / RAD, (-90 + 60) / RAD); ctx.stroke();
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const len = Math.abs(a) === 30 || Math.abs(a) === 60 ? 30 : 16;
    const r = a / RAD - Math.PI / 2;
    line(ctx, Math.cos(r) * R, Math.sin(r) * R, Math.cos(r) * (R + len), Math.sin(r) * (R + len), C.white, 3);
  }
  // zero index (fixed, hollow triangle)
  poly(ctx, [0, -R, -13, -R - 22, 13, -R - 22], { stroke: C.white, w: 3 });
  // moving pointer + slip/skid
  ctx.rotate(-d.roll / RAD);
  const col = Math.abs(d.roll) > 35 ? C.amber : C.white;
  const fill = Math.abs(d.roll) > 35 ? C.amber : null;
  poly(ctx, [0, -R + 2, -14, -R + 26, 14, -R + 26], { stroke: col, fill, w: 3 });
  const slip = clamp(d.ay * 260, -34, 34);
  const sx = slip;
  const skidCol = Math.abs(d.ay) > 0.12 ? C.amber : col;
  poly(ctx, [sx - 18, -R + 30, sx + 18, -R + 30, sx + 22, -R + 38, sx - 22, -R + 38], { stroke: skidCol, fill: Math.abs(d.ay) > 0.12 ? C.amber : null, w: 3 });
  ctx.restore();
}

function drawAircraftSymbol(ctx) {
  ctx.save();
  ctx.lineWidth = 3; ctx.strokeStyle = C.white; ctx.fillStyle = '#000';
  for (const s of [-1, 1]) {
    const x0 = CX + s * 150, x1 = CX + s * 58;
    ctx.beginPath();
    ctx.moveTo(x0, CY - 7); ctx.lineTo(x1 + s * -7, CY - 7);
    ctx.lineTo(x1 + s * -7, CY + 30); ctx.lineTo(x1 + s * 7, CY + 30);
    ctx.lineTo(x1 + s * 7, CY + 7); ctx.lineTo(x0, CY + 7); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.fillRect(CX - 8, CY - 8, 16, 16); ctx.strokeRect(CX - 8, CY - 8, 16, 16);
  ctx.restore();
}

function drawFD(ctx, d) {
  const ap = d.ap;
  if (!ap.fd?.valid || !ap.fdL) return;
  ctx.save();
  roundRectPath(ctx, ADI.x, ADI.y, ADI.w, ADI.h, ADI.r); ctx.clip();
  const dy = clamp((fin(ap.fd.pitchDeg) - d.pitch) * PX_DEG, -150, 150);
  const dx = clamp((fin(ap.fd.rollDeg) - d.roll) * 4.2, -150, 150);
  ctx.lineCap = 'round';
  line(ctx, CX - 130, CY - dy, CX + 130, CY - dy, '#000', 9);
  line(ctx, CX - 130, CY - dy, CX + 130, CY - dy, C.magenta, 5);
  line(ctx, CX + dx, CY - 130, CX + dx, CY + 130, '#000', 9);
  line(ctx, CX + dx, CY - 130, CX + dx, CY + 130, C.magenta, 5);
  ctx.restore();
}

function drawFPV(ctx, d) {
  if (!d.efis.fpv || d.cas < 40) return;
  const drift = clamp(wrap180(d.trk - d.hdg), -15, 15);
  ctx.save();
  ctx.translate(CX, CY);
  ctx.rotate(-d.roll / RAD);
  const y = (d.pitch - d.fpa) * PX_DEG;
  const x = drift * PX_DEG;
  ctx.rotate(d.roll / RAD);
  // translate in display frame (FPV is earth-referenced relative to pitch scale)
  const xr = x * Math.cos(-d.roll / RAD) - y * Math.sin(-d.roll / RAD);
  const yr = x * Math.sin(-d.roll / RAD) + y * Math.cos(-d.roll / RAD);
  ctx.translate(xr, yr);
  ctx.rotate(-d.roll / RAD);
  for (const [c, w] of [['#000', 7], [C.white, 3]]) {
    circle(ctx, 0, 0, 14, { stroke: c, w });
    line(ctx, -40, 0, -14, 0, c, w); line(ctx, 14, 0, 40, 0, c, w); line(ctx, 0, -14, 0, -30, c, w);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- ILS / RA / minimums
function drawILS(ctx, d) {
  const ils = d.sim.nav?.ils;
  if (!ils?.valid) return;
  // ident block (top-left of ADI)
  const crs = Math.round(wrapDeg(fin(ils.crsRad) * RAD - fin(d.sim.ac.magVar) * RAD));
  text(ctx, `${ils.ident || 'ILS'}/${fin(ils.freq).toFixed(2)}`, ADI.x + 18, ADI.y + 26, C.white, 24);
  text(ctx, `${pad(crs === 0 ? 360 : crs, 3)}°`, ADI.x + 18, ADI.y + 54, C.white, 24);
  text(ctx, `DME ${fin(ils.distNm).toFixed(1)}`, ADI.x + 18, ADI.y + 82, C.white, 24);
  const DOT = 52;
  // localizer (bottom of ADI)
  const ly = ADI.y + ADI.h - 44;
  for (const k of [-2, -1, 1, 2]) circle(ctx, CX + k * DOT, ly, 7, { stroke: C.white, w: 3 });
  line(ctx, CX, ly - 16, CX, ly + 16, C.white, 3);
  const loc = fin(ils.locDots);
  diamond(ctx, CX + clamp(-loc, -2.4, 2.4) * DOT, ly, Math.abs(loc) <= 2.4);
  // glideslope (right side of ADI)
  const gx = ADI.x + ADI.w - 30;
  for (const k of [-2, -1, 1, 2]) circle(ctx, gx, CY + k * DOT, 7, { stroke: C.white, w: 3 });
  line(ctx, gx - 16, CY, gx + 16, CY, C.white, 3);
  const gs = fin(ils.gsDots);
  diamond(ctx, gx, CY + clamp(gs, -2.4, 2.4) * DOT, Math.abs(gs) <= 2.4, true);
}

function diamond(ctx, x, y, filled, vertical = false) {
  const a = vertical ? 13 : 19, b = vertical ? 19 : 13;
  poly(ctx, [x - a, y, x, y - b, x + a, y, x, y + b], { fill: filled ? C.magenta : '#000', stroke: filled ? '#000' : C.magenta, w: filled ? 2 : 3 });
}

function drawRaMins(ctx, d, st) {
  const ef = d.efis;
  const radio = ef.minsType === 'RADIO';
  const mins = fin(ef.minimumsFt, 200);
  // minimums alert: crossing below the minimums while descending
  const ref = radio ? d.ra : d.alt;
  const below = !d.onGround && d.vs < 0 && ref < mins && ref > mins - 1500;
  if (below && !st.minsAlert && st.minsPrevAbove) st.minsT = performance.now();
  if (d.onGround || ref > mins + 75 || fin(ef.minsResetT) > fin(st.minsT)) st.minsAlert = false;
  if (below && !(fin(ef.minsResetT) > fin(st.minsT))) st.minsAlert = true;
  st.minsPrevAbove = ref >= mins;
  const flash = st.minsAlert && performance.now() - fin(st.minsT) < 3000 ? blink(0.25) : true;
  const mc = st.minsAlert ? C.amber : C.green;
  if (mins > 0 && flash) {
    const x = ADI.x + ADI.w - 56;
    text(ctx, radio ? 'RADIO' : 'BARO', x, ADI.y + ADI.h + 30, mc, 24, 'right');
    text(ctx, String(Math.round(mins)), x, ADI.y + ADI.h + 60, mc, 30, 'right');
  }
  if (d.ra < 2500 && !(d.onGround && d.cas < 1 && d.ra < 5)) {
    const raTxt = d.ra < 100 ? String(Math.max(0, Math.round(d.ra))) : d.ra < 500 ? String(Math.round(d.ra / 10) * 10) : String(Math.round(d.ra / 20) * 20);
    const col = radio && d.ra < mins && !d.onGround ? C.amber : C.white;
    ctx.fillStyle = 'rgba(0,0,0,0.0)';
    text(ctx, raTxt, CX, ADI.y + ADI.h - 92, col, 40, 'center', 'middle', true);
  }
}

// ---------------------------------------------------------------- speed tape
function spdY(d, v) { return CY - (v - d.cas) * SPD.kt; }

function drawSpeedTape(ctx, d) {
  const { x, y, w, h } = SPD;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w + 60, h); ctx.clip();
  rect(ctx, x, y, w, h, { fill: C.tape });
  const lo = Math.max(30, Math.floor((d.cas - 70) / 10) * 10), hi = d.cas + 70;
  for (let v = lo; v <= hi; v += 10) {
    const yy = spdY(d, v);
    line(ctx, x + w - 22, yy, x + w, yy, C.white, 3);
    if (v % 20 === 0) text(ctx, String(v), x + w - 30, yy, C.white, 30, 'right');
  }
  // barber poles (right edge) and amber maneuver bands
  if (!d.onGround) {
    const yv = spdY(d, d.vss);
    barber(ctx, x + w - 12, yv, y + h - yv + 10);
    const ym = spdY(d, d.vminMan);
    ctx.strokeStyle = C.amber; ctx.lineWidth = 3;
    ctx.strokeRect(x + w - 10, ym, 8, yv - ym);
  }
  const ymax = spdY(d, d.vmax);
  barber(ctx, x + w - 12, y - 10, ymax - y + 10);
  if (d.vmaxMan && d.vmaxMan < d.vmax) {
    const ya = spdY(d, d.vmaxMan);
    ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.strokeRect(x + w - 10, ymax, 8, ya - ymax);
  }
  drawSpeedBugs(ctx, d);
  ctx.restore();
  // trend vector (green arrow from the index)
  if (Math.abs(d.trend) > 2) {
    const tx = x + w - 2, y1 = clamp(spdY(d, d.cas + d.trend), y + 6, y + h - 6);
    line(ctx, tx, CY, tx, y1, C.green, 3);
    const s = d.trend > 0 ? 1 : -1;
    poly(ctx, [tx - 9, y1 + s * 14, tx, y1, tx + 9, y1 + s * 14], { stroke: C.green, w: 3, close: false });
  }
  // selected speed readout (top) and Mach / GS (bottom)
  text(ctx, d.selSpdTxt, x + w / 2 + 8, y - 26, C.magenta, 36, 'center');
  if (d.mach >= 0.4) text(ctx, '.' + pad(Math.round(d.mach * 1000), 3), x + w / 2, y + h + 34, C.white, 34, 'center');
  else if (d.gs > 1 || d.onGround) { text(ctx, 'GS', x, y + h + 34, C.white, 24); text(ctx, String(Math.round(d.gs)), x + w, y + h + 34, C.white, 32, 'right'); }
}

function barber(ctx, x, y, h) {
  if (h <= 0) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, 12, h); ctx.clip();
  ctx.fillStyle = '#000'; ctx.fillRect(x, y, 12, h);
  ctx.fillStyle = C.red;
  for (let yy = Math.floor(y / 24) * 24; yy < y + h; yy += 24) ctx.fillRect(x, yy, 12, 12);
  ctx.restore();
}

function drawSpeedBugs(ctx, d) {
  const { x, w } = SPD;
  const fmc = d.sim.fmc || {};
  const bugTxt = (v, label, col = C.green) => {
    const yy = spdY(d, v);
    line(ctx, x + w, yy, x + w + 12, yy, col, 3);
    text(ctx, label, x + w + 14, yy, col, 24);
  };
  if (d.toPhase && fin(fmc.v1) > 0) {
    bugTxt(fmc.v1, 'V1');
    bugTxt(fmc.vr, 'VR');
    if (!d.onGround) bugTxt(fmc.v2 + 15, '+15', C.white);
  } else if (!d.toPhase && fin(fmc.vref) > 0 && d.flaps >= 1) {
    bugTxt(fmc.vref, 'REF');
  }
  // flap maneuver speeds: current detent and retraction settings
  if (!d.onGround && d.flaps > 0.5) {
    for (const [fl, ofs, lab] of MANEUVER_OFS) {
      if (fl < d.flaps - 0.5 || (fl <= d.flaps + 0.5 && fl > 0 && d.flaps < 21)) {
        if (fl <= d.flaps + 0.5) bugTxt(d.vref30 + ofs, lab);
      }
    }
  }
  // selected speed bug (magenta notch)
  const ys = clamp(spdY(d, d.selSpd), SPD.y - 6, SPD.y + SPD.h + 6);
  poly(ctx, [x + w - 2, ys - 16, x + w + 18, ys - 16, x + w + 18, ys + 16, x + w - 2, ys + 16, x + w + 8, ys], { stroke: C.magenta, w: 3 });
}

/**
 * Odometer value of the digit at `place` (1, 10, 100...) for a counter whose lowest window steps by `step`:
 * the digit rolls to the next value during the last `step` of the lower places.
 */
function odo(v, place, step) {
  const lower = v % place;
  return Math.floor(v / place) % 10 + Math.max(0, lower - (place - step)) / step;
}

/** Clip helper for rolling digit windows. */
function drum(ctx, x, y, w, h, fn) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); fn(); ctx.restore(); }

/**
 * Draw a rolling digit column right-aligned at xr. `val` is fractional (4.3 = 30% from 4 towards 5).
 * blankZero hides a leading zero (the digit is blank while its value is 0).
 */
function digitColumn(ctx, xr, cy, val, size, pitch, blankZero = false, col = C.white) {
  const base = Math.floor(val), off = (val - base) * pitch;
  for (const k of [-1, 0, 1]) {
    const n = base + k;
    if (blankZero && n <= 0) continue;
    text(ctx, String(((n % 10) + 10) % 10), xr, cy + off - k * pitch, col, size, 'right');
  }
}

function drawSpeedReadout(ctx, d) {
  const bx = SPD.x - 6, bw = 112, bh = 66;
  const amber = !d.onGround && d.cas < d.vminMan;
  const col = amber ? C.amber : C.white;
  ctx.beginPath();
  ctx.moveTo(bx, CY - bh / 2); ctx.lineTo(bx + bw, CY - bh / 2); ctx.lineTo(bx + bw, CY - 12);
  ctx.lineTo(bx + bw + 14, CY); ctx.lineTo(bx + bw, CY + 12); ctx.lineTo(bx + bw, CY + bh / 2);
  ctx.lineTo(bx, CY + bh / 2); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke();
  if (d.cas < 30) { text(ctx, '30', bx + bw - 12, CY, C.white, 44, 'right'); return; }
  const v = d.cas, dw = textW(ctx, '0', 44), xr = bx + bw - 10;
  drum(ctx, bx + 3, CY - bh / 2 + 3, bw - 6, bh - 6, () => {
    digitColumn(ctx, xr, CY, v % 10, 44, 46);
    digitColumn(ctx, xr - dw, CY, odo(v, 10, 1), 44, 46);
    digitColumn(ctx, xr - 2 * dw, CY, odo(v, 100, 1), 44, 46, true);
  });
}

// ---------------------------------------------------------------- altitude tape
function altY(d, a) { return CY - (a - d.alt) * ALT.ft; }

function drawAltTape(ctx, d, st) {
  const { x, y, w, h } = ALT;
  const sel = fin(d.ap.sel?.altFt, 10000);
  ctx.save();
  ctx.beginPath(); ctx.rect(x - 4, y, w + 8, h); ctx.clip();
  rect(ctx, x, y, w, h, { fill: C.tape });
  // ground / landing altitude band
  const landElev = d.sim.fmc?.dest?.elevFt != null && !d.toPhase ? d.sim.fmc.dest.elevFt : d.alt - d.ra;
  if (d.ra < 2500 || d.alt - landElev < 2500) {
    const yl = altY(d, landElev);
    hatch(ctx, x, yl, w, y + h - yl, C.amber, '#000', 16, 4);
    line(ctx, x, yl, x + w, yl, C.amber, 4);
    rect(ctx, x + 2, altY(d, landElev + 500), 8, yl - altY(d, landElev + 500), { fill: C.amber });
    rect(ctx, x + 2, altY(d, landElev + 1000), 8, altY(d, landElev + 500) - altY(d, landElev + 1000), { fill: C.white });
  }
  const lo = Math.floor((d.alt - 600) / 100) * 100, hi = d.alt + 600;
  for (let a = lo; a <= hi; a += 100) {
    const yy = altY(d, a);
    line(ctx, x, yy, x + 14, yy, C.white, 3);
    if (a % 200 === 0) {
      const s = Math.abs(a);
      const lab = (a < 0 ? '-' : '') + (s >= 1000 ? String(Math.floor(s / 1000)) : '');
      const rest = pad(s % 1000, 3);
      const tx = x + w - 6;
      text(ctx, rest, tx, yy + 1, C.white, 24, 'right');
      if (lab) text(ctx, lab, tx - textW(ctx, rest, 24) - 1, yy, C.white, 30, 'right');
    }
    if (a % 1000 === 0) { line(ctx, x + 18, yy - 19, x + w, yy - 19, C.white, 2); line(ctx, x + 18, yy + 19, x + w, yy + 19, C.white, 2); }
  }
  // baro minimums pointer
  if (d.efis.minsType !== 'RADIO' && fin(d.efis.minimumsFt) > 0) {
    const ym = altY(d, d.efis.minimumsFt);
    line(ctx, x - 4, ym, x + 40, ym, C.green, 4);
    poly(ctx, [x - 4, ym, x + 16, ym - 14, x + 16, ym + 14], { fill: C.green });
  }
  // selected altitude bug
  const ys = clamp(altY(d, sel), y + 6, y + h - 6);
  poly(ctx, [x, ys - 26, x + 26, ys - 26, x + 26, ys + 26, x, ys + 26, x, ys + 8, x + 10, ys, x, ys - 8], { stroke: C.magenta, w: 3 });
  ctx.restore();
  // selected altitude readout with box logic
  const diff = Math.abs(d.alt - sel);
  if (diff < 50) st.altCaptured = true; else if (diff > 900) st.altCaptured = false;
  const deviate = st.altCaptured && diff > 200;
  const approaching = !st.altCaptured && diff < 900 && diff > 200 && Math.sign(sel - d.alt) === Math.sign(d.vs);
  drawAltNumber(ctx, sel, x + w / 2 + 6, y - 26, C.magenta, 36, 28);
  if (deviate || approaching) rect(ctx, x - 6, y - 52, w + 24, 50, { stroke: deviate ? C.amber : C.white, lw: 3 });
  if (d.efis.mtrs) text(ctx, `${Math.round(sel * FT)} M`, x + w + 12, y - 68, C.magenta, 22, 'right');
  // baro setting below
  const env = d.sim.env || {};
  if (env.baroStd) {
    text(ctx, 'STD', x + w / 2, y + h + 32, C.green, 34, 'center');
    const pre = d.efis.baroIn ? (fin(env.baroHpa) * 0.02953).toFixed(2) + ' IN' : `${Math.round(fin(env.baroHpa, 1013))} HPA`;
    text(ctx, pre, x + w / 2, y + h + 64, C.white, 22, 'center');
  } else {
    const t = d.efis.baroIn ? (fin(env.baroHpa) * 0.02953).toFixed(2) : String(Math.round(fin(env.baroHpa, 1013)));
    text(ctx, t, x + w / 2 - 10, y + h + 32, C.green, 34, 'right');
    text(ctx, d.efis.baroIn ? 'IN' : 'HPA', x + w / 2 - 2, y + h + 34, C.green, 24, 'left');
  }
}

/** Altitude number with thousands in larger digits (e.g. 12 000). */
function drawAltNumber(ctx, a, xc, y, col, big, small) {
  const s = Math.round(a), neg = s < 0, abs = Math.abs(s);
  const th = Math.floor(abs / 1000), rest = pad(abs % 1000, 3);
  const thStr = (neg ? '-' : '') + (th > 0 ? String(th) : '');
  const w1 = textW(ctx, thStr, big), w2 = textW(ctx, rest, small);
  const x0 = xc - (w1 + w2 + 4) / 2;
  text(ctx, thStr, x0, y, col, big, 'left');
  text(ctx, rest, x0 + w1 + 4, y + 2, col, small, 'left');
}

function drawAltReadout(ctx, d) {
  const bx = ALT.x - 20, bw = 152, bh = 66, ext = 16;
  const xs = bx + bw - 54;                       // left edge of the taller last-two-digit window
  const y0 = CY - bh / 2, y1 = CY + bh / 2;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(bx, CY); ctx.lineTo(bx + 14, CY - 12); ctx.lineTo(bx + 14, y0); ctx.lineTo(xs, y0); ctx.lineTo(xs, y0 - ext);
    ctx.lineTo(bx + bw, y0 - ext); ctx.lineTo(bx + bw, y1 + ext); ctx.lineTo(xs, y1 + ext); ctx.lineTo(xs, y1);
    ctx.lineTo(bx + 14, y1); ctx.lineTo(bx + 14, CY + 12); ctx.closePath();
  };
  path(); ctx.fillStyle = '#000'; ctx.fill();
  const abs = Math.abs(d.alt), neg = d.alt < 0;
  ctx.save(); path(); ctx.clip();
  // last two digits: 20-ft drum
  const dv = (abs % 100) / 20, base = Math.floor(dv), fr = dv - base;
  for (const k of [-2, -1, 0, 1, 2]) {
    const n = ((((base + k) % 5) + 5) % 5) * 20;
    text(ctx, pad(n, 2), bx + bw - 8, CY + fr * 38 - k * 38, C.white, 30, 'right');
  }
  // hundreds (medium) and thousands / ten-thousands (large)
  const wS = textW(ctx, '0', 34), wL = textW(ctx, '0', 44);
  const xh = xs - 3, xt = xh - wS - 2, xtt = xt - wL;
  digitColumn(ctx, xh, CY + 2, odo(abs, 100, 20), 34, 40);
  digitColumn(ctx, xt, CY, odo(abs, 1000, 20), 44, 50, abs < 1000);
  const tt = odo(abs, 10000, 20);
  if (tt >= 0.001) digitColumn(ctx, xtt, CY, tt, 44, 50, true);
  else if (!neg) hatch(ctx, xtt - wL + 4, CY - 17, wL - 6, 34, C.green, null, 9, 3);
  if (neg) text(ctx, '-', xtt - wL + 6, CY, C.white, 40, 'left');
  ctx.restore();
  path(); ctx.strokeStyle = C.white; ctx.lineWidth = 3; ctx.stroke();
  if (d.efis.mtrs) {
    rect(ctx, bx + 20, y0 - ext - 46, bw - 20, 38, { fill: '#000', stroke: C.white, lw: 2 });
    text(ctx, `${Math.round(d.alt * FT)} M`, bx + bw - 8, y0 - ext - 27, C.white, 26, 'right');
  }
}

// ---------------------------------------------------------------- vertical speed
function vsiY(fpm) {
  const a = Math.abs(fpm), s = Math.sign(fpm);
  let u;
  if (a <= 1000) u = a / 1000 * 92;
  else if (a <= 2000) u = 92 + (a - 1000) / 1000 * 50;
  else u = 142 + Math.min(a - 2000, 4000) / 4000 * 52;
  return CY - s * u;
}

function drawVSI(ctx, d) {
  const { x, y, w, h } = VSI;
  poly(ctx, [x, y, x + 34, y, x + w, y + 90, x + w, y + h - 90, x + 34, y + h, x, y + h, x, CY + 36, x + 12, CY + 20, x + 12, CY - 20, x, CY - 36], { fill: C.tape });
  for (const [v, lab] of [[500, ''], [1000, '1'], [1500, ''], [2000, '2'], [6000, '6']]) {
    for (const s of [-1, 1]) {
      const yy = vsiY(s * v);
      const major = lab !== '';
      line(ctx, x + 18, yy, x + (major ? 34 : 28), yy, C.white, 3);
      if (major) text(ctx, lab, x + 4, yy, C.white, 24, 'left');
    }
  }
  line(ctx, x + 14, CY, x + 38, CY, C.white, 4);
  // pointer from a pivot right of the scale
  const vs = clamp(d.vs, -6500, 6500);
  const yp = vsiY(vs);
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 20, y, w, h); ctx.clip();
  line(ctx, x + 22, yp, x + w + 70, CY, C.white, 4);
  ctx.restore();
  // selected V/S bug
  if (/V\/S/.test(d.ap.modes?.pitch || '')) {
    const yb = vsiY(fin(d.ap.sel?.vsFpm));
    poly(ctx, [x + 36, yb - 9, x + 50, yb - 9, x + 50, yb + 9, x + 36, yb + 9], { stroke: C.magenta, w: 3 });
  }
  if (Math.abs(d.vs) > 400) {
    const t = String(Math.round(Math.abs(d.vs) / 50) * 50);
    text(ctx, t, x + w / 2 + 6, d.vs > 0 ? y - 22 : y + h + 22, C.white, 28, 'center');
  }
}

// ---------------------------------------------------------------- heading arc
function drawHeading(ctx, d) {
  const { cx, cy, r } = HDG;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 760, 1000, 240); ctx.clip();
  circle(ctx, cx, cy, r, { fill: C.tape });
  ctx.translate(cx, cy);
  for (let k = 0; k < 360; k += 5) {
    const a = (k - d.hdg) / RAD;
    if (Math.abs(wrap180(k - d.hdg)) > 40) continue;
    ctx.save(); ctx.rotate(a);
    const major = k % 10 === 0;
    line(ctx, 0, -r, 0, -r + (major ? 22 : 12), C.white, 3);
    if (major) {
      const n = k / 10;
      text(ctx, String(n), 0, -r + 44, C.white, n % 3 === 0 ? 32 : 26, 'center');
    }
    ctx.restore();
  }
  // track line
  ctx.save(); ctx.rotate(wrap180(d.trk - d.hdg) / RAD);
  line(ctx, 0, -r, 0, -r + 140, C.white, 3);
  line(ctx, -10, -r + 70, 10, -r + 70, C.white, 3);
  ctx.restore();
  // selected heading bug
  const sel = fin(d.ap.sel?.hdgDeg);
  const ra = clamp(wrap180(sel - (d.ap.sel?.hdgIsTrk ? d.trk : d.hdg)), -52, 52);
  ctx.save(); ctx.rotate(ra / RAD);
  poly(ctx, [-20, -r, -20, -r - 14, 20, -r - 14, 20, -r, 8, -r, 0, -r + 12, -8, -r], { stroke: C.magenta, w: 3 });
  ctx.restore();
  ctx.restore();
  // fixed heading pointer
  poly(ctx, [cx, cy - r + 2, cx - 14, cy - r - 22, cx + 14, cy - r - 22], { stroke: C.white, w: 3 });
  const trkSel = !!d.ap.sel?.hdgIsTrk;
  text(ctx, `${fmtHdg(sel)}`, cx - 196, 792, C.magenta, 30, 'right');
  text(ctx, trkSel ? 'T' : 'H', cx - 190, 794, C.magenta, 22, 'left');
  text(ctx, trkSel ? 'TRK' : 'HDG', cx + 178, 792, C.green, 24, 'left');
  text(ctx, 'MAG', cx + 236, 792, C.green, 24, 'left');
}

// ---------------------------------------------------------------- FMA & AFDS status
const FMA_KEYS = [['at', null], ['roll', 'armedRoll'], ['pitch', 'armedPitch']];

function drawFMA(ctx, d, st) {
  const { x, y, w, h } = FMA;
  const cw = w / 3;
  const m = d.ap.modes || {};
  const now = fin(d.sim.time);
  for (let i = 1; i < 3; i++) line(ctx, x + i * cw, y + 4, x + i * cw, y + h - 6, C.white, 3);
  FMA_KEYS.forEach(([k, armedK], i) => {
    const s = m[k] || '';
    const rec = st.fma[k] || (st.fma[k] = { s, t: -1e9 });   // modes present at start are not boxed
    if (s !== rec.s) { rec.s = s; rec.t = s ? now : -1e9; }
    const xc = x + cw * i + cw / 2;
    if (s) {
      text(ctx, s, xc, y + 26, C.green, 32, 'center');
      if (now - rec.t < 10 && now >= rec.t) {
        const tw = textW(ctx, s, 32) + 20;
        rect(ctx, xc - tw / 2, y + 6, tw, 40, { stroke: C.green, lw: 3 });
      }
    }
    if (armedK && m[armedK]) text(ctx, m[armedK], xc, y + 70, C.white, 26, 'center');
  });
  // AFDS status (centre above ADI)
  const ap = d.ap;
  let status = m.ap || '';
  if (!status) status = ap.apEngaged ? 'A/P' : (ap.fdL || ap.fdR) && ap.fd?.valid !== false ? 'FLT DIR' : '';
  if (st.apWas && !ap.apEngaged) st.apDiscT = performance.now();
  st.apWas = !!ap.apEngaged;
  const discShow = !ap.apEngaged && performance.now() - fin(st.apDiscT, -1e9) < 6000;
  if (discShow) { if (blink(0.4)) text(ctx, 'A/P', CX, y + h + 34, C.red, 36, 'center'); }
  else if (status) {
    const amber = /NO AUTOLAND/.test(status);
    text(ctx, status, CX, y + h + 34, amber ? C.amber : C.green, 36, 'center');
  }
}

/** Red PFD warnings (PULL UP / WINDSHEAR) pulled from the alert system if present. */
function drawWarnings(ctx, d) {
  const al = d.sim.alerts || {};
  let msg = al.pfd || al.gpws || '';
  if (!msg && al.pullUp) msg = 'PULL UP';
  if (!msg && al.windshear) msg = 'WINDSHEAR';
  if (msg && /PULL UP|WINDSHEAR/.test(msg)) {
    text(ctx, msg.includes('WINDSHEAR') ? 'WINDSHEAR' : 'PULL UP', CX, CY + 110, C.red, 44, 'center', 'middle', true);
  }
  if (d.ra < 2500 && /OFF|FAIL/.test(String(d.sim.nav?.ils?.flag || ''))) text(ctx, 'LOC', CX, ADI.y + ADI.h - 44, C.amber, 26, 'center');
}

// ---------------------------------------------------------------- public
export function createPFD(el, sim) {
  const st = { lastT: 0, lastCas: 0, acc: 0, fma: {}, toPhase: true, altCaptured: false, minsAlert: false };
  const disp = createDisplay(el, (ctx) => {
    const d = readData(sim, st);
    drawAttitude(ctx, d);
    drawILS(ctx, d);
    drawFD(ctx, d);
    drawFPV(ctx, d);
    drawRollScale(ctx, d);
    drawAircraftSymbol(ctx);
    drawRaMins(ctx, d, st);
    drawWarnings(ctx, d);
    drawSpeedTape(ctx, d);
    drawSpeedReadout(ctx, d);
    drawAltTape(ctx, d, st);
    drawAltReadout(ctx, d);
    drawVSI(ctx, d);
    drawHeading(ctx, d);
    drawFMA(ctx, d, st);
  });
  return disp;
}
// keep unused import references explicit for linting tools
void box; void hatch;
