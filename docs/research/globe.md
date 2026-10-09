# Globe rendering for a browser flight sim (plain ES modules, jsDelivr)

Research date 2026-10-09. Every URL marked "curl 200" was fetched from this machine.

## 1. CesiumJS: version and loading
- npm `latest` is 1.146.0 (published 2026-10-01, too new). **Use 1.145.0** (published 2026-09-01).
- curl 200: `https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js` (6.0 MB, UMD global `Cesium`),
  `.../Build/Cesium/index.js` (4.7 MB, **real ESM**, `export {...}`), `.../Widgets/widgets.css`, `.../Workers/*.js`, `.../Assets/*.json`.
- The ESM build still fetches Workers/Assets/Widgets at runtime from `CESIUM_BASE_URL`. Set it in a classic script
  that runs *before* the module, because `import` statements are hoisted:
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Widgets/widgets.css">
<script>window.CESIUM_BASE_URL = 'https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/';</script>
<!-- Option A: global -->  <script src="https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/Cesium.js"></script>
<!-- Option B: ESM -->     <script type="module">import * as Cesium from 'https://cdn.jsdelivr.net/npm/cesium@1.145.0/Build/Cesium/index.js';</script>
```
Viewer without an Ion token. The defaults (Bing imagery via Ion, geocoder) call Ion, so turn them off explicitly:
```js
const viewer = new Cesium.Viewer('globe', {
  baseLayer: false,              // otherwise Ion Bing imagery is used and a token is needed
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false, shouldAnimate: true,
  requestRenderMode: false,      // sim redraws every frame anyway
  msaaSamples: 4,
});
viewer.scene.debugShowFramesPerSecond = false;
```
- If anything touches Ion without your token, Cesium 1.145 still embeds a default token and shows a credit/console
  warning: "This application is using Cesium's default ion access token. Please assign Cesium.Ion.defaultAccessToken ...".
  To stay quiet, avoid Ion entirely (as above) or set `Cesium.Ion.defaultAccessToken = '<your free token>'` first.
- `ArcGisMapServerImageryProvider.fromBasemapType()` uses `ArcGisMapService.defaultAccessToken` (an Ion-provided
  token). Use `fromUrl()` with the public MapServer instead (section 3).

## 2. Google Photorealistic 3D Tiles
- Needs a Google Cloud key with the **Map Tiles API** enabled and billing set up. Without a key,
  `tile.googleapis.com/v1/3dtiles/root.json` returns 403 "unregistered callers" (curl). Restrict the key by HTTP referrer.
- Exact 1.145 signature (source read): `createGooglePhotorealistic3DTileset(apiOptions?, tilesetOptions?)`, where
  `apiOptions = { key, onlyUsingWithGoogleGeocoder: true }`. With no key it falls back to Ion asset 2275207 (Ion token needed).
  It defaults `cacheBytes` to 1.5 GB and `enableCollision: true` (the camera does not go underground).
```js
const tileset = await Cesium.createGooglePhotorealistic3DTileset(
  { key: GOOGLE_KEY, onlyUsingWithGoogleGeocoder: true },   // flag silences the one-time geocoder warning
  { showCreditsOnScreen: true, maximumScreenSpaceError: 16 });
