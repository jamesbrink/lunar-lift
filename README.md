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
| SPACE | Ignite / flameout. S-1 is a solid: once lit it runs at 100 % to burnout. On S-2/CSM, raising the throttle relights the engine (KSP-style) |
| SHIFT (hold) | Throttle up |
| CTRL (hold) | Throttle down |
| W / S | Pitch |
| A / D | Yaw |
| Q / E | Roll |
| X | Separate the stage. Pressed on the CSM it leaves the command module flying alone |
| P | SAS autopilot on / off (holds the pitch program off the pad, then the velocity vector) |
| V | Flip SAS between prograde and retrograde |
| H | Attitude hold on / off: stops every rotation and keeps the nose where it is; steering by hand moves the held attitude with you. Switching SAS on cancels it, and it switches SAS off |
| T | RCS stability assist on / off (on by default; off, nothing damps a rotation in vacuum) |
| G | Parachutes, command module only: first press drogues, second press mains |
| ] / [ | Time warp up / down the ladder |
| C | Camera mode: orbit (the default) ↔ chase |
| M | Map: the same 3-D scene from far off, with the ship, both bodies, the Moon's orbit and sphere of influence, the coast path and the Moon's position at closest approach marked |
| F | Map focus: Earth → Moon → ship |
| ↑ ↓ ← → | Turn the camera (they no longer steer the ship) |
| − / = | Zoom out / in |
| R | Reset the mission (ENTER or SPACE on the end overlay) |
| Mouse drag | Turn the camera |
| Double-click | Re-centre the view behind the ship |
| Mouse wheel | Zoom |

Warp ladder (`WARPS` in `js/constants.js`): ×1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000. The
convention that makes coasting honest: **warp multiplies the number of substeps, never the step
size.** `js/main.js` takes `simDt = frame time × warp` and splits it into substeps capped at
`DTPHYS = 0.1 s` (at least 1 per frame, up to 600), so the integrator sees the same 0.1 s steps at
×1000 that it sees at ×1 — the trajectory is identical at every warp factor, ×1000 only buys wall
clock.

Flight controls are inertial: the keys apply torque against the vehicle's live moment of inertia, so
the fueled stack turns slowly and the HUD's `authority` readout climbs as propellant burns off, and
the burning engine gimbal swings the plume opposite each turn. Nothing else turns the vehicle for
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

- `js/physics.js` (681 lines) — the integrator and the reference-frame helpers. Inverse-square
  gravity from Earth and Moon plus the indirect term an Earth-centred frame owes (the Earth falls
  toward the Moon too), the aerodynamic force and its torque from `js/aero.js`, mass burn, staging,
  attitude dynamics, SAS, attitude hold, the RCS stability assist, side-load strain and breakup, the
  command module's heat-shield rule and parachutes, and `impact()`. Contact is the
  lowest attached point (`surfaceAlt()`: the engine bell of whatever stage is still bolted on, or
  the nose if it is upside down) meeting the terrain, and a slow touchdown more than 60° from
  vertical is `TIPPED OVER`, a loss. It also holds
  `GEOM`, the one table of segment lengths, radii and stations that both the moment of inertia and
  the aerodynamic shape are built from. Its frame rule matters: `navVel()` is
  Moon-relative inside the lunar SOI and inertial outside (it drives SAS and the navball),
  `groundVel()` is velocity relative to the surface of whichever body is underneath (it drives
  `impact()` and the HUD speed readout), and `bodyUp()` is the attitude to hold when the velocity
  vector has no direction worth steering by. The Moon moves at ~1 023 m/s through the game frame, so
  anything judged against a surface must not use the raw state vector `S.v`. Also owns `LES_ALT`
  (90 km) and the launch-escape-tower jettison, which is visual only and sheds no mass.
- `js/aero.js` (81 lines) — the atmospheric flight model, display-free: exponential density, speed of
  sound, the transonic drag rise, and `aeroForce()` — axial drag plus the angle-of-attack normal
  force. One evaluation per step feeds both the trajectory and the torque. What it models and what
  it deliberately does not: `docs/reference/atmosphere.md`.
- `js/world.js` (687 lines) — Earth, Moon, sky gradient, starfield, the sun whose
  shadow camera follows the vehicle, and the launch pad welded to the rotating planet. Mounts the
  weather shell from `js/clouds.js` and composes the ground materials' injections (cloud shade, haze,
  coastline ink) — one `onBeforeCompile` per material. Exposes the terrain queries
  `groundHeight`, `moonGroundHeight` and `fineGroundHeight` (km above the reference sphere), plus
  `planetCanvas` and `bodySpin` for the navball's globe.
