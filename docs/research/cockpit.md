# Boeing 777 Flight Deck – Simulation Reference

Sources: web search turned up only partial secondary material (Smartcockpit 777 auto-flight quiz, FlightGear 757/767/777 AP wiki,
Aerofly Boeing AP tutorial, flaps2approach autobrake notes, Asiana 214 / HOLD-mode discussions). The rest comes from
general knowledge of the 777 FCOM. Items marked (≈) are approximate or vary by customer option.

## 0. Layout overview (Captain left, F/O right)
- **Glareshield**: MASTER WARNING (red) / MASTER CAUTION (amber) lights at each outboard end. **EFIS control panel** at left (Capt)
  and right (F/O). **MCP** in the centre.
- **Main panel**: 6 identical LCDs (8x8 in). From left: Capt PFD (outboard), Capt ND (inboard), **upper EICAS** (centre top),
  F/O ND, F/O PFD. **Lower centre display** (MFD): synoptics, checklists and CDU repeats. Standby instruments (ISFD, attitude/speed/alt)
  sit left of the upper EICAS. **Landing gear lever** is right of the upper EICAS. Autobrake selector and ALTN FLAPS are below or beside it.
- **Display select panel** (between EICAS and the lower display) has buttons ENG, STAT, ELEC, HYD, FUEL, AIR, DOOR, GEAR, FCTL, CAM,
  CHKL, COMM, NAV, CANC/RCL.
- **Pedestal (forward)**: L and R CDU, speedbrake (left), thrust levers (centre), flap lever (right), fuel control switches (below the
  thrust levers), parking brake (left), STAB cutout switches. **Aft pedestal**: C CDU, radios (VHF/HF), audio control panels, transponder,
  weather radar, fire handles (on the centre forward panel just above, ≈), rudder/aileron trim.

## 1. PFD
**Arrangement** (left to right): speed tape | attitude indicator | altitude tape | vertical speed scale. FMA strip across the top.
Heading/track arc (partial compass rose) along the bottom.

### Colors
| Color | Use |
|---|---|
| White | Scales, current values, armed FMA modes (small, below active), pointers, reference marks |
| Green | Active FMA modes, AFDS status, V-speed and flap-maneuver labels, baro setting, minimums, speed trend vector, thrust ref mode (EICAS) |
| Magenta | Pilot-selected or commanded targets: selected speed / alt / heading / V/S bugs, FD bars, ILS deviation pointers, active route (ND) |
| Cyan | Inactive/preselected data: preselected baro, inactive route, navaids/airports on ND, sky (blue) on ADI |
| Amber | Cautions and limits: min-maneuver band, out-of-tolerance, NO AUTOLAND, FAIL flags, pitch limit indicator, bank pointer >35° |
| Red | Warnings: barber poles (with black), PULL UP, WINDSHEAR, RA traffic |
| Brown/blue | Ground (brown) and sky (blue) on the ADI |

### Attitude indicator (centre)
- Blue/brown horizon. Pitch ladder every 2.5° (labelled every 10°). Bank scale arc at the top with ticks at 10, 20, 30, 45 and 60°.
  The bank pointer and slip/skid trapezoid are white; the pointer turns amber above 35° bank.
- Aircraft symbol: two white-outlined black L-shaped wings and a centre square.
- **FD bars** (magenta): a pitch bar and a roll bar (crosshair). The flight path vector (FPV) is optional (white circle with wings).
- **Pitch limit indicator** (amber "eyebrow"): shown with flaps extended or at low speed.
- **ILS**: localizer deviation scale (two white dots each side) below the ADI, glideslope scale to the right of the ADI. Both pointers are
  magenta diamonds. The pointer is hollow when off scale. The scale expands (rectangle) once LOC is captured and small. The ILS ident,
  frequency, course and DME are shown top-left of the ADI in white (green when tuned? ≈). Marker beacon icons are on the upper right of
  the ADI (OM cyan, MM amber, IM white).
- **Radio altitude**: digital readout centred below the ADI (above the heading arc), white, shown below 2500 ft RA. It turns amber and
  flashes when below RADIO minimums. A rising-runway symbol is shown on LOC (≈).
