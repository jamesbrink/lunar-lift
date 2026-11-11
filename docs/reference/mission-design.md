# Mission design: is LUNAR LIFT completable?

**Yes — the whole round trip, and it has been flown.** `tools/mission-sim.mjs` drives the shipped
`js/physics.js`, `js/vehicle.js` and `js/constants.js` with nothing but the controls a player has,
at the 0.1 s step `js/main.js` never exceeds, and reaches:

```
RESULT WON   fuel left 0.0/0.0/0.0/0.0/0.0 t        893597s SPLASHDOWN — 7.8 m/s
```

Lunar touchdown 3.8 m/s at 26.6° tilt (`LAND_SAFE` is 32 m/s), docking 603,456 s into the trip with
2.4 t of ascent-stage propellant left, splashdown 7.8 m/s against `SAFE_EARTH`'s 12, mission clock
10.343 days. The previous one-way mission is kept as a regression:
`landed --phase=4.9187044` still touches down at 3.3 m/s with 7.2 t spare in 3.469 days.
The verdicts are the game's own: `impact()` in `js/physics.js` decides the landing by comparing
`groundVel()` with `LAND_SAFE` in the frame of the surface underneath, at the moment the lowest
attached point (`surfaceAlt()`) reaches the ground, and it also demands the vehicle be within 60° of
vertical; splashdown decides the return. One caveat about what "the ground" is: in the browser it is
the drawn relief; the headless tool injects no terrain and lands on the datum sphere.

```sh
npm i --no-save three@0.187.0     # the tool needs Three; the game itself has no dependencies
node tools/mission-sim.mjs                         # solves the launch window, then flies: ~50 s
node tools/mission-sim.mjs game --phase=2.1777643  # fly the shipped window exactly, as shipped
node tools/mission-sim.mjs landed --phase=4.9187044  # the previous one-way mission: still WON
node tools/mission-sim.mjs retro                   # the stack this repo shipped before: LOST
```

Everything below is measured output from those runs or from `tools/mission-math.py`, re-run after
the flight-model change (Mach drag rise, angle-of-attack forces, the indirect lunar term in
`gravityAt`; see [atmosphere.md](atmosphere.md) and [orbital-mechanics.md](orbital-mechanics.md))
and after the window was re-centred on a 350 km periselene.
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

The game's three-star outcome is still the **landing**, so 15,142 m/s is what a one-way flight has
to beat — but the game now flies the whole 18,092 m/s round trip: a lunar module separates from the
parked command module, touches down, ascends, docks, and takes the mated stack home to a
splashdown. The table's last line — "lunar ascent 1,850 + TEI ≈ 1,100" — is modelled by dedicated
hardware (`LM ASCENT` in `SPECS`, and the CSM engine for the trans-Earth injection) and flown; the
bookkeeping is in the flight table below.

## The vehicle

`js/constants.js` `SPECS`, verified by the run above (see the comment there for the sizing
reasoning, and `mission-math.py` section 6 for the arithmetic):

| Stage | dry t | propellant t | thrust kN | Isp s | ideal Δv m/s | TWR at ignition |
| --- | --- | --- | --- | --- | --- | --- |
| S-1 SATURN I | 130 | 2,500 | 62,000 | 304 | 2,129 | 1.29 g |
| S-2 SATURN II | 90 | 1,800 | 24,000 | 415 | 6,423 | 1.08 g |
| CSM ENGINE | 18 | 300 | 650 | 440 | 6,810 | 0.18 g (Earth) |
| LM DESCENT | 5 | 26 | 380 | 380 | 2,117 | 0.65 g_moon |
| LM ASCENT | 4 | 15 | 180 | 380 | 2,714 | 0.63 g_moon |

Ignition mass 4,898 t; ideal staged budget **20,192 m/s = 1.33× the 15,142 m/s one-way
requirement, 1.12× the 18,092 m/s round trip**.

| Candidate | ignition t | ideal Δv m/s | ratio | outcome when flown |
| --- | --- | --- | --- | --- |
| **shipped** (above) | 4,898 | 20,192 | 1.33× | **WON** — round trip: LM touchdown 3.8 m/s, dock, splashdown 7.8 m/s, 19,802 m/s in 10.343 days |
| previous (`retro`) | 3,780 | 16,303 | 1.08× | LOST — `HARD IMPACT ON THE MOON AT 1264 m/s`, tank dry |
| oversized (`nova`) | 5,525 | 21,543 | 1.42× | **WON** — self-solved round trip at phase 1.2294908: LM awarded 2.8 m/s, splashdown 7.8 m/s, 20,733 m/s in 13.484 days |

The previous stack is the instructive one. On paper it had 1.08× the requirement, it reached a
parking orbit, it executed TLI, it entered the lunar sphere of influence, it achieved lunar orbit at
199 km with 12.8 t left (flown at `--phase=1.4742618`, the window solved for it when the tool aimed
at 200 km) — and then it burnt the last of 400 t of CSM propellant 76 s into the powered
descent and reached the surface at 1,264 m/s. 1.08× of an ideal number is not a mission. The verification harness exists
because that failure is invisible to budget arithmetic.

## The flight, as measured

