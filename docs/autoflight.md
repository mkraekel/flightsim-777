# Autoflight (Team D1)

Files: `src/systems/afds.js`, `fmc.js`, `navradio.js`, `src/cockpit/mcp.js`, `src/avionics/cdu.js`,
`styles/mcp.css`, `styles/cdu.css`, `tests/afds.test.mjs`, `tests/autoflight-harness.html`.

Run the tests with `node tests/afds.test.mjs` (64 checks, exits 0). For the harness, serve the project
folder (`python3 -m http.server`) and open `tests/autoflight-harness.html`. Screenshots are in
`tests/shots/mcp*.png` and `tests/shots/cdu-*.png`.

## AFDS (`afds.js`)

- **Outputs.** `ap.out {pitch, roll, yaw, active}` is a virtual column/wheel/pedal on the pilot scale
  (−1..1, clamped to ±0.6 for pitch and roll). `ap.thrustCmd` is a lever target from 0 to 1, or `null`
  in HOLD or when the A/T is off. `ap.fd {pitchDeg, rollDeg, valid, pitchValid, rollValid}` holds the
  absolute commanded attitude; the FD bar offset is the command minus the current attitude.
- **Structure.** Each pitch mode's outer loop produces a flight-path-angle command, and
  θc = γc + (θ−γ)filtered. Each roll mode produces a bank command. Both commands are rate-limited
  (2.5°/s for pitch, 3.5°/s for bank).
- **Inner loops.**
  - Pitch: the inner loop builds a pitch-rate demand and converts it to column through the C* relation
    (full column ≈ 1.5 g C*, Vco = 120 m/s), with a damping term and an anti-windup integrator.
  - Roll: the inner loop builds a roll-rate demand. Full wheel ≈ 15°/s, with a feed-forward term and a
    gated integrator.
- **Speed control.**
  - Speed on elevator (FLCH, VNAV SPD, TO/GA) commands γc = γ + (V̇ + 0.09·ΔV)/g.
  - The A/T SPD mode converts the speed error into an acceleration command, then uses PI on the
    acceleration error with flight-path feed-forward.
- **Pitch modes.** TO/GA, ALT, V/S, FPA, FLCH SPD, VNAV SPD/PTH/ALT, G/S and FLARE.
  - ALT capture is asymptotic (vs = Δh/12 s) and starts when |Δh| ≤ |V/S|·12 s. It is limited to
    about 0.08 g.
  - In V/S and FPA, the AFDS reverts to FLCH when the speed falls below the minimum manoeuvre speed.
- **Roll modes.** TO/GA (track hold), HDG/TRK SEL, HDG/TRK HOLD, LNAV, LOC, ATT and ROLLOUT.
  - LNAV and LOC use a path-following law: the desired lateral rate −y/τ becomes a track command and
    then a bank command. LNAV uses τ = 30 s with intercepts up to 45°. LOC uses τ = 20 s (14 s below
    300 ft) with intercepts up to 30°.
  - LNAV engages within 2.5 nm of the route, or arms (and engages after 50 ft when armed on the
    ground).
- **Bank limit.** AUTO gives 25° up to 350 KTAS, reducing to 15° at 500 KTAS. You can also select 5 to
  25°.
- **A/T modes.** THR REF, THR, SPD, IDLE and HOLD.
  - THR REF lever targets: TO 0.95, GA 0.95, CON 0.92, CLB 0.90, CRZ 0.86. `ap.thrRef` is exposed for
    EICAS.
  - Takeoff: THR REF changes to HOLD at 80 kt.
  - FLCH and VNAV descents go IDLE → HOLD.
  - HOLD wakes up to SPD below the minimum manoeuvre speed.
  - The A/T disconnects silently when reverse thrust is selected.
- **Approach and autoland.** APP arms LOC and G/S.
  1. LAND 3 annunciates below 1500 ft RA with LOC and G/S captured (LAND 2 with an engine out). FLARE
     and ROLLOUT then arm.
  2. FLARE engages at 50 ft. It is an exponential flare with about 2 ft/s at touchdown.
  3. The A/T goes to IDLE at 25 ft.
  4. ROLLOUT starts at touchdown and steers on the localizer through `ap.out.yaw`. It lowers the nose
     gently.
- **Disconnects.**
  - `controls.apDisc` (which is cleared after it is read) disconnects the AP. It emits the `ap_disc`
    aural and sets `ap.discWarning`. A second press clears the warning.
  - The AP also disconnects automatically on upset (bank > 45°, pitch beyond +30°/−20°), in a PFC mode
    other than NORMAL, on `fbw.prot.stall`, on a crash, when the DISENGAGE bar is pulled, and on a
    touchdown without autoland.
  - `controls.atDisc` disconnects the A/T, emits `at_disc` and sets `ap.atDiscWarning`.
