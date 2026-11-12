# Working notes for agents in this repo

LUNAR LIFT: a real-scale orbital game — vanilla ES modules, Three.js 0.187.0 from a CDN importmap,
hand-written gravity in `js/physics.js`, no build step, no runtime npm dependencies.

Read this before changing physics, the vehicle, or any number that appears in a doc. This file is
`AGENTS.md`; `CLAUDE.md` is a symlink to it.

## Run it

```sh
node server.js 8078      # serves ES modules with no-store + SSE hot reload at /__reload
```

Open `http://localhost:8078/index.html`. 8078 is the default and the user's own: an agent starts its
server on another port. The server serves only files under the repo and refuses any path with a
dot-segment (`/.git/config` is 403).

`window.game` is the debug handle:
`state() ignite stage jettisonLES jettisonAdapter setSas(on, retro) warp(n) camera(name) map(on) ff(seconds)
setThrottle(v) nudge(ω) teleport(pos, vel, simTime) reset()`, plus `_cam`, `_pred`, `setCam(d)` and
`setView(yaw, pitch, dist)` (snapped, for scripted poses). `camera(name)` takes `'orbit'` or
`'chase'`; the far view is `map(true)`. `warp(n)` takes a value from `WARPS` and ignores any other.
`state().aero` is `{ q, mach, aoa, load, margin }` — Pa, –, rad, lateral g, static margin in m.

What the page does without being asked: with no WebGL 2 it shows a `CANNOT START` card instead of a
blank canvas; if `window.game` does not exist ten seconds after load (three.js comes from
cdn.jsdelivr.net) `index.html` says so; an exception in the frame loop stops the loop and shows
`SOMETHING BROKE` with the message. The drawing buffer starts at `min(devicePixelRatio, 2)` and
drops a quarter-step of pixel ratio, down to 1, whenever frames run longer than 24 ms for three
seconds (`adaptScale` in `js/main.js`, logged as `RENDER SCALE`); it never climbs back. `?scale=<n>`
pins it (up to 3) — pin it for any pixel measurement.

## Verify

```sh
npm i --no-save three@0.187.0 playwright   # tools only; the game has no dependencies
npm test                                    # tools/check.mjs: everything below. Must end `check: all ok`
npm run test:headless                       # the first five only: what CI runs
```

`tools/check.mjs` runs each tool as a child process, prints one `ok` / `FAIL` line per tool with
its last output, and exits 1 if any exited non-zero. The browser checks run against a dev server
it starts itself on a free port, so nothing an editor saves can reload the page under them.

| check | tool | exits non-zero when |
| --- | --- | --- |
| shader-lint | `node tools/shader-lint.mjs` | any `ShaderMaterial` or injected GLSL helper breaks a rule (braces, `main`, `<common>` first, unknown `#include`, a splice anchor three does not have, `atan2`, a loop with no increment, an array parameter written through) |
| mission (shipped) | `node tools/mission-sim.mjs game --phase=<MOON_PHASE0>` | the result is not `WON` |
| mission (retro loses) | `node tools/mission-sim.mjs retro --phase=1.4742618` | the previous stack does not `LOSE` (it is kept as a recorded loss) |
|mission-math|`python3 tools/mission-math.py`|its vehicle is not `SPECS`, or a derived number it prints (15,142 / 20,192 / 16,303 / 20,608 m/s, 1.33×, 4,898 t, 66,184 km) is not the one the docs and `js/constants.js` quote. It does not check flown numbers|
| crater-stats | `node tools/crater-stats.mjs` | the lunar relief ladder is discontinuous: a height step over 8 m between points 2 m apart along 4,000 random tracks (a crater cut off along a lattice plane) |
| shots (console clean) | `node tools/shots.mjs <outdir> <port>` | the console printed any error or warning during eleven minutes of flight (ten screenshots are written to `<outdir>`) |
| clip-test | `node tools/clip-test.mjs <port>` | the camera is under the drawn terrain or inside the hull anywhere in a yaw / pitch / zoom sweep at the pad, liftoff, ascent, orbit and 30 m over the Moon |
| trail-offset | `node tools/trail-offset.mjs <port>` | newborn trail puffs stand off the vehicle's axis by a median over 5 m at any warp (a column laid a frame late) |
| orbit-line | `node tools/orbit-line.mjs <port>` | the drawn ribbon's apoapsis is not the state vector's, engine lit or cut |
| debris-orbit | `node tools/debris-orbit.mjs <port>` | a stage dropped in a 300 km orbit is gone, below 250 km, or over 200 km from the ship after most of a revolution |
| flicker-test | `node tools/flicker-test.mjs <port> [outdir]` | a view in which nothing should change has too many changing pixels, or two meshes share a plane (below) |

The last six need a GPU and a Playwright Chromium (`tools/lib/browser.mjs` finds it, or `$EXE`),
so CI (`.github/workflows/check.yml`: every push and pull request, Ubuntu, Node 22, Python 3.12)
runs `node tools/check.mjs --no-browser` only. Run `npm test` locally before pushing.

`tools/flicker-test.mjs` is the gate on flicker — a pixel that changes when nothing it shows has
changed. Each view hides the HUD and takes 10 screenshots about 100 ms apart at 1440 × 900. A pixel
is *unstable* if the channel-sum step between two consecutive frames exceeds 24, *strong* above 90,
and a *flip* if it changes by more than 60 and is back within 20 of where it was one frame later
(A, B, A: a hard edge that is really moving changes pixels without doing that). Gates and the
numbers from the run made for this file:

```
ok   pad, weather off           unstable     22 (<= 300)   strong     11 (<= 20)   flips    13 (<= 20)
ok   pad close, weather off     unstable     30 (<= 400)   strong      7 (<= 25)   flips     3 (<= 25)
ok   pad, weather on            unstable   1814 (<= 6000)   strong    178 (<= 1500)   flips    57 (<= 150)
ok   paused in flight           unstable      0 (<= 0)   strong      0 (<= 0)   flips     0
ok   coplanar overlapping faces: 0
flicker-test: ok
```

The two pad views with the weather off (`window.__noWeather`) are the precision test: everything in
frame is bolted to ground that moves 409 m/s through the inertial frame; the numbers above are from
the LM round-trip run (Nov-27). The idle pad is no longer a clean 0 (the review-fixes run measured
0/0/0; the run before 69/1/0): the stack now carries the LM's windows, legs and frames, and the
ship-collider basis — degenerate whenever the axis stood parallel to up before the `shipAxes` fix —
rests the camera where single MSAA samples on those edges flip. With the weather on the
cloud outlines move on the wind and the gate is loose — the flips there are the known cloud-outline
shimmer, gated at 150 (58 in the measurement that set the gate, 57 here) — and that view is the one
a loaded machine fails: its strong count measured
1,674 and 1,709 with 33 other Chromium processes running and 1,102 minutes later with the machine
quiet (presumably the ten frames spread further apart; the cause is inferred). `paused in flight` must be exactly 0: a paused frame is a still. The last line
is a static check, not a screenshot: opaque faces of different meshes of the vehicle or the pad
that are coplanar and overlap. If the GPU is busy the counts wobble; rerun once before believing a
failure. Diff maps go to `[outdir]`.

Not gates, measurements: `tools/gpu-time.mjs [port] [query]` (GPU ms per frame by timer query at a
retina buffer: pad idle, liftoff, 15 km, 500 km orbit) and `tools/cloud-views.mjs` (weather
screenshots and GPU time). `node tools/mission-sim.mjs` with no `--phase` solves the launch window
and then flies it (~50 s for the periselene aim; a round-trip stack flies every candidate the
solve can find — up to eight full missions — until one also wins its return corridor, minutes).

