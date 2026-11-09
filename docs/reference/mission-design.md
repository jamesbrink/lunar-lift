# Mission design: is LUNAR LIFT completable?

**Yes, end to end, and it has been flown.** `tools/mission-sim.mjs` drives the shipped
`js/physics.js`, `js/vehicle.js` and `js/constants.js` with nothing but the controls a player has,
at the 0.1 s step `js/main.js` never exceeds, and reaches:

```
RESULT WON   fuel left 0.0/0.0/7.6 t        294122s TOUCHDOWN — 20.1 m/s. THE MOON IS OURS.
```

20.1 m/s against the `LAND_SAFE` limit of 32 m/s, 7.6 t of CSM propellant to spare, mission clock
3.404 days. The verdict is the game's own: `impact()` in `js/physics.js` decides it by comparing
`groundVel()` with `LAND_SAFE` in the frame of the surface underneath.

```sh
npm i --no-save three@0.187.0     # the tool needs Three; the game itself has no dependencies
node tools/mission-sim.mjs                       # solves the launch window, then flies: ~50 s
node tools/mission-sim.mjs game --phase=4.9561012  # fly the shipped window exactly, as shipped
node tools/mission-sim.mjs retro                 # the stack this repo shipped before: LOST
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
| **shipped** (above) | 3,433 | 17,090 | 1.13× | **WON**, 20.1 m/s, 7.6 t spare |
| previous (`retro`) | 3,780 | 16,303 | 1.08× | LOST — `HARD IMPACT ON THE MOON AT 1235 m/s`, tank dry |
| oversized (`nova`) | 5,475 | 20,608 | 1.36× | not flown: nothing the margin is spent on, and a 3,000 t first stage is a different game |

The previous stack is the instructive one. On paper it had 1.08× the requirement, it reached a
parking orbit, it executed TLI, it entered the lunar sphere of influence, it achieved lunar orbit at
200 km — and then it burnt the last of 400 t of CSM propellant on the descent and reached the
surface at 1,235 m/s. 1.08× of an ideal number is not a mission. The verification harness exists
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
| TLI ignition | 3,869 | at perigee, v 7.8918 | | |
| TLI cutoff | 4,681 | v 10.3980 commanded; apogee 384,202 km | | |
| **coast begins** | 4,685.1 | throttle run-down adds 2.5 m/s → v 10.4005 | **3,032** | 0 / 0 / 44.5 |
| lunar SOI | 232,147 | game log: PREPARE RETROGRADE BRAKING | | |
| periselene (uncorrected) | 290,369 | 169 km, vRel 2.4585, v∞ 0.9484 | | |
| **LOI** | 290,512 | retrograde at 183 km to vRel 1.6141 | **875** | 0 / 0 / 30.6 |
| parked | 290,512 | a = 1,957 km about the Moon | | |
| **deorbit burn** | 290,537 | retrograde at 185 km | **51** | 0 / 0 / 29.9 |
| **PDI** | 293,808 | 70 km, vRel 1.6611 | 1 | 0 / 0 / 29.9 |
| **touchdown** | 294,122 | 20.1 m/s | **2,003** | 0 / 0 / 7.6 |
| | | **total** | **16,226** | |

Margin, stated as the two different things it is: **864 m/s** of headroom between the ideal staged
budget (17,090) and what the flight actually spent (16,226), and **7.6 t** of propellant still in
the CSM tank at touchdown, which on the 18 t dry CSM is 4,119 × ln(25.6/18) = **1,444 m/s** of
capability nobody used. The two numbers differ because the ideal budget
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
*inside* the SOI, where the Moon's gravity does the rest. Measured result: apogee 384,202 km at the cutoff command, SOI
entry at 232,147 s, periselene 169 km with **no correction burns fired**. They were not available
either: the tool's mid-course machinery is gated on `fuel > 60 t` and the CSM holds 44.5 t after
TLI, so for this vehicle the aim has to be right at injection — which is what the HUD readout
described below is for.

Apollo flew harder than this — `mission-math.py` section 4 shows Apollo 11's post-TLI orbit with an
apogee of 522,505 km, a ~73 h fast transfer rather than the 120 h minimum-energy one. The game's
119.5 h-class coast is the patient version.

### Capture belongs at periselene

The `approach` phase coasts on nothing until the Moon-relative radial velocity changes sign, then
burns. Braking from the edge of the SOI instead spends the tank fighting your own approach energy
and still misses the orbit: at 66,200 km the circular speed is 272 m/s, so decelerating to bind
yourself early buys a huge eccentric fall instead of an orbit. At periselene the same Δv is worth
the most, which is why LOI cost 875 m/s here against the 820 m/s the patched-conic estimate for
111 km predicts and Apollo's measured 889 m/s.

## Launch window and how tight "aim" really is

`MOON_PHASE0 = 4.9561012` rad is not a rounded number and must not be rounded. The tool finds it by
bisecting the first periselene altitude. Sensitivity measured by flying the shipped configuration at
three phases around the window:

| phase rad | periselene | outcome |
| --- | --- | --- |
| 4.9551012 (−1e-3) | 304 km | WON, 21.2 m/s, 7.4 t spare |
| **4.9561012 (shipped)** | **169 km** | **WON, 20.1 m/s, 7.6 t spare** |
| 4.9571012 (+1e-3) | 37 km | WON, 16.4 m/s, 7.6 t spare |

So about **135 km of periselene per 1e-3 rad**, and roughly ±1e-3 rad of phase still lands: that
band is about ±6 s of lunar motion at `MOON_RATE = 2.6617e-6` rad/s. Two consequences for the game:

- The lever a player actually has is *time*: wait on the pad, or coast in the parking orbit, and warp
  until the geometry works. Small along-track correction burns would work too, and the tool has
  machinery for them, but it is gated on `fuel > 60 t` and the shipped CSM has 44.5 t left after
  TLI, so for this vehicle the encounter is decided at injection and cannot be repaired later.
- **Aim is now visible.** `js/targeting.js` propagates the live state forward through the same
  gravity the integrator uses and the orbit panel shows `lunar aim: 169 km in 79:21:19`, green inside
  the corridor the mission has been landed from (30–320 km, from the three flights above). It runs
  incrementally — a fixed step budget per frame, worst measured 3.5 ms, idle 0.0005 ms after it
  settles — and it re-seeds only when the engine has pushed the vehicle, when the predicted encounter
  has passed, or when the result has gone stale, because a coast does not change the answer.

### The readout predicts the game, not the textbook

Verified against the certified flights, from the recorded coast-start state of each of the three
phases above: the readout says **303.5 / 168.8 / 37.5 km** where the simulation reports **304 / 169 /
37 km** — under 0.5 km out on all three. It does that by reproducing the game's own discretisation:
`simTime += dt`, gravity at the advanced time, `v += a·dt`, `p += v·dt`, at `DTPHYS = 0.1 s`.

That choice was measured, not assumed. From the same state that the game flies to a 1,069.8 km
closest approach:

| propagation | predicted closest approach |
| --- | --- |
| the game's `physStep` at 0.1 s (ground truth) | 1,069.8 km |
| this module (game scheme at 0.1 s) | 1,069.6 km |
| velocity Verlet, converged to dt → 0.1 s | 1,170.2 km |
| the game scheme at 1 s | 201.6 km |

A converged integrator is *more* faithful to two-body mechanics and *less* faithful to this game, by
~100 km: the game samples the Moon 0.05 s off the state on every step, a coherent perturbation, and
a lunar flyby amplifies it. A readout that disagreed with the player's own trajectory by 100 km
would be worse than no readout at all.

### Why the coast step is not a free parameter

Until this was checked, the tool stepped the coast at 1 s and only used the game's 0.1 s cap during
powered flight and near bodies. That is ten times faster and it certified a trajectory **no player
can fly**: at the shipped phase, 1 s stepping aims at 203 km periselene and the game's own 0.1 s
substeps arrive at 21 km — an 870 km difference, which is six times the whole launch-window
tolerance. Every coast-derived number moved when the step was fixed: SOI entry 234,479 → 232,147 s,
LOI 869 → 875 m/s, parked semimajor axis 1,990 → 1,957 km, touchdown 20.2 → 20.1 m/s, and the window
itself 4.957230 → 4.9561012.

The mission still wins, and by about the same margin, because the landing physics was always at
0.1 s; it was the coast geometry that had been drifting. The rule the tool now states in its own
source: **the step is part of the trajectory.** `js/main.js` splits warp into substeps capped at
`DTPHYS`, so 0.1 s is the only step the game can produce, and anything that certifies a mission has
to use it.

`MOON_PHASE0` is solved for the `TURN` table in the same file. Change the pitch program without
re-running the tool and TLI mis-aims by tens of thousands of km: `--turn=steep` (the reach-horizontal
table `t0 60, ramp 200, max π/2`) needs phase **4.9745948**, 0.018 rad ≈ 2 h of lunar motion away,
and it wins with 8.0 t spare against the shipped table's 7.6 t.

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
| Reach the Moon | enter SOI | 232,147 s, periselene 169 km | ✅ |
| Lunar orbit | bound, circularisable | LOI to vRel 1.6141 at 183 km, a = 1,957 km | ✅ |
| Deorbit | periselene in the corridor | burn at 185 km, PDI at 70 km | ✅ |
| Soft landing | < 32 m/s (`LAND_SAFE`) | **20.1 m/s** | ✅ |
| Propellant margin | > 0 at touchdown | 7.6 t = 1,444 m/s unused | ✅ |
| One-way budget | ≥ 15,142 m/s | 17,090 ideal / 16,226 spent | ✅ |
| Return to Earth | 18,092 m/s | not modelled | ❌ |
