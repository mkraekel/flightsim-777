// Airport and runway data for the simulator (Team B owns, everyone reads).
//
// Source: OurAirports runways.csv / airports.csv (public domain), extracted 2026-10-09.
// RAW entries keep the CSV semantics: lat/lon = physical runway END, dispFt = displaced
// threshold distance, hdgT = true course computed from both ends.
// The exported AIRPORTS array is built from RAW into the CONTRACT format:
//   { icao, name, city, lat, lon, elevFt, magVarDeg, tower:{lat,lon,hAglM},
//     runways:[{ id, lat, lon /* landing THRESHOLD, displaced, DEG */, hdgDeg /* true */,
//                lengthM, widthM, ldaM, elevFt, dispM,
//                startLat, startLon /* physical start of the runway (use for takeoff) */,
//                endLat, endLon /* physical far end */,
//                ils:{ freq, ident, gsDeg, crsDeg, simOnly } }] }
// All lat/lon are DEGREES. Convert with DEG when filling sim state.
//
// ILS: OurAirports has no ILS data. Entries in REAL_ILS are published values the author
// is confident about; every other runway gets a deterministic, plausible frequency in the
// 108.10–111.95 MHz ILS band flagged `simOnly: true` (NOT for real-world use).

import { DEG, FT, RAD, destination } from '../core/geo.js';