- `js/terrain.js` (549 lines) — the near level: one 161 × 161 mesh warped radially, ~25 m spacing
  under the vehicle stretching to a ±220 km rim, hidden above 30 km and re-centred in place after
  ground travel, so the ground the vehicle touches is always the authored ground.
- `js/toonmap.js` (1778 lines) — where the planets are *painted*, once at boot, from data rather than
  from imagery: the specular sheet is read as a land mask and the diffuse sheet as a biome signal, and
  the result is a flat cartoon surface map — ocean, shelf, a hard coastline stroke, grass, forest,
  desert, tundra, boreal, ice — plus the relief fields, the authored Merritt Island shore lines and the
  cloud sheets. No photographic pixel reaches the screen. Look and its limits:
  `docs/reference/painted-planets.md` and `docs/reference/cartoon-art-direction.md`.
- `js/toon.js` (117 lines) — the cel shading itself: `toon()` materials on a quantising ramp
  (`RAMP_EARTH` is four texels with the top two equal, so its steps sit at N·L = −0.5, 0, +0.5 — out by
  the terminator; three samples the ramp at `dotNL · 0.5 + 0.5`, see `agents.md`), `PALETTE`, and
  `outline()` for the single dark edge on hardware.
- `js/saturn.js` (214 lines) — the Saturn V as drawn hardware: three stage groups in the real paint
  scheme, engine fairings and fins, contoured bells, the launch escape system, and the command
  module as its own group so it can fly on alone.
- `js/vehicle.js` (210 lines) — what the hardware does: the pose each frame, staging and debris, and
  the call that turns a burning stage into fire and smoke.
- `js/flame.js` (214 lines) — the drawn flames: one shader-shaped mesh per stage with hard tone bands,
  shock diamonds in thick air, a wide translucent bell in thin air, an engine-by-engine start-up.
- `js/exhaust-pool.js`, `exhaust-emit.js`, `exhaust-sim.js`, `exhaust-draw.js` (148, 312, 491, 254 lines) —
  the particle field: the pool, where parcels are born (nozzles, smoke trail, ignition steam, lunar
  dust), how they move (drag, the trench, the hull), and how they are drawn (opaque shaded puffs).
- `js/chutes.js` (70 lines) — the command module's parachutes as drawn hardware: two drogues, then
  three orange-and-white mains, inflated by the state `js/physics.js` publishes.
- `js/vehicle.js` (1374 lines) — what the hardware does: the pose each frame, the flames' size and
- `js/pad.js` (202 lines) — Launch Complex 39: mobile launcher with a real flame opening, the red
  umbilical tower with swing arms and crane, propellant farm, floodlights, and the site it stands on —
  hardstand, flame trench, crawlerway, perimeter road, water tower. Static geometry is merged
  into nine meshes.
- `js/halfres.js` (103 lines) — the half-resolution pass the weather and the exhaust are drawn in, with
  the exhaust behind its own depth prepass, the weather cut by the hardware at full resolution.
- `js/predictor.js` (276 lines) — where the vehicle is going. Integrates the path five times a second,
  draws it every frame from the ship's current position: it starts a short gap ahead of the ship, fades
  in, dims with time ahead, and stops after one lap of a closed orbit. Places the `Ap`/`Pe` markers
  on the path and raises the impact warning.
- `js/ribbon.js` (213 lines) — a polyline as a screen-space ribbon (a 2 px feathered core under a 9 px
  additive halo, per-point colour and opacity) rather than a thin `Line`, so it stays legible against
  both the planet and black space.
- `js/hud.js` (318 lines) — telemetry, stage fuel pips, throttle gauge, logs, the `NEXT` line (what
  to do now and the key that does it, derived from the live state — including the braking deadline
  on the way down to the Moon and the parachute calls on the way home), the end overlay and the
  landing debrief with its stars and score.
- `js/mapview.js` (112 lines) — what the map adds to the scene: a marker for the ship, a name on each
  body, the Moon's orbit and its sphere of influence, the whole coast path, and where the Moon will
  be at closest approach. The map itself
  is the real scene seen from the map camera; the old 2-D canvas map is gone.
