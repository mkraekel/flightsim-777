// CesiumJS world (Team B): viewer, scenery, lighting, aircraft model, camera, ground height.
//
// main.js owns timing: the viewer is created with useDefaultRenderLoop = false and
// updateGlobe(sim, dt) renders exactly one frame each time it is called.
//
// Scenery modes
//   'google' : Google Photorealistic 3D Tiles (needs a Map Tiles API key). Globe hidden.
//   'ion'    : Cesium World Terrain + Bing (via Cesium ion token)
//   'esri'   : keyless default: ESRI World Imagery + ESRI WorldElevation3D terrain

import { DEG, RAD, FT, lag, destination, eulerToQuat } from '../core/geo.js';
import { createAircraftModel } from './model777.js';
import { createCameraController, computeBodyFrame, CG_HEIGHT_M } from './camera.js';

const ESRI_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_TERRAIN = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';

const QUALITY = {
  low:    { msaa: 1, res: 0.75, sse: 4,   shadows: false, fxaa: true,  tileSse: 32, hdr: false },
  medium: { msaa: 2, res: 1.0,  sse: 2,   shadows: false, fxaa: true,  tileSse: 16, hdr: false },
  high:   { msaa: 4, res: 1.0,  sse: 1.5, shadows: true,  fxaa: true,  tileSse: 12, hdr: true },
  ultra:  { msaa: 4, res: 1.25, sse: 1.2, shadows: true,  fxaa: true,  tileSse: 8,  hdr: true },
};

/** Touch devices (iPad/Safari): cap at MEDIUM, no MSAA/shadows/HDR, coarser tiles (fits the memory budget). */
const IS_COARSE = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
function mobileQuality(q) {
  if (!IS_COARSE) return q;
  const base = q === QUALITY.low ? QUALITY.low : QUALITY.medium;
  return { ...base, mobile: true, msaa: 1, shadows: false, hdr: false,
    sse: base === QUALITY.low ? 4 : 2.5, tileSse: base === QUALITY.low ? 32 : 24, res: base === QUALITY.low ? 0.75 : 1.0 };
}

// module state (one world per page)
const W = {
  viewer: null, mode: 'esri', quality: QUALITY.medium, tileset: null,
  model: null, cam: null, frame: {}, frameNo: 0,
  ground: { bias: 0, pending: false, lastReq: -1, filtered: null, detailed: null },
  clockBase: null, simT0: 0,
};

const C = () => window.Cesium;

/** Wait for the async-loaded Cesium global (index.html loads it with `async`). */
export function waitForCesium(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    (function poll() {
      if (window.Cesium && window.Cesium.Viewer) return resolve(window.Cesium);
      if (performance.now() - t0 > timeoutMs) return reject(new Error('CesiumJS failed to load'));
      setTimeout(poll, 50);
    })();
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms))]);
}

// ---------------------------------------------------------------- init

export async function initGlobe(sim, containerEl, { googleKey = '', ionToken = '', quality = 'medium' } = {}) {
  const Cesium = await waitForCesium();
  const q = mobileQuality(QUALITY[quality] || QUALITY.medium);
  W.quality = q;
  if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

  const viewer = new Cesium.Viewer(containerEl, {
    baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false, vrButton: false, projectionPicker: false,
    shouldAnimate: false, useDefaultRenderLoop: false, requestRenderMode: false,
    scene3DOnly: true, msaaSamples: q.msaa, shadows: q.shadows,
    terrainShadows: q.shadows ? Cesium.ShadowMode.RECEIVE_ONLY : Cesium.ShadowMode.DISABLED,
    showRenderLoopErrors: false,
  });
  W.viewer = viewer;
  viewer.resolutionScale = q.mobile
    ? Math.min(window.devicePixelRatio || 1, 1.5) * q.res      // tablets: at most 1.5 px per CSS px
    : Math.min(q.res, 2 / (window.devicePixelRatio || 1) * q.res);
  const scene = viewer.scene;
  scene.screenSpaceCameraController.enableInputs = false;
  scene.debugShowFramesPerSecond = false;
  viewer.camera.frustum.near = 0.3;
  viewer.camera.frustum.fov = 60 * DEG;

  await setupScenery(sim, viewer, { googleKey, ionToken });
  setupAtmosphere(viewer, q);

  W.cam = createCameraController(viewer);
  W.model = await createAircraftModel(viewer, { shadows: q.shadows });
  sim.world = Object.assign(sim.world || {}, { scenery: W.mode, model: W.model.source, viewer });
  return { viewer };
}

