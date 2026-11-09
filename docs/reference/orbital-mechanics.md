# Orbital mechanics as implemented

What `js/physics.js` computes, why, and how each piece is checked. Symbols: `r` position
from a body's centre (km), `v` inertial velocity (km/s), `t` mission-elapsed time (s).

## Units, one more time, because everything depends on it

| Expression | Resulting unit |
| --- | --- |
| `MU / r^2` | km/s² (MU in km³/s²) |
| `thrust(kN) / mass(t)` | m/s² → divided by 1000 in the code |
| `thrust / (isp · 9.81)` | t/s of propellant |
| `½ · rho(kg/m³) · A(m²) · v(km/s)² / mass(t)` | km/s² of drag deceleration |

The code uses `9.81` where the standard is `9.80665` (`js/physics.js:186`). That is a
0.034 % error in exhaust velocity — 3.5 m/s over a 10 km/s mission. Left alone deliberately:
it is inside every other approximation here.

## Gravity

```js
gravityAt(p, out, t)  =  -MU_E·p/|p|³  −  MU_M·(p − moonPos(t))/|p − moonPos(t)|³
```

Both point masses, always, every step. No patched conics in the *forces*: the Moon's pull is
summed in from the pad, where it is 2 × 10⁻⁴ of Earth's. `SOI_M = 66 200 km` is used only to
decide which body the guidance and HUD talk about (`moon-relative` state), never to switch
forces — so nothing discontinuous happens at the boundary, and a trajectory can be integrated
across it with the same integrator.

Not modelled, with the error each omission carries:

| Omitted | Error at the vehicle | Verdict |
| --- | --- | --- |
| Earth J2 | ≤ 0.005 m/s² at the surface, ~10⁻⁶ km/s² in LEO | node drift and apsidal rotation absent; irrelevant on a 6-day mission |
| Moon J2 | ~10⁻⁴ of Moon gravity at 100 km | low lunar orbit instability absent; fine for one descent |
| Sun tide | 3 × 10⁻⁸ km/s² | ~10³ km of along-track drift over a coast; absorbed by phase targeting ([sun.md](sun.md)) |
| Earth oblateness of shape | 21 km between equator and pole radius | pad latitude handling in [launch-site.md](launch-site.md) |

## Integration

Symplectic (semi-implicit) Euler, one place in the code:

```js
const a = accelAt(S.pos, S.v, mass, thrustAcc);
S.v.addScaledVector(a, dt);
S.pos.addScaledVector(S.v, dt);      // position uses the NEW velocity
```

`js/main.js` drives it: `simDt = dtReal · WARP`, split into
`max(1, min(600, ceil(simDt / 0.1)))` substeps, so **h ≤ 0.1 s always** and warp multiplies
the number of physical steps rather than the size of one. Warp is therefore not a time
dilation — the mission clock is real seconds at every warp setting, and ×1000 costs 167
integration steps per frame instead of lying about the physics.

Why this is accurate enough: the orbit period is ~5,300 s, so one orbit is ~53,000 steps.
Symplectic integrators keep the *secular* energy error bounded (it oscillates with the true
anomaly instead of drifting), so a 5-day coast neither leaks energy nor gains it. The
per-step displacement at 185 km periapsis is 0.78 km against r = 6,556 km — 0.012 % of the
radius, and the two-body force is smooth on that scale. The one place h matters is the
atmospheric phase: at 800 m/s and h = 0.1 s, drag changes velocity by ≤ 0.09 m/s per step,
so drag integration is not the limiting error either.

## Orbit elements from the state (what the HUD and predictor show)

```
energy      ε = v²/2 − MU/r                    a = −MU/(2ε)
ecc vector  e = (v×h)/MU − r̂,  h = r × v       e = |e|,  i = acos(h_z/|h|)
apsides     r_ap/pe = a(1 ± e)                  (the HUD's apoapsis/periapsis readouts)
speed       v² = MU(2/r − 1/a)                  ← vis-viva, the workhorse below
```

