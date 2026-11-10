# LUNAR LIFT — Reference Data

Everything the simulation needs to be *physically honest*, fetched once from primary
sources and distilled here. Code should take its numbers from this folder, and this
folder should cite where each number came from.

All data was retrieved on **2026-11-08**.

## Index

| File | Contents |
| --- | --- |
| [earth.md](earth.md) | Earth GM, radii, mass, gravity, rotation, J2, atmosphere summary |
| [moon.md](moon.md) | Moon GM, radii, orbit elements, inclination geometry, sphere of influence |
| [sun.md](sun.md) | Sun GM, size, luminosity, Earth distance — light and the third gravity well |
| [atmosphere.md](atmosphere.md) | U.S. Standard Atmosphere 1976 layers, density table, drag, max-q, the game's exponential model and its error, and the flight model in `js/aero.js`: drag rise, angle-of-attack forces, static margin, side-load breakup |
| [launch-site.md](launch-site.md) | LC-39A coordinates, geodetic vs geocentric latitude, rotation credit, launch azimuth, launch window |
| [spacecraft.md](spacecraft.md) | Saturn V stage masses, F-1/J-2/DPS/SPS engines, propellants, Apollo 11 spacecraft stack |
| [apollo-11-profile.md](apollo-11-profile.md) | Apollo 11 flight tables: every event, altitude, velocity, Δv — the acceptance target for the game |
| [orbital-mechanics.md](orbital-mechanics.md) | The formulas `js/physics.js` implements: vis-viva, patched conics, SOI, staging Δv accounting, gravity loss |
| [mission-design.md](mission-design.md) | The derived requirement (15.1 km/s one-way), the game's vehicle budgets, guidance loss, validation status |
| [libraries.md](libraries.md) | Survey of JS astro/orbital libraries and the decision: keep our integrator, adopt `astronomy-engine` for ephemerides |
| [painted-planets.md](painted-planets.md) | How the bodies are drawn: land mask from the specular sheet, the biome rule that replaced hue, generated weather, measured cover and boot cost |
| [cartoon-art-direction.md](cartoon-art-direction.md) | The look, as decided after seeing the result: flat cartoon Earth, no normal maps or surface textures, immersion from motion and coherence. Overrides the shading decisions in painted-planets.md |

## Unit conventions (repo-wide)

The simulation works in **km, s, tonnes, kN**.

| Quantity | Unit | Why |
| --- | --- | --- |
| distance | km | Moon distance is 384 400; in metres every number is silly-big |
| time | s | real mission seconds — no `VSCALE`/`TSCALE` fudge anywhere |
| mass | tonne | Saturn V is 2 938.3 t |
| force | kN | `thrust / mass` is then exactly **m/s²** |
| gravity `GM` | km³/s² | `GM / r²` with `r` in km gives **km/s²** |
| velocity | km/s in state vectors, m/s in UI | HUD reads m/s, physics reads km/s |
| angles | rad internally, deg in UI | |

Standard gravity `g₀ = 9.80665 m/s²` converts Isp (s) to exhaust velocity (m/s).
`1 lbm = 0.45359237 kg`, `1 nmi = 1 852 m`, `1 ft = 0.3048 m`, `1 psf = 47.88026 Pa`.

## Reproducing the numbers

`tools/mission-math.py` recomputes every derived table quoted in these docs —
circular and escape speeds, the Apollo 11 Δv audit, the trans-lunar patched-conic
check, the game's vehicle budgets, and the atmosphere comparison.

```
python3 tools/mission-math.py
```

Its inputs are only the primary constants in the fact sheets and the SP-4029 tables,
so a mismatch between script and doc is a bug in one of them.

## Primary sources

| Source | Used for |
| --- | --- |
| <https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html> | Earth constants |
| <https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html> | Moon constants |
| <https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html> | Sun constants |
| NASA SP-4029 *Apollo by the Numbers* — Apollo 11 phase tables (`Apollo_11d_Ascent_Phase.htm`, `Apollo_11e_Earth_Orbit_Phase.htm`, `Apollo_11f_Translunar_Phase.htm`, `Apollo_11g_Lunar_Orbit_Phase.htm`), cross-mission tables (`Apollo_18-20_Ascent_Data.htm`, `Apollo_18-19_Ground_Ignition_Weights.htm`) | every Apollo 11 event time, altitude, velocity, Δv, and stage mass |
| <http://enginehistory.org/Rockets/RPE08.11/RPE08.11.shtml> | F-1 engine specification table |
| <http://enginehistory.org/Rockets/RPE08.22/RPE08.22.shtml> | J-2 engine specification table |
| <https://www.enginehistory.org/Rockets/RPE09.40/RPE09.40.shtml> | Lunar Module particulars (stage masses, propellant loads) |
| <https://en.wikipedia.org/wiki/Descent_Propulsion_System> | DPS throttle range and engine mass |
| <https://en.wikipedia.org/wiki/Kennedy_Space_Center_Launch_Complex_39> | LC-39 coordinates |
| U.S. Standard Atmosphere 1976 (NOAA/NASA/USAF), table as reproduced at <https://cosmic.lbl.gov/SKliewer/Cosmic_Rays/StdAtmos.htm> | atmospheric layer definitions |

Secondary/derived values are labelled as such in each file. Where a number is the
game's own simplification, the file says what the real value is and what error the
simplification buys.
