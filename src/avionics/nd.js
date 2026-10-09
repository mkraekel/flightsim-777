// Boeing 777 Navigation Display: expanded MAP / APP / VOR (arc), CTR variants and PLN (north up).
// 1000x1000 virtual canvas. Positions are projected with great-circle bearing/distance from the
// aircraft; the map is rotated so that the selected reference (track in MAP, heading in APP/VOR,
// true north in PLN) points up. Rose labels are magnetic (true - magVar).
import { KT, NM, FT, FPM, RAD, DEG, G0, clamp, distance, bearing } from '../core/geo.js';
import { C, createDisplay, text, textW, line, poly, rect, circle, fin, pad, fmtHdg, wrapDeg, wrap180 } from './gfx.js';

const CLIP_TOP = 96;

function geom(efis) {
  const mode = efis.ndMode || 'MAP';
  if (mode === 'PLN') return { mode, cx: 500, cy: 540, R: 380, arc: false };
  if (efis.ctr) return { mode, cx: 500, cy: 540, R: 380, arc: false };
  return { mode, cx: 500, cy: 820, R: 640, arc: true };
}

function readData(sim) {
  const ac = sim.ac, efis = sim.efis || {};
  const magVar = fin(ac.magVar) * RAD;
  const g = geom(efis);
  const hdgT = fin(ac.euler?.heading) * RAD;
  const trkT = ac.gs > 3 ? fin(ac.track) * RAD : hdgT;
  const range = clamp(fin(efis.ndRangeNm, 40), 0.5, 640);
  const upT = g.mode === 'PLN' ? 0 : g.mode === 'MAP' ? trkT : hdgT;
  const d = {
    sim, ac, efis, ...g, magVar, hdgT, trkT, upT, range,
    hdgM: wrapDeg(hdgT - magVar), trkM: wrapDeg(trkT - magVar),
    gs: fin(ac.gs) / KT, tas: fin(ac.tas) / KT, alt: fin(ac.altMSL) / FT, vs: fin(ac.vs) / FPM,
    scale: (g.arc ? g.R : g.R) / range,  // units per nm (full range = rose radius)
    lat: fin(ac.lat), lon: fin(ac.lon),
  };
  // PLN is centred on the active waypoint (or the aircraft when there is no route)
  if (g.mode === 'PLN') {
    const r = sim.fmc?.route || [];
    const wp = r[clamp(fin(sim.fmc?.activeLeg), 0, Math.max(0, r.length - 1))];
    d.refLat = wp ? wp.lat : d.lat; d.refLon = wp ? wp.lon : d.lon;
  } else { d.refLat = d.lat; d.refLon = d.lon; }
  return d;
}

/** Project lat/lon (rad) to screen. */
function proj(d, lat, lon) {
  const dist = distance(d.refLat, d.refLon, lat, lon) / NM;
  const rel = (bearing(d.refLat, d.refLon, lat, lon) * RAD - d.upT) / RAD;
  return [d.cx + Math.sin(rel) * dist * d.scale, d.cy - Math.cos(rel) * dist * d.scale];
}

function clipMap(ctx, d) {
  ctx.beginPath();
  if (d.arc) { ctx.rect(0, CLIP_TOP, 1000, 1000 - CLIP_TOP); }
  else ctx.arc(d.cx, d.cy, d.R + 6, 0, Math.PI * 2);
  ctx.clip();
}