`predict()` in `js/physics.js` re-integrates the trajectory forward (same force model, plus
the current burn) rather than drawing a conic, so the predicted path bends correctly when the
Moon matters — at the cost of the ellipse-only quantities (ap/pe) being read off the two-body
Earth solution, which is exactly what a real MFD does too.

## The maneuvers, in the order the mission needs them

**Circularise at apoapsis.** From a transfer with apogee `r_a` and perigee `r_p`, at apogee:

```
v_circ = sqrt(MU/r_a)          Δv = v_circ − sqrt(MU(2/r_a − 1/a_transfer))
```

At 185 km the circular speed is **7,797 m/s**, period 88.05 min
([earth.md](earth.md)); Apollo 11's insertion was 7,793.4 m/s at 191 km, 0.005 % off the
target speed.

**Trans-lunar injection.** Burn prograde at perigee until the *target* energy is reached.
Minimum-energy (Hohmann) transfer to the Moon's distance:

```
a_T = (r_park + 384 400)/2            v_peri = sqrt(MU_E(2/r_park − 1/a_T))
Δv_TLI = v_peri − v_circ = 10 934 − 7 797 = 3 137 m/s          transfer 119.5 h
```

The autopilot's cutoff rule is that vis-viva speed, evaluated with
`a_T = (r + MOON_DIST)/2` at the current radius — no ephemeris needed, and it lands the
apogee on the Moon's orbit by construction.

Apollo flew a hotter burn: 3,050 m/s at 191 km (measured), leaving an Earth orbit with
`a = 264 549 km`, `e = 0.9751`, apogee 522 505 km — reaching the Moon in 73 h instead of
120 h. Both are legitimate; the game's Hohmann targeting is the one that needs the least
guidance sophistication, and warp ×1000 exists precisely to sit through those 5 days.

**Arrival.** At the Moon, the Earth-frame speed of a minimum-energy transfer is 186 m/s
against the Moon's 1,018 m/s, so the craft arrives with **v_inf = 832 m/s**. Falling into the
Moon converts that to

```
v_peri(lunar) = sqrt(v_inf² + 2·MU_M/r_p) = 2 449 m/s at 111 km
Δv_LOI = 2 449 − 1 629 (circular at 111 km) = 820 m/s
```

Apollo 11 needed 889 m/s from a faster transfer — the same physics, more energy to shed.
Aim the LOI burn **retrograde at periselene**; burning earlier or later turns a capture into
an escape.

**Descent.** The guidance law the mission simulator flies at the Moon
(`tools/mission-sim.mjs`, the profile verifier — the shipped game leaves this to the player,
with SAS retrograde as the tool):

```
req = v_M²/(2·alt_M) + MU_M/r_M²          throttle = clamp(req / (T/m), 0.05, 1)
```

The first term is the deceleration that would bring the vehicle down along a circular arc of
radius `2·alt_M`; the second is local lunar gravity. At Apollo's powered-descent initiation
(11.9 km, 1,696 m/s) the first term is 121 m/s² against 1.62 m/s² of gravity, so the clamp
saturates at full throttle and the vehicle decelerates hard, the demand collapsing toward
pure hover thrust as `v → 0`. Touchdown counts as a win when **total** speed at contact is
under `LAND_SAFE = 0.032 km/s` (32 m/s) — the code uses the magnitude of the velocity vector,
not just the vertical component, so screaming in sideways is as fatal as slamming down.

**Ascent off the Moon.** 1,850 m/s to a 18.5 × 89 km orbit (Apollo 11, measured). Circular
lunar speed at 100 km is 1,633 m/s; gravity loss over a 435 s burn is the difference.

## Gravity turn and the pitch limit