- `js/navball.js` (498 lines) — the KSP-style attitude ball: an orthographic view of the sky from
  the nose, prograde/retrograde markers, apsis markers, the Moon as a target.
- `js/camera.js` (428 lines) — orbit and chase cameras and the map camera; drag, wheel, arrow-key and
  − / = input. Orbit is the default: the camera circles the ship on a heading carried along with it,
  never taken from the nose or the velocity, so the view moves only when you move it and nothing
  eases it "home" on a timer (double-click re-centres). Chase sits behind the flight path — heading
  from the horizontal velocity, elevation from the climb angle. The map (M) pivots on Earth, the
  Moon or the ship (F), looking down on the Moon's orbital plane; it replaced a 'system' view.
  The frame shakes with thrust and dynamic pressure. Follows the middle of
  the hardware still attached and damps its *offset* from it, so the ship stays centred at any speed
  or warp and re-frames smoothly at staging. Collides with the vehicle, the pad, the Earth and the
  Moon — twice per frame because a chord between two legal points can pass through a body, and in
  three rounds each time because one push-out can land inside another solid
  (`tools/clip-test.mjs` sweeps it).
- `js/main.js` (183 lines) — renderer bootstrap, keyboard input, the render loop (warp → substeps),
  camera cycling, and the `window.game` debug handle.
- `js/targeting.js` (111 lines) — the predicted lunar aim: propagates the live state forward through
  `gravityAt` at the game's own 0.1 s step and publishes the closest lunar approach, incrementally
  (a fixed step budget per frame) and only re-seeding after thrust, past the predicted encounter, or
  when the result goes stale. Run headless from the recorded coast-start state it reproduces the
  certified flights' periselene to about 1 km (476.5 / 345.7 / 217.0 km against the tool's
  477 / 346 / 218), which means it predicts what this game will do rather than the converged two-body
  answer.
- `js/constants.js` (125 lines) — every physical constant: `RE`/`MU_E`, `RM`/`MU_M`/`SOI_M`,
  `MOON_DIST`, Earth spin, LC-39 position, the exponential-atmosphere parameters, `SPECS` (stage
  dry/fuel/thrust/Isp), `LAND_SAFE` (0.032 km/s), `SAFE_EARTH` (0.012 km/s), `WARPS`, `DTPHYS`, the SAS pitch program `TURN`,
  and `MOON_PHASE0` — the solved launch window (the Moon's angle along its orbit at MET 0 for which
  a TLI at the first perigee after insertion arrives at the Moon).
- `js/textures.js` (232 lines) — the generated sheets: the weather's macro fields (zonal cumulus cover and cirrus veil) and the shared glow
  sprite, deterministic so the weather is the same every run. The photographic diffuse/normal/specular maps
  under `assets/` are inputs to the painter in `js/toonmap.js` (mask and biome signal); the normal
  map is no longer bound to any surface, per `docs/reference/cartoon-art-direction.md`.
- `js/clouds.js` (443 lines) — the weather: one shell from 4 to 11 km around the whole planet, its
  opacity marched through the view ray as optical depth. The macro sheet sets coverage, a tileable rank
  lattice at 0.31 km per texel gives the cells their shape, and two drifting copies of it make them
  build and dissolve. The same march, aimed up the sun ray, is injected into the globe and the near
  patch as ground shade. Details and measurements: `docs/reference/painted-planets.md`.
- `js/haze.js` (62 lines) — aerial perspective for the ground: one exp² law in true distance, injected
  into both the near patch and the globe so they agree at the patch's rim.
- `js/audio.js` (62 lines) — engine and impact audio, gated on first keypress as browsers require.

`window.game` is the debugging/test handle wired in `js/main.js`: `state()` returns a full readback
(altitude over each body, radial velocity, speed, fuel, engine/SAS/warp state, and `aero`: dynamic
pressure, Mach, angle of attack, side load in g, static margin in m), and
`ignite()`, `stage()`, `setSas(on, retro)`, `setThrottle(v)`, `warp(m)`, `camera(name)`, `map(on)`,
`setView(yaw, pitch, dist)`,
`ff(seconds)`, `nudge(ω)`, `teleport(pos, vel, simTime)` and `reset()` drive the game exactly as a player
would, except `teleport`. `ff()` steps the shipped `physStep()` at 0.1 s without rendering, which is
how the multi-day translunar coast is crossed in a test.

