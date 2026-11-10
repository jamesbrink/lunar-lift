# Atmosphere

Three things are described here: the **U.S. Standard Atmosphere 1976** (what reality does,
to 86 km) with the **MSISE-90** mean-solar-activity extension above it; the game's
single-exponential density — including how far off it is; and the **flight model** in
`js/aero.js` that turns that density into force and torque on the vehicle.

Definitions: geopotential altitude `h`, temperature `T`, pressure `p`, density `ρ`.
`g₀ = 9.80665 m/s²`, `R = 287.0528731 J/(kg·K)` (dry air), `M = 28.9644 kg/kmol` to 86 km.

## USSA-1976 layer definitions

| Layer | Base h (km) | T base (K) | p base (Pa) | Lapse rate L (K/km) |
| --- | --- | --- | --- | --- |
| 1 troposphere | 0 | 288.15 | 101 325.0 | −6.5 |
| 2 tropopause | 11 | 216.65 | 22 632.0 | 0.0 |
| 3 | 20 | 216.65 | 5 474.89 | +1.0 |
| 4 | 32 | 228.65 | 868.02 | +2.8 |
| 5 | 47 | 270.65 | 110.91 | 0.0 |
| 6 | 51 | 270.65 | 66.939 | −2.8 |
| 7 | 71 | 214.65 | 3.9564 | −2.0 |

Within a layer with lapse rate `L` (in K/m):

```
T = T_b + L·(h − h_b)
p = p_b · (T/T_b)^(−g₀/(R·L))          a = a_b · (T/T_b)^(g₀·M/(R₀·L))
```

and with `L = 0`: `p = p_b · exp(−g₀(h − h_b)/(R·T_b))`. Then `ρ = p/(R·T)`.
`tools/mission-math.py::rho_usa` implements exactly this, and matches the published table:
0 km 1.225, 8 km 0.525168, 20 km 0.0880349, 50 km 9.77525e-4, 80 km 1.57005e-5 kg/m³.

## 0–86 km, SI

| h (km) | T (K) | p (Pa) | ρ (kg/m³) |
| --- | --- | --- | --- |
| −1 | 294.65 | 1.13929e5 | 1.34700 |
| 0 | 288.15 | 1.01325e5 | 1.22500 |
| 5 | 255.65 | 5.40199e4 | 7.36116e-1 |
| 10 | 223.15 | 2.64363e4 | 4.12707e-1 |
| 11 | 216.65 | 2.26320e4 | 3.63924e-1 |
| 20 | 216.65 | 5.47489e3 | 8.80349e-2 |
| 32 | 228.65 | 8.68020e2 | 1.32295e-2 |
| 47 | 270.65 | 1.10910e2 | 1.42784e-3 |
| 51 | 270.65 | 6.69390e1 | 8.62505e-4 |
| 60 | 245.45 | 2.03143e1 | 2.88321e-4 |
| 71 | 214.65 | 3.95640 | 6.42137e-5 |
| 80 | 196.65 | 8.86280e-1 | 1.57005e-5 |
| 86 | 186.87 | 3.73384e-1 | 5.704e-6 |

Mean molecular weight falls above ~86 km (28.95 → 26 by 120 km) as the gas separates;
that is why the 1976 table stops there and a different model takes over.

## Above 86 km — MSISE-90, mean solar activity

| h (km) | T (K) | ρ (kg/m³) | local scale height (km) |
| --- | --- | --- | --- |
| 100 | 184.0 | 5.08e-7 | 5.9 |
| 120 | 375.0 | 1.80e-8 | — |
| 150 | — | 1.73e-9 | 25.5 |
| 200 | 931.3 | 2.41e-10 | 37.5 |
| 250 | — | 5.97e-11 | 44.8 |
| 300 | 1005.0 | 1.87e-11 | 50.3 |
| 400 | 1011.0 | 2.62e-12 | 58.2 |
| 600 | 1011.5 | 9.89e-14 | 74.8 |

`tools/mission-math.py` uses exactly these rows as its `UPPER` anchors, so the comparison
table below and the in-game model proposed at the end are the same numbers.
Temperature in the thermosphere runs 200–1500 K depending on solar activity; density at a
given altitude varies by ~10× between solar minimum and maximum. Low-LEO decay is therefore
the least predictable number in this file — and the least relevant to a mission that burns
for the Moon.

