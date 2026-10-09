# Team A — Flight physics (777-300ER / GE90-115B)

Pure ES modules under `src/physics/` (no DOM, Node-runnable). Test: `node tests/physics.test.mjs` (prints a numeric report, exits 0 on pass).
All numbers come from `scratchpad/research/physics.md` and live in **`aircraft777.js`** (single data file).

| File | Content |
|---|---|
| `atmosphere.js` | ISA (+ΔT, QNH-aware pressure via `airAt`), CAS/TAS/EAS/Mach (compressible), `pressureAltitude`, log-profile wind `windNED`, Dryden-like turbulence `createTurbulence` |
| `aircraft777.js` | geometry, masses, inertia table, flap/slat table, aero derivatives, surface limits/rates, placards, engine tables, gear geometry, FBW gains |
| `aero.js` | lift curve with nonlinear stall, drag polar + config/wave drag, ground effect, side force, 6 moment equations |
| `engines.js` | N2 spool (accel schedule), N1(N2), corrected-N1 thrust with Mattingly lapse, reverse, FF (TSFC), EGT, start/windmill |
| `gear.js` | gear actuator, struts, tyres, brakes/anti-skid, autobrake (1-4/MAX/RTO), steering, auto ground spoilers, touchdown/crash checks |
| `fbw.js` | PFC NORMAL/SECONDARY/DIRECT: C*U pitch law, auto stab trim, flare comp, protections, roll law, yaw damper, TAC, flaps/slats/speedbrake |
| `fdm.js` | `initAircraft`, `stepPhysics`, `solveTrim`, 6-DOF integration, outputs, NaN guard |

## API notes
- `initAircraft(sim, { lat, lon, h, heading, onGround=true, speedKt=0, fuelKg=60000, payloadKg=30000, enginesRunning=true })`
  - lat/lon/heading **radians**. `onGround`: `h` = ground ellipsoidal height, CG height solved from strut equilibrium; `speedKt` = ground speed. Airborne: `h` = CG ellipsoidal height, `speedKt` = CAS; the aircraft is trimmed (alpha, stab, thrust) and **`controls.throttle` is set to the trim lever** (the only time physics writes a control).
  - Flaps/gear are set immediately from `controls.flapLever/gearLever`. On ground the stab is set to a takeoff trim (green band). `enginesRunning:false` = cold & dark (N1/N2 0, startState 'OFF').
  - Fuel split: L/R up to 29 t each, rest centre. `zfw = OEW 167.8 t + payload`.
- `stepPhysics(sim, 1/120)`: order FBW → secondary surfaces → gear lever → brakes/steering → engines → fuel → aero → ground → integrate → outputs → contact checks. ~35 µs per call.
- `solveTrim(sim, { tas, hMSL, gamma })` → `{ alpha, stab, thrust }` (exported helper, used by tests).
- Ground height: `env.groundH` when `env.groundValid`, else last valid value.

## Conventions (surfaces)
`elevator` + = TE down (nose down), ±: −30°/+25°. `stab` + = nose-up trim, −4°…+11°, `stabUnits = stabDeg + 4`. `aileron` (display) + = roll right, = lumped roll command × 25°. `spoilerRollL/R` 0..1. `rudder` + = nose right. `speedbrake` 0..1 actual panels (flight max 0.6; 1 = ground spoilers). `reverser[i]` 0..1. `noseWheel` rad + = right. `brakes[i]` applied pressure 0..1.

## Extra outputs (added to own blocks)
`ac.stallWarning` (stick shaker), `ac.stalled`, `ac.buffet` 0..1, `ac.vs1gKt`, `ac.vShakerKt`, `ac.vMinManKt` (top of amber band ≈1.19 Vs), `ac.vMaxKt` (min of VMO/MMO/flap placard/VLE), `ac.satC`, `ac.tatC`, `ac.pressureAltM`, `ac.windNED`, `ac.CL/CD`; `surfaces.autobrakeState` ('OFF'|'ARMED'|'ACTIVE'|'DISARMED'), `surfaces.flapLoadRelief`; `engines[i].reverser`; `fbw.law` ('GROUND'|'CSTAR'|'FLARE'|'DIRECT'), `fbw.cstarCmd/cstar`, `fbw.tacActive`.

