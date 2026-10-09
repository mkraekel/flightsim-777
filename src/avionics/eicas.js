// Boeing 777 EICAS: upper display (engine dials, thrust reference, alerts, gear, flaps, fuel)
// and the lower multifunction display with synoptic pages (ENG, FUEL, ELEC, HYD, FCTL, GEAR, DOOR).
// sim.systems is owned by the systems team; every read here is defensive with sensible defaults.
import { FT, FPM, RAD, clamp } from '../core/geo.js';
import { C, createDisplay, text, textW, line, poly, rect, circle, hatch, fin, pad } from './gfx.js';

const N1_MAX = 110, EGT_MAX = 1200, SWEEP = 200 / RAD;   // dial ranges, sweep in rad
const N1_RED = 110, EGT_RED = 1090, EGT_AMBER = 1060;

// ---------------------------------------------------------------- thrust reference logic
/** Derive EICAS thrust reference mode + N1 limit from flight phase (simple model). */
export function thrustRef(sim, st) {
  const ac = sim.ac, ap = sim.ap || {};
  const altFt = fin(ac.altMSL) / FT, vs = fin(ac.vs) / FPM, flaps = fin(sim.surfaces?.flapsDeg);
  const pm = `${ap.modes?.pitch || ''} ${ap.modes?.at || ''}`;
  let mode;
  if (ac.onGround) mode = /TO\/GA/.test(pm) && st?.wasAir ? 'GA' : 'TO';
  else if (st?.wasTO && ac.ra / FT < 1500 && vs > 0) mode = 'TO';
  else if (/TO\/GA/.test(pm) || (flaps >= 20 && vs < 300)) mode = 'GA';
  else if (ap.clbCon || /CON/.test(pm)) mode = vs > 300 ? 'CLB' : 'CON';
  else if (vs > 400) mode = 'CLB';
  else mode = 'CRZ';
  if (st) { if (ac.onGround) st.wasTO = true; else if (ac.ra / FT > 1500) st.wasTO = false; st.wasAir = !ac.onGround; }
  const tempDev = fin(sim.env?.tempDevC);
  const altK = clamp(altFt / 1000, 0, 43);
  const base = { TO: 101.8, GA: 100.5, CLB: 97.5 + altK * 0.12, CON: 98.8, CRZ: 91 + altK * 0.12 }[mode];
  return { mode, n1: clamp(base - Math.max(0, tempDev - 15) * 0.25, 70, 106) };
}

// ---------------------------------------------------------------- dial
function dial(ctx, cx, cy, r, val, max, { red, amber, ref = null, cmd = null, fmt, boxCol = C.white, tick = [] }) {
  const ang = (v) => Math.PI + clamp(v / max, 0, 1.06) * SWEEP;
  // arc
  ctx.strokeStyle = C.white; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, ang(red)); ctx.stroke();
  for (const t of tick) { const a = ang(t); line(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14), C.white, 3); }
  // amber + red limit lines
  const lim = (v, col, len) => { const a = ang(v); line(ctx, cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6), cx + Math.cos(a) * (r + len), cy + Math.sin(a) * (r + len), col, 6); };
  if (amber != null) lim(amber, C.amber, 14);
  lim(red, C.red, 20);
  // commanded thrust (white arc segment outside the dial) and reference (green line)
  if (cmd != null && Math.abs(cmd - val) > 0.5) {
    ctx.strokeStyle = C.white; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, r + 9, Math.min(ang(cmd), ang(val)), Math.max(ang(cmd), ang(val))); ctx.stroke();
  }
  if (ref != null) { const a = ang(ref); line(ctx, cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18), cx + Math.cos(a) * (r + 18), cy + Math.sin(a) * (r + 18), C.green, 5); }
  // filled swept sector and needle
  const col = val >= red ? C.red : amber != null && val >= amber ? C.amber : C.white;
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r - 3, Math.PI, ang(val)); ctx.closePath(); ctx.fill();
  const a = ang(val);
  line(ctx, cx, cy, cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4), col, 5);
  // readout box (upper right of the dial centre)
  const bw = r * 0.8, bh = 42, bx = cx + 10, by = cy - bh - 10;
  rect(ctx, bx, by, bw, bh, { stroke: boxCol === C.white ? col : boxCol, lw: 3, fill: '#000' });
  text(ctx, fmt(val), bx + bw - 7, by + bh / 2 + 1, col, 33, 'right');
}

