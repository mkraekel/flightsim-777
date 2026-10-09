# Team D2: Systems & Controls

Files: `src/input/input.js`, `src/systems/aircraftSystems.js`, `src/systems/alerts.js`, `src/audio/audio.js`,
`src/cockpit/overhead.js`, `src/cockpit/pedestal.js`, `styles/overhead.css`, `styles/pedestal.css`,
`tests/systems.test.mjs` (`node tests/systems.test.mjs`, 16 tests), `tests/controls-harness.html`
(the `?cold=1`, `?scene=warn|approach|reverse` variants), and screenshots in `tests/shots/d2-*.png`.

## Input (`initInput(sim, rootEl)`, `stepInput(sim, dt)`, `getBindingsHelp()`)
- Implements every key in CONTRACT.md. Keys are ignored while focus is in an input, textarea, select or contenteditable element, or anywhere inside `#drawer-cdu`. Ctrl/Meta browser shortcuts pass through.
- **Pitch and roll**: the axis ramps toward ±1 at 1.1/s, reverses at 3.5/s and recentres at 2.4/s. Rates run in real time, so they do not depend on the sim rate. Hold Ctrl for fine control (±0.35). **H** toggles hold mode (no auto-centre). **Y** toggles mouse-yoke mode, where the mouse position over `#world` is the column and wheel.
- **Rudder** is Z/X. **Tiller** is Q/E on the ground. The pedals also steer the nosewheel below 30 kt.
- **Throttle**: levers move at 0.4/s. F1/F4 glide the levers to idle/full. Hold F2 at idle for reverse. R toggles max reverse or stow, and only works on the ground with the levers at idle.
- **Flaps**: one detent per press. Key auto-repeat stops at the 1 and 20 gates.
- **Gear**: the lever is locked on the ground.
- **Speedbrake**: `/` gives UP or DOWN, `Shift+/` arms it.
- **Brakes**: `.` or `B`. `controls.pilotBrakeL/R` holds the pedal value and `brakeL/R` the value applied.
- **Trim**: the trim switch is Home/End (Num7/Num1).
- **Look**: right-drag on `#world`, or Num 4/6/8/2 (Num5 resets). The wheel changes `view.zoom`.
- **Drawers**: 1–4 toggle `.open` on the drawer and emit `'drawer'`. The other keys are C → `'view'`, V → `'view'`, Esc → `'menu'`, Space → `sim.paused` plus a `'pause'` event, and `=` → sim rate.
- **A/P and A/T keys**: A sets `controls.apDisc` when the AP is engaged or `discWarning` is set. Otherwise it calls `afdsAction('AP_ENGAGE')`. Shift+A sets `controls.atDisc` when the A/T is engaged or the AUTOTHROTTLE DISC warning is showing; otherwise it calls `AT_ARM`. The AFDS module is reached through a soft dynamic `import()`. If that import fails, an `'afds'` event is emitted instead.
- **Gamepad** (standard mapping): the left stick has a deadzone of 0.08 and an expo curve. The triggers are rudder. Right stick Y is the thrust rate. The buttons are A brakes, B gear, X/Y flaps, LB AP disc, and D-pad trim.
- **A/T backdrive**: when `ap.thrustCmd !== null`, the levers move toward it at ≤ 0.25/s of sim time. This does not happen in a frame where the pilot moved them. Pilot movement covers keys, gamepad, and the pedestal drag, which sets `controls.throttlePilot`.

## Systems (`initSystems(sim,{coldDark})`, `stepSystems(sim, dt)`)
- **`sim.systems.fuelOwned = true`** tells `fdm.js` that systems burns the fuel and completes engine starts.
- **Fuel**: engine `ff` (from physics) plus the APU (120 kg/h) are drawn from the feed tank.
  - The centre pumps (`cL`/`cR`) take priority over the mains.
  - With crossfeed open, both engines feed from the fuller main tank.
  - Suction feed works below FL250.
  - `fuel.burnedKg`, `totalKg`, `imbalanceKg`, `tempC`.