A rocket can only tilt as far as its thrust still holds up what gravity is not already
turning. Along the local vertical, the vehicle needs net downward acceleration `v²/r − g` to
follow a path of radius `r`; when `v²/r < g` the deficit `g − v²/r` must be cancelled by the
*vertical component* of thrust, and with thrust acceleration `t` tilted by `θ` from vertical
that component is `t·cos θ`. So the largest tilt that still flies the required path is

```
t·cos θ = g − v²/r     →     θ_max = acos( clamp( (g − v²/r) / t, 0, 1 ) )
```

`js/constants.js` exposes the steering program as `TURN = { t0: 55, ramp: 190, max: 1.15 }`:
hold vertical for 55 s, then sweep the nose toward `PAD_EAST` over 190 s by up to 1.15 rad,
with the clamp above deciding how much of that the vehicle can actually hold. At the pad,
`g − v²/r = 9.82` and `t = 46 000/3 780 = 12.17 m/s²` → `θ_max = acos(0.807) = 36°` — the
program asks for less, which is right early on; later, when `v²/r` approaches `g`, the clamp
prevents the classic "pull up into the sky" failure and the vehicle naturally flattens into
the gravity turn.

Two rules the SAS must obey, both learned the hard way in this codebase:

- **Every velocity has a frame, and the frame is whichever body is underneath.** `navVel()`
  (physics.js) is inertial near Earth and Moon-relative inside `SOI_M`: the Moon travels at
  1,023 m/s through the game frame, so the velocity a capture or descent burn fights is not the
  inertial one. SAS prograde/retrograde, the navball markers and its ap/pe readouts, and the
  scene's velocity arrow all read `navVel()`. `groundVel()` is the same idea against the surface
  you might hit — co-rotating ground on Earth, travelling Moon on the Moon — and is what the HUD
  speed and the touchdown test use.
- **Plane discipline.** The turn is executed inside the plane spanned by `PAD_UP` and
  `PAD_EAST`, which is the Moon's orbital plane in this game; measured drift of the
  trajectory plane across a full ascent: **0.000°**.

Historic bugs of exactly this kind, so the pattern stays visible: SAS once steered on
ground-relative velocity, which is ~0 at ignition (the pad carries 408.6 m/s) and pulled the
trajectory out of its own launch plane; `impact()` judged touchdown on *inertial* speed, which
no vehicle on the lunar surface can satisfy because the surface itself moves at 1,023 m/s
(`LAND_SAFE` was therefore unreachable and the game could not be won); and the HUD's vertical
speed dotted the velocity against `pos − pos`, i.e. against zero, so it read 0.0 m/s always.

## Mass bookkeeping

```
ṁ = thrust · throttle / (Isp · 9.81)      [t/s]        (code)
m(t) -= ṁ·dt                                            (per stage)
staging:  m -= fuel_remaining + dry_mass                ← not just the dry mass
```

That last line was a bug worth naming: dropping a stage while only subtracting its dry mass
leaves phantom propellant in the vehicle, and every downstream Δv number is then optimistic.
`totalMass()` sums `CAPSULE_MASS` plus each unseparated stage's `dry + fuel`, and the same
mass feeds thrust acceleration, drag, and the inertia tensor — one number, three users.

## Landing and failure conditions

| Condition | Code | Outcome |
| --- | --- | --- |
| Moon contact, speed ≤ 32 m/s | `impact(true)` with `speed ≤ LAND_SAFE` | **win** |
| Moon contact, faster | same | lost |
| Earth contact, speed ≤ 120 m/s | `impact(false)` with `speed ≤ SAFE_EARTH` | "splashdown", lost (the Moon was the target) |
| Earth contact, faster | same | lost |
| Contact test | `|r − moonPos| ≤ RM + RHALF`, `|r| ≤ RE + RHALF` | `RHALF ≈ 52 m` is the vehicle's half-height, so the test is a surface contact, not a point hit |

The Moon-encounter gate (`rM < SOI_M` → switch guidance to Moon-relative) must run **before**
`checkImpact`, otherwise a fast arrival at the surface is reported as impact instead of a
capture attempt.