Shipped flight right now: the round trip — `RESULT WON`, 13.667 days. Periselene 358 km, LOI
829 m/s at 370 km into a = 2,149 km capture; the CSM parks on a 110 km rail while the LM deorbits
(84 m/s) and the game awards the landing at **3.7 m/s, tilt 27.4°** (`LAND_SAFE` is 32 m/s —
physics records TOUCHDOWN only on an engine-out contact step, which the law's 3 m cutoff delivers;
an earlier tool guard keyed on contact and debriefed a phantom `0.0 m/s` the game never awarded);
lunar ascent + insertion
1,940 m/s, Hohmann trim 27 m/s, docking at 599,878 s (the terminal approach closes to 1,000 m at
5.8 m/s) with 2.4 t of ascent-stage propellant left; TEI 857 m/s plus a 779 m/s return
correction after which the service stage is dropped; splashdown **7.8 m/s**; 19,784 m/s spent.
`landed` (the previous one-way
autopilot, at `--phase=4.9187044`) is the kept one-way regression — WON in 3.469 days, touchdown
3.3 m/s, 7.2 t spare, 16,274 m/s spent; its band ran −3e-3 rad (745 km) to +1.75e-3 rad (123 km)
with +2e-3 rad LOST at 80 m/s. `retro` (at `--phase=1.4742618`) is LOST at 1,264 m/s with a dry
tank. The round-trip window is solved for `AIM_PERI = 350` km: the shipped `MOON_PHASE0 =
2.1777643` passes at 358 km (the solver's own converged 350-aim phase is 2.1777956), every phase
measured from 2.158 to 2.186 rad (fifteen flights at 0.002-rad steps) flies the whole chain to
splashdown, and the shipped phase does it after 120 s (20.519 d) or 300 s (10.637 d) of waiting on
the pad; 3,600 s of pad time pushes the docking phasing past the tool's own 1,100 ks chain
horizon — that mission was still FLYING, healthy, at 12.731 d. Nominal ascent under SAS: max-Q
22.8 kPa at
T+71 s, peak side load 0.016 g at T+87 s (limit 0.5 g, then strain), static margin +3.2 m on the
pad; the same ascent after 0, 120, 300 or 3,600 s of waiting on the pad (S-2 burnout inertial
speed 6.3838 km/s, and 6.3811 after the hour). Command module alone from 122 km: 7.8 km/s lands from −1.5°
(7.2 g, splashdown 7.8 m/s, `SAFE_EARTH` is 12) to −6° (14.7 g) and is `ENTRY TOO STEEP` at −7°;
11 km/s skips out at −5°, lands at −5.5° to −6.5° (5.6 to 14.4 g) and is too steep at −7°. If you
change physics, specs, constants or the launch window, re-run and fix every number that moved **in
the same commit** — `README.md` and `docs/reference/*.md` quote measured output, and a doc that no
run backs is a bug.

`three` must resolve for the tools: `npm i --no-save three@0.187.0`, or the root `node_modules`
symlink to `/tmp/lltest/node_modules`. Ignore the `MODULE_TYPELESS_PACKAGE_JSON` warning; do not add
`"type": "module"` to `package.json` without checking `server.js`. `.gitignore` says `node_modules`
with no trailing slash because that entry is a symlink, and `node_modules/` does not match symlinks.

## Units

km, s, tonnes, kN, everywhere. `thrust / mass` with kN over tonnes is exactly m/s². `GM / r²` with
`GM` in km³/s² and r in km gives km/s². State vectors are km/s; the HUD prints m/s. `simTime` is
real mission seconds — there is no time-scale fudge, and there must never be one.

## Rule: never steer or score with the raw state vector

The Moon moves ~1,023 m/s through the game frame and the Earth's surface moves ~409 m/s under the
pad. Three helpers in `js/physics.js` exist because of this, and every bug in this file's history
came from ignoring them:

- `navVel(out)` — inertial near Earth, Moon-relative inside `SOI_M`. What SAS and the navball steer
  by, and what the orbit plot's arrow and the HUD's Ap/Pe use.
- `groundVel(out)` — velocity relative to the surface of whichever body is underneath. What
  `impact()` compares against `LAND_SAFE`, and what the HUD speed readout shows.
- `bodyUp(out)` — the attitude to hold when the velocity vector has no direction worth steering by.

Concrete failures that actually shipped, each found by measurement rather than reading: touchdown
was scored on inertial `S.v` while the ground moved at 1,023 m/s, so a soft landing was unreadable
and a landed mission looked like a 1,233 m/s win; the HUD's vertical speed was `pos − pos`, always
zero; Ap/Pe mixed a Moon-centred position with inertial velocity and printed `ESCAPE` for a bound
200 km orbit. If a formula combines a position and a velocity, check which frame each is in.

## Rule: the parked CSM is a curve, not a ship

- While the LM is away the CSM exists only as `csmParkPos(t)` / `csmParkVel(t)` in
  `js/constants.js` — closed-form circular park at `PARK_R = RM + 110`. There is NO second
  integrator and nothing may steer it: not SAS, not debris code, not a test. Mass, inertia, aero,
  contact, `stranded()` and `separateStage()` all exclude separated stages; docking is the only
  thing that brings it back.
- Docking is decided inside `physStep`: within `DOCK_DIST = 1` km of the parked point at under
  `DOCK_SPEED = 0.05` km/s relative → `dockCsm()`, log `LUNAR MODULE DOCKED — CSM RE-MATED`, and
  the CSM is the active stack again. While parked, the command module is DRAWN with it
  (`syncParkedCsm` moves `capsuleGroup`); physics still carries `CAPSULE_MASS` with the LM. The parked CSM never seeks the player — that asymmetry is
  what keeps every round-trip trajectory the certifier certifies reproducible.
- A soft, upright LM contact with the throttle still open is the contact probe: physics cuts the
  engine (`CONTACT LIGHT — ENGINE STOP`) and awards the landing on the next, engine-out step — only
  before the first landing, because the same deferral lets the ascent engine build thrust off the
  perch. The award seats the LM on the surface (`surfaceAlt` = 0) before taking the perch; an
  inverted contact reads `noseStation()` (the cabin roof while the ascent stage is aboard).
- Touchdown perches the LM (`moonPerch`, held at `moonPos(t)` + offset, attitude turning with the Moon; the frame is one
  single step, `moonIdle()`, exactly like `padIdle()` for the pad) and the first burning step
  clears it. `warpCap()` offers ×10000 under `moonIdle()` for the same reason it does on the pad.

## Rule: the step is part of the trajectory

In flight the game integrates at exactly `DTPHYS = 0.1 s`. `js/main.js` keeps an accumulator
(`bank`): each frame adds `frame time × warp` to it (frame time is capped at 0.1 s of real time) and
spends it in whole `physStep(DTPHYS)` calls — at most 20,000 a frame (0.41 µs a coasting step, measured), so a frame too slow for its warp
falls behind the warp rather than take a coarser step. Warp changes how many steps a frame takes
and nothing else: ×1000 is 167 steps a frame at 60 fps, ×1 is one step every six frames, ×0.25 one
every twenty-four. The trajectory is therefore the same on a 60 Hz and a 144 Hz display and at
every warp, and it is the trajectory `tools/mission-sim.mjs` certifies (the tool steps at `H = 0.1`
always and says so in its source; anything that certifies a mission must use the same step).

- **What is drawn is interpolated, and `S` holds the DRAWN state between frames.** Ten steps a
  second would stutter, so after stepping, `show(bank / DTPHYS)` saves the true state in `T`, blends
  the last two steps into `S` (lerp of position and velocity, slerp of attitude) and sets the
  mission clock to the drawn instant. The camera, the vehicle, the HUD, the Moon, the weather and
  the terrain lookups all read that one state and one clock. `toTrue()` puts the true state back at
  the top of the next unpaused frame, before physics runs. Anything that steps or replaces the
  state from outside the frame loop must do what the `window.game` handle does: `toTrue()` first
  (`ff`, `teleport`), `retrue()` afterwards (`reset`, `teleport`, `ff`) so a stale `T` cannot
  overwrite the new state. A test that reads `S` or `game.state()` between frames reads a state up
  to one step old and blended; after `ff()` it is exact.
- **The pad-idle exception.** Standing on the pad with the engine off, SHIFT up and the target
  throttle under 0.05, a step is an exact rotation with the planet at any size (`physStep`'s
  hold-down branch), so the frame is ONE step of `frame time × warp` and nothing is interpolated.
  That condition is the exported `padIdle()` in `js/physics.js` — the frame loop and `warpCap()`
  both call it, so the step and the offer can never disagree.
  That is what makes **×10000 on the pad** affordable — a day in 8.6 s, for waiting out the night or
  the launch window — and `warpCap()` offers it under the same condition and no other. A pressed
  or open throttle is not idle: SHIFT at ×10000 once lit the engine inside a 167 s "idle" step.
- **Pause** (`WARPS[0] = 0`, ESC or `[`): nothing steps — not the physics, the planets, the exhaust
  or the debris — and `S` keeps the drawn state; the camera, the map and the HUD stay live.
  **×0.25** is the same 0.1 s steps, fewer per second; the interpolation is what makes it smooth.
- Warp is capped by place (`warpCap()`, enforced every frame by `guardWarp()`): ×4 below 70 km
  (×16 under fully open mains), ×4 within 15 km of the Moon, ×32 within 50 km, ×128 within 400 km,
  ×16 below 140 km of the Earth, ×8 while the engine burns, ×1000 below 2,000 km of the Earth,
  ×10000 within 30,000 km of the Earth or 5,000 km of the Moon, ×100000 beyond; it drops to ×1 on
  crossing the Moon's sphere of influence either way. `warpHorizon()` estimates the mission time to
  the next place that lowers the cap and `js/main.js` spends at most a quarter of it per frame, so
  a fast coast arrives eased down instead of a frame (10,000 s at ×100000) past the door. `capWhy` carries the reason to the log.

History, because these notes were wrong about it: before commit 55f18fa the step was
`min(0.1, simDt / steps)` — the frame time itself below ×6, 1/60 s at ×1 — while this file, the
README and `js/constants.js` all said warp only multiplied the number of substeps. An independent
review flew the certified window at the steps a browser actually took, with the tool's own
autopilot: Moon impact at 2,559 m/s instead of a 346 km pass. Measured after the fix, in the
real page with real keys against headless 0.1 s stepping: altitude and speed differ by 0.000 after
12.1 s at ×1 and 36.0 s at ×4.

The encounter is that sensitive: stepping the coast at 1 s instead of 0.1 s is worth hundreds of km
of periselene and the sign is not fixed — re-measured on the shipped round-trip coast-start state
it gives 658 km where the game's 0.1 s step gives 358 km; the same experiment on the previous
one-way state moved 346 km to an impact 475 km under the surface, 820 km. Related: the mission is
sensitive to ~130 km of periselene per 1e-3 rad of launch phase, and `MOON_PHASE0 = 2.1777643` is
solved for the current `TURN` table, the current stage masses **and the current forces** — change
the pitch program, the stacks, the step, the drag model or `gravityAt` and the window constant is
wrong. The flight-model commit moved it by 0.036 rad (4.9561012 → 4.9198031 for the same 200 km
aim), and adding the 50 t LM to the stack moved the window's phase outright to 2.1777643.

A corollary for anything that *predicts* the game: account for its discretisation. The step is
`simTime += dt`, gravity at the advanced time, `v += a·dt`, `p += v·dt` — leapfrog with the velocity
written half a step late. `js/targeting.js` (`lunarPass`) does not replay those steps; it starts a
velocity-Verlet integration from `(p, v + a·dt/2)` with a step that follows the local radius, which
lands on the game's own future in about a millisecond. A converged integration from the raw
`(p, v)` does not: the half-step term is worth about 100 km of periselene at the Moon. The
measured figures for both are in that file's header (they were not re-run for this note); change
the step, or predict from the raw state, and the readout lies.

## Rule: one aerodynamic evaluation feeds both the trajectory and the attitude

`accelAt(p, v, mass, thrustAcc, t, axis)` calls `aeroForce()` in `js/aero.js` once per step. The
force goes into the acceleration; the same call leaves its dynamic pressure, Mach number, angle of
attack and normal-force split in `aeroState`, and `physStep` builds the torque, the pitch damping
and the side-load check from that record. Do not compute a second "aero for rotation" from
`surfaceVel()` or a normalised q — that is what the old weathervane constants were, and a torque
that disagrees with the force it came from flies a vehicle whose nose and path answer to different
air. Corollaries, each read off the code or measured:

- Pass `axis` only for the vehicle. Debris and anything else without an attitude passes `null` and
  gets plain `CD_AREA` drag; it must not overwrite `aeroState`, and with `axis = null` it does not.
- `GEOM` in `js/stations.js` is the single table for mass distribution *and* aerodynamic shape, in
  build units (1 u = 1.4 m) at the stations `js/saturn.js` draws. Move a drawn stage and the centre
  of mass, the planform centroid and the fin arm all move with it; `stability()` returns the result
  as a static margin in metres. Measured: +3.2 m on the pad, +16.4 m at T+100 s as the S-1 drains,
  −10.3 m just after staging (no fins; q is 4.4 kPa by then and the side load stays under 0.006 g).
- The breakup limits (`LOAD_LIMIT_STACK = 0.5` g, `LOAD_LIMIT_CSM = 6` g) are set against the
  measured SAS ascent, whose peak is 0.016 g, **and against what the vehicle can generate at all**.
  The stack limit was 1.2 g for one commit and almost nothing reached it: full pitch held with SAS
  off through max-Q peaked at 0.93 g and flew on, because held broadside this airframe makes about
  1 g and no more — the five-stage stack's inversion tumbles peak at 0.67–1.03 g. A limit is only a
  rule if a measured manoeuvre crosses it.
- Failure is accumulated strain (`overstressed()`): `(load/limit − 1)` per second over the limit,
  relaxing 0.5/s under it, gone at 0.6 or at once above 3× the limit. Measured, pitch held SAS-off
  from T+60 s: released after 5 s it peaks 0.56 g with 18 % of the strain used; after 6 s, 0.58 g
  and 41 %; held, the nose goes through and breakup follows at T+115 s. The five-stage stack inverts
  and breaks up under every hold from T+40 s to T+100 s — every one of them crosses the limit now.
  Change `CD_CROSS`, `GEOM`, the stage masses or the strain constants and re-measure
  both tables in `docs/reference/atmosphere.md`.
- The command module alone is a different vehicle in the same code path: `aeroShape()` gives a bare
  capsule `CA = 1.1` and a 3 m² normal-force area at the apex so it is stable heat-shield-first;
  heat is `sqrt(rho)·v³` against `HEAT_SHIELD = 4`; canopy drag is solved implicitly because an
  explicit 0.1 s step overshoots under the mains. A capsule that starts apex-first rights itself in
  time at 7.8 km/s and does **not** at 11 km/s, −6.5° (burned up 23 s after a 122 km interface) —
  measured; do not write "the capsule always settles" anywhere.
- Entry has a floor and a ceiling now. `G_LIMIT = 16` g for `G_TIME = 2` s is `ENTRY TOO STEEP`
  (only with the engine off, below 150 km); a canopy is lost on deploy above its tear pressure, its
  Mach limit (1.5 drogues, 0.5 mains) or with the heat proxy over 0.5. Under an open canopy SAS and
  hold are ignored, and retrograde SAS below 120 km steers by `surfaceVel`, not `navVel` — inertial
  velocity under a parachute is 409 m/s of planet spin. A scripted entry must deploy by altitude or
  Mach, not by q alone: q is 0.08 kPa at 110 km and Mach 25.
- The pad is solid and the clock that matters off it is `tRelease`. `padHit()` (`js/colliders.js`)
  is tested from hold-down release, while `state` is still `'pad'`; swing arms are solid while
  `armSwing < 0.6` (0.9 s). The pitch program runs on `simTime − tRelease`. `markTeleported()` sets
  `tRelease = −1e9` and `armSwing = 1`, so a teleported vehicle is past both. A headless test that
  steers at ignition with SAS off will hit a swing arm at 0.8 s (yaw) or the ground at 14 s
  (pitch) — measured — so switch SAS on first unless the collision is what you are testing.
- `WARPS[0]` is 0 (paused) and `WARPS[1]` is 0.25. Start from `WARP_ONE`, set by value
  (`g.warp(1)`), and never treat index 0 as ×1. `guardWarp()` caps warp by place every frame and
  drops it to ×1 at the Moon's SOI, so a browser test that sets ×1000 in the air does not get it;
  `ff(seconds)` is not capped.
- `TLI_LEAD = 2.9159` rad is `ev.tliIgn.lead` from the shipped flight (the tool prints `lead` and
  `altE`). It moves with anything that moves the ascent or the window — `TURN`, the forces,
  `MOON_PHASE0`, `AIM_PERI` — so re-read it from the tool whenever those change. It is a cue for a
  hand-flown burn, not a targeting solution.
- A flight that can never come down ends. `stranded()` in `js/physics.js` runs every 50 steps once
  no attached stage holds propellant: a closed orbit clear of the air (periapsis above 130 km and
  apoapsis under 0.8 of the Moon's distance) or clear of the lunar ground (periapsis above 2 km) is
  `STRANDED IN ORBIT`; an Earth escape past 1.3 lunar distances is `LOST IN SPACE`. Both are
  losses with their own end card. A test that drains the tanks in orbit will be ended by it.
- **Open, known and not fixed:** about a pixel of shimmer on cloud outlines (`tools/flicker-test.mjs`
  measures it, see Verify); dark blotches near the terminator in the map were reported in a
  playtest and have not been re-checked since.
- **Known limit, not fixed:** in the browser the terrain height under the vehicle is read through
  the planet mesh's drawn rotation, which `syncTime()` sets once per rendered frame. At high warp
  the steps inside a frame see the ground where it was drawn — up to a frame of spin stale. Found in review,
  not measured. Headless there is no terrain and no lag.
- The flat rate damping is a control system now (`rcsAssist`, key T, reset to on by `resetSim()`).
  A test that wants free rotation in vacuum must call `toggleRcsAssist()`; a test that assumes rates
  die on their own is testing the assist.

## Harness gotchas (`tools/mission-sim.mjs`)

- It imports the real `js/*.js`. Phases: `ascent → tliwait → tli → mcc → approach → loi →
  orbitCheck → deorbit → toPeri → descend`, and for a round-trip stack (≥ 5 rows: demate,
  touchdown, ascent) additionally `→ lmClimb → lmCoast → lmRise → lmApex → lmTerminal → tei →
  tecoast → capsule`. Three-row stacks (`landed`, `retro`) pre-separate the LM rows and
  fly the one-way chain they were certified on; `nova` carries the shipped LM rows (5,525 t at
  ignition) and flies the round-trip chain — its 6,000 kN third stage is a ~39 g_moon thruster,
  outside the tool's own 1.2–2.2 g_moon lander sizing, so it was never a one-way lander.
- The launch phase is found by bisecting the first periselene (`probePeri` runs the mission with
  `capture: false, stopAtPeri: true`). The straddling corridor is ~0.004 rad wide and moves with
  every mass change, so the solve walks FORWARD FROM `MOON_PHASE0` in 0.002 rad steps to bracket
  it, then bisects — a coarse walk around the whole circle provably misses it (a 0.25 rad stride
  skipped the corridor on 32 consecutive probes and reported "no launch window").
- The `ev` record is the source for every measured number in `docs/reference/atmosphere.md` and
  `mission-design.md`: `maxQ`, `loadPeak`, `strainPeak`, `padMargin`, `stageMargin` (static margin
  and inertial speed at every staging), `ascent.rows` (MET/alt/q/Mach/α/side-load/margin every
  10 s), `dvDrag` (integrated axial drag loss; 23.8 m/s on the pre-LM stack, matching the script
  whose 24 m/s the docs quote), `aimLP` (`lunarPass` from `ev.tliDone`, scored against the flown
  periselene). Add telemetry there rather than writing throwaway scripts, and move the docs with
  the run.
- `stages[i].dry` is copied at import time by `js/saturn.js`, and `resetSim()` re-syncs only
  `fuel`. If you override `SPECS`, you MUST write `stages[i].dry` too, or you fly the old airframe.
- `P.setSas(on, retro)` — the second argument is **retrograde**, not "prograde".
- The solid first stage cannot be throttled or shut down (`physStep` forces `targetThrottle = 1`
  while stage 0 is attached and lit), so `engineOn` stays true after a `toggleIgnite()` on the pad.
  To reach a genuine no-thrust state for a test, call `separateStage()`: it clears `engineOn`,
  `targetThrottle` and `throttle`.
- Mid-course correction burns run for the round-trip `game` and `nova` stacks only, gated on
  `fuel > 5 t` with a budget of eight burns. The shipped CSM holds 56.2 t after TLI and the
  certified flight fired **zero** trim burns (the first aim check read 357 km). `landed` flies
  with no MCC machinery: that encounter really is decided at injection.
- The round-trip chain's guidance laws were each tuned by measurement and are documented where
  they live — do not simplify them from this file. What they are, in one line each: LOI holds at
  periselene and may spend up to four revolutions before it cuts (`loiPeri`, `L.alt ≤` periselene
  `+ 50` to arm; past rev 4 the pass is abandoned as `dry`); the LM demates near periselene and
  `insert` burns retrograde while the **predicted** periapsis (vis-viva + angular momentum, valid
  mid-burn) sits above `RM + 350` km; the terminal approach to the rail is a Hill/Clohessy-Wiltshire
  V-bar servo at 10 Hz (an earlier absolute-velocity homing law flew backwards); TEI aims the
  lunar-departure asymptote, not the raw geocentric corridor state (`teiEscape` — the Moon will
  not release a bound vehicle, and three cuts at the corridor velocity itself never left 2,000 km),
  with mid-coast taps refining the Earth corridor outside the sphere. Inside the sphere the
  co-rotating frame has equilibria and the Earth's tidal term cancels ~7.6 m/s of the Kepler
  rate — altitude-drift phasing laws written from two-body intuition break there; the events
  (`ev.touchMoon`, `ev.insert`, `ev.dock`) are the ground truth for anything quoted.
- The descent guidance law (`a_cmd = (v_des − v)/τ + dv_des/dt − g_abs + g_moon`, τ = 2.5 s, with the
  altitude-bounded velocity envelope) was tuned by measurement. Simplify it and you get 41 m/s, 62
  m/s or 220 m/s impacts, all of which have been observed. Attitude must be commanded through the
  body-rate in the game's SAS convention; writing `S.q` directly gives `align −0.93` and a crater.
- Contact is `surfaceAlt() <= 0`: the lowest attached point (the active stage's bell — for the last
  stage the soles of its landing gear, `GEAR_Z = 6.2` u in `js/stations.js`, 0.6 u under the bell's
  exit at `TAIL_Z[2]` — or the nose if inverted) over the terrain. Headless there is no terrain — `initPhysics` gets no `relief`, so the
  tool lands on the datum sphere, and its touchdown speed says nothing about a hillside. The descent
  guidance reads the same `P.surfaceAlt(true)`; when it read the altitude of `S.pos` instead it met
  the ground believing it had 52 m left, and the touchdown at that window was 20.4 m/s where the
  fix made it 4.2.
- The launch-phase solve only looks at the first periselene, so it is blind to anything that happens
  after it. A change to contact, descent guidance or `LAND_SAFE` does not move `MOON_PHASE0`, but it
  can move the corridor's edge onto the window: re-fly the neighbours (`--phase=` ±0.25e-3 … ±3e-3),
  not just the shipped phase.
- `airDensity(alt)` (in `js/aero.js`, re-exported by `physics.js`) returns exactly 0 above
  `ATMO_TOP = 420` km, so coast trajectories are drag-free. The air's own velocity is `airVel(p, out)`
  in the same file; nothing else may write `ω × r` by hand.
- **The return-corridor ladder's minimum impulse bit is the engine.** A tap asking less than one
  full-throttle step (`a·H` ≈ 7–9 m/s at 66–90 t) used to cut at step 0 (`teiAcc >= dv − a·H`) and
  burn nothing forever: nova@0.82 stalled at 6.5 m/s across 17 zero-burn taps, and the game chain's
  late passes ended on zero-burn taps too, rescued only by Moon-tide kicks over the 20 m/s re-arm.
  The law (`teicorr`): full throttle when the ask ≥ 2·a·H, else `thr = sqrt(ask/4a)` cut at
  `2a·thr² + 0.0004` — the throttle ramps ±0.25/s (`js/physics.js`), so a ramp-up/down pair at
  throttle τ delivers exactly 4aτ²; that is the quantum the cut leaves for. Hand-back floor 5 m/s:
  micro-taps overshoot ~1.4× and 4 m/s was unreachable by construction.
- **`teiIter` counts taps per pass; `teiFixAcc` is the mission budget.** The re-arm resets the tap
  counter (40 per pass) — cumulative starved the late passes (nova@0.82 spent 23 of 40 in one
  locked pass). Δv asks are cumulative, capped 0.45 km/s, measured both ways (comment at
  `teicorr`): 1 km/s never starves but the tide re-kicks every ~27 ks forever, and the cert phase
  then burns 1,751 m/s of corrections arriving 21.3 d out; at 0.45 the certified chains land in
  ~13.5 d having spent 779–880 m/s. What the cap can do to a needy geometry — silence the ladder
  mid-work with fuel aboard, a 25 g entry — was measured on the pre-awarded-touchdown chain at
  wait=120; with the descent fixed that same flight comes home on the 0.45 cap in 20.519 d, so
  nothing starves today and the number is a measured stability bound, not a live failure.
- **Touchdown is the game's award, not the tool's observation.** The `descend` guard waits for
  `P.landing.landedOnMoon` — physics records TOUCHDOWN only on a contact step with the engine out
  (`isBurning()` defers it), and that flag is the sticky one (`moonPerch` reads false under any
  powered state). A guard keyed on contact debriefed `0.0 m/s, 0.0°` for a powered touchdown the
  game never awarded — those were `landing.speed`'s initial values. A stack that runs its descent
  tank dry above the surface lands through a throttle-ramp hop; the certified landing is whatever
  physics wrote (currently 3.7 m/s at 27.4° tilt).
- The exit code is the verdict: `game`, `landed` and `nova` must WIN, `retro` must LOSE, and
  `--expect=won|lost|any` overrides. The solve (no `--phase`) is not part of `npm test`.

## Renderer rules

Short and imperative. Each was found by measurement, not by reading; the measurement, the symptom
and the history behind each are in the appendix at the end of this file, under the same headings.

### Shaders

- A custom `ShaderMaterial` starts its vertex shader with `#include <common>` and carries all four
  log-depth chunks: `<logdepthbuf_pars_vertex>` and `<logdepthbuf_vertex>` in the vertex stage,
  `<logdepthbuf_pars_fragment>` and `<logdepthbuf_fragment>` in the fragment stage.
- `#include <logdepthbuf_fragment>` goes INSIDE `void main()`. It is a statement.
- No backtick in a comment inside a GLSL template literal. If the linter reports a brace mismatch
  your eyes cannot find, look for a backtick first.
- A function-like `#define` must not name a parameter that also appears as a swizzle in its body,
  and takes no space before its parenthesis.
- A `#define` used by an injected helper goes in the injected text, not in the host's preamble.
- Run `node tools/shader-lint.mjs` before the page sees a new shader. A bad loop can hang the GPU
  process of every open tab the dev server reloads.
- One `onBeforeCompile` per material, with every uniform bound at compile time. If a uniform must
  be bound late, give the material a `customProgramCacheKey` that changes with it.
- After any custom-shader change, count the console on a fresh load: a failed program logs one
  `console.error` and then simply draws nothing. `tools/shots.mjs` fails on it.
- Hand a raw `ShaderMaterial` the colours it should show (`setHex(hex, THREE.LinearSRGBColorSpace)`
  or `hex/255` triples): nothing encodes its output.

### Textures, ramps and painted data

- A texture whose information is in alpha is bound as `map`. `alphaMap` reads GREEN.
- Allocate a canvas or data texture at its final size and fill it in place (`drawImage`); never
  replace `texture.image` with a larger canvas.
- An N-texel nearest ramp steps at N·L = 2k/N − 1. Check the sun table in
  `docs/reference/launch-site.md` against the boundaries before changing a ramp.
- A colour source for the ground varies slower than the coarsest vertex that samples it.
- Nothing tiles across a large mesh from per-vertex uv: rebuild the uv per fragment.
- Surfaces are painted from data, not imagery, and the biome rule keys on red − blue, not hue.
- The ground is drawn per fragment by `js/surface.js`, the same function on the globe and the near
  patch. Anything shaded by slope needs the gradient term; a patch differences its coarse octaves
  in the vertex stage; no relief octave under ~25 px per cell.
- Test a filter against brute force before tuning anything on it.
- When many features claim one vertex or texel, compose tone by MAX, not by product.

### Weather

These five are carried as written — rule and history together — because `js/clouds.js` and
`js/cloudfields.js` are being reworked separately; that work owns this block.

- **Weather is one field drawn as shapes, and a coverage field must move coverage, not opacity.**
  `js/clouds.js` is a sphere at RE + 11 km; `js/cloudfields.js` is the data. A cloud is where one
  scalar field exceeds one threshold that climbs with height, found by a short walk and a bisection —
  an opaque surface, not an optical depth. The macro sheet moves the *fraction of sky covered*
  (thresholds are solved from the uploaded bytes); scaling density by it instead gave a planet-wide
  white fog with no edges. Unresolved octaves drop out through explicit mips and the remaining
  contrast is scaled back up, so far cloud simplifies instead of dissolving — never swap the field
  for "density = coverage", which is the grey smear orbit used to wear. The shell keeps
  `castShadow = false` — a low sun drags its silhouette hundreds of kilometres through the ±48 km
  shadow box — and ground shade is the same field looked up along the sun ray, injected into the
  globe and the patch. See `docs/reference/painted-planets.md`.
- **A ray walk may not read the field finer than its stride.** A lobe narrower than the stride is hit
  by some rays and jumped by their neighbours, and the cloud comes out as the slices the samples cut:
  a stack of plates from the pad, a comb on every flank. Jitter hid this in the old march and paid
  for it in stipple; the fix is to band-limit the read (explicit `textureLod`) to twice the stride.
- **The weather is not the same field at every altitude, and the clock is the EYE's.** 8 % of
  fair-weather cumulus everywhere is a sky from the pad and polka dots from 500 km, and no mip trick
  fixes it — at 500 km the cells are resolved, the field *is* dots. `orbit` (0 below 50 km of eye
  altitude, 1 above 200, set in `setWeatherEye`) mixes the macro term from the sheet's red channel
  to its blue one, the synoptic sheet (`drawSystems` in `js/cloudfields.js`): commas with fronts,
  trade fields, decks, tropical cyclones, and 42 % of the planet with nothing in it. Everything else
  gated on `orbit` is worth exactly nothing at the pad and must stay that way. Three things learned
  drawing it: a diagonal stripe in a 20 km texture is a string of beads (the streets are a `sin` in
  the shader, the texture's alpha only says where); a slanted pixel is a strip `1 / cos(zenith)`
  long and a field read at its width aliases into rows of dashes at the limb; a mask multiplied by
  a latitude gate has the gate's straight edge (add the gate to the noise before the threshold).
  `tools/cloud-views.mjs --climb` is the pop test, `--flicker` the idle-frame diff.
- **A hard threshold turns noise in its argument into flicker along its whole outline, so nothing
  noisy may reach one.** Cloud outlines flipped (353 A-B-A pixels in ten idle frames) for three
  reasons, each found by reading the half-resolution target back frame by frame: the view ray was
  built from the shell's interpolated surface — 6,382 km minus 6,371 km in float32, half a metre of
  new rounding every frame — instead of from `gl_FragCoord` and the inverse projection; coverage
  was 1 on a hit and at most 0.5 on a miss, so an outline pixel jumped between the two; and a crest
  between samples was only looked at when the whole ray missed. `tools/cloud-views.mjs --flicker
  --freeze=drift,sun,ride` is the instrument: with every input the weather reads held still, any
  pixel that still flips is arithmetic, not weather (884 before, 49 after). Do not reach for a blur.
- **A half-resolution pass can still have a full-resolution edge.** The weather target holds
  coverage as a ramp through 0.5 and light as a scalar, not a colour; the main pass thresholds them
  per screen pixel. Upsampling a colour blurs it, upsampling a ramp and cutting it does not.
- **Sixteen opaque draws in one render pass are one draw to a tile-based GPU.** A timing harness
  that repeats a pass to amplify it must clear between repeats, or the figure is sixteen times low;
  and a single light frame reads 0.7 to 2.5 ms for the same picture, so do amplify.
  `tools/cloud-views.mjs` does both.

### Ground, shadows, precision and sky

- The near patch and the globe are one surface: any material property on one belongs on the other
  (`js/haze.js` on both, the same `emissive`, no scene fog on either).
- The near patch IS the contact surface: no display lift under the vehicle. A test camera adds the
  ground height to its altitude.
- A bake that writes a vertex attribute rejects non-finite output; a harness counts non-finite
  channels and fails on any. Assert a normal buffer's distribution, not its length
  (`patchAudit()` in `js/terrain.js` does both).
- Roads, aprons and decks are geometry (`js/pad.js`), never ground colour.
- No two surfaces share a plane. `js/pad.js`'s header lists the heights nothing may share, and
  `tools/flicker-test.mjs` fails on any coplanar overlapping pair.
- The scene is drawn from the eye, in the Earth's axes (`js/origin.js`): `setOrigin(scene, eye,
  spin)` each frame sets the scene's position to minus the eye and turns it back by the planet's
  spin, so a thing bolted to the ground gets the same float32 matrix every frame. Therefore:
  - The camera is a child of the scene. **Never call `camera.lookAt`**; `js/camera.js` builds the
    look-at by hand.
  - A `matrixWorld` read in JavaScript is eye-relative AND turned. Use `padMatrix()` in
    `js/world.js`, or `absolute()` from `origin.js`.
  - A shader that needs a planet-centred position adds `uOrigin` and gets it in the EARTH-FIXED
    frame; turn any inertial direction it uses (the sun) the same way first (`frameDir()`, or as
    `updateSky` does). Use it only for things kilometres across.
- Shadows are `PCFShadowMap`, 4096², in a box that tracks the vehicle: ±3 km on the ground
  (1.46 m/texel) growing with height to ±48 km in quarter-octave steps, and the sun stops casting
  above 30 km. The box's centre is a point in the Earth-fixed frame that moves by whole texels, and
  only when the vehicle is 8 texels from it. Do not resize or re-centre it continuously.
- The weather shell casts no shadow-map shadow; its ground shade is `js/clouds.js`'s own lookup
  along the sun ray, injected into the globe and the patch.
- The Moon does not cast into the shadow map (it self-shadowed the whole near field); it receives.
- Mix sky colour on the quartic of `exp(−alt/80)` for the dome and the background; the fog keeps the
  squared clock; stars threshold on sRGB lightness, not the linear buffer.
- The sky follows the sun. `updateSky` multiplies the dome, the background and the fog by
  `smoothstep(sun elevation sine, −0.14, 0.09)` — night falls through a short twilight — the limb
  shell's night floor is 0.012 from inside the air and 0.14 from space, and the pad's floodlight
  sprites come on between +0.05 and −0.10. The sun's bearing is inertial and fixed (`SUN_DIR`): the
  planet turns under it, so waiting on the pad is how night comes.

- Cel light is three's own chunks, patched once in `js/toon.js` (the patch throws if three's text
  moves): a cast shadow is four fixed taps cut at one half and caps the ramp at `CEL_FLOOR`.
- The vehicle and pad use `hardware()` / `padware()` materials; `js/world.js` fills their
  `CEL_HARDWARE` uniforms each frame (sun above the limb at that place, floodlights). `HARD_GAIN = π`.
- The sun LIGHT moves in `SUN_STEP` steps (27 s), held in the Earth's frame between them; the sky
  and terminator use the true direction.
- Receivers thinner than a shadow texel (the red lattice, small parts at the vehicle's foot) cast
  but do not receive.
- A mesh inside an invisible group is still `visible` to `tools/flicker-test.mjs`; pose hidden
  things too.

- **A toon ramp shades a form; night is not the shadow side of one.** `RAMP_EARTH`'s lowest band is
  34 % of noon, so the globe's night side was lit at a third of daylight and the far ground glowed
  green at night beside a navy near field (the 3 km shadow box hid it close in). The Earth's ground
  exports `sfLit` (cuts the sun's term below the horizon) and `sfTwi` (twilight, as INDIRECT sky
  light: a set sun has no direction for a shadow map, and left in the direct term the shadow box
  drew its own outline 40 km across the dusk). Anything standing on the ground that is not
  floodlit takes the same two numbers (`js/cape.js` does, for itself; the pad's slabs are `padware` and must not be given a second `onBeforeCompile` — that left the apron black).
- **A flat step in sun elevation is a ruled line across the landscape.** Everything else in the
  ground shader is a flat tone behind an edge; daylight is the exception, twice tried.
- **Light that must read as light is written past 1.** A lit toon surface shows albedo × light / π.
  Foam and the sun's glint as palette whites came out grey; they are 2.3–3.0 in linear.
- **A lattice reject box must be the exact bound of what the cell can reach.** `js/mooncraters.js`
  derives it (0.644 of a cell); the shader uses the same number. Tighter cuts craters off along
  lattice planes — an 85° wall in the lunar patch, a ruled edge in the drawing — and
  `tools/crater-stats.mjs` gates the largest 2 m height step at 8 m (it found 499 m). Looser costs
  frame time: 3.4 candidate cells of 8 instead of 2.1 was half the Moon's frame again.
- **The lunar ground is relief grid + crater ladder, in three places that must stay one function**:
  `moonGroundHeight` (contact, camera, dust), the patch's vertices (`js/terrain.js`), and the
  drawing (`js/surface-moon.js`, same hash). The patch re-centres by HEIGHT, not by distance flown,
  or a lander arrives on 400 m triangles that are not the craters it is landing in. Verify with
  `tools/terrain-views.mjs <dir> <port> moon-landed`: it raycasts the drawn patch under a landed
  CSM (measured 0.00–0.07 m at four sites, one 2.45 km under the datum).
- **A patch rebuild is sliced.** Rows into back buffers inside 3.5 ms a frame, swapped in whole with
  the anchor and the globe's hole. Anything new in the per-vertex height must be cheap per call and
  safe to evaluate across frames (no state that the next frame changes).
- **Flat things on the ground are drawn by the ground; only what stands up is geometry.** Roads,
  the crawlerway beyond the pad's own slabs, ponds, beach and canal are in `js/surface-earth.js`
  from `js/padsite.js`'s fields. A slab on terrain is two surfaces on one plane.

### Exhaust

- If a parameter appears to have no effect, read the arithmetic that consumes it before changing
  its value: check that a factor is applied to all three components.
- Spread a frame's parcels along the path the vehicle flew in that frame (`spawnPlume`
  back-projects each by its slice of the step).
- Earth-side, no parcels are emitted above 52 km; nozzle parcels
  are not born more than ~450 m up. Above that the drawn flame is the exhaust. Lunar parcels are
  exempt.
- The trench hit bleeds tangential velocity to 0.12 on Earth, and `BILLOW` of the deflected parcels
  become the lasting pad cloud.
- Smoke is opaque, depth-writing, unsorted (`NoBlending`, its own `gl_FragDepth`). Nothing in the
  exhaust is additive: sparks and the staging flash are opaque shards in the main pass
  (renderOrder 6).
- A trail is continuous only when a puff is wider than the gap to the next: trail puffs are born
  at least a sixtieth of the airspeed in radius, and thin air shortens their life, not their size.
- The integrator clamps generic parcels to `R_CAP` (16 m); growth-free kinds are exempt.
- A clustered stage has one merged envelope under its jets; it widens on `vac²` and thins on `vac³`.
- The fire lights the smoke in the puff shader (`setFireLight`); there is no scene light for it.
- Lunar dust is flat grey lenses plus `js/dust-sheet.js` on `moonGroundHeight`; free gas is not
  drawn in vacuum.
- On an end card `stepExhaust(dt, frame)` advances parcels relative to the frozen frame, or they
  slide off at the planet's spin.
- `impact()` calls `explode()` before the splashdown branch; `js/vehicle.js` decides the drawn event
  a frame later and takes the sparks back at a safe splashdown.
- Physics spawns at the true state and the picture is up to a step behind: parcels and dropped
  stages spawned by physics are re-seated on the drawn vehicle the next frame.
- `js/entry-fx.js` is one closed mesh drawn back faces only, on `getHeat()` (nothing under 0.5) and
  `getCooking()`. `js/splash-fx.js` draws the water landing.
- `half` is a reserved word in GLSL ES 3 and the linter does not catch it.
- Pausing just after automatic staging: 20-36 pixels still change 0.3 s after the pause and 0 from
  1.2 s on (three runs). The tens of thousands reported earlier did not reproduce on this tree.
- The flame is one mesh drawn twice: full resolution in the main pass (renderOrder 1), and again
  into the FX target as an eraser with `ZeroFactor / OneMinusSrcAlphaFactor`.
- Smoke shadows come from the layer-0 `Points` with a `customDepthMaterial` in
  `js/exhaust-draw.js`, not from the puffs.
- Smoke growth multiplies `airDensity(alt)`; debris trails are gated at ρ > 0.02. Nothing grows in
  vacuum.
- Soft, fill-bound layers go in `js/halfres.js`. A shader there sees pixels twice the size (scale
  footprints and point sizes by `RES_SCALE`); a new opaque mesh goes through `occlude()` or smoke
  draws over it; white noise, not ordered dither, in anything the tent filters.
- Shoot a lunar surface burn from the orbit camera.

### Camera, map and trajectory ribbon

- A closed orbit is drawn on the map as the whole analytic ellipse (`js/mapview.js`, from the
  elements `js/predictor.js` exports in `path`), with Ap and Pe markers; a transfer or escape is the
  integrated coast. In the flight view the ribbon thins and fades with distance from the eye
  (`ribbon.setFade`): at constant width a far leg read as a sharp corner.
- The cockpit (throttle, navball, modes) and the stage list stay up on the map.
- Sound is muted with N or the SOUND chip: one master gain in `js/audio.js` that every source
  connects through, remembered in `localStorage` (the game plays the same without it).
- Navball markers are KSP's: prograde ring with three spurs, retrograde ring with a cross, normal
  triangles, radial rings; a marker on the far side is pinned inside the rim with a chevron.
- A dropped stage is stepped at `DTPHYS` like the ship and lives until it lands or is 5,000 km
  away (`tools/debris-orbit.mjs`).

- The trajectory ribbon is the engine-off, drag-free coast from the present state (the orbit the
  ship is ON), and its apsis markers are the conic's own; `tools/orbit-line.mjs` gates that the
  ribbon's apoapsis equals the state vector's, engine lit and cut. Do not integrate the burn into it.

- Collide the camera twice per frame — the wanted place and the blended one — three rounds each,
  ground last, with a sideways escape if it is still inside the hull. `tools/clip-test.mjs` sweeps it.
- The hull collider's basis must stay orthonormal: when the axis is parallel to `up` (every vertical
  pose) `shipAxes` builds its fallback by crossing the axis itself, never `X_AXIS` — a reference
  sharing the axis overcounts the ellipsoid's `s²` by 1/sin² and a camera inside the hull reads far
  outside (the moon-30 m view parked it 1.4 m off the vehicle centre that way).
- The pad collider is two ellipsoids and a box in the pad's frame (`padMatrix()`), not a dome: the camera
  must be able to stand on the apron.
- Start a damped quantity at its target.
- Nothing moves the camera but the user: no "home", no timer. Orbit carries its heading with the
  ship; chase sits behind the flight path, not the nose. Double-click re-centres.
- Damp the camera's offset from its target, never its position. The target is the middle of the
  hardware still attached, not `S.pos`.
- Below 20 km the carried heading turns with the planet; between 20 and 120 km that fades out, and
  above 120 km it is inertial (`updateCamera`).
- The map is the real scene from the map camera, up along the pole of the Moon's orbit; it hides
  the weather and takes its sky from where the eye is. The arrow keys and − / = belong to the
  camera; W A S D Q E fly the ship.
- Integrate the predicted path on one clock (5 Hz, stored body-relative with mission times) and
  draw it on another (every frame, from where the ship is): a gap of 9 % of the camera distance, a
  five-vertex fade-in, one lap of a closed orbit, lunar paths stored Moon-relative, vertices as
  offsets from a group on the ship.

### Measuring

- Frame time is not GPU time. Measure with `tools/gpu-time.mjs` (timer queries, retina buffer);
  rAF deltas are vsync.
- A timing harness that repeats a pass to amplify it clears between repeats.
- Do not trust whole-frame mean error between two frames; use spatial masks, flip counts
  (`tools/flicker-test.mjs`) and the eyes.
- Do not save a file under `js/`, `css/` or `index.html` while a browser measurement is running
  against the shared dev server: every open page reloads.

## Browser recipe

The dev server must be running on a port of your own (`node server.js 8000`; never 8078, which is
the user's). With the harness browser:

```js
const tab = browser.open({ name: 'lift', url: 'http://127.0.0.1:8000/index.html' });
await tab.reload({ wait_until: 'networkidle2' });
await tab.evaluate(`(async () => {
  const g = window.game;
  g.ignite(); g.ff(20); g.stage();                      // stage() cuts the engine: throttle really 0
  g.teleport(pos, vel, simTime);                        // time included: the Moon is a function of it
  const T = await import('/js/targeting.js'), P = await import('/js/physics.js');   // the game's own module instances
  const pass = T.lunarPass(P.S.pos, P.S.v, P.getSimTime(), { alt: 0, t: 0 }).alt;   // km; -1 is an impact
})()`);
```

- Read HUD text only after `await new Promise(r => setTimeout(r, 700))`. A hidden tab throttles
  `requestAnimationFrame`, so counting frames or awaiting rAF gives stale text like `0 m/s ground`.
  `updateAim()` refreshes `aim` at most every 250 ms of wall clock; for a number now, call
  `lunarPass()` yourself.
- `ff(seconds)` steps the shipped `physStep` at 0.1 s without rendering; it is how a multi-day coast
  is crossed in a test. It leaves `S` true; between rendered frames `S` and `getSimTime()` are the
  DRAWN, interpolated state (see "the step is part of the trajectory"), up to 0.1 s behind.
- Turn the engine off before teleporting if you are checking an impact speed, or thrust adds to it.
- Cross-check the readout against the tool: `node tools/mission-sim.mjs game --phase=…` records the
  coast-start state (`ev.tliDone`, with millisecond time — rounding it to seconds shifts the Moon by
  ~1 km and the encounter by hundreds), which is exactly what `teleport` wants.
- `tab.screenshot({silent: true})` returns a **path**; you have to read the file to see the image.
- `(await tab.errors()).entries` is **cumulative across reloads**. Filter on `Date.now() - e.ts < N`
  or you will chase an error the page has already left behind.
- `gl.readPixels` on the game canvas returns all zeros (`preserveDrawingBuffer: false`). It is never
  evidence of anything; take a screenshot instead.
- To isolate one object in the scene, get the scene through the prediction line
  (`(await import('/js/predictor.js')).predLine.parent`) and index the spheres by
  `Math.round(o.geometry.parameters.radius)`: Earth 6371, weather shell 6382,
  atmosphere shell 6435, Moon 1737. Hiding one at a time and screenshotting is how the grey-wedge
  artefact turned out to be cloud alpha rather than a shadow.
- **`mesh.visible = false` is not a toggle for anything that re-centres.** `updatePatch` and
  `updateMoonPatch` set `visible = true` on every frame they run (including their early-return path),
  so an A/B that hides a mesh silently un-hides it a frame later. Isolate with
  `mesh.geometry.setDrawRange(0, 0)`, which no update touches, and reload between cases — module state
  like `receiveShadow` survives `reset()` and contaminates the next measurement.
- **Neither camera looks at the ground unless you turn it there.** A limb view shows the surface as
  a few pixels of mip-blurred mean colour — that is how a perfectly painted Earth looked
  "featureless from orbit" for a whole session. The old recipe (point the vehicle's +Z at local up)
  only worked while the camera took its heading from the nose, which it no longer does; pose the
  view with `g.setView(yaw, pitch, dist)` (snapped) instead — not yet verified to reach a true
  nadir — and aim at a continent rather than trusting the ship to be over land.
- Take the teleport velocity from the sim, not from `EARTH_SPIN × r`: capture `S.v` right after
  `g.reset()` and reuse it, otherwise the vehicle arrives with the wrong ground speed and the frame
  ends in `RE-ENTRY DISASTER` before you can screenshot.
- If the tab answers `Tab "lift" is frozen`, recover with `browser.tab('lift').close()` and reopen it;
  evaluating against it will not wake it.
- Frame cost: sample 90 `requestAnimationFrame` deltas and report median and p90. A hidden tab
  throttles rAF, so keep the tab visible.
- **You can test the camera without the game booting.** `js/camera.js` only needs `S`, so set
  `S.pos`/`S.v` yourself and call `updateCamera(1/60)` in a loop, then assert on `camera.position`.
  Drag input is real pointer events on `#gl` (`movementX/Y` go in the `PointerEvent` constructor; stub
  `HTMLCanvasElement.prototype.setPointerCapture` first or the synthetic `pointerdown` throws). Note
  that the collider reads the Moon at `getSimTime()`, so compare against `moonPos(getSimTime(), …)` —
  comparing against a Moon you advance yourself measures the Moon's motion, not the collision.
- The dev server hot-reloads on every save, so an agent's half-written file reliably breaks the page
  mid-verification. If `window.game` is missing, that is why: the module graph (`SyntaxError` or a
  missing export) is the failure, not the thing you were testing.

## Structure


**Flight (display-free where noted — `tools/mission-sim.mjs` imports these headless)**
- `js/constants.js` — every physical constant, `SPECS`, `WARPS`, `DTPHYS`, `TURN`, `MOON_PHASE0`, each with the measurement behind it. Display-free.
- `js/stations.js` — the vehicle's axial stations and radii and the `GEOM` mass/aero table, written once. Display-free, import-free.
- `js/physics.js` — the integrator (`physStep`), frames (`navVel` / `groundVel` / `bodyUp`), staging, SAS and hold, loads, entry, parachutes, contact, end states. Display-free.
- `js/aero.js` — density, `airVel`, Mach drag rise, the one `aeroForce()` evaluation. Display-free.
- `js/colliders.js` — the one table of pad solids and swing arms: what `pad.js` draws and what `physics.js` hits. Display-free.
- `js/targeting.js` — predicted closest lunar approach (`lunarPass`), the trim hint (`aim.trim`) and the SAS injection cutoff (`cutoffNow`).
- `js/predictor.js` — the trajectory ribbon ahead of the ship, apsis markers, the impact warning.

**Vehicle and exhaust**
- `js/saturn.js` — the Saturn V as drawn hardware and the stage records (imported headless: must tolerate having no canvas). The LM launches inside the drawn SLA adapter (`adapterGroup`, jettisoned at the SM engine's first burn in space) — display-only, its mass is carried by GEOM row 2.
- `js/chutes.js` — the drawn drogues and mains; what is deployed is `physics.js`'s state, the pendulum is the mission clock's, and the collapse after splashdown runs on real seconds, held while paused.
- `js/gear.js` — when the lander's legs are down (`saturn.js` owns the legs and `setGear()`), and each foot's trim to its own ground.
- `js/vehicle.js` — the conductor: pose, staging (`detachStage`, `resetStages`), debris, and `updateBurnVisuals`, which turns "this stage is burning" into calls on the five exhaust modules.
- `js/entry-fx.js` — entry heating. `js/splash-fx.js` — the splash of a water landing. `js/dust-sheet.js` — the sheet of dust a lunar burn drives along the ground. All display-only, riding `updateParticles`.
- `js/flame.js` — the drawn flames. `js/exhaust-pool.js` — the parcel pool and `spawnParticle`. `js/exhaust-emit.js` — where parcels are born. `js/exhaust-sim.js` — how they move (the largest; its lunar and Earth branches are the next split if it grows). `js/exhaust-draw.js` — how they are drawn, and their shadow caster.

**Worlds**
- `js/world.js` — Earth, Moon, sky dome, limb shell, stars, the sun and its shadow box, the pad's mount; terrain lookups (`groundHeight`, `fineGroundHeight`, `moonGroundHeight`), `padMatrix()`, `syncTime()`, `updateSky()`.
- `js/terrain.js` — the near patch of each body, re-centred on the vehicle. `js/surface.js`, `js/surface-earth.js`, `js/surface-moon.js` — the ground, drawn per fragment.
- `js/toonmap.js` — the registry of paint products. `js/earthpaint.js`, `js/moonpaint.js`, `js/paintkit.js` — the painters. `js/padsite.js` — the authored launch site. `js/palette.js`, `js/textures.js` — shared palettes and sheets.
- `js/cape.js` — everything that stands within 6 km of the pad, one merged mesh. `js/mooncraters.js` — the crater ladder as numbers (display-free).
- `js/pad.js` — Launch Complex 39 as drawn. `js/clouds.js`, `js/cloudfields.js` — the weather shell and its data. `js/haze.js` — aerial perspective, one law for patch and globe.

**Rendering and interface**
- `js/main.js` — renderer bootstrap, adaptive render scale, keys, the frame loop (accumulator, interpolation, pause), the failure cards, `window.game`.
- `js/origin.js` — the floating origin and the Earth-fixed render frame (`setOrigin`, `uOrigin`, `frameDir`, `absolute`).
- `js/camera.js` — orbit, chase and map cameras, input, colliders. `js/mapview.js` — what the map adds to the scene.
- `js/hud.js` — readouts, toasts, the `NEXT` line, end overlay and debrief. `js/navball.js` — the attitude ball and the orbit plot.
- `js/halfres.js` — the half-resolution passes. `js/ribbon.js` — screen-space ribbons. `js/toon.js` — cel materials, ramps, outlines. `js/audio.js` — engine, wind and impact sound.

**Tools**
- `tools/check.mjs` — `npm test`. `tools/mission-sim.mjs` — flies the mission headless. `tools/mission-math.py` — derived numbers, checked against code and docs. `tools/shader-lint.mjs` — static GLSL rules.
- `tools/shots.mjs`, `tools/clip-test.mjs`, `tools/flicker-test.mjs` — the browser gates. `tools/trail-offset.mjs` (smoke column on the flame at every warp), `tools/orbit-line.mjs` (the ribbon is the ship's own orbit) and `tools/debris-orbit.mjs` (a dropped stage stays up) are browser gates too; `tools/crater-stats.mjs` (lunar relief continuity) is a headless one. `tools/gpu-time.mjs`, `tools/cloud-views.mjs`, `tools/terrain-views.mjs`, `tools/boot-time.mjs` — measurements. `tools/lib/browser.mjs` — how all of them find and launch Chromium.

  closed, and because every save hot-reloads, the user's own Chrome loaded the same shader and lost
  WebGL for the session (`GL_VENDOR = Disabled`; only a browser restart clears it). Two neighbours of
  that bug render *nothing* with no error at all: `atan2` (not GLSL; fails the link) and an array
  function parameter written through (parameters are `in`; the caller keeps its zeros).
  `tools/shader-lint.mjs` now rejects all three and reads shaders composed from named constants —
  it used to match only an inline template after `vertexShader:` and passed these unread. Run it
  before the page sees a new shader, and recover a hung harness with
  `browser.close({ all: true, kill: true })`.
- **A late-bound `onBeforeCompile` uniform never reaches an already-cached program.** Three r160 keys
  the program cache on `onBeforeCompile.toString()`; assigning a texture a second after boot and setting
  `material.needsUpdate` re-fetches the SAME cached program (the function's source didn't change), so
  the injection silently never compiles. Measured with a magenta probe: the whole coast-shelf band
  forced to `0xff00ff` produced not one magenta pixel at 160 km, while `onBeforeCompile.toString()` in
  the page showed the new source. Fix: `material.customProgramCacheKey = () => (bound ? 'on' : 'off')`
  next to the late assignment (js/world.js does this for the coast ink).
- **A dead ShaderMaterial announces itself once, through a channel the harness cannot see.** A failed
  program logs exactly one `console.error` at program build; `tab.errors()` does NOT capture
  `console.error`, so every A/B after the failure measures a world where the object simply is not
  there. When one object draws nothing, install a console hook on a fresh load before touching
  anything else.
- **A raw ShaderMaterial's colours are not encoded on the way out.** No `colorspace_fragment` (and the
  linter only admits the log-depth chunks), so a `THREE.Color(hex)` uniform — linear — reaches the
  canvas dark and over-saturated: the flame's soot band was near black. Hand such a shader the bytes it
  should show: `new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace)`, or plain `hex/255` triples.

### Textures, ramps and painted data

- **`alphaMap` is sampled from the GREEN channel**, not the alpha channel. Binding a texture whose
  information lives in alpha (the shipped `earth_clouds_1024.png` is one; a hand-generated white
  cloud sheet is another) reads a flat density and lays an opaque tablecloth over the planet. Anything
  whose density is alpha must be bound as `map`.
- **A canvas texture's placeholder must already be the size the paint will be.** `paintedTexture` used
  to allocate a 2×2 canvas and swap in the painted 2048×1024 one with `needsUpdate = true`. WebGL2 gives
  a canvas texture *immutable* storage at its first upload (`texStorage2D`, and r160 only allocates when
  `sourceProperties.__version === undefined`), so every later `texSubImage2D` of the big canvas is a
  silent GL error: the planet sampled one ocean-blue texel forever while `planetCanvas()` — the CPU
  canvas behind it — was perfect, the orbital map drawn from it was perfect, and `needsUpdate` "fixed"
  nothing. Copy into the existing surface (`drawImage`) instead of replacing `texture.image`.
- **Read a cel ramp in the scale three actually samples it.** `gradientmap_pars_fragment` computes
  `coord = dotNL · 0.5 + 0.5`, so an N-texel nearest ramp steps at **N·L = 2k/N − 1**, not at k/N. The
  old three-texel `[0.24, 0.62, 1.0]` stepped at ±1/3, and with the MET-0 sun 38.7° up a flat field sits
  at sin(38.7°) = 0.625 — already in the top band, so the ramp was never what made the field around the
  pad read as a fan of dark wedges. It was `padAuthored` thresholding a 2.2 km noise lattice, sampled by
  a mesh whose vertex spacing grows from 25 m under the vehicle to 3 km at its rim: a per-sample hard
  decision faster than the mesh aliases into straight-edged wedges. `RAMP_EARTH` is four texels with the
  top two equal (steps at −0.5, 0, +0.5 — every step out by the terminator), and a colour source for the
  ground must vary slower than the coarsest vertex on the cap. Check the sun table in
  `docs/reference/launch-site.md` against the boundaries before changing either.
- **A big transparent sheet may not have triangles that span several uv repeats.** Mip derivatives are
  computed per triangle, so a cell carrying a coarse tiling picks a different mip level per cell and
  the surface fills with straight-edged wedges of the tile's mip average. The weather shell is safe
  because its uv is rebuilt per fragment from the fragment's own position (12.5 km triangles against a
  160 km tile); anything new that tiles across a large mesh has to pass the same test.
- **Surfaces are painted from data, not from imagery.** `js/toonmap.js` reads the specular sheet as a
  land mask and the diffuse sheet as a biome signal; no photographic pixel reaches the screen. The
  biome rule keys on red−minus−blue, *not* hue — the shipped diffuse is blue-shifted over land, so the
  Amazon and the Atlantic have the same hue. Details and measurements:
  `docs/reference/painted-planets.md`.
- **The ground is drawn per fragment from data fields; the painted canvases are only the map's.**
  `js/surface.js` thresholds smooth fields with lattice noise on the threshold, the same function on
  the globe and the near patch. Rules it was built on, each measured: value noise has zero slope
  across every lattice plane, so anything SHADED BY SLOPE needs the gradient term (straight-edged
  facets over Italy from 400 km without it); a screen derivative of a per-vertex varying is constant
  per triangle (sawtooth relief over the Alps from 12 km), so the patch differences its coarse
  octaves in the vertex stage; a relief octave under ~25 px per cell shades as a stipple; and data
  textures are allocated at final size and filled in place, so nothing is late-bound.
- **Test a filter against brute force before trusting what was tuned on it.** `boxSignal` returned 11
  for a constant field of 1 at r 1; the biome classifier and the mare cut ran on it for rounds.
- **Compose tone by MAX, not by product, when many features claim the same vertex.** `moonPatchDetail`
  darkened each vertex by the floor factor of every crater whose rim or spokes reached it — across ~70
  craters the product compounded to black (mean linear 0.004; the surface looked scorched). Taking the
  strongest darkening, lightening and ray per vertex (`1 − 0.42·darkMax + litMax + rayMax`) restored
  mean 0.235. Multiplicative overlays only survive when a vertex meets two or three of them.

### Ground, shadows, precision and sky

- **The near patch and the globe are one surface and must be shaded as one.** The "giant flat square
  plate around the ship" at full zoom-out was the ±220 km ground patch, not weather, and it showed for
  two reasons, each found by toggling `drawRange` on that one mesh and diffing frames: it took scene
  fog while the globe takes none (90–100 % sky tone at a 400–600 km sight line), and it lacked the
  globe's `emissive: 0x07182c` (17/255 low in blue across its whole footprint). After `js/haze.js`
  on both and the same emissive, the frame difference fell from 23.6 % of pixels to 2.9 %. Any new
  material property on one of the two belongs on the other.
- **The near patch is the contact surface: no display lift under the vehicle.** The lunar patch used
  to stand 300 m (plus rim relief) above `moonGroundHeight`, so anything placed on that function was
  under the drawn ground looking at stars. The globe's fragments under the patch are discarded in
  the shader instead (`setHole`), and the patch is exactly `moonGroundHeight` / `fineGroundHeight`
  under the vehicle (0.07 m / 0.27 m worst over the 625 nearest vertices). A test camera must add the
  ground height to its altitude or it is underground.
- **Lunar dust collides with the height field, and the drawn Moon was not at the height field.**
  (Superseded by the entry above; kept because it is how the gap was found.) `js/terrain.js` drew the
  lunar near patch with a display-only lift (`+ 0.3` km in `rebuildMoon`), and `js/physics.js` landed
  on the bare sphere. Measured by raycast at a flat sunlit site: the drawn surface
  was 270 m above `moonGroundHeight()`. So in play the dust sheet (`js/exhaust-sim.js` collides with
  `RM + moonGroundHeight`) was under the drawn ground until the camera sank through the patch, at which
  point the ground was back-face culled and the ship hung in black. The lunar exhaust was tuned and
  photographed with the patch lowered by the measured gap in the harness. Shoot it from the orbit camera, not the chase one — the chase
  camera sits below the vehicle near the ground.
- **A non-finite value in a vertex colour attribute renders as a black band, and nothing else you do
  will remove it.** A NaN in `attributes.color` propagates through the toon lighting into a NaN fragment,
  so the pixel goes black and ignores material swaps, `castShadow`/`receiveShadow`, `normalScale`,
  visibility and background changes. This cost an hour of elimination before anyone counted NaNs:
  `attributes.color` on the near patch had **10,905 non-finite floats (3,635 vertices)** and the band
  rang the launch complex. Any bake that writes a vertex attribute must reject non-finite output and the
  harness must count non-finite channels and fail on a non-zero count.
- **Sanity-check a normal buffer's distribution, not just its length.** The same patch had
  `normal.y ∈ [0.103, 0.888]` — worst case 84° off vertical — on a coastal plain whose real relief is
  under 4° of slope, because a finite difference mixed units (the patch's positions are in metres while
  the scene is in km). A plain's normals should cluster near the local up vector; assert that.
- **A ground colour cannot hold a road; geometry can.** The pad stood on 360 m of terrain painted
  concrete-grey because the patch's vertices are 25 m apart at best. The site is now slabs in
  `js/pad.js` half a metre proud of terrain measured flat to ±0.22 u within 700 u, and the terrain
  under them is grass.
- **Two surfaces on one plane flicker, and a vehicle standing in a slab is two.** The pad deck was a
  solid box with a dark box inset, both tops at z 3.0, and the stack (skirt at z 1.4, bells to −1)
  stood sunk through them: crawling stripes at the foot of the rocket. `js/pad.js` now has a real
  opening with the bells hanging in it and the header lists the heights nothing may share.
- **The scene is drawn from the eye: floating origin (`js/origin.js`).** Coordinates are km from the
  Earth's centre and the GPU has 32-bit floats: at 6,371 km a float steps 0.49 m, and the pad moves
  409 m/s through the frame, so every world-space quantity a shader computed landed on a different
  half-metre each frame. Measured idle on the pad: 9,561 pixels changing frame to frame, 0 when
  paused. Each frame `setOrigin(scene, camera.position, spin)` moves the scene to minus the eye; positions
  stay absolute doubles in JavaScript and every uploaded matrix is eye-relative. That removed the
  half-metre steps and left ~125 pixels of 1.3 million still changing on an idle pad, because every
  matrix under the planet was rebuilt each frame from a rotation that had advanced; turning the whole
  scene back by the planet's spin (the Earth-fixed frame) gives a thing bolted to the ground the same
  matrix every frame. What follows:
  - The camera is a child of the scene. **Never call `camera.lookAt`** — on a parented camera it
    builds the wrong matrix; the look-at is built by hand in `js/camera.js`.
  - A `matrixWorld` read in JavaScript is eye-relative. Read the pad's only through
    `padMatrix()` in `js/world.js` (or put the planet back with `absolute()` from `origin.js`).
  - A new shader that needs a planet-centred position must add the `uOrigin` uniform back, or do
    its work in an Earth-fixed frame. `modelMatrix × position` alone is eye-relative now. The
    answer with `uOrigin` is as coarse as it ever was, so use it only for things kilometres across.
- **A texel-sized caster cannot be filtered by the die.** `BasicShadowMap` compares one depth sample,
  so a 2 m lightning tower inside a ±6 km box at 2048² (5.9 m/texel) rendered its shadow as a black
  staircase. `js/main.js` uses `PCFShadowMap` with a 4096² map (and the box is ±3 km on the ground now, 1.46 m/texel): p90 17.1 ms against 17.9 for
  `PCFSoftShadowMap` over 90 rAF deltas at the pad, and the softer kernel sanded off the edge the drawn
  look wants. Filtering the depth map cannot hurt the cloud shade, because that shade is not a shadow-map
  caster (js/clouds.js looks its own field up along the sun ray in the ground materials) — the old comment claiming Basic "gives the cloud shadows
  the soft filter blurs away" was never true, which is worth knowing before anyone reverts this to protect
  them. `logarithmicDepthBuffer` is unrelated: the compare uses `vShadowCoord` from the light's projection.
- **The shadow grid is pinned to the ground.** The box follows the vehicle, and following it
  continuously slid the texel grid under every shadow by a fraction of a texel per frame — the last
  ~125 unstable pixels on an idle pad. Snapping the vehicle's own planet-centred coordinates to a
  lattice made it ten times worse (the light's axes turn with the sun, and 6,371 km from the centre
  that sweeps the lattice over the ground at 460 m/s; two versions did this). What works is a centre
  that is a point in the Earth-fixed frame, moved by whole texels only when the vehicle is 8 texels
  from it, and a box size that changes in quarter-octave steps instead of every frame.
- **One part in eight of pale sky mixed in LINEAR space is a grey poster.** `lerp(black, 0xb2cfe2, 0.125)`
  is sRGB 30 %-grey: the old linear sky-mix clock left the 163 km sky measured flat (69,82,90) with the
  stars faded out — "the sky is grey and muddy" was this one line, not the dome, not the shell. The dome
  and background therefore fall on the QUARTIC of `exp(−alt/80)` (zenith optical depth dies far faster
  than horizon glow, which the shell draws from grazing rays on its own), the fog's density falls on the square of it, and star visibility thresholds on **sRGB lightness**, not the linear buffer. Measured: 68 km
  went (77,91,100) → (33,36,40) with the quartic.
- **The sky needs a sun.** Before the day/night gate the ground went dark at midnight under a
  noon-blue sky, and the limb shell's night floor — 0.14, right from space — painted the whole sky
  slate grey from the pad through a horizon-long path and hid the stars.

- **Cel light is three's own chunks, patched once in `js/toon.js`.** Every lit surface is a
  `MeshToonMaterial`, so the rules live in `ShaderChunk` (the patch throws if three's text moves):
  a cast shadow is four fixed bilinear taps CUT at one half (a crisp contour through the texel
  staircase, one screen pixel of smoothstep), and it caps the ramp at `CEL_FLOOR` instead of
  removing the sun — `min(ramp, shade)`, so it has the tone of the form shadow next to it and a
  face already turned from the sun is not darkened twice. Before, shadows were five noise-rotated
  PCF taps with only the blue fill left in them: soft navy smears.
- **Hardware is lit by where it is.** `hardware()` / `padware()` materials (the vehicle, the pad)
  carry `CEL_HARDWARE` uniforms that `js/world.js` fills each frame: whether the sun clears the
  limb of the Earth and the Moon at that place (the sun light has no planet in its shadow box, so a
  rocket on the night side used to stand day-bright), the fill and emissive floors that drop with
  it, and the pad's floodlights — one hard-stepped direction plus a two-ring pool on upward faces,
  no second light, nothing the planet's materials can see. `HARD_GAIN = π` is there because
  three's Lambert divides by π and no longer multiplies it back: the hull was sRGB 160, a grey
  rocket. The planets keep the exposure their shaders were tuned at.
- **The sun light moves in steps (`SUN_STEP`, 27 s).** A hard shadow edge and a hard cel band both
  follow the light, and the true sun creeps over the ground at 7.3e-5 rad/s: shadow-map texels on
  a silhouette flip one at a time and each takes a stretch of thresholded edge with it. Measured
  idle on the pad with the hard shadow term: 77-85 unstable pixels and 12-13 strong; with the
  shadow map frozen 29 and 8; with the light held in the Earth's frame between steps 2-23 and 0-5
  (the tree before this: 63-78 and 0-3). What is left is single MSAA samples on silhouettes — the
  view matrix still changes in its last bits every frame — and they count as "strong" more often
  now only because white hardware against black ink is a bigger step than grey was.
- **A thresholded shadow needs receivers a texel can describe.** Wherever a receiver stands exactly
  one shadow bias behind a caster the depth compare is decided by rounding noise; a soft filter
  averaged that away, a cut edge follows it, and one flipped texel moves ~50 px of edge at close
  range. The pad's red lattice (members thinner than the 1.46 m texel) and the small moving parts at
  the vehicle's foot therefore cast but do not receive: 'pad close' went from 62-103 unstable
  pixels to 0-19. The residual on any idle view is the camera: its orientation still turns ~4e-8
  rad a frame on the pad (measured from `matrixWorld`), enough to flip single MSAA samples.
- **A mesh inside an invisible group is still `visible`.** The stowed parachutes sat at the origin
  of their hidden cluster, all three canopies in one place, and `tools/flicker-test.mjs` (which
  reads `o.visible`, not the ancestors') reported 23 coplanar pairs. Pose hidden things too.

### Exhaust

- **A factor written on one component of three is a bug wearing a tuning knob.** `groundHit` bled the
  tangential velocity of deflectate with `keep = 0.12` on `rx` while `ry`/`rz` kept `(1 + out·k)`, so two
  thirds of the deflected flow left the trench at near exhaust speed and every attempt to tune the blast
  cloud's spread "did nothing". When a parameter appears to have no effect, read the arithmetic that
  consumes it before changing its value.
- **A frame's particles did not all leave at the same instant.** Charging `emitAcc` and spawning the whole
  budget at the current vehicle position put a fresh clump every 16 ms while the vehicle moved 1.9 m on,
  and the ascent trail came out as a ringed fir tree spaced by the frame rate. `spawnPlume` now
  back-projects parcel *c* along the velocity by the slice of `simDt` it represents and starts its age,
  remaining life and heat there.
- **Exhaust parcels are only a plume where air holds them together.** Above ~40 km nothing does and
  a 1600-slot pool draws them as dots a hundred metres apart. The smoke trail thins out between 28 and
  50 km and nothing is emitted Earth-side above 52; the drawn flame, opened wide by the same thin air, is
  the exhaust up there. And over Earth a NOZZLE parcel only matters while it can reach the ground —
  sea-level air stops the jet in tens of metres — so they are not born more than ~450 m up; the ascent
  is the flame plus trail puffs born at rest in the air's frame. Lunar parcels are exempt from all of it.
- **Pad exhaust is a shape problem before it is a physics problem.** Parcels leave the F-1s at
  ~2.9 km/s, and if the tangential component of the trench hit survives whole, the deflectate paints a
  200 m field of discrete domes around the pad. The trench hit bleeds the tangential to 0.12 on Earth,
  and a share of the deflected parcels (`BILLOW` in `js/exhaust-sim.js`) become long-lived buoyant
  billows — without them the pad cloud was only ever the last second of exhaust.
- **Smoke is drawn opaque, with depth, and that is the whole look.** `js/exhaust-draw.js` draws each
  parcel as a clump of four analytic spheres in three flat sun-shaded tones, with `NoBlending`,
  `depthWrite` and a `gl_FragDepth` that bulges by the clump's own height. Neighbours then cut into one
  another along real intersection arcs — a cauliflower with a scalloped edge — and draw order stops
  mattering, so nothing is sorted. The same parcels as soft alpha sprites were beige fog. A puff ends
  by shrinking; anything translucent (sparks, the staging flash, vacuum gas) is a second, additive
  draw call. Hard tone edges at half resolution show a stair-step at deviceScaleFactor 1.
- **The flame is a mesh drawn twice.** `js/flame.js` paints it at full resolution in the main pass
  under the half-resolution layer (renderOrder 1 < the composite's 2), and draws the same vertices
  again into the FX target as an eraser (`ZeroFactor / OneMinusSrcAlphaFactor`, depth-tested against
  the puffs' own depth). Smoke behind the flame is cut away, smoke in front of it stays. The first
  attempt blended the punch `One / OneMinusSrcAlpha` with black: that RAISES the target's alpha, and
  the flame rendered as a black shape with an orange rim.
- **Smoke casts shadows through its own caster.** The puffs live on the effects layer and cast
  nothing; `js/exhaust-draw.js` keeps a layer-0 `Points` with a `customDepthMaterial` that draws
  each puff as a disc into the sun's map (three 0.187 reads the shadow map's depth attachment).
- **Entrainment is air; a growth constant without a density in it is confetti.** The staging burst grew
  its smoke parcels at a flat 14 m/s and bloomed 26 puffs into kilometre-soft bokeh discs against black
  space at 67 km — the reviewer's worst frame. Smoke-parcel growth now multiplies `airDensity(alt)`,
  and the debris trail is gated at ρ > 0.004: the high event is a flash and tumbling metal, the pad
  event keeps its billow, and nothing in vacuum grows at all.
- **Soft, fill-bound layers go in the half-resolution pass, and how each is hidden decides how it
  comes back.** `js/halfres.js` draws the weather (a ray march when this was measured) and the exhaust points into
  quarter-pixel targets. Same views before and after: 13.4 → 5.9 ms idle, 31.6 → 6.4 ms at full throttle on the pad.
  The weather is drawn with no depth at all and put on screen by the shell's own geometry in the
  main pass (a lookup by screen position), so hardware cuts it at full resolution; testing it against
  a low-resolution depth prepass left a one-texel fringe of cloud on every silhouette. The exhaust
  keeps the prepass (smoke is in front of the ship as often as behind) and is skipped when no parcel
  is alive. Remember: a shader in these passes sees pixels twice the size (footprints and point sizes
  scale by `RES_SCALE`); a new opaque mesh must go through `occlude()` or smoke draws over it;
  ordered dither survives the exhaust's tent as a weave, white noise does not (the weather no longer
  dithers or uses the tent: it writes ramps and the main pass cuts them); and the shell's mesh density
  buys nothing — 512 × 256 cost ~1 ms over 192 × 96 for the same picture.

- **A column is continuous when a puff is wider than the gap to the next one, and for no other
  reason.** The trail is laid at 60 puffs a second at most, so past 150 m/s the gap grows with the
  speed and a fixed 3 m puff becomes beads: measured at 27 km and 714 m/s, puffs drawn 10 m across
  stood a median 13 m apart. A trail puff is now born with a radius of at least a sixtieth of the
  airspeed and half the width of the fire it leaves (drawn 37 m across there, median gap 11 m), and
  the thin air shortens the column through the puffs' LIFE, not their size. A puff smaller than
  2.4 px of the half-resolution pass is drawn at up to that until it is a third of a pixel, or the
  far column breaks into the dots that survive the cut.
  by shrinking. Hard tone edges at half resolution show a stair-step at deviceScaleFactor 1.
- **Nothing in the exhaust is additive any more.** Sparks, burning fragments and the staging flash
  were additive discs with a bright heart and two rings; twenty-six of them at a seam were a soft
  ball of light bigger than the vehicle. They are opaque shapes now, in the main pass at full
  resolution over the smoke layer (`shards`, renderOrder 6): a spark is a thin rhombus, the flash a
  spiked star shown as three flat drawings, one after another. Two things bit while making them: the
  integrator clamps EVERY generic parcel's radius to `R_CAP` (16 m), so a flash asked for at 34 m was
  silently 16 until growth-free kinds were exempted; and a point sprite stood on the vehicle's axis is
  inside the hull, so only the tips of its points showed round the stack until the star was drawn
  nearer the eye by its own radius.
- **The fire lights the smoke in the puff shader, with no light in the scene.** `setFireLight`
  hands the puffs the flame's position, colour and strength; a puff takes the fire's colour on the
  side facing it, in two flat steps, at a strength that falls in three steps with distance (260 m at
  night; 140 m and 0.38 as strong by day). Night smoke also takes a lighter top and a darker
  underside from the sky, or it is one flat lavender.
- **Lunar dust is flat, grey and ballistic.** No air, so no billow: a dust parcel is drawn as a lens
  lying in the ground plane, long axis on the line from the point under the engine, and the sheet
  the engine drives out along the ground is a mesh of its own (`js/dust-sheet.js`: a polar grid stood
  on `moonGroundHeight`, rays cut per fragment). Both are a step lighter than the brightest painted
  regolith class, because out there the tone is all that separates dust from ground. Free gas is not
  drawn at all in vacuum; the flame mesh is the fire.
- **When the mission clock stops, the exhaust must stop riding the planet.** `js/main.js` freezes
  the clock on an end card, so the bodies stand still, but parcel velocities are inertial: the air
  over the pad does 409 m/s and the Moon's ground 1 km/s. Everything alive at the end slid away over
  the frozen ground — measured after a crash by the pad, the wreck's sparks a median 741 m off at the
  first look and 1,567 m 1.5 s later; that, and the next rule, were the "yellow smear on the horizon"
  of a splashdown. `stepExhaust(dt, frame)` now advances positions relative to the frame the picture
  is frozen in (the ground under the vehicle, or the vehicle's last velocity if it came apart in
  flight): 47 m and 75 m in the same test.
- **`js/physics.js` explodes first and asks afterwards.** `impact()` calls `explode()` on every
  Earth contact before the splashdown branch, so a good splashdown threw 240 burning sparks, and it
  gives every explosion's sparks 0.3 of the vehicle's INERTIAL velocity — on the ground that is 0.3
  of the planet's spin, so they left a crater at 286 m/s, always the same way, and in flight they
  were kilometres behind before a frame was drawn. `js/vehicle.js` decides the drawn event a frame
  later: none at a safe splashdown (the sparks are taken back), otherwise flashes, smoke and the
  same sparks re-based on the ground or on the vehicle.
- **Anything physics spawns is spawned at the true state; the picture is up to a step behind it.**
  The drawn vehicle is the last two 0.1 s steps blended, so a burst left where physics put it stands
  ahead of the vehicle it came from (18 m at staging in the runs measured; the bound is a step of
  flight, 120 m there). The `spawnParticle` that `js/main.js` hands to physics remembers what it
  spawned, and on the next frame those parcels — and a dropped stage — are moved by the difference
  between the vehicle as drawn and as it was.
- **Entry heating is a closed body drawn inside out.** `js/entry-fx.js` is one mesh of revolution
  about the air-relative velocity (bow-shock cap, sheath, streak), back faces only, depth-tested: a
  closed surface has exactly one back face behind each pixel of its outline, so the shape fills once
  with no sorting, and the vehicle — nearer than the far wall — covers its middle and stays readable.
  It runs on `getHeat()` (nothing under 0.5; the shipped ascent peaks at 0.09) and turns crimson and
  spiked with `getCooking()`.
- **`half` is a reserved word in GLSL ES 3.** `float half = …` passes `tools/shader-lint.mjs` and
  fails in the browser with "Illegal use of reserved word"; the object simply is not drawn.
- **Open, measured, not fixed (not the exhaust's):** pausing within a few seconds of automatic
  staging can leave 32,000-170,000 pixels changing between consecutive screenshots of the paused
  frame (seven runs). The same script gives 79,000-103,000 on the commit before this work (three
  runs), with different effects on screen, so it is upstream of them; the particle pool is still (the flash parcel stays
  alive). Run to run it is intermittent — other runs of the same pause read 0.
- **A cluster's fire is one shape, and it opens on a different clock from the one it thins on.**
  Five jets a bell wide and half a stage long were "three short tongues". Each clustered stage now
  carries an envelope tube under its jets — the merged fire — whose outline swells with `vac²`
  (0.34 at 15 km, 0.63 at 27, 0.89 at staging) to several hull diameters, while the paint goes from
  opaque to flat veils on `vac³`, so the flame is still solid colour at 15 km. The jets keep the
  shock diamonds and the soot collar. The additive halo sprite is gone: it was the one soft thing
  left in the picture.

### Camera, map and trajectory ribbon

- **Camera collision is applied twice per frame, three rounds each** — to `desired` and again to the
  interpolated `camPos`; the rounds are there because the planet's push-out is radial and one pass
  lifted a camera squeezed between pad and stack out of the ground straight into the hull
  (`tools/clip-test.mjs` found it 3 m inside the S-1), with a sideways escape if it is still inside. A lerp between two points outside a sphere is a chord, and chords are inside, so before
  this the camera cut 6 019 km through the Earth whenever `reset()`, `teleport()` or `ff()` moved the
  vehicle to the far side. Measured after the fix: the closest the camera gets to the centre during a
  full crossing is `RE + 0.02`, exactly the skin.
- **The pad's collider must let the camera onto the apron.** One 640 × 210 m dome kept the view out
  of the towers by keeping it out of the launch site, and the only angle from which a Saturn V looks
  110 m tall — low, close, looking up — could not be reached. Two ellipsoids and a box (deck, tank
  farm, umbilical tower) in the pad's own frame now, via `padMatrix()`, which also follows the planet's spin.
- **Start a damped quantity at its target.** The camera's up vector, heading and lens eased in from
  module defaults, so each mission opened with the horizon rolling level; and "ease back behind the
  nose" ran on the pad, where the nose's heading is a fallback axis. Measured after: 0.000° of camera
  rotation across the first 4 s.
- **The camera has no "home" and nothing moves it but the user.** The altitude-keyed home and the
  timed ease back to it are gone: they took the view out of the user's hand two seconds after every
  drag. Orbit (the default) carries its heading along with the ship — parallel-transported, never
  read from the nose or the velocity — so pitching the rocket pitches the rocket, not the world.
  Chase sits behind the *flight path*, not the nose (those differ by 180° in a braking burn).
  Double-click re-centres. `js/camera.js`'s header is the truth; do not reintroduce a timer.
- **Damp the camera's offset, never its position.** A lerp of the absolute position toward a moving
  target trails it by speed × time-constant: in a 300 km orbit at ×1 with 0.12 km asked for, the camera
  sat 0.572 km back with the ship 32 % up the frame, and under warp it was simply left behind. The
  camera now keeps a damped offset from its target, which is the middle of the hardware still attached
  (`S.pos` is the middle of the FULL stack — after two stagings the command module is 38 m ahead of
  it); the focus glides at staging. Measured after: ship at NDC (0, 0), distance 0.118 km, re-centred
  to within 1 % of the frame 1.4 s after a stage leaves.
- **Near the ground the camera's heading belongs to the ground.** Carried purely in inertial space
  it drifted against the pad at the Earth's rate — 15 degrees an hour, a thousandth of a pixel a
  frame, which is enough to flip the coverage of every sub-pixel edge (the last unstable pixels of
  `tools/flicker-test.mjs`: 127 strong pixels before, 2 after), and under ×10000 on the pad it swung
  the view round the rocket.
- **The map is the scene, not a drawing of it.** M switches to a map camera pivoting on Earth, the
  Moon or the ship (F), with the pole of the Moon's orbit as up (north-up showed the transfer plane
  edge-on); `js/mapview.js` adds only what is too small to see from 100 000 km, plus the engine-off
  coast path and the Moon's position at closest approach. The map hides the weather, takes its sky
  from where the *eye* is (space) rather than where the ship is, and opens on the ship's side of the
  planet. The 2-D canvas map and the `'system'` camera mode no longer exist, and the arrow
  keys and − / = belong to the camera — W A S D Q E fly the ship.
- **Integrate the trajectory on one clock, draw it on another.** `js/predictor.js` re-integrates the
  path five times a second (0.72 ms each, measured) and stores it as data — body-relative positions
  with their mission times. `updatePredictor` draws it every frame from where the ship is: flown
  points dropped, a gap of 9 % of the camera distance, a five-vertex fade-in. Drawing the
  integration's own points until the next tick put the ribbon's start 2.7 km behind an orbiting ship
  and through its hull; measured after, the first vertex sits 0.120 km ahead on twelve consecutive
  frames. Three more rules live there: a closed orbit stops after one lap and fades out before it
  meets its start; lunar paths are stored Moon-relative (inertial, an orbit round a body moving
  1 km/s is a coil); and the ribbon's vertices are offsets from a group sitting on the ship, because
  absolute Float32 at lunar distance is a 31 m grid.

### Measuring

- **Frame time is not GPU time; the display hides the difference.** Ninety `requestAnimationFrame`
  deltas read 16.7 ms whether the GPU worked for 4 ms or 14, and then jump to 33. Every "frame cost"
  quoted before this note was vsync. Measure with `EXT_disjoint_timer_query_webgl2` around the rAF
  callback (wrap `requestAnimationFrame` from an init script; `gl.getParameter(query, QUERY_RESULT)`
  a few frames later) and at a retina-sized drawing buffer — `tab.emulate({ viewport: { …,
  deviceScaleFactor: 2 } })`. That is how the weather shell (6.7 ms of 13.4 idle) and the exhaust
  sprites (16 ms of 31.6 at full throttle) were found.
- **Whole-frame pixel sandwiches lie here.** Temporal drift — clouds, water glint, living parcels —
  measures 0.016–0.06 RMSE between two idle seconds, larger than some real state diffs. Trust
  spatial compare-masks and the eyes, not frame-mean error.
- **Do not save a file while a browser measurement is running.** The dev server hot-reloads every
  open page, so the run silently continues on a fresh pad: a perf table came back with its rows
  shifted by one station and zero live parcels at full throttle.
