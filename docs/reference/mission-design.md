# Mission design: is LUNAR LIFT completable?

**Yes, end to end, and it has been flown.** `tools/mission-sim.mjs` drives the shipped
`js/physics.js`, `js/vehicle.js` and `js/constants.js` with nothing but the controls a player has,
at the 0.1 s step `js/main.js` never exceeds, and reaches:

```
RESULT WON   fuel left 0.0/0.0/7.4 t        298991s TOUCHDOWN — 4.2 m/s. THE MOON IS OURS.
```

4.2 m/s against the `LAND_SAFE` limit of 32 m/s, 7.4 t of CSM propellant to spare, mission clock
3.461 days. The verdict is the game's own: `impact()` in `js/physics.js` decides it by comparing
`groundVel()` with `LAND_SAFE` in the frame of the surface underneath, at the moment the lowest
attached point (`surfaceAlt()`) reaches the ground, and it also demands the vehicle be within 60° of
vertical. One caveat about what "the ground" is: in the browser it is the drawn relief; the
headless tool injects no terrain and lands on the datum sphere.

```sh
npm i --no-save three@0.187.0     # the tool needs Three; the game itself has no dependencies
node tools/mission-sim.mjs                       # solves the launch window, then flies: ~50 s
node tools/mission-sim.mjs game --phase=4.9198031  # fly the shipped window exactly, as shipped
node tools/mission-sim.mjs retro                 # the stack this repo shipped before: LOST
```

Everything below is measured output from those runs or from `tools/mission-math.py`, re-run after
the flight-model change (Mach drag rise, angle-of-attack forces, the indirect lunar term in
`gravityAt`; see [atmosphere.md](atmosphere.md) and [orbital-mechanics.md](orbital-mechanics.md)).
Nothing here is a estimate dressed as a measurement, and where a number is Apollo's rather than the
game's it is marked. A few figures come from short headless scripts that drive the same modules
rather than from a tool in `tools/`; each says so where it appears.

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
| **shipped** (above) | 3,433 | 17,090 | 1.13× | **WON**, 4.2 m/s, 7.4 t spare |
| previous (`retro`) | 3,780 | 16,303 | 1.08× | LOST — `HARD IMPACT ON THE MOON AT 1264 m/s`, tank dry |
| oversized (`nova`) | 5,475 | 20,608 | 1.36× | not flown: nothing the margin is spent on, and a 3,000 t first stage is a different game |

The previous stack is the instructive one. On paper it had 1.08× the requirement, it reached a
parking orbit, it executed TLI, it entered the lunar sphere of influence, it achieved lunar orbit at
199 km with 12.8 t left — and then it burnt the last of 400 t of CSM propellant 76 s into the powered
descent and reached the surface at 1,264 m/s. 1.08× of an ideal number is not a mission. The verification harness exists
because that failure is invisible to budget arithmetic.

## The flight, as measured

`node tools/mission-sim.mjs game --phase=4.9198031`. Velocities labelled `vRel` are Moon-relative
(`navVel()`); `vInert` is the game frame.

| Event | MET s | state | Δv spent m/s | propellant left t |
| --- | --- | --- | --- | --- |
| ignition, LC-39 | 0 | pad TWR 1.37 g | | 1,800 / 1,200 / 185 |
| stage 1 separation | 117 | game log: STAGE 1 SEPARATED | | 0 / 1,200 / 185 |
| stage 2 separation | 422 | game log: S-2 SATURN II DEPLETED | | 0 / 0 / 185 |
| **parking orbit** | 1,051 | 151 × 760 km, v 7.3706 km/s | **10,248** | 0 / 0 / 124.0 |
| TLI ignition | 3,827 | at perigee, v 7.8854 | | |
| TLI cutoff | 4,644 | v 10.3914 commanded; apogee 383,242 km | | |
| **coast begins** | 4,647.7 | throttle run-down adds 2.4 m/s → v 10.3938 | **3,039** | 0 / 0 / 44.7 |
| lunar SOI | 236,191 | game log: PREPARE RETROGRADE BRAKING | | |
| periselene (uncorrected) | 295,185 | 205 km, vRel 2.4327, v∞ 0.9317 | | |
| **LOI** | 295,327 | retrograde at 218 km to vRel 1.5993 | **865** | 0 / 0 / 30.9 |
| parked | 295,327 | a = 1,993 km about the Moon | | |
| **deorbit burn** | 295,357 | retrograde at 221 km | **58** | 0 / 0 / 30.1 |
| **PDI** | 298,671 | 70 km, vRel 1.6688 | 1 | 0 / 0 / 30.1 |
| **touchdown** | 298,991 | 4.2 m/s | **2,035** | 0 / 0 / 7.4 |
| | | **total** | **16,245** | |

