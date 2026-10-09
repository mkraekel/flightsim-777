# B777-300ER (GE90-115B) — 6-DOF FDM Reference Data

Tags: **[S#]** sourced (see list at bottom), **[B747]** Boeing 747 published data used as a proxy for a large swept-wing transport, **[EST]** engineering estimate, cross-checked for consistency (e.g. Vref and V2 come out right). SI units unless noted. Angles in rad unless noted. Body axes: x forward, y right, z down.
Not certified data. Do not use for real flight operations.

## 1. Geometry
| Item | Value | Tag |
|---|---|---|
| Wing area S (reference) | 436.8 m² (4,702 ft²) (-300ER with raked tips) | [S1] |
| Span b | 64.80 m (212 ft 7 in) | [S1][S2] |
| Aspect ratio b²/S | 9.61 | derived |
| MAC c̄ | 8.75 m (basic 777 wing, use as reference chord) | [S3] |
| ¼-chord sweep Λ | 31.6° | [S3][S1] |
| Taper ratio | 0.149 | [S3] |
| Dihedral | ≈ 6° | [EST] |
| Length overall / fuselage | 73.86 m / 72.88 m | [S1][S3] |
| Height (tail) | 18.85 m | [S1] |
| Fuselage diameter | 6.20 m | [S1] |
| Horizontal tail: S_h, b_h, AR, Λ, arm l_h | 101.26 m², 21.35 m, 4.5, 35°, 32.95 m | [S3] (777-300) |
| Vertical tail: S_v, h_v, AR, Λ, arm l_v | 53.23 m², 9.24 m, 1.6, 46°, 31.65 m | [S3] (777-300) |
| Tail volume V_h = S_h·l_h/(S·c̄) | ≈ 0.87 | derived |
| Wheelbase (nose gear to main bogie centre) | 31.22 m (102 ft 5 in) | [EST from ACAPS memory; the -200 is 25.9 m] |
| Main gear track | 10.97 m (36 ft) | [S3] (11.0 m) |
| Gear: nose 2 wheels; main 2 × 6-wheel bogies (three axles; aft axle steers ±8°) | — | [S3][S6] |
| Main tyre diameter / width | 1.118 m / 0.457 m (52×21R22) | [S3] |
| Engine position (y), nacelle length, diameter | ±10.6 m (0.326·b/2 basic wing) , 7.3 m, fan 3.25 m | [S3][S4] |

**Gear positions relative to the CG** (CG at about 25 % MAC, mid weight) [EST]: nose gear x = +28.6 m; main bogie centre x = −2.6 m (about 8 % of weight on the nose gear static); main y = ±5.49 m; for gear legs compressed static, z = +5.0 m (CG about 5.0 m above ground). Engine thrust line z ≈ +1.5 m below the CG, so thrust gives a nose-up moment of about 1.5·T.
Tail-strike pitch with gear compressed ≈ 9–10° (the -300ER has semi-levered main gear and tail-strike protection) [EST]. The 3-axle bogie raises scrub friction in tight turns.

## 2. Masses & inertia
| Item | kg | lb | Tag |
|---|---|---|---|
| MTW (taxi) | 352,441 | 777,000 | [EST/ACAPS] |
| MTOW | 351,535 | 775,000 | [S1][S2] |
| MLW | 251,290 | 554,000 | [EST/ACAPS] |
| MZFW | 237,682 | 524,000 (later 529,000 option) | [EST/ACAPS][S1] |
| OEW (typical) | 167,829 | 370,000 | [S1] |
| Max usable fuel | 145,538 (181,283 L, 47,890 USG) | 320,863 | [S1] |
| Fuel density | 0.803 kg/L | — | [S1] |

**Inertias** [EST], scaled from B747 at 288.8 t (Ixx 24.7e6, Iyy 44.9e6, Izz 67.4e6, Ixz 1.32e6 kg·m², from 18.2/33.1/49.7/0.97 e6 slug·ft²) [S5] using I ∝ m·L². The 777 has 2 engines instead of 4, so the outboard mass is lower.
| Condition (mass) | Ixx | Iyy | Izz | Ixz | units 1e6 kg·m² |
|---|---|---|---|---|---|
| 300 t (mid) | 26 | 51 | 76 | 1.3 | |
| 351 t MTOW (full wing fuel) | 31 | 57 | 87 | 1.5 | |
| 230 t (landing, light) | 19 | 42 | 60 | 1.0 | |
Interpolate linearly in mass. Fuel sits mostly in the wing, so it raises Ixx and Izz more than Iyy. CG range ≈ 14–44 % MAC [EST]; use 25 % as nominal.

## 3. Aerodynamics (stability axes, coefficients on S, c̄ or b; per rad)
### 3.1 Lift
- CL = CL0(flap) + CLα·α + CLq·(q c̄/2V) + CLα̇·(α̇ c̄/2V) + CLδe·δe + CLih·ih + ΔCL_spoiler + ΔCL_gnd
- CLα at M 0.2 = 5.6 (whole aircraft) [EST; B747 5.70 at M0.25 [S5]]. Compressibility: CLα(M) = CLα0·√(1−0.04)/√(1−(M cosΛ)²) (≈6.3 at M0.7, ≈6.6 at M0.84), then flat above M0.86 [EST]. B747 values for comparison: 4.4 at M0.65 and 5.5 at M0.9 (aeroelastic) [S5].
- CLq = 5.5, CLα̇ = 6.7, CLδe = 0.35, CLih = 0.75 [B747 / EST]

| Flap | Slats | TE flap | CL0 (α_body=0) | CLmax (Vs1g, low M) | α_stall linear (deg) | ΔCD0 | ΔCm0 (before trim) |
|---|---|---|---|---|---|---|---|
| UP (0) | retracted | 0° | 0.20 | 1.45 | 12.8 | 0 | 0 |
| 1 | sealed (mid) | 0° | 0.25 | 1.75 | 15.3 | 0.004 | −0.01 |
| 5 | sealed | 5° | 0.45 | 1.92 | 15.0 | 0.010 | −0.04 |
| 15 | sealed | 15° | 0.68 | 2.05 | 14.0 | 0.020 | −0.08 |
| 20 | sealed | 20° | 0.78 | 2.15 | 14.0 | 0.027 | −0.10 |
| 25 | gapped (full) | 25° | 1.00 | 2.28 | 13.1 | 0.045 | −0.14 |
| 30 | gapped (full) | 30° | 1.10 | 2.35 | 12.8 | 0.060 | −0.16 |
All CL0, CLmax, ΔCD0 and ΔCm0 values are [EST]. They are tuned so that Vref30 at 251 t is about 150 kt, V2 for F15 at 340 t is about 172–180 kt, and the flaps-30 approach attitude is about +1.5–2° and the cruise attitude about +2.5°. [S3] gives landing CLmax ≈ 2.53 for 777-100X studies. Slat and flap detent mapping per the FCOM description: flaps 1 = slats only; slats sealed for 1–20; gapped for 25/30. In flight with flaps 1–20, autoslat moves the slats to gapped near stall AoA (+0.10 CLmax) [EST].
- Stall model: soft roll-off. CL follows the linear curve up to about CLmax − 0.15. It rounds to a peak about 1.5–2° past the linear α_stall, then falls about 0.03 per degree. Pitch-up at stall is mild (Cm increases by +0.05). Stick shaker fires at about 0.92·CLmax.
- CLmax vs Mach (clean): 1.45 at M ≤ 0.3, 1.25 at M 0.5, 1.05 at M 0.7, 0.88 at M 0.84 (buffet onset). Use these values in the stall and buffet logic [EST].
- Ground effect (McCormick): with h the wing height above ground, φ = (16h/b)²/(1+(16h/b)²). CDi ← φ·CDi. ΔCL_gnd ≈ +0.10·(1−φ) for flaps down [EST].

### 3.2 Drag
- CD = CD0 + k·(CL − CLminD)² + ΔCD_flap + ΔCD_gear + ΔCD_sb + CD_wave. Take CLminD ≈ 0.10.
- Clean CD0 = 0.0165 [EST; B747 0.0164 [S5]]. e = 0.82 and k = 1/(π·AR·e) = 0.0404. Flaps ≥ 20: e = 0.75 (k = 0.044). L/Dmax ≈ 19.4 [EST]; published 777 cruise L/D is about 19–20.
- Landing gear down: ΔCD0 = +0.018 [EST]. Gear-in-transit doors add +0.004 more.
- Speedbrake (flight detent, 777 has 7 spoiler panels per wing): ΔCD = +0.020·(δsb/δsb_max), ΔCL = −0.10. Ground spoilers fully up: ΔCD = +0.070, ΔCL = −0.70 (lift dump) [EST].
- Wave drag (Korn/Lock): Mdd = 0.95/cosΛ − (t/c)/cos²Λ − CL/(10cos³Λ). With κ_A = 0.95 (supercritical), t/c ≈ 0.10 and CL 0.5, Mdd ≈ 0.86. Then Mcrit = Mdd − (0.1/80)^(1/3) = Mdd − 0.108. CD_wave = 20·(M − Mcrit)⁴ for M > Mcrit [EST method].
- Engine windmilling/failed: ΔCD ≈ +0.003 per engine [EST]. Thrust reverser deployment adds drag in its thrust term (see §4).

### 3.3 Pitching moment (about the CG at 25 % MAC)
- Cm = Cm0 + Cmα·α + Cmq·(q c̄/2V) + Cmα̇·(α̇ c̄/2V) + Cmδe·δe + Cmih·ih + ΔCm0(flap) + ΔCm_gear + Cm_thrust
- Cm0 = +0.05 clean (stab at 0) [EST]. Cmα = −1.3 (static margin ≈ 0.23) [B747 −1.26 at approach, −1.0 at M0.65] [S5]. For CG shift, Cmα ← Cmα + CLα·(x_cg − 0.25), with x_cg in fractions of MAC.
- Cmq = −21 low speed and −25 at cruise. Cmα̇ = −3.5 [B747 −20.5, −20.8; −4.0, −3.2] [S5]
- Cmδe = −1.35 [B747 −1.3/−1.34] [S5]. Elevator travel ≈ +30° (TE up) / −25° [EST]. Elevator rate 40°/s [EST].
- Cmih (stabilizer) = −2.8 [EST, about 2× elevator]. Stab travel ≈ −4° (LE up, nose-down trim) to +11° (LE down, nose-up trim); trim rate 0.2°/s at high speed and 0.5°/s at low speed [EST]. Takeoff green band ≈ 2–8 units (1 unit ≈ 1°) [EST].
- Gear down: ΔCm ≈ +0.005. Spoilers: ΔCm ≈ +0.02 (nose-up) [EST].

### 3.4 Lateral-directional
| Deriv. | Approach (M0.25) | Cruise (M0.65–0.85) | Tag |
|---|---|---|---|
| CYβ | −0.96 | −0.90 | [B747][S5] |
| CYδr | 0.175 | 0.120 | [B747] |
| Clβ | −0.22 | −0.16 | [B747] |
| Clp | −0.45 | −0.34 | [B747] |
| Clr | +0.10 | +0.13 | [B747] |
| Clδr | +0.007 | +0.008 | [B747] |
| Cnβ | +0.15 | +0.16 | [B747] |
| Cnp | −0.12 | −0.026 | [B747] |
| Cnr | −0.30 | −0.28 | [B747] |
| Cnδr | −0.109 | −0.100 | [B747] |
| Cl_δroll (flaperons, ailerons and roll spoilers lumped, per rad of equivalent surface) | 0.10 | 0.06 (outboard ailerons locked out above about 210 kt) | [EST] |
| Cn_δroll (adverse yaw) | −0.010 | −0.004 | [EST] |
- Use δroll_max = 0.35 rad equivalent. This gives a steady roll rate of about 10°/s at 145 kt and 15–20°/s at 250 kt, which matches large-transport roll performance [EST]. Roll-surface rate is 60°/s.
- Rudder ±27° at low speed. FBW rudder-ratio limit: δr_max = 27°·min(1, (130/KCAS)²), with a floor of 8° [EST]. Rudder rate 50°/s. Yaw damper is always on in Normal mode.
- Sign convention: +δr = trailing edge left gives nose-left yaw (Cnδr < 0). +δroll = right-wing-down command gives Cl > 0.

## 4. Engines — GE90-115B (×2)
| Item | Value | Tag |
|---|---|---|
| Rated TO thrust (SL static, flat-rated to about ISA+15) | 513 kN (115,300 lbf); TCDS range 492.7–513.9 kN | [S2][S4] |
| Bypass ratio / OPR / fan diameter / dry mass | 9 / 42 / 3.25 m (128 in) / 8,762 kg | [S4] |
| N1 100 % = 2,355 rpm, limit 110.5 % · N2 100 % = 9,332 rpm, limit 121 % | | [S7] |
| EGT limits: TO 1,090 °C (5 min), max continuous 1,050 °C, start 750 °C on ground / 825 °C in flight | | [S7] |
| TSFC: TO static 0.278 lb/lbf/h (7.9 g/kN/s); cruise ≈ 0.52–0.545 lb/lbf/h (≈ 15 g/kN/s) | | [S4]; cruise [EST] |
| Max reverse ≈ 0.30·T_rated effective at high speed; reverse N1 ≈ 80 %; deploy and stow time ≈ 2–3 s; reverse is reduced to reverse idle by 60–80 kt | | [EST] |

**Thrust lapse model** (Mattingly, high bypass) [EST method]. Constants: γ = 1.4, θ = T/288.15, δ = p/101325.
θ0 = θ·(1+0.2M²) and δ0 = δ·(1+0.2M²)^3.5.
T_max/T_SLS = δ0·[1 − 0.49√M − (θ0>TR ? 3(θ0−TR)/(1.5+M) : 0)], with TR ≈ 1.05.
Check at FL350, M0.84: ≈ 0.206, so about 105 kN per engine of max climb thrust. Cruise drag at 300 t is about 78 kN per engine. Max climb rating ≈ 0.93·TO rating; max continuous ≈ 0.90·TO rating.
- Thrust vs N1 (fraction of max at the current condition): F/Fmax ≈ ((N1 − N1_idle)/(N1_max − N1_idle))^1.6 [EST]
- Fuel flow per engine: FF = TSFC(M,h)·F + FF_idle. TSFC_eff ≈ 7.9·(1 + 0.45M) g/kN/s at sea level, falling about 3 % per 10 kft [EST].

| Phase (per engine, typical) | N1 % | N2 % | EGT °C | FF kg/h | Tag |
|---|---|---|---|---|---|
| Ground idle | 20–23 | 60–63 | 400–480 | 550–700 | [EST] |
| Flight/approach idle | 28–35 | 70–75 | 450–550 | 800–1,100 | [EST] |
| Takeoff (full rating, SL) | 100–108 | 105–110 | 900–1,040 | 14,000–17,000 | [EST; TSFC S4] |
| Climb (early → TOC) | 98–102 | 103–106 | 850–950 | 10,000 → 4,500 | [EST] |
| Cruise M0.84 FL330–FL390 | 90–97 | 96–100 | 700–820 | 3,000–4,300 | [EST] |
| Approach flaps 30, 3° glide path | 55–65 | 85–90 | 550–650 | 2,000–2,700 | [EST] |
- Spool dynamics [EST]: model N2-driven N1 as a first-order lag with τ = 4.5 s at idle down to 1.2 s near max (rate-limited acceleration schedule). Flight idle to 95 % TO thrust takes ≈ 6–7 s, which meets the FAR 25.119 requirement of 8 s for go-around thrust. Ground idle to TO takes ≈ 9–11 s. Deceleration from max to idle takes ≈ 5–7 s. Start sequence: N2 25 % → fuel → light-off → idle in ≈ 50–70 s.
- Thrust asymmetry beyond 10 % of rated thrust activates TAC (see §6).

## 5. Performance & operating limits
| Limit | Value | Tag |
|---|---|---|
| VMO / MMO | 330 KCAS (KEAS) / M0.89. FCOM barber pole uses 330 kt / M0.87 for the -200 family | [S8][S1] |
| VLO / VLE / M_LE | 270 KIAS / 270 KIAS / M0.82 | [S9] (sim reference) |
| Flap placards -300ER (F1/5/15/20/25/30) | 265 / 245 / 230 / 225 / 200 / 180 kt (Infinite Flight lists 220 for F25; older 777-200 placards are 255/235/215/195/185/170) | [S10][S11] |
| Flap extension max altitude | 20,000 ft | [EST] |
| Max operating altitude / ceiling | 43,100 ft | [S1] |
| Cruise | M0.84 (LRC M0.83–0.84); initial FL300–FL330 at heavy weight, FL370–FL410 at light weight | [S1][EST] |
| TO field length (MTOW, SL ISA) / landing distance (MLW) | 3,215 m / 1,780 m | [S1] |
| Max demonstrated crosswind / tailwind | 38 kt / 15 kt | [EST] |
Takeoff and landing speeds below are [EST]: they come from the §3.1 CLmax values, with V2 ≈ 1.15·Vs1g (min 1.13) and Vref = 1.23·Vs1g, scaled by √(W/W_ref). They are consistent with FMC values reported by sim users.
| TOW (t) | Flap | V1 | VR | V2 |
|---|---|---|---|---|
| 250 | 15 | 140 | 145 | 152 |
| 300 | 15 | 152 | 157 | 164 |
| 340 | 15 | 164 | 168 | 174 |
| 351 | 15/20 | 167 | 171 | 177 |
Use flaps 5 for lighter or performance-limited climb cases, which adds about 7 kt to the speeds above. Rotate at 2.5–3°/s to 12–15° pitch; liftoff α ≈ 9–10° [EST].
| Landing weight (t) | 180 | 200 | 220 | 240 | 251 (MLW) |
|---|---|---|---|---|---|
| Vref30 (KIAS) | 127 | 134 | 140 | 146 | 150 |
| Vref25 | +3 kt | Vref20 ≈ +12 kt | Vapp = Vref + max(5, ½·headwind + gust) ≤ Vref+20 |
- Flap-retraction manoeuvre speeds (FMC style) [EST]: UP = Vref30+80, F1 = +60, F5 = +40, F15 = +20, F20 = +20, F25 = +10.
- Climb [EST]: 250 KIAS below 10,000 ft. Above that, 310 KIAS until crossover (≈ 31,500 ft for 310/M0.84), then M0.84. Initial ROC at MTOW ≈ 2,000–2,500 fpm (N-1: ≈ 300–500 fpm). Time from MTOW to FL310 ≈ 25–30 min. Optimum or max altitude is where residual ROC drops to 300 fpm.
- Descent [EST]: idle, M0.84 → 310 KIAS (280 kt in turbulence) → 250 KIAS below 10,000 ft. ROD 2,000–3,000 fpm (speedbrakes about +1,000 fpm). Use the 3:1 rule (3 nm per 1,000 ft). Glide slope 3° at ≈ 700–800 fpm.

## 6. Fly-by-wire, ground handling, brakes
**Primary Flight Control System** [S12][S13]. The modes are Normal, Secondary (simplified gains, no envelope protection) and Direct (surfaces proportional to column and wheel).
- **Pitch: C*U law.** The column commands a blend of normal load factor and pitch rate: C* = Δnz + (V_co/g)·q, with V_co ≈ 120 m/s [EST]. The U term adds speed stability about the *trim reference speed*. In flight, the trim switches change the reference speed rather than move the stabilizer directly; the stab then auto-trims elevator to zero. A rate of ≈ 1 kt per 0.25 s of trim switch is a reasonable model [EST]. Hands-off, the aircraft returns to Vref_trim like a conventional speed-stable aircraft. Column force gradient ≈ 1 lb/kt off trim speed [EST]. On the ground and below about 100 ft RA, the pitch law blends to a direct column-to-elevator law [EST].
- **Thrust changes** do not change the trim reference. Pitch-thrust coupling is only partly compensated, so the aircraft still pitches up with power increase [EST].
- **Turn compensation**: no back-pressure is needed up to 30° bank. Beyond 30°, the pilot must pull [S12][EST bank value].
- **Landing flare compensation**: below about 100 ft RA, the law adds a gradual nose-down bias, so the pilot must flare by pulling back as on a conventional aircraft [S12].
- **Stall protection**: the trim reference speed cannot be set below the minimum manoeuvre speed (top of the amber band ≈ 1.3·Vs). Below that speed, column force increases sharply. Stick shaker fires at ≈ 1.05–1.1·Vs; activate it at 0.92·CLmax or the α_shaker table. Stall protection uses no hard α limit [S12].
- **Overspeed protection**: the trim reference cannot exceed VMO/MMO. Above VMO/MMO, a nose-up push force builds that the pilot must hold [S12]. Model it as an added Δnz command ≈ +0.1 g per 5 kt over the limit [EST].
- **Bank angle protection**: wheel force increases beyond about 35° bank. If the wheel is released, the aircraft rolls back toward 30°. The pilot can override up to full control authority [S12][EST thresholds].
- **Roll law**: wheel commands surface deflection (a roll-rate-like response). It is not a rate-command/attitude-hold law; bank does not hold neutrally beyond the spiral mode, which is near-neutral [EST].
- **TAC (thrust asymmetry compensation)**: the system computes the yaw moment from engine thrust (N1/EPR) and commands rudder to cancel ≈ 90 % of it [S14 patent; EST fraction]. FlightGlobal summarizes it as "up to 10° rudder when asymmetry >10 % of rated thrust" [S13]. TAC is active above ≈ 70–80 kt and on the takeoff roll, and is inhibited when reversers are deployed. It drives the rudder pedals (backdrive). When TAC is disconnected, the rudder trim returns to zero.
- **Tail-strike protection** (-300ER): during takeoff rotation, pitch commands are reduced near the tail-strike attitude [EST].
- **Yaw damper and gust suppression** are always on in Normal mode. Rudder ratio limits are given in §3.4.

**Autobrake** [S15] (forum-reported FCOM values; ft/s² → m/s²):
| Setting | 1 | 2 | 3 | 4 | MAX AUTO | RTO |
|---|---|---|---|---|---|---|
| Decel target | 4 (1.22) | 5 (1.52) | 6 (1.83) | 7–7.5 (2.2) | 11 (3.35) | full brake pressure (3,000 psi), armed and triggered above 85 kt when thrust is reduced to idle |
Autobrake activates when the main gear is on the ground and the wheels are spun up, with thrust levers at idle. It disarms on pedal braking, thrust advance, or speedbrake stow. Pressure ramps up over ≈ 1–2 s [EST].
**Brakes and tyres** [EST]: carbon brakes on all 12 main wheels, each wheel with anti-skid. Max torque ≈ 220 kN·m per wheel, but in practice braking is friction-limited. Model each wheel group as F_brake = min(P_cmd·K_b, μ_avail·N).
- Rolling resistance μ_roll = 0.015 (unbraked, concrete); + 0.005 for wet runway.
- Braking friction μ_max ≈ 0.80 dry and ≈ 0.45 effective with anti-skid efficiency. Wet: μ ≈ 0.25–0.35, speed-dependent per ESDU 71026 (μ_wet ≈ 0.40·(1 − 0.004·V_kt)). Contaminated runways: ice ≈ 0.05–0.10; packed snow ≈ 0.2.
- Lateral (cornering) force uses a slip-angle model: F_y = μ_y·N·tanh(β_slip/β0), with β0 ≈ 6° and μ_y,max ≈ 0.6 dry. Peak lateral force occurs at a slip of ≈ 8–10°.
- Static oleo stroke ≈ 0.3 m main, 0.25 m nose; k ≈ 1.2e7 N/m per main gear, damping ζ ≈ 0.4 [EST].
**Steering**: nose-wheel tiller ±70° [S6]; rudder pedals ±7° [EST/common Boeing]. Tiller authority fades with speed: full below 20 kt, about 10° at 60 kt. Aft main axle steers ±8° (active when the nose-wheel angle exceeds ≈ 13° and groundspeed is below ≈ 20 kt) [S6]. 180° turn: minimum effective pavement width ≈ 56 m [EST]. Taxi speed is about 20 kt straight and 10 kt in turns. Brake-release thrust: N1 ≈ 30 %.

## 7. Atmosphere (ISA) & airspeed conversions
Constants: g0 = 9.80665, R = 287.053 J/(kg·K), γ = 1.4, T0 = 288.15 K, p0 = 101325 Pa, ρ0 = 1.225 kg/m³, a0 = 340.294 m/s (661.47 kt), lapse rate L = 0.0065 K/m. 1 kt = 0.514444 m/s, 1 ft = 0.3048 m.
- Troposphere (h ≤ 11,000 m geopotential): T = T0 − L·h; p = p0·(T/T0)^(g0/(L·R)), where the exponent is 5.25588; ρ = p/(R·T).
- Lower stratosphere (11,000 < h ≤ 20,000 m): T = 216.65 K; p = 22632.06·exp(−g0·(h − 11000)/(R·216.65)).
- ISA deviation ΔT: T = T_ISA + ΔT. Pressure vs pressure-altitude is unchanged. Density altitude follows from ρ = p/(R·T).
- Speed of sound a = √(γ·R·T) = 20.0468·√T m/s.
- Dynamic pressure q = ½ρV² = 0.7·p·M².
- EAS = TAS·√(ρ/ρ0).
- **CAS → Mach** (subsonic): qc = p0·[(1 + 0.2·(Vc/a0)²)^3.5 − 1]; M = √(5·[(qc/p + 1)^(2/7) − 1]); TAS = M·a.
- **Mach → CAS**: qc = p·[(1 + 0.2M²)^3.5 − 1]; Vc = a0·√(5·[(qc/p0 + 1)^(2/7) − 1]).
- Crossover altitude where a CAS equals a Mach: solve the CAS → Mach relation for p. Examples: 310 kt / M0.84 ≈ 31,560 ft (computed); 330 kt / M0.87 ≈ 30,476 ft [S8].
- Mach > 1 does not occur in this model. Pitot static error can be ignored.
- Wind: groundspeed vector = TAS vector (in the NED frame) + wind vector. Use the Dryden turbulence model (MIL-F-8785C) if needed.

## Sources
- [S1] Wikipedia, Boeing 777, Specifications (777-300ER): https://en.wikipedia.org/wiki/Boeing_777
- [S2] Boeing 777X airport brochure, 777-300ER comparison table: https://www.boeing.com/resources/boeingdotcom/commercial/airports/acaps/777Xbrochure.pdf (full 777-300ER ACAPS: https://www.boeing.com/resources/boeingdotcom/commercial/airports/acaps/777_2lr_3er_f.pdf; could not be fetched, so the ACAPS figures marked EST/ACAPS come from memory)
- [S3] Jenkinson, Simpkin & Rhodes, *Civil Jet Aircraft Design*, Data A table 4 (777 family): https://booksite.elsevier.com/9780340741528/appendices/data%2Da/table-4/table.htm
- [S4] Wikipedia, General Electric GE90: https://en.wikipedia.org/wiki/General_Electric_GE90
- [S5] UIUC/FlightGear B747 linear model (Heffley & Jewell NASA CR-2144 / Nelson App. B): https://de3mirror.flightgear.org/fgdata/fgdata_2024_1/Aircraft-uiuc/models/boeing747/linear.html; Cornell MAE5070 notes: https://courses.cit.cornell.edu/mae5070/mae5070Exer06.pdf
- [S6] PlaneFYI, nose-wheel steering (777-300ER ±70°, aft-axle ±8°): https://planefyi.com/systems/nose-wheel-steering/
- [S7] JCAB TADS No.611-4 (GE90 series): https://asims.cab.mlit.go.jp/fsdb/a_katashiki.nsf/8344a61f244404e6492574eb003898d6/ba674633d706237d492575b60023e22c/%24FILE/34307323.pdf/TADS_No.611-4%20%28GE90%20series%29%20rev.4.pdf; EASA TCDS IM.E.002: https://www.easa.europa.eu/nl/downloads/7799/en
- [S8] AVSIM thread quoting FAA TCDS T00001SE (VMO/MMO by variant): https://www.avsim.com/forums/topic/458015-bug-report-b777-300er-vmo/
- [S9] FlyAwaySimulation, 777 limits: https://forum.flyawaysimulation.com/forum/topic/1596/rpm-gauges
- [S10] Infinite Flight, flap limits: https://community.infiniteflight.com/t/flap-limits-for-infinite-flight-20-1-edition/453409
- [S11] https://community.infiniteflight.com/t/777-flap-speeds/635668
- [S12] Digital Avionics Handbook, 777 flight controls chapter (quoted): https://forums.parallax.com/uploads/attachments/52350/66781.pdf
- [S13] FlightGlobal, "Control functions": https://www.flightglobal.com/control-functions/16615.article
- [S14] US Patent 5,657,949, thrust asymmetry rudder compensation: https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/5657949
- [S15] SimViation/PPRuNe autobrake rates: https://forums.simviation.com/phpBB3/viewtopic.php?p=732019; FlightGear Autobrake: https://wiki.flightgear.org/Autobrake
