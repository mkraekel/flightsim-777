# B777 Flight Simulator — Engineering Contract

Every implementer MUST follow this file. It defines module boundaries, exported
function names, DOM ids, CSS files and key bindings so that five teams can build
in parallel and the pieces plug together without edits.

Research references (read the ones relevant to you):
- `../scratchpad/research/physics.md`   (777-300ER aero, engines, performance, FBW, ISA)
- `../scratchpad/research/cockpit.md`   (PFD/ND/EICAS/MCP/CDU/overhead/pedestal/aurals)
- `../scratchpad/research/globe.md`     (CesiumJS, Google 3D tiles, terrain, airports)
(absolute dir: `/tmp/claude-0/-home-user-blog-by-mathis/4fa38caf-f896-5b7f-b613-fc19d2e06296/scratchpad/research/`)

## Tech rules
- Plain browser ES modules, no bundler, no npm install at runtime. Only external lib: CesiumJS 1.x
  loaded by `index.html` from cdn.jsdelivr.net as global `Cesium`. Only `src/world/*` and `src/main.js` may touch `Cesium`.
- Shared state: `src/core/state.js` (`createSimState()`), shared math: `src/core/geo.js`. Do not
  redefine their content; import from them. You MAY add fields to your own state block; do not rename existing ones.
- SI + radians internally. Convert only for display/input.
- Physics, AFDS, FMC, systems modules must be pure logic (no DOM) so they run under Node for tests.
- Each module is resilient: never throw from a `step*`/`update*` function on odd state (guard NaN).
- Code quality: readable, commented where non-obvious, no giant single functions > ~150 lines.

## Directory & ownership
| Team | Files |
|---|---|
| A Physics | `src/physics/atmosphere.js, aircraft777.js (data), aero.js, engines.js, gear.js, fbw.js, fdm.js`; `tests/physics.test.mjs` |
| B World/Shell | `index.html, src/main.js, src/world/globe.js, camera.js, model777.js, airports.js, src/ui/menu.js, src/ui/hud.js, styles/base.css (provided — extend), styles/shell.css, styles/menu.css` |
| C Displays | `src/avionics/gfx.js (canvas helpers), pfd.js, nd.js, eicas.js, isfd.js, efisPanel.js, displays.js`; `styles/displays.css` |
| D1 Autoflight | `src/systems/afds.js, fmc.js, navradio.js, src/cockpit/mcp.js, src/avionics/cdu.js`; `styles/mcp.css, styles/cdu.css`; `tests/afds.test.mjs` |
| D2 Systems/Controls | `src/input/input.js, src/systems/aircraftSystems.js, src/systems/alerts.js, src/audio/audio.js, src/cockpit/overhead.js, src/cockpit/pedestal.js`; `styles/overhead.css, styles/pedestal.css`; `tests/systems.test.mjs` |

