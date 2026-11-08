# LUNAR LIFT

Fly a three-stage rocket — S-1 BOOSTER, S-2 UPPER, CSM ENGINE — off a launch pad on a 1000 km-radius
planet and out to a Moon 12,000 km away. Two-body inverse-square gravity, atmospheric drag, and
staging are simulated, so the flight is a real mission profile: climb, gravity turn, coast, lunar
encounter, and a powered descent. Touch down softer than 32 m/s or you lose the spacecraft. The HUD
carries telemetry, a flight computer (periapsis, apoapsis, range), a green trajectory prediction
line, an Earth-Moon minimap with the lunar sphere of influence drawn as a dashed sphere of about
2,100 km, stage fuel pips, and a center throttle gauge reading percent and engine output in kN. Time
display scales sim seconds so surface gravity reads 9.81 m/s^2 and MET shows mission-realistic
durations.

## Run

Open `index.html` in any modern browser with an internet connection — Three.js loads from a CDN via
an importmap. Or serve the folder and open it locally:

```
python3 -m http.server
```

then visit `http://127.0.0.1:8000/index.html`.

## Controls

| Key | Action |
| --- | --- |
| SPACE | Ignite / flameout |
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
- `js/world.js` — planet, Moon, sky, launch pad.
- `js/vehicle.js` — rocket stages and their meshes.
- `js/textures.js` — generated surface and flame textures.
- `js/audio.js` — engine and ambience audio.
- `js/main.js` — loop, input handling, and the debug API at `window.game`.