Margin, stated as the two different things it is: **845 m/s** of headroom between the ideal staged
budget (17,090) and what the flight actually spent (16,245), and **7.4 t** of propellant still in
the CSM tank at touchdown, which on the 28 t that lands dry (18 t CSM + the 10 t `CAPSULE_MASS`) is
4,119 × ln(35.4/28) = **966 m/s** of capability nobody used. (This file used to quote 1,444 m/s
here; that figure left the capsule out of the mass ratio. The tool's own touchdown mass is 35 t.) The two numbers differ because the ideal budget
is a model with assumptions the flight does not honour — nothing is spent while the launch clamp
holds the vehicle on the pad, dry mass is dropped exactly at depletion rather than on the next
staging command, and the per-step integral charges Δv by propellant flow. Both numbers are honest;
neither is the other.

### Where the ascent Δv goes

The ascent spent 10,248 m/s of propellant-equivalent Δv to deliver 152 t into 151 × 760 km.
`mission-math.py` section 5 prices that manoeuvre — pad to a 185 km orbit, Apollo hardware,
sea-level Isp, nothing wasted — at 8,854 m/s, so gravity, drag and steering cost about
**1,394 m/s**. The same section derives Apollo 11's own loss from the SP-4029 ground-ignition
weights as 1,469–1,997 m/s. Two different vehicles and two different derivations land in the same
band, which is the check that the game is not handing out orbital velocity for free. The tool prints
this comparison every run; it deliberately compares against Apollo's derived cost rather than
against the staged ideal of its own stack, because those are different quantities that happen to
come out near each other, and pretending otherwise would be a coincidence dressed up as an
accounting identity.

Drag specifically is not a factor. Measured on the shipped SAS ascent by integrating the axial drag
deceleration `q · CD_AREA · machDrag(M) · cos²α / m` over every 0.1 s step (a headless script on
`js/physics.js`, not a tool in `tools/`): **24 m/s** lost to drag before S-2 burnout, peak
deceleration 0.45 m/s², max-Q 25.4 kPa at T+65 s, 10.9 km, Mach 1.3. The Mach rise and the angle of
attack together account for 5 of those 24 m/s; the same path priced at a constant `CD_AREA` is 19.
`mission-math.py` section 8 bounds the loss from above at ≤ 109 m/s for a constant `CD_AREA = 28` m²
(≤ 47 m/s at 12 m²) and ≤ 174 m/s with the drag rise held at its 1.6× peak throughout, because the
pitch program is above the dense air within two minutes. The exponential density model is a poor fit
to USSA-1976 above 100 km, but the error sits where the air is too thin to matter.

### Why TLI overshoots

The tool burns prograde until `v = sqrt(MU_E (2/r − 1/aT))` with `aT = (r + 1.012·MOON_DIST)/2`.
The 1.012 is not decoration: an exactly-tangent transfer whose apogee equals `MOON_DIST` came up
about 2,000 km short of the sphere of influence in testing and never registered an encounter, and
no correction burn can rescue a miss that large at 384,000 km. Overshooting puts the crossing
*inside* the SOI, where the Moon's gravity does the rest. Measured result: apogee 383,242 km at the
cutoff command, SOI entry at 236,191 s, periselene 205 km with **no correction burns fired**. They
were not available either: the tool's mid-course machinery is gated on `fuel > 60 t` and the CSM
holds 44.7 t after TLI, so for this vehicle the aim has to be right at injection — which is what the HUD readout
described below is for.

Apollo flew harder than this — `mission-math.py` section 4 shows Apollo 11's post-TLI orbit with an
apogee of 522,505 km, a ~73 h fast transfer rather than the 120 h minimum-energy one. The game sits
between the two: **80.7 h** from coast start (4,647.7 s) to periselene (295,185 s), measured. The
383,242 km apogee the tool prints belongs to the cutoff *command*; the engine keeps pushing through
the ~4 s run-down while the radius grows, and the two-body apogee of the coast-start state the tool
records (`ev.tliDone`) works out to about 432,700 km altitude — computed by hand from that state,
not printed by the tool. This file used to call the coast "119.5 h-class"; no run ever showed that.

### Capture belongs at periselene

The `approach` phase coasts on nothing until the Moon-relative radial velocity changes sign, then
burns. Braking from the edge of the SOI instead spends the tank fighting your own approach energy
and still misses the orbit: at 66,200 km the circular speed is 272 m/s, so decelerating to bind
yourself early buys a huge eccentric fall instead of an orbit. At periselene the same Δv is worth
the most, which is why LOI cost 865 m/s here (at 218 km) against the 820 m/s the patched-conic
estimate for 111 km predicts and Apollo's measured 889 m/s.

## Launch window and how tight "aim" really is

`MOON_PHASE0 = 4.9198031` rad is not a rounded number and must not be rounded. The tool finds it by
bisecting the first periselene altitude. Sensitivity measured by flying the shipped configuration at
eight phases around the window:

| phase rad | periselene | outcome | touchdown | spare | Δv spent |
| --- | --- | --- | --- | --- | --- |
| 4.9168031 (−3e-3) | 597 km | WON | 2.6 m/s | 6.8 t | 16,319 m/s |
| 4.9178031 (−2e-3) | 464 km | WON | 2.8 m/s | 7.0 t | 16,296 m/s |
| 4.9188031 (−1e-3) | 334 km | WON | 3.4 m/s | 7.2 t | 16,272 m/s |
| **4.9198031 (shipped)** | **205 km** | **WON** | **4.2 m/s** | **7.4 t** | **16,245 m/s** |
| 4.9200531 (+0.25e-3) | 173 km | WON | 4.4 m/s | 7.5 t | 16,238 m/s |
| 4.9203031 (+0.5e-3) | 142 km | WON | 4.8 m/s | 7.6 t | 16,232 m/s |
| 4.9205531 (+0.75e-3) | 110 km | **LOST** | 81 m/s | 0.2 t | 17,184 m/s |
| 4.9208031 (+1e-3) | 79 km | **LOST** | 72 m/s | 0.4 t | 17,157 m/s |

So about **130 km of periselene per 1e-3 rad**, and the window is **a slope on one side and a cliff
on the other**. Early (a higher periselene) costs a little propellant per hundred kilometres and
nothing else, out to at least −3e-3 rad. Late, the shipped window sits **0.5e-3 rad — about three
minutes of lunar motion at `MOON_RATE = 2.6617e-6` rad/s (1e-3 rad is 376 s; this file used to say
"±6 s", a slip for minutes), 63 km of periselene — from the last flight that lands.** At a 110 km
periselene the LOI burn finishes at 124 km, the tool's deorbit phase is skipped, and the descent
starts from orbit height and speed with no transfer ellipse: it spends 3,020 m/s against 2,035 at
the window, runs the tank down to 0.2 t and still arrives at 81 m/s.
That is a statement about this autopilot's descent, not about the Moon — a pilot who brakes
differently may land from lower — but it is the only landing anyone has measured. Where exactly
between 142 and 110 km the edge lies has not been bisected. Two consequences for the game:

- The lever a player actually has is *time*: wait on the pad, or coast in the parking orbit, and warp
  until the geometry works. Small along-track correction burns would work too, and the tool has
  machinery for them, but it is gated on `fuel > 60 t` and the shipped CSM has 44.7 t left after
  TLI, so for this vehicle the encounter is decided at injection and cannot be repaired later.
- **Aim is visible.** `js/targeting.js` propagates the live state forward through the same gravity
  the integrator uses and the orbit panel shows it as `<km> km in <hh:mm:ss>`. From the shipped
  coast-start state the module's values are 204.4 km and MET 295,185.5 s, which the HUD's own
  formatting renders as `204 km in 80:42:17` (run headless; the string on screen has not been
  re-read in a browser since the window moved). It is painted green inside
  `CORRIDOR = { lo: 140, hi: 600 }` km, which is the table above: every flight from 142 to 597 km
  landed, and the band stops at the last one that did rather than at a guess between 142 and 110.
  The module's own values for the −1e-3 and +1e-3 rad flights are 332.9 km (green, landed) and
  78.3 km (red, lost).
  The module runs incrementally — a fixed step budget per frame, 865 `updateAim()` calls from coast
  start to `done` — and it re-seeds only when the engine has pushed the vehicle, when the predicted
  encounter has passed, or when the result has gone stale, because a coast does not change the
  answer. Its per-frame cost (previously 3.5 ms worst, 0.0005 ms idle, in a browser) has not been
  re-timed; `gravityAt` gained one term.

### The readout predicts the game, not the textbook

Verified against the certified flights, from the recorded coast-start state (`ev.tliDone`, which is
the same for every phase — only the Moon moves): for the −1e-3, shipped and +1e-3 rad flights the
module says **332.9 / 204.4 / 78.3 km** where the simulation reports **334 / 205 / 79 km**. The tool prints whole kilometres from the
unrounded state and the module was seeded with the state as printed (1 m, 1 mm/s, 1 ms), so "within
about 1 km" is all that comparison can claim. The sharper check is against the integrator itself: a
real `physStep` coast from that same printed state reaches **204.43 km**, and so does the module.
Run headless in Node with the shipped modules; nothing here was read off a browser HUD. It does that
by reproducing the game's own discretisation: `simTime += dt`, gravity at the advanced time,
`v += a·dt`, `p += v·dt`, at `DTPHYS = 0.1 s`.

That choice was measured, not assumed. From the shipped coast-start state:

| propagation | predicted closest approach |
| --- | --- |
| the game's `physStep` at 0.1 s (ground truth) | 204.43 km |
| this module (game scheme at 0.1 s) | 204.43 km |
| velocity Verlet at 0.1 s (300.4 km at 1 s — converged) | 299.9 km |
| the game scheme at 1 s | −589.7 km (an impact) |

A converged integrator is *more* faithful to two-body mechanics and *less* faithful to this game, by
~95 km: the game samples the Moon 0.05 s off the state on every step, a coherent perturbation, and
a lunar flyby amplifies it. A readout that disagreed with the player's own trajectory by 95 km
would be worse than no readout at all.

### Why the coast step is not a free parameter

Until this was checked, the tool stepped the coast at 1 s and only used the game's 0.1 s cap during
powered flight and near bodies. That is ten times faster and it certified a trajectory **no player
can fly**. With the current forces the same experiment, from the shipped coast-start state: the
game's scheme at 0.1 s reaches 204 km and at 1 s it is 590 km *under the surface* — a 794 km
difference, nearly twice the width of the whole 140–600 km corridor. (When the step was first fixed, at the
physics of that date, every coast-derived number moved: SOI entry 234,479 → 232,147 s, LOI 869 →
875 m/s, parked semimajor axis 1,990 → 1,957 km, touchdown 20.2 → 20.1 m/s, and the window itself
4.957230 → 4.9561012. Those are history now; none of them is a current value.)

The mission still wins, and by about the same margin, because the landing physics was always at
0.1 s; it was the coast geometry that had been drifting. The rule the tool now states in its own
source: **the step is part of the trajectory.** `js/main.js` splits warp into substeps capped at
`DTPHYS`, so 0.1 s is the only step the game can produce, and anything that certifies a mission has
to use it.

`MOON_PHASE0` is solved for the `TURN` table in the same file. Change the pitch program without
re-running the tool and TLI mis-aims by tens of thousands of km: `--turn=steep` (the reach-horizontal
table `t0 60, ramp 200, max π/2`) needs phase **4.9472816**, 0.027 rad ≈ 2.9 h of lunar motion away,
and it wins with 7.9 t spare for 16,190 m/s (touchdown 3.8 m/s) against the shipped table's 7.4 t
and 16,245.

The same is true of the forces. The flight-model change — a drag rise that reshapes the ascent, and
the indirect term in `gravityAt` that acts through the whole 80 h coast — moved the solved window
from 4.9561012 to 4.9198031: 0.036 rad, more than 70 times the 0.5e-3 rad that now separates the
window from the last late flight that lands. Any change to
`js/aero.js`, `GEOM`, `CD_AREA` or `gravityAt` needs the tool re-run and the constant replaced.

## The descent, which is where the mission was won

Terminal guidance, from the tool's `descend` phase:

```
a_cmd = (v_des − v)/τ + dv_des/dt − g_abs + g_moon          τ = 2.5 s
|v_r| ≤ min( sqrt(2 a_v h), 0.35 km/s, 0.06 h )             a_v = 0.35 a_max − g_moon
|v_t| ≤ min( |v_t|,      sqrt(2 a_h h · 0.8), 0.05 h )      a_h = 0.40 a_max
```

with `h` the altitude above the Moon, the commanded acceleration slewed by the body-rate channel
exactly as the game's own SAS does it, and the engine cut at 3 m (the last 3 metres fall at
≈ 3 m/s, well inside `LAND_SAFE`). `h` is `surfaceAlt()` — the engine bell over the surface, the
same number contact is judged by. It used to be the altitude of `S.pos`, the middle of the *full*
stack, while contact was declared when `S.pos` came within the full stack's half-height (52 m) of
the surface: the guidance met "the ground" while still reading 52 m of altitude, and every
touchdown before this fix came in near 20 m/s. With the heights agreeing the shipped flight touches at **4.2 m/s**.