// ---------------------------------------------------------------- upper EICAS
const ALERT_COL = { warning: 'red', caution: 'amber', advisory: 'amber', memo: 'white' };
const ALERT_PRI = { warning: 0, caution: 1, advisory: 2, memo: 3 };

/** Normalise an alert entry: string | {text|msg|message|id, level|type|severity|cat}. */
export function normAlert(a) {
  if (typeof a === 'string') return { text: a, level: 'caution' };
  const textS = a?.text ?? a?.msg ?? a?.message ?? a?.id ?? '';
  let lvl = String(a?.level ?? a?.type ?? a?.severity ?? a?.cat ?? 'caution').toLowerCase();
  if (lvl.startsWith('warn')) lvl = 'warning'; else if (lvl.startsWith('caut')) lvl = 'caution';
  else if (lvl.startsWith('adv')) lvl = 'advisory'; else if (lvl.startsWith('mem') || lvl === 'status') lvl = 'memo';
  else lvl = 'caution';
  return { text: String(textS), level: lvl };
}

function drawAlerts(ctx, sim) {
  const list = (sim.alerts?.list || []).map(normAlert).filter((a) => a.text);
  list.sort((a, b) => ALERT_PRI[a.level] - ALERT_PRI[b.level]);
  const x = 590, lh = 36;
  let y = 34;
  const max = 11;
  list.slice(0, max).forEach((a) => {
    const col = C[ALERT_COL[a.level]];
    text(ctx, (a.level === 'advisory' ? ' ' : '') + a.text, x + (a.level === 'advisory' ? 18 : 0), y, col, 29);
    y += lh;
  });
  if (list.length > max) text(ctx, `PG 1`, 980, 34 + lh * max, C.white, 24, 'right');
}

function drawGear(ctx, sim, st) {
  const g = fin(sim.surfaces?.gear, 1), x = 760, y = 480;
  const now = performance.now();
  if (g > 0.99) st.gearUpT = null;
  else if (g < 0.01 && st.gearUpT == null) st.gearUpT = now;
  if (g < 0.01 && st.gearUpT != null && now - st.gearUpT > 10000) return;
  text(ctx, 'GEAR', x - 14, y + 28, C.white, 26, 'right');
  if (g > 0.99) { rect(ctx, x, y, 150, 56, { stroke: C.green, lw: 3 }); text(ctx, 'DOWN', x + 75, y + 29, C.green, 34, 'center'); }
  else if (g < 0.01) { rect(ctx, x, y, 150, 56, { stroke: C.white, lw: 3 }); text(ctx, 'UP', x + 75, y + 29, C.white, 34, 'center'); }
  else { hatch(ctx, x, y, 150, 56, C.white, '#000', 14, 3); rect(ctx, x, y, 150, 56, { stroke: C.white, lw: 3 }); }
}

function drawFlaps(ctx, sim, st) {
  const s = sim.surfaces || {};
  const pos = fin(s.flapsDeg), tgt = fin(s.flapsTarget, pos);
  const now = performance.now();
  if (pos > 0.1 || tgt > 0.1) st.flapUpT = null; else if (st.flapUpT == null) st.flapUpT = now;
  if (st.flapUpT != null && now - st.flapUpT > 10000) return;
  const x = 800, y = 600, w = 44, h = 240;
  const fy = (deg) => y + clamp(deg / 30, 0, 1) * h;
  text(ctx, 'FLAPS', x + w / 2, y - 26, C.white, 26, 'center');
  rect(ctx, x, y, w, h, { stroke: C.white, lw: 3 });
  rect(ctx, x + 3, y + 3, w - 6, fy(pos) - y - 3, { fill: C.white });
  for (const det of [1, 5, 15, 20, 25]) line(ctx, x - 12, fy(det), x, fy(det), C.white, 3);
  // command line + number (magenta/green) while in transit or not up
  line(ctx, x - 16, fy(tgt), x + w + 16, fy(tgt), C.magenta, 4);
  const lab = tgt < 0.5 ? 'UP' : String(Math.round(tgt));
  text(ctx, lab, x + w + 24, fy(tgt), C.green, 34);
}

