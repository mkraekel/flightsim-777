// Boeing 777 Control Display Unit (Team D1). Renders inside #drawer-cdu.
//
// Screen: 14 lines x 24 characters (line 1 title, 6 label/data pairs, line 14 scratchpad), large and
// small font, white / green / cyan / magenta / amber text. 6 line select keys each side, function keys,
// alphanumeric keypad, EXEC with its lit bar, MSG / EXEC annunciators.
// Pages: MENU, INIT/REF INDEX, IDENT, POS INIT, PERF INIT, THRUST LIM, TAKEOFF REF, APPROACH REF, RTE,
// DEP/ARR, LEGS, PROGRESS, VNAV (CLB/CRZ/DES), NAV RAD, ALTN, FIX, HOLD, FMC COMM.
// Physical keyboard input is accepted only while the CDU element has focus (focus-scoped listener).

import { RAD, DEG, NM, FT, KT, wrap360, distance, bearing } from '../core/geo.js';
import {
  beginMod, execMod, eraseMod, directTo, deleteWaypoint, insertWaypoint, linkTo, buildDefaultRoute,
  parseLatLon, fmtLatLon, fmtZulu, runwayInfo, resolveAirport, fmcIndicatedAltFt,
} from '../systems/fmc.js';

const COLS = 24, ROWS = 14;
const BOX = '□';

// ------------------------------------------------------------------------------------------
// Screen buffer
// ------------------------------------------------------------------------------------------
class Screen {
  constructor() { this.cells = Array.from({ length: ROWS }, () => Array(COLS).fill(null)); }
  put(row, col, text, color = 'w', small = false) {
    text = String(text ?? '');
    for (let i = 0; i < text.length; i++) {
      const c = col + i;
      if (c < 0 || c >= COLS || row < 0 || row >= ROWS) continue;
      this.cells[row][c] = { ch: text[i], color, small };
    }
  }
  left(row, text, color, small) { this.put(row, 0, text, color, small); }
  right(row, text, color, small) { this.put(row, COLS - String(text).length, text, color, small); }
  center(row, text, color, small) { this.put(row, Math.floor((COLS - String(text).length) / 2), text, color, small); }
  title(text, pageNo, pages, color = 'w') {
    this.center(0, text, color);
    if (pages > 1) this.right(0, `${pageNo}/${pages}`, 'w', true);
  }
  // LSK helpers: k = 1..6
  label(k, side, text, color = 'w') { side === 'L' ? this.put(2 * k - 1, 1, text, color, true) : this.right(2 * k - 1, text + ' ', color, true); }
  data(k, side, text, color = 'w', small = false) { side === 'L' ? this.left(2 * k, text, color, small) : this.right(2 * k, text, color, small); }
}

// ------------------------------------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------------------------------------
const fmtAlt = (ft) => (ft === null || ft === undefined || !Number.isFinite(ft) ? '-----' : ft >= 18000 ? 'FL' + String(Math.round(ft / 100)).padStart(3, '0') : String(Math.round(ft)));
const fmtCrs = (deg) => String(Math.round(wrap360(deg)) % 360).padStart(3, '0') + '°';
const tonnes = (kg) => (kg / 1000).toFixed(1);
const pad = (s, n) => String(s).padEnd(n, ' ');
const totalFuel = (sim) => (sim.ac.fuelKg.L || 0) + (sim.ac.fuelKg.C || 0) + (sim.ac.fuelKg.R || 0);
const gw = (sim) => (sim.fmc.grossWtKg > 0 ? sim.fmc.grossWtKg : sim.ac.mass > 0 ? sim.ac.mass : 0);

function parseAltEntry(s) {
  s = s.trim().toUpperCase();
  let m = /^FL(\d{2,3})$/.exec(s); if (m) return Number(m[1]) * 100;
  m = /^(\d{3})$/.exec(s); if (m) return Number(m[1]) * 100;
  m = /^(\d{4,5})$/.exec(s); if (m) return Number(m[1]);
  return null;
}

// ------------------------------------------------------------------------------------------
// Module state
// ------------------------------------------------------------------------------------------
let S = null; // { sim, el, screen rows, page, sub, scratch, msg, refs, cache }

function setMsg(text) { S.msg = text; }
function takeScratch() { const s = S.scratch; S.scratch = ''; return s; }
const invalid = () => setMsg('INVALID ENTRY');

function goto(page, sub = 0) { S.page = page; S.sub = sub; }

// ------------------------------------------------------------------------------------------
// Pages
// ------------------------------------------------------------------------------------------
const routeView = (sim) => (sim.fmc.mod ? sim.fmc.mod : { route: sim.fmc.route || [], activeLeg: sim.fmc.activeLeg, origin: sim.fmc.origin, dest: sim.fmc.dest, depRwy: sim.fmc.depRwy, arrRwy: sim.fmc.arrRwy });
const actTag = (sim) => (sim.fmc.mod ? 'MOD' : (sim.fmc.route || []).length ? 'ACT' : '');