- **Engine start (autostart)**: the start selector is `controls.engStart[i]`, and the duct needs ≥ 20 psi.
  - `startState` goes to `'STARTING'` and physics motors the N2. With the fuel control at RUN, physics lights the engine.
  - Systems sets `'RUN'` once N2 reaches 50 % and releases the selector. CUTOFF, starvation or a pulled fire handle set `'OFF'`.
  - In flight, a windmilling engine relights. A start with no light-off aborts after 90 s.
- **Electrics**:
  - Switches: BATTERY, APU GEN (`elec.apuGenSw`), EXT PWR (available while parked in cold & dark), GEN CTRL, BUS TIE.
  - Outputs: `acBus[]`, `acPowered`, `dcPowered`, `sources`. Display aliases are `idgL/idgR/apuGen/extPwr/busL/busR/battV`.
- **APU**: OFF/ON/START (spring-back to ON). A start takes about 60 s, with N%, an EGT profile and a cooldown.
- **Bleed and packs**:
  - `air.ductPsi`/`ductSrc` come from the engines (N2 > 45 %) or the APU bleed.
  - The packs close while an engine is starting.
  - `air.tatC`/`satC`.
- **Hydraulics**: the L/C/R systems have EDP, ACMP and ADP pumps with AUTO demand logic. Outputs are `hyd.press.{L,C,R}` and `hyd.{L,C,R}.{press,qty,pumps}`.
- **Other systems**:
  - Pressurization: cabin schedule, 8.6 psi max differential, cabin climbs/leaks without packs.
  - Anti-ice: AUTO follows the optional `sim.env.icing` flag.
  - Lights: `systems.lights.*` (landingL/N/R, taxi, turnoffL/R, strobe, beacon, nav, logo, wing, storm, dome) and passenger signs.
  - ADIRU: alignment takes 240 s, shortened for playability.
  - Transponder: `xpdr.code/mode/ident`.
  - Also: fire handles, STAB cutout, brake temperatures and tyre pressures (12 each), and doors. The doors are open in cold & dark and close when the beacon goes ON.
- **Automation**:
  - Speedbrake: auto-deploy (lever to UP) on landing when ARMED with the levers at idle, or on an RTO with the reversers up; auto-stow when the thrust levers are advanced.
  - Autobrake: RTO → OFF after liftoff. When the physics reports `surfaces.autobrakeState === 'DISARMED'`, the selector goes to DISARM, which raises the AUTOBRAKE caution. Physics applies the autobrake pressure. A fallback controller exists if physics does not.
- `initSystems(coldDark:false)` sets up for takeoff: engines RUN, takeoff flaps (`fmc.toFlaps`), RTO, lights, parking brake set. `initSystems(coldDark:true)` leaves everything off, with fuel control CUTOFF and GPU available. Both are re-applied on `'spawned'`.

## Alerts (`stepAlerts`, `resetMaster(sim,'warning'|'caution'|'both')`, `acknowledgeATDisc`)
- **`sim.alerts.list`** holds `[{id,text,level,since}]`, with level `'warning'|'caution'|'advisory'|'memo'` (lowercase). It is sorted by level, newest first.
  - Warnings: CONFIG FLAPS/SPOILERS/PARKING BRAKE/STABILIZER/GEAR, OVERSPEED (Vmo 330/Mmo .89/flap placards/VLE 270), AUTOPILOT DISC (`ap.discWarning`), FIRE ENG L/R, CABIN ALTITUDE.
  - Cautions: AUTOTHROTTLE DISC (`ap.atDiscWarning`), ENG FAIL, SPEEDBRAKE EXTENDED, GEAR DISAGREE, FUEL QTY LOW, FUEL PRESS ENG, HYD PRESS SYS, ELEC AC BUS, AUTOBRAKE, AIRSPEED LOW, BATTERY OFF, NAV ADIRU INERTIAL.
  - Advisories, plus the memos PARKING BRAKE SET, SPEEDBRAKE ARMED, AUTOBRAKE n, APU RUNNING, SEATBELTS ON, and others.