viewer.scene.primitives.add(tileset);
viewer.scene.globe.show = false;   // photoreal tiles already contain terrain; avoids z-fighting
// Equivalent low-level form:
// const tileset = await Cesium.Cesium3DTileset.fromUrl(
//   `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_KEY}`, { showCreditsOnScreen: true });
```
- Attribution: the Google logo plus the per-tile data credits must be visible. Keep `showCreditsOnScreen: true`
  and do not hide `viewer.bottomContainer` / the credit container. Google's policy also forbids caching tiles offline
  and using a geocoder other than Google's with these tiles.
- Ground height on photoreal tiles (`globe.getHeight` does not work while the globe is hidden):
```js
// sync, cheap, only uses tiles already rendered; may return undefined
const h = viewer.scene.sampleHeight(Cesium.Cartographic.fromDegrees(lon, lat), [aircraftPrimitive]);
// async, most detailed LOD, use for spawn/landing; 2nd arg is objectsToExclude, 3rd is width in m
const [c] = await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(lon, lat)], [aircraftPrimitive]);
const [p] = await viewer.scene.clampToHeightMostDetailed([cartesian], [aircraftPrimitive]);
```
  Check `viewer.scene.sampleHeightSupported` first (it needs depth-texture support). Per frame, call `sampleHeight`
  about every 5th frame for the gear and low-pass filter the result, because tile LOD changes make the height jitter.

## 3. Keyless fallback: ESRI imagery and terrain
- curl 200 with `Access-Control-Allow-Origin: *` and no token: `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json`,
  tile `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/350/536` (JPEG; note the **z/y/x** order).
- curl 200 with `ACAO: *` and **no token**: `https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer?f=json`,
  `.../tile/10/350/536` (LERC blob) and `.../tilemap/...`. Esri's terms still require the "Esri, Maxar, Earthstar..." credit, which Cesium adds automatically.
```js
const imagery = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer');
viewer.imageryLayers.add(new Cesium.ImageryLayer(imagery));
// or, with no metadata request:
// new Cesium.UrlTemplateImageryProvider({ url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
//   maximumLevel: 19, credit: 'Esri, Maxar, Earthstar Geographics' })
viewer.scene.terrainProvider = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer');
// Alternative with an Ion token: viewer.scene.terrainProvider = await Cesium.createWorldTerrainAsync({ requestWaterMask: true });
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.maximumScreenSpaceError = 1.5;   // sharper terrain near the ground (default 2)
```
Terrain height under the aircraft:
```js
const carto = Cesium.Cartographic.fromDegrees(lon, lat);
const hFast = viewer.scene.globe.getHeight(carto);   // every frame; loaded tiles only; undefined if not loaded
const [s] = await Cesium.sampleTerrainMostDetailed(viewer.scene.terrainProvider, [carto.clone()]);
// s.height is ellipsoid height in m at max LOD; use it to place the aircraft on the runway at spawn
```
Heights are ellipsoidal (WGS84). Airport `elevFt` values are MSL, and the geoid offset can be about ±50 m
(EDDF +48 m, KLAX -35 m). Place the aircraft from **sampled terrain**, not from `elevFt`.

## 4. Camera and render loop
```js
const ssc = viewer.scene.screenSpaceCameraController;
ssc.enableInputs = false;                            // no mouse orbit/zoom
viewer.scene.preUpdate.addEventListener((scene, time) => stepPhysics(time));    // before the scene updates
viewer.scene.postUpdate.addEventListener(() => placeCamera());                  // after; set the camera here
// Driving it yourself: new Viewer(..., {useDefaultRenderLoop:false}) then call viewer.render() in rAF.