- **Minimums**: "BARO" or "RADIO" label plus value in green, lower right of the ADI. At minimums the label and value turn amber and flash
  for 3 s.
- **AFDS status** (centred just above the ADI, below the FMA): **FLT DIR** / **A/P** / **LAND 2** / **LAND 3** in green. **NO AUTOLAND**
  is amber. **A/P** in red ≈ means autopilot disengaged (with the wailer).

### FMA (top strip, 3 columns, left to right)
| A/T (autothrottle) | Roll | Pitch |
|---|---|---|
| THR REF, THR, SPD, IDLE, HOLD | TO/GA, LNAV, HDG SEL, HDG HOLD, TRK SEL, TRK HOLD, LOC, B/CRS, FAC, ATT, ROLLOUT | TO/GA, ALT, V/S, FPA, VNAV PTH, VNAV SPD, VNAV ALT, FLCH SPD, G/S, G/P, FLARE |

- Active modes are large green text. Armed modes are smaller white text on a second line (e.g. LNAV / VNAV, LOC / G/S, ROLLOUT / FLARE).
- A **green box** is drawn around a newly engaged mode for 10 s.
- A/T modes:
  - **THR REF**: thrust to the EICAS reference limit.
  - **THR**: thrust for a climb or descent rate (FLCH/VNAV).
  - **SPD**: speed on thrust.
  - **IDLE**: levers to idle.
  - **HOLD**: servos off and levers stay put. Entered on the takeoff roll at 80 kt and in FLCH/VNAV descent once idle is reached.

### Speed tape (left)
- Grey tape with ticks every 10 kt, labels every 20 kt. Current IAS is in a white-bordered black rolling box at the centre.
- **Selected speed**: magenta value above the tape plus a magenta bug on the tape. The value is replaced by Mach when Mach is selected.
- **Speed trend vector**: green arrow from the index showing the speed predicted in 10 s.
- **Max speed** (Vmo/Mmo, gear or flap placard): red/black barber pole from the top. **Max maneuver** speed: amber hollow bar under it.
- **Min maneuver** speed: amber hollow bar at the bottom. **Min speed** (stick-shaker): red/black barber pole from the bottom.
- **Flap maneuver speeds**: green labels "UP", "1", "5", "15", "20" at the corresponding speeds (shown for the next retraction or
  extension setting).
- **Takeoff bugs** (green): "V1" and "VR" on the tape. V2 is the magenta selected-speed bug. "80" knot marker (≈ only on some
  variants). If V-speeds are not entered: amber **NO V SPD**. Off-scale V1 is shown digitally at the top of the tape.
- **Approach**: green "REF" at VREF, plus "20"/"15" flap-maneuver bugs. Off-scale REF is shown digitally at the bottom.
- **Below the tape**: Mach readout (≥ M .40) in white, e.g. ".840". Ground speed "GS 15" is shown at low Mach.

### Altitude tape (right)
- Ticks every 100 ft, labels every 200 ft, and a rolling digital box (thousands are larger digits). A negative sign is shown for
  negative values.
- **Selected altitude**: magenta value above the tape plus a magenta bug.
  - It gets a white box when approaching (within 900 ft, ≈).
  - It gets an amber box with a caution beeper when you deviate more than 200 ft after capture.
- **Baro setting** below the tape in green, e.g. "29.92 IN" or "1013 HPA". Selecting **STD** shows green "STD". A preselected QNH under
  STD is shown in small white text.
- **Landing altitude**: white bar ≈, with an amber crosshatch band near the ground.
- **Minimums**: green pointer on the tape at the baro minimums altitude.
- Meter readout (optional) in white above the tape.

### Vertical speed indicator (far right)
- Non-linear scale with marks at ±500, 1000, 2000 and 6000 fpm. A white pointer runs from a fixed pivot.
- A digital readout (white) is shown above the scale (climb) or below it (descent) when |V/S| > 400 fpm.
- Selected V/S: a magenta bug in V/S mode.