- **Master lights**: `masterWarning`/`masterCaution` latch on a new item and are reset by clicking the master lights on the pedestal. Cautions are inhibited during takeoff.
- **EGPWS modes 1–6**: sink rate / pull up, terrain closure, don't sink, too low gear/flaps/terrain, glideslope, bank angle.
  - `alerts.gpws` is `'PULL UP'` or `null`, which drives the PFD banner. `alerts.pullUp` is a boolean, and `alerts.egpws` holds the detail.
  - The glideslope mode assumes `nav.ils.gsDots > 0` means the aircraft is below the path. That is D1's convention in navradio.js.
- **Callouts**: RA callouts at 2500/1000/500/100/50/40/30/20/10, plus APPROACHING MINIMUMS (+80 ft) and MINIMUMS from `efis.minimumsFt`. BARO minimums use the baro-corrected altitude and RADIO minimums use the RA. A numeric call that coincides with MINIMUMS is suppressed. V1 is called; rotate is optional (`alerts.options`).
- **Stick shaker**: AoA above 11°–14° depending on flaps. `alerts.limits = {vmaxKt, alphaWarnDeg}`.
- **Continuous sounds**: `alerts.aural = {siren, fireBell, wailer, shaker}`. One-shots go out as `'aural'` events with a `priority`.

## Audio (`initAudio`, `resumeAudio()` from a user gesture, `stepAudio`)
- Everything is WebAudio synthesis.
  - **Engines**: per engine, panned L/R, made of the GE90 fan blade-pass tone, a core whine, rumble/roar, and a buzz-saw above 85 % N1. In the cockpit they are low-passed and quieter.
  - **Wind**: scales with TAS.
  - **Runway**: rumble plus centre-line thumps, and a touchdown thump scaled by V/S.
  - **Systems**: hydraulic motor whine while the gear or flaps move, and an APU whine.
  - **Alerts**: siren, fire bell, A/P wailer, stick shaker, beeper and gear horn.
- Speech uses `speechSynthesis` with an en-US male voice when one is available, rate 1.05. It has a priority queue: stale callouts are dropped and higher priorities pre-empt lower ones.
- Volume is `sim.audioVolume`. A watchdog suspends the AudioContext when `stepAudio` stops being called, for example while paused.

## Overhead & pedestal
- **Overhead** (`#drawer-overhead`): ADIRU/flight controls, ELEC, HYD, APU + ENGINE START, FUEL (with quantities), ANTI-ICE + window/probe heat, AIR/BLEED (duct psi), PRESSURIZATION readouts, LIGHTS + PASS SIGNS + EMER lights.
  - Controls are Boeing push buttons (white OFF/ON/AVAIL, amber FAULT/PRESS/ISLN), rotary knobs (click the left or right half, or use the wheel) and bat-handle toggles.
  - Annunciators need DC power.
  - A status strip at the top is a sim aid and not part of the real panel.
- **Pedestal** (`#drawer-pedestal`):
  - Glareshield: MASTER WARNING/CAUTION, twice.
  - Levers, all dragged vertically:
    - Thrust: both levers move together, Ctrl moves one. Below IDLE is the reverse range, which only works on the ground. Each lever has TO/GA and A/T DISC switches.
    - Speedbrake: DOWN / ARMED / UP.
    - Flaps: detents with gates at 1 and 20. Clicking a label moves the lever one detent.
  - Gear lever and gear indication, AUTOBRAKE knob, STAB/flap/brake readouts.
  - Fuel control switches with fire lights, guarded STAB cutout, fire handles (click to pull, click again to discharge, right-click to stow), transponder, rudder trim.
- Updates are cheap: classes change only when a value changes, and nothing updates while the drawer lacks `.open`. The widget factory lives in overhead.js and uses the `ow-*` CSS classes.

## Limitations
- Electrics, hydraulics and bleed are logical models with no load or flow simulation, and there are no backup generators.
- Outflow valves are AUTO only. Anti-ice has no performance effect. Physics does not use the STAB cutout unless it reads `systems.stabCutout`.
- If systems sets `startState = 'OFF'` because of fuel starvation, the physics engine stays lit. Physics only flames out on CUTOFF, empty tanks or fire.
- Aurals are synthesized approximations, not recordings. Speech quality depends on the browser's voices.
