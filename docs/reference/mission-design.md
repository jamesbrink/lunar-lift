# Mission design: is LUNAR LIFT completable?

**Yes, end to end, and it has been flown.** `tools/mission-sim.mjs` drives the shipped
`js/physics.js`, `js/vehicle.js` and `js/constants.js` with nothing but the controls a player has,
at the 0.1 s step `js/main.js` never exceeds, and reaches:

```
RESULT WON   fuel left 0.0/0.0/7.5 t        296869s TOUCHDOWN — 20.2 m/s. THE MOON IS OURS.
```

20.2 m/s against the `LAND_SAFE` limit of 32 m/s, 7.5 t of CSM propellant to spare, mission clock
3.436 days. The verdict is the game's own: `impact()` in `js/physics.js` decides it by comparing
`groundVel()` with `LAND_SAFE` in the frame of the surface underneath.

```sh
npm i --no-save three@0.160.1     # the tool needs Three; the game itself has no dependencies
node tools/mission-sim.mjs                      # solves the launch window, then flies: ~6 s
node tools/mission-sim.mjs game --phase=4.95723 # fly the shipped window exactly, as shipped
node tools/mission-sim.mjs retro                # the stack this repo shipped before: LOST
```

Everything below is measured output from those runs or from `tools/mission-math.py`. Nothing here
is a estimate dressed as a measurement, and where a number is Apollo's rather than the game's it is
marked.

## The requirement

`tools/mission-math.py` section 5 derives it from Apollo 11's own flight tables
([apollo-11-profile.md](apollo-11-profile.md)), ideal rocket equation, no losses:

| Leg | Δv m/s | Running |
| --- | --- | --- |
| pad → 185 km parking orbit | 8,854 | 8,854 |
| trans-lunar injection | 3,050 | 11,904 |
| lunar orbit insertion | 889 | 12,793 |
| circularise at 60 nmi | 48 | 12,842 |
| deorbit + powered descent | 2,300 | **15,142** |
| + lunar ascent 1,850 + TEI ≈ 1,100 | | 18,092 round trip |

The game's win condition is the **landing**, so 15,142 m/s is the number the vehicle has to beat.
The return leg is not modelled: there is no lunar ascent stage and no TEI in the game, and
pretending otherwise would be the easiest way to hide a propellant shortfall.

## The vehicle

`js/constants.js` `SPECS`, verified by the run above (see the comment there for the sizing
reasoning, and `mission-math.py` section 6 for the arithmetic):

| Stage | dry t | propellant t | thrust kN | Isp s | ideal Δv m/s | TWR at ignition |
| --- | --- | --- | --- | --- | --- | --- |
| S-1 SATURN I | 130 | 1,800 | 46,000 | 304 | 2,215 | 1.37 g |
| S-2 SATURN II | 90 | 1,200 | 16,000 | 415 | 6,518 | 1.09 g |
| CSM ENGINE | 18 | 185 | 400 | 420 | 8,357 | 0.19 g (Earth) / 4.2 g_moon |

Ignition mass 3,433 t; ideal staged budget **17,090 m/s = 1.13× the requirement**.

| Candidate | ignition t | ideal Δv m/s | ratio | outcome when flown |
| --- | --- | --- | --- | --- |
| **shipped** (above) | 3,433 | 17,090 | 1.13× | **WON**, 20.2 m/s, 7.5 t spare |
| previous (`retro`) | 3,780 | 16,303 | 1.08× | LOST — `HARD IMPACT ON THE MOON AT 1233 m/s`, tank dry |
| oversized (`nova`) | 5,475 | 20,608 | 1.36× | not flown: nothing the margin is spent on, and a 3,000 t first stage is a different game |

The previous stack is the instructive one. On paper it had 1.08× the requirement, it reached a
parking orbit, it executed TLI, it entered the lunar sphere of influence, it achieved lunar orbit at
200 km — and then it burnt the last of 400 t of CSM propellant on the descent and reached the
surface at 1,233 m/s. 1.08× of an ideal number is not a mission. The verification harness exists
because that failure is invisible to budget arithmetic.

