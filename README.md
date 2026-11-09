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
  3.436 days, as a real one does.
- Visuals ride at real planetary scale; the vehicle mesh is scaled by `VS` (≈105 m, Saturn-V sized).

## Architecture

- `js/physics.js` (483 lines) — the integrator and the reference-frame helpers. Two-body
  inverse-square gravity for Earth and Moon, exponential drag, mass burn, staging, attitude
  dynamics, SAS, the trajectory predictor, and `impact()`. Its frame rule matters: `navVel()` is
  Moon-relative inside the lunar SOI and inertial outside (it drives SAS and the navball),
  `groundVel()` is velocity relative to the surface of whichever body is underneath (it drives
  `impact()` and the HUD speed readout), and `bodyUp()` is the attitude to hold when the velocity
  vector has no direction worth steering by. The Moon moves at ~1 023 m/s through the game frame, so
  anything judged against a surface must not use the raw state vector `S.v`.
- `js/world.js` (302 lines) — Earth, Moon, sky gradient, starfield, two cloud decks (cumulus and
  cirrus) that cast moving shadows, the sun whose shadow camera follows the vehicle, and the launch
  pad welded to the rotating planet.
- `js/vehicle.js` (234 lines) — the three rocket-stage meshes, staging visuals, exhaust particles,
  debris, the gimballing flame, and the thrust/velocity arrows drawn beside the vehicle
  (`initNavVectors` / `updateNavVectors`).
- `js/navball.js` (286 lines) — the KSP-style attitude ball: an orthographic view of the sky from
  the nose, prograde/retrograde markers, apsis markers, the Moon as a target.
- `js/hud.js` (202 lines) — telemetry panel, flight computer, minimap (auto / system views, lunar
  SOI marked), stage fuel pips, throttle gauge with engine output in kN, logs, end overlay.
- `js/main.js` (140 lines) — renderer bootstrap, keyboard input, the render loop (warp → substeps),
  camera cycling, and the `window.game` debug handle.
- `js/constants.js` (114 lines) — every physical constant: `RE`/`MU_E`, `RM`/`MU_M`/`SOI_M`,
  `MOON_DIST`, Earth spin, LC-39 position, the exponential-atmosphere parameters, `SPECS` (stage
  dry/fuel/thrust/Isp), `LAND_SAFE` (0.032 km/s), `WARPS`, `DTPHYS`, the SAS pitch program `TURN`,
  and `MOON_PHASE0` — the solved launch window (the Moon's angle along its orbit at MET 0 for which
  a TLI at the first perigee after insertion arrives at the Moon).
- `js/camera.js` (107 lines) — chase, orbit and system cameras; drag/zoom input.
- `js/textures.js` (99 lines) — the body surfaces. Earth diffuse/normal/specular, the cloud sheet and
  the lunar map are real imagery served from `assets/` (1.5 MB total, committed); only the high
  cirrus deck and the shared glow sprite are generated here, deterministically, so the weather is
  the same every run. The specular map doubles as an ocean mask.
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
| TLI | to 10.3932 km/s inertial, apogee 385 295 km |
| Lunar SOI entry | MET 234 479 s |
| Periselene | 203 km at 2.4375 km/s Moon-relative |
| LOI | 869 m/s to a lunar orbit with a = 1 990 km |
| Deorbit | 57 m/s |
| Powered descent | 2 008 m/s |
| Touchdown | **20.2 m/s** against the 32 m/s `LAND_SAFE` limit |
| Propellant spare | 7.5 t of CSM propellant unused |
| Mission clock | 3.436 days |
| Δv spent | 16 233 m/s vs an ideal staged budget of 17 090 m/s and a derived one-way requirement of 15 142 m/s |

`python3 tools/mission-math.py` recomputes the derived numbers (derived requirement, budgets, the
atmosphere comparison) from the primary constants in `docs/reference/`; it exits 0 when script and
docs agree.

None of this means the mission is easy. The vehicle has ~5 % margin between spent and ideal, the
descent is only survivable because its guidance flies an altitude-bounded velocity envelope rather
than trying to hover, and an earlier, slightly smaller stack reached lunar orbit and then hit the
surface at 1 233 m/s with a dry tank. Margin on paper is not margin; the descent has to be flown.

## Known gaps

- **No predicted-periselene readout.** The HUD shows apoapsis/periapsis but nothing predicts the
  periselene of a translunar coast, and that is what makes the aim hard for a human: near the window
  the encounter moves about 130 km of periselene per 1e-3 rad of launch phase, so the tolerance is
  roughly ±1e-3 rad — about ±3 s of lunar motion (measured in
  `docs/reference/mission-design.md`). The mission sim solves this by finite differences; a player
  cannot see it.
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