const PAGES = {
  MENU: {
    render(s) {
      s.title('MENU');
      s.label(1, 'L', ''); s.data(1, 'L', '<FMC'); s.data(1, 'R', '<ACT>', 'g', true);
      s.data(2, 'L', '<SAT'); s.data(3, 'L', '<ACARS');
      s.label(6, 'R', 'EFIS CP'); s.data(6, 'R', 'SELECT>', 'w');
    },
    lsk(sim, side, k) { if (side === 'L' && k === 1) goto('IDENT'); },
  },
  INDEX: {
    render(s) {
      s.title('INIT/REF INDEX');
      s.data(1, 'L', '<IDENT'); s.data(1, 'R', 'NAV DATA>');
      s.data(2, 'L', '<POS'); s.data(3, 'L', '<PERF'); s.data(4, 'L', '<THRUST LIM');
      s.data(5, 'L', '<TAKEOFF'); s.data(6, 'L', '<APPROACH'); s.data(6, 'R', 'MAINT>');
    },
    lsk(sim, side, k) {
      if (side !== 'L') return;
      goto(['IDENT', 'POS', 'PERF', 'THRLIM', 'TAKEOFF', 'APPROACH'][k - 1]);
    },
  },
  IDENT: {
    render(s, sim) {
      s.title('IDENT');
      s.label(1, 'L', 'MODEL'); s.data(1, 'L', '777-300ER');
      s.label(1, 'R', 'ENGINES'); s.data(1, 'R', 'GE90-115BL');
      s.label(2, 'L', 'NAV DATA'); s.data(2, 'L', 'SIM2610');
      s.label(2, 'R', 'ACTIVE'); s.data(2, 'R', 'OCT09NOV05/26');
      s.label(4, 'L', 'OP PROGRAM'); s.data(4, 'L', 'BP4501-D1');
      s.label(5, 'L', 'DRAG/FF'); s.data(5, 'L', '+0.0/+0.0');
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<INDEX'); s.data(6, 'R', 'POS INIT>');
      void sim;
    },
    lsk(sim, side, k) { if (k === 6) goto(side === 'L' ? 'INDEX' : 'POS'); },
  },
  POS: {
    render(s, sim) {
      s.title('POS INIT', 1, 1);
      const o = sim.fmc.origin;
      s.label(1, 'R', 'LAST POS'); s.data(1, 'R', fmtLatLon(sim.ac.lat, sim.ac.lon));
      s.label(2, 'L', 'REF AIRPORT'); s.data(2, 'L', o ? o.icao : '----');
      if (o) s.data(2, 'R', fmtLatLon(o.lat * DEG, o.lon * DEG));
      s.label(3, 'L', 'GATE'); s.data(3, 'L', '-----');
      s.label(4, 'L', 'UTC (GPS)'); s.data(4, 'L', fmtZulu(sim.env.timeOfDayH));
      s.label(4, 'R', 'GPS POS'); s.data(4, 'R', fmtLatLon(sim.ac.lat, sim.ac.lon));
      s.label(5, 'R', 'SET IRS POS');
      s.data(5, 'R', S.irsSet ? fmtLatLon(sim.ac.lat, sim.ac.lon) : `${BOX.repeat(3)}°${BOX.repeat(2)}.${BOX} ${BOX.repeat(4)}°${BOX.repeat(2)}.${BOX}`, S.irsSet ? 'w' : 'w');
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<INDEX'); s.data(6, 'R', 'ROUTE>');
    },
    lsk(sim, side, k) {
      if (k === 6) return goto(side === 'L' ? 'INDEX' : 'RTE');
      if (side === 'R' && (k === 4 || k === 1) && !S.scratch) { S.scratch = fmtLatLon(sim.ac.lat, sim.ac.lon); return; }
      if (side === 'R' && k === 5) {
        const sp = takeScratch();
        if (!sp || parseLatLon(sp)) S.irsSet = true; else invalid();
      }
    },
  },
  PERF: {
    render(s, sim) {
      const f = sim.fmc;
      s.title('PERF INIT');
      s.label(1, 'L', 'GR WT'); s.data(1, 'L', gw(sim) ? tonnes(gw(sim)) : BOX.repeat(5), 'w', !(f.grossWtKg > 0));
      s.label(1, 'R', 'CRZ ALT'); s.data(1, 'R', f.crzAltFt ? fmtAlt(f.crzAltFt) : BOX.repeat(5));
      s.label(2, 'L', 'FUEL'); s.data(2, 'L', tonnes(totalFuel(sim)) + ' CALC', 'w', true);
      s.label(3, 'L', 'ZFW'); s.data(3, 'L', gw(sim) ? tonnes(gw(sim) - totalFuel(sim)) : BOX.repeat(5), 'w', true);
      s.label(3, 'R', 'CRZ CG'); s.data(3, 'R', (sim.ac.cgMacPct || 25).toFixed(1) + '%', 'w', true);
      s.label(4, 'L', 'RESERVES'); s.data(4, 'L', tonnes(f.reserveKg || 0));
      s.label(4, 'R', 'STEP SIZE'); s.data(4, 'R', 'ICAO');
      s.label(5, 'L', 'COST INDEX'); s.data(5, 'L', String(f.costIndex ?? BOX.repeat(4)));
      s.label(5, 'R', 'FUEL TEMP'); s.data(5, 'R', '-37°C', 'w', true);
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<INDEX'); s.data(6, 'R', 'THRUST LIM>');
    },
    lsk(sim, side, k) {
      const f = sim.fmc;
      if (k === 6) return goto(side === 'L' ? 'INDEX' : 'THRLIM');
      const sp = S.scratch;
      if (!sp) {
        if (side === 'L' && k === 1 && gw(sim)) S.scratch = tonnes(gw(sim));
        return;
      }
      takeScratch();
      if (sp === 'DELETE') { if (side === 'L' && k === 1) f.grossWtKg = null; else invalid(); return; }
      if (side === 'L' && k === 1) { const v = Number(sp); if (v >= 150 && v <= 360) f.grossWtKg = v * 1000; else invalid(); }
      else if (side === 'R' && k === 1) { const a = parseAltEntry(sp); if (a && a >= 1000 && a <= 43100) f.crzAltFt = a; else invalid(); }
      else if (side === 'L' && k === 4) { const v = Number(sp); if (v >= 0 && v <= 50) f.reserveKg = v * 1000; else invalid(); }
      else if (side === 'L' && k === 5) { const v = Number(sp); if (Number.isInteger(v) && v >= 0 && v <= 9999) f.costIndex = v; else invalid(); }
      else invalid();
    },
  },
  THRLIM: {
    render(s, sim) {
      const t = sim.fmc.toThrust || 'TO';
      s.title('THRUST LIM');
      s.label(1, 'L', 'SEL'); s.data(1, 'L', '--°C'); s.label(1, 'R', 'OAT'); s.data(1, 'R', `${Math.round(15 + (sim.env.tempDevC || 0))}°C`, 'w', true);
      const opt = (k, side, name, sel) => s.data(k, side, side === 'L' ? `<${name}` + (sel ? ' <SEL>' : '') : (sel ? '<SEL> ' : '') + `${name}>`, 'w');
      opt(2, 'L', 'TO', t === 'TO'); opt(3, 'L', 'TO 1', t === 'TO 1'); opt(4, 'L', 'TO 2', t === 'TO 2');
      opt(2, 'R', 'CLB', true); opt(3, 'R', 'CLB 1', false); opt(4, 'R', 'CLB 2', false);
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<INDEX'); s.data(6, 'R', 'TAKEOFF>');
    },
    lsk(sim, side, k) {
      if (k === 6) return goto(side === 'L' ? 'INDEX' : 'TAKEOFF');
      if (side === 'L' && k >= 2 && k <= 4) sim.fmc.toThrust = ['TO', 'TO 1', 'TO 2'][k - 2];
    },
  },
  TAKEOFF: {
    render(s, sim) {
      const f = sim.fmc;
      s.title('TAKEOFF REF');
      s.label(1, 'L', 'FLAPS'); s.data(1, 'L', String(f.toFlaps || 15) + '°');
      s.label(2, 'L', 'THRUST'); s.data(2, 'L', f.toThrust || 'TO');
      s.label(3, 'L', 'CG'); s.data(3, 'L', (sim.ac.cgMacPct || 25).toFixed(1) + '%', 'w', true);
      s.label(3, 'R', 'TRIM'); s.data(3, 'R', (sim.surfaces.stabUnits ?? 4).toFixed(1), 'w', true);
      const v = (k, name, val, calc) => {
        s.label(k, 'R', name);
        const conf = S.vConfirmed || f.vOverride;
        // FMC-computed speeds are small font until the pilot selects (LSK) or enters them
        s.data(k, 'R', val > 0 ? String(Math.round(val)) : BOX.repeat(3), 'w', !conf);
        void calc;
      };
      v(1, 'V1', f.v1, f.calc.v1); v(2, 'VR', f.vr, f.calc.vr); v(4, 'V2', f.v2, f.calc.v2);
      s.label(4, 'L', 'RWY/POS'); s.data(4, 'L', f.depRwy ? 'RW' + f.depRwy.id : '-----');
      s.label(5, 'L', 'ACCEL HT'); s.data(5, 'L', `${f.accelHtFt || 1000}FT`, 'w', true);
      s.label(5, 'R', 'GR WT  TOW'); s.data(5, 'R', gw(sim) ? tonnes(gw(sim)) : '-----', 'w', true);
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<INDEX'); s.data(6, 'R', 'POS INIT>');
    },
    lsk(sim, side, k) {
      const f = sim.fmc;
      if (k === 6) return goto(side === 'L' ? 'INDEX' : 'POS');
      const sp = takeScratch();
      if (side === 'L' && k === 1) {
        const v = Number(sp); if ([5, 15, 20].includes(v)) { f.toFlaps = v; f.vOverride = false; S.vConfirmed = false; } else if (sp) invalid();
        return;
      }
      if (side === 'R' && [1, 2, 4].includes(k)) {
        const key = { 1: 'v1', 2: 'vr', 4: 'v2' }[k];
        if (!sp) { S.vConfirmed = true; if (key === 'v2' && sim.ap.sel && !sim.ap.sel.useMach && sim.ac.onGround) sim.ap.sel.spdKt = f.v2; return; }
        if (sp === 'DELETE') { f.vOverride = false; S.vConfirmed = false; return; }
        const v = Number(sp); if (v >= 100 && v <= 200) { f.vOverride = true; f[key] = v; } else invalid();
        return;
      }
      if (side === 'L' && k === 5) { const v = Number(sp); if (v >= 400 && v <= 9999) f.accelHtFt = v; else if (sp) invalid(); return; }
      if (sp) invalid();
    },
  },
  APPROACH: {
    render(s, sim) {
      const f = sim.fmc;
      s.title('APPROACH REF');
      s.label(1, 'L', 'GROSS WT'); s.data(1, 'L', gw(sim) ? tonnes(gw(sim)) : '-----');
      s.label(1, 'R', 'FLAPS    VREF');
      s.data(1, 'R', `25°  ${f.calc.vref25}KT`); s.data(2, 'R', `30°  ${f.calc.vref30}KT`);
      const rw = f.dest && f.arrRwy ? runwayInfo(f.dest, f.arrRwy) : null;
      if (rw) {
        s.label(3, 'L', f.dest.icao + 'RW' + rw.id);
        s.data(3, 'L', `${Math.round(rw.lengthM / FT)}FT${Math.round(rw.lengthM)}M`, 'w', true);
        s.label(4, 'L', 'ILS - MLS'); s.data(4, 'L', `${rw.ils.freq.toFixed(2)}${rw.ils.ident}/${fmtCrs(rw.ils.crsDeg)}`, 'g', true);
      } else { s.label(3, 'L', '----RW---'); }
      s.label(4, 'R', 'FLAP/SPD');
      s.data(4, 'R', f.vrefOverride || S.vrefSel ? `${f.ldgFlaps}/${Math.round(f.vref)}` : `${BOX.repeat(2)}/${BOX.repeat(3)}`);
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<INDEX'); s.data(6, 'R', 'THRUST LIM>');
    },
    lsk(sim, side, k) {
      const f = sim.fmc;
      if (k === 6) return goto(side === 'L' ? 'INDEX' : 'THRLIM');
      if (side === 'R' && (k === 1 || k === 2) && !S.scratch) { S.scratch = k === 1 ? `25/${f.calc.vref25}` : `30/${f.calc.vref30}`; return; }
      if (side === 'R' && k === 4) {
        const sp = takeScratch();
        if (sp === 'DELETE') { f.vrefOverride = false; S.vrefSel = false; return; }
        const m = /^(25|30)\/(\d{3})$/.exec(sp);
        if (!m) return invalid();
        f.ldgFlaps = Number(m[1]); const v = Number(m[2]);
        const calc = f.ldgFlaps === 25 ? f.calc.vref25 : f.calc.vref30;
        if (v === calc) { f.vrefOverride = false; } else if (v >= 100 && v <= 200) { f.vrefOverride = true; f.vref = v; } else return invalid();
        S.vrefSel = true;
      }
    },
  },
  RTE: {
    pages(sim) { return 1 + Math.max(1, Math.ceil(Math.max(0, routeView(sim).route.length - 2) / 5)); },
    render(s, sim, sub) {
      const v = routeView(sim), n = this.pages(sim);
      const tag = actTag(sim);
      s.title(`${tag ? tag + ' ' : ''}RTE 1`, sub + 1, n);
      if (sub === 0) {
        s.label(1, 'L', 'ORIGIN'); s.data(1, 'L', v.origin ? v.origin.icao : BOX.repeat(4));
        s.label(1, 'R', 'DEST'); s.data(1, 'R', v.dest ? v.dest.icao : BOX.repeat(4));
        s.label(2, 'L', 'RUNWAY'); s.data(2, 'L', v.depRwy ? 'RW' + v.depRwy.id : '-----');
        s.label(2, 'R', 'FLT NO'); s.data(2, 'R', sim.fmc.flightNo || '----------');
        s.label(3, 'R', 'CO ROUTE'); s.data(3, 'R', '----------');
        s.put(11, 0, '------------------------', 'w', true);
        s.data(6, 'L', '<RTE 2');
        s.data(6, 'R', sim.fmc.mod ? 'ACTIVATE>' : 'PERF INIT>');
      } else {
        s.label(1, 'L', 'VIA'); s.label(1, 'R', 'TO');
        const r = v.route, start = 1 + (sub - 1) * 5;
        for (let k = 1; k <= 5; k++) {
          const w = r[start + k - 1];
          if (!w || start + k - 1 >= r.length) { if (k === 1 || r[start + k - 2]) s.data(k, 'L', '-----'), s.data(k, 'R', '-----'); break; }
          s.data(k, 'L', 'DIRECT'); s.data(k, 'R', w.ident);
        }
        s.put(11, 0, '------------------------', 'w', true);
        s.data(6, 'L', '<RTE 2'); s.data(6, 'R', sim.fmc.mod ? 'ACTIVATE>' : 'PERF INIT>');
      }
    },
    lsk(sim, side, k, sub) {
      if (k === 6) { if (side === 'R') { if (sim.fmc.mod) { S.execArmed = true; } else goto('PERF'); } return; }
      if (sub !== 0) { if (S.scratch) invalid(); return; }
      const sp = takeScratch();
      if (side === 'L' && k === 1) {
        const a = resolveAirport(sim, sp);
        if (!a) return setMsg(sim.fmc.airports ? 'NOT IN DATA BASE' : 'NAV DATA LOADING');
        const m = beginMod(sim); m.origin = a; m.depRwy = a.runways && a.runways[0]; m.route = []; m.activeLeg = 1;
        if (m.dest) buildDefaultRoute(sim, a, m.dest, { intoMod: true, depRwy: m.depRwy });
      } else if (side === 'R' && k === 1) {
        const a = resolveAirport(sim, sp);
        if (!a) return setMsg(sim.fmc.airports ? 'NOT IN DATA BASE' : 'NAV DATA LOADING');
        const m = beginMod(sim); m.dest = a; m.arrRwy = null;
        if (m.origin) buildDefaultRoute(sim, m.origin, a, { intoMod: true, depRwy: m.depRwy });
      } else if (side === 'L' && k === 2) {
        const m = beginMod(sim);
        const id = sp.replace(/^RW/, '');
        const r = m.origin && m.origin.runways.find((x) => x.id === id);
        if (!r) { eraseIfEmpty(sim); return invalid(); }
        m.depRwy = r;
        if (m.dest) buildDefaultRoute(sim, m.origin, m.dest, { intoMod: true, depRwy: r, arrRwy: m.arrRwy });
      } else if (side === 'R' && k === 2) {
        if (/^[A-Z0-9]{1,10}$/.test(sp)) sim.fmc.flightNo = sp; else invalid();
      } else if (sp) invalid();
    },
  },
  DEPARR: {
    render(s, sim) {
      const v = routeView(sim);
      s.title('DEP/ARR INDEX');
      s.label(1, 'L', 'DEP'); s.label(1, 'R', 'ARR');
      if (v.origin) { s.data(1, 'L', '<DEP'); s.center(2, v.origin.icao, 'w'); s.data(1, 'R', 'ARR>'); }
      if (v.dest) { s.data(2, 'R', 'ARR>'); s.center(4, v.dest.icao, 'w'); s.put(4, 0, '', 'w'); }
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<DEP'); s.data(6, 'R', 'ARR>');
    },
    lsk(sim, side, k) {
      const v = routeView(sim);
      if (k === 1 && side === 'L' && v.origin) goto('RWYSEL', 0), (S.rwySel = 'DEP');
      else if (k === 2 && side === 'R' && v.dest) goto('RWYSEL', 0), (S.rwySel = 'ARR');
      else if (k === 1 && side === 'R' && v.origin) goto('RWYSEL', 0), (S.rwySel = 'DEP');
    },
  },
  RWYSEL: {
    pages(sim) { const a = S.rwySel === 'ARR' ? routeView(sim).dest : routeView(sim).origin; return Math.max(1, Math.ceil(((a && a.runways.length) || 0) / 5)); },
    render(s, sim, sub) {
      const v = routeView(sim), dep = S.rwySel !== 'ARR';
      const a = dep ? v.origin : v.dest, cur = dep ? v.depRwy : v.arrRwy;
      s.title(`${a ? a.icao : '----'} ${dep ? 'DEPARTURES' : 'ARRIVALS'}`, sub + 1, this.pages(sim));
      s.label(1, 'R', 'RUNWAYS');
      const list = (a && a.runways) || [];
      for (let k = 1; k <= 5; k++) {
        const r = list[sub * 5 + k - 1]; if (!r) break;
        const sel = cur && cur.id === r.id;
        s.data(k, 'R', (sel ? (sim.fmc.mod ? '<SEL> ' : '<ACT> ') : '') + (dep ? r.id : 'ILS' + r.id), sel ? 'g' : 'w');
        if (sel) s.put(2 * k, COLS - (dep ? r.id : 'ILS' + r.id).length - 6, sim.fmc.mod ? '<SEL>' : '<ACT>', 'w', true);
      }
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', sim.fmc.mod ? '<ERASE' : '<INDEX'); s.data(6, 'R', 'ROUTE>');
    },
    lsk(sim, side, k, sub) {
      if (k === 6) { if (side === 'R') goto('RTE'); else if (sim.fmc.mod) eraseMod(sim); else goto('DEPARR'); return; }
      if (side !== 'R') return;
      const m = beginMod(sim), dep = S.rwySel !== 'ARR';
      const a = dep ? m.origin : m.dest; const r = a && a.runways[sub * 5 + k - 1];
      if (!r) { eraseIfEmpty(sim); return; }
      if (dep) m.depRwy = r; else m.arrRwy = r;
      if (m.origin && m.dest) buildDefaultRoute(sim, m.origin, m.dest, { intoMod: true, depRwy: m.depRwy, arrRwy: m.arrRwy });
    },
  },
  LEGS: {
    pages(sim) { const v = routeView(sim); return Math.max(1, Math.ceil(Math.max(1, v.route.length - Math.max(1, v.activeLeg)) / 5)); },
    render(s, sim, sub) {
      const v = routeView(sim), r = v.route, n = this.pages(sim);
      const tag = actTag(sim);
      s.title(`${tag ? tag + ' ' : ''}RTE 1 LEGS`, Math.min(sub + 1, n), n, sim.fmc.mod ? 'w' : 'w');
      const start = Math.max(1, v.activeLeg) + sub * 5;
      const magVar = (sim.ac.magVar || 0) * RAD;
      for (let k = 1; k <= 5; k++) {
        const i = start + k - 1, w = r[i];
        if (!w) { if (k === 1 || r[i - 1]) s.center(2 * k, '--- END OF ROUTE ---', 'w', true); break; }
        const prev = i === v.activeLeg && sim.fmc.legFrom && !sim.fmc.mod ? sim.fmc.legFrom : (r[i - 1] || null);
        if (prev) {
          const crs = bearing(prev.lat, prev.lon, w.lat, w.lon) * RAD - magVar;
          const d = distance(prev.lat, prev.lon, w.lat, w.lon) / NM;
          const dtxt = i === v.activeLeg && !sim.fmc.mod ? (sim.fmc.distToGoNm || d) : d;
          s.put(2 * k - 1, 1, `${fmtCrs(crs)}  ${dtxt < 100 ? dtxt.toFixed(1) : Math.round(dtxt)}NM`, 'w', true);
        }
        const active = i === v.activeLeg;
        s.data(k, 'L', w.ident, active ? 'm' : 'w');
        const spd = w.spdKt ? String(w.spdKt) : '';
        const alt = w.altFt ? fmtAlt(w.altFt) + (w.altType === 'A' ? 'A' : '') : '';
        if (spd || alt) s.data(k, 'R', `${spd || '---'}/${alt || '-----'}`, 'c');
        else s.data(k, 'R', `${predSpd(sim, i)}/${predAlt(sim, i)}`, 'c', true);
      }
      s.put(11, 0, '------------------------', 'w', true);
      if (sim.fmc.mod) s.data(6, 'L', '<ERASE', 'w'); else s.data(6, 'L', '<RTE 2 LEGS');
      s.data(6, 'R', 'RTE DATA>');
    },
    lsk(sim, side, k, sub) {
      if (k === 6) { if (side === 'L' && sim.fmc.mod) eraseMod(sim); return; }
      const v = routeView(sim);
      const i = Math.max(1, v.activeLeg) + sub * 5 + k - 1;
      const w = v.route[i];
      const sp = S.scratch;
      if (side === 'L') {
        if (!sp) { if (w) S.scratch = w.ident; return; }
        takeScratch();
        if (sp === 'DELETE') { if (!w || !deleteWaypoint(sim, i)) { eraseIfEmpty(sim); invalid(); } return; }
        const route = beginMod(sim).route;
        const j = route.findIndex((x, n) => n >= Math.max(1, v.activeLeg) && x.ident === sp);
        if (j >= 0) {
          if (k === 1 && sub === 0) { // direct-to: drop everything before the target
            if (j > i) linkTo(sim, i - 1, j); directTo(sim, Math.min(i, j));
          } else if (j > i) linkTo(sim, i - 1, j);
          else { eraseIfEmpty(sim); invalid(); }
          return;
        }
        const ll = parseLatLon(sp);
        if (ll) {
          S.wptN = (S.wptN || 0) + 1;
          insertWaypoint(sim, i, { ident: 'WPT' + String(S.wptN).padStart(2, '0'), lat: ll.lat, lon: ll.lon });
          if (k === 1 && sub === 0) directTo(sim, i);
          return;
        }
        eraseIfEmpty(sim); setMsg('NOT IN DATA BASE');
        return;
      }
      // right side: speed / altitude constraints
      if (!w || !sp) return;
      takeScratch();
      const m = beginMod(sim), mw = m.route[i];
      if (sp === 'DELETE') { mw.spdKt = null; mw.altFt = null; return; }
      const parts = sp.split('/');
      let spd = null, alt = null;
      if (parts.length === 2) { spd = parts[0] ? Number(parts[0]) : null; alt = parts[1] ? parseAltEntry(parts[1].replace(/[AB]$/, '')) : null; }
      else alt = parseAltEntry(sp.replace(/[AB]$/, ''));
      if ((spd !== null && !(spd >= 100 && spd <= 400)) || (parts.length === 2 && parts[1] && alt === null) || (parts.length === 1 && alt === null)) { eraseIfEmpty(sim); return invalid(); }
      if (spd !== null) mw.spdKt = spd;
      if (alt !== null) { mw.altFt = alt; mw.altType = /A$/.test(sp) ? 'A' : /B$/.test(sp) ? 'B' : ''; }
    },
  },
  PROG: {
    pages() { return 2; },
    render(s, sim, sub) {
      const f = sim.fmc, r = f.route || [];
      const title = (f.flightNo ? f.flightNo + ' ' : '') + 'PROGRESS';
      s.title(title, sub + 1, 2);
      const gsKt = (sim.ac.gs || 0) / KT;
      const fuel = totalFuel(sim);
      if (sub === 0) {
        const from = r[f.activeLeg - 1];
        s.label(1, 'L', 'FROM'); s.put(1, 10, 'ALT', 'w', true); s.put(1, 15, 'ATA', 'w', true); s.right(1, 'FUEL ', 'w', true);
        s.data(1, 'L', from ? from.ident : '-----');
        s.put(3, 1, 'TO', 'w', true); s.put(3, 9, 'DTG', 'w', true); s.put(3, 15, 'ETA', 'w', true); s.right(3, 'FUEL ', 'w', true);
        const to = r[f.activeLeg], nxt = r[f.activeLeg + 1];
        const ffKgH = sim.engines.reduce((a, e) => a + (e.ff || 0), 0) || 7000;
        const fuelAt = (nm) => (gsKt > 60 ? tonnes(Math.max(0, fuel - ffKgH * nm / gsKt)) : '--.-');
        const row = (rr, ident, dtg, eta, color) => {
          s.put(rr, 0, ident || '-----', color);
          s.put(rr, 8, dtg === null ? '----' : String(Math.round(dtg)).padStart(4), 'w');
          s.put(rr, 13, eta === null ? '----z' : fmtZulu(eta).replace(/\.\dz$/, 'z'), 'w', true);
          s.right(rr, dtg === null ? '--.-' : fuelAt(dtg), 'w', true);
        };
        const tod = (h) => (gsKt > 60 ? (sim.env.timeOfDayH || 0) + h / gsKt : null);
        if (to) row(4, to.ident, f.distToGoNm, tod(f.distToGoNm), 'm');
        if (nxt) { const d = f.distToGoNm + (f.legDistNm[f.activeLeg + 1] || 0); s.put(5, 1, 'NEXT', 'w', true); row(6, nxt.ident, d, tod(d), 'w'); }
        if (f.dest) { s.put(7, 1, 'DEST', 'w', true); row(8, f.dest.icao, f.alongToDestNm, tod(f.alongToDestNm || 0), 'w'); }
        s.label(5, 'L', 'TO T/D'); s.data(5, 'L', f.todNm !== null && f.todNm > 0 ? `${Math.round(f.todNm)}NM` : '----', 'w', true);
        s.label(5, 'R', 'FUEL QTY'); s.data(5, 'R', `${tonnes(fuel)} TOTZR`, 'w', true);
        s.put(11, 0, '------------------------', 'w', true);
        s.data(6, 'L', '<POS REPORT'); s.data(6, 'R', 'POS REF>');
      } else {
        const wdir = Math.round(sim.env.windDirDeg || 0), wkt = Math.round(sim.env.windKt || 0);
        s.label(1, 'L', 'H/WIND'); s.data(1, 'L', String(Math.round(wkt * Math.cos((wdir - sim.ac.track * RAD) * DEG))) + 'KT', 'w', true);
        s.label(1, 'R', 'WIND'); s.data(1, 'R', `${String(wdir).padStart(3, '0')}°/${wkt}KT`, 'w', true);
        s.label(2, 'L', 'XTK ERROR'); s.data(2, 'L', `${(Math.abs(f.xtkM || 0) / NM).toFixed(1)}NM ${(f.xtkM || 0) >= 0 ? 'R' : 'L'}`, 'w', true);
        s.label(2, 'R', 'VERT DEV');
        const vdev = f.pathAltFt !== null && (f.phase === 'DESCENT' || f.phase === 'APPROACH') ? fmcIndicatedAltFt(sim) - f.pathAltFt : null;
        s.data(2, 'R', vdev === null ? '----' : `${Math.abs(Math.round(vdev))}${vdev >= 0 ? 'HI' : 'LO'}`, 'w', true);
        s.label(3, 'L', 'TAS'); s.data(3, 'L', `${Math.round((sim.ac.tas || 0) / KT)}KT`, 'w', true);
        s.label(3, 'R', 'SAT'); s.data(3, 'R', `${Math.round(15 - 1.98 * fmcIndicatedAltFt(sim) / 1000 + (sim.env.tempDevC || 0))}°C`, 'w', true);
        s.label(4, 'L', 'FUEL USED'); s.data(4, 'L', '---.-', 'w', true);
        s.label(4, 'R', 'GS'); s.data(4, 'R', `${Math.round(gsKt)}KT`, 'w', true);
        s.label(5, 'L', 'PHASE'); s.data(5, 'L', f.phase || '----', 'g', true);
        s.put(11, 0, '------------------------', 'w', true);
      }
    },
    lsk() {},
  },
  VNAV: {
    pages() { return 3; },
    render(s, sim, sub) {
      const f = sim.fmc;
      if (sub === 0) {
        s.title((f.phase === 'CLIMB' || f.phase === 'TAKEOFF' || f.phase === 'PREFLIGHT' ? 'ACT ' : '') + 'ECON CLB', 1, 3);
        s.label(1, 'L', 'CRZ ALT'); s.data(1, 'L', fmtAlt(f.crzAltFt));
        s.label(2, 'L', 'ECON SPD'); s.data(2, 'L', '310/.840', 'w', true);
        s.label(3, 'L', 'SPD TRANS'); s.data(3, 'L', '250/10000', 'w', true);
        s.label(4, 'L', 'SPD RESTR'); s.data(4, 'L', '---/-----');
        s.label(1, 'R', 'TO T/C'); s.data(1, 'R', f.tocNm !== null && f.tocNm !== undefined ? `${Math.round(f.tocNm)}NM` : '----', 'w', true);
      } else if (sub === 1) {
        s.title((f.phase === 'CRUISE' ? 'ACT ' : '') + 'ECON CRZ', 2, 3);
        s.label(1, 'L', 'CRZ ALT'); s.data(1, 'L', fmtAlt(f.crzAltFt));
        s.label(2, 'L', 'ECON SPD'); s.data(2, 'L', '.840', 'w', true);
        s.label(3, 'L', 'N1'); s.data(3, 'L', `${(sim.engines[0].n1 || 0).toFixed(1)}%`, 'w', true);
        s.label(1, 'R', 'STEP TO'); s.data(1, 'R', 'NONE', 'w', true);
        s.label(3, 'R', 'TO T/D'); s.data(3, 'R', f.todNm !== null && f.todNm !== undefined && f.todNm > 0 ? `${Math.round(f.todNm)}NM` : '----', 'w', true);
        s.label(4, 'R', 'OPT   MAX'); s.data(4, 'R', 'FL350 FL390', 'w', true);
      } else {
        s.title((f.phase === 'DESCENT' || f.phase === 'APPROACH' ? 'ACT ' : '') + 'ECON DES', 3, 3);
        const faf = (f.route || []).find((w) => w.kind === 'FAF');
        s.label(1, 'L', 'E/D AT'); s.data(1, 'L', faf ? `${faf.altFt}  ${faf.ident}` : '-----', 'w', true);
        s.label(2, 'L', 'ECON SPD'); s.data(2, 'L', '.840/290', 'w', true);
        s.label(3, 'L', 'SPD TRANS'); s.data(3, 'L', '240/10000', 'w', true);
        s.label(4, 'L', 'SPD RESTR'); s.data(4, 'L', '---/-----');
        s.label(1, 'R', 'TO T/D'); s.data(1, 'R', f.todNm !== null && f.todNm !== undefined && f.todNm > 0 ? `${Math.round(f.todNm)}NM` : '----', 'w', true);
        s.label(2, 'R', 'VERT DEV');
        const vdev = f.pathAltFt !== null && (f.phase === 'DESCENT' || f.phase === 'APPROACH') ? fmcIndicatedAltFt(sim) - f.pathAltFt : null;
        s.data(2, 'R', vdev === null ? '----' : `${Math.abs(Math.round(vdev))}${vdev >= 0 ? 'HI' : 'LO'}`, 'w', true);
        s.label(3, 'R', 'FPA  V/B  V/S'); s.data(3, 'R', `3.0 3.0 ${Math.round(-(f.pathVsFpm || 0))}`, 'w', true);
      }
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'R', sub === 2 ? 'FORECAST>' : 'ENG OUT>');
    },
    lsk(sim, side, k, sub) {
      if (side === 'L' && k === 1 && sub < 2) {
        const sp = takeScratch(); if (!sp) return;
        const a = parseAltEntry(sp); if (a && a >= 1000 && a <= 43100) sim.fmc.crzAltFt = a; else invalid();
      }
    },
  },
  NAVRAD: {
    render(s, sim) {
      const ils = sim.nav.ils, man = sim.fmc.ilsManual;
      s.title('NAV RADIO');
      s.label(1, 'L', 'VOR L'); s.data(1, 'L', '---.--'); s.label(1, 'R', 'VOR R'); s.data(1, 'R', '---.--');
      s.label(2, 'L', 'CRS'); s.data(2, 'L', '---'); s.label(2, 'R', 'CRS'); s.data(2, 'R', '---');
      s.label(3, 'L', 'ADF L'); s.data(3, 'L', '----.-'); s.label(3, 'R', 'ADF R'); s.data(3, 'R', '----.-');
      s.label(4, 'L', 'ILS - MLS');
      if (ils.freq) s.data(4, 'L', `${ils.freq.toFixed(2)}/${fmtCrs(ils.crsDeg || 0)} ${man ? 'MAN' : 'PARK'}`, 'w', !man);
      else s.data(4, 'L', '---.--/---°');
      if (ils.ident) s.label(4, 'R', ils.ident, 'g');
      s.label(5, 'L', 'GLS'); s.data(5, 'L', '-----');
      s.put(11, 0, '------------------------', 'w', true);
      if (man) s.data(6, 'L', '<AUTO');
    },
    lsk(sim, side, k) {
      if (side === 'L' && k === 6 && sim.fmc.ilsManual) { sim.fmc.ilsManual = null; return; }
      if (side === 'L' && k === 4) {
        const sp = takeScratch(); if (!sp) return;
        if (sp === 'DELETE') { sim.fmc.ilsManual = null; return; }
        const m = /^(1\d{2}(?:\.\d{1,2})?)?(?:\/(\d{1,3}))?$/.exec(sp);
        if (!m || (!m[1] && !m[2])) return invalid();
        const freq = m[1] ? Number(m[1]) : (sim.fmc.ilsManual ? sim.fmc.ilsManual.freq : sim.nav.ils.freq);
        if (!(freq >= 108 && freq <= 117.95)) return invalid();
        sim.fmc.ilsManual = { freq, crsDeg: m[2] ? Number(m[2]) % 360 : null };
        return;
      }
      if (S.scratch) { takeScratch(); invalid(); }
    },
  },
  ALTN: {
    render(s, sim) {
      s.title('ALTN LIST');
      const dest = sim.fmc.dest, db = sim.fmc.airports || [];
      if (!dest) { s.center(6, 'NO DESTINATION', 'w', true); return; }
      const list = db.filter((a) => a.icao !== dest.icao)
        .map((a) => ({ a, d: distance(dest.lat * DEG, dest.lon * DEG, a.lat * DEG, a.lon * DEG) / NM }))
        .sort((x, y) => x.d - y.d).slice(0, 4);
      s.label(1, 'L', 'ALTN'); s.label(1, 'R', 'DIST');
      list.forEach((x, n) => { s.data(n + 1, 'L', `<${x.a.icao}`); s.data(n + 1, 'R', `${Math.round(x.d)}NM`, 'w', true); });
      s.put(11, 0, '------------------------', 'w', true);
    },
    lsk() {},
  },
  FIX: {
    render(s) {
      s.title('FIX INFO', 1, 1);
      s.label(1, 'L', 'FIX'); s.data(1, 'L', BOX.repeat(5));
      s.label(1, 'R', 'RAD/DIS FR'); s.data(2, 'L', '---/---'); s.data(3, 'L', '---/---');
      s.put(11, 0, '------------------------', 'w', true);
      s.data(6, 'L', '<ERASE FIX');
    },
    lsk() { if (S.scratch) { takeScratch(); setMsg('NOT AVAILABLE'); } },
  },
  HOLD: {
    render(s) {
      s.title('RTE 1 LEGS');
      s.label(6, 'L', 'HOLD AT'); s.data(6, 'L', BOX.repeat(5)); s.label(6, 'R', 'HOLD AT'); s.data(6, 'R', 'PPOS>');
    },
    lsk() { if (S.scratch) { takeScratch(); setMsg('NOT AVAILABLE'); } },
  },
  COMM: {
    render(s) {
      s.title('FMC COMM');
      s.data(1, 'L', '<RTE 1'); s.data(2, 'L', '<ALTN'); s.data(3, 'L', '<PERF'); s.data(4, 'L', '<TAKEOFF');
      s.data(1, 'R', 'POS REPORT>'); s.data(2, 'R', 'WIND>');
      s.label(6, 'L', 'DATA LINK'); s.data(6, 'L', 'NO COMM', 'w', true);
    },
    lsk() {},
  },
};