## The flight, as measured

`node tools/mission-sim.mjs game --phase=4.95592`. Velocities labelled `vRel` are Moon-relative
(`navVel()`); `vInert` is the game frame.

| Event | MET s | state | Δv spent m/s | propellant left t |
| --- | --- | --- | --- | --- |
| ignition, LC-39 | 0 | pad TWR 1.37 g | | 1,800 / 1,200 / 185 |
| stage 1 separation | ~117 s burn | `mission-math.py` §6 burn time | | 0 / 1,200 / 185 |
| stage 2 separation | 422 | game log: S-2 SATURN II DEPLETED | | 0 / 0 / 185 |
| **parking orbit** | 1,057 | 150 × 784 km, v 7.3572 km/s | **10,265** | 0 / 0 / 123.4 |
| TLI ignition | 3,874 | at perigee, v 7.8916 | | |
| **TLI cutoff** | 4,686 | v 10.3932, apogee 385,295 km | **3,033** | 0 / 0 / 44.5 |
| lunar SOI | 234,479 | game log: PREPARE RETROGRADE BRAKING | | |
| periselene (uncorrected) | 293,071 | 203 km, vRel 2.4375, v∞ 0.9409 | | |
| **LOI** | 293,213 | retrograde to vRel 1.6000 (circular 1.5900) | **869** | 0 / 0 / 30.7 |
| parked | 293,213 | a = 1,990 km about the Moon | | |
| **deorbit burn** | 293,242 | retrograde at 219 km | **57** | 0 / 0 / 29.9 |
| **PDI** | 296,555 | 70 km, vRel 1.6683 | 1 | 0 / 0 / 29.9 |
| **touchdown** | 296,869 | 20.2 m/s | **2,008** | 0 / 0 / 7.5 |
| | | **total** | **16,233** | |

Margin, stated as the two different things it is: **857 m/s** of headroom between the ideal staged
budget (17,090) and what the flight actually spent (16,233), and **7.5 t** of propellant still in
the CSM tank at touchdown, which at the 35.5 t terminal mass is 4,121 × ln(35.5/28.0) =
**981 m/s** of capability nobody used. The two numbers differ by ~120 m/s because the ideal budget
is a model with assumptions the flight does not honour — nothing is spent while the launch clamp
holds the vehicle on the pad, dry mass is dropped exactly at depletion rather than on the next
staging command, and the per-step integral charges Δv by propellant flow. Both numbers are honest;
neither is the other.

### Where the ascent Δv goes

The ascent spent 10,265 m/s of propellant-equivalent Δv to deliver 151 t into 150 × 784 km.
`mission-math.py` section 5 prices that manoeuvre — pad to a 185 km orbit, Apollo hardware,
sea-level Isp, nothing wasted — at 8,854 m/s, so gravity, drag and steering cost about
**1,411 m/s**. The same section derives Apollo 11's own loss from the SP-4029 ground-ignition
weights as 1,469–1,997 m/s. Two different vehicles and two different derivations land in the same
band, which is the check that the game is not handing out orbital velocity for free. The tool prints
this comparison every run; it deliberately compares against Apollo's derived cost rather than
against the staged ideal of its own stack, because those are different quantities that happen to
come out near each other, and pretending otherwise would be a coincidence dressed up as an
accounting identity.

Drag specifically is not a factor: `mission-math.py` section 8 bounds it at ≤ 109 m/s for the
game's `CD_AREA = 28` m² (≤ 47 m/s at 12 m²), because the pitch program is above the dense air
within two minutes. The exponential density model is a poor fit to USSA-1976 above 100 km, but the
error sits where the air is too thin to matter.

### Why TLI overshoots

The tool burns prograde until `v = sqrt(MU_E (2/r − 1/aT))` with `aT = (r + 1.012·MOON_DIST)/2`.
The 1.012 is not decoration: an exactly-tangent transfer whose apogee equals `MOON_DIST` came up
about 2,000 km short of the sphere of influence in testing and never registered an encounter, and
no correction burn can rescue a miss that large at 384,000 km. Overshooting puts the crossing
*inside* the SOI, where the Moon's gravity does the rest. Measured result: apogee 385,295 km, SOI
entry at 234,479 s, periselene 203 km with **zero correction burns** needed.

