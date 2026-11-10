# Earth

Values from the NASA planetary fact sheet
(<https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html>), accessed 2026-11-08.

## Gravitational and physical

| Quantity | Value | Game constant |
| --- | --- | --- |
| GM | 0.39860 × 10⁶ km³/s² | `MU_E = 398600.4418` |
| equatorial radius | 6378.137 km | — |
| polar radius | 6356.752 km | — |
| mean (volumetric) radius | 6371.000 km | `RE = 6371` |
| mass | 5.9722 × 10²⁴ kg | — |
| density | 5.515 g/cm³ | — |
| gravity, equator | 9.780 m/s² | — |
| gravity, pole | 9.832 m/s² | — |
| gravity, mean | 9.820 m/s² | `MU_E/RE² = 9.820` ✓ |
| escape velocity | 11.186 km/s | `sqrt(2·GM/RE) = 11.186` ✓ |
| J2 | 1082.63 × 10⁻⁶ | not modelled |
| flattening `f` | 1 − 6356.752/6378.137 = 0.0033528 | used for lat conversion |
| sidereal rotation period | 23.9345 h | `EARTH_SPIN = 7.292115e-5 rad/s` ✓ |
| obliquity to ecliptic | 23.44° | see moon.md |
| geometric albedo / Bond albedo | 0.367 / 0.294 | — |
| solar irradiance at 1 AU | 1361 W/m² | sun.md |

Earth's GM implies a mass parameter consistent with the tabulated mass:
`GM = 6.674e-20 km³/(kg·s²) × 5.9722e24 kg = 398 600 km³/s²`.

## Derived orbit table (`tools/mission-math.py` §1)

| Altitude | Circular speed | Period |
| --- | --- | --- |
| 0 km | 7909.8 m/s | 84.35 min |
| 100 km | 7848.4 m/s | 86.34 min |
| **185 km** | **7797.4 m/s** | **88.05 min** |
| 191 km (Apollo 11 EOI) | 7793.8 m/s | 88.17 min |
| 400 km | 7672.6 m/s | 92.41 min |
| 1000 km | 7353.7 m/s | 104.97 min |

Escape speed at 100 km: 11 099 m/s. Surface gravity from GM/R²: 9.820 m/s² — the game's
`g` at the pad is therefore already right without a hard-coded 9.81.

## Shape: sphere, not ellipsoid

`js/physics.js` treats Earth as a sphere of radius 6371 km and ignores J2. Consequences:

- **Latitude mapping.** A point drawn at *geodetic* latitude 28.6084° N (real LC-39A)
  sits at *geocentric* latitude
  `atan((1−f)² · tan 28.6084°) = 28.4469°`.
  SP-4029 lists Apollo 11 liftoff at geocentric **28.4470° N, 80.6041° W** — identical.
  A spherical planet must use the **geocentric** value, and the repo ships it:
  `PAD_LAT = 28.4469`, `PAD_LON = -80.6041` (`js/constants.js`). An earlier pair
  (`28.4961, -80.6194`) matched neither frame: the pad landed ~1.9 km off and the
  rotation credit was wrong by ~1 m/s. See [launch-site.md](launch-site.md).
- **Gravity error from J2** is ≤0.005 m/s² (0.05 %) at the surface, decaying as (RE/r)³·J2.
  Irrelevant against the game's 32 m/s landing tolerance; the 6 km radius difference
  between equator and pole matters more for the pad's altitude, and the sphere splits
  the difference.
- **Ground track.** Real ground tracks drift because the planet rotates under an
  inclined orbit; the game reproduces this correctly by integrating in an inertial
  frame with the pad welded to the rotating sphere.

## Atmosphere

Surface pressure 1014 mb, surface density 1.217 kg/m³, scale height 8.5 km, mean
molecular weight 28.97. Full layer table, the drag equation, and the error in the
game's single-exponential model: [atmosphere.md](atmosphere.md).

## Moon and Sun as third bodies

The Moon's GM is 1.23 % of Earth's; at the Moon's distance it is not negligible and
`js/physics.js` integrates it explicitly rather than switching patched conics. The Sun
contributes 6.0 × 10⁻⁴ of the Earth's gravity *at Earth* and is only used for lighting
(see [sun.md](sun.md)); its tidal term across the Earth–Moon distance is ~0.5 % of the
Moon's pull at the Moon, below the game's tolerance.