function drawFuel(ctx, sim) {
  const f = sim.ac.fuelKg || {};
  const tot = fin(f.L) + fin(f.C) + fin(f.R);
  const temp = fin(sim.systems?.fuel?.tempC, fin(sim.env?.tempDevC) - 10 - fin(sim.ac.altMSL) / 1000 * 1.5);
  const x = 560, y = 860;
  text(ctx, 'TOTAL', x, y, C.white, 24); text(ctx, 'FUEL', x, y + 28, C.white, 24);
  text(ctx, (tot / 1000).toFixed(1), x + 210, y + 14, C.white, 42, 'right');
  text(ctx, 'KGS X', x + 226, y, C.white, 22); text(ctx, '1000', x + 226, y + 26, C.white, 22);
  text(ctx, 'FUEL TEMP', x, y + 76, C.white, 24);
  text(ctx, `${temp >= 0 ? '+' : ''}${Math.round(temp)}c`, x + 210, y + 76, temp < -37 ? C.amber : C.white, 30, 'right');
}

function drawEngines(ctx, sim, st) {
  const tr = thrustRef(sim, st);
  const engs = sim.engines || [];
  const thr = sim.controls?.throttle || [0, 0];
  const tat = fin(sim.systems?.air?.tatC, (sim.ac.mach > 0.2
    ? (288.15 - 0.0065 * Math.min(fin(sim.ac.altMSL), 11000) + fin(sim.env?.tempDevC)) * (1 + 0.2 * sim.ac.mach ** 2) - 273.15
    : 15 + fin(sim.env?.tempDevC) - 0.0065 * fin(sim.ac.altMSL)));
  text(ctx, 'TAT', 30, 34, C.white, 26);
  text(ctx, `${tat >= 0 ? '+' : ''}${Math.round(tat)}c`, 92, 34, C.white, 30);
  text(ctx, tr.mode, 30, 82, C.green, 36);
  text(ctx, tr.n1.toFixed(1), 250, 82, C.green, 34, 'right');
  const cxs = [150, 450];
  cxs.forEach((cx, i) => {
    const e = engs[i] || {};
    const n1 = fin(e.n1), egt = fin(e.egt, 15);
    const idle = e.running ? 21 : 0;
    const cmd = e.running ? idle + clamp(fin(thr[i]), 0, 1) * (tr.n1 + 1.5 - idle) : null;
    dial(ctx, cx, 270, 122, n1, N1_MAX, { red: N1_RED, amber: tr.n1 + 2.5, ref: tr.n1, cmd, fmt: (v) => v.toFixed(1), tick: [] });
    dial(ctx, cx, 540, 108, egt, EGT_MAX, { red: EGT_RED, amber: EGT_AMBER, fmt: (v) => String(Math.round(v)) });
    // N2 / FF digital
    const col = (bad) => (bad ? C.amber : C.white);
    rect(ctx, cx - 40, 680, 120, 44, { stroke: C.white, lw: 2.5 });
    text(ctx, fin(e.n2).toFixed(1), cx + 72, 703, col(fin(e.n2) > 117), 32, 'right');
    rect(ctx, cx - 40, 748, 120, 44, { stroke: C.white, lw: 2.5 });
    text(ctx, (fin(e.ff) / 1000).toFixed(1), cx + 72, 771, C.white, 32, 'right');
    if (e.fire) text(ctx, 'FIRE', cx, 130, C.red, 30, 'center');
    if (e.startState === 'STARTING') text(ctx, 'START', cx - 40, 128, C.white, 24, 'center');
  });
  text(ctx, 'N1', 300, 200, C.white, 30, 'center');
  text(ctx, 'EGT', 300, 476, C.white, 30, 'center');
  text(ctx, 'N2', 300, 703, C.white, 28, 'center');
  text(ctx, 'FF', 300, 771, C.white, 28, 'center');
}