Apollo flew harder than this — `mission-math.py` section 4 shows Apollo 11's post-TLI orbit with an
apogee of 522,505 km, a ~73 h fast transfer rather than the 120 h minimum-energy one. The game's
119.5 h-class coast is the patient version.

### Capture belongs at periselene

The `approach` phase coasts on nothing until the Moon-relative radial velocity changes sign, then
burns. Braking from the edge of the SOI instead spends the tank fighting your own approach energy
and still misses the orbit: at 66,200 km the circular speed is 272 m/s, so decelerating to bind
yourself early buys a huge eccentric fall instead of an orbit. At periselene the same Δv is worth
the most, which is why LOI cost 869 m/s here against the 820 m/s the patched-conic estimate for
111 km predicts and Apollo's measured 889 m/s.

## Launch window and how tight "aim" really is

`MOON_PHASE0 = 4.957230` rad is not a rounded number and must not be rounded. The tool finds it by
bisecting the first periselene altitude. Sensitivity measured by flying the shipped configuration at
three phases around the window:

| phase rad | first periselene | outcome |
| --- | --- | --- |
| 4.95623 (−1e-3) | 334 km | WON, 21.3 m/s, 7.3 t spare |
| **4.95723 (shipped)** | **203 km** | **WON, 20.2 m/s, 7.5 t spare** |
| 4.95823 (+1e-3) | 74 km | WON, 29.9 m/s, 4.4 t spare — inside `LAND_SAFE` by 2 m/s |

So about **130 km of periselene per 1e-3 rad**, and roughly ±1e-3 rad of phase still lands: the last
10 km of aim is 8e-5 rad, which is 3 s of lunar motion at `MOON_RATE = 2.6617e-6` rad/s. Two
consequences for the game:

- The lever a player actually has is *time* (wait on the pad, or coast in the parking orbit, and
  warp until the geometry works) plus small along-track correction burns. The tool's `mcc` phase
  closes an arbitrary first-periselene error with up to four finite-difference burns of ≤ 30 m/s
  each, and at the solved window it needed none of them.
- **Aim is currently invisible.** Nothing on the HUD predicts the periselene of the trajectory you
  are on, so hitting the window by hand is guesswork. The forward model already exists — the tool's
  `predictPeri()` propagates the current state through `gravityAt()` for ~2 min of CPU per look-ahead
  — and a HUD readout of "predicted periselene: NNNN km" is the single change that would make this
  flyable by a human without a solver. Logged as a HUD task; not implemented.

`MOON_PHASE0` is solved for the `TURN` table in the same file. Change the pitch program without
re-running the tool and TLI mis-aims by tens of thousands of km: `--turn=steep` (the
reach-horizontal table `t0 60, ramp 200, max π/2`) needs phase **4.97632**, 0.019 rad ≈ 2 h of lunar
motion away, and it wins with 8.0 t spare against the shipped table's 7.5 t.

## The descent, which is where the mission was won

Terminal guidance, from the tool's `descend` phase:

```
a_cmd = (v_des − v)/τ + dv_des/dt − g_abs + g_moon          τ = 2.5 s
|v_r| ≤ min( sqrt(2 a_v h), 0.35 km/s, 0.06 h )             a_v = 0.35 a_max − g_moon
|v_t| ≤ min( |v_t|,      sqrt(2 a_h h · 0.8), 0.05 h )      a_h = 0.40 a_max
```

with `h` the altitude above the Moon, the commanded acceleration slewed by the body-rate channel
exactly as the game's own SAS does it, and the engine cut at 3 m (the last 3 metres fall at
≈ 3 m/s, well inside `LAND_SAFE`).

Four things had to be true before it stopped crashing, each one measured:

- **Do not aim at the ground beneath you, or at a downrange point.** An aim point recomputed from
  the current speed never collapses, and the straight-line path to a point on a sphere meets the
  ground short of it. One attempt hit at 1,000 m/s with a nominal guidance error of 2 m/s² — the
  guidance was working perfectly and the geometry was wrong. Braking from 1.69 km/s needs ~200 km of
  path, which is more than the last 70 km of altitude contains. Bounding each velocity axis by
  altitude instead makes a terrain impact impossible *by construction*.
- **Rate floors must tighten with altitude.** A 300 m/s vertical floor held until 3 km and arrived
  at 220 m/s. The `sqrt(2 a h)` form is the braking distance you can still afford at this
  acceleration, so it hands down to the creep law (`0.06 h`, i.e. 6 m/s at 100 m) on its own.
- **Feedforward the derivative of the commanded velocity.** Without `dv_des/dt` the loop is first
  order and trails its own target by `a·τ`; over the last kilometre that is the 20–40 m/s that
  reached the surface. Two runs impacted at 41 and 62 m/s for want of that one term.
- **Command attitude the way the game commands attitude.** Body-frame error `err = q⁻¹ q_target`,
  negate when `w < 0` for the shortest arc, rate limit `0.85 × MAX_RATE_PY = 0.45 rad/s`, smooth
  with `k = min(0.9, 1.2·ratio·dt)`. Writing `S.q` directly — or computing the error in the world
  frame — claimed authority the attitude control does not have: alignment went to −0.93 and the
  vehicle accelerated sideways instead of braking.

Descent cost 2,008 m/s against Apollo's derived 2,300 m/s for the equivalent manoeuvre (PDI at
1,696 m/s plus gravity losses). PDI sits at 70 km here rather than Apollo's 11.9 km / 1,696 m/s,
because the envelope above needs path, not because it is more realistic.

## What is not true yet

- **No way home.** The mission ends at touchdown. Lunar ascent and TEI are not modelled, so the
  18,092 m/s round-trip figure is a reference number, not a game target.
- **The Moon is parametric** (`constants.js` `moonPos`/`moonVel`): a circular 384,400 km orbit in
  the launch plane at the sidereal rate. Real ephemerides would come from `astronomy-engine`; see
  [libraries.md](libraries.md) for why the integrator stays hand-written and what adopting it buys.
- **The HUD cannot show predicted periselene**, which is what stands between this mission and a
  human flying it reliably (see the window section).
- **Drag is exponential**, not USSA-1976 + MSISE-90; `mission-math.py` section 7 has the tables and
  section 8 bounds the error's effect at ≤ 109 m/s.
- **The pad sits in near-shore water in the texture, not because the coordinates are wrong.**
  `PAD_LAT`/`PAD_LON` are now the geocentric LC-39 values (28.4469, −80.6041), and the texture's
  alignment with the mapping was measured at IoU 0.954 against Natural Earth with zero offset. But
  the committed 2048 × 1024 sheet resolves 17 km per pixel and its Florida coastline runs to
  −80.68° where the real shore is near −80.55°, so the pad's pixel is sea at any LC-39 latitude
  anyone could argue for. A sharper sheet fixes the look; changing the coordinates would move the
  pad off the launch complex to agree with a pixel. See [launch-site.md](launch-site.md).
- **No atmospheric structural loads**, so nothing punishes an over-fast ascent beyond drag.

## Status

| Requirement | Value | Measured | |
| --- | --- | --- | --- |
| Reach a parking orbit | pe ≥ 150 km | 150 × 784 km at 7.3572 km/s | ✅ |
| Reach the Moon | enter SOI | 234,479 s, periselene 203 km | ✅ |
| Lunar orbit | bound, circularisable | LOI to vRel 1.6000 at 216 km, a = 1,990 km | ✅ |
| Deorbit | periselene in the corridor | burn at 219 km, PDI at 70 km | ✅ |
| Soft landing | < 32 m/s (`LAND_SAFE`) | **20.2 m/s** | ✅ |
| Propellant margin | > 0 at touchdown | 7.5 t = 981 m/s unused | ✅ |
| One-way budget | ≥ 15,142 m/s | 17,090 ideal / 16,233 spent | ✅ |
| Return to Earth | 18,092 m/s | not modelled | ❌ |