### Heading/track (bottom)
- Partial compass rose (about 60° visible) in white, with a heading pointer triangle at the top.
- A white track line or diamond. Selected heading: magenta bug, with the value in magenta on the left ("230 H" ≈).
- Labels "MAG"/"TRU" and "HDG"/"TRK" in green next to the rose.

## 2. ND (Navigation Display)
- **Modes** (EFIS selector): APP, VOR, MAP, PLN. Each mode except PLN has a CTR (centred) option. Expanded MAP = a 90° arc with the
  aircraft symbol near the bottom. PLN is north-up and centred on the selected LEGS waypoint (STEP from the CDU).
- **Compass arc**: white with 5° ticks and labels every 30°. A box at the top shows "HDG 235 M" / "TRK 233 M" in green, with the value
  white in a box. Heading pointer: white triangle at the top. Selected-heading bug: magenta, with a dashed magenta line.
- **Aircraft symbol**: white triangle at the bottom centre (or the centre in CTR mode).
- **Range rings**: white dashed half-range arc with the range label. Ranges are 0.5, 1, 2, 5, 10, 20, 40, 80, 160, 320 and 640 NM.
- **Track line**: white line from the aircraft to the arc with range ticks.
- **Curved trend vector**: white (≈) segmented curve predicting the path at 30, 60 and 90 s (shown for ranges below 20 NM; ≈).
- **Route**: active route is a **magenta** solid line, the modified (pending EXEC) route is **white dashed**, and an inactive route is
  **cyan** dashed.
- **Waypoints**: active waypoint is a magenta star with a magenta name. Other route waypoints are white stars with white names.
  Off-route waypoints are cyan when DATA/WPT is selected. Airports are cyan circles. VOR/DME symbols are cyan (green when tuned).
  Altitude constraints (white) are shown under the waypoint when DATA is selected. T/C and T/D are shown as a green circle labelled
  "T/C"/"T/D". Deceleration point and step climb points are also shown.
- **Altitude range arc**: green arc where the selected altitude will be reached.
- **Top-left**: "GS 482 TAS 495" (white), with the wind below: "275°/45" plus a white wind arrow (relative direction).
- **Top-right**: active waypoint name (magenta), ETA (white "1432.5z"), and distance to go ("62.0 NM").
- **Bottom corners**: VOR L / VOR R (or ADF) idents and DME, green for VOR and cyan for ADF.
- **TCAS**: Resolution Advisory = **red** filled square. Traffic Advisory = **amber** filled circle. Proximate = **white filled
  diamond**. Other traffic = **white hollow diamond**. A data tag shows relative altitude in hundreds of feet (+05, -12; above or below
  the symbol) with an arrow for climbing or descending traffic above 500 fpm. Banners "TRAFFIC" (amber/red) and "TA ONLY".
- **Terrain (EGPWS, TERR)**: dot-density patterns. Green = terrain from 2000 ft below to 500 ft below the aircraft. Amber = 500 ft below
  to 2000 ft above. Red = more than 2000 ft above. Solid amber/red = look-ahead caution/warning areas. Magenta = no data. Label "TERR"
  in cyan.
- **Weather radar (WXR)**: green/amber/red/magenta returns. Gain and tilt are shown in cyan/green.

## 3. EICAS
### Upper EICAS (centre)
- **Top-left**: thrust ref mode in green plus the limit value, e.g. "TO 1  98.6", "CLB", "CRZ", "CON", "GA", "D-TO", "A-TO", "CLB 2".
  **TAT** e.g. "TAT +15c" is above or beside it.
- **Primary engine gauges** (L and R side by side, as round dial arcs with digital boxes):
  1. **N1** for GE90, or **EPR** for PW4000/Trent with N1 below. White arc and needle with a red redline. **Reference/target thrust**:
     green line marker and green value. **Commanded thrust**: white arc segment. Max: amber line.
  2. **EGT**: same dial style, with an amber band (max continuous) and red redline. The box turns amber or red when exceeded.