function predSpd(sim, i) { void i; const t = sim.fmc.vnavTargetSpdKt; return t ? String(Math.round(t)) : '---'; }
function predAlt(sim, i) {
  const r = sim.fmc.route || [];
  if (!r[i]) return '-----';
  if (i === r.length - 1) return fmtAlt(r[i].altFt);
  return sim.fmc.phase === 'DESCENT' || sim.fmc.phase === 'APPROACH' ? '-----' : fmtAlt(sim.fmc.crzAltFt);
}
function eraseIfEmpty(sim) {
  // if a mod was opened only to be rejected, discard it again
  const m = sim.fmc.mod;
  if (m && JSON.stringify(m.route.map((w) => w.ident)) === JSON.stringify((sim.fmc.route || []).map((w) => w.ident)) && m.activeLeg === sim.fmc.activeLeg
    && m.origin === sim.fmc.origin && m.dest === sim.fmc.dest && m.depRwy === sim.fmc.depRwy && m.arrRwy === sim.fmc.arrRwy
    && m.route.every((w, n) => w.altFt === sim.fmc.route[n].altFt && w.spdKt === sim.fmc.route[n].spdKt)) sim.fmc.mod = null;
}

// ------------------------------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------------------------------
const FUNC_KEYS = {
  'INIT REF': () => goto('INDEX'), RTE: () => goto('RTE'), 'DEP ARR': () => goto('DEPARR'), ALTN: () => goto('ALTN'),
  VNAV: () => goto('VNAV', phaseVnavPage()), FIX: () => goto('FIX'), LEGS: () => goto('LEGS'), HOLD: () => goto('HOLD'),
  'FMC COMM': () => goto('COMM'), PROG: () => goto('PROG'), MENU: () => goto('MENU'), 'NAV RAD': () => goto('NAVRAD'),
};
function phaseVnavPage() { const p = S.sim.fmc.phase; return p === 'CRUISE' ? 1 : p === 'DESCENT' || p === 'APPROACH' ? 2 : 0; }