## Model summary
- **6-DOF**: body forces/moments, Euler equations with Ixz, inertia interpolated in mass (230/300/351 t). NED velocity with gravity(h), curvature/transport-rate terms; attitude quaternion integrated with body rates minus transport rate; position on WGS84 (`dlat=vN/(M+h)` …). Semi-implicit Euler, fixed 1/120 s (time acceleration = more calls).
- **Air data**: air-relative velocity = vNED − wind(log profile below 10 m, `windDirDeg` = FROM) − turbulence (σw = 3 m/s × `env.turbulence`, MIL-F-8785C length scales, plus roll gust). Alpha/beta/TAS/CAS/EAS/Mach. Pressure from pressure altitude (QNH aware) so indicated altitude at QNH equals `altMSL`.
- **Lift**: CL0(flap) + CLα(M)·α (5.6→6.6), linear to CLmax−0.15, parabolic rounding to CLmax (≈1.5–3° past linear), post-stall −0.04/deg then faster, flat plate beyond. CLmax vs Mach (1.45 → 0.88 at M0.84); autoslat (+0.1 CLmax) at shaker with flaps 1-20. Stall: nose-down break, wing drop (random side), buffet. Shaker = 0.92 CLmax or near-peak alpha.
- **Drag**: CD0 0.0158 + flaps + gear (0.018, +0.004 transit) + speedbrake (0.020 flight / 0.070 ground) + k(CL−0.1)²·φGE + Korn wave drag (Mcrit ≈ 0.78–0.80 at cruise CL, Mdd ≈ 0.89) + 0.003 per dead engine.
- **Moments**: Cm0, Cmα −1.3, Cmq −21/−25, Cmα̇ −3.5, Cmδe −1.35, Cm_stab 2.8, flap/gear/spoiler ΔCm, CG shift (`ac.cgMacPct`), ground effect nose-down; thrust line 1.5 m below CG (nose-up with power). Lateral derivatives interpolated M0.25→0.75 (Clβ, Clp, Clr, Clδa, Cnβ, Cnr, Cnδr, Cnδa adverse yaw, CYβ, CYδr).
- **Engines**: N2 state, accel limit 2.6 %/s at idle → 6.5 %/s mid, τ 0.9 s up / 1.4 s down; idle N2 62 ground / 66 flight / 72 approach (flaps ≥25 or gear down). Lever 0..1 → N1 from ground-idle N1 (21 %) to TO-rated N1 (104 % SL static). Thrust = Fmax(M,δ0,θ0)·((N1c−N1z)/(N1cmax−N1z))^1.8 with N1z = 10 + 62 M. FF = TSFC·F + idle term, TSFC = 7.9 g/kN/s·(1+1.3M)·θ^0.3. Reverse: doors 2 s, only with lever at idle and wow/RA<3 m, ≈50 % of gross at 80 % N1. Start: STARTING → starter to ~27 % N2, light-off ≥20 % with fuel RUN, idle in ~47 s, physics sets 'RUN' >50 % only when no systems module owns fuel. Flameout on CUTOFF, empty tanks, fire, or `startState 'OFF'`. Windmill N1 ≈ 0.09·KCAS.
- **Gear**: nose (x +28.6) + 2 main bogies (x −2.6, y ±5.49), extended contact z 5.3 m; k 5 MN/m main (static stroke ~0.29 m), 0.9 MN/m nose, asymmetric damping, bottoming. Rolling μ 0.015, braking min(P·1.25 MN, 0.55·N), cornering μ 0.6·tanh(slip/6°), friction circle 0.8; 6-wheel bogie scrub (reduced when aft axle steers). Tiller ±70° (full < 20 kt, 10° at 60 kt), pedals ±7°. Autobrake decel 1.22/1.52/1.83/2.2/3.35 m/s², engages after an airborne phase on main wow + idle; RTO above 85 kt after TO thrust then idle; disarms on pedal > 0.4 / thrust. Auto ground spoilers when armed + idle on touchdown, or reverse selected, or RTO.
- **Crash/hard landing** (toasts on `sim.events`): touchdown toast with fpm; > 600 fpm "HARD LANDING"; > 1200 fpm crash; nacelle/wingtip/belly/nose contact, gear not down, strut collapse, nose-first at speed, > 20° bank or > 25° pitch on ground = crash; tail contact = "TAIL STRIKE" toast (crash if > 4 m/s). After a crash physics freezes until `initAircraft`.