- Secondary engine data (N2, N3 (RR), FF, oil pressure/temperature/quantity, vibration) are shown on the lower display ENG page, or in
  compact form. Fuel flow is shown in units ×1000 kg/hr or lb/hr.
- **Right side**:
  - **Alert message stack** (newest at the top, priority order). **Warnings** are red. **Cautions** are amber. **Advisories** are amber
    and indented one space. **Memos** are white, at the bottom of the stack (e.g. "PARKING BRAKE SET", "SEATBELTS ON", "AUTOBRAKE 3",
    "SPEEDBRAKE ARMED", "APU RUNNING").
  - Status cue: white "STATUS" ≈. Page number "PG 2" when the list overflows.
- **Gear indicator** (right of the engines): "DOWN" in green, three boxes or text. "UP" in white, then the indication blanks after 10 s
  ≈. Amber cross-hatch boxes show gear in transit or disagreement.
- **Flap indicator**: a vertical white-outlined tape with detent marks. The flap position bar is white or magenta ≈. The commanded
  position is a magenta line plus the green detent number (e.g. "20") when in transit. Flaps fully up = blank after 10 s. Text is
  "FLAPS" (amber if disagreeing). ALTN mode shows a split L/R display.
- **Fuel**: "TOTAL FUEL 82.4 KGS X 1000" in white, plus "FUEL TEMP -12c" (amber when low). Fuel-to-remain ≈.
- Glareshield: MASTER WARNING (red) is triggered by warnings (siren/bell). MASTER CAUTION (amber) is triggered by cautions (beeper).
  Push either light to reset. Advisories have no aural and no light.

### Lower EICAS synoptics (MFD, selected with the display select panel)
- **ENG**: secondary engine data (N2, FF, oil, vibration).
- **STAT**: status messages and system data (hydraulic quantities, APU EGT/RPM, oxygen pressure).
- **ELEC**: IDGs, APU gen, backup gens, bus ties, AC/DC buses, battery.
- **HYD**: L/C/R systems, pumps, quantities and flow lines.
- **FUEL**: tanks L/CTR/R, pumps, crossfeed valves, jettison.
- **AIR**: packs, bleeds, trim air, pressurization.
- **DOOR**: entry, cargo and access doors.
- **GEAR**: tire pressure, brake temperature, gear doors.
- **FCTL**: surface positions, trims and PFC mode.
- **CHKL**: electronic checklist (normal/non-normal).
- **CAM** (cameras, 777-300ER), **COMM** (datalink), **NAV** (on some variants).

## 4. MCP (glareshield), left to right
1. **F/D** switch (L), ON/OFF toggle. Has a bar that rises when ON (≈ on the outboard edge).
2. **A/P** engage button (L). Any one engages all channels; a green bar lights in the button.
3. **A/T ARM** switches L and R (toggles, ARM/OFF), one per engine.
4. **CLB/CON** button: selects CLB thrust in flight, or CON (max continuous) with an engine out or above 2000 ft ≈ once flaps are up.
5. **A/T** button: engages the A/T in the mode for the current pitch mode (SPD or THR).
6. **IAS/MACH** selector switch, then the **speed window** (blanks when the FMC controls speed in VNAV). The **speed knob** is pushable
   for speed intervention in VNAV.
7. **LNAV**, 8. **VNAV**, 9. **FLCH** buttons (lights on top when armed or active).
10. **A/P DISENGAGE bar**: pull it down to disengage and lock out the A/P, which stops the AP from engaging.
11. **HDG/TRK** reference switch, then the **heading/track window**. The **HDG/TRK selector knob** has an outer **BANK LIMIT** ring:
    AUTO, 5, 10, 15, 20, 25°. Push the inner knob for **HDG/TRK SEL**. A separate **HOLD** button gives **HDG/TRK HOLD**.
12. **V/S/FPA** reference switch, then the **V/S window** (blank until the mode is engaged), the **V/S thumbwheel**, and the **V/S/FPA**
    mode button.
13. **ALT window**, then the **altitude selector**: a rotary knob with an AUTO (100 ft) / 1000 ft increment ring. Pushing it does a VNAV
    altitude intervention (deletes a constraint, or starts a climb/descent in cruise). **HOLD** button = ALT hold.