const hpr = new Cesium.HeadingPitchRoll(), pos = new Cesium.Cartesian3(), mtx = new Cesium.Matrix4();
// Model +X = nose. With a north-west local frame, heading 0 = north and grows clockwise like a compass
const fixedFrame = Cesium.Transforms.localFrameToFixedFrameGenerator('north', 'west');
function poseAircraft(model, lonDeg, latDeg, hM, hdgDeg, pitDeg, rolDeg) {
  Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, hM, Cesium.Ellipsoid.WGS84, pos);
  hpr.heading = Cesium.Math.toRadians(hdgDeg + MODEL_HDG_OFFSET);  // 0 for +X-nose models; tune per model
  hpr.pitch = Cesium.Math.toRadians(pitDeg); hpr.roll = Cesium.Math.toRadians(rolDeg);
  Cesium.Transforms.headingPitchRollToFixedFrame(pos, hpr, Cesium.Ellipsoid.WGS84, fixedFrame, model.modelMatrix);
}
// Chase cam: orbit offset expressed in the aircraft frame (or the ENU frame for a horizon-stable chase)
function chaseCam() {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, mtx);
  viewer.camera.lookAtTransform(enu, new Cesium.HeadingPitchRange(
    Cesium.Math.toRadians(hdgDeg), Cesium.Math.toRadians(-8), 90));   // 90 m behind, 8 deg down
}
// Cockpit cam: world position plus orientation, no transform
function cockpitCam() {
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);              // release a previous lookAt
  viewer.camera.setView({ destination: eyePos, orientation: {
    heading: Cesium.Math.toRadians(hdgDeg), pitch: Cesium.Math.toRadians(pitDeg), roll: Cesium.Math.toRadians(rolDeg) } });
}
viewer.camera.frustum.fov = Cesium.Math.toRadians(60); viewer.camera.frustum.near = 0.5;
```
Aircraft glTF models (curl 200 and CORS `*` for all of these):
- **Boeing 777 (GPL-2.0, Flightradar24 repo, FlightGear-derived)**, available from jsDelivr per file even though the repo
  is too big for a jsDelivr package listing:
  `https://cdn.jsdelivr.net/gh/Flightradar24/fr24-3d-models@master/models/b773.glb` (1.3 MB, 777-300) and `.../b772.glb` (2.0 MB).
  Also available: `b738 b744 b788 b789 a320 a321 a333 a359` (`b77w` and `a388` return 404).
  These are **glTF 1.0** (collada2gltf, KHR_binary_glTF); Cesium upgrades them on load (`GltfJsonLoader` calls `updateVersion`).
  The bounding box is about 75 x 60 x 42 units, so the model is roughly at metre scale. Check the nose axis visually and
  fix it with the heading offset. GPL means you credit "Flightradar24 / FlightGear (GPLv2)" and link to the source.
- Cesium sample model (Apache-2.0, small prop plane, not an airliner):
  `https://cdn.jsdelivr.net/gh/CesiumGS/cesium@1.145/Apps/SampleData/models/CesiumAir/Cesium_Air.glb`.
```js
const model = await Cesium.Model.fromGltfAsync({
  url: 'https://cdn.jsdelivr.net/gh/Flightradar24/fr24-3d-models@master/models/b773.glb',
  minimumPixelSize: 0, scale: 1.0, shadows: Cesium.ShadowMode.ENABLED });
viewer.scene.primitives.add(model);
```
- Fallback with no download: build an airliner from Cesium primitives (`CylinderGeometry` fuselage, flat `BoxGeometry`
  wings and stabilisers in one `Primitive` with a shared `modelMatrix`), or generate a tiny glTF JSON with base64
  buffers in JS and pass `Model.fromGltfAsync({ gltf: jsonObject })`.

## 5. Lighting, atmosphere and time of day
```js
const s = viewer.scene;
s.globe.enableLighting = true;                 // day/night from the sun position
s.globe.dynamicAtmosphereLighting = true; s.globe.dynamicAtmosphereLightingFromSun = true;
s.skyAtmosphere.show = true; s.skyAtmosphere.atmosphereLightIntensity = 10;  // default 50
s.fog.enabled = true; s.fog.density = 2e-4; s.fog.minimumBrightness = 0.03;
s.highDynamicRange = true;                     // tone-mapped; looks good with photoreal tiles
s.shadowMap.enabled = true; s.shadowMap.softShadows = true; s.shadowMap.maximumDistance = 2000;
s.postProcessStages.fxaa.enabled = true;
viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-06-21T14:00:00Z');  // time of day in UTC
viewer.clock.multiplier = 1; viewer.clock.shouldAnimate = true;
```
Photoreal tiles have sun and shadows baked into their texture, so time of day only changes the sky, the atmosphere and the model.
Use HDR plus fog there. With ESRI imagery, `enableLighting` produces a proper night side.

## 6. Airport data
- curl 200: `https://davidmegginson.github.io/ourairports-data/runways.csv` (4.0 MB), `airports.csv` (12.7 MB), `navaids.csv`.
  These are public domain, but too big to fetch at runtime. OurAirports has **no ILS frequencies** (navaids.csv covers VOR/NDB/DME),
  so ILS freqs are left out. If you need them, add them by hand from AIP charts.
