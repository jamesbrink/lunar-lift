<p align="center"><img src="assets/logo.svg" alt="Lunar Lift" width="420"></p>

# LUNAR LIFT

Fly a three-stage rocket — S-1 SATURN I (solid), S-2 SATURN II and the CSM ENGINE (both
throttleable) — off LC-39 at Cape Canaveral on a rotating, real-radius Earth (6 371 km) and out to a
real Moon 384 400 km away: orbit, trans-lunar injection, lunar orbit insertion, and a soft powered
landing under the 32 m/s `LAND_SAFE` limit or you lose the spacecraft. Or bring the command module
home instead — heat shield first, drogues, mains, and a splashdown under 12 m/s. The orbital physics is
hand-written in `js/physics.js` — no orbital-mechanics library; the only runtime dependency is
Three.js 0.187.0, loaded from a CDN through the importmap in `index.html`, so an internet connection
is required.

## Run

```
node server.js 8078      # any port; 8078 is the default
```

then open <http://localhost:8078/index.html>. Node 18+ only, no install step. The dev server
(`server.js`) serves every file with `Cache-Control: no-store` — ES modules never go stale — and
watches `js/`, `css/` and `index.html`, pushing a `reload` event down an SSE endpoint (`/__reload`)
that a client injected into the HTML turns into `location.reload()`. Every edit hot-reloads.

## Controls

Read from the `keydown` handler in `js/main.js` and the hold-key reads in `js/physics.js` and
`js/camera.js`:

| Key | Action |
| --- | --- |
| SPACE | Ignite / shut down. S-1 is a solid: once lit it runs at 100 % to burnout and neither SPACE nor CTRL touches it. On S-2/CSM, SPACE cuts the engine and zeroes the throttle; raising the throttle relights it (KSP-style) |
| SHIFT (hold) | Throttle up |
| CTRL or Z (hold) | Throttle down. Z is there because CTRL+W / S / D belong to the browser on Windows and Linux |
| W / S | Pitch |
| A / D | Yaw |
| Q / E | Roll |
| X | Separate the stage. A stage still holding more than 5 % of its propellant wants X twice within two seconds. Pressed on the CSM it leaves the command module flying alone |
| P | SAS autopilot on / off (holds the pitch program off the pad, then the velocity vector) |
| V | Flip SAS between prograde and retrograde |
| H | Attitude hold on / off: stops every rotation and keeps the nose where it is; steering by hand moves the held attitude with you. Switching SAS on cancels it, and it switches SAS off |
| T | RCS stability assist on / off (on by default; off, nothing damps a rotation in vacuum) |
| G | Parachutes, command module only: first press drogues, second press mains |
| ] / [ | Time warp up / down the ladder, which runs down through slow motion to a pause |
| ESC | Pause / resume (or close the help card if it is open). The camera, the map and the HUD stay live while paused |
| ? | Help card |
| C | Camera mode: orbit (the default) ↔ chase |
| M | Map: the same 3-D scene from far off, with the ship, both bodies, the Moon's orbit and sphere of influence, the coast path and the Moon's position at closest approach marked |
| F | Map focus: Earth → Moon → ship |
| ↑ ↓ ← → | Turn the camera (W A S D Q E steer the ship) |
| − / = | Zoom out / in |
| R | Reset the mission (R, ENTER or SPACE on the end overlay) |
| Mouse drag | Turn the camera |
| Double-click | Re-centre the view behind the ship |
| Mouse wheel | Zoom |

Warp ladder (`WARPS` in `js/constants.js`): paused, ×0.25, ×1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
1000, 10000 and 100000 (the top two for the pad and for open space). The convention that makes coasting honest: **in flight the step is
always `DTPHYS = 0.1 s`.** `js/main.js` banks `frame time × warp` and spends it in whole 0.1 s steps
(up to 20,000 a frame: a coasting step costs 0.41 µs in the browser), so warp changes how many steps a frame takes and never their size — the
trajectory is the same at ×0.25, ×1 and ×1000 and on a 60 Hz or a 144 Hz display, and it is the one
`tools/mission-sim.mjs` certifies. A frame too slow for its warp falls behind the warp rather than
take a coarser step. Ten steps a second would stutter, so what is drawn is the state blended
between the last two steps, with the mission clock set to the drawn instant; paused, nothing steps
and the camera, the map and the HUD stay live. (Before commit 55f18fa the game stepped at the frame
time below ×6 — 1/60 s at ×1 — while this paragraph claimed otherwise; a review flew the certified
window that way and hit the Moon at 2,559 m/s instead of passing it at 346 km.)

Warp is capped by place — ×4 in the air (below 70 km; ×16 under open mains) or within 15 km of the
Moon, ×32 within 50 km of it, ×128 within 400 km, ×16 below 140 km of the Earth, ×8 while the
engine burns, ×1000 below 2,000 km of the Earth, ×10000 within 30,000 km of the Earth or 5,000 km
of the Moon, ×100000 beyond — and drops to ×1 on crossing the Moon's sphere of influence. A fast
coast eases itself down as it arrives: each frame spends at most a quarter of the estimated time to
the next place that lowers the cap (`warpHorizon()`), so the certified coast reaches the Moon's
sphere of influence in about 5 s at ×100000 without stepping past it. The one exception to the fixed step is standing on the pad with the engines
cold and the throttle shut: there a step is an exact rotation with the planet at any size, so time
is free up to ×10000 (a day in 8.6 s). The sun's bearing is fixed in inertial space and the planet
turns under it, so that is how you wait for the launch window, or watch night fall: the sky, the
fog and the ground go dark through a short twilight, the stars come out and the pad's floodlights
come on.

The launch complex is solid. The swing arms start to retract at ignition and take 1.5 s; for the
first 0.9 s they are still across the stack, and touching them, the tower, the crane, a mast or a
tank ends the flight (`COLLISION`). Measured headless: SAS from ignition clears everything (the
stack is 1.6 m up when the arms stop being solid); yaw held from ignition with SAS off hits a swing
arm 0.8 s later; a stack pitched over at ignition falls back and hits the ground at 142 m/s — it
used to tunnel into the Earth. The SAS pitch program is timed from the moment the hold-down lets
go, so waiting on the pad for the launch window does not change the ascent: waits of 0, 120, 300
and 3,600 s reach the same S-2 burnout state to within 3 m/s (6.416 km/s, apogee 584 km, max-Q
25.4 kPa; the hour-long wait lands on 6.4135 — the per-figure note in
`docs/reference/mission-design.md`).

Flight controls are inertial: the keys apply torque against the vehicle's live moment of inertia, so
the fueled stack turns slowly and gets livelier as propellant burns off (`game.state().authority`
is the ratio), and the burning engine gimbal swings the plume opposite each turn. Nothing else turns the vehicle for
free:

- **In air** the airframe flies. `js/aero.js` gives a body at an angle of attack a normal force
  (slender-body lift, cross-flow drag, the S-1's fins) as well as Mach-dependent axial drag, and
  `js/physics.js` takes that force's moment about the live centre of mass — so the nose weathervanes
  into the airflow while the centre of pressure is behind the centre of mass (measured static margin
  +4.4 m on the pad, growing as the S-1 drains) and the rate is damped in proportion to dynamic
  pressure. After the S-1 and its fins are gone the measured margin is negative (−7.2 m at
  staging), by which point the air is nearly gone too.
- **Side load breaks the vehicle.** The stack is rated for 0.5 g of lateral aerodynamic load (6 g
  for the bare CSM). Over that it accumulates strain — faster the further over — and lets go when
  the strain reaches its limit, or at once at three times the rating: `AERODYNAMIC BREAKUP`,
  mission lost. The SAS ascent peaks at 0.024 g (measured, T+85 s, Mach 2, 5° off the airflow).
  Measured the other way, SAS off and full pitch from T+60 s, through max-Q: let go after 5 s
  (41° off the airflow, 0.55 g) and SAS brings it back; after 6 s (50°, 0.68 g) it survives with
  77 % of its strain used; keep holding and it breaks up at 6.9 s. Above ~30 km (pitch held from
  T+100 s) the air is too thin to hurt it.
- **In vacuum** the only rate damping is the RCS stability assist (`T`, on by default). Switch it
  off and the vehicle keeps whatever spin it was given until you cancel it.

## Units and scale

Repo-wide convention (see `docs/reference/README.md`): **km, s, tonnes, kN**.

- `thrust / mass` with kN over tonnes is exactly **m/s²**; `GM / r²` with `GM` in km³/s² and `r` in
  km gives **km/s²**.
- State vectors are km/s internally; the HUD reads m/s.
- `simTime` is real mission seconds — no time-scaling fudge anywhere. The measured mission clocks
  3.469 days, as a real one does.
- Visuals ride at real planetary scale; the vehicle mesh is scaled by `VS` (≈105 m, Saturn-V sized).

## Architecture

One concern per file.

### Flight

- `js/physics.js` — the integrator and the reference-frame helpers. Inverse-square
  gravity from Earth and Moon plus the indirect term an Earth-centred frame owes (the Earth falls
  toward the Moon too), the aerodynamic force and its torque from `js/aero.js`, mass burn, staging,
  attitude dynamics, SAS, attitude hold, the RCS stability assist, side-load strain and breakup, the
  command module's heat-shield rule, parachutes and crew g limit, collision with the launch complex
  (`js/colliders.js`), and `impact()`. Contact is the
  lowest attached point (`surfaceAlt()`: the engine bell of whatever stage is still bolted on — for
  the last stage, the footpads of its landing gear, 0.84 m under the bell — or the nose if it is
  upside down) meeting the terrain, and a slow touchdown more than 60° from
  vertical is `TIPPED OVER`, a loss. A flight with no propellant left and no way down ends too:
  `STRANDED IN ORBIT` for a closed orbit that stays clear of the air or of the lunar ground,
  `LOST IN SPACE` for an escape past the Moon. Its frame rule matters: `navVel()` is
  Moon-relative inside the lunar SOI and inertial outside (it drives SAS and the navball),
  `groundVel()` is velocity relative to the surface of whichever body is underneath (it drives
  `impact()` and the HUD speed readout), and `bodyUp()` is the attitude to hold when the velocity
  vector has no direction worth steering by. The Moon moves at ~1 023 m/s through the game frame, so
  anything judged against a surface must not use the raw state vector `S.v`. Also owns `LES_ALT`
  (90 km) and the launch-escape-tower jettison, which is visual only and sheds no mass.
- `js/stations.js` — the vehicle's axial stations and radii and `GEOM`, the one table of segment
  lengths, radii and stations that both the moment of inertia and the aerodynamic shape are built
  from. Written once here and read by physics, the pad collider, the camera, the parachutes and
  the exhaust; where two consumers use different numbers for nearly the same thing (the CSM is
  2.2 u for mass and aerodynamics, 2.36 u for the pad collider) each keeps its own name.
- `js/aero.js` — the atmospheric flight model, display-free: exponential density, the air's own velocity
  (`airVel`), speed of sound, the transonic drag rise, and `aeroForce()` — axial drag plus the angle-of-attack normal
  force. One evaluation per step feeds both the trajectory and the torque. What it models and what
  it deliberately does not: `docs/reference/atmosphere.md`.
- `js/colliders.js` — what the vehicle can run into at the launch complex: the one table of pad
  solids (tower, crane, service masts, lightning masts, tank farm, water tower) and the swing arms,
  which `js/pad.js` also draws from, so what is drawn and what is solid cannot drift apart.
  Display-free; the headless tool flies through it.
- `js/constants.js` — every physical constant: `RE`/`MU_E`, `RM`/`MU_M`/`SOI_M`,
  `MOON_DIST`, Earth spin, LC-39 position, the exponential-atmosphere parameters, `SPECS` (stage
  dry/fuel/thrust/Isp), `LAND_SAFE` (0.032 km/s), `SAFE_EARTH` (0.012 km/s), `WARPS`, `DTPHYS`, the
  SAS pitch program `TURN`, `TLI_LEAD` (how far the Moon leads the ship when the certified flight
  lights its injection burn — 2.7742 rad, the cue the `NEXT` line counts down to),
  and `MOON_PHASE0` — the solved launch window (the Moon's angle along its orbit at MET 0 for which
  a TLI at the first perigee after insertion arrives at the Moon).
- `js/targeting.js` — the predicted lunar aim: `lunarPass()` integrates the present state forward to
  its closest lunar approach, four times a second, engine lit or not (while burning, the figure is
  the pass you would get by cutting now). It is a velocity-Verlet integration started from the
  velocity advanced half a game step, which is what makes it land on the game's own trajectory
  rather than the textbook one; its header has the measurements. It also publishes `aim.trim` — the
  prograde or retrograde m/s that would centre the pass in the corridor — and `cutoffNow()`, which
  lets SAS end an injection burn when the pass is inside the corridor with 60 km in hand.
- `js/predictor.js` — where the vehicle is going. Integrates the path five times a second,
  draws it every frame from the ship's current position: it starts a short gap ahead of the ship, fades
  in, dims with time ahead, and stops after one lap of a closed orbit. Places the `Ap`/`Pe` markers
  on the path and raises the impact warning.

### Vehicle and exhaust

- `js/saturn.js` — the Saturn V as drawn hardware: three stage groups in the real paint scheme,
  engine fairings and fins, contoured bells, the launch escape system, and the command module as its
  own group so it can fly on alone.
- `js/chutes.js` — the command module's parachutes as drawn hardware: two drogues, then three
  orange-and-white mains, inflated by the state `js/physics.js` publishes.
- `js/vehicle.js` — the conductor: the hardware's pose each frame, staging and the debris it
  leaves (dropped stages stop at the ground), and the one call that turns a burning stage into fire
  and smoke.
- `js/flame.js` — the drawn flames: one shader-shaped mesh per stage with hard tone bands, nearly
  opaque at sea level and a translucent veil in vacuum.
- `js/exhaust-pool.js` — the fixed pool of gas parcels and the `spawnParticle` contract.
- `js/exhaust-emit.js` — where parcels are born: nozzles, the smoke trail, ignition steam, lunar dust.
- `js/exhaust-sim.js` — how they move: drag from the same `airDensity` the vehicle flies in, the
  flame trench, the hull.
- `js/exhaust-draw.js` — how they are drawn: opaque three-tone puffs that write their own depth
  and take the fire's colour on the side that faces it, flat grey lenses for lunar dust, hard-edged
  shards for sparks and flashes, and a shadow-casting pass so the smoke column shades the ground.
- `js/entry-fx.js` — atmospheric entry, drawn from the flight model's own heat proxy: a bow-shock
  cap, a sheath of fire and a trailing streak; crimson and shedding fragments when burning up.
- `js/splash-fx.js` — the splash at a water landing: a crown, droplets, two rings and foam.
- `js/dust-sheet.js` — the flat sheet of dust a lunar burn drives out along the ground.

### Worlds

- `js/world.js` — Earth, Moon, sky, starfield, the sun and its shadow camera, the launch pad welded
  to the rotating planet; mounts the weather and the ground shaders. Exposes the terrain queries
  `groundHeight`, `moonGroundHeight` and `fineGroundHeight` (km above the reference sphere) and
  `padMatrix()`.
- `js/terrain.js` — the near level: one streamed mesh per body that re-centres on the vehicle,
  metres of spacing under the craft and a rim at ±220 km. Shape only; colour is drawn per fragment.
- `js/surface.js`, `js/surface-earth.js`, `js/surface-moon.js` — the ground, drawn per
  fragment from smooth data fields thresholded into flat tones with sharp edges at every zoom; the
  same function on the globe and the near patch.
- `js/earthpaint.js`, `js/moonpaint.js`, `js/paintkit.js` — the paint jobs that turn the
  shipped satellite sheets into those fields (land mask, biomes, relief, coast distance, 560 lunar
  craters), and their deterministic tool kit. No photographic pixel reaches the screen.
- `js/toonmap.js` — the registry that hands the paint products out. `js/textures.js` — asset
  loading and the shared sheets. `js/palette.js` — the two palettes the painters and ground
  shaders share.
- `js/padsite.js` — the authored launch site: relief held at exactly zero round the pad, and the
  Merritt Island shore.
- `js/pad.js` — Launch Complex 39 as drawn: mobile launcher with a real flame opening, the red
  umbilical tower, swing arms that retract at ignition, crane, propellant farm, floodlights,
  hardstand, flame trench, crawlerway, water tower.
- `js/clouds.js`, `js/cloudfields.js` — the weather: one shell from 4 to 11 km round the planet,
  drawn as opaque cel-shaded shapes where one scalar field exceeds one threshold; the second file
  is the field's data. Details: `docs/reference/painted-planets.md`.
- `js/haze.js` — aerial perspective for the ground: one law in true distance on both the near
  patch and the globe, so they agree at the patch's rim.

### Rendering and interface

- `js/main.js` — renderer bootstrap, keyboard input, the frame loop (the 0.1 s accumulator, the
  interpolated picture, pause) and the `window.game` debug handle. Also the failure cards — no
  WebGL 2 is `CANNOT START`, an exception in the loop is `SOMETHING BROKE`, and `index.html` says so
  if the game has not started in ten seconds (three.js comes from a CDN) — and the one quality
  knob: the drawing buffer starts at `min(devicePixelRatio, 2)` and drops a quarter-step of pixel
  ratio, down to 1, when frames run longer than 24 ms for three seconds. It does not climb back;
  `?scale=<n>` in the URL pins it.
- `js/origin.js` — the render frame. Each frame the scene is shifted by minus the camera's
  position, so every matrix the GPU sees is eye-relative (32-bit floats step 0.49 m at the Earth's
  radius, and every shadow edge on the pad crawled), and turned back by the planet's spin, so a
  thing bolted to the ground gets the same matrix every frame. `js/world.js` pins the shadow map's
  texel grid to the ground the same way: the box's centre moves by whole texels, its size in
  quarter-octave steps.
- `js/camera.js` — orbit and chase cameras and the map camera; drag, wheel, arrow-key and
  − / = input. Orbit is the default: the camera circles the ship on a heading carried along with it,
  never taken from the nose or the velocity, so the view moves only when you move it and nothing
  eases it "home" on a timer (double-click re-centres). Chase sits behind the flight path — heading
  from the horizontal velocity, elevation from the climb angle. Near the ground the carried
  heading turns with the planet (fully below 20 km, fading out by 120 km), so the view stands
  still against the pad however long you wait. The map (M) pivots on Earth, the Moon or the ship
  (F), looking down on the Moon's orbital plane. The frame shakes with thrust and dynamic pressure. Follows the middle of
  the hardware still attached and damps its *offset* from it, so the ship stays centred at any speed
  or warp and re-frames smoothly at staging. Collides with the vehicle, the pad, the Earth and the
  Moon — twice per frame because a chord between two legal points can pass through a body, and in
  three rounds each time because one push-out can land inside another solid
  (`tools/clip-test.mjs` sweeps it).
- `js/mapview.js` — what the map adds to the scene: a marker for the ship, a name on each
  body, the Moon's orbit and its sphere of influence, the whole coast path, and where the Moon will
  be at closest approach. The map itself
  is the real scene seen from the map camera.
- `js/hud.js` — telemetry, stage fuel pips, throttle gauge, logs, the `NEXT` line (what
  to do now and the key that does it, derived from the live state — including the braking deadline
  on the way down to the Moon and the parachute calls on the way home), the end overlay and the
  landing debrief with its stars and score.
- `js/navball.js` — the KSP-style attitude ball: an orthographic view of the sky from
  the nose, prograde/retrograde markers, apsis markers, the Moon as a target. North is the +Y spin
  axis. Also the small orbit plot in the orbit panel.
- `js/ribbon.js` — a polyline as a screen-space ribbon (a 2 px feathered core under a 9 px
  additive halo, per-point colour and opacity) rather than a thin `Line`, so it stays legible against
  both the planet and black space.
- `js/toon.js` — the cel shading itself: `toon()` materials on a quantising ramp (`RAMP_EARTH` is
  four texels with the top two equal, so its steps sit at N·L = −0.5, 0, +0.5 — out by the
  terminator; three samples the ramp at `dotNL · 0.5 + 0.5`, see `AGENTS.md`) and `outline()` for
  the single dark edge on hardware.
- `js/halfres.js` — the half-resolution passes that the fill-rate-bound layers (weather, exhaust) are drawn in.
- `js/audio.js` — engine and impact audio, gated on first keypress as browsers require.

`window.game` is the debugging/test handle wired in `js/main.js`: `state()` returns a full readback
(altitude over each body, radial velocity, speed, fuel, engine/SAS/warp state, and `aero`: dynamic
pressure, Mach, angle of attack, side load in g, static margin in m), and
`ignite()`, `stage()`, `setSas(on, retro)`, `setThrottle(v)`, `warp(m)`, `camera(name)`, `map(on)`,
`setView(yaw, pitch, dist)`,
`ff(seconds)`, `nudge(ω)`, `teleport(pos, vel, simTime)` and `reset()` drive the game exactly as a player
would, except `teleport`. `ff()` steps the shipped `physStep()` at 0.1 s without rendering, which is
how the multi-day translunar coast is crossed in a test.

## Verification

```
npm i --no-save three@0.187.0 playwright   # for the tools only; the game itself has no dependencies
npm test                                    # everything; ends with `check: all ok`, exits 1 otherwise
npm run test:headless                       # the checks that need no browser: what CI runs
```

`npm test` is `tools/check.mjs`. It runs each tool below as its own process and fails if any of
them exits non-zero:

| Tool | Exits non-zero when |
| --- | --- |
| `tools/shader-lint.mjs` | a shader breaks one of its static rules |
| `tools/mission-sim.mjs game --phase=<MOON_PHASE0>` | the shipped mission is not `WON` |
| `tools/mission-sim.mjs retro --phase=1.4742618` | the previous stack, kept as a recorded loss, does not lose |
| `tools/mission-math.py` | the vehicle it budgets is not `SPECS`, or a derived number it prints is not the one the docs and `js/constants.js` quote |
| `tools/crater-stats.mjs` | the lunar relief is discontinuous: a crater cut off along a lattice plane |
| `tools/shots.mjs` | the browser console printed an error or a warning in eleven minutes of flight |
| `tools/clip-test.mjs` | the camera gets under the terrain or inside the hull anywhere in its sweep |
| `tools/trail-offset.mjs` | the smoke column stands off the flame at any warp |
| `tools/orbit-line.mjs` | the ribbon's apoapsis is not the state vector's, engine lit or cut |
| `tools/debris-orbit.mjs` | a stage dropped in a 300 km orbit is gone, below 250 km, or over 200 km from the ship after most of a revolution |
| `tools/flicker-test.mjs` | a view in which nothing should change has changing pixels, or two meshes share a plane |

The last six drive a real Chromium on a real GPU against a dev server `check.mjs` starts on its
own port, so CI (`.github/workflows/check.yml`, on every push and pull request) runs
`node tools/check.mjs --no-browser`: the first five. `tools/flicker-test.mjs` counts, over ten
screenshots of a view with the HUD hidden, the pixels that change between consecutive frames and
the *flips* — a pixel that changes and comes straight back. Gates: the idle pad with the weather
off (at most 300 changing pixels of 1,296,000, 20 strong, 20 flips), the same from 60 m, the pad
with the weather on (loose: cloud outlines really move, and their shimmer is a known gap), a paused
flight (exactly 0), and 0 coplanar overlapping faces between meshes of the vehicle or the pad.
Current numbers and what each gate protects are in `AGENTS.md`. `tools/gpu-time.mjs` and
`tools/cloud-views.mjs` are measurements, not gates.

The mission is completable and has been flown end to end:

```
node tools/mission-sim.mjs
```

`tools/mission-sim.mjs` drives the shipped `js/*.js` modules — the same physics, vehicle and specs
the browser loads — with nothing but the controls a player has (SAS prograde/retrograde, throttle,
staging, warp-equivalent 0.1 s stepping), solves the launch-window phase, and flies the mission.
Measured (full breakdown in `docs/reference/mission-design.md`):

| | |
| --- | --- |
| Parking orbit | 151 × 760 km at 7.3706 km/s |
| TLI | to 10.3938 km/s inertial at coast start; apogee 383 242 km at the cutoff command |
| Lunar SOI entry | MET 236 539 s |
| Periselene | 346 km at 2.3611 km/s Moon-relative |
| LOI | 849 m/s at 358 km to a lunar orbit with a = 2 135 km |
| Deorbit | 83 m/s |
| Powered descent | 2 055 m/s |
| Touchdown | **3.3 m/s** against the 32 m/s `LAND_SAFE` limit |
| Propellant spare | 7.2 t of CSM propellant unused |
| Mission clock | 3.469 days |
| Δv spent | 16 274 m/s vs an ideal staged budget of 17 090 m/s and a derived one-way requirement of 15 142 m/s |

`python3 tools/mission-math.py` recomputes the derived numbers (derived requirement, budgets, the
atmosphere comparison) from the primary constants in `docs/reference/` and prints the derivation.
Its last section is a check with an exit code: the stack it budgets must be `SPECS` in
`js/constants.js`, and the requirement, the three ideal budgets, the shipped margin and ignition
mass and the Moon's sphere of influence it has just computed must be the figures the docs and the
source comments quote. It does not check anything that is flown — periselene, touchdown, Δv spent
come from `tools/mission-sim.mjs`.

None of this means the mission is easy. The vehicle has ~5 % margin between spent and ideal, the
descent is only survivable because its guidance flies an altitude-bounded velocity envelope rather
than trying to hover, and an earlier, slightly smaller stack reached the Moon and then hit the
surface at 1 264 m/s with a dry tank. The launch window is solved for a 350 km periselene, the middle
of the band the tool's autopilot lands from: every flight from 3e-3 rad of launch phase early
(745 km) to 1.75e-3 rad late (123 km, eleven minutes of lunar motion) lands at under 5 m/s, and
2e-3 rad late (91 km) runs the tank down and hits at 80 m/s. Margin on paper is not margin; the
descent has to be flown.

## How a flight is graded

A touchdown on the Moon opens a debrief. One star for landing at all — under 32 m/s and within 60°
of vertical; further over is `TIPPED OVER` and lost. Two stars at 12 m/s and 20° or better, three at
4 m/s and 8°. The score is `1000 − 25 × speed (m/s) − 6 × tilt (°) + 40 × propellant left (t)`, and
the best one is kept in the browser. On the way down the `NEXT` line under the clock gives the
braking deadline: stopping from the current speed at full thrust takes v²/2(a − g) of path, and it
says `BRAKE NOW` when the height in hand falls under 1.15 times that. The same line times the
translunar burn: in a parking orbit it counts down (`translunar burn in m:ss`) to the moment the
Moon leads the ship by `TLI_LEAD = 2.7742` rad, the lead at which the certified flight lights its
injection burn. It is a cue, not a solution — it puts a hand-flown burn in the right half-hour and
the aim readout and a trim burn do the rest. Recorded with the change that added it (commit
213226d, not re-flown for this document): the first three opportunities gave lunar passes of 194,
348 and −68 km, where the old advice to burn "at periapsis" gave 92,521 km.

Bringing the command module home is the other ending. With every stage dropped (X on the CSM) the
capsule flies alone. From orbital speed it settles heat shield first by itself; from lunar return
speed it does not have time, so hold retrograde before the air arrives. Anything still wearing a
stage, or a capsule that meets the heat apex-first, is `BURNED UP`. More than 16 g for 2 s is
`ENTRY TOO STEEP`. Press G for the drogues and again for the mains; a canopy is lost if it is opened
above its dynamic pressure (20 kPa drogues, 4 kPa mains), above its Mach number (1.5 and 0.5), or
in entry heat. Under a canopy SAS and attitude hold are ignored — the canopy steers. Measured
headless from 122 km, drogues at 7.3 km and mains at 3 km:

| entry | result |
| --- | --- |
| 7.8 km/s, −1.5° | 7.2 g, 59 kPa, splashdown at 7.8 m/s (limit 12) |
| 7.8 km/s, −6° | 14.7 g, splashdown |
| 7.8 km/s, −7° | `ENTRY TOO STEEP` (16.6 g) |
| 11 km/s, −5° | skips back out to space |
| 11 km/s, −5.5° / −6° / −6.5° | 5.6 / 10.0 / 14.4 g, splashdown |
| 11 km/s, −7° | `ENTRY TOO STEEP` (16.8 g) |
| no parachutes / drogues only | 114 m/s / 61 m/s |

So the corridor home from the Moon is about a degree wide. A splashdown is one star, two if the flight passed through the Moon's sphere of influence
first; three stars need the Moon. Details: `docs/reference/mission-design.md`.

## Known gaps

- **The aim readout gives the closest approach, not the landing site.** `js/targeting.js` predicts
  the periselene of the coast you are on and the orbit panel prints it; it answers "how hard will
  the encounter be", not "where will I touch down". It is green between 120 and 745 km: the band
  the tool's autopilot lands from (123 km to 745 km), with the floor set between the last landing
  and the first loss (110 km; 91 km is lost too). Below 420 km the prediction includes drag.
  Nothing marks the launch window itself; the player finds it by waiting and warping.
- **The Moon is a parametric circular orbit**, not an ephemeris: fixed 384 400 km radius, sidereal
  rate `MOON_RATE`, fixed 28.5° inclination, no eccentricity, no node regression.
- **The air is an exponential density model** (8.5 km scale height), not USSA-1976/MSISE-90;
  `docs/reference/atmosphere.md` quantifies the error. The flight model on top of it is deliberately
  coarse: textbook-order coefficients rather than wind-tunnel data, body lift lumped at the planform
  centroid — which makes this vehicle statically stable where the real Saturn V was not and flew on
  engine gimbal. Heating is a threshold on a proxy (√ρ·v³), not a thermal model, and the capsule's
  entry is ballistic: no lift to steer with, which is why its corridor is a degree wide. The one structural load is the
  lateral aerodynamic limit.
- **The headless tool lands on the datum sphere.** In the browser contact is against the drawn
  relief (`groundHeight` / `moonGroundHeight`); `tools/mission-sim.mjs` injects no terrain, so its
  touchdown speed is for a Moon with no hills.
- **Open, known and not fixed:** cloud outlines shimmer by about a pixel (`tools/flicker-test.mjs`
  measures it; its gate on that view is loose). A playtest also reported dark blotches near the
  terminator in the map; that has not been re-checked.
- **No way home from the surface.** A landed mission ends at touchdown: there is no lunar ascent
  stage and no TEI in the game. Re-entry and splashdown exist for flights that never landed — from
  Earth orbit, or round the Moon and back.

- **Terrain under the vehicle can lag the planet by a frame.** Contact height is read through the
  planet mesh's drawn rotation, which is updated once per rendered frame; at high warp the physics
  steps inside that frame see the terrain where it was drawn. Found in code review, not
  measured, and not fixed. It cannot affect the headless tool, which has no terrain.

## Reference docs

`docs/reference/` holds the source-cited data the simulation is built on (Earth/Moon/Sun fact
sheets, LC-39, atmosphere, the unit conventions above). Start with its `README.md` index. Three of
note:

- `mission-design.md` — the measured mission above, the derived 15.1 km/s one-way requirement, the
  vehicle budgets, guidance loss, and validation status.
- `orbital-mechanics.md` — the formulas `js/physics.js` implements: vis-viva, patched conics, SOI,
  staging Δv accounting, gravity loss.
- `spacecraft.md` — Saturn V stage masses, F-1/J-2/DPS/SPS engines, propellants, the Apollo 11
  spacecraft stack.

## Licence

MIT — see `LICENSE`.