14. **LOC** button, 15. **APP** button (arms LOC + G/S).
16. **A/P** engage (R), 17. **F/D** switch (R).

### Mode behaviour
- **Speed-on-thrust**: SPD (A/T) holds the MCP or FMC speed. Used in ALT, V/S, FPA, G/S, VNAV PTH, and LNAV/HDG level flight.
- **Speed-on-elevator**: FLCH SPD and VNAV SPD. Pitch holds speed while the A/T sets THR (climb thrust limit or idle). In descent it then
  goes to HOLD. In FLCH, the A/T uses a thrust rate that gives about a 1000 fpm/min change scaled to altitude ≈.
- **ALT capture**: from V/S/FLCH/VNAV, the pitch mode transitions to ALT when approaching the selected altitude (FMA "ALT", with an
  asymptotic capture and no separate ALT* annunciation on the 777). In VNAV it becomes "VNAV ALT" (MCP-limited) or "VNAV PTH" (FMC
  cruise altitude/constraint).
- **VNAV PTH**: follows the FMC vertical path. The A/T is in SPD (cruise/level) or IDLE→HOLD (descent).
  **VNAV SPD**: pitch holds the FMC target speed with THR REF (climb) or IDLE/HOLD (descent). Speed windows close.
- **V/S / FPA**: holds the selected V/S (±8000 fpm) or FPA. The A/T holds speed.
- **TO/GA**: on the ground, A/T ARM + F/D ON, then press a TO/GA switch.
  - FMA: THR REF | TO/GA | TO/GA. The A/T goes to HOLD at 80 kt.
  - Pitch target is V2+15 ≈ (V2 to V2+25) or the current speed if higher. LNAV/VNAV can be armed (white) and engage at 50 ft / 400 ft.
  - Go-around: TOGA in flight (flaps out or G/S captured) gives THR | TO/GA | TO/GA. Press again for full GA thrust (THR REF).
- **LOC/APP**: LOC arms, then captures (green). G/S captures after LOC. Two or more A/Ps engage with APP armed. At 1500 ft RA: LAND 3
  (3 autopilot channels) or LAND 2 (degraded) annunciates, and FLARE + ROLLOUT arm (white).
  - ≈ 50 ft RA: **FLARE** activates.
  - ≈ 25 ft: the A/T goes to **IDLE**.
  - At touchdown: **ROLLOUT** steers on the LOC with the rudder/nosewheel.
  - **NO AUTOLAND** (amber) means autoland is not available.
  - A/P disconnects manually after the stop.
- **A/P disconnect**: via the yoke button (red, outboard handle), the DISENGAGE bar, or overpowering the column (CWS-like force). This
  produces the red "A/P" text and the wailer until it is reset by pressing the button again.
- **A/T disconnect**: via the thrust lever buttons (outboard side of the levers). This produces an amber AUTOTHROTTLE DISC caution
  (≈ when not commanded) and a beeper.

## 5. EFIS control panel (one per pilot, glareshield outboard)
- **MINS** selector (outer ring RADIO/BARO, inner knob sets the value, push = RST). **BARO** knob (outer IN/HPA, push = **STD**,
  inner sets the value).
- **FPV** and **MTRS** buttons. **VOR/ADF L and R** switches (VOR/OFF/ADF) for the ND bearing pointers.
- **ND mode selector**: APP/VOR/MAP/PLN. The centre push button is **CTR**.
- **Range selector**: 10–640 NM ≈ (0.5–5 in CTR via TFC ≈). The centre push button is **TFC** (traffic).
- **Map overlay buttons**: WXR, STA (navaids), WPT, ARPT, DATA, POS, TERR.