## FBW scaling (for Team D1 / input)
- **Pitch (NORMAL, airborne)**: column c ∈ [−1, 1] → C*cmd = 1.8·c (g). C* = (nzW − cosγ/cosφc) + (Vco/g)(q − q_turn), Vco = 120 m/s, φc = min(|φ|, 30°) (turn compensation up to 30°, pull needed beyond). PI on C* error, partially model-inverting (gains × Iyy / (q̄ S c̄ |Cmδe|)). Neutral column → C* = 0 → flight path held. Full column ≈ 7°/s peak, ~5°/s sustained, nz ≈ 1.5 g at 150 kt F30; 2.1 g at 320 kt; nz clamped to +2.5/−1 g.
- **U term** (speed stability): +0.010 g per kt above `fbw.trimRefKt` (cap ±0.25 g) with speed-rate damping (7 s lead). Trim switch moves `trimRefKt` by 4 kt/s in flight (clamped vMinMan…VMO); on ground/SECONDARY/DIRECT it moves the stab 0.5°/s. With `ap.out.active` the U term is off and `trimRefKt` tracks CAS (so the AP column alone controls the path).
- **Auto stab trim** offloads the elevator (0.5°/s < 230 kt, 0.2°/s above); inhibited on ground and in flare.
- **Flare**: armed above 150 ft RA; below 100 ft RA descending with gear down, a −0.08 C* nose-down bias ramps in over 5 s and the U term is suspended → the pilot/AP must pull to flare.
- **Protections**: stall — C* reduced 40/rad beyond (alpha_shaker − 1°), extra nose-down below min manoeuvre speed; overspeed — +0.02 g/kt above VMO/MMO; bank — beyond 35° wheel authority opposed (≈60° max with full wheel), wheel released → rolls back to 30°; AP limited to 35°. Tail-strike protection on ground fades elevator above 8° pitch.
- **Ground / transitions**: on ground column → elevator directly (pull 1 → −30°), blended to C*U over 2 s after liftoff and back over 1 s after touchdown.
- **Roll**: wheel w → roll-rate command 15°/s·w (achievable ≈ 15°/s clean at 250 kt, ≈ 9°/s at 145 kt F30); wheel neutral (|w| < 0.05) → bank captured and held. Measured: 0→30° in 2.7 s (250 kt) / 4.3 s (F30 145 kt).
- **Yaw**: pedal → rudder × rudder-ratio limit max(8°, 27°·min(1,(130/KCAS)²)); yaw damper/turn coordination (authority ±8°); TAC cancels 90 % of thrust-asymmetry yaw above 70 KCAS (off with reversers or `fbw.prot.tac=false`).
- **AP combination**: per axis, `ap.out.*` used when `ap.out.active` and pilot |input| < 0.3; pilot column/wheel > 0.3 sets `controls.apDisc = true`.
- SECONDARY/DIRECT: column→elevator, wheel→roll surface directly, no protections (DIRECT: no YD/TAC).

## Test report (node tests/physics.test.mjs — ALL PASS)
- Takeoff 300 t F15: VR 160 at 38 s, liftoff 1,556 m / 170 KCAS, 35 ft at 1,880 m / 180 KCAS (1.15×d35 ≈ 2,160 m), climb ≈ 3,500 fpm, TO N1 104.5 %, FF 16 t/h/eng, EGT 944 °C.
- Cruise FL350 M0.84 280 t: 61 kN/eng, 3.6 t/h/eng, N1 88.8 %, EGT 751 °C, pitch 2.9°, hands-off 120 s alt dev 30 ft.
- Approach 250 t F30: Vs1g 121, Vref 149 KCAS; 3° at Vref+5: N1 59.6 %, pitch +1.0°, 87 kN/eng.
- Stall clean 280 t: CLmax 1.45 at α 14.1° (166 KCAS), shaker 176 KCAS; NORMAL law full aft stays ≈1.7° below stall alpha.
- Engine failure at V2+10: TAC on → β 0.4°, heading change 9° in 38 s hands-off; TAC off → β 7°, 32°.
- Landing 250 t AB3 + reverse: touchdown 265 fpm, ground roll 1,670 m, 2,030 m from 50 ft; RTO from 120 kt 461 m.
- Taxi full tiller: radius ≈ 17 m at CG at 9 kt. Spool: ground idle → 95 % TO thrust 9.2 s, approach idle → GA 5.7 s, start 47 s.

## Limitations
Not certified data (EST tags in research). Flat-earth ground plane under the aircraft (terrain slope ignored), no Coriolis, no wet/contaminated runway selection, no aeroelasticity, no flap/slat asymmetry or hydraulic failures, no fuel CG travel (CG from `ac.cgMacPct`), simplified secondary-mode laws, no separate pressure-altitude display logic (Team C).
