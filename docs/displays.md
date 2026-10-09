# Team C: Displays

Files: `src/avionics/{gfx,pfd,nd,eicas,isfd,efisPanel,displays}.js`, `styles/displays.css`,
`tests/displays-harness.html`. Screenshots are in `tests/shots/`.

## API
```js
initDisplays(sim, { pfdEl, ndEl, eicasEl, lowerEl, isfdEl, efisEl })  // any element may be omitted
updateDisplays(sim, dt)   // call every frame; it redraws at ~30 Hz on wall-clock time and skips hidden hosts
```
Each display is a canvas that stays square and letterboxed inside its host element. A `ResizeObserver` keeps it sized, and it draws at `devicePixelRatio`. All drawing uses a 1000×1000 virtual coordinate space (`gfx.createDisplay`). Colours and fonts come from the `base.css` tokens. Everything is redrawn once `document.fonts` reports that B612 is ready.

## What is implemented
- **PFD**: blue/brown ADI. Pitch ladder in 2.5° steps. Fixed roll scale with a moving pointer that turns amber above 35°, plus slip/skid. Aircraft symbol and magenta FD bars (when `ap.fd.valid && ap.fdL`). FPV (`efis.fpv`), and the amber pitch limit indicator when flaps are out.
  - FMA: A/T | roll | pitch. Active modes are green, armed modes white below them. A green box marks a changed mode for 10 s. The AFDS status (`ap.modes.ap`, otherwise `A/P` / `FLT DIR`) shows a red flashing `A/P` for 6 s after the autopilot disengages.
  - Speed tape: rolling-drum readout, magenta selected speed (shown as Mach when `sel.useMach`) and its bug, 10 s green trend vector. Red/black barber poles for Vmax (Vmo 330 / Mmo .89 / flap placards / VLE 270) and the stick shaker. Amber min/max manoeuvre bands. Green flap manoeuvre bugs (VREF30 + 80/60/40/20/10). V1/VR/+15 until 1500 ft RA, REF afterwards. Mach readout at M ≥ .40, otherwise GS.
  - Altitude tape: Boeing-style readout with large thousands digits, a 20 ft drum and a green crosshatch below 10 000 ft. Magenta selected altitude, with a white box when approaching and an amber box when deviating. Landing-altitude amber/white bars and a hatched ground band. Baro minimums pointer, baro setting in hPa/IN/STD with the preselect value. Metres readouts (`efis.mtrs`).
  - V/S: non-linear scale (1/2/6) with a pivoting pointer, a digital readout when |V/S| > 400 fpm, and a magenta V/S bug in V/S mode.
  - Heading arc, track line, magenta selected heading bug and readout, HDG/TRK and MAG labels.
  - ILS: ident/freq, course and DME. LOC and G/S scales with magenta diamonds (hollow when off scale).
  - RA readout below 2500 ft.
  - Minimums: BARO or RADIO value in green. It turns amber and flashes for 3 s when the aircraft descends through minimums. The EFIS MINS RST push resets it.
  - Red PULL UP / WINDSHEAR banner, driven by `alerts.pfd` / `alerts.gpws` / `alerts.pullUp` / `alerts.windshear`.
- `stallSpeedKt(mass, flapsDeg)` (exported from `pfd.js`) is the only place the 1-g stall speed is computed. It uses Vs1g = √(2mg/(ρ0·S·CLmax)), with S = 436.8 m² and CLmax interpolated between the flap detents.
- **ND**:
  - MAP mode is track-up. APP and VOR modes are heading-up. All three can be drawn as an expanded arc or centred (`efis.ctr`). PLN is north-up, centred on the active waypoint.
  - Compass rose (magnetic), heading pointer, magenta heading bug with a dashed line in HDG/TRK SEL, and a track line with a range mark. Range arcs with their labels.
  - Magenta active route, waypoint stars (active one magenta), and altitude constraints when DATA is on. T/D marker from `fmc.todNm`.
  - Airports from `fmc.origin` / `fmc.dest`: runway outlines at 40 NM range or less, otherwise cyan circles.
  - Curved trend vector based on the turn rate, green altitude range arc, and a TCAS 3 NM ring.
  - Flat-terrain colouring (`efis.terr`), worked out from `env.groundH`.
  - Header: GS/TAS, wind readout and arrow, and the active waypoint with ETA and distance. APP/VOR modes show the ILS course pointer and deviation bar, plus the G/S scale in APP.
- **Upper EICAS**:
  - N1 and EGT dials with red and amber limits. N1 also has a green reference marker and a white commanded-thrust arc driven by the levers.
  - N2/FF boxes, TAT, and the thrust reference mode with its N1 value (`thrustRef()`: TO/CLB/CRZ/CON/GA, a simple phase model).
  - Alert stack, sorted by level: warning red, caution amber, advisory amber and indented, memo white.
  - Gear indicator: DOWN green, UP white, crosshatch in transit; it blanks 10 s after the gear is up.
  - Flap tape with a magenta command line and green detent number; it blanks 10 s after the flaps are up.
  - Total fuel and fuel temperature.
- **Lower EICAS** (`#drawer-lower`): ENG/FUEL/ELEC/HYD/FCTL/GEAR/DOOR buttons with a square synoptic display. The selected page is stored in `sim.efis.lowerPage`.
- **ISFD**: attitude, speed and altitude tapes, baro and Mach.
- **EFIS panel**: CSS knobs. Click the left or right half of a knob, or use the wheel, to turn it; click the centre to push it; click a label around the knob to select that position.
  - MINS: RADIO/BARO, value, RST.
  - BARO: IN/HPA, value, STD.
  - MODE: APP/VOR/MAP/PLN, CTR.
  - RANGE: 10–640, TFC.
  - Buttons: FPV, MTRS, WXR, STA, WPT, ARPT, DATA, POS, TERR.
  - The layout adapts to the shape of the host (container queries).
  - Added efis fields: `ctr, baroIn, data, pos, minsResetT, lowerPage`.

## Assumptions about other teams' state (all read defensively)
- `alerts.list` entries are `{ text, level: 'warning'|'caution'|'advisory'|'memo' }`. Plain strings are shown as cautions.
- `nav.ils.locDots > 0` means the aircraft is right of the localizer, so the diamond is drawn left. `gsDots > 0` means the aircraft is above the glideslope, so the diamond is drawn below.
- `systems.fuel.{pumps:{lFwd,lAft,cL,cR,rFwd,rAft}, xfeedFwd, xfeedAft, tempC, jettison}`.
- `systems.elec.{idgL,idgR,apuGen,extPwr,busL,busR,battV}`.
- `systems.hyd.{L,C,R}.{press,qty,pumps}`.
- `systems.gear.{brakeTemp[12],tirePsi[12]}`.
- `systems.doors['ENTRY 1L'…'FWD CARGO']` (boolean = open).
- `systems.air.tatC`, `systems.apu.running`, and optionally `engines[i].oilQty`.
- When a value is missing, the display shows a default derived from the engines running.
- Airport objects may carry `lat`/`lon` (degrees). Otherwise the first runway threshold is used.

## Limitations
- No navaid database: STA/WPT show only route waypoints, there are no VOR bearing pointers, and VOR mode uses the ILS data.
- WXR and POS have no data, so only their labels are shown.
- Terrain assumes the terrain under the aircraft is flat.
- The thrust reference N1 values and flap manoeuvre speeds are approximations.