## 6. Overhead & pedestal
### Overhead (forward overhead panel, top to bottom, typical)
- **ADIRU** switch; **flight controls** (thrust asymmetry compensation / PRIMARY FLIGHT COMPUTERS DISC).
- **Electrical**: BATTERY, APU GEN, EXT PWR PRIMARY/SECONDARY, BUS TIE L/R AUTO, GEN CTRL L/R, DRIVE disconnect L/R, BACKUP GEN.
- **APU selector**: OFF / ON / START (spring-loaded back to ON). APU fire handle on the cargo-fire panel ≈.
- **Hydraulics**: L ENG PRIMARY pump, C1/C2 ELEC primary pumps, R ENG PRIMARY pump, and DEMAND pumps L / C1 / C2 / R as
  AUTO/OFF/ON (C2 air-driven demand pumps on some variants). FAULT lights are amber.
- **Engine start**: L/R START/IGNITION selectors (pull to START, spring to NORM), AUTOSTART ON/OFF, CON ignition.
- **Fuel**: FWD/AFT pumps for L and R main tanks, L/R CTR pumps, CROSSFEED FWD/AFT, jettison (ARM + nozzles). The "PRESS"
  annunciation is amber.
- **Anti-ice**: WING AUTO/OFF/ON, ENGINE L/R AUTO/OFF/ON (ice detectors).
- **Air**: PACKS L/R AUTO, TRIM AIR, RECIRC FANS, ENG BLEED L/R, APU BLEED, ISLN valves, EQUIP COOLING, pressurization OUTFLOW VALVES.
- **Lights**: LANDING L / NOSE / R, RUNWAY TURNOFF L/R, TAXI, STROBE, BEACON, NAV, LOGO, WING, STORM, DOME. **Passenger signs**: NO
  SMOKING and SEATBELTS (AUTO/OFF/ON each). Window/probe heat (AUTO). EMER lights (guarded ARMED). Wipers.
### Pedestal
- **Thrust levers** (2): **TO/GA switches** on the forward/aft face of each lever (thumb), **A/T disconnect** buttons on the outboard
  side. **Reverse thrust levers** are piggy-back on the front of the levers and can be lifted only at idle. The A/T moves the levers
  (servo-driven).
- **Speedbrake lever** (left): DOWN → **ARMED** (auto-deploy at touchdown) → intermediate positions → **UP**. Auto-stows on throttle
  advance.
- **Flap lever** (right): detents **UP-1-5-15-20-25-30**, with **gates at 1 and 20** (lift to pass the go-around gate). The lever
  shape is a flap airfoil.
- **Fuel control switches** L/R: **RUN / CUTOFF** (pull to move). Fire indication lights in the switch (red).
- **Parking brake** lever (left of the thrust levers, pull), with a red PARKING BRAKE memo.
- **STAB cutout** switches L/R (NORM/CUTOUT, guarded); **ALTN PITCH TRIM** levers.
- Rudder trim knob and aileron trim switches on the aft pedestal.
- **Gear lever** (centre forward panel, right of the EICAS): UP / DOWN, with a LOCK OVERRIDE button and an "ALTN GEAR" switch.
- **Autobrake selector** (centre forward panel, rotary): **RTO – OFF – DISARM – 1 – 2 – 3 – 4 – MAX AUTO**.
  - RTO activates above 85 kt ≈ when the thrust levers close. It goes to OFF after takeoff.
  - Disarming (brake pedal, throttle advance, speedbrake stowed) sets DISARM and gives an AUTOBRAKE caution.
- **CDUs**: L and R on the forward pedestal, C (centre) aft.

## 7. CDU / FMC
- **Screen**: 14 lines × 24 chars. Line 1 = title (+ page "1/3"). Six label/data line pairs. Line 14 = **scratchpad**.
  - **6 line-select keys** each side (LSK 1L–6L, 1R–6R).
  - Boxes `□□□□` = mandatory entry. Dashes `----` = optional.
  - Large font = entered or confirmed data. Small font = computed/default data.
  - Page titles show ACT (active) or MOD (modified, pending EXEC). The text is mostly white, with highlighted lines in reverse video
    for MOD ≈.
- **Function keys**: INIT REF, RTE, DEP ARR, ALTN, VNAV, FIX, LEGS, HOLD, FMC COMM, PROG, MENU, NAV RAD, PREV PAGE, NEXT PAGE,
  **EXEC** (lit-bar annunciator above it).