Four things had to be true before it stopped crashing, each one measured:

- **Do not aim at the ground beneath you, or at a downrange point.** An aim point recomputed from
  the current speed never collapses, and the straight-line path to a point on a sphere meets the
  ground short of it. One attempt hit at 1,000 m/s with a nominal guidance error of 2 m/s² — the
  guidance was working perfectly and the geometry was wrong. Braking from 1.67 km/s needs ~200 km of
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

Powered descent cost 2,035 m/s — 2,094 with the 58 m/s deorbit burn and the 1 m/s spent reaching
PDI — against Apollo's derived 2,300 m/s for deorbit plus powered descent (PDI at 1,696 m/s plus
gravity losses). PDI sits at 70 km here rather than Apollo's 11.9 km / 1,696 m/s,
because the envelope above needs path, not because it is more realistic.

## What is not true yet

- **No way home.** The mission ends at touchdown. Lunar ascent and TEI are not modelled, so the
  18,092 m/s round-trip figure is a reference number, not a game target.
- **The Moon is parametric** (`constants.js` `moonPos`/`moonVel`): a circular 384,400 km orbit in
  the launch plane at the sidereal rate. Real ephemerides would come from `astronomy-engine`; see
  [libraries.md](libraries.md) for why the integrator stays hand-written and what adopting it buys.