export function createEICAS(el, sim) {
  const st = { wasTO: true };
  return createDisplay(el, (ctx) => {
    drawEngines(ctx, sim, st);
    line(ctx, 560, 16, 560, 430, 'rgba(255,255,255,0)', 1);
    drawAlerts(ctx, sim);
    drawGear(ctx, sim, st);
    drawFlaps(ctx, sim, st);
    drawFuel(ctx, sim);
  });
}

// ================================================================ lower EICAS (MFD)
export const LOWER_PAGES = ['ENG', 'FUEL', 'ELEC', 'HYD', 'FCTL', 'GEAR', 'DOOR'];

function title(ctx, s) { text(ctx, s, 500, 40, C.white, 34, 'center'); }
const sys = (sim) => sim.systems || {};
const engRun = (sim, i) => !!sim.engines?.[i]?.running;

function pageENG(ctx, sim) {
  title(ctx, 'ENGINE');
  const rows = [
    ['N2', (e) => fin(e.n2).toFixed(1), '%'],
    ['FF', (e) => (fin(e.ff) / 1000).toFixed(2), 'KGH x1000'],
    ['OIL PRESS', (e) => String(Math.round(fin(e.oilP))), 'PSI'],
    ['OIL TEMP', (e) => String(Math.round(fin(e.oilT, 15))), 'C'],
    ['OIL QTY', (e) => String(Math.round(fin(e.oilQty, 20))), 'QT'],
    ['VIB N1', (e) => fin(e.vib).toFixed(1), ''],
  ];
  rows.forEach(([lab, fn, unit], r) => {
    const y = 150 + r * 120;
    text(ctx, lab, 500, y, C.white, 30, 'center');
    if (unit) text(ctx, unit, 500, y + 34, C.white, 20, 'center');
    [0, 1].forEach((i) => {
      const e = sim.engines?.[i] || {};
      const x = i ? 640 : 220;
      rect(ctx, x, y - 30, 150, 60, { stroke: C.white, lw: 3 });
      const lowOil = lab === 'OIL PRESS' && e.running && fin(e.oilP) < 25;
      text(ctx, fn(e), x + 138, y, lowOil ? C.amber : C.white, 38, 'right');
      // simple vertical bar gauge for oil press / temp
    });
  });
}

function tank(ctx, x, y, w, h, label, kg, cap) {
  ctx.strokeStyle = C.white; ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  const f = clamp(kg / cap, 0, 1);
  rect(ctx, x + 3, y + h - 3 - (h - 6) * f, w - 6, (h - 6) * f, { fill: 'rgba(61,251,255,0.18)' });
  text(ctx, label, x + w / 2, y + 28, C.white, 24, 'center');
  text(ctx, (kg / 1000).toFixed(1), x + w / 2, y + h / 2, C.white, 40, 'center');
}

function pump(ctx, x, y, on, label) {
  rect(ctx, x - 22, y - 22, 44, 44, { stroke: on ? C.green : C.white, lw: 3, fill: on ? 'rgba(61,255,74,0.12)' : null });
  if (on) line(ctx, x, y - 22, x, y + 22, C.green, 4); else line(ctx, x - 22, y, x + 22, y, C.white, 4);
  if (label) text(ctx, label, x, y + 40, C.white, 18, 'center');
}