- **Lights**: EXEC (white), DSPY, FAIL, MSG, OFST.
- **Keys**: alpha keyboard A–Z, numeric 0–9 and ".", "+/-", SP, DEL, "/", CLR.
- **Pages**:
  - **INIT REF** → IDENT → POS INIT (set IRS position with GPS/airport ref).
  - **RTE**: ORIGIN, DEST, RUNWAY, CO ROUTE, FLT NO, then airways (VIA/TO). ACTIVATE then EXEC.
  - **DEP ARR**: SIDs, runways, STARs, approaches, transitions.
  - **LEGS**: waypoint sequence with speed/altitude constraints. RTE DATA, STEP (PLN mode).
  - **PERF INIT**: GR WT (or ZFW), FUEL, RESERVES, COST INDEX, CRZ ALT, CRZ CG (≈), STEP SIZE, MIN FUEL TEMP.
  - **THRUST LIM**: SEL TEMP (assumed temp), TO / TO 1 / TO 2 derates, CLB / CLB 1 / CLB 2.
  - **TAKEOFF REF**: FLAPS (5/15/20), THRUST, CG → TRIM, V1/VR/V2 (select computed speeds), EO ACCEL HT, ACCEL HT, THR REDUCTION.
    PRE-FLT COMPLETE.
  - **VNAV**: CLB / CRZ / DES pages with target speeds, transition altitude and ECON/selected speed.
  - **PROGRESS**: previous / active / next waypoint, ETA, fuel, wind, crosstrack error, RTA.
  - **FIX**: draw radial or distance circles (green dashed) on the ND. **HOLD**: hold at a fix (inbound course, turn, leg time).
  - **APPROACH REF**: GROSS WT, flap/VREF options (25 / 30 VREF), LOC/ILS frequency.
- **Typical entries** (777-300ER, ≈):
  - GW 300 t, FUEL 80 t, COST INDEX 80, CRZ ALT FL350.
  - Flaps 15, V1 155 / VR 160 / V2 167.
  - VREF30 ~150 kt, approach speed VREF+5.

## 8. Aurals & alerts
- **A/P disconnect**: wailer (siren-like warble) and red "A/P" annunciation. Reset by pressing disconnect again.
- **A/T disconnect**: beeper plus the amber AUTOTHROTTLE DISC caution.
- **Master warning**: fire bell (fire) or siren (other warnings, e.g. configuration, cabin altitude, overspeed). **Master caution**:
  beeper (double chime).
- **Overspeed**: siren plus the red OVERSPEED warning on the 777. The "clacker" is a 737/747 sound, so it does not apply here ≈.
- **Stall**: stick shaker on both columns at the red barber pole. Above it, the "AIRSPEED LOW" caution with a beeper.
- **Takeoff configuration**: siren plus warnings "CONFIG FLAPS", "CONFIG SPOILERS", "CONFIG PARKING BRAKE", "CONFIG STABILIZER",
  "CONFIG RUDDER", "CONFIG DOORS" (thrust levers advanced on the ground). Gear: "CONFIG GEAR" (gear not down with flaps 25/30, or
  thrust at idle low ≈).
- **GPWS/EGPWS**:
  - "PULL UP", "TERRAIN TERRAIN", "SINK RATE", "DON'T SINK", "TOO LOW – GEAR", "TOO LOW – FLAPS", "TOO LOW – TERRAIN", "GLIDESLOPE"
    (soft/hard), "BANK ANGLE".
  - "CAUTION TERRAIN", "TERRAIN AHEAD, PULL UP", "WINDSHEAR WINDSHEAR WINDSHEAR" (siren). A red PULL UP / WINDSHEAR shows on the PFD.
- **Radio altitude callouts** (customer-selectable): "TWENTY FIVE HUNDRED" (or "RADIO ALTITUDE"), "ONE THOUSAND", "FIVE HUNDRED",
  "(APPROACHING MINIMUMS / PLUS HUNDRED)", "MINIMUMS", "ONE HUNDRED", "FIFTY", "FORTY", "THIRTY", "TWENTY", "TEN". The 777 has **no
  "RETARD"** callout (that is Airbus).
