# Moon

Values from the NASA planetary fact sheet
(<https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html>), accessed 2026-11-08.

## Gravitational and physical

| Quantity | Value | Game constant |
| --- | --- | --- |
| GM | 0.00490 × 10⁶ km³/s² | `MU_M = 4904.8695` (fine-grid value; fact sheet rounds to 4900) |
| equatorial radius | 1738.1 km | — |
| polar radius | 1736.0 km | — |
| mean radius | 1737.4 km | `RM = 1737.4` |
| mass | 0.07346 × 10²⁴ kg | — |
| mass ratio Moon/Earth | 0.012300 | used for SOI |
| density | 3.344 g/cm³ | — |
| surface gravity | 1.62 m/s² | `MU_M/RM² = 1.624` ✓ |
| escape velocity | 2.38 km/s | `sqrt(2·GM/RM) = 2375.7 m/s` ✓ |
| J2 | 202.7 × 10⁻⁶ | not modelled |
| Bond albedo | 0.11 | — |
| surface temperature | 95–390 K | — |
| atmosphere | ≈ 25 000 kg total, effectively vacuum | **no drag in lunar flight** |

## Orbit

| Quantity | Value | Game constant |
| --- | --- | --- |
| semi-major axis | 0.3844 × 10⁶ km | `MOON_DIST = 384400` |
| perigee / apogee | 0.3633 × 10⁶ / 0.4055 × 10⁶ km | not modelled (game orbit is circular) |
| eccentricity | 0.0549 | not modelled |
| sidereal period | 27.3217 d | `MOON_RATE = 2.6617e-6 rad/s` ✓ (= 2π/2 360 590 s) |
| synodic period | 29.53 d | — |
| mean orbital speed | 1.022 km/s (actual 0.966–1.100) | `sqrt(GM_E/a) = 1018.3 m/s` ✓ |
| inclination to ecliptic | 5.145° | — |
| inclination to Earth's equator | **18.28° – 28.58°** (18.6-yr node cycle) | game fixes 28.5° — the favourable extreme |
| obliquity to its orbit | 6.68° | lunar north pole tilt for texturing |

The equatorial inclination swings between 18.28° and 28.58° as the nodes regress with an
18.6-year period. `js/constants.js` builds the Moon's orbit in a plane tilted 28.5° to the
equator with its node aligned to the launch azimuth — the textbook "direct-plane" launch
window, where the whole mission stays in one plane. That is a *choice*, not the state of
the real Moon on any given date; measured against the real ephemeris it is a good one.

## Sphere of influence

```
r_SOI ≈ a · (m/M)^(2/5) = 384 400 · (0.012300)^0.4 = 66 184 km
```

Game: `SOI_M = 66200` km — same number, rounded. Inside that radius the vehicle's
guidance/HUD switches to Moon-relative state; the *force* model never switches, it always
sums Earth + Moon gravity, so there is no energy discontinuity at the boundary.

## Lunar orbits (`tools/mission-math.py` §1)

| Altitude | Circular speed | Period |
| --- | --- | --- |
| 15 km | 1672.7 m/s | 109.71 min |
| 60 km | 1651.6 m/s | 113.97 min |
| 100 km | 1633.5 m/s | 117.79 min |
| 185 km | 1597.0 m/s | 126.06 min |

Apollo 11's post-LOI orbit was 169.7 × 60.0 nmi (314 × 111 km), circularised to ~200 km
(108 nmi) — matches the 110–126 min period band. A 15 km circular orbit is the practical
floor: low lunar orbits are unstable to mascons over long periods, irrelevant for a
single descent but a reason not to loiter at 15 km.

## Real ephemeris check (astronomy-engine, verified 2026-11-08)

Sampled hourly for 30 days from 2026-11-08 14:00 UTC:

- geocentric distance **359 300 – 405 600 km** — brackets the fact-sheet perigee/apogee ✓
- best-fit orbital plane normal over 1 month in J2000 equatorial: `(0.0512, 0.4612, −0.8858)`,
  i.e. **27.6° from the equatorial pole** — inside the 18.28–28.58° envelope ✓, and
  within 1° of the game's 28.5° assumption
- maximum out-of-plane deviation over the month: 656 km (0.17 % of distance) — the
  coplanar approximation is good for a 5-day transfer
- planar radius median 379 000 km, spread 88 000 km over the month (the eccentricity)

The game's parametric Moon is therefore accurate to a few percent in distance and ~1° in
inclination for the dates checked, and the phase is a free parameter anyway. See
[libraries.md](libraries.md) for what swapping in `astronomy-engine.GeoVector(Body.Moon, …)` would
take. That has not been done: nothing in the game imports the library, and the check above was a
one-off script outside the repo.

## Frame mapping, J2000 → game

`astronomy-engine` returns geocentric vectors in the **J2000 mean equator/equinox** frame
(X toward the March equinox, Z toward J2000 north, right-handed). The game frame is
right-handed with **Y = north pole** and X in the equatorial plane at MET 0 (Greenwich
meridian). A proper rotation that maps north to north:

```
game (x, y, z) = (Jx, Jz, −Jy)      det = +1  (verified, not a mirror)
```

If the game's Z axis is instead pinned to the launch site's meridian, compose with a
rotation about Y by the Greenwich apparent sidereal time at mission start
(`SiderealTime(startDate) · 15 °/h`).