function pageFUEL(ctx, sim) {
  title(ctx, 'FUEL');
  const f = sim.ac.fuelKg || {};
  const fs = sys(sim).fuel || {};
  const pumps = fs.pumps || {};
  const p = (k, dflt) => (pumps[k] != null ? !!pumps[k] : dflt);
  const anyEng = engRun(sim, 0) || engRun(sim, 1);
  tank(ctx, 60, 500, 260, 220, 'MAIN L', fin(f.L), 43000);
  tank(ctx, 370, 500, 260, 220, 'CTR', fin(f.C), 95000);
  tank(ctx, 680, 500, 260, 220, 'MAIN R', fin(f.R), 43000);
  // pumps
  pump(ctx, 130, 430, p('lFwd', anyEng), 'FWD'); pump(ctx, 250, 430, p('lAft', anyEng), 'AFT');
  pump(ctx, 440, 430, p('cL', fin(f.C) > 500 && anyEng), 'L'); pump(ctx, 560, 430, p('cR', fin(f.C) > 500 && anyEng), 'R');
  pump(ctx, 750, 430, p('rFwd', anyEng), 'FWD'); pump(ctx, 870, 430, p('rAft', anyEng), 'AFT');
  // feed manifold to engines
  ctx.strokeStyle = C.green; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(130, 408); ctx.lineTo(130, 300); ctx.lineTo(870, 300); ctx.lineTo(870, 408);
  for (const x of [250, 440, 560, 750]) { ctx.moveTo(x, 408); ctx.lineTo(x, 300); }
  ctx.moveTo(190, 300); ctx.lineTo(190, 180); ctx.moveTo(810, 300); ctx.lineTo(810, 180);
  ctx.stroke();
  // crossfeed valves (circles on the manifold)
  for (const [x, k] of [[400, 'xfeedFwd'], [600, 'xfeedAft']]) {
    const open = !!fs[k];
    circle(ctx, x, 300, 20, { stroke: open ? C.green : C.white, w: 3, fill: '#000' });
    if (open) line(ctx, x - 20, 300, x + 20, 300, C.green, 4); else line(ctx, x, 280, x, 320, C.white, 4);
  }
  text(ctx, 'ENG 1', 190, 150, C.white, 28, 'center');
  text(ctx, 'ENG 2', 810, 150, C.white, 28, 'center');
  const tot = fin(f.L) + fin(f.C) + fin(f.R);
  text(ctx, 'TOTAL FUEL', 380, 820, C.white, 28); text(ctx, `${(tot / 1000).toFixed(1)}`, 680, 820, C.white, 38, 'right');
  text(ctx, 'KGS X 1000', 700, 822, C.white, 22);
  if (fs.jettison) text(ctx, 'JETTISON', 500, 900, C.amber, 30, 'center');
}

function pageELEC(ctx, sim) {
  title(ctx, 'ELECTRICAL');
  const el = sys(sim).elec || {};
  const on = (v, d) => (v != null ? !!v : d);
  const idgL = on(el.idgL ?? el.genL, engRun(sim, 0)), idgR = on(el.idgR ?? el.genR, engRun(sim, 1));
  const apu = on(el.apuGen, !!sys(sim).apu?.running), ext = on(el.extPwr, false);
  const busL = on(el.busL, idgL || apu || ext || idgR), busR = on(el.busR, idgR || apu || ext || idgL);
  const src = (x, y, lab, ok) => {
    rect(ctx, x - 70, y - 30, 140, 60, { stroke: ok ? C.green : C.white, lw: 3 });
    text(ctx, lab, x, y, ok ? C.green : C.white, 26, 'center');
  };
  src(160, 640, 'L IDG', idgL); src(840, 640, 'R IDG', idgR); src(500, 760, 'APU GEN', apu); src(500, 880, 'EXT PWR', ext);
  const bus = (x, y, lab, ok) => {
    rect(ctx, x - 110, y - 26, 220, 52, { fill: ok ? 'rgba(61,255,74,0.12)' : null, stroke: ok ? C.green : C.amber, lw: 3 });
    text(ctx, lab, x, y, ok ? C.green : C.amber, 26, 'center');
  };
  bus(220, 300, 'L MAIN AC', busL); bus(780, 300, 'R MAIN AC', busR);
  bus(220, 150, 'L XFR', busL); bus(780, 150, 'R XFR', busR);
  bus(500, 470, 'TIE BUS', busL || busR);
  ctx.strokeStyle = C.green; ctx.lineWidth = 4;
  ctx.beginPath();
  if (idgL) { ctx.moveTo(160, 610); ctx.lineTo(160, 326); }
  if (idgR) { ctx.moveTo(840, 610); ctx.lineTo(840, 326); }
  if (apu) { ctx.moveTo(500, 730); ctx.lineTo(500, 496); }
  if (ext) { ctx.moveTo(430, 880); ctx.lineTo(380, 880); ctx.lineTo(380, 496); }
  if (busL) { ctx.moveTo(220, 274); ctx.lineTo(220, 176); ctx.moveTo(280, 326); ctx.lineTo(280, 470); ctx.lineTo(390, 470); }
  if (busR) { ctx.moveTo(780, 274); ctx.lineTo(780, 176); ctx.moveTo(720, 326); ctx.lineTo(720, 470); ctx.lineTo(610, 470); }
  ctx.stroke();
  const batt = el.battV ?? 28;
  text(ctx, `BATT ${Math.round(batt)}V`, 60, 900, C.white, 26);
}