- The table below was extracted from runways.csv on 2026-10-09. `lat/lon` is the runway **end** (`le_/he_`), not the displaced
  threshold. Move `dispFt` along `hdgT` to get the landing threshold. `hdgT` is the true course **computed** from the two ends
  (great circle), because the CSV values are often rounded. Elevations are MSL ft. Also saved as `airports_snippet.js` next to this file.
```js
export const AIRPORTS = [
  { icao:'EDDF', name:'Frankfurt Main Airport', city:'Frankfurt am Main', lat:50.02671, lon:8.55835, elevFt:364, runways:[
    { id:'07C', lat:50.032600, lon:8.534630, elevFt:329, hdgT:69.6, dispFt:0, lenFt:13123, widFt:197 },{ id:'25C', lat:50.045101, lon:8.586980, elevFt:364, hdgT:249.6, dispFt:0, lenFt:13123, widFt:197 },
    { id:'07R', lat:50.027500, lon:8.534170, elevFt:328, hdgT:69.4, dispFt:0, lenFt:13123, widFt:148 },{ id:'25L', lat:50.040100, lon:8.586530, elevFt:362, hdgT:249.5, dispFt:0, lenFt:13123, widFt:148 },
  ]},
  { icao:'EDDM', name:'Munich Airport', city:'Munich', lat:48.35380, lon:11.78610, elevFt:1487, runways:[
    { id:'08L', lat:48.362801, lon:11.767600, elevFt:1467, hdgT:83.4, dispFt:0, lenFt:13123, widFt:197 },{ id:'26R', lat:48.366901, lon:11.821200, elevFt:1449, hdgT:263.5, dispFt:0, lenFt:13123, widFt:197 },
    { id:'08R', lat:48.340698, lon:11.751000, elevFt:1486, hdgT:83.4, dispFt:0, lenFt:13123, widFt:197 },{ id:'26L', lat:48.344799, lon:11.804600, elevFt:1470, hdgT:263.5, dispFt:0, lenFt:13123, widFt:197 },
  ]},
  { icao:'KJFK', name:'John F. Kennedy International Airport', city:'New York', lat:40.63945, lon:-73.77932, elevFt:13, runways:[
    { id:'04L', lat:40.622002, lon:-73.785599, elevFt:12, hdgT:30.6, dispFt:463, lenFt:12079, widFt:200 },{ id:'22R', lat:40.648800, lon:-73.764702, elevFt:13, hdgT:210.6, dispFt:2696, lenFt:12079, widFt:200 },
    { id:'13R', lat:40.648399, lon:-73.816704, elevFt:13, hdgT:120.9, dispFt:2043, lenFt:14511, widFt:200 },{ id:'31L', lat:40.627899, lon:-73.771599, elevFt:13, hdgT:300.9, dispFt:3263, lenFt:14511, widFt:200 },
  ]},
  { icao:'KLAX', name:'Los Angeles International Airport', city:'Los Angeles', lat:33.94250, lon:-118.40800, elevFt:125, runways:[
    { id:'6L', lat:33.949119, lon:-118.431187, elevFt:112, hdgT:83.0, dispFt:0, lenFt:8926, widFt:150 },{ id:'24R', lat:33.952112, lon:-118.401954, elevFt:117, hdgT:263.0, dispFt:0, lenFt:8926, widFt:150 },
    { id:'7R', lat:33.933659, lon:-118.419074, elevFt:118, hdgT:83.0, dispFt:0, lenFt:11095, widFt:200 },{ id:'25L', lat:33.937371, lon:-118.382700, elevFt:95, hdgT:263.0, dispFt:0, lenFt:11095, widFt:200 },
  ]},
  { icao:'EGLL', name:'London Heathrow Airport', city:'London', lat:51.47075, lon:-0.45991, elevFt:83, runways:[
    { id:'09L', lat:51.477490, lon:-0.489439, elevFt:79, hdgT:89.7, dispFt:1007, lenFt:12799, widFt:164 },{ id:'27R', lat:51.477681, lon:-0.433227, elevFt:78, hdgT:269.7, dispFt:0, lenFt:12799, widFt:164 },
    { id:'09R', lat:51.464780, lon:-0.486808, elevFt:75, hdgT:89.7, dispFt:1013, lenFt:12001, widFt:164 },{ id:'27L', lat:51.464957, lon:-0.434048, elevFt:77, hdgT:269.7, dispFt:0, lenFt:12001, widFt:164 },
  ]},
  { icao:'OMDB', name:'Dubai International Airport', city:'Dubai', lat:25.24979, lon:55.37099, elevFt:62, runways:[
    { id:'12L', lat:25.264627, lon:55.350422, elevFt:11, hdgT:121.5, dispFt:1476, lenFt:14275, widFt:197 },{ id:'30R', lat:25.247709, lon:55.380932, elevFt:32, hdgT:301.5, dispFt:984, lenFt:14275, widFt:197 },
    { id:'12R', lat:25.252836, lon:55.364376, elevFt:11, hdgT:121.5, dispFt:2345, lenFt:14590, widFt:197 },{ id:'30L', lat:25.235920, lon:55.394882, elevFt:60, hdgT:301.5, dispFt:433, lenFt:14590, widFt:197 },
  ]},
  { icao:'KSFO', name:'San Francisco International Airport', city:'San Francisco', lat:37.61981, lon:-122.37482, elevFt:13, runways:[
    { id:'10L', lat:37.628742, lon:-122.393410, elevFt:5, hdgT:117.9, dispFt:0, lenFt:11870, widFt:200 },{ id:'28R', lat:37.613538, lon:-122.357160, elevFt:13, hdgT:297.9, dispFt:300, lenFt:11870, widFt:200 },
    { id:'10R', lat:37.626298, lon:-122.393124, elevFt:6, hdgT:117.9, dispFt:0, lenFt:11381, widFt:200 },{ id:'28L', lat:37.611720, lon:-122.358367, elevFt:13, hdgT:297.9, dispFt:300, lenFt:11381, widFt:200 },
  ]},
  { icao:'LFPG', name:'Charles de Gaulle International Airport', city:'Paris', lat:49.00896, lon:2.55412, elevFt:392, runways:[
    { id:'08R', lat:48.992901, lon:2.565660, elevFt:336, hdgT:85.2, dispFt:0, lenFt:8858, widFt:197 },{ id:'26L', lat:48.994900, lon:2.602430, elevFt:316, hdgT:265.3, dispFt:0, lenFt:8858, widFt:197 },
    { id:'09L', lat:49.024700, lon:2.524890, elevFt:378, hdgT:85.3, dispFt:0, lenFt:8858, widFt:197 },{ id:'27R', lat:49.026699, lon:2.561690, elevFt:392, hdgT:265.3, dispFt:0, lenFt:8858, widFt:197 },
  ]},
  { icao:'RJTT', name:'Tokyo Haneda International Airport', city:'Tokyo', lat:35.54968, lon:139.78696, elevFt:35, runways:[
    { id:'16L', lat:35.565897, lon:139.786550, elevFt:22, hdgT:150.0, dispFt:1280, lenFt:11024, widFt:200 },{ id:'34R', lat:35.539690, lon:139.805142, elevFt:20, hdgT:330.0, dispFt:1180, lenFt:11024, widFt:200 },
    { id:'16R', lat:35.560452, lon:139.768734, elevFt:20, hdgT:150.0, dispFt:1770, lenFt:9843, widFt:200 },{ id:'34L', lat:35.536591, lon:139.785672, elevFt:20, hdgT:330.0, dispFt:0, lenFt:9843, widFt:200 },
  ]},
  { icao:'VHHH', name:'Hong Kong International Airport', city:'Hong Kong', lat:22.31184, lon:113.91486, elevFt:28, runways:[
    { id:'07C', lat:22.310400, lon:113.896004, elevFt:22, hdgT:70.9, dispFt:565, lenFt:12467, widFt:197 },{ id:'25C', lat:22.321600, lon:113.931000, elevFt:23, hdgT:250.9, dispFt:580, lenFt:12467, widFt:197 },
    { id:'07R', lat:22.296200, lon:113.898003, elevFt:28, hdgT:70.8, dispFt:525, lenFt:12467, widFt:197 },{ id:'25L', lat:22.307431, lon:113.932819, elevFt:27, hdgT:250.8, dispFt:0, lenFt:12467, widFt:197 },
  ]},
  { icao:'WSSS', name:'Singapore Changi Airport', city:'Singapore', lat:1.35019, lon:103.99400, elevFt:22, runways:[
    { id:'02L', lat:1.348970, lon:103.977997, elevFt:22, hdgT:22.7, dispFt:0, lenFt:13123, widFt:197 },{ id:'20R', lat:1.382410, lon:103.991997, elevFt:14, hdgT:202.7, dispFt:2429, lenFt:13123, widFt:197 },
    { id:'02C', lat:1.328800, lon:103.985001, elevFt:15, hdgT:22.8, dispFt:0, lenFt:13123, widFt:197 },{ id:'20C', lat:1.362130, lon:103.999001, elevFt:15, hdgT:202.8, dispFt:0, lenFt:13123, widFt:197 },
  ]},
  { icao:'EHAM', name:'Amsterdam Airport Schiphol', city:'Amsterdam', lat:52.30860, lon:4.76389, elevFt:-11, runways:[
    { id:'06', lat:52.287899, lon:4.734020, elevFt:-11, hdgT:57.9, dispFt:820, lenFt:11283, widFt:148 },{ id:'24', lat:52.304600, lon:4.777520, elevFt:-12, hdgT:237.9, dispFt:0, lenFt:11283, widFt:148 },
    { id:'18R', lat:52.362701, lon:4.711930, elevFt:-13, hdgT:183.2, dispFt:886, lenFt:12467, widFt:198 },{ id:'36L', lat:52.328602, lon:4.708840, elevFt:-12, hdgT:3.2, dispFt:0, lenFt:12467, widFt:198 },
  ]},
  { icao:'LSZH', name:'Zürich Airport', city:'Zurich', lat:47.45806, lon:8.54806, elevFt:1417, runways:[
    { id:'14', lat:47.483101, lon:8.534730, elevFt:1402, hdgT:137.3, dispFt:492, lenFt:10827, widFt:197 },{ id:'32', lat:47.461300, lon:8.564460, elevFt:1402, hdgT:317.3, dispFt:0, lenFt:10827, widFt:197 },
    { id:'16', lat:47.475601, lon:8.535950, elevFt:1390, hdgT:155.0, dispFt:0, lenFt:12139, widFt:197 },{ id:'34', lat:47.445400, lon:8.556730, elevFt:1388, hdgT:335.1, dispFt:1542, lenFt:12139, widFt:197 },
  ]},
  { icao:'KSEA', name:'Seattle–Tacoma International Airport', city:'Seattle', lat:47.44794, lon:-122.31028, elevFt:433, runways:[
    { id:'16L', lat:47.463799, lon:-122.307999, elevFt:432, hdgT:180.0, dispFt:0, lenFt:11901, widFt:150 },{ id:'34R', lat:47.431198, lon:-122.307999, elevFt:347, hdgT:0.0, dispFt:0, lenFt:11901, widFt:150 },
    { id:'16C', lat:47.463799, lon:-122.310997, elevFt:430, hdgT:180.0, dispFt:0, lenFt:9426, widFt:150 },{ id:'34C', lat:47.438000, lon:-122.310997, elevFt:363, hdgT:0.0, dispFt:0, lenFt:9426, widFt:150 },
  ]},
  { icao:'KPAE', name:'Seattle Paine Field International Airport', city:'Everett', lat:47.90630, lon:-122.28200, elevFt:606, runways:[
    { id:'16R', lat:47.921343, lon:-122.285874, elevFt:558, hdgT:179.1, dispFt:0, lenFt:9010, widFt:150 },{ id:'34L', lat:47.896643, lon:-122.285324, elevFt:579, hdgT:359.1, dispFt:0, lenFt:9010, widFt:150 },
  ]},
];
```