- **The window sits near the corridor's cliff.** The shipped phase is 0.5e-3 rad from the last
  measured landing on the late side (see the window section); `MOON_PHASE0` is solved for a 200 km
  periselene, not for the middle of the band that lands. Nothing marks the launch window itself
  either.
- **Headless landings are on a smooth Moon.** The tool injects no relief; the browser lands on the
  drawn terrain. No headless number here says anything about a slope.
- **The air's density is one exponential**, not USSA-1976 + MSISE-90; `mission-math.py` section 7
  has the tables and section 8 bounds drag's whole effect at ≤ 174 m/s (24 m/s measured).
- **The flight model is coarse.** Coefficients are textbook orders of magnitude, body lift is lumped
  at the planform centroid so the vehicle is statically stable where Apollo's was not, and there is
  no heating. See [atmosphere.md](atmosphere.md).
- **The pad sits in near-shore water in the texture, not because the coordinates are wrong.**
  `PAD_LAT`/`PAD_LON` are now the geocentric LC-39 values (28.4469, −80.6041), and the texture's
  alignment with the mapping was measured at IoU 0.954 against Natural Earth with zero offset. But
  the committed 2048 × 1024 sheet resolves 17 km per pixel and its Florida coastline runs to
  −80.68° where the real shore is near −80.55°, so the pad's pixel is sea at any LC-39 latitude
  anyone could argue for. A sharper sheet fixes the look; changing the coordinates would move the
  pad off the launch complex to agree with a pixel. See [launch-site.md](launch-site.md).