## Verification

The mission is completable and has been flown end to end:

```
npm i --no-save three@0.187.0    # for the tool only; the game itself has no dependencies
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
atmosphere comparison) from the primary constants in `docs/reference/`; it exits 0 when script and
docs agree.

None of this means the mission is easy. The vehicle has ~5 % margin between spent and ideal, the
descent is only survivable because its guidance flies an altitude-bounded velocity envelope rather
than trying to hover, and an earlier, slightly smaller stack reached the Moon and then hit the
surface at 1 264 m/s with a dry tank. The launch window is solved for a 350 km periselene, the middle
of the band the tool's autopilot lands from: every flight from 3e-3 rad of launch phase early
(745 km) to 1.75e-3 rad late (123 km, eleven minutes of lunar motion) lands at under 5 m/s, and
2e-3 rad late (91 km) runs the tank down and hits at 71 m/s. Margin on paper is not margin; the
descent has to be flown.

## How a flight is graded

A touchdown on the Moon opens a debrief. One star for landing at all — under 32 m/s and within 60°
of vertical; further over is `TIPPED OVER` and lost. Two stars at 12 m/s and 20° or better, three at
4 m/s and 8°. The score is `1000 − 25 × speed (m/s) − 6 × tilt (°) + 40 × propellant left (t)`, and
the best one is kept in the browser. On the way down the `NEXT` line under the clock gives the
braking deadline: stopping from the current speed at full thrust takes v²/2(a − g) of path, and it
says `BRAKE NOW` when the height in hand falls under 1.15 times that.

Bringing the command module home is the other ending. With every stage dropped (X on the CSM) the
capsule flies alone and settles heat shield first by itself; anything still wearing a stage, or a
capsule that meets the heat apex-first, is `BURNED UP`. Press G for the drogues once the air has
slowed you under 20 kPa of dynamic pressure and again for the mains under 4 kPa — earlier and the
airstream tears them off. Measured headless from a 7.8 km/s entry at −1.5°: 7.2 g and 59 kPa at
41 km, then 7.8 m/s under the mains against the 12 m/s limit; 114 m/s with no parachutes, 61 m/s on
drogues alone. At lunar return speed (11 km/s) −6.5° lands after 14.4 g and −5° skips back out to
space. A splashdown is one star, two if the flight passed through the Moon's sphere of influence
first; three stars need the Moon. Details: `docs/reference/mission-design.md`.

## Known gaps

- **The aim readout gives the closest approach, not the landing site.** `js/targeting.js` propagates
  the live state at the game's own 0.1 s step and the orbit panel prints the predicted periselene —
  346 km on the shipped window, against the simulation's 346 km — but it answers "how hard will the
  encounter be", not "where will I touch down", and it needs 865 frames of its step budget to finish
  after each manoeuvre (counted headless; about 14 s at 60 fps, not re-timed in a browser). It is
  green between 140 and 600 km. That band is conservative, not exact: every measured flight inside
  it landed, and so did three outside it (123, 610 and 745 km); below, 110 km and 91 km are lost.
  Nothing marks the launch window itself; the player finds it by waiting and warping.
- **The Moon is a parametric circular orbit**, not an ephemeris: fixed 384 400 km radius, sidereal
  rate `MOON_RATE`, fixed 28.5° inclination, no eccentricity, no node regression.
- **The air is an exponential density model** (8.5 km scale height), not USSA-1976/MSISE-90;
  `docs/reference/atmosphere.md` quantifies the error. The flight model on top of it is deliberately
  coarse: textbook-order coefficients rather than wind-tunnel data, body lift lumped at the planform
  centroid — which makes this vehicle statically stable where the real Saturn V was not and flew on
  engine gimbal. Heating is a threshold on a proxy (√ρ·v³), not a thermal model, and the capsule's
  entry is ballistic: no lift to steer with, and nothing limits g. The one structural load is the
  lateral aerodynamic limit.
- **The headless tool lands on the datum sphere.** In the browser contact is against the drawn
  relief (`groundHeight` / `moonGroundHeight`); `tools/mission-sim.mjs` injects no terrain, so its
  touchdown speed is for a Moon with no hills.
- **No way home from the surface.** A landed mission ends at touchdown: there is no lunar ascent
  stage and no TEI in the game. Re-entry and splashdown exist for flights that never landed — from
  Earth orbit, or round the Moon and back.

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