const RAW = [
  { icao:'EDDF', name:'Frankfurt Main Airport', city:'Frankfurt am Main', lat:50.02671, lon:8.55835, elevFt:364, runways:[
  { id:'07C', lat:50.032600, lon:8.534630, elevFt:329, hdgT:69.6, dispFt:0, lenFt:13123, widFt:197 },
  { id:'25C', lat:50.045101, lon:8.586980, elevFt:364, hdgT:249.6, dispFt:0, lenFt:13123, widFt:197 },
  { id:'07R', lat:50.027500, lon:8.534170, elevFt:328, hdgT:69.4, dispFt:0, lenFt:13123, widFt:148 },
  { id:'25L', lat:50.040100, lon:8.586530, elevFt:362, hdgT:249.5, dispFt:0, lenFt:13123, widFt:148 },
  ]},
  { icao:'EDDM', name:'Munich Airport', city:'Munich', lat:48.35380, lon:11.78610, elevFt:1487, runways:[
  { id:'08L', lat:48.362801, lon:11.767600, elevFt:1467, hdgT:83.4, dispFt:0, lenFt:13123, widFt:197 },
  { id:'26R', lat:48.366901, lon:11.821200, elevFt:1449, hdgT:263.5, dispFt:0, lenFt:13123, widFt:197 },
  { id:'08R', lat:48.340698, lon:11.751000, elevFt:1486, hdgT:83.4, dispFt:0, lenFt:13123, widFt:197 },
  { id:'26L', lat:48.344799, lon:11.804600, elevFt:1470, hdgT:263.5, dispFt:0, lenFt:13123, widFt:197 },
  ]},
  { icao:'KJFK', name:'John F. Kennedy International Airport', city:'New York', lat:40.63945, lon:-73.77932, elevFt:13, runways:[
  { id:'04L', lat:40.622002, lon:-73.785599, elevFt:12, hdgT:30.6, dispFt:463, lenFt:12079, widFt:200 },
  { id:'22R', lat:40.648800, lon:-73.764702, elevFt:13, hdgT:210.6, dispFt:2696, lenFt:12079, widFt:200 },
  { id:'13R', lat:40.648399, lon:-73.816704, elevFt:13, hdgT:120.9, dispFt:2043, lenFt:14511, widFt:200 },
  { id:'31L', lat:40.627899, lon:-73.771599, elevFt:13, hdgT:300.9, dispFt:3263, lenFt:14511, widFt:200 },
  ]},
  { icao:'KLAX', name:'Los Angeles International Airport', city:'Los Angeles', lat:33.94250, lon:-118.40800, elevFt:125, runways:[
  { id:'6L', lat:33.949119, lon:-118.431187, elevFt:112, hdgT:83.0, dispFt:0, lenFt:8926, widFt:150 },
  { id:'24R', lat:33.952112, lon:-118.401954, elevFt:117, hdgT:263.0, dispFt:0, lenFt:8926, widFt:150 },
  { id:'7R', lat:33.933659, lon:-118.419074, elevFt:118, hdgT:83.0, dispFt:0, lenFt:11095, widFt:200 },
  { id:'25L', lat:33.937371, lon:-118.382700, elevFt:95, hdgT:263.0, dispFt:0, lenFt:11095, widFt:200 },
  ]},
  { icao:'EGLL', name:'London Heathrow Airport', city:'London', lat:51.47075, lon:-0.45991, elevFt:83, runways:[
  { id:'09L', lat:51.477490, lon:-0.489439, elevFt:79, hdgT:89.7, dispFt:1007, lenFt:12799, widFt:164 },
  { id:'27R', lat:51.477681, lon:-0.433227, elevFt:78, hdgT:269.7, dispFt:0, lenFt:12799, widFt:164 },
  { id:'09R', lat:51.464780, lon:-0.486808, elevFt:75, hdgT:89.7, dispFt:1013, lenFt:12001, widFt:164 },
  { id:'27L', lat:51.464957, lon:-0.434048, elevFt:77, hdgT:269.7, dispFt:0, lenFt:12001, widFt:164 },
  ]},
  { icao:'OMDB', name:'Dubai International Airport', city:'Dubai', lat:25.24979, lon:55.37099, elevFt:62, runways:[
  { id:'12L', lat:25.264627, lon:55.350422, elevFt:11, hdgT:121.5, dispFt:1476, lenFt:14275, widFt:197 },
  { id:'30R', lat:25.247709, lon:55.380932, elevFt:32, hdgT:301.5, dispFt:984, lenFt:14275, widFt:197 },
  { id:'12R', lat:25.252836, lon:55.364376, elevFt:11, hdgT:121.5, dispFt:2345, lenFt:14590, widFt:197 },
  { id:'30L', lat:25.235920, lon:55.394882, elevFt:60, hdgT:301.5, dispFt:433, lenFt:14590, widFt:197 },
  ]},
  { icao:'KSFO', name:'San Francisco International Airport', city:'San Francisco', lat:37.61981, lon:-122.37482, elevFt:13, runways:[
  { id:'10L', lat:37.628742, lon:-122.393410, elevFt:5, hdgT:117.9, dispFt:0, lenFt:11870, widFt:200 },
  { id:'28R', lat:37.613538, lon:-122.357160, elevFt:13, hdgT:297.9, dispFt:300, lenFt:11870, widFt:200 },
  { id:'10R', lat:37.626298, lon:-122.393124, elevFt:6, hdgT:117.9, dispFt:0, lenFt:11381, widFt:200 },
  { id:'28L', lat:37.611720, lon:-122.358367, elevFt:13, hdgT:297.9, dispFt:300, lenFt:11381, widFt:200 },
  ]},
  { icao:'LFPG', name:'Charles de Gaulle International Airport', city:'Paris', lat:49.00896, lon:2.55412, elevFt:392, runways:[
  { id:'08R', lat:48.992901, lon:2.565660, elevFt:336, hdgT:85.2, dispFt:0, lenFt:8858, widFt:197 },
  { id:'26L', lat:48.994900, lon:2.602430, elevFt:316, hdgT:265.3, dispFt:0, lenFt:8858, widFt:197 },
  { id:'09L', lat:49.024700, lon:2.524890, elevFt:378, hdgT:85.3, dispFt:0, lenFt:8858, widFt:197 },
  { id:'27R', lat:49.026699, lon:2.561690, elevFt:392, hdgT:265.3, dispFt:0, lenFt:8858, widFt:197 },
  ]},
  { icao:'RJTT', name:'Tokyo Haneda International Airport', city:'Tokyo', lat:35.54968, lon:139.78696, elevFt:35, runways:[
  { id:'16L', lat:35.565897, lon:139.786550, elevFt:22, hdgT:150.0, dispFt:1280, lenFt:11024, widFt:200 },
  { id:'34R', lat:35.539690, lon:139.805142, elevFt:20, hdgT:330.0, dispFt:1180, lenFt:11024, widFt:200 },
  { id:'16R', lat:35.560452, lon:139.768734, elevFt:20, hdgT:150.0, dispFt:1770, lenFt:9843, widFt:200 },
  { id:'34L', lat:35.536591, lon:139.785672, elevFt:20, hdgT:330.0, dispFt:0, lenFt:9843, widFt:200 },
  ]},
  { icao:'VHHH', name:'Hong Kong International Airport', city:'Hong Kong', lat:22.31184, lon:113.91486, elevFt:28, runways:[
  { id:'07C', lat:22.310400, lon:113.896004, elevFt:22, hdgT:70.9, dispFt:565, lenFt:12467, widFt:197 },
  { id:'25C', lat:22.321600, lon:113.931000, elevFt:23, hdgT:250.9, dispFt:580, lenFt:12467, widFt:197 },
  { id:'07R', lat:22.296200, lon:113.898003, elevFt:28, hdgT:70.8, dispFt:525, lenFt:12467, widFt:197 },
  { id:'25L', lat:22.307431, lon:113.932819, elevFt:27, hdgT:250.8, dispFt:0, lenFt:12467, widFt:197 },
  ]},
  { icao:'WSSS', name:'Singapore Changi Airport', city:'Singapore', lat:1.35019, lon:103.99400, elevFt:22, runways:[
  { id:'02L', lat:1.348970, lon:103.977997, elevFt:22, hdgT:22.7, dispFt:0, lenFt:13123, widFt:197 },
  { id:'20R', lat:1.382410, lon:103.991997, elevFt:14, hdgT:202.7, dispFt:2429, lenFt:13123, widFt:197 },
  { id:'02C', lat:1.328800, lon:103.985001, elevFt:15, hdgT:22.8, dispFt:0, lenFt:13123, widFt:197 },
  { id:'20C', lat:1.362130, lon:103.999001, elevFt:15, hdgT:202.8, dispFt:0, lenFt:13123, widFt:197 },
  ]},
  { icao:'EHAM', name:'Amsterdam Airport Schiphol', city:'Amsterdam', lat:52.30860, lon:4.76389, elevFt:-11, runways:[
  { id:'06', lat:52.287899, lon:4.734020, elevFt:-11, hdgT:57.9, dispFt:820, lenFt:11283, widFt:148 },
  { id:'24', lat:52.304600, lon:4.777520, elevFt:-12, hdgT:237.9, dispFt:0, lenFt:11283, widFt:148 },
  { id:'18R', lat:52.362701, lon:4.711930, elevFt:-13, hdgT:183.2, dispFt:886, lenFt:12467, widFt:198 },
  { id:'36L', lat:52.328602, lon:4.708840, elevFt:-12, hdgT:3.2, dispFt:0, lenFt:12467, widFt:198 },
  ]},
  { icao:'LSZH', name:'Zürich Airport', city:'Zurich', lat:47.45806, lon:8.54806, elevFt:1417, runways:[
  { id:'14', lat:47.483101, lon:8.534730, elevFt:1402, hdgT:137.3, dispFt:492, lenFt:10827, widFt:197 },
  { id:'32', lat:47.461300, lon:8.564460, elevFt:1402, hdgT:317.3, dispFt:0, lenFt:10827, widFt:197 },
  { id:'16', lat:47.475601, lon:8.535950, elevFt:1390, hdgT:155.0, dispFt:0, lenFt:12139, widFt:197 },
  { id:'34', lat:47.445400, lon:8.556730, elevFt:1388, hdgT:335.1, dispFt:1542, lenFt:12139, widFt:197 },
  ]},
  { icao:'KSEA', name:'Seattle–Tacoma International Airport', city:'Seattle', lat:47.44794, lon:-122.31028, elevFt:433, runways:[
  { id:'16L', lat:47.463799, lon:-122.307999, elevFt:432, hdgT:180.0, dispFt:0, lenFt:11901, widFt:150 },
  { id:'34R', lat:47.431198, lon:-122.307999, elevFt:347, hdgT:0.0, dispFt:0, lenFt:11901, widFt:150 },
  { id:'16C', lat:47.463799, lon:-122.310997, elevFt:430, hdgT:180.0, dispFt:0, lenFt:9426, widFt:150 },
  { id:'34C', lat:47.438000, lon:-122.310997, elevFt:363, hdgT:0.0, dispFt:0, lenFt:9426, widFt:150 },
  ]},
  { icao:'KPAE', name:'Seattle Paine Field International Airport', city:'Everett', lat:47.90630, lon:-122.28200, elevFt:606, runways:[
  { id:'16R', lat:47.921343, lon:-122.285874, elevFt:558, hdgT:179.1, dispFt:0, lenFt:9010, widFt:150 },
  { id:'34L', lat:47.896643, lon:-122.285324, elevFt:579, hdgT:359.1, dispFt:0, lenFt:9010, widFt:150 },
  ]},
];