function pageCount() { const p = PAGES[S.page]; return p.pages ? p.pages(S.sim) : 1; }

function pressKey(key) {
  const sim = S.sim;
  if (FUNC_KEYS[key]) { FUNC_KEYS[key](); return; }
  switch (key) {
    case 'PREV PAGE': S.sub = (S.sub - 1 + pageCount()) % pageCount(); return;
    case 'NEXT PAGE': S.sub = (S.sub + 1) % pageCount(); return;
    case 'EXEC': if (sim.fmc.mod) { execMod(sim); S.execArmed = false; } return;
    case 'CLR':
      if (S.msg) { S.msg = ''; return; }
      if (S.scratch === 'DELETE') { S.scratch = ''; return; }
      S.scratch = S.scratch.slice(0, -1); return;
    case 'DEL': if (!S.scratch && !S.msg) S.scratch = 'DELETE'; return;
    case 'SP': typeChar(' '); return;
    case '+/-': {
      const last = S.scratch.slice(-1);
      if (last === '-') S.scratch = S.scratch.slice(0, -1) + '+';
      else if (last === '+') S.scratch = S.scratch.slice(0, -1) + '-';
      else typeChar('-');
      return;
    }
    default: if (key.length === 1) typeChar(key);
  }
}
function typeChar(ch) {
  if (S.msg) S.msg = '';
  if (S.scratch === 'DELETE') S.scratch = '';
  if (S.scratch.length < COLS) S.scratch += ch;
}
function pressLsk(side, k) {
  if (S.msg) return; // a message in the scratchpad must be cleared first
  const p = PAGES[S.page];
  if (p && p.lsk) p.lsk(S.sim, side, k, S.sub);
}

