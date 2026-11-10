# Launch site — LC-39A, Kennedy Space Center

| Quantity | Value | Source |
| --- | --- | --- |
| LC-39 coordinates | 28°36′30.2″ N, 80°36′15.6″ W = **28.608389° N, 80.604333° W** (geodetic, WGS-84) | Wikipedia, Kennedy Space Center Launch Complex 39 |
| Apollo 11 liftoff state | **28.4470° N, 80.6041° W**, geocentric | SP-4029 ascent table |
| Apollo 11 liftoff | 1969-07-16 13:32:00 UTC (09:32 EDT) | NASA mission report |
| pad azimuth | 90.0° (due magnetic-true east downrange) | SP-4029 ascent data |
| flight azimuth | 72.058° | SP-4029 ascent data |
| Earth rotation credit at liftoff | 408.6 m/s space-fixed | SP-4029 (liftoff row: 1,340.7 ft/s) |
| launch inclination achieved | 32.521° | SP-4029 earth-orbit table |

## Geodetic vs geocentric latitude

The planet is an oblate spheroid: `f = 1 − 6356.752/6378.137 = 0.0033528`.
Latitude measured from the **surface normal** (geodetic, what maps and GPS give) differs
from latitude measured from the **centre** (geocentric, what a spherical simulation must
use):

```
tan φ_geo = (1 − f)² · tan φ_geodetic
φ_geodetic 28.6084°  →  φ_geo 28.4469°        (SP-4029's 28.4470 ✓, 0.0001° apart)
```

Longitude is unaffected by the conversion: 80.6041° W in both systems, which is why the
liftoff row's longitude and the pad's mapped longitude agree.

**In the game:** applied —

```js
export const PAD_LAT = 28.4469, PAD_LON = -80.6041;   // geocentric = what a sphere can express
```

The values before this (28.4961, −80.6194) were neither the geodetic nor the geocentric
number: the pad sat 5.5 km north and 1.5 km west of LC-39A. The vehicle, pad mesh and physics
were already mutually consistent (pad welding verified: dot error 0.000000000000000 between
vehicle-up and rotated-pad-up), so the error was purely geographic.

### How well the texture can express a coastline (measured, not assumed)

`assets/earth_atmos_2048.jpg` and its specular companion are 2048 × 1024, so one pixel is
17 km of the surface. Two checks against Natural Earth 110m land polygons:

| question | measurement |
| --- | --- |
| does the geometry mapping `u = (lon+180)/360`, `v = (90−lat)/180` match the sheet? | **IoU 0.954** with zero offset; every non-zero offset is worse (0.879 at ±1.4° of longitude), and a vertical flip scores 0.120. The mapping in `js/constants.js` is exactly right. |
| where is Florida's east coast in the sheet, at the pad's latitude? | land from −82.62° to **−80.68°**, water east of it. The real shore at 28.45° N is about −80.55°, so the sheet's coast is ~0.13° (14 km) inside the real one. |
| is the pad's exact point on land in the sheet? | **No** — geocentric (28.4469, −80.6041), geodetic (28.6084, −80.6043) and the old value all read water, with 41–46 % land inside 20 km. Inland points (Rome, Madrid, Cape Town, São Paulo, the Everglades) read land; every *coastal* probe (Key West, San Diego, Tokyo, Sydney, Cape May) reads water. |

So the 18 km gap between the geodetic and geocentric pad latitude — the whole reason this
section exists — is **smaller than the texture's resolution**: whichever value the code uses, the
pad's pixel falls in the near-shore water of a sheet that cannot draw the 5 km-wide Cape barrier
island at all. The geocentric value is still the right choice, because it is the one that makes
the *physics* come out (408.6 m/s of rotation credit, 28.447° achievable inclination); the
cosmetic residue is a texture limit, and the fix is a higher-resolution sheet, not a coordinate
change. Do not "fix" the longitude to sit on the drawn coastline — that would move the pad off
LC-39 to agree with a 17 km pixel.

## Rotation credit

```
v = 2π R cos φ_geo / T_sidereal = 2π · 6371 · cos 28.4469° / 86164.09 s = 408.6 m/s
```

On a mean-radius sphere at the geocentric latitude this reproduces SP-4029's 408.6 m/s
exactly (equatorial value 464.6 m/s; the ellipsoid's equatorial 465.1 m/s differs by 0.1 %).
Consequences the game must respect:

- The state vector at ignition is **not** zero: the vehicle already moves 408.6 m/s east.
  `js/physics.js` seeds `S.v = PAD_ANGULAR` (the pad's inertial velocity) and the
  `Δv`/`v_inertial` HUD reads it; "prograde" is defined on inertial `v`, never on the
  ground-relative vector, which is ~0 at ignition.
- Atmosphere co-rotation is the other half of the same fact: drag uses ground-relative
  velocity, thrust and gravity use inertial.
- Launching due east costs nothing and buys the whole 408.6 m/s; any azimuth away from east
  trades credit for inclination (`Δv = 408.6·(1 − cos Δaz)` at 5° off east is only 1.6 m/s,
  but the plane change to reach the Moon's orbit can cost far more).

## Why the real flight azimuth was 72.058° and the game's is ~90°

Apollo's 72.058° azimuth aimed the parking orbit at 32.521° inclination, downrange over the
Atlantic, keeping the spent S-IC and S-II impact zones out of land and aligning the orbit
with the Moon's position *at TLI* two and a half hours later. That orbit was 4° higher in
inclination than the launch site's latitude, i.e. the launch was already partly a plane
change.

The game instead pins the Moon's orbit to a plane tilted 28.5° to the equator whose node is
the launch site's east direction (`MOON_U = PAD_EAST` in `js/constants.js`). Launching due
east then gives inclination = φ_geo = **28.447°**, exactly the plane the Moon is in —
no plane change anywhere in the mission, and the whole flight is planar. That is not a
cheat: 28.5° is the *maximum* inclination the real Moon's orbit ever reaches relative to the
equator (18.28–28.58° over 18.6 years), so the game's geometry is the real favourable
window, fixed in time.

## Launch window

For a real ephemeris, the Moon crosses the launch site's orbital plane twice per nodal
cycle. Measured over 30 days from 2026-11-08 (astronomy-engine, `tools/…` notes in
[moon.md](moon.md)): the Moon crosses the game's equatorial-plane target **every ~12.5
days** (observed at +11.29 d and +23.83 d). A game day is a mission of ~6 days (ascent,
73–120 h coast, lunar phase), so roughly every other day is a feasible launch date.
The game exposes this as the free parameter `MOON_PHASE0` (`setMoonPhase`)
rather than as a calendar: the mission clock starts at ignition, and the Moon's phase at
ignition is what determines whether intercept is cheap or impossible.

## Pad geometry in the game

| Quantity | Value | Note |
| --- | --- | --- |
| vehicle visual scale `VS` | 0.0014 km per build unit | 75 units → 105 m tall |
| Saturn V + LES actual height | 110.6 m | published figure, ~5 % taller than the game's stack |
| `PAD_POS` offset | 4 × PAD_SCALE + 37 × VS ≈ 57.4 m | the state point on the pad: deck top 4 u above the datum, vehicle centre 37 u above that; contact itself is `surfaceAlt()`, see [orbital-mechanics.md](orbital-mechanics.md) |
| pad stand height | 4 × VS ≈ 5.6 m | the crawler/pedestal, not the 136 m LUT — the vehicle is welded at its own scale |
| pad tangential speed | `SPIN_AXIS × PAD_POS · EARTH_SPIN` | `PAD_ANGULAR` |