## Exported API (exact names)
```js
// A — src/physics/fdm.js
export function initAircraft(sim, { lat, lon, h, heading, onGround = true, speedKt = 0, fuelKg = 60000, payloadKg = 30000 })
export function stepPhysics(sim, dt)      // dt fixed 1/120 s; runs FBW, engines, gear, aero, integration; writes sim.ac, sim.surfaces, sim.engines, sim.fbw
// A — src/physics/atmosphere.js
export function isa(hMSL, tempDevC = 0)  // -> { T, p, rho, a }   (K, Pa, kg/m³, m/s)
export function casFromTas(tas, hMSL, tempDevC), tasFromCas(cas, hMSL, tempDevC), machFromTas(tas, hMSL, tempDevC)
export function pressureAltitude(hMSL, qnhHpa)  // ft-free helper, returns m

// D1 — src/systems/afds.js
export function initAFDS(sim)
export function stepAFDS(sim, dt)          // reads sim.ac/fmc/nav, writes sim.ap.out, sim.ap.thrustCmd, sim.ap.fd, sim.ap.modes
export function afdsAction(sim, action, value)
//   actions: 'AP_ENGAGE','AP_DISC','FD_L','FD_R','AT_ARM','AT','CLB_CON','IAS_MACH','LNAV','VNAV','FLCH',
//            'HDG_SEL','HDG_HOLD','HDG_TRK','VS_FPA','VS','ALT_HOLD','LOC','APP','TOGA',
//            'SPD_SET'(kt or mach),'SPD_INC'(delta),'HDG_SET'(deg),'HDG_INC'(delta),'ALT_SET'(ft),'ALT_INC'(delta),
//            'VS_SET'(fpm),'VS_INC'(delta),'BANK_LIMIT'(deg or 0=AUTO)
// D1 — src/systems/fmc.js
export function initFMC(sim), stepFMC(sim, dt), buildDefaultRoute(sim, origin, dest)
// D1 — src/systems/navradio.js
export function stepNav(sim, dt)           // fills sim.nav.ils deviations from fmc.dest runway / tuned ILS
// D1 — src/cockpit/mcp.js     : export function initMCP(sim, el), updateMCP(sim)
// D1 — src/avionics/cdu.js    : export function initCDU(sim, el), updateCDU(sim)

// D2 — src/input/input.js     : export function initInput(sim, rootEl), stepInput(sim, dt)
// D2 — src/systems/aircraftSystems.js : export function initSystems(sim, { coldDark = false }), stepSystems(sim, dt)
// D2 — src/systems/alerts.js  : export function stepAlerts(sim, dt)   // EICAS messages, master caution/warning, GPWS logic, aural queue
// D2 — src/audio/audio.js     : export function initAudio(sim), resumeAudio(), stepAudio(sim, dt)
// D2 — src/cockpit/overhead.js: export function initOverhead(sim, el), updateOverhead(sim)
// D2 — src/cockpit/pedestal.js: export function initPedestal(sim, el), updatePedestal(sim)

// C — src/avionics/displays.js
export function initDisplays(sim, { pfdEl, ndEl, eicasEl, lowerEl, isfdEl, efisEl })
export function updateDisplays(sim, dt)    // throttles itself to ~30 Hz

// B — src/world/globe.js
export async function initGlobe(sim, containerEl, { googleKey, ionToken, quality })  // returns {viewer}
export function updateGlobe(sim, dt)       // aircraft model pose, camera, sample ground height -> sim.env.groundH
export async function spawnAt(sim, airport, runway)  // resolves terrain height, sets env.geoidN, calls initAircraft
// B — src/world/airports.js   : export const AIRPORTS = [...]; export function findAirport(icao)
```

### Airport / runway object (B owns data, everyone reads)
```js
{ icao:'EDDF', name:'Frankfurt am Main', elevFt: 364, magVarDeg: 3 /*E+*/,
  runways:[{ id:'25C', lat, lon /*threshold, DEG*/, hdgDeg /*true*/, lengthM, widthM, ils:{freq:110.10, ident:'IFC', gsDeg:3}, endLat, endLon }] }
```
Lat/lon in airport data are DEGREES; convert with `DEG` when filling sim state (`fmc.route` uses radians).

## Main loop (B implements in src/main.js, in this order)
```
per animation frame (dtFrame clamp ≤ 0.1 s, × simRate, skipped if paused):
  stepInput(sim, dt)                       // keyboard/gamepad -> sim.controls, view keys -> sim.view
  stepNav(sim, dt); stepFMC(sim, dt); stepAFDS(sim, dt)
  accumulator: while (acc >= 1/120) stepPhysics(sim, 1/120)   // physics consumes controls + ap.out + ap.thrustCmd
  stepSystems(sim, dt); stepAlerts(sim, dt); stepAudio(sim, dt)
  updateGlobe(sim, dt)                     // after physics: camera/model/ground height
  updateDisplays(sim, dt); updateMCP(sim); updateCDU(sim); updateOverhead(sim); updatePedestal(sim); updateHud(sim)
```

### How controls combine (A implements in fbw.js)
- Effective column/wheel/pedal = `ap.out.*` when `ap.out.active` and pilot input |x| < 0.3; a pilot input > 0.3
  on column/wheel while AP engaged = disconnect (A sets `sim.controls.apDisc = true`; D1 handles it).
- Thrust lever: if `ap.thrustCmd !== null` A/T owns the levers: **D2's input** must move `controls.throttle[i]` toward
  thrustCmd at ≤ 0.25/s (backdrive) unless the pilot is actively moving them this frame (pilot input wins for that frame; A/T stays engaged).
  Physics always reads `controls.throttle` only.
- 777 C*U pitch law: column commands C* (blend of pitch rate & nz) relative to trim reference speed; auto pitch trim in NORMAL;
  roll: wheel commands roll rate-ish/surface with bank protection > 35°. Trim switch changes trim reference speed (NORMAL mode).