function pageHYD(ctx, sim) {
  title(ctx, 'HYDRAULICS');
  const hy = sys(sim).hyd || {};
  const sysNames = ['L', 'C', 'R'];
  sysNames.forEach((n, i) => {
    const x = 180 + i * 320;
    const s = hy[n] || hy[n.toLowerCase()] || {};
    const run = i === 0 ? engRun(sim, 0) : i === 2 ? engRun(sim, 1) : (engRun(sim, 0) || engRun(sim, 1));
    const press = fin(s.press ?? s.psi, run ? 3000 : 0);
    const qty = fin(s.qty, 0.95);
    const ok = press > 1200;
    text(ctx, n, x, 120, C.white, 40, 'center');
    rect(ctx, x - 60, 170, 120, 54, { stroke: ok ? C.green : C.amber, lw: 3 });
    text(ctx, String(Math.round(press)), x, 197, ok ? C.green : C.amber, 32, 'center');
    text(ctx, 'PRESS', x, 245, C.white, 20, 'center');
    // reservoir
    rect(ctx, x - 40, 300, 80, 160, { stroke: C.white, lw: 3 });
    rect(ctx, x - 37, 457 - 154 * clamp(qty, 0, 1), 74, 154 * clamp(qty, 0, 1), { fill: 'rgba(61,251,255,0.25)' });
    text(ctx, `${qty.toFixed(2)}`, x, 490, qty < 0.5 ? C.amber : C.white, 26, 'center');
    text(ctx, 'QTY', x, 520, C.white, 20, 'center');
    // pumps (EDP + ACMP / ADP)
    const pumps = s.pumps || {};
    const labels = i === 1 ? ['ACMP C1', 'ACMP C2'] : ['EDP', 'ACMP'];
    labels.forEach((lab, k) => {
      const onP = pumps[lab] ?? (k === 0 ? run : false);
      pump(ctx, x - 55 + k * 110, 640, !!onP, lab);
    });
    ctx.strokeStyle = ok ? C.green : C.white; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x - 55, 618); ctx.lineTo(x - 55, 580); ctx.lineTo(x + 55, 580); ctx.lineTo(x + 55, 618);
    ctx.moveTo(x, 580); ctx.lineTo(x, 760); ctx.stroke();
    text(ctx, i === 1 ? 'FLT CTRLS / GEAR' : 'FLT CTRLS', x, 790, C.white, 20, 'center');
  });
}

function vbar(ctx, x, y, h, val, lab, col = C.green) {
  // centred deflection scale: val -1..1
  line(ctx, x, y, x, y + h, C.white, 3);
  for (const f of [0, 0.5, 1]) line(ctx, x - 10, y + f * h, x + 10, y + f * h, C.white, 2);
  const yy = y + h / 2 - clamp(val, -1, 1) * h / 2;
  poly(ctx, [x + 4, yy, x + 24, yy - 12, x + 24, yy + 12], { fill: col });
  text(ctx, lab, x, y + h + 28, C.white, 20, 'center');
}

function hbar(ctx, x, y, w, val, lab) {
  line(ctx, x, y, x + w, y, C.white, 3);
  for (const f of [0, 0.5, 1]) line(ctx, x + f * w, y - 10, x + f * w, y + 10, C.white, 2);
  const xx = x + w / 2 + clamp(val, -1, 1) * w / 2;
  poly(ctx, [xx, y + 4, xx - 12, y + 24, xx + 12, y + 24], { fill: C.green });
  text(ctx, lab, x + w / 2, y + 52, C.white, 20, 'center');
}