- **FMA.** `ap.modes.{at, roll, pitch, armedRoll, armedPitch, ap}` uses the exact 777 strings.
  `ap.modes.ap` is one of `A/P`, `FLT DIR`, `LAND 3`, `LAND 2` or `NO AUTOLAND`. `ap.modeT.*` holds
  the sim time of each change, for the 10 s green box.
- **Extra state.**
  - `ap.tgtSpdKt`, `tgtMach`, `tgtIsMach`: the active speed target, for the PFD bug.
  - `ap.spdWindowBlank`, `ap.vsWindowOpen`, `ap.land`, `ap.holdAltFt`.
  - `ap.sel.vsIsFpa`, `ap.atArmL/R`, `ap.disengageBar`, `ap.altIncr1000`.
- **Interlocks.**
  - The AP cannot engage on the ground, with the DISENGAGE bar pulled, or in a PFC mode other than
    NORMAL. Pushing an engaged A/P button does nothing (`afdsAction('AP_ENGAGE','toggle')` toggles).
  - LNAV and VNAV need an active route. VNAV also needs a CRZ ALT.
  - On the ground, FD ON shows TO/GA | TO/GA.
  - TO/GA works in flight only with flaps extended or G/S captured. A second push gives THR REF.
- **Extra actions** besides the contract list: `SPD_INTV` (speed knob push), `ALT_INTV` (altitude
  knob push), `AP_DISENGAGE_BAR`, `AT_DISC`, `ALT_INCR_MODE`, and `AT_ARM` with `'L'` or `'R'`.
- **IAS/MACH changeover** at crossover is automatic: IAS → M.84 when climbing, M → 310 kt when
  descending.

## FMC (`fmc.js`)

- **Default route.** `buildDefaultRoute(sim, origin, dest)`:
  - The route is `RWxx → DPxx` (runway end + 10 nm), then great-circle fixes every ~100 nm with
    pronounceable 5-letter names, then `CIxx` (20 nm final, field + 5000 ft at-or-above), `FFxx`
    (FAF, 10 nm, field + 3000 ft), then `RWxx`.
  - If the arrival comes from the far side of the field, the FMC adds a downwind/base pair.
  - Runways are picked by headwind, or by the great-circle direction when the wind is calm.
  - The route is rebuilt on the `'spawned'` event if `fmc.dest` is set.
- **Leg sequencing** uses turn anticipation (R·tan(Δ/2)). The FMC computes `xtkM` (+ = right), `dtkRad`
  (great-circle course abeam the aircraft), `distToGoNm`, `alongToDestNm` and `etaActiveH`/`etaDestH`.
- **Modification buffer.** `fmc.mod` holds pending edits. `beginMod`, `execMod`, `eraseMod`,
  `directTo`, `insertWaypoint`, `deleteWaypoint`, `linkTo`.
- **VNAV.**
  - Phase is one of PREFLIGHT, TAKEOFF, CLIMB, CRUISE, DESCENT, APPROACH, DONE.
  - T/D uses the 3:1 rule from the FAF constraint, plus a 5 nm deceleration segment at 10 000 ft.
    `todNm`, `pathAltFt` and `pathVsFpm` are published.
  - Target speeds: V2+15 for takeoff; 250 kt below 10 000 ft (or the flap manoeuvre speed); 310 kt /
    M.84 in climb; M.84 in cruise; M.84/290 kt in descent, then 240 kt below 11 000 ft. On approach the
    target is the flap manoeuvre speed, or VREF+5 with flaps 25/30.
  - `vnavTargetSpdKt` is always the effective CAS (the Mach-equivalent value when Mach governs).
  - A VNAV PTH descent holds the path up to the target speed + 15 kt and posts "DRAG REQUIRED". Beyond
    that it changes to VNAV SPD, and it returns to PTH once the aircraft is back on the path.
- **Performance** (research §3/§5):
  - Vs from CLmax per flap setting. V2 = 1.15·Vs, VR = V2−7, V1 = VR−5. VREF = 1.23·Vs.
  - Flap manoeuvre speeds: VREF30 + 80/60/40/20/20/10.
  - `stallSpeedKt`, `minManeuverKt`, `maxSpeedKt` (flap placards / VMO).
  - V-speeds and VREF fill in automatically unless the pilot overrides them in the CDU.