## DOM layout (B creates in index.html; others only render inside their element)
```
#app
  #world                 Cesium container (fills screen)
  #cockpit               overlay shown when view.mode==='cockpit' && view.panel
    #glareshield
      #efis-l            (C) EFIS control panel
      #mcp               (D1) Mode Control Panel
    #main-panel
      #pfd               (C) captain PFD  — square, renders canvas inside
      #nd                (C) captain ND   — square
      #eicas             (C) upper EICAS  — square
      #isfd              (C) standby (small)
    #drawer-dock         buttons to toggle drawers (B)
  #drawer-overhead       (D2) overhead panel (slide-in)
  #drawer-pedestal       (D2) pedestal: thrust levers, flaps, gear, speedbrake, autobrake, park brake, fuel ctrl
  #drawer-cdu            (D1) CDU
  #drawer-lower          (C) lower EICAS / synoptics (ENG, FUEL, ELEC, HYD, FCTL, GEAR, DOORS)
  #hud                   (B) minimal external-view readouts
  #menu                  (B) start / pause menu
  #toast                 (B) transient messages: listen sim.events 'toast' {text}
```
Each element is a sized box; your module must fill it responsively (use ResizeObserver; canvases at devicePixelRatio).
Avionics canvases must be crisp and keep square aspect (letterbox inside the box).

## Styling
`styles/base.css` holds design tokens (provided). Use only those variables for colors/fonts. Cockpit look:
Boeing "cockpit grey" panels, white backlit legends, real display color conventions (green active, white armed,
magenta targets, cyan selected/pre-select, amber caution, red warning). Fonts: displays use the tokens `--font-avionics`;
panel legends `--font-legend`.
Each team creates only its own CSS file(s) listed above; `index.html` links all of them.

## Key bindings (D2 implements all in input.js; no other module adds global key handlers)
| Key | Action |
|---|---|
| Arrow ↑/↓ or mouse-yoke | pitch (↓ = pull/nose up, like a yoke) |
| Arrow ←/→ | roll |
| Z / X  | rudder left / right; Q/E also tiller when on ground (Z/X steer nosewheel too below 30 kt) |
| PageUp / PageDown or F3/F2 , also `+`/`-` on numpad and `Shift+↑/↓` | throttle up / down; F1 idle; F4 full |
| F2 hold at idle | reverse thrust (R key also toggles reverse) |
| F7 / F6  (also `]` / `[`) | flaps down / up one detent |
| G | gear lever toggle |
| / | speedbrake toggle (ARMED->UP->DOWN cycle: Shift+/ arms) |
| . (period) or B | both brakes (hold) |
| Shift+. or P | parking brake toggle |
| Home / End (also 1/7 numpad) | pitch trim nose down / up |
| A | AP engage/disengage (MCP A/P / disconnect) ; Shift+A A/T arm/disconnect |
| T | TO/GA |
| C | cycle view: cockpit -> chase -> flyby -> tower |
| V | toggle panel overlay in cockpit view |
| Mouse drag on #world (right button) / Numpad | look around |
| 1 / 2 / 3 / 4 | open drawer: overhead / pedestal / CDU / lower EICAS (toggle) |
| Space or Esc | pause / menu (Esc), Space pause |
| `=` | sim rate cycle 1x/2x/4x |
| Gamepad | left stick pitch/roll, triggers rudder, right stick Y throttle, buttons: A brakes, B gear, X flaps up, Y flaps down, LB AP disc |

## Events (sim.events)
- `'toast'` `{text}` — show a short message.
- `'spawned'` `{airport, runway}` — after spawn (FMC builds default route, systems set before-takeoff state).
- `'view'` `{mode}` — view changed.
- `'aural'` `{id}` — request an aural (D2 audio plays): ids `'ap_disc','master_warning','master_caution','stall','overspeed','config','minimums','approaching_minimums','ra2500','ra1000','ra500','ra100','ra50','ra40','ra30','ra20','ra10','pull_up','terrain','sink_rate','glideslope','bank_angle','too_low_gear','too_low_flaps','v1','rotate','positive_rate','at_disc','gear_horn'`.

## Definition of done for every team
1. Module(s) implement the API above and import only from `core/*` and their own files (plus `physics/atmosphere.js` which anyone may import).
2. Node test (where listed) passes: `node tests/<file>.test.mjs` exits 0.
3. UI modules: a standalone harness `tests/<team>-harness.html` that imports `createSimState` + your module and animates fake data,
   screenshot-verified with Playwright (Chromium at `/opt/pw-browsers`, launch with `executablePath` found under that dir,
   serve the folder with `npx http-server` or `python3 -m http.server`). Put screenshots in `tests/shots/`.
4. Write a short `docs/<team>.md` (what's implemented, limitations).