/** Magnetic variation (deg, East positive), approx. WMM 2025 epoch for 2026. */
const MAGVAR = {
  EDDF: 3.6, EDDM: 4.2, KJFK: -12.8, KLAX: 11.6, EGLL: 1.2, OMDB: 2.6, KSFO: 12.9, LFPG: 2.2,
  RJTT: -8.0, VHHH: -3.4, WSSS: 0.1, EHAM: 2.6, LSZH: 3.6, KSEA: 15.0, KPAE: 15.2,
};

/** Published ILS data (freq MHz, ident). Only entries the author is confident about. */
const REAL_ILS = {
  'EGLL/27L': [109.50, 'ILL'], 'EGLL/27R': [110.30, 'IRR'],
  'EGLL/09L': [110.30, 'IAA'], 'EGLL/09R': [109.50, 'IBB'],
  'KSFO/28L': [109.55, 'ISFO'], 'KSFO/28R': [111.70, 'IGWQ'],
  'KLAX/24R': [108.50, 'IOSS'], 'KLAX/25L': [109.90, 'ILAX'],
};

// ILS localizer channels: 108.10..111.95 with odd tenths (x.10, x.15, x.30, x.35, ...).
const ILS_CHANNELS = [];
for (let mhz = 108; mhz <= 111; mhz++) {
  for (const t of [0.10, 0.15, 0.30, 0.35, 0.50, 0.55, 0.70, 0.75, 0.90, 0.95]) ILS_CHANNELS.push(+(mhz + t).toFixed(2));
}