function pageFCTL(ctx, sim) {
  title(ctx, 'FLIGHT CONTROLS');
  const s = sim.surfaces || {};
  const ail = fin(s.aileron) / (25 / RAD);
  vbar(ctx, 90, 200, 200, -ail, 'AIL L');
  vbar(ctx, 910, 200, 200, ail, 'AIL R');
  vbar(ctx, 220, 200, 200, -ail * 0.6, 'FLPRN L');
  vbar(ctx, 780, 200, 200, ail * 0.6, 'FLPRN R');
  // spoilers (7 per side) as up-deflection bars
  const spL = clamp(Math.max(fin(s.spoilerRollL), fin(s.speedbrake)), 0, 1), spR = clamp(Math.max(fin(s.spoilerRollR), fin(s.speedbrake)), 0, 1);
  for (let k = 0; k < 7; k++) {
    for (const [side, v] of [[-1, spL], [1, spR]]) {
      const x = 500 + side * (50 + k * 30);
      rect(ctx, x - 9, 220, 18, 120, { stroke: C.white, lw: 2 });
      if (v > 0.02) rect(ctx, x - 6, 337 - 114 * v, 12, 114 * v, { fill: C.green });
    }
  }
  text(ctx, 'SPOILERS', 500, 380, C.white, 22, 'center');
  vbar(ctx, 330, 520, 220, fin(s.elevator) / (30 / RAD), 'ELEV L');
  vbar(ctx, 670, 520, 220, fin(s.elevator) / (30 / RAD), 'ELEV R');
  hbar(ctx, 340, 860, 320, fin(s.rudder) / (27 / RAD), 'RUDDER');
  // stabilizer & rudder trim
  const units = fin(s.stabUnits, 4);
  text(ctx, 'STAB', 500, 530, C.white, 26, 'center');
  rect(ctx, 440, 550, 120, 56, { stroke: C.white, lw: 3 });
  text(ctx, units.toFixed(2), 500, 578, C.green, 34, 'center');
  const rt = fin(sim.controls?.rudderTrim) * 15;
  text(ctx, 'RUD TRIM', 500, 680, C.white, 24, 'center');
  text(ctx, `${rt < -0.05 ? 'L' : rt > 0.05 ? 'R' : ''} ${Math.abs(rt).toFixed(1)}`, 500, 716, C.white, 30, 'center');
  const mode = sim.fbw?.mode || 'NORMAL';
  text(ctx, `PFC ${mode}`, 500, 780, mode === 'NORMAL' ? C.green : C.amber, 26, 'center');
}

function pageGEAR(ctx, sim) {
  title(ctx, 'GEAR');
  const g = fin(sim.surfaces?.gear, 1);
  const gs = sys(sim).gear || {};
  const bt = gs.brakeTemp || [];
  const tp = gs.tirePsi || [];
  const st = g > 0.99 ? ['DOWN', C.green] : g < 0.01 ? ['UP', C.white] : ['TRANSIT', C.amber];
  const gearBox = (x, y, lab) => {
    rect(ctx, x - 70, y - 26, 140, 52, { stroke: st[1], lw: 3 });
    text(ctx, st[0], x, y, st[1], 26, 'center');
    text(ctx, lab, x, y - 48, C.white, 22, 'center');
  };
  gearBox(500, 170, 'NOSE');
  gearBox(300, 330, 'LEFT'); gearBox(700, 330, 'RIGHT');
  // 6-wheel main gear trucks: brake temp & tire pressure
  for (const [side, x0] of [[0, 220], [1, 620]]) {
    for (let k = 0; k < 6; k++) {
      const col = k % 2, row = Math.floor(k / 2);
      const x = x0 + col * 100, y = 470 + row * 140;
      const idx = side * 6 + k;
      const temp = fin(bt[idx], 1 + fin(sim.surfaces?.brakes?.[side]) * 2);
      rect(ctx, x, y, 60, 100, { stroke: temp > 5 ? C.amber : C.white, lw: 3 });
      text(ctx, temp.toFixed(1), x + 30, y + 30, temp > 5 ? C.amber : C.white, 24, 'center');
      text(ctx, String(Math.round(fin(tp[idx], 210))), x + 30, y + 72, C.white, 22, 'center');
    }
  }
  text(ctx, 'BRAKE TEMP', 500, 520, C.white, 20, 'center');
  text(ctx, 'TIRE PSI', 500, 560, C.white, 20, 'center');
  text(ctx, `AUTOBRAKE ${sim.controls?.autobrake || 'OFF'}`, 500, 920, C.white, 26, 'center');
}