`node tools/mission-sim.mjs game --phase=2.1777643`. Velocities labelled `vRel` are Moon-relative
(`navVel()`); `vInert` is the game frame.

| Event | MET s | state | Δv spent m/s | propellant left t |
| --- | --- | --- | --- | --- |
| ignition, LC-39 | 0 | pad TWR 1.29 g | | 2,500 / 1,800 / 300 / 26 / 15 |
| stage 1 separation | 120.3 | game log: STAGE 1 SEPARATED | | 0 / 1,800 / 300 / 26 / 15 |
| stage 2 separation | 425.8 | S-2 SATURN II DEPLETED; the CSM engine keeps burning | | 0 / 0 / 300 / 26 / 15 |
| TLI ignition | 1,107 | at the 237 km perigee, vInert 7.7979, Moon lead 2.9159 rad | | 0 / 0 / 197.5 / 26 / 15 |
| TLI cutoff | 2,045 | vInert 10.4159 commanded; two-body apogee 384,427 km | | |
| **coast begins** | 2,049.1 | the cut's 0.6 m/s tail → vInert 10.4165; that state's apogee 427,714 km | **3,104** | 0 / 0 / 56.2 / 26 / 15 |
| lunar SOI | 237,701 | game log: PREPARE RETROGRADE BRAKING | | |
| periselene (uncorrected) | 297,301 | 358 km, vRel 2.3517, v∞ 0.9213 | | |
| **LOI** | 297,458 | retrograde at 370 km to vRel 1.5407 | **829** | 0 / 0 / 32.5 / 26 / 15 |
| parked | 297,458 | a = 2,149 km capture; the CSM keeps a 110 km rail | | |
| LM separation | 297,458 | the CSM becomes a rail curve while the LM is away | 1 | 0 / 0 / 32.5 / 26 / 15 |
| **deorbit burn** | 297,512 | retrograde, 54 s after LOI | **84** | 0 / 0 / 32.5 / 24.7 / 15 |
| **PDI** | 301,069 | powered descent guidance takes over | 1 | 0 / 0 / 32.5 / 24.6 / 15 |
| **LM touchdown** | 301,397 | 3.8 m/s, tilt 26.6° — the game's awarded landing, engine out | **2,057** | 0 / 0 / 32.5 / 0.0 / 14.8 |
| **lunar ascent** | 301,641 | to a 25.2 km insertion, vRel 1.6686 | **1,940** | 0 / 0 / 32.5 / 0.0 / 3.1 |
| phasing trim | 377,476 | Hohmann to the rail | **21** | 0 / 0 / 32.5 / 0.0 / 3.0 |
| **docking** | 603,456 | the terminal approach closes to 1,001 m at 9.0 m/s; the game re-mates | 139 | 0 / 0 / 32.5 / 0.0 / 2.4 |
| **TEI** | 604,729 | trans-Earth injection from lunar orbit | **859** | 0 / 0 / 21.5 / 0 / 0 |
| return correction | 876,732 | mid-coast aim, then the service stage is dropped | **802** | 0 / 0 / 0 / 0 / 0 |
| re-entry interface | 876,732 | capsule alone | | 0 / 0 / 0 / 0 / 0 |
| drogues / mains | 892,359 / 892,392 | | | |
| **splashdown** | 893,597 | 7.8 m/s | | |
| | | **total** | **19,802** | |

Margin, stated as the two different things it is: **398 m/s** between the ideal staged budget
(20,192) and what the round trip actually spent (19,802), and **2.4 t** still in the LM ascent
tank at docking — every tank reads dry by splashdown, because the mission is over before the
propellant runs out. The one-way flight kept 7.2 t at touchdown, worth 943 m/s on the 28 t that
lands dry; that headroom is what the chain of ascent (1,940 m/s), phasing, and the 802 m/s return
correction consumed. The ideal budget and the flown total differ because the budget is a model with
assumptions the flight does not honour — nothing is spent while the launch clamp holds the vehicle
on the pad, dry mass is dropped exactly at depletion rather than on the next staging command, and
the per-step integral charges Δv by propellant flow. Both numbers are honest; neither is the other.

### Where the ascent Δv goes

The ascent spent 9,956 m/s of propellant-equivalent Δv to deliver 275 t through the 237 km perigee
where TLI ignites 43 s later; this profile does not circularise first.
`mission-math.py` section 5 prices that manoeuvre — pad to a 185 km orbit, Apollo hardware,
sea-level Isp, nothing wasted — at 8,854 m/s, so gravity, drag and steering cost about
**1,102 m/s**. The same section derives Apollo 11's own loss from the SP-4029 ground-ignition
weights as 1,469–1,997 m/s. Two different vehicles and two different derivations land in the same
band, which is the check that the game is not handing out orbital velocity for free. The tool prints
this comparison every run; it deliberately compares against Apollo's derived cost rather than
against the staged ideal of its own stack, because those are different quantities that happen to
come out near each other, and pretending otherwise would be a coincidence dressed up as an
accounting identity.

