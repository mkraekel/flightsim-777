// Integrated Standby Flight Display: attitude, airspeed tape, altitude tape and baro setting.
// Deliberately simple and independent from the PFD (as on the real aircraft).
import { KT, RAD, clamp } from '../core/geo.js';
import { C, createDisplay, text, line, poly, rect, roundRectPath, fin, pad } from './gfx.js';
import { indicatedAltFt } from './pfd.js';

const CX = 500, CY = 500, PX_DEG = 11;

function attitude(ctx, pitch, roll) {
  ctx.save();
  roundRectPath(ctx, 230, 120, 540, 760, 30); ctx.clip();
  ctx.translate(CX, CY); ctx.rotate(-roll / RAD);
  const py = pitch * PX_DEG;
  ctx.fillStyle = C.sky; ctx.fillRect(-900, -1600 + py, 1800, 1600);
  ctx.fillStyle = C.ground; ctx.fillRect(-900, py, 1800, 1600);
  line(ctx, -900, py, 900, py, C.white, 4);
  for (let p = -30; p <= 30; p += 5) {
    if (!p) continue;
    const y = py - p * PX_DEG;
    const w = p % 10 === 0 ? 70 : 34;
    line(ctx, -w, y, w, y, C.white, 4);
    if (p % 10 === 0) text(ctx, String(Math.abs(p)), w + 12, y, C.white, 36);
  }
  // roll pointer
  poly(ctx, [0, -300, -16, -272, 16, -272], { fill: C.white });
  ctx.restore();
  // fixed roll scale
  ctx.save(); ctx.translate(CX, CY);
  ctx.strokeStyle = C.white; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, 300, (-150) / RAD, (-30) / RAD); ctx.stroke();
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const r = (a - 90) / RAD, len = Math.abs(a) % 30 === 0 ? 36 : 20;
    line(ctx, Math.cos(r) * 300, Math.sin(r) * 300, Math.cos(r) * (300 + len), Math.sin(r) * (300 + len), C.white, 4);
  }
  poly(ctx, [0, -302, -16, -332, 16, -332], { stroke: C.white, w: 4 });
  ctx.restore();
  // aircraft symbol (amber-outlined, as on the ISFD)
  ctx.fillStyle = '#000'; ctx.strokeStyle = C.amber; ctx.lineWidth = 4;
  for (const s of [-1, 1]) { ctx.fillRect(CX + s * 160 - (s > 0 ? 90 : 0), CY - 8, 90, 16); ctx.strokeRect(CX + s * 160 - (s > 0 ? 90 : 0), CY - 8, 90, 16); }
  ctx.fillRect(CX - 10, CY - 10, 20, 20); ctx.strokeRect(CX - 10, CY - 10, 20, 20);
}

function tape(ctx, x, w, val, pxPer, step, labelEvery, fmt, right) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, 120, w, 760); ctx.clip();
  rect(ctx, x, 120, w, 760, { fill: C.tape });
  const span = 380 / pxPer;
  for (let v = Math.floor((val - span) / step) * step; v <= val + span; v += step) {
    const y = CY - (v - val) * pxPer;
    const tx = right ? x : x + w;
    line(ctx, tx, y, right ? tx + 20 : tx - 20, y, C.white, 4);
    if (v % labelEvery === 0 && v >= 0) text(ctx, fmt(v), right ? x + 28 : x + w - 28, y, C.white, 38, right ? 'left' : 'right');
  }
  ctx.restore();
}

export function createISFD(el, sim) {
  return createDisplay(el, (ctx) => {
    const ac = sim.ac, env = sim.env || {};
    const pitch = fin(ac.euler?.pitch) * RAD, roll = fin(ac.euler?.roll) * RAD;
    const cas = Math.max(0, fin(ac.cas) / KT), alt = indicatedAltFt(sim);
    attitude(ctx, pitch, roll);
    tape(ctx, 20, 200, Math.max(30, cas), 4, 10, 20, (v) => String(v), false);
    tape(ctx, 780, 200, alt, 0.6, 100, 500, (v) => String(v), true);
    // readout boxes
    rect(ctx, 30, CY - 40, 180, 80, { fill: '#000', stroke: C.white, lw: 4 });
    text(ctx, cas < 30 ? '---' : String(Math.round(cas)), 196, CY, C.white, 52, 'right');
    rect(ctx, 790, CY - 40, 200, 80, { fill: '#000', stroke: C.white, lw: 4 });
    text(ctx, String(Math.round(alt / 20) * 20), 978, CY, C.white, 46, 'right');
    // baro + mach
    const baro = env.baroStd ? 'STD' : `${Math.round(fin(env.baroHpa, 1013))} HPA`;
    text(ctx, baro, 885, 940, C.green, 40, 'center');
    if (ac.mach >= 0.4) text(ctx, '.' + pad(Math.round(ac.mach * 1000), 3), 120, 940, C.white, 40, 'center');
    void clamp;
  });
}