## Drag

```
F_d = ½ ρ v² C_d A          a_d = F_d / m          q = ½ ρ v²
```

`v` is speed **relative to the air**, which rotates with the planet — `js/physics.js` uses
the ground-relative velocity for the aerodynamic force and the inertial velocity for
everything else, which is correct. Units in the repo:
`a (km/s²) = ½·ρ(kg/m³)·A_cd(m²)·v(km/s)² / mass(t)`. That is the nose-on, subsonic case of
what the game now computes; the full model is the next section.

Apollo 11's max-q is tabulated as **735.17 psf = 35.20 kPa**. At `ρ(13.57 km) = 0.243 kg/m³`
that implies `v = 539 m/s`. (The ascent table's own velocity entry for that event cannot be
reconciled with this `q` and altitude, so the game docs quote `q` only; see
[apollo-11-profile.md](apollo-11-profile.md).) The game's SAS ascent, measured: max-q
**25.4 kPa** at T+65 s, 10.9 km, Mach 1.3; Mach 1 at T+56 s and 7.65 km, where Apollo 11
passed it at 7.84 km.

Drag area of the stack. The game's `CD_AREA = 28 m²` is the full stack nose-on below Mach 0.8.
On the vehicle `js/physics.js` describes (`GEOM`: 10.0 m across, reference area
π·5.0² = 78.5 m²) that is an axial coefficient of **0.357**. This section used to call 28 m²
"about twice Apollo's" by taking a 6.6 m base → 34 m² → C_d·A ≈ 12–15 m²; 6.6 m is the
S-IVB's diameter, not the S-IC's ([spacecraft.md](spacecraft.md) has both at Ø10.0 m for the
lower stages), so that comparison was wrong and 28 m² is the ordinary number for a 10 m body
with C_d ≈ 0.36. The 0.35–0.45 range for a slender launcher's subsonic C_d is a textbook
figure with no source fetched here. Bound on what axial drag can cost (from
`tools/mission-math.py` §8, USSA density, `v < 550 m/s` below 20 km, `m > 2000 t`):

| C_d·A | peak drag deceleration | max drag loss in the dense air |
| --- | --- | --- |
| 12 m² (the old, mistaken Apollo figure) | 0.39 m/s² | ≤ 47 m/s |
| 28 m² | 0.91 m/s² | ≤ 109 m/s |
| 28 m² × the 1.6 transonic peak, held throughout | 1.45 m/s² | ≤ 174 m/s |

Measured on the shipped SAS ascent, summing `q · CD_AREA · machDrag(M) · cos²α / m` over every
0.1 s step until S-2 burnout (a headless script on the shipped modules, not a tool in
`tools/`): **23.8 m/s** of drag loss, peak deceleration 0.45 m/s². The same path at a constant
`CD_AREA` would have lost 18.8 m/s, so the Mach rise and the angle of attack together are
worth 5 m/s. Either way drag is a rounding error next to gravity loss (~1.0–1.5 km/s); it
matters for *feeling* — and, since the flight model, for which way the nose wants to point.

## The flight model (`js/aero.js`)

`js/aero.js`'s header is the source of truth; this is the same content with the numbers
filled in. One call, `aeroForce(out, vrel, alt, axis, shape)`, returns the whole aerodynamic
force for a body with nose vector `axis` at angle of attack `α` to the airflow. `accelAt` in
`js/physics.js` puts that force into the trajectory, and `physStep` builds the torque from the
record the same call leaves in `aeroState` — one evaluation, so path and attitude cannot
disagree about the air.