async function setupScenery(sim, viewer, { googleKey, ionToken }) {
  const Cesium = C();
  const scene = viewer.scene;
  const globe = scene.globe;
  globe.depthTestAgainstTerrain = true;
  globe.maximumScreenSpaceError = W.quality.sse;
  globe.tileCacheSize = W.quality.mobile ? 150 : 400;
  globe.baseColor = Cesium.Color.fromCssColorString('#2b3a2a');

  if (googleKey) {
    try {
      const tileset = await withTimeout(Cesium.createGooglePhotorealistic3DTileset(
        { key: googleKey, onlyUsingWithGoogleGeocoder: true },
        { showCreditsOnScreen: true, maximumScreenSpaceError: W.quality.tileSse,
          ...(W.quality.mobile ? { cacheBytes: 256 * 1024 * 1024, maximumCacheOverflowBytes: 128 * 1024 * 1024 } : {}) }),
        20000, 'google tiles');
      scene.primitives.add(tileset);
      globe.show = false;
      W.tileset = tileset; W.mode = 'google';
      // Keep an ellipsoid-only terrain under the hidden globe; heights come from sampleHeight.
      return;
    } catch (e) {
      console.warn('[globe] Google 3D tiles failed, falling back', e);
      sim.events.emit('toast', { text: 'Google 3D Tiles unavailable – using satellite imagery' });
    }
  }
  if (ionToken) {
    try {
      viewer.imageryLayers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.createWorldImageryAsync()));
      scene.terrainProvider = await withTimeout(Cesium.createWorldTerrainAsync({ requestWaterMask: true }), 20000, 'ion terrain');
      W.mode = 'ion';
      return;
    } catch (e) {
      console.warn('[globe] Cesium ion failed, falling back', e);
      viewer.imageryLayers.removeAll();
      sim.events.emit('toast', { text: 'Cesium ion unavailable – using keyless imagery' });
    }
  }
  // keyless ESRI imagery + terrain
  try {
    const imagery = await withTimeout(Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_IMAGERY), 15000, 'esri imagery');
    viewer.imageryLayers.add(new Cesium.ImageryLayer(imagery));
  } catch (e) {
    console.warn('[globe] ESRI metadata failed, using URL template', e);
    viewer.imageryLayers.add(new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: `${ESRI_IMAGERY.replace('services.', 'server.')}/tile/{z}/{y}/{x}`, maximumLevel: 19,
      credit: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community' })));
  }
  try {
    scene.terrainProvider = await withTimeout(Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN), 15000, 'esri terrain');
  } catch (e) {
    console.warn('[globe] ESRI terrain failed – flat ellipsoid', e);
    sim.events.emit('toast', { text: 'Terrain service unavailable – flat terrain' });
  }
  W.mode = 'esri';
}

function setupAtmosphere(viewer, q) {
  const s = viewer.scene;
  s.globe.enableLighting = true;
  s.globe.dynamicAtmosphereLighting = true;
  s.globe.dynamicAtmosphereLightingFromSun = true;
  s.globe.showGroundAtmosphere = true;
  if (s.skyAtmosphere) { s.skyAtmosphere.show = true; }
  if (s.moon) s.moon.show = false; // reads as a dark speck in daylight
  s.fog.enabled = true;
  s.fog.density = 1.6e-4;
  s.fog.minimumBrightness = 0.04;
  s.highDynamicRange = !!q.hdr;
  if (s.postProcessStages?.fxaa) s.postProcessStages.fxaa.enabled = q.fxaa;
  if (q.shadows && s.shadowMap) {
    s.shadowMap.enabled = true;
    s.shadowMap.softShadows = true;
    s.shadowMap.maximumDistance = 1500;
    s.shadowMap.size = 2048;
  }
}

// ---------------------------------------------------------------- time of day

/** Set the Cesium clock so local *solar* time at lonDeg equals hoursLocal. */
export function setTimeOfDay(sim, hoursLocal, lonDeg) {
  const Cesium = C();
  if (!W.viewer) return;
  const now = new Date();
  const utcH = hoursLocal - lonDeg / 15;
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + utcH * 3600e3;
  W.clockBase = Cesium.JulianDate.fromDate(new Date(base));
  W.simT0 = sim.time || 0;
  W.viewer.clock.currentTime = W.clockBase.clone();
  sim.env.timeOfDayH = hoursLocal;
}

function advanceClock(sim) {
  const Cesium = C();
  if (!W.clockBase) return;
  const t = Cesium.JulianDate.addSeconds(W.clockBase, (sim.time || 0) - W.simT0, new Cesium.JulianDate());
  W.viewer.clock.currentTime = t;
}

// ---------------------------------------------------------------- ground height