Drag specifically is not a factor. Measured on the shipped SAS ascent by integrating the axial drag
deceleration `q · CD_AREA · machDrag(M) · cos²α / m` over every 0.1 s step (a headless script on
`js/physics.js`, not a tool in `tools/`): **16.0 m/s** lost to drag before S-2 burnout, peak
deceleration 0.29 m/s², max-Q 22.8 kPa at T+71 s, 11.1 km, Mach 1.25. The Mach rise and the angle of
attack together account for 3.4 of those 16.0 m/s; the same path priced at a constant `CD_AREA` is
12.6.
`mission-math.py` section 8 bounds the loss from above at ≤ 109 m/s for a constant `CD_AREA = 28` m²
(≤ 47 m/s at 12 m²) and ≤ 174 m/s with the drag rise held at its 1.6× peak throughout, because the
pitch program is above the dense air within two minutes. The exponential density model is a poor fit
to USSA-1976 above 100 km, but the error sits where the air is too thin to matter.

### Why TLI overshoots

The tool burns prograde until `v = sqrt(MU_E (2/r − 1/aT))` with `aT = (r + 1.012·MOON_DIST)/2`.
The 1.012 is not decoration: an exactly-tangent transfer whose apogee equals `MOON_DIST` came up
about 2,000 km short of the sphere of influence in testing and never registered an encounter, and
no correction burn can rescue a miss that large at 384,000 km. Overshooting puts the crossing
*inside* the SOI, where the Moon's gravity does the rest. Measured result: apogee 384,427 km at the
cutoff command, SOI entry at 237,701 s, periselene 358 km with **no correction burns fired**. That
was a choice, not a lack of one: the mid-course machinery runs for this stack (the `game` and `nova`
tools, gated on `fuel > 5 t`, up to eight burns) and the CSM holds 56.2 t after TLI — but the first
aim check read 357 km, so the flight corrected nothing. The one-way regression `landed` flies
without the machinery at all: its encounter is decided at injection.

Apollo flew harder than this — `mission-math.py` section 4 shows Apollo 11's post-TLI orbit with an
apogee of 522,505 km, a ~73 h fast transfer rather than the 120 h minimum-energy one. The game sits
between the two: **82.0 h** from coast start (2,049.1 s) to periselene (297,301 s), measured. The
384,427 km apogee the tool prints belongs to the cutoff *command*; the engine keeps pushing through
the ~4 s run-down while the radius grows, and the two-body apogee of the coast-start state the tool
records (`ev.tliDone`) works out to 427,714 km altitude — computed from that state, not printed by
the tool. This file used to call the coast "119.5 h-class"; no run ever showed that.

### Capture belongs at periselene

The `approach` phase coasts on nothing until the Moon-relative radial velocity changes sign, then
burns. Braking from the edge of the SOI instead spends the tank fighting your own approach energy
and still misses the orbit: at 66,200 km the circular speed is 272 m/s, so decelerating to bind
yourself early buys a huge eccentric fall instead of an orbit. At periselene the same Δv is worth
the most: LOI cost 829 m/s here, at 370 km, against the 820 m/s the patched-conic estimate predicts
for 111 km and Apollo's measured 889 m/s. (The one-way regression's capture burned 849 m/s at 358 km
and 83 m/s to deorbit from it; a higher capture is a cheaper capture and a dearer descent.)

## Launch window and how tight "aim" really is

`MOON_PHASE0 = 2.1777643` rad is not a rounded number and must not be rounded. The tool finds it by
bisecting the first periselene altitude toward `AIM_PERI = 350` km — the middle of the band the
autopilot lands from, not its late edge; the solver's own converged phase is 2.1777956 and the
shipped constant passes the Moon at 358 km. Every phase flown since — 2.158 through 2.186 rad,
fifteen flights at 0.002 rad steps — completes the whole chain to splashdown, with mission clocks
from 10.2 to 20.3 days (the long ones spend it in rendezvous phasing, not in trouble); the shipped
phase does it after 120 s (20.487 days) or 300 s (17.979 days) of waiting on the pad, while 3,600 s
of pad time pushes the phasing past the tool's own 1,100 ks chain horizon — that mission was still
FLYING, healthy, at 12.731 days. The eleven-phase sweep below is the
one-way `landed` regression: it maps the corridor that mission's window sits in, and it remains the
sweep the corridor constants (`CORRIDOR = { lo: 120, hi: 745 }` km) were measured against:

| phase rad | periselene | outcome | touchdown | spare | Δv spent | aim readout |
| --- | --- | --- | --- | --- | --- | --- |
| 4.9157044 (−3e-3) | 745 km | WON | 2.8 m/s | 6.6 t | 16,341 m/s | 744 km, green |
| 4.9167044 (−2e-3) | 610 km | WON | 2.6 m/s | 6.8 t | 16,321 m/s | green |
| 4.9177044 (−1e-3) | 477 km | WON | 2.8 m/s | 7.0 t | 16,298 m/s | 477 km, green |
| 4.9182044 (−0.5e-3) | 412 km | WON | 3.0 m/s | 7.1 t | 16,287 m/s | green |
| **4.9187044 (landed window)** | **346 km** | **WON** | **3.3 m/s** | **7.2 t** | **16,274 m/s** | **346 km, green** |
| 4.9192044 (+0.5e-3) | 282 km | WON | 3.7 m/s | 7.3 t | 16,262 m/s | green |
| 4.9197044 (+1e-3) | 218 km | WON | 4.1 m/s | 7.4 t | 16,248 m/s | 217 km, green |
| 4.9199544 (+1.25e-3) | 186 km | WON | 4.4 m/s | 7.5 t | 16,241 m/s | green |
| 4.9202044 (+1.5e-3) | 154 km | WON | 4.7 m/s | 7.5 t | 16,234 m/s | green |
| 4.9204544 (+1.75e-3) | 123 km | WON | 4.9 m/s | 7.6 t | 16,227 m/s | 122 km, green |
| 4.9207044 (+2e-3) | 91 km | **LOST** | 80 m/s | 0.4 t | 17,162 m/s | 91 km, red |

