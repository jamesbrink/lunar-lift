# Sun

Values from the NASA planetary fact sheet
(<https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html>), accessed 2026-11-08.

| Quantity | Value |
| --- | --- |
| GM | 132 712.44 × 10⁶ km³/s² |
| radius | 695 700 km |
| mass | 1.9891 × 10³⁰ kg |
| luminosity | 382.8 × 10²⁴ W |
| effective temperature | 5772 K |
| distance from Earth | 147.1 × 10⁶ – 152.1 × 10⁶ km (perihelion/aphelion) |
| mean Earth distance | 1 AU = 149 597 870.7 km |
| apparent diameter at 1 AU | 1919″ (0.533°) |
| solar irradiance at 1 AU | 1361 W/m² |
| rotation period | 25.38 d equatorial |

## Why the Sun is lighting, not gravity, in this game

Acceleration the Sun raises at the Earth:

```
GM_sun / 1 AU² = 132 712.44e6 / (1.496e8)² = 5.930e-3 m/s²   → 0.060 % of surface g
```

The whole Earth–Moon system free-falls in that field, so only the **tidal difference**
acts in the game's geocentric frame:

```
2 · GM_sun · d / 1 AU³   with d = 384 400 km  →  3.0e-8 km/s²
```

Compare the two forces a spacecraft near the Moon actually feels:

| Force | km/s² | ratio to Moon's pull |
| --- | --- | --- |
| Moon, at 1 837 km from centre | 1.455e-3 | 1 |
| Earth, at the Moon's distance | 2.697e-6 | 1.9e-3 |
| Solar tide across the Earth–Moon system | 3.0e-8 | 2.1e-5 |

The Sun's tidal term is 1.1 % of *Earth's* gravity out at the Moon's distance but only
2 × 10⁻⁵ of the Moon's pull on a descending spacecraft. Integrated over a 5-day coast it
accumulates ~8 m/s and of order 10³ km of along-track displacement — real enough that
Apollo flew midcourse corrections (Apollo 11's at GET 26:44:58, SP-4029 translunar table),
but it is absorbed by solving the launch/Moon phase for intercept, which the game does
anyway.
It is therefore excluded from the dynamics and used only for the sky and the light.

## Use in the game

- **Direction.** The game does not use an ephemeris: `js/world.js` keeps the sun on one fixed
  inertial bearing (`SUN_DIR`, about 37° above the pad's horizon at MET 0) and the planet turns
  under it, which is right for a mission of a few days. If a real direction is ever wanted,
  `GeoVector(Body.Sun, date, true)` from `astronomy-engine` gives the geocentric vector in AU;
  multiply by 149 597 870.7 km and map J2000 → game with the matrix in [moon.md](moon.md).
- **Sun angle drives the sky.** At 1 AU the irradiance is 1361 W/m²; the game's day/night
  terminator, specular highlight on the ocean, and the blue-sky colour (`SKY_DAY`) all key
  off `dot(surfaceNormal, sunDir)` — no inverse-square dimming is needed inside 1.4 million km.
- **Eclipse.** A real Earth shadow on the translunar trajectory matters (Apollo crossed the
  terminator several times) but changes no numbers in the game; the Moon's shadow on Earth
  is likewise cosmetic.
