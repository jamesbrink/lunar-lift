# LUNAR LIFT

Fly a three-stage rocket — an S-1 SOLID BOOSTER, a throttleable S-2 UPPER, and a throttleable CSM
ENGINE — off a launch pad on a 1000 km-radius planet and out to a Moon 12,000 km away. Two-body
inverse-square gravity, atmospheric drag, and staging are simulated, so the flight is a real mission
profile: climb, gravity turn, coast, lunar encounter, and a powered descent. Touch down softer than
32 m/s or you lose the spacecraft. Flight controls are inertial: the keys apply torque against the
vehicle's live moment of inertia, so the fully fueled stack turns slowly and the flight computer's
`authority` readout climbs as propellant burns off; tail fins damp the rate and weathervane the nose
into the airflow, and the burning engine gimbal tilts its plume opposite each turn. The HUD
carries telemetry, a flight computer (periapsis, apoapsis, range), a green trajectory prediction
line, an Earth-Moon minimap with the lunar sphere of influence drawn as a dashed sphere of about
2,100 km, stage fuel pips, and a center throttle gauge reading percent and engine output in kN. Time
display scales sim seconds so surface gravity reads 9.81 m/s^2 and MET shows mission-realistic
durations. The planet wears a weather system — cumulus fields and spiral storms on two cloud decks
that cast moving shadows across the surface — and a sun whose shadow camera follows the vehicle, so
the rocket, the launch complex, and the lander all cast real shadows from tower to lunar surface.

## Run

Node 18+ is the only requirement — the dev server is dependency-free and reloads the page in the
browser the moment any `js/`, `css/` or `index.html` file changes:

```
npm run dev            # node server.js, port 8078
npm run dev 8000       # any port you like
```

then visit `http://127.0.0.1:8078/index.html`. Three.js still comes from a CDN through the
importmap, so an internet connection is required.

## Controls

| Key | Action |
| --- | --- |
| SPACE | Ignite — the S-1 solid booster burns at 100% to burnout and sheds itself; on S-2/CSM also flameout |
| SHIFT (hold) | Throttle up |
| CTRL (hold) | Throttle down |
| W / S or arrows | Pitch |
| A / D or arrows | Yaw |
| Q / E | Roll |
| X | Separate spent stage |
| P | SAS autopilot |
| V | Flip SAS prograde / retrograde |
| [ and ] | Time warp x1 / x2 / x4 / x8 |
| C | Camera mode (chase / orbit / system) |
| R | Restart |
| Mouse drag | Orbit camera |
| Mouse wheel | Zoom |

## Mission profile

1. Vertical climb to a few hundred km.
2. Gravity turn toward the Moon as shown on the minimap, or press P to let SAS do it.
3. Build apoapsis to, or past, the dashed lunar SOI, then cut the engine and coast.
4. At encounter, flip with V + P and burn retrograde to drop perilune to the surface.
5. Final descent under 32 m/s, dropping each spent stage with X along the way.

## Architecture

`index.html` hosts the canvas and importmap; `css/style.css` styles the HUD.

- `js/constants.js` — world and vehicle specs.
- `js/physics.js` — two-body simulation, staging, trajectory predictor.
- `js/camera.js` — chase, orbit, and system cameras.
- `js/hud.js` — telemetry, flight computer, minimap, throttle gauge.
- `js/world.js` — planet, Moon, sky gradient, weather cloud decks, sun-tracking shadows, launch pad.
- `js/vehicle.js` — rocket stages and their meshes.
- `js/textures.js` — generated planet surfaces, cloud decks, and flame glow.
- `js/audio.js` — engine and ambience audio.
- `js/main.js` — loop, input handling, and the debug API at `window.game`.
