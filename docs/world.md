# Team B: World and shell

## Files
- `index.html`: loads Cesium 1.145.0 (global `Cesium`) from jsDelivr with `async`, links every team's CSS, builds the CONTRACT DOM and loads `src/main.js`.
- `src/main.js`: boot sequence and main loop.
  - Every other module is loaded with dynamic `import()`. A missing module or export becomes a no-op and is logged once.
  - Each subsystem call runs inside try/catch. The first error per subsystem is logged and later ones are suppressed.
  - Physics uses a fixed 1/120 s accumulator, capped at 48 steps per frame. `simRate` and pause are applied. While paused, only rendering (`updateGlobe`, `updateDisplays`, panel updates) continues.
  - `window.sim` is exposed. `sim.debug.{api,loaded,failed}` shows which modules loaded.
- `src/world/globe.js`: `initGlobe`, `updateGlobe`, `spawnAt` (plus `setTimeOfDay`, `waitForCesium`).
  - The viewer is created with `useDefaultRenderLoop:false`. `updateGlobe` renders exactly one frame.
  - All camera-controller inputs are disabled.
  - Scenery: Google Photorealistic 3D Tiles (globe hidden), then Cesium ion (World Terrain + Bing), then keyless ESRI World Imagery + WorldElevation3D. Each one falls back to the next.
  - Sun lighting follows local solar time from the menu. Fog, atmosphere and HDR depend on the quality preset; shadows are on at high/ultra.
- `src/world/camera.js`: cockpit, chase, flyby and tower cameras, built from the body→NED quaternion (body→NED→ECEF matrices, no Euler shortcuts).
  - Cockpit eye position, body axes relative to the CG: (29.2, −0.55, −1.55) m.
  - Cockpit horizontal FOV is 72°/zoom. With the panel shown, the view is pitched down automatically so the horizon sits above the panel.
  - The aircraft model is hidden in cockpit view.
- `src/world/model777.js`: FR24 `b773.glb` (GPLv2; credit and link are added to the Cesium credits) scaled to 73.9 m.
  - A procedural landing gear is added, because the glb has none.
  - A procedural fallback airliner is used if the glb fails to load.
  - Livery fix: Cesium's glTF 1.0 upgrade binds the wrong texture to this model, so a CustomShader samples the embedded paint atlas instead.
  - Orientation was verified in screenshots (`tests/shots/world-chase*.png`).
- `src/world/airports.js`: 15 airports from OurAirports.
  - Airport `lat/lon` (reference point, degrees), `elevFt`, `magVarDeg`, `tower`.
  - Runways: `lat/lon` = landing threshold (displaced), `hdgDeg` (true), `lengthM`, `widthM`, `ldaM`, `startLat/startLon` (physical start, used for takeoff), `endLat/endLon` (far end), `ils{freq,ident,gsDeg,crsDeg,simOnly}`.
  - Published ILS data is included only for EGLL, KSFO 28L/R and KLAX 24R/25L. All other runways use a generated frequency with `simOnly:true`.
  - Also exports `findAirport`, `findRunway` and `nearestAirport`.
- `src/ui/menu.js`: start screen, pause card (Resume / Restart on runway / New flight / Keys) and key-binding sheet. Settings and API keys are saved in localStorage.
- `src/ui/hud.js`: readout for external views and `'toast'` handling.
- `styles/shell.css` and `styles/menu.css`.
- Test: `tests/world-shots.mjs`. Screenshots go to `tests/shots/world-*.png`.

## Ground height
`sim.env.groundH` is an ellipsoidal height.
- ESRI and ion terrain: computed every frame as
  `globe.getHeight(here) + (lastMostDetailed − globe.getHeight(lastMostDetailedPoint))`.
  A `sampleTerrainMostDetailed` request runs every 0.5 s below 3000 m AGL. Coarse or changing LOD tiles therefore cancel out. Without this, a coarse tile at EDDF reported the runway 27 m too low.
- Google 3D Tiles: `scene.sampleHeight` every 4th frame, excluding the aircraft, then low-pass filtered.
- Note: ESRI terrain heights are close to MSL, so `env.geoidN` comes out about 0 at EDDF. This is intended: `geoidN` = sampled − elevFt.

## Integration notes and contract clarifications
- `spawnAt(sim, airport, runway, opts?)` takes an optional 4th argument from the menu: `{fuelKg, payloadKg, coldDark, timeOfDayH}`. It passes `enginesRunning: !coldDark` to `initAircraft`.
  - Lat, lon and heading are in **radians**.
  - With `onGround`, `h` is the **ground** ellipsoidal height. This matches fdm.js, which solves the CG height from the struts.
  - The aircraft spawns 40 m past the *physical* runway start, so the full length is available.
- `sim.fmc.origin/dest` hold airport objects; `sim.fmc.originRwy/destRwy` hold runway objects. `buildDefaultRoute` is called only when a destination is chosen.
- Drawers are opened by the CSS class `open` on `#drawer-*`. input.js can use `sim.ui.toggleDrawer(name)` or emit `sim.events.emit('drawer', {name, open?})`. Opening one right-side drawer (OVHD/CDU/LWR) closes the others.
- Pause:
  - main.js watches `sim.paused` and shows the pause card. input.js can also emit `'menu'` on Esc.
  - Keys typed inside `#menu` are stopped from propagating, so flight keys don't fire while you type.
  - If input.js fails to load, main installs fallback keys: Esc, Space, C, V, 1–4 and =.
- Body classes `view-<mode>` and `panel-hidden` are synced every frame. A `'view'` event is emitted on change.
- Other teams' host classes (`.cdu-host{position:relative}` etc.) used to override drawer positioning. Drawer rules are now scoped as `#app > .drawer…`. Please don't set `position`, `transform` or `top/left` on `#drawer-*` hosts.

## Limitations
- Swiftshader (headless test) renders at about 1 fps. Distant tiles load slowly, so the screenshots show some blurry or olive placeholder tiles.
- The tower camera sits 60 m above the airport reference point, not at the real tower.
- There is no gear or flap animation on the glb. The procedural gear is shown when `surfaces.gear > 0.5`.
- The model is a white livery and has no cockpit interior.