const DOORS = [['ENTRY 1L', 1], ['ENTRY 2L', 2], ['ENTRY 3L', 3], ['ENTRY 4L', 4], ['ENTRY 5L', 5],
  ['ENTRY 1R', 1], ['ENTRY 2R', 2], ['ENTRY 3R', 3], ['ENTRY 4R', 4], ['ENTRY 5R', 5]];

function pageDOOR(ctx, sim) {
  title(ctx, 'DOORS');
  const ds = sys(sim).doors || {};
  // fuselage outline
  ctx.strokeStyle = C.white; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(500, 90); ctx.bezierCurveTo(580, 110, 590, 190, 590, 240);
  ctx.lineTo(590, 860); ctx.lineTo(540, 940); ctx.lineTo(460, 940); ctx.lineTo(410, 860); ctx.lineTo(410, 240);
  ctx.bezierCurveTo(410, 190, 420, 110, 500, 90); ctx.stroke();
  const isOpen = (name) => !!(ds[name] ?? ds[name.replace(' ', '_')] ?? ds[name.toLowerCase().replace(/\s/g, '')]);
  DOORS.forEach(([name, n]) => {
    const left = name.endsWith('L');
    const y = 180 + (n - 1) * 165;
    const x = left ? 396 : 590;
    const open = isOpen(name);
    rect(ctx, x, y, 14, 46, { fill: open ? C.amber : null, stroke: open ? C.amber : C.white, lw: 2 });
    text(ctx, name.replace('ENTRY ', ''), left ? x - 14 : x + 30, y + 23, open ? C.amber : C.white, 24, left ? 'right' : 'left');
  });
  for (const [name, y, side] of [['FWD CARGO', 300, 1], ['AFT CARGO', 700, 1], ['BULK CARGO', 820, 1], ['E/E ACCESS', 240, -1]]) {
    const open = isOpen(name);
    const x = side > 0 ? 576 : 410;
    rect(ctx, x, y, 14, 30, { fill: open ? C.amber : null, stroke: open ? C.amber : C.white, lw: 2 });
    text(ctx, name, side > 0 ? 660 : 340, y + 15, open ? C.amber : C.white, 22, side > 0 ? 'left' : 'right');
  }
}

const PAGE_FN = { ENG: pageENG, FUEL: pageFUEL, ELEC: pageELEC, HYD: pageHYD, FCTL: pageFCTL, GEAR: pageGEAR, DOOR: pageDOOR };

/** Lower EICAS: page buttons (HTML) above a square synoptic display. */
export function createLowerEICAS(el, sim) {
  const wrap = document.createElement('div');
  wrap.className = 'mfd';
  const bar = document.createElement('div');
  bar.className = 'mfd-pages';
  const screen = document.createElement('div');
  screen.className = 'mfd-screen av-host';
  wrap.append(bar, screen);
  el.appendChild(wrap);
  if (!sim.efis.lowerPage) sim.efis.lowerPage = 'ENG';
  const buttons = LOWER_PAGES.map((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mfd-btn'; b.textContent = p; b.dataset.page = p;
    b.addEventListener('click', () => { sim.efis.lowerPage = p; sync(); disp.render(); });
    bar.appendChild(b);
    return b;
  });
  function sync() { buttons.forEach((b) => b.classList.toggle('on', b.dataset.page === sim.efis.lowerPage)); }
  sync();
  const disp = createDisplay(screen, (ctx) => {
    sync();
    (PAGE_FN[sim.efis.lowerPage] || pageENG)(ctx, sim);
  });
  return disp;
}
void textW; void pad;