(The aim column is `js/targeting.js` run headless from the coast-start state where a number is
given, and `CORRIDOR`'s 120–745 km test applied to the tool's periselene where it is not.)

So about **130 km of periselene per 1e-3 rad** on that one-way profile (1e-3 rad is 376 s of lunar
motion at
`MOON_RATE = 2.6617e-6` rad/s), and the band is still **a slope on one side and a cliff on the
other** — but the window now stands in the middle of it. Early costs about 0.2 t of propellant per
1e-3 rad and nothing else, out to at least −3e-3 rad. Late, every flight lands down to +1.75e-3 rad
(eleven minutes of lunar motion, a 123 km periselene), and +2e-3 rad is lost: its LOI burn ends at
106 km, the tool's deorbit phase is skipped, and the descent starts from orbit height and speed with
no transfer ellipse — 2,994 m/s against 2,055 at the window, the tank run down to 0.4 t, and still
80 m/s at the surface. The edge is between 123 and 110 km: a 110 km periselene (phase 4.9205531,
re-flown at this physics) is lost at 76 m/s. (Both lost flights were re-flown when contact moved
from the bell's exit to the footpads, 0.84 m lower: every landing in the table kept its touchdown
speed, spare propellant and Δv to the printed digit; the two crashes are the only rows that moved.) That is a statement about this autopilot's descent,
not about the Moon — a pilot who brakes differently may land from lower — but it is the only landing
anyone has measured. Two consequences for the game:

- The lever a player actually has is *time*: wait on the pad, or coast in the parking orbit, and warp
  until the geometry works. Small along-track correction burns work too: the round-trip tool carries
  that machinery (the `game` and `nova` stacks, gated on `fuel > 5 t`, up to eight burns) and the
  shipped CSM has 56.2 t after TLI, though the certified flight never needed one — and `landed` has
  none, so that encounter really is decided at injection.
- **Aim is visible, and live through the burn.** `js/targeting.js` predicts the closest lunar
  approach from the present state four times a second (`lunarPass`, 1.6 ms a call, timed headless in
  Node on the development machine) and the orbit panel shows it as `<km> km in <hh:mm:ss>`. With the
  engine lit the figure is the pass you would get by cutting now. It is painted green inside
  `CORRIDOR = { lo: 120, hi: 745 }` km — the table above: every flight inside it landed, the lowest
  being the 123 km one, which the module reads as 121.3 km; the floor sits between that and the
  110 km flight that was lost (the floor itself is not a flown point). Above 745 km nothing has
  been flown, so red there means "unmeasured", not "you will crash". Below 420 km the prediction
  includes nose-on drag (`coastDrag`). Outside the corridor `aim.trim` is the prograde (+) or
  retrograde (−) m/s that would centre the pass, from a ±1 m/s finite difference, clamped to 60.
- **SAS cuts the injection burn.** At full CSM thrust the pass crosses the whole corridor in about
  a tenth of a second of burn, so with SAS on (prograde) `cutoffNow()` shuts the engine down when
  the pass is inside the corridor with 60 km in hand. Flown headless on three successive
  opportunities (the one-way stack of that date) it left passes of 568, 349 and 369 km with
  44.5–44.6 t aboard. With SAS off the cut
  is the pilot's and the trim hint is how it is repaired.

### The readout predicts the game, not the textbook

The game's step (`simTime += dt`, gravity at the advanced time, `v += a·dt`, `p += v·dt`, at
`DTPHYS = 0.1 s`) is leapfrog with its velocity written half a step late. The state it holds
therefore evolves, to second order, like a true trajectory started from the same position with
velocity `v + a·dt/2`, and `lunarPass` is a velocity-Verlet integration from that state with a step
of 1/1000 of the local radius (0.5–300 s). Measured from the `landed` coast-start state
(`ev.tliDone`, the same for every phase — only the Moon moves), against the game's own scheme
stepped at 0.1 s all the way to the Moon, headless in Node with the shipped modules:

| launch phase offset, rad | game scheme at 0.1 s | `lunarPass` | flight (whole km) |
| --- | --- | --- | --- |
| −3e-3 | 744.24 km | 743.39 km | 745 |
| −1e-3 | 476.51 km | 475.70 km | 477 |
| 0 (at that window) | 345.66 km | 344.87 km | 346 |
| +1e-3 | 217.00 km | 216.23 km | 218 |
| +1.75e-3 | 122.03 km | 121.28 km | 123 |
| +2e-3 | 90.68 km | 89.93 km | 91 |

The predictor reads 0.75–0.85 km low on all six. The state was seeded as the tool prints it (1 m,
1 mm/s, 1 ms), so the last column agrees only to about a kilometre by construction.