// ------------------------------------------------------------------------------------------
// DOM
// ------------------------------------------------------------------------------------------
const h = (tag, cls, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of [].concat(kids)) if (k) e.appendChild(k);
  return e;
};

export function initCDU(sim, el) {
  if (!el) return;
  el.classList.add('cdu-host');
  el.innerHTML = '';
  S = { sim, el, page: 'IDENT', sub: 0, scratch: '', msg: '', rows: [], rowSig: [], irsSet: false, vConfirmed: false, vrefSel: false, rwySel: 'DEP', lights: {} };

  // optional airport DB for ICAO entries (read-only data owned by Team B)
  if (!sim.fmc.airports) {
    import('../world/airports.js').then((m) => { if (!sim.fmc.airports && Array.isArray(m.AIRPORTS)) sim.fmc.airports = m.AIRPORTS; }).catch(() => {});
  }

  const after = (fn) => (e) => { e.preventDefault(); fn(); render(true); root.focus({ preventScroll: true }); };
  const key = (label, cls = '', fn = () => pressKey(label), aria = label) =>
    h('button', 'cdu-key ' + cls, { type: 'button', 'aria-label': aria, tabindex: '-1', onpointerdown: after(fn) }, [h('span', '', { text: label })]);

  // screen + LSKs
  const lskCol = (side) => h('div', 'cdu-lsks ' + side, {}, [1, 2, 3, 4, 5, 6].map((k) =>
    h('button', 'cdu-lsk', { type: 'button', tabindex: '-1', 'aria-label': `Line select key ${k}${side}`, onpointerdown: after(() => pressLsk(side === 'left' ? 'L' : 'R', k)) })));
  const screen = h('div', 'cdu-screen', { role: 'log', 'aria-label': 'CDU screen', 'aria-live': 'off' });
  for (let r = 0; r < ROWS; r++) { const row = h('div', 'cdu-row'); screen.appendChild(row); S.rows.push(row); S.rowSig.push(''); }

  const lights = {};
  const light = (name) => (lights[name] = h('span', 'cdu-light', { text: name }));
  const screenWrap = h('div', 'cdu-screen-area', {}, [
    h('div', 'cdu-lights left', {}, [light('DSPY'), light('FAIL')]),
    lskCol('left'), h('div', 'cdu-glass', {}, [screen]), lskCol('right'),
    h('div', 'cdu-lights right', {}, [light('MSG'), light('OFST')]),
  ]);

  const execBtn = h('button', 'cdu-key cdu-exec', { type: 'button', tabindex: '-1', 'aria-label': 'EXEC', onpointerdown: after(() => pressKey('EXEC')) },
    [(lights.EXEC = h('span', 'cdu-exec-bar')), h('span', '', { text: 'EXEC' })]);

  const fnRow1 = h('div', 'cdu-fn-row', {}, ['INIT REF', 'RTE', 'DEP ARR', 'ALTN', 'VNAV'].map((k) => key(k, 'fn')));
  const fnRow2 = h('div', 'cdu-fn-row', {}, [...['FIX', 'LEGS', 'HOLD', 'FMC COMM', 'PROG'].map((k) => key(k, 'fn')), execBtn]);
  const fnRow3 = h('div', 'cdu-fn-row', {}, [key('MENU', 'fn'), key('NAV RAD', 'fn'), h('span', 'cdu-brightness', { 'aria-hidden': 'true' }, [h('span', '', { text: 'BRT' })])]);
  const fnRow4 = h('div', 'cdu-fn-row', {}, [key('PREV PAGE', 'fn'), key('NEXT PAGE', 'fn')]);

  const num = h('div', 'cdu-num', {}, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '+/-'].map((k) => key(k, 'num')));
  const alphaKeys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => key(k, 'alpha'));
  alphaKeys.push(key('SP', 'alpha small'), key('DEL', 'alpha small'), key('/', 'alpha'), key('CLR', 'alpha small'));
  const alpha = h('div', 'cdu-alpha', {}, alphaKeys);

  const root = h('div', 'cdu-bezel', { tabindex: '0', role: 'application', 'aria-label': 'Control display unit. Type to enter text into the scratchpad.' }, [
    screenWrap,
    h('div', 'cdu-keys', {}, [fnRow1, fnRow2, fnRow3, fnRow4, h('div', 'cdu-pads', {}, [num, alpha])]),
  ]);
  el.appendChild(root);
  S.lights = lights; S.root = root;

  // Focus-scoped physical keyboard (no global handlers).
  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    const k = e.key;
    if (/^[a-zA-Z0-9]$/.test(k)) pressKey(k.toUpperCase());
    else if (k === '.' || k === '/') pressKey(k);
    else if (k === ' ') pressKey('SP');
    else if (k === '-' || k === '+') pressKey('+/-');
    else if (k === 'Backspace') pressKey('CLR');
    else if (k === 'Delete') pressKey('DEL');
    else if (k === 'Enter') pressKey('EXEC');
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); render(true); }
  });
  // stop key-up of handled keys reaching global handlers too
  root.addEventListener('keyup', (e) => { if (/^[a-zA-Z0-9./ +-]$/.test(e.key) || ['Backspace', 'Delete', 'Enter'].includes(e.key)) e.stopPropagation(); });
  root.addEventListener('pointerdown', () => root.focus({ preventScroll: true }));

  // scale to the host box: the CDU is laid out at a design size and scaled uniformly
  // Calibrate the screen font so one glyph advance equals one character cell exactly.
  const calibrate = () => {
    const row = S.rows[0]; if (!row || typeof getComputedStyle === 'undefined') return;
    const cs = getComputedStyle(row);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `20px ${cs.fontFamily}`;
    const adv = ctx.measureText('MMMMMMMMMM').width / 10;
    const cell = parseFloat(getComputedStyle(screen.parentElement).getPropertyValue('--cdu-cell')) || 12.6;
    if (adv > 0) screen.style.setProperty('--cdu-fs', `${(20 * cell / adv).toFixed(2)}px`);
  };
  calibrate();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(calibrate);
  const fit = () => {
    const w = el.clientWidth || 460, hh = el.clientHeight || 700;
    const s = Math.min(w / 460, hh / 700);
    root.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(el);
  fit();
  render(true);
}