| Term | Form | Coefficient | Acts at |
| --- | --- | --- | --- |
| axial drag | `q · CA·A_ref · f(M) · cos α·|cos α|` along the body axis | `CA·A_ref = CD_AREA = 28 m²` for the stack (`CA` = 0.357 on 78.5 m²); `CA = 1.1` for the capsule alone, a blunt body | — (through the axis) |
| drag rise | multiplier `f(M)` on the axial term | 1 below Mach 0.8, smooth to **1.6 at Mach 1.1**, relaxing to 0.9 by Mach 5 and beyond | — |
| body lift | `q · CN_BODY · A_ref · sin α·|cos α|`, normal to the axis | `CN_BODY = 2` per radian (slender-body theory's value) | planform centroid |
| cross-flow drag | `q · CD_CROSS · A_plan · sin² α`, normal to the axis | `CD_CROSS = 1.2`, a cylinder broadside; `A_plan` = 853 m² for the full stack | planform centroid |
| fins | `q · CN_FIN · A_fin · sin α·|cos α|`, normal to the axis | `CN_FIN = 3` per radian on `FIN_AREA = 20 m²`; gone with the S-1 | station −38 u, 5.6 m ahead of the tail |
| pitch damping | rate decays at `q · CN_BODY · J / (V · I)` per second | `J` is the planform's second moment about the centre of mass, `I` the pitch inertia, `V = max(30, 300·M)` m/s | — |

"Lift" is not a separate term: it is the component of the normal force perpendicular to the
airflow. Speed of sound is 340 m/s at sea level falling linearly to 295 m/s at 11 km and held
there. Debris and anything else without an attitude gets plain `CD_AREA · f(M)` drag.

**Torque and stability.** The normal force's moment is taken about the *live* centre of mass,
from the same `GEOM` table (segment lengths, radii and stations, as `js/saturn.js` draws them)
that the moment of inertia comes from, so stability moves as the tanks drain. `stability()`
returns the small-angle static margin — how far the centre of pressure sits behind the centre
of mass. Measured along the SAS ascent:

| MET s | altitude km | q kPa | Mach | α | side load g | static margin m |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (pad) | 0.1 | 0 | 0 | — | 0 | **+4.4** |
| 20 | 0.9 | 4.0 | 0.25 | 0.2° | 0.000 | +6.1 |
| 40 | 3.7 | 15.5 | 0.61 | 0.3° | 0.001 | +8.0 |
| 60 | 9.0 | 25.0 | 1.13 | 1.5° | 0.007 | +10.5 |
| 80 | 17.7 | 21.6 | 1.80 | 4.6° | 0.024 | +13.7 |
| 100 | 30.6 | 10.3 | 2.64 | 5.8° | 0.018 | +17.9 |
| 120 (S-1 gone at 117) | 48.9 | 2.2 | 3.59 | 7.2° | 0.004 | **−7.2** |
| 140 | 69.4 | 0.2 | 3.70 | 9.5° | 0.001 | −7.0 |

The stack with its fins is stable and gets more so as the S-1 empties from the tail; with SAS
switched off at T+60 s and no input, the angle of attack falls from 1.5° to 0.1° in 20 s on
its own. Without the S-1 the margin is negative, but only where q is already a tenth of its
peak and falling by a factor of ten every 20 s. Peak side load on the whole ascent: **0.024 g**
at T+85.4 s, 20.6 km, Mach 2.0, 5.0° off the airflow, q 18.9 kPa.

**Breakup.** The normal force is carried by the airframe as a side load,
`(N_body + N_fin) / m` in g, against `LOAD_LIMIT_STACK = 0.5` g for the stack and
`LOAD_LIMIT_CSM = 6` g for the CSM flying alone. Both limits are gameplay values, not structural
data. Crossing one is no longer instant death: `overstressed()` in `js/physics.js` accumulates
**strain**. Over the limit it grows at `(load/limit − 1)` per second; under it, it relaxes at
0.5 per second; the airframe goes at 0.6 (`AERODYNAMIC BREAKUP`) — 1.5× the limit held for 1.2 s,
2× for 0.6 s — and at once above 3× the limit. Measured by switching SAS off and holding full
pitch from a given moment of the nominal ascent:

| pitch held from | outcome | seconds over 0.5 g | peak side load |
| --- | --- | --- | --- |
| T+40 s | **breakup** at T+81.9 s, Mach 0.8, 48° — after a tumble back into dense air | 4.4 | 0.89 g |
| T+50 s | **breakup** at T+58.2 s, Mach 0.9, 63° | 2.6 | 0.69 g |
| T+60 s (through max-q) | **breakup** at T+66.9 s, Mach 1.3, 56° | 2.2 | 0.75 g |
| T+70 s | **breakup** at T+76.4 s, Mach 1.6, 57° | 2.1 | 0.76 g |
| T+80 s | **breakup** at T+86.5 s, Mach 1.9, 65° | 2.3 | 0.72 g |
| T+90 s | survives, strain peaked at 59 % of failure | 3.4 | 0.58 g |
| T+100 s | survives, never over the limit | 0 | 0.41 g |

And what the strain rule buys — pitch held from T+60 s for a few seconds, then SAS switched back on:

| pitch held for | peak angle of attack | peak side load | seconds over 0.5 g | peak strain (1 = lost) | outcome |
| --- | --- | --- | --- | --- | --- |
| 3 s | 22° | 0.23 g | 0 | 0 | survives |
| 4 s | 32° | 0.39 g | 0 | 0 | survives |
| 5 s | 41° | 0.55 g | 0.8 | 0.09 | survives |
| 6 s | 50° | 0.68 g | 2.3 | 0.77 | survives |
| held | 56° | 0.75 g | 2.2 | 1 | breakup at 6.9 s |

So an excursion to 40° at max-q is a warning and one to 50° is the last one you get. With the
instant rule that preceded this the T+60 s case broke at T+64.8 s, the moment the load crossed
0.5 g. Why 0.5 g and not more: the limit was 1.2 g for one commit, and a vehicle pitched
broadside through max-q flew on at 0.93 g, because fully broadside at 25 kPa the cross-flow term
is 1.2 × 853 m² × 25 kPa = 25.6 MN on the 2,430 t the stack weighs by then, about 1.07 g
(computed from the coefficients, not a run) — the airframe could barely reach its own limit.
The angular acceleration the moment can produce is clamped at ±2 rad/s², and the torque and
damping are skipped below q = 0.5 Pa.

**The capsule alone.** With every stage gone the shape is the command module: `CA = 1.1` on its
own 12.1 m², and a 3 m² normal-force area at the apex — ahead of the centre of mass — standing in
for a blunt cone's tendency to fly heat-shield-first. Its heating proxy, parachutes and the
measured entries are in [mission-design.md](mission-design.md) under "Coming home".

**Vacuum.** Above `ATMO_TOP = 420 km` density is exactly zero and none of this runs. The only
rate damping left is the **RCS stability assist** (key T, on by default: 0.6 /s on pitch and
yaw rates, 0.25 /s on roll). With it off a rotation persists until something cancels it.

**What is deliberately not modelled**, from the module's own header:

- Slender-body theory puts a body's lift on the *nose*, well ahead of the planform centroid.
  That is why the real Saturn V was statically unstable through max-q and flew on engine
  gimbal. Lumping the lift at the centroid makes this vehicle **more stable than Apollo's** —
  it weathervanes where the real one would have diverged.
- Heating is a proxy with a threshold (see "Coming home" in mission-design.md), not a thermal
  model; no ablation, and no compressibility beyond the drag rise: Mach number changes
  axial drag only, never the normal-force coefficients or the centre of pressure.
- The coefficients are textbook orders of magnitude, not wind-tunnel data, and the fin area is
  an effective planform chosen for the model, not a measurement of the drawn fins.
- No wind, no gusts, no axial or max-q structural limit, no roll aerodynamics.

## The game's density model, and its error

```js
export const ATMO_TOP = 420;
export function airDensity(alt) { return alt > ATMO_TOP ? 0 : RHO0 * Math.exp(-Math.max(0, alt) / ATMO_H); }
```

`RHO0 = 1.225`, `ATMO_H = 8.5` km — a single scale height (the fact sheet's own summary
number) all the way to a hard cut at 420 km. Ratio **game / real**:

| alt km | game ρ | real ρ | ratio |
| --- | --- | --- | --- |
| 0 | 1.225 | 1.225 | 1.00 |
| 7.84 | 4.870e-1 | 5.351e-1 | 0.91 |
| 11 | 3.358e-1 | 3.639e-1 | 0.92 |
| 13.57 | 2.482e-1 | 2.427e-1 | 1.02 |
| 20 | 1.165e-1 | 8.803e-2 | 1.32 |
| 32 | 2.839e-2 | 1.323e-2 | 2.15 |
| 47 | 4.861e-3 | 1.428e-3 | 3.41 |
| 66.1 | 5.139e-4 | 1.285e-4 | 4.00 |
| 86 | 4.944e-5 | 5.704e-6 | 8.67 |
| 100 | 9.523e-6 | 5.08e-7 | 18.7 |
| 120 | 9.056e-7 | 1.80e-8 | 50.3 |
| 150 | 2.655e-8 | 1.73e-9 | 15.3 |
| 200 | 7.404e-11 | 2.41e-10 | 0.31 |
| 300 | 5.756e-16 | 1.87e-11 | 3.1e-5 |

Read it as three regimes:

1. **0–14 km: right.** Within 10 %, because sea-level scale height really is 8.4–8.5 km.
   Max-q and the whole first minute of flight are modelled correctly.
2. **20–160 km: too dense**, by 1.3× at 20 km, 4× at 66 km (S-IC burnout), 19× at 100 km,
   50× at 120 km. A vehicle coasting at 120 km decays ~50× faster than it should; stage-1
   coast drag losses are inflated (worth tens of m/s, not hundreds).
3. **above ~180 km: too thin**, by up to 4 orders of magnitude, then hard zero at 420 km.
   Real 400 km orbits decay measurably; in the game they are perfect.

The reason is structural: scale height grows with temperature, 8.4 km at sea level → 5.9 km
at 100 km → 58 km at 400 km, so one exponential cannot fit a profile whose exponent changes
by 7×.

## Recommendation

Replace `airDensity` with the layer model plus a log-linear upper tail — ~25 lines, no data
files, monotone, and exact against the tables:

```js
// USSA-1976: [base km, T K, p Pa, lapse K/km]; above 86 km: log-linear MSISE-90 mean anchors
const LAYERS = [[0, 288.15, 101325, -6.5], [11, 216.65, 22632, 0], [20, 216.65, 5474.89, 1],
                [32, 228.65, 868.02, 2.8], [47, 270.65, 110.91, 0], [51, 270.65, 66.939, -2.8],
                [71, 214.65, 3.9564, -2]];
const UPPER = [[86, 5.704e-6], [100, 5.08e-7], [120, 1.80e-8], [150, 1.73e-9],
               [200, 2.41e-10], [300, 1.87e-11], [400, 2.62e-12], [600, 9.89e-14]];
```

Re-measure the ascent after the swap — drag loss (23.8 m/s now, so there are not tens of m/s
left to drop), max-q, the side-load table above, and the launch window, which is solved for
the forces as they are — and leave `CD_AREA` as the gameplay knob. `soundSpeed()` in
`js/aero.js` should move to the layer temperatures at the same time. The visual weather in `js/clouds.js` stays
cosmetic; weather is not simulated.

## Constants for the game, restated

| Constant | Value | Source |
| --- | --- | --- |
| sea-level density | 1.225 kg/m³ | USSA-1976 (fact sheet says 1.217 for the real atmosphere's mean) |
| sea-level pressure | 101 325 Pa | USSA-1976 (fact sheet: 1014 mb) |
| `C_d·A`, nose-on, subsonic | 28 m² (game) = 0.357 × 78.5 m² | game value; no Apollo figure fetched |
| side-load limit | 0.5 g stack, 6 g bare CSM; failure at 0.6 of accumulated strain or 3× the limit | gameplay choice; nominal ascent peaks at 0.024 g |
| crew limit | 16 g for 2 s | gameplay choice; survivable entries measured up to 14.7 g |
| heat limit | `sqrt(ρ)·v³` > 4 for 3 s without a heat shield forward | gameplay choice; 8.9 at a 7.8 km/s entry, 33.7 at 11 km/s (measured) |
| parachutes | drogues 30 m², tear 20 kPa or Mach 1.5; mains 2,300 m², tear 4 kPa or Mach 0.5; either lost in entry heat | gameplay choice; 7.8 m/s under mains (measured) |
| Kármán line | 100 km | convention only; no physical discontinuity |
| max-q | 35.2 kPa (Apollo 11), 25.4 kPa (game, measured) | SP-4029; SAS ascent |