The half-step term is the whole of it. The same Verlet integration from the raw `(p, v)` says
442.74 km at the shipped window — 97 km from the ship's real trajectory, which is the "a converged
integrator disagrees with the game" of earlier revisions of this page. And the game scheme itself
at 1 s instead of 0.1 s says −474.5 km on that state, an impact. On the shipped round-trip
coast-start state the same experiment gives 658 km where 0.1 s gives 358 km — re-measured for this
revision: the discretisation error is worth hundreds of km, and its sign is not fixed from one
coast geometry to the next. The module this replaced replayed the 0.1 s steps a budget at a time:
exact, but 6–14 s to an answer and blank whenever the engine burned.

### Why the coast step is not a free parameter

Until this was checked, the tool stepped the coast at 1 s and only used the game's 0.1 s cap during
powered flight and near bodies. That is ten times faster and it certified a trajectory **no player
can fly**. With the current forces, the same experiment, from the shipped coast-start state: the
game's scheme reaches 358 km at 0.1 s and 658 km at 1 s — 300 km off; on the previous one-way state
the 1 s step went 475 km *under the surface* instead, 820 km off. Either way it is worth far more
than the margin anyone steers by. (When the step was first fixed, at the
physics of that date, every coast-derived number moved: SOI entry 234,479 → 232,147 s, LOI 869 →
875 m/s, parked semimajor axis 1,990 → 1,957 km, touchdown 20.2 → 20.1 m/s, and the window itself
4.957230 → 4.9561012. Those are history now; none of them is a current value.)

The mission still wins, and by about the same margin, because the landing physics was always at
0.1 s; it was the coast geometry that had been drifting. The rule the tool now states in its own
source: **the step is part of the trajectory.** `js/main.js` banks frame time × warp and spends it
in whole `DTPHYS` steps, so 0.1 s is the only step the game takes in flight, and anything that
certifies a mission has to use it. (That became true of the game itself only with commit 55f18fa:
before it the browser stepped at the frame time below ×6, and the tool was certifying a step the
page did not take at ×1.)

`MOON_PHASE0` is solved for the `TURN` table in the same file. Change the pitch program without
re-running the tool and TLI mis-aims by tens of thousands of km. `--turn=steep` (the reach-horizontal
table `t0 60, ramp 200, max π/2`) solves its own window at phase **2.1909830** — 1.32e-2 rad,
some 83 min of lunar motion from the shipped one — and flies the whole chain there: WON, 10.916
days, 19,779 m/s, ascent 9,952 m/s. Two tables, two windows, two missions; the constant belongs to
whichever table is in the file. (On the build that predates the finished round-trip chain the same
steep table lost with `HARD IMPACT ON THE MOON AT 1503 m/s`; the chain's homing and correction
laws are what the profile now flies through.)

The same is true of the forces. The flight-model change — a drag rise that reshapes the ascent, and
the indirect term in `gravityAt` that acts through the whole 80 h coast — moved the solved window
from 4.9561012 to 4.9198031 for the same 200 km aim: 0.036 rad, twenty times the 1.75e-3 rad that
now separates the window from the last late flight that lands. (Re-centring on 350 km then moved it
to 4.9187044 on purpose — the one-way regression's window; the round-trip chain's own window was
solved at 2.1777643 when the LM stages entered the stack.) Any change to
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
≈ 3 m/s, well inside `LAND_SAFE`). `h` is `surfaceAlt()` — the lander's footpads over the surface
(station 6.2 u, 0.6 u under the bell's exit; `GEAR_Z` in `js/stations.js`), the same number contact is
judged by. It used to be the altitude of `S.pos`, the middle of the *full*
stack, while contact was declared when `S.pos` came within the full stack's half-height (52 m) of
the surface: the guidance met "the ground" while still reading 52 m of altitude, and every
touchdown before this fix came in near 20 m/s. With the heights agreeing the one-way regression
still touches at **3.3 m/s**, and the round-trip LM — the same law on the 45 t stage — is awarded
**3.8 m/s, tilt 26.6°** (`ev.touchMoon` is the game's own award: `js/physics.js` records TOUCHDOWN
only on a contact step with the engine out, which the law's 3 m cutoff delivers — the last metres
are a throttle-ramping hop. The tool used to print `0.0 m/s, 0.0°` for that landing: it keyed its
guard on contact, the stage-3 tank ran dry ~200 m up, and the debrief recorded the initial values
of `landing.speed` for a touchdown the game had never awarded).

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

The LM's powered descent cost 2,057 m/s — 2,142 with the 84 m/s deorbit burn and the 1 m/s spent reaching
PDI — against Apollo's derived 2,300 m/s for deorbit plus powered descent (PDI at 1,696 m/s plus
gravity losses); the one-way regression's CSM descent cost 2,055 and 2,139 on the same law.
PDI sits at 70 km here rather than Apollo's 11.9 km / 1,696 m/s,
because the envelope above needs path, not because it is more realistic.

## Leaving the pad