function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function makeIls(icao, rwy, hdgDeg, magVarDeg) {
  const crsDeg = (((hdgDeg - magVarDeg) % 360) + 360) % 360;
  const real = REAL_ILS[`${icao}/${rwy.id}`];
  if (real) return { freq: real[0], ident: real[1], gsDeg: 3, crsDeg, simOnly: false };
  const freq = ILS_CHANNELS[hashStr(icao + rwy.id) % ILS_CHANNELS.length];
  const ident = ('I' + icao.slice(1, 3) + rwy.id.replace(/[^0-9LRC]/g, '').slice(-1)).toUpperCase();
  return { freq, ident, gsDeg: 3, crsDeg, simOnly: true };
}

/** Build contract-format runways. RAW lists runways as consecutive opposite-end pairs. */
function buildRunways(a) {
  const out = [];
  const magVarDeg = MAGVAR[a.icao] ?? 0;
  for (let i = 0; i < a.runways.length; i++) {
    const r = a.runways[i];
    const opp = a.runways[i % 2 === 0 ? i + 1 : i - 1];
    if (!opp) continue;
    const lengthM = r.lenFt * FT, dispM = (r.dispFt || 0) * FT;
    const thr = destination(r.lat * DEG, r.lon * DEG, r.hdgT * DEG, dispM);
    out.push({
      id: r.id,
      lat: thr.lat * RAD, lon: thr.lon * RAD,
      hdgDeg: r.hdgT,
      lengthM, widthM: r.widFt * FT, ldaM: lengthM - dispM, dispM,
      elevFt: r.elevFt,
      startLat: r.lat, startLon: r.lon,
      endLat: opp.lat, endLon: opp.lon,
      ils: makeIls(a.icao, r, r.hdgT, magVarDeg),
    });
  }
  return out;
}

export const AIRPORTS = RAW.map((a) => ({
  icao: a.icao, name: a.name, city: a.city, lat: a.lat, lon: a.lon, elevFt: a.elevFt,
  magVarDeg: MAGVAR[a.icao] ?? 0,
  // No tower coordinates in OurAirports: use the reference point, 60 m up (sim camera only).
  tower: { lat: a.lat, lon: a.lon, hAglM: 60 },
  runways: buildRunways(a),
}));

export function findAirport(icao) {
  if (!icao) return null;
  const k = String(icao).trim().toUpperCase();
  return AIRPORTS.find((a) => a.icao === k) || null;
}

export function findRunway(airport, id) {
  if (!airport) return null;
  return airport.runways.find((r) => r.id === id) || airport.runways[0] || null;
}

/** Nearest airport to lat/lon (DEG). */
export function nearestAirport(latDeg, lonDeg) {
  let best = null, bd = Infinity;
  for (const a of AIRPORTS) {
    const d = (a.lat - latDeg) ** 2 + ((a.lon - lonDeg) * Math.cos(latDeg * DEG)) ** 2;
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