- **TCAS**: "TRAFFIC, TRAFFIC", "CLIMB, CLIMB", "DESCEND, DESCEND", "ADJUST VERTICAL SPEED, ADJUST", "MONITOR VERTICAL SPEED",
  "CLEAR OF CONFLICT".
- **Altitude alert**: beeper plus an amber box on deviation. **Chimes**: hi-lo chime for SELCAL / datalink.

## 9. Normal procedure flow (abridged)
1. **Cold & dark (optional)**:
   1. BATTERY ON, then EXT PWR or APU START (OFF→START→ON, ~1 min). APU GEN.
   2. ADIRU ON (≈ 7–10 min align).
   3. Hydraulic and fuel pumps OFF. Lights NAV ON.
2. **Preflight**:
   1. EMER LIGHTS ARMED. Packs AUTO. Seatbelt/no-smoking AUTO/ON.
   2. CDU: IDENT, POS INIT, RTE (+EXEC), DEP ARR, PERF INIT, THRUST LIM, TAKEOFF REF.
   3. MCP: F/D ON (both), A/T ARM L+R, initial altitude, V2 in the speed window, runway heading, LNAV/VNAV armed.
   4. EFIS: baro QNH, minimums, MAP 10 NM. Autobrake RTO. Trim set (green band). Flaps set.
3. **Engine start**:
   1. BEACON ON. Hydraulic demand pumps AUTO. Fuel pumps ON.
   2. START selector R (pull). Fuel control switch to RUN at max motoring (autostart handles ignition). N2 → idle. Repeat for L.
   3. APU OFF after the engine gens are on.
4. **Taxi**: TAXI lights, flaps set (e.g. 15), flight controls check, before-taxi checklist (CHKL on the lower display).
5. **Takeoff**:
   1. Runway: LANDING/STROBE lights ON, TCAS TA/RA, transponder ON.
   2. Advance levers to about 55% N1 / 1.1 EPR, then press **TO/GA**. FMA THR REF | TO/GA | TO/GA. HOLD at 80 kt.
   3. V1, rotate at VR to about 15°, follow the FD. Positive rate: gear UP.
   4. LNAV at 50 ft. VNAV at 400 ft (THR REF | LNAV | VNAV SPD).
   5. At thrust reduction altitude, the thrust ref goes to CLB. Accel altitude: retract flaps on the green labels (15→5→1→UP).
   6. A/P engage (above 200 ft). Autobrake goes to OFF. The gear lever stays UP (the 777 has no OFF position).
6. **Climb/cruise**:
   1. 10,000 ft: landing lights OFF. Transition altitude: baro STD.
   2. VNAV SPD (CLB), then VNAV PTH at cruise (CRZ thrust ref, A/T SPD). Monitor fuel/PROG, step climbs.
7. **Descent**:
   1. DES/approach brief, APPROACH REF VREF (flaps 30). Set baro minimums. Set autobrake 2–3.
   2. At T/D, VNAV PTH with A/T IDLE then HOLD. Speedbrake as needed. Set QNH at the transition level.
8. **Approach**:
   1. LOC/APP armed, both A/Ps ON (autoland). Flaps 1→5 (by 210 kt ≈) →15→20, G/S alive: gear DOWN, flaps 30, speedbrake ARMED,
      landing checklist.
   2. Speed VREF+5. LAND 3 at 1500 ft RA. Callouts 1000/500/minimums.
9. **Landing**:
   1. FLARE ≈50 ft, IDLE ≈25 ft, touchdown.
   2. Speedbrakes auto UP and autobrake. ROLLOUT. Reverse thrust (idle reverse by 60 kt, stowed by taxi speed).
   3. A/P disconnect. Exit the runway.
10. **After landing/shutdown**:
    1. Speedbrake DOWN, flaps UP, APU START, strobe/landing lights OFF, TCAS STBY.
    2. Parking brake SET, fuel control switches CUTOFF, BEACON OFF, seatbelts OFF, hydraulics OFF.