The launch complex is solid (`js/colliders.js`: one table of boxes in the pad's frame, which
`js/pad.js` also draws the swing arms from). The vehicle is tested against it as a run of spheres
along its axis from the moment the hold-down lets go, and contact with anything ends the flight —
`COLLISION WITH THE LAUNCH TOWER`, `A SWING ARM`, `THE TOWER CRANE` and so on. The swing arms begin
to retract at ignition and take `ARM_TIME = 1.5 s`; they are solid until 60 % of the way round,
0.9 s. That is short on purpose and the source says why: this vehicle leaves the pad the instant it
is lit, where Apollo's arms took 2–5 s against a vehicle held down for 8.9 s first (Apollo's
numbers, from that comment, not fetched into `docs/reference/`).

Measured headless (a script on the shipped modules):

| what was flown | result |
| --- | --- |
| SPACE then SAS (P) | clears: 1.6 m up when the arms stop being solid at 0.9 s, 4.4 m up when they are home at 1.5 s; `LIFTOFF — THE TOWER CLEARS` at 8.9 s |
| SAS off, yaw (A or D) held from ignition | `COLLISION WITH A SWING ARM` at 0.8 s, 3 m/s |
| SAS off, pitch (W or S) held from ignition | tips over and falls back: `IMPACT WITH EARTH AT 142 m/s` at 13.9 s |
| SAS off, any axis held from T+3 s or T+6 s | clears the steel, then `IMPACT WITH EARTH` at 176–204 m/s, 19–24 s after ignition |

The third row used to be a tunnel: a stack that let go and came back down stayed in the `pad`
state, which tests no ground, and went two kilometres into the Earth. Dropping back below the pad
now starts the flight and its ground test.

The pitch program runs on time **since the hold-down let go**, not on the mission clock. It has to:
waiting on the pad is how a player moves the launch window, and on the mission clock a late launch
was already "past" its vertical hold and tipped into the swing arms. Measured — wait, then SPACE
and P, state at S-2 burnout 425.8 s after ignition:

| wait on the pad | speed | max-Q | peak side load |
| --- | --- | --- | --- |
| 0 s | 6.3838 km/s | 22.8 kPa | 0.016 g |
| 120 s | 6.3841 km/s | 22.8 kPa | 0.016 g |
| 300 s | 6.3841 km/s | 22.8 kPa | 0.016 g |
| 3,600 s | 6.3811 km/s | 22.8 kPa | 0.0159 g |

(The hour-long wait differs in the fourth figure — the Moon has moved 0.55° by then, which is the
likely cause, not a measured one; the ascent is the same ascent.) Other things the same review fixed, read from the code rather than measured:
SPACE on a liquid stage now zeroes the throttle as well as cutting the engine, so the next step
does not relight it; CTRL cannot throttle the solid; and a step is never longer than `DTPHYS` (since commit 55f18fa it
is exactly `DTPHYS` in flight).

## Coming home

Drop every stage (X on the CSM) and what is left is the 10 t command module, flying alone. It has
no engine, so the path has to meet the air on its own — from a parking orbit that means braking
*before* the CSM goes; from a lunar flyby it means a perigee inside the atmosphere. A splashdown
under `SAFE_EARTH = 12 m/s` is a success end state: `SPLASHDOWN`, or `AROUND THE MOON AND HOME` if
the flight entered the lunar sphere of influence first.

What `js/physics.js` models (its comment block is the source of truth):