// ---------------------------------------------------------------- compass rose
function drawRose(ctx, d) {
  const { cx, cy, R } = d;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, CLIP_TOP - 40, 1000, 1000); ctx.clip();
  ctx.strokeStyle = C.white; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  for (let k = 0; k < 360; k += 5) {
    const rel = (k + d.magVar - d.upT);
    if (d.arc && Math.abs(wrap180(rel)) > 62) continue;
    const a = rel * DEG;
    const major = k % 10 === 0;
    const sx = Math.sin(a), sy = -Math.cos(a);
    line(ctx, cx + sx * R, cy + sy * R, cx + sx * (R - (major ? 24 : 12)), cy + sy * (R - (major ? 24 : 12)), C.white, 3);
    if (k % 30 === 0) {
      ctx.save(); ctx.translate(cx + sx * (R - 46), cy + sy * (R - 46)); ctx.rotate(a);
      text(ctx, String(k / 10), 0, 0, C.white, k % 90 === 0 ? 34 : 30, 'center');
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawHeadingBits(ctx, d) {
  const { cx, cy, R } = d;
  const ap = d.sim.ap || {};
  // heading pointer (triangle on the rose at actual heading)
  const relH = (d.hdgT - d.upT) * DEG;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(relH);
  poly(ctx, [0, -R, -14, -R - 24, 14, -R - 24], { stroke: C.white, w: 3 });
  ctx.restore();
  // selected heading/track bug + dashed line when a HDG/TRK SEL mode is active
  const selM = fin(ap.sel?.hdgDeg);
  const relS = wrap180(selM + d.magVar - d.upT + (ap.sel?.hdgIsTrk && d.mode !== 'MAP' ? 0 : 0));
  const clampS = d.arc ? clamp(relS, -50, 50) : relS;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(clampS * DEG);
  if (/HDG SEL|TRK SEL/.test(ap.modes?.roll || '')) {
    ctx.setLineDash([16, 14]); line(ctx, 0, 0, 0, -R, C.magenta, 3); ctx.setLineDash([]);
  }
  poly(ctx, [-22, -R, -22, -R - 16, 22, -R - 16, 22, -R, 9, -R, 0, -R + 13, -9, -R], { stroke: C.magenta, w: 3 });
  ctx.restore();
  // track line with range mark (white), rotated by drift in heading-up modes
  const relT = (d.trkT - d.upT) * DEG;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(relT);
  line(ctx, 0, -36, 0, -R, C.white, 3);
  line(ctx, -12, -R / 2, 12, -R / 2, C.white, 3);
  ctx.restore();
}

function drawRangeArcs(ctx, d) {
  const { cx, cy, R } = d;
  ctx.save();
  ctx.setLineDash([14, 16]); ctx.strokeStyle = C.white; ctx.lineWidth = 2.5;
  const fracs = d.arc ? [0.25, 0.5, 0.75] : [0.5];
  for (const f of fracs) {
    ctx.beginPath();
    if (d.arc) ctx.arc(cx, cy, R * f, -Math.PI / 2 - 1.05, -Math.PI / 2 + 1.05);
    else ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  const half = d.range / 2;
  const lab = half < 1 ? half.toFixed(2).replace(/^0/, '') : String(Math.round(half * 10) / 10);
  const a = -1.05;
  const lx = cx + Math.sin(a) * R * 0.5 - 18, ly = cy - Math.cos(a) * R * 0.5;
  rect(ctx, lx - textW(ctx, lab, 26) - 4, ly - 15, textW(ctx, lab, 26) + 8, 30, { fill: '#000' });
  text(ctx, lab, lx, ly, C.white, 26, 'right');
}

function drawAirplane(ctx, d) {
  if (d.mode === 'PLN') {
    const [x, y] = proj(d, d.lat, d.lon);
    ctx.save(); ctx.translate(x, y); ctx.rotate((d.trkT - d.upT) * DEG);
    poly(ctx, [0, -26, -16, 18, 16, 18], { stroke: C.white, w: 3 });
    ctx.restore();
    return;
  }
  poly(ctx, [d.cx, d.cy - 34, d.cx - 20, d.cy + 20, d.cx + 20, d.cy + 20], { stroke: C.white, w: 4 });
}

// ---------------------------------------------------------------- route / map data
function star(ctx, x, y, col, s = 14) {
  const k = s * 0.32;
  poly(ctx, [x, y - s, x + k, y - k, x + s, y, x + k, y + k, x, y + s, x - k, y + k, x - s, y, x - k, y - k], { stroke: col, w: 2.5 });
}

function drawRoute(ctx, d) {
  const fmc = d.sim.fmc || {};
  const route = fmc.route || [];
  if (!route.length) return;
  const act = clamp(fin(fmc.activeLeg), 0, route.length - 1);
  const pts = route.map((w) => proj(d, w.lat, w.lon));
  // magenta active route: from aircraft (or previous wpt) through the remaining waypoints
  ctx.strokeStyle = C.magenta; ctx.lineWidth = 4;
  ctx.beginPath();
  if (act > 0) ctx.moveTo(pts[act - 1][0], pts[act - 1][1]);
  else { const [x0, y0] = proj(d, d.lat, d.lon); ctx.moveTo(x0, y0); }
  for (let i = act; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  for (let i = Math.max(0, act - 1); i < pts.length; i++) {
    const [x, y] = pts[i];
    if (x < -50 || x > 1050 || y < -50 || y > 1050) continue;
    const col = i === act ? C.magenta : C.white;
    star(ctx, x, y, col);
    text(ctx, route[i].ident || '', x + 20, y - 4, col, 26, 'left', 'bottom');
    if (d.efis.data && route[i].altFt) text(ctx, String(route[i].altFt), x + 20, y + 2, C.white, 22, 'left', 'top');
  }
  // top of descent marker
  if (fmc.todNm != null && fmc.todNm > 0 && fmc.todNm < d.range) {
    const s = fmc.todNm * d.scale;
    const rel = (d.trkT - d.upT) * DEG;
    const x = d.cx + Math.sin(rel) * s, y = d.cy - Math.cos(rel) * s;
    circle(ctx, x, y, 10, { stroke: C.green, w: 3 });
    text(ctx, 'T/D', x + 16, y, C.green, 24);
  }
}

function airportPos(apt) {
  const r0 = apt?.runways?.[0];
  const lat = apt?.lat ?? r0?.lat, lon = apt?.lon ?? r0?.lon;
  return lat == null ? null : { lat: lat * DEG, lon: lon * DEG };
}

function drawAirports(ctx, d) {
  if (!d.efis.arpt && d.mode !== 'PLN') return;
  const fmc = d.sim.fmc || {};
  for (const apt of new Set([fmc.origin, fmc.dest])) {
    const p = airportPos(apt);
    if (!p) continue;
    const [x, y] = proj(d, p.lat, p.lon);
    if (d.range <= 40 && apt.runways?.length) {
      // runway outlines (white) when zoomed in
      for (const rw of apt.runways) {
        if (rw.endLat == null) continue;
        const a = proj(d, rw.lat * DEG, rw.lon * DEG), b = proj(d, rw.endLat * DEG, rw.endLon * DEG);
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const w = Math.max(3, fin(rw.widthM, 45) / NM * d.scale * 2);
        const nx = -dy / L * w, ny = dx / L * w;
        poly(ctx, [a[0] + nx, a[1] + ny, b[0] + nx, b[1] + ny, b[0] - nx, b[1] - ny, a[0] - nx, a[1] - ny], { stroke: C.white, w: 2 });
      }
      text(ctx, apt.icao || '', x - 20, y + 30, C.white, 26, 'right');
    } else {
      circle(ctx, x, y, 14, { stroke: C.cyan, w: 3 });
      text(ctx, apt.icao || '', x - 20, y + 22, C.cyan, 26, 'right');
    }
  }
}

function drawTrendVector(ctx, d) {
  if (d.mode === 'PLN' || d.gs < 40 || d.sim.ac.onGround) return;
  const roll = fin(d.ac.euler?.roll);
  if (Math.abs(roll) < 1 * DEG) return;
  const tas = Math.max(50, fin(d.ac.tas));
  const w = G0 * Math.tan(roll) / tas;          // rad/s turn rate
  const vNm = d.gs / 3600;                      // nm/s
  const tMax = d.range > 20 ? 90 : d.range > 10 ? 60 : 30;
  let a = (d.trkT - d.upT) * DEG, x = d.cx, y = d.cy;
  ctx.save(); ctx.strokeStyle = C.white; ctx.lineWidth = 3; ctx.setLineDash([22, 14]);
  ctx.beginPath(); ctx.moveTo(x, y);
  for (let t = 0; t < tMax; t += 2) {
    x += Math.sin(a) * vNm * 2 * d.scale; y -= Math.cos(a) * vNm * 2 * d.scale; a += w * 2;
    ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.restore();
}

function drawAltRangeArc(ctx, d) {
  const sel = fin(d.sim.ap?.sel?.altFt);
  const dh = sel - d.alt;
  if (Math.abs(d.vs) < 200 || Math.sign(dh) !== Math.sign(d.vs) || d.mode === 'PLN') return;
  const nm = (dh / d.vs) / 60 * d.gs;
  if (nm <= 0.1 || nm > d.range) return;
  const r = nm * d.scale;
  const rel = (d.trkT - d.upT) * DEG - Math.PI / 2;
  ctx.strokeStyle = C.green; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(d.cx, d.cy, r, rel - 0.22, rel + 0.22); ctx.stroke();
}

function drawTerrain(ctx, d) {
  if (!d.efis.terr || d.mode === 'PLN') return;
  const env = d.sim.env || {};
  const ground = (fin(env.groundH) - fin(env.geoidN)) / FT;
  const rel = ground - d.alt;
  let col = null;
  if (rel > 2000) col = C.red; else if (rel > -500) col = C.amber; else if (rel > -2000) col = C.green;
  if (!col || !env.groundValid) return;
  ctx.fillStyle = col;
  for (let y = CLIP_TOP; y < 1000; y += 14) for (let x = (y / 14) % 2 ? 0 : 7; x < 1000; x += 14) ctx.fillRect(x, y, 3, 3);
}

function drawTCAS(ctx, d) {
  if (!d.efis.tfc || d.mode === 'PLN') return;
  const r = 3 * d.scale;
  if (r < 30 || r > d.R) return;
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 6;
    circle(ctx, d.cx + Math.cos(a) * r, d.cy + Math.sin(a) * r, 4, { fill: C.white });
  }
}

// ---------------------------------------------------------------- APP / VOR course
function drawCourse(ctx, d) {
  const ils = d.sim.nav?.ils;
  if (!ils?.valid) { text(ctx, d.mode === 'APP' ? 'ILS' : 'VOR', 500, 470, C.amber, 30, 'center'); return; }
  const rel = (fin(ils.crsRad) * RAD - d.upT) * DEG;
  const R = d.R * (d.arc ? 0.62 : 0.9), DOT = 70;
  ctx.save(); ctx.translate(d.cx, d.cy - (d.arc ? 260 : 0)); ctx.rotate(rel);
  // course pointer (white) with arrow, deviation bar (magenta)
  line(ctx, 0, -R, 0, -R * 0.42, C.white, 4);
  line(ctx, 0, R * 0.42, 0, R, C.white, 4);
  poly(ctx, [0, -R - 26, -16, -R, 16, -R], { fill: C.white });
  for (const k of [-2, -1, 1, 2]) circle(ctx, k * DOT, 0, 8, { stroke: C.white, w: 3 });
  const dev = clamp(-fin(ils.locDots), -2.5, 2.5) * DOT;
  line(ctx, dev, -R * 0.4, dev, R * 0.4, C.magenta, 5);
  ctx.restore();
  // glideslope scale on the right
  if (d.mode === 'APP') {
    const gx = 968, gy = 560;
    for (const k of [-2, -1, 1, 2]) circle(ctx, gx, gy + k * 50, 7, { stroke: C.white, w: 3 });
    line(ctx, gx - 18, gy, gx + 18, gy, C.white, 3);
    const yy = gy + clamp(fin(ils.gsDots), -2.4, 2.4) * 50;
    poly(ctx, [gx - 12, yy, gx, yy - 18, gx + 12, yy, gx, yy + 18], { fill: C.magenta });
  }
}

// ---------------------------------------------------------------- header texts
function drawHeader(ctx, d) {
  const sim = d.sim, env = sim.env || {};
  // GS / TAS
  text(ctx, 'GS', 18, 34, C.white, 24); text(ctx, String(Math.round(d.gs)), 62, 32, C.white, 34);
  if (d.tas > 100) { text(ctx, 'TAS', 150, 34, C.white, 24); text(ctx, String(Math.round(d.tas)), 206, 32, C.white, 34); }
  // wind
  const wk = fin(env.windKt);
  if (d.tas > 100 && wk >= 1) {
    const wdM = wrapDeg(fin(env.windDirDeg) - d.magVar);
    text(ctx, `${pad(Math.round(wdM) % 360, 3)}°/${Math.round(wk)}`, 18, 74, C.white, 28);
    const a = (fin(env.windDirDeg) + 180 - d.upT) * DEG;
    ctx.save(); ctx.translate(48, 128); ctx.rotate(a);
    line(ctx, 0, 24, 0, -24, C.white, 3);
    poly(ctx, [-9, -10, 0, -26, 9, -10], { fill: C.white });
    ctx.restore();
  }
  // HDG/TRK box (top centre)
  const ref = d.mode === 'MAP' ? 'TRK' : d.mode === 'PLN' ? 'TRK' : 'HDG';
  const val = fmtHdg(ref === 'TRK' ? d.trkM : d.hdgM);
  text(ctx, ref, 418, 36, C.green, 30, 'right');
  rect(ctx, 428, 10, 110, 52, { stroke: C.white, lw: 3, fill: '#000' });
  text(ctx, val, 483, 37, C.white, 38, 'center');
  text(ctx, 'MAG', 550, 36, C.green, 30, 'left');
  // active waypoint (top right)
  const fmc = sim.fmc || {};
  const route = fmc.route || [];
  if (d.mode === 'APP' || d.mode === 'VOR') {
    const ils = sim.nav?.ils;
    if (ils?.valid) {
      text(ctx, `${ils.ident || ''} ${fin(ils.freq).toFixed(2)}`, 982, 32, C.green, 28, 'right');
      text(ctx, `CRS ${fmtHdg(fin(ils.crsRad) * RAD - d.magVar)}`, 982, 66, C.white, 26, 'right');
      text(ctx, `DME ${fin(ils.distNm).toFixed(1)}`, 982, 98, C.white, 26, 'right');
    }
    return;
  }
  const wp = route[clamp(fin(fmc.activeLeg), 0, Math.max(0, route.length - 1))];
  if (wp) {
    const nm = distance(d.lat, d.lon, wp.lat, wp.lon) / NM;
    const etaH = fin(env.timeOfDayH, 12) + (d.gs > 30 ? nm / d.gs : 0);
    const hh = Math.floor(((etaH % 24) + 24) % 24), mm = (etaH - Math.floor(etaH)) * 60;
    text(ctx, wp.ident || '', 982, 32, C.magenta, 32, 'right');
    text(ctx, `${pad(hh, 2)}${pad(Math.floor(mm), 2)}.${Math.floor((mm % 1) * 10)}z`, 982, 66, C.white, 28, 'right');
    const dt = nm >= 100 ? nm.toFixed(0) : nm.toFixed(1);
    text(ctx, 'NM', 982, 100, C.white, 22, 'right');
    text(ctx, dt, 982 - textW(ctx, 'NM', 22) - 8, 98, C.white, 32, 'right');
  }
}

function drawFooter(ctx, d) {
  const ef = d.efis;
  const labels = [];
  if (ef.terr) labels.push(['TERR', C.cyan]);
  if (ef.wxr) labels.push(['WXR', C.green]);
  let y = 860;
  for (const [t, c] of labels) { text(ctx, t, 982, y, c, 26, 'right'); y += 32; }
  if (ef.tfc) text(ctx, 'TFC', 18, 940, C.cyan, 26);
  if (d.mode === 'PLN') {
    // north arrow
    const x = 930, y0 = 250;
    poly(ctx, [x, y0 - 50, x - 14, y0 - 16, x + 14, y0 - 16], { fill: C.white });
    line(ctx, x, y0 - 16, x, y0 + 30, C.white, 3);
    text(ctx, 'N', x, y0 - 76, C.white, 30, 'center');
  }
}

// ---------------------------------------------------------------- public
export function createND(el, sim) {
  return createDisplay(el, (ctx) => {
    const d = readData(sim);
    ctx.save();
    clipMap(ctx, d);
    drawTerrain(ctx, d);
    if (d.mode === 'MAP' || d.mode === 'PLN') {
      drawAirports(ctx, d);
      drawRoute(ctx, d);
      drawAltRangeArc(ctx, d);
      drawTrendVector(ctx, d);
      drawTCAS(ctx, d);
    } else {
      drawCourse(ctx, d);
      drawTCAS(ctx, d);
    }
    if (d.mode !== 'PLN') drawRangeArcs(ctx, d);
    ctx.restore();
    if (d.mode !== 'PLN') { drawRose(ctx, d); drawHeadingBits(ctx, d); }
    else {
      ctx.strokeStyle = C.white; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(d.cx, d.cy, d.R, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([14, 16]); ctx.beginPath(); ctx.arc(d.cx, d.cy, d.R / 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      text(ctx, String(d.range / 2), d.cx - d.R / 2 * 0.7 - 10, d.cy - d.R / 2 * 0.7, C.white, 26, 'right');
    }
    drawAirplane(ctx, d);
    drawHeader(ctx, d);
    drawFooter(ctx, d);
  });
}