## NAV radio (`navradio.js`)

- **Tuning.** AUTO tunes the departure runway on the ground before the first takeoff, and the arrival
  runway afterwards. A manual NAV RAD entry is stored in `fmc.ilsManual`.
- **Antennas.** The localizer antenna is at the stop end of the runway. The glideslope antenna is
  abeam the aim point, 1000 ft past the threshold. The glidepath angle is `ils.gsDeg` (3°).
- **Signs** (Team C convention):
  - `locDots > 0`: the aircraft is right of the course.
  - `gsDots > 0`: the aircraft is above the glideslope.
  - 1 dot = 1.25° for the localizer and 0.35° for the glideslope, clamped to ±2.5 dots.
  - `locDevM` and `gsDevM` use the same signs, in metres.
- **Validity.** The signal is valid within 25 nm and ±35° of the front course. The glideslope is valid
  between 0.2 and 2.2 times the glidepath angle.
- **Other fields.** `distNm` (DME to the threshold), `crsRad` (true course), `crsDeg` (magnetic) and
  `thrH`.

## MCP (`mcp.js`)

- **Layout.** The panel is laid out at 1240×150 and scaled to fit `#mcp`. Controls follow the real
  left-to-right order (see the file header).
- **Buttons.** The legend is engraved on the panel. The button shows a green bar when its mode is
  active or armed.
- **Windows.** The windows use amber LCD digits, with HDG/TRK and V/S/FPA labels. The windows blank in
  VNAV, and in V/S when the window is closed.
- **Knobs.**
  - Wheel turns the knob (Shift = ×10). You can also drag vertically, or use the arrow keys when the
    knob is focused.
  - Click pushes the knob: speed → intervention in VNAV or IAS/MACH otherwise, HDG → HDG SEL,
    ALT → altitude intervention.
  - Outer rings: BANK LIMIT (AUTO/5–25) and ALT increment (AUTO/1000).
- **Other controls.** V/S thumbwheel, F/D and A/T ARM toggles, and the A/P DISENGAGE bar.

## CDU (`cdu.js`)

- **Screen.** 24×14 cells with large and small font. The font is calibrated so one glyph equals one
  cell. Text colours are white, green, cyan and magenta.
- **Keys.** 6+6 LSKs, the full function key set, EXEC with its light, the MSG light, and the
  alphanumeric keypad with SP, DEL, / and CLR.
- **Pages.**
  - MENU, INIT/REF INDEX, IDENT, POS INIT, PERF INIT (GW, CRZ ALT, reserves, cost index).
  - THRUST LIM, TAKEOFF REF (flaps, V1/VR/V2: select or enter, ACCEL HT).
  - APPROACH REF (VREF 25/30, FLAP/SPD).
  - RTE (origin, dest, runway, flight number; the via/to list) and DEP/ARR with runway selection.
  - LEGS: direct-to by entering an ident at 1L. Entering a later ident at nL links (deletes the
    waypoints between). DELETE removes a waypoint. Lat/lon entries such as `N5003.0E00834.0` insert
    WPTnn. Right LSKs take `SPD/ALT` constraints.
  - PROGRESS (2 pages), VNAV CLB/CRZ/DES, NAV RAD (ILS `freq/crs`, DELETE returns to AUTO), ALTN,
    FIX, HOLD and FMC COMM. FIX, HOLD and FMC COMM are display only.
- **Messages.** INVALID ENTRY, NOT IN DATA BASE and FMC messages (DRAG REQUIRED) appear in the
  scratchpad. CLR clears them.
- **Keyboard.** Typing works only while the CDU is focused, through a listener on the CDU element. The
  CDU handles A–Z, 0–9, `. / space - +`, Backspace (CLR), Delete (DEL) and Enter (EXEC), and stops
  propagation for these keys only.
- **Airport database.** If `fmc.airports` is empty, the CDU loads it with `import('../world/airports.js')`.

## Limitations

- No SIDs/STARs, holds, step climbs, RTA or constraint-driven VNAV legs. Only the FAF constraint shapes
  the descent path, and LEGS constraints are displayed and stored only.
- The A/T uses fixed lever targets per thrust reference rather than closed-loop N1.
- There is no autoland decrab; the aircraft lands in its crab angle.
- VNAV ALT resumes the climb automatically when the MCP altitude is raised, without a knob push.
- The gains were validated against the stub model in `tests/afds.test.mjs`. Retune `T_CAP`, `K_SPD`,
  the `AT_*` constants and the inner-loop gains if Team A's FBW scaling differs a lot.