| | rule | numbers |
| --- | --- | --- |
| heat | proxy `sqrt(ρ)·v³` (kg/m³, km/s). Above `HEAT_SHIELD` the vehicle cooks unless it is a bare capsule flying apex-trailing (nose within ~53° of retrograde to the airflow); `HEAT_TIME` of cooking is `BURNED UP` | `HEAT_SHIELD = 4`, `HEAT_TIME = 3 s`; evaluated below 150 km |
| attitude | the bare capsule gets a small normal-force area at its apex, ahead of the centre of mass, so it is statically stable heat-shield-first and turns round by itself | 3 m² at the apex station |
| drogues | first press of G; plain `C_d·A` drag, 2.5 s to inflate. Lost if deployed above the tear pressure, above the Mach limit, or with the heat proxy over 0.5; lost once open at 1.4× the tear pressure | 30 m², tear 20 kPa, Mach 1.5 |
| mains | second press of G; same rules | 2,300 m², tear 4 kPa, Mach 0.5 |
| crew | felt acceleration (air on the hull plus the canopy's pull) over `G_LIMIT` for `G_TIME` is `ENTRY TOO STEEP` | 16 g, 2 s |
| control | under an open canopy with q > 5 Pa, SAS and attitude hold are ignored: the canopy hauls the apex round to trail. Retrograde SAS below 120 km steers by ground-relative velocity, and holds the local vertical under 10 m/s | — |
| canopy drag | solved implicitly per step (`v/(1 + k·v·dt)`), because a 0.1 s explicit step overshoots through zero under the mains | — |
| splashdown | Earth contact, capsule alone, `groundVel ≤ SAFE_EARTH` | 12 m/s |

Measured headless with the shipped modules (a script, not a tool in `tools/`): a bare capsule
placed 122 km above the pad's position, flying east at the stated inertial speed and flight-path
angle, heat shield first, hands off; drogues at 7.3 km and mains at 3.0 km, which are Apollo's
nominal deployment heights (Apollo's numbers, not fetched into `docs/reference/`).

| entry at 122 km | peak g | peak q | peak heat | outcome |
| --- | --- | --- | --- | --- |
| 7.8 km/s, −1.5° | 7.2 g at 40.6 km | 59.2 kPa | 8.9 | **splashdown 7.8 m/s**, 859 s after interface |
| 7.8 km/s, −3° | 8.9 g | 73.3 kPa | 11.3 | splashdown 7.8 m/s |
| 7.8 km/s, −6° | 14.7 g at 38.8 km | 120.9 kPa | 15.4 | splashdown 7.8 m/s |
| 7.8 km/s, −7° | 16.6 g | 136.1 kPa | 16.6 | **`ENTRY TOO STEEP`**, 90 s after interface |
| 7.8 km/s, −8° / −10° | 17.4 / 18.6 g | 142.7 / 153.0 kPa | 17.7 / 19.8 | `ENTRY TOO STEEP` |
| 11 km/s, −3° / −4° | — / 0.2 g | 0.3 / 1.7 kPa | 2.9 / 6.6 | **skips out** at 10.90 / 10.77 km/s |
| 11 km/s, −5° | 1.7 g at 71 km | 13.7 kPa | 16.7 | skips out, leaving at 9.49 km/s |
| 11 km/s, −5.5° | 5.6 g at 39.0 km | 45.6 kPa | 23.8 | splashdown 7.8 m/s |
| 11 km/s, −6° | 10.0 g at 49.9 km | 82.2 kPa | 29.5 | splashdown 7.8 m/s |
| 11 km/s, −6.5° | 14.4 g at 46.2 km | 118.5 kPa | 33.7 | splashdown 7.8 m/s |
| 11 km/s, −7° | 16.8 g | 138.2 kPa | 37.2 | `ENTRY TOO STEEP`, 76 s after interface |
| 11 km/s, −7.5° / −8° | 17.6 / 18.3 g | 144.2 / 149.9 kPa | 40.1 / 42.7 | `ENTRY TOO STEEP` |

**The corridor home from the Moon is about one degree wide** — −5° skips, −5.5° to −6.5° land,
−7° kills the crew — and from low orbit anything from −1.5° to −6° lands. The 5.6 g at −5.5° is the
entry's; that flight's largest load was 6.6 g when the mains opened at 3 km.

In every flight that landed the chutes went out at the same state, because by 7.3 km the capsule
is at terminal velocity whatever it arrived at: drogues at 9.0 kPa and 186 m/s, mains at 2.3 kPa
and 73 m/s. What happens when the sequence is flown wrong, all from the 7.8 km/s, −1.5° entry:

| mistake | result |
| --- | --- |
| no parachutes | `HARD LANDING`, 114 m/s |
| drogues only | `HARD LANDING`, 61 m/s |
| mains straight after the drogues, at 8.9 kPa | lost (limit 4 kPa) → 114 m/s |
| G at peak dynamic pressure, 56.5 kPa | drogues lost (limit 20 kPa) → 114 m/s |
| G 60 s after interface: 110 km, 0.08 kPa, Mach 25 | drogues lost to the Mach limit → 114 m/s. Before that limit existed the same press put drogues out at 107 km and 10.5 km/s |
| G at 27 km, Mach 3.9, 32.6 kPa | drogues lost (pressure) → 114 m/s |
| drogues early but legal, at 20 km (10.8 kPa, 430 m/s) | fine: splashdown 7.8 m/s, 40 s later than nominal |
| CSM still attached | `BURNED UP` 200 s after interface, at 80 km, heat 4.2 |
| starts apex-first | turns round on its own before the heat arrives; splashdown 7.8 m/s |
| starts apex-first **at 11 km/s, −6.5°** | `BURNED UP` 23 s after interface, at 95 km — the heat gets there before the capsule has come round |

Apollo's entry was a *lifting* one — the real command module flew at an angle
of attack and rolled its lift vector to hold the corridor and the load; this capsule cannot, which
is why the game's entry g is what a ballistic body gets. The drawn mains are 17 m across against
Apollo's 25 m (`js/chutes.js` says why: three of them and the capsule fit one frame); the 2,300 m²
that does the braking is a drag area chosen for an ~8 m/s descent, not the drawn cloth.

## Scoring

A touchdown on the Moon opens a debrief (`js/hud.js`):

- **Stars.** One for landing at all (under 32 m/s, within 60° of vertical). Two at ≤ 12 m/s and
  ≤ 20° of tilt. Three at ≤ 4 m/s and ≤ 8°.
- **Score.** `1000 − 25·speed(m/s) − 6·tilt(°) + 40·propellant left(t)`, floored at zero. The best
  score is kept in the browser's `localStorage`.
- A splashdown is one star, two after a lunar flyby, and three when it closes a round trip that
  touched down on the Moon ("walked on the Moon and came back").

By that rule the certified chain scores at both ends: the awarded landing reads 3.8 m/s at 26.6°
tilt — one star (the throttle-ramp hop leaves the vehicle further from vertical than the second
star's 20°, though well inside `LAND_SAFE` and the 60° gate) — and a splashdown that closes a round
trip which touched down is the third kind. The one-way regression's landing (3.3 m/s with 7.2 t left) is a three-star
landing too if its tilt is under 8°. Note what the
score rewards: 40 points per tonne is worth more than 25 per m/s, so a late, hard braking burn that
arrives at 10 m/s with more in the tank can outscore a gentle one. The HUD's `NEXT` line gives the
deadline for it: stopping from the current speed at full thrust takes `v²/2(a − g)` of path, and it
calls `BRAKE NOW` when the height in hand falls below 1.15× that.

## What is not true yet

- **The burn cue is coarse.** In a parking orbit the HUD counts down to the moment the Moon leads
  the ship by `TLI_LEAD = 2.9159` rad — the lead `tools/mission-sim.mjs` prints at the certified
  flight's ignition (`ev.tliIgn`: lead 2.9159, 237 km up; re-run here). It puts a hand-flown burn in
  the right half-hour, no better: the commit that added it records lunar passes of 194, 348 and
  −68 km on the first three opportunities (its measurement, not repeated here), against 92,521 km
  for a burn "at periapsis". The aim readout and a trim burn have to do the rest.
- **Docking is an arrival, not a piloted mate.** Within `DOCK_DIST = 1` km of the parked CSM at
  under `DOCK_SPEED = 50 m/s` the modules join and the stack re-mates; the parked CSM rides a
  closed-form rail and never seeks the LM. There is no soft-dock port, no capture probe to line
  up, and no way to fail the mate gently from inside the gate.
- **Entry is ballistic.** The capsule trims at zero angle of attack, so it has no lift to steer
  with; that is why the lunar-return corridor is a degree wide and its survivable end is 14 g.
- **The Moon is parametric** (`constants.js` `moonPos`/`moonVel`): a circular 384,400 km orbit in
  the launch plane at the sidereal rate. Real ephemerides would come from `astronomy-engine`, which
  was evaluated and is not used; see [libraries.md](libraries.md) for why the integrator stays
  hand-written and what adopting it would buy.
- **Nothing marks the launch window.** The shipped round-trip phase has at least 2.8e-2 rad of
  measured room (2.158 through 2.186 rad all fly the chain), but a player who launches at another
  time has only the aim readout to steer by.
- **Headless landings are on a smooth Moon.** The tool injects no relief; the browser lands on the
  drawn terrain. No headless number here says anything about a slope.
- **The air's density is one exponential**, not USSA-1976 + MSISE-90; `mission-math.py` section 7
  has the tables and section 8 bounds drag's whole effect at ≤ 174 m/s (16 m/s measured).
- **The flight model is coarse.** Coefficients are textbook orders of magnitude, body lift is lumped
  at the planform centroid so the vehicle is statically stable where Apollo's was not, and there is
  heating is a threshold on a proxy, not a thermal model. See [atmosphere.md](atmosphere.md).
- **The pad sits in near-shore water in the texture, not because the coordinates are wrong.**
  `PAD_LAT`/`PAD_LON` are now the geocentric LC-39 values (28.4469, −80.6041), and the texture's
  alignment with the mapping was measured at IoU 0.954 against Natural Earth with zero offset. But
  the committed 2048 × 1024 sheet resolves 17 km per pixel and its Florida coastline runs to
  −80.68° where the real shore is near −80.55°, so the pad's pixel is sea at any LC-39 latitude
  anyone could argue for. A sharper sheet fixes the look; changing the coordinates would move the
  pad off the launch complex to agree with a pixel. See [launch-site.md](launch-site.md).
- **One structural load, and it is lateral.** The stack fails on accumulated strain above 0.5 g of
  aerodynamic side load (6 g for the bare CSM); the SAS ascent peaks at 0.016 g. There is no axial
  or max-Q limit, so nothing punishes an over-fast ascent flown nose-on beyond drag.

## Status

| Requirement | Value | Measured | |
| --- | --- | --- | --- |
| Reach orbit | a path the TLI burn can light from | 237 km perigee at S-IVB cutoff, TLI 43 s later (the `landed` regression still makes 151 × 760 km at 7.3706 km/s) | ✅ |
| Reach the Moon | enter SOI | 237,701 s, periselene 358 km | ✅ |
| Lunar orbit | bound, circularisable | LOI 829 m/s at 370 km to vRel 1.5407, a = 2,149 km | ✅ |
| Deorbit | periselene in the corridor | 84 m/s burn, PDI 301,069 s | ✅ |
| Soft landing | < 32 m/s (`LAND_SAFE`), within 60° of vertical | LM **3.8 m/s**, tilt 26.6° | ✅ |
| Return from the surface and dock | re-mate with the CSM | ascent + insertion 1,940 m/s, phasing 21 m/s, dock 603,456 s, 2.4 t left | ✅ |
| Come home | TEI, re-entry | 859 + 802 m/s, capsule alone from 876,732 s | ✅ |
| Splash down | < 12 m/s (`SAFE_EARTH`), capsule alone, under 16 g | **7.8 m/s** under mains | ✅ |
| Propellant margin | > 0 at the end | 2.4 t at docking; every tank dry by splashdown | ✅ |
| Round-trip budget | ≥ 18,092 m/s | 20,192 ideal / 19,802 spent | ✅ |
| Survive the air | side load < 0.5 g | 0.016 g peak on the SAS ascent | ✅ |