function render(force) {
  if (!S) return;
  const sim = S.sim;
  const p = PAGES[S.page] || PAGES.IDENT;
  const n = p.pages ? p.pages(sim) : 1;
  if (S.sub >= n) S.sub = n - 1;
  const scr = new Screen();
  try { p.render(scr, sim, S.sub); } catch (e) { scr.center(6, 'PAGE ERROR', 'a'); }
  // scratchpad (line 14)
  if (S.msg) scr.left(13, S.msg, 'w');
  else scr.left(13, S.scratch, 'w');
  for (let r = 0; r < ROWS; r++) {
    const cells = scr.cells[r];
    const sig = cells.map((c) => (c ? c.ch + c.color + (c.small ? 's' : 'L') : ' ')).join('');
    if (!force && sig === S.rowSig[r]) continue;
    S.rowSig[r] = sig;
    const row = S.rows[r];
    row.textContent = '';
    let i = 0;
    while (i < COLS) {
      const c = cells[i];
      const key = c ? c.color + (c.small ? 's' : 'L') : '_';
      let txt = '';
      let j = i;
      while (j < COLS) {
        const d = cells[j]; const kk = d ? d.color + (d.small ? 's' : 'L') : '_';
        if (kk !== key) break;
        txt += d ? d.ch : ' '; j++;
      }
      const span = document.createElement('span');
      span.className = c ? `c-${c.color}${c.small ? ' sm' : ''}` : '';
      span.style.width = `calc(${j - i} * var(--cdu-cell))`;
      span.textContent = txt;
      row.appendChild(span);
      i = j;
    }
  }
  // annunciators
  setLight('EXEC', !!sim.fmc.mod);
  setLight('MSG', !!S.msg);
}
function setLight(name, on) { const l = S.lights[name]; if (l && l.classList.contains('on') !== on) l.classList.toggle('on', on); }

export function updateCDU(sim) {
  if (!S || S.sim !== sim) return;
  // FMC-originated scratchpad messages (e.g. DRAG REQUIRED)
  if (sim.fmc.msg && sim.fmc.msg !== S.lastFmcMsg) { S.lastFmcMsg = sim.fmc.msg; if (!S.msg) S.msg = sim.fmc.msg; }
  if (!sim.fmc.msg) S.lastFmcMsg = '';
  render(false);
}

// test hook (harness): drive the CDU programmatically
export function cduPress(label) { if (!S) return; if (/^LSK[1-6][LR]$/.test(label)) pressLsk(label[4], Number(label[3])); else pressKey(label); render(true); }
