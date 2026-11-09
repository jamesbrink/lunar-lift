# LUNAR LIFT

Fly a three-stage rocket — S-1 SATURN I (solid), S-2 SATURN II and the CSM ENGINE (both
throttleable) — off LC-39 at Cape Canaveral on a rotating, real-radius Earth (6 371 km) and out to a
real Moon 384 400 km away: orbit, trans-lunar injection, lunar orbit insertion, and a soft powered
landing under the 32 m/s `LAND_SAFE` limit or you lose the spacecraft. The orbital physics is
hand-written in `js/physics.js` — no orbital-mechanics library; the only runtime dependency is
Three.js 0.160.1, loaded from a CDN through the importmap in `index.html`, so an internet connection
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

Read from the `keydown` handler in `js/main.js` and the hold-key reads in `js/physics.js`:

| Key | Action |
| --- | --- |
| SPACE | Ignite / flameout. S-1 is a solid: once lit it runs at 100 % to burnout. On S-2/CSM, raising the throttle relights the engine (KSP-style) |
| SHIFT (hold) | Throttle up |
| CTRL (hold) | Throttle down |
| W / S or ↑ / ↓ | Pitch |
| A / D or ← / → | Yaw |
| Q / E | Roll |
| X | Separate the spent stage |
| P | SAS autopilot on / off (holds the pitch program off the pad, then the velocity vector) |
| V | Flip SAS between prograde and retrograde |
| ] / [ | Time warp up / down the ladder |
| C | Camera mode: chase / orbit / system |
| M | Minimap view: auto / system |
| R | Reset the mission (ENTER or SPACE on the end overlay) |
| Mouse drag | Orbit camera |
| Mouse wheel | Zoom |

Warp ladder (`WARPS` in `js/constants.js`): ×1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000. The
convention that makes coasting honest: **warp multiplies the number of substeps, never the step
size.** `js/main.js` takes `simDt = frame time × warp` and splits it into substeps capped at
`DTPHYS = 0.1 s` (at least 1 per frame, up to 600), so the integrator sees the same 0.1 s steps at
×1000 that it sees at ×1 — the trajectory is identical at every warp factor, ×1000 only buys wall
clock.

Flight controls are inertial: the keys apply torque against the vehicle's live moment of inertia, so
the fueled stack turns slowly and the HUD's `authority` readout climbs as propellant burns off; tail
fins damp the rate and weathervane the nose into the airflow, and the burning engine gimbal swings
the plume opposite each turn.

## Units and scale

Repo-wide convention (see `docs/reference/README.md`): **km, s, tonnes, kN**.

- `thrust / mass` with kN over tonnes is exactly **m/s²**; `GM / r²` with `GM` in km³/s² and `r` in
  km gives **km/s²**.
- State vectors are km/s internally; the HUD reads m/s.
- `simTime` is real mission seconds — no time-scaling fudge anywhere. The measured mission clocks
  3.404 days, as a real one does.
- Visuals ride at real planetary scale; the vehicle mesh is scaled by `VS` (≈105 m, Saturn-V sized).

## Architecture

- `js/physics.js` (521 lines) — the integrator and the reference-frame helpers. Two-body
  inverse-square gravity for Earth and Moon, exponential drag, mass burn, staging, attitude
  dynamics, SAS, the trajectory predictor, and `impact()`. Its frame rule matters: `navVel()` is
  Moon-relative inside the lunar SOI and inertial outside (it drives SAS and the navball),
  `groundVel()` is velocity relative to the surface of whichever body is underneath (it drives
  `impact()` and the HUD speed readout), and `bodyUp()` is the attitude to hold when the velocity
  vector has no direction worth steering by. The Moon moves at ~1 023 m/s through the game frame, so
  anything judged against a surface must not use the raw state vector `S.v`. Also owns `LES_ALT`
  (90 km) and the launch-escape-tower jettison, which is visual only and sheds no mass.
- `js/world.js` (591 lines) — Earth, Moon, sky gradient, starfield, the two cloud decks (cumulus at
  2 km, cirrus at 9 km, which deliberately **do not** cast shadows — see `agents.md`), the sun whose
  shadow camera follows the vehicle, and the launch pad welded to the rotating planet. Drives
  `js/clouds.js` with the ground point and the sun in body-local space. Exposes the terrain queries
  `groundHeight`, `moonGroundHeight` and `fineGroundHeight` (km above the reference sphere), plus
  `planetCanvas` and `bodySpin` for the orbital map.
- `js/terrain.js` (269 lines) — the near level: one 161 × 161 mesh warped radially, ~25 m spacing
  under the vehicle stretching to a ±220 km rim, hidden above 30 km and re-centred in place after
  ground travel, so the ground the vehicle touches is always the authored ground.
- `js/toonmap.js` (921 lines) — where the planets are *painted*, once at boot, from data rather than
  from imagery: the specular sheet is read as a land mask and the diffuse sheet as a biome signal, and
  the result is a flat cartoon surface map — ocean, shelf, a hard coastline stroke, grass, forest,
  desert, tundra, boreal, ice — plus the relief fields, the authored Merritt Island shore lines and the
  cloud sheets. No photographic pixel reaches the screen. Look and its limits:
  `docs/reference/painted-planets.md` and `docs/reference/cartoon-art-direction.md`.
- `js/toon.js` (119 lines) — the cel shading itself: `toon()` materials on a quantising ramp
  (`RAMP_EARTH` is four texels with the top two equal, so its steps sit at N·L = −0.5, 0, +0.5 — out by
  the terminator; three samples the ramp at `dotNL · 0.5 + 0.5`, see `agents.md`), `PALETTE`, and
  `outline()` for the single dark edge on hardware.
- `js/vehicle.js` (952 lines) — the three rocket-stage meshes, staging visuals, LES jettison, debris,
  the gimballing flame, the thrust/velocity arrows drawn beside the vehicle (`initNavVectors` /
  `updateNavVectors`), and the exhaust: a 1 600-slot pool of physics parcels spawned on the real bell
  exit discs, integrated against drag, gravity and the ground/pad/hull colliders, composited in one
  draw call so smoke can darken the sky instead of glowing at it.
- `js/ribbon.js` (198 lines) — the trajectory prediction as a screen-space ribbon (a 3 px core under an
  11 px additive halo, two draw calls, `PRED_MAX` 2 700 points) rather than a thin `Line`, so it stays
  legible against both the planet and black space.
- `js/hud.js` (378 lines) — telemetry panel, flight computer, stage fuel pips, throttle gauge with
  engine output in kN, logs, end overlay, and the full-screen orbital map (`M`): both bodies drawn as
  polar azimuthal discs painted from the same canvas the meshes use, with the terminator, the vehicle
  track and the launch site on them.
- `js/navball.js` (286 lines) — the KSP-style attitude ball: an orthographic view of the sky from
  the nose, prograde/retrograde markers, apsis markers, the Moon as a target.
- `js/camera.js` (216 lines) — chase, orbit and system cameras; drag/zoom input; damping plus collision
  against the vehicle, the pad, the Earth and the Moon, applied twice per frame because a chord between
  two points outside a sphere is inside it.
- `js/main.js` (149 lines) — renderer bootstrap, keyboard input, the render loop (warp → substeps),
  camera cycling, and the `window.game` debug handle.
- `js/targeting.js` (108 lines) — the predicted lunar aim: propagates the live state forward through
  `gravityAt` at the game's own 0.1 s step and publishes the closest lunar approach, incrementally
  (a fixed step budget per frame) and only re-seeding after thrust, past the predicted encounter, or
  when the result goes stale. It reproduces the certified flights' periselene to under 0.5 km,
  which means it predicts what this game will do rather than the converged two-body answer.
- `js/constants.js` (119 lines) — every physical constant: `RE`/`MU_E`, `RM`/`MU_M`/`SOI_M`,
  `MOON_DIST`, Earth spin, LC-39 position, the exponential-atmosphere parameters, `SPECS` (stage
  dry/fuel/thrust/Isp), `LAND_SAFE` (0.032 km/s), `WARPS`, `DTPHYS`, the SAS pitch program `TURN`,
  and `MOON_PHASE0` — the solved launch window (the Moon's angle along its orbit at MET 0 for which
  a TLI at the first perigee after insertion arrives at the Moon).
- `js/textures.js` (151 lines) — the generated sheets: the two cloud decks and the shared glow
  sprite, deterministic so the weather is the same every run. The photographic diffuse/normal/specular maps
  under `assets/` are inputs to the painter in `js/toonmap.js` (mask and biome signal); the normal
  map is no longer bound to any surface, per `docs/reference/cartoon-art-direction.md`.
- `js/clouds.js` (284 lines) — weather at human scale: a 440 km cloud cap at 7 km altitude and a
  64 km shade cap, both re-centred under the vehicle. The deck samples one tileable puff field at 390 m
  per texel; the shade samples the same field box-filtered to 64 × 64 with no mip chain, because a cap
  that size minifies hard and mip selection is per triangle. Shadows land under their clouds, offset
  anti-sunward by deck height over tan(elevation). The planet-scale decks cannot do this — one of their texels is 39 km and
  the whole sky above the pad spans a fifth of one. Why it has to exist: `agents.md`.
- `js/audio.js` (53 lines) — engine and impact audio, gated on first keypress as browsers require.

`window.game` is the debugging/test handle wired in `js/main.js`: `state()` returns a full readback
(altitude over each body, radial velocity, speed, fuel, engine/SAS/warp state), and
`ignite()`, `stage()`, `setSas(on, retro)`, `setThrottle(v)`, `warp(m)`, `camera(n)`,
`ff(seconds)`, `nudge(ω)`, `teleport(pos, vel)` and `reset()` drive the game exactly as a player
would, except `teleport`. `ff()` steps the shipped `physStep()` at 0.1 s without rendering, which is
how the multi-day translunar coast is crossed in a test.

## Verification

The mission is completable and has been flown end to end:

```
npm i --no-save three@0.160.1    # for the tool only; the game itself has no dependencies
node tools/mission-sim.mjs
```

`tools/mission-sim.mjs` drives the shipped `js/*.js` modules — the same physics, vehicle and specs
the browser loads — with nothing but the controls a player has (SAS prograde/retrograde, throttle,
staging, warp-equivalent 0.1 s stepping), solves the launch-window phase, and flies the mission.
Measured (full breakdown in `docs/reference/mission-design.md`):

| | |
| --- | --- |
| Parking orbit | 150 × 784 km at 7.3572 km/s |
| TLI | to 10.4005 km/s inertial at coast start; apogee 384 202 km at the cutoff |
| Lunar SOI entry | MET 232 147 s |
| Periselene | 169 km at 2.4585 km/s Moon-relative |
| LOI | 875 m/s to a lunar orbit with a = 1 957 km |
| Deorbit | 51 m/s |
| Powered descent | 2 003 m/s |
| Touchdown | **20.1 m/s** against the 32 m/s `LAND_SAFE` limit |
| Propellant spare | 7.6 t of CSM propellant unused |
| Mission clock | 3.404 days |
| Δv spent | 16 226 m/s vs an ideal staged budget of 17 090 m/s and a derived one-way requirement of 15 142 m/s |

`python3 tools/mission-math.py` recomputes the derived numbers (derived requirement, budgets, the
atmosphere comparison) from the primary constants in `docs/reference/`; it exits 0 when script and
docs agree.

None of this means the mission is easy. The vehicle has ~5 % margin between spent and ideal, the
descent is only survivable because its guidance flies an altitude-bounded velocity envelope rather
than trying to hover, and an earlier, slightly smaller stack reached the Moon and then hit the
surface at 5 577 m/s with a dry tank. Margin on paper is not margin; the descent has to be flown.

## Known gaps

- **The aim readout gives the closest approach, not the landing site.** `js/targeting.js` propagates
  the live state at the game's own 0.1 s step and the orbit panel prints the predicted periselene —
  169 km on the shipped window, against the simulation's 169 km — but it answers "how hard will the
  encounter be", not "where will I touch down", and it takes ~11 s of frames to settle after each
  manoeuvre. Nothing marks the launch window itself; the player finds it by waiting and warping.
- **The Moon is a parametric circular orbit**, not an ephemeris: fixed 384 400 km radius, sidereal
  rate `MOON_RATE`, fixed 28.5° inclination, no eccentricity, no node regression.
- **Drag is an exponential model** (8.5 km scale height), not USSA-1976/MSISE-90;
  `docs/reference/atmosphere.md` quantifies the error. No structural loads are modelled either.
- **No return leg.** The mission ends at touchdown: there is no lunar ascent stage and no TEI in the
  game, and `docs/reference/mission-design.md` lists the return to Earth as not modelled.

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