function excludeList() { return W.model ? W.model.exclude() : []; }

/** Per-frame ground height (ellipsoidal) under the aircraft -> sim.env.groundH. */
function updateGround(sim, dt) {
  const Cesium = C();
  const scene = W.viewer.scene;
  const ac = sim.ac, env = sim.env;
  const carto = Cesium.Cartographic.fromRadians(ac.lon, ac.lat);
  const g = W.ground;
  let h;
  if (W.mode === 'google') {
    if (W.frameNo % 4 === 0 && scene.sampleHeightSupported) {
      try { h = scene.sampleHeight(carto, excludeList()); } catch (e) { h = undefined; }
      if (Number.isFinite(h)) {
        g.filtered = g.filtered === null || Math.abs(h - g.filtered) > 40 ? h : lag(g.filtered, h, 0.25, Math.max(dt, 1 / 60) * 4);
      }
    }
    h = g.filtered;
  } else {
    const fast = scene.globe.getHeight(carto);
    // Periodically refine with the most-detailed terrain sample and keep the difference as a bias,
    // so coarse LOD tiles do not make the runway "move" under the wheels.
    const agl = ac.h - (Number.isFinite(env.groundH) ? env.groundH : 0);
    const now = performance.now();
    if (!g.pending && agl < 3000 && now - g.lastReq > 500 && scene.terrainProvider && !(scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
      g.pending = true; g.lastReq = now;
      const c = carto.clone();
      Cesium.sampleTerrainMostDetailed(scene.terrainProvider, [c]).then(([s]) => {
        g.pending = false;
        if (!s || !Number.isFinite(s.height)) return;
        g.detailed = { carto: s.clone(), h: s.height };
      }).catch(() => { g.pending = false; });
    }
    // Ground = fast height here + (detailed - fast) at the last detailed sample point. Both fast
    // values come from the same loaded LOD, so coarse tiles and LOD swaps cancel out instantly.
    const d = g.detailed;
    const fastAtD = d && d.carto ? scene.globe.getHeight(d.carto) : undefined;
    if (d && Number.isFinite(fastAtD) && Math.abs(d.h - fastAtD) < 300) g.bias = d.h - fastAtD;
    else if (d && !d.carto) g.bias = 0;
    if (Number.isFinite(fast) && Number.isFinite(fastAtD)) h = fast + g.bias;
    else if (d) h = d.h;                       // nothing loaded yet: use the last detailed sample
    else if (Number.isFinite(fast)) h = fast;
    // tiny smoothing against residual steps (never across big jumps)
    if (Number.isFinite(h) && g.filtered !== null && Math.abs(h - g.filtered) < 5) h = lag(g.filtered, h, 0.08, dt || 1 / 60);
    if (Number.isFinite(h)) g.filtered = h;
  }
  if (Number.isFinite(h)) { env.groundH = h; env.groundValid = true; }
}

// ---------------------------------------------------------------- per frame

export function updateGlobe(sim, dt = 0) {
  const v = W.viewer;
  if (!v || v.isDestroyed()) return;
  W.frameNo++;
  advanceClock(sim);
  let fr;
  if (W.model) {
    W.model.setVisible(sim.view.mode !== 'cockpit');
    fr = W.model.pose(sim);
  } else {
    fr = computeBodyFrame(sim, W.frame);
  }
  try { updateGround(sim, dt); } catch (e) { /* never break the frame on sampling */ }
  W.cam.update(sim, fr, dt);
  v.resize();
  v.render();
}

// ---------------------------------------------------------------- spawn

/** Sample the ground height (ellipsoidal) at lat/lon (deg); null if unavailable. */
async function sampleGround(latDeg, lonDeg, timeoutMs = 12000) {
  const Cesium = C();
  const scene = W.viewer.scene;
  const carto = Cesium.Cartographic.fromDegrees(lonDeg, latDeg);
  try {
    if (W.mode === 'google') {
      if (!scene.sampleHeightSupported) return null;
      const [c] = await withTimeout(scene.sampleHeightMostDetailed([carto], excludeList()), timeoutMs, 'sampleHeight');
      return Number.isFinite(c?.height) ? c.height : null;
    }
    if (scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return null;
    const [c] = await withTimeout(Cesium.sampleTerrainMostDetailed(scene.terrainProvider, [carto]), timeoutMs, 'sampleTerrain');
    return Number.isFinite(c?.height) ? c.height : null;
  } catch (e) {
    console.warn('[globe] ground sample failed', e);
    return null;
  }
}

/** Fallback when physics/fdm.js is not available: set the essential sim.ac fields. */
function fallbackInitAircraft(sim, o) {
  const ac = sim.ac;
  ac.lat = o.lat; ac.lon = o.lon; ac.h = o.h + (o.onGround ? CG_HEIGHT_M : 0);
  ac.euler = { roll: 0, pitch: 0, heading: o.heading };
  ac.quat = eulerToQuat(0, 0, o.heading);
  ac.vNED = [0, 0, 0]; ac.onGround = o.onGround; ac.gs = 0; ac.tas = 0; ac.cas = 0;
  ac.track = o.heading; ac.altMSL = o.h - sim.env.geoidN;
  ac.fuelKg = { L: o.fuelKg * 0.3, C: o.fuelKg * 0.4, R: o.fuelKg * 0.3 };
  ac.zfw = 167829 + o.payloadKg; ac.mass = ac.zfw + o.fuelKg;
}

/**
 * Place the aircraft on `runway` of `airport` (contract objects, degrees), ~40 m past the
 * physical runway start on the centreline, facing the runway true heading.
 * opts: { fuelKg, payloadKg, coldDark, timeOfDayH } (optional, from the menu).
 */
export async function spawnAt(sim, airport, runway, opts = {}) {
  const Cesium = C();
  if (!W.viewer) throw new Error('initGlobe first');
  const rwy = runway || airport.runways[0];
  const startLat = rwy.startLat ?? rwy.lat, startLon = rwy.startLon ?? rwy.lon;
  const hdg = rwy.hdgDeg * DEG;
  const p = destination(startLat * DEG, startLon * DEG, hdg, 40);
  const latD = p.lat * RAD, lonD = p.lon * RAD;
  const elevFt = Number.isFinite(rwy.elevFt) ? rwy.elevFt : airport.elevFt;

  if (Number.isFinite(opts.timeOfDayH)) setTimeOfDay(sim, opts.timeOfDayH, lonD);
  else if (!W.clockBase) setTimeOfDay(sim, sim.env.timeOfDayH ?? 12, lonD);

  // Park the camera over the spot so tiles there load first.
  const view = W.viewer.camera;
  view.lookAtTransform(Cesium.Matrix4.IDENTITY);
  view.setView({
    destination: Cesium.Cartesian3.fromDegrees(lonD, latD, elevFt * FT + 400),
    orientation: { heading: hdg, pitch: -30 * DEG, roll: 0 },
  });
  for (let i = 0; i < 3; i++) W.viewer.render();

  const sampled = await sampleGround(latD, lonD);
  let groundH = sampled;
  let geoidN = 0;
  if (Number.isFinite(groundH)) geoidN = groundH - elevFt * FT;
  else { groundH = elevFt * FT; geoidN = 0; console.warn('[globe] spawn: using airport elevation (no terrain sample)'); }
  if (Math.abs(geoidN) > 120) { geoidN = 0; }   // implausible -> keep MSL = ellipsoid

  const env = sim.env;
  env.geoidN = geoidN; env.groundH = groundH; env.groundValid = true;
  W.ground = { bias: 0, pending: false, lastReq: -1, filtered: groundH,
    detailed: { h: groundH, carto: Number.isFinite(sampled) ? Cesium.Cartographic.fromDegrees(lonD, latD, groundH) : null } };

  const init = {
    // fdm.js treats h as the GROUND ellipsoidal height when onGround (it solves the CG height
    // from the gear struts); the fallback below adds the CG height itself.
    lat: p.lat, lon: p.lon, h: groundH, heading: hdg, onGround: true, speedKt: 0,
    fuelKg: opts.fuelKg ?? 60000, payloadKg: opts.payloadKg ?? 30000, enginesRunning: !opts.coldDark,
  };
  let initAircraft = null;
  try { ({ initAircraft } = await import('../physics/fdm.js')); } catch (e) { console.warn('[globe] fdm.js not available', e); }
  try {
    if (typeof initAircraft === 'function') initAircraft(sim, init);
    else fallbackInitAircraft(sim, init);
  } catch (e) {
    console.error('[globe] initAircraft threw – using fallback', e);
    fallbackInitAircraft(sim, init);
  }
  sim.ac.magVar = (airport.magVarDeg || 0) * DEG;
  sim.fmc.origin = airport;
  sim.world = Object.assign(sim.world || {}, { airport, runway: rwy, spawnGroundH: groundH });
  W.cam.update(sim, W.model ? W.model.pose(sim) : computeBodyFrame(sim, W.frame), 0);
  return { groundH, geoidN };
}

/** Debug access (window.sim.world.debug). */
export function globeDebug() { return W; }
if (typeof window !== 'undefined') window.__globeDebug = W;
export { QUALITY };