- **One structural load, and it is lateral.** The stack breaks up above 0.5 g of aerodynamic side
  load (6 g for the bare CSM); the SAS ascent peaks at 0.024 g. There is no axial or max-Q limit, so
  nothing punishes an over-fast ascent flown nose-on beyond drag.

## Status

| Requirement | Value | Measured | |
| --- | --- | --- | --- |
| Reach a parking orbit | pe ≥ 150 km | 151 × 760 km at 7.3706 km/s | ✅ |
| Reach the Moon | enter SOI | 236,191 s, periselene 205 km | ✅ |
| Lunar orbit | bound, circularisable | LOI to vRel 1.5993 at 218 km, a = 1,993 km | ✅ |
| Deorbit | periselene in the corridor | burn at 221 km, PDI at 70 km | ✅ |
| Soft landing | < 32 m/s (`LAND_SAFE`), within 60° of vertical | **4.2 m/s** | ✅ |
| Propellant margin | > 0 at touchdown | 7.4 t = 966 m/s unused | ✅ |
| One-way budget | ≥ 15,142 m/s | 17,090 ideal / 16,245 spent | ✅ |
| Survive the air | side load < 0.5 g | 0.024 g peak on the SAS ascent | ✅ |
| Return to Earth | 18,092 m/s | not modelled | ❌ |
