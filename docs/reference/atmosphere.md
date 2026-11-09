# Atmosphere

Two models are described here: the **U.S. Standard Atmosphere 1976** (what reality does,
to 86 km) with the **MSISE-90** mean-solar-activity extension above it, and the game's
current single exponential — including how far off it is.

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
the ground-relative velocity for drag and the inertial velocity for everything else, which
is correct. Units in the repo: `a (km/s²) = ½·ρ(kg/m³)·A_cd(m²)·v(km/s)² / mass(t)`.

Apollo 11's max-q is tabulated as **735.17 psf = 35.20 kPa**. At `ρ(13.57 km) = 0.243 kg/m³`
that implies `v = 539 m/s`. (The ascent table's own velocity entry for that event cannot be
reconciled with this `q` and altitude, so the game docs quote `q` only; see
[apollo-11-profile.md](apollo-11-profile.md).)

Drag area of the stack: S-IC base diameter 6.6 m → `A = 34 m²`, but a slender rocket's
`C_d` is base-dominated, ≈ 0.35–0.45 → **C_d·A ≈ 12–15 m²**. The game uses `CD_AREA = 28 m²`,
about twice that, which is a deliberate handle: it makes the gravity turn's early losses
visible on the HUD instead of invisible. Bound on what it can cost (from
`tools/mission-math.py` §8, USSA density, `v < 550 m/s` below 20 km, `m > 2000 t`):

| C_d·A | peak drag deceleration | max drag loss in the dense air |
| --- | --- | --- |
| 12 m² | 0.39 m/s² | ≤ 47 m/s |
| 28 m² | 0.91 m/s² | ≤ 109 m/s |

Either way drag is a rounding error next to gravity loss (~1.0–1.5 km/s); it matters for
*feeling*, not for the Δv budget.

## The game's model, and its error

```js
export function airDensity(alt) { return alt > 420 ? 0 : RHO0 * Math.exp(-Math.max(0, alt) / ATMO_H); }
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

Re-measure the ascent drag loss after the swap (expect the loss to drop by a few tens of
m/s) and leave `CD_AREA` as the gameplay knob. The visual cloud deck in `js/world.js` stays
cosmetic; weather is not simulated.

## Constants for the game, restated

| Constant | Value | Source |
| --- | --- | --- |
| sea-level density | 1.225 kg/m³ | USSA-1976 (fact sheet says 1.217 for the real atmosphere's mean) |
| sea-level pressure | 101 325 Pa | USSA-1976 (fact sheet: 1014 mb) |
| `C_d·A` | 28 m² (game), 12–15 m² (Apollo) | gameplay choice, documented above |
| Kármán line | 100 km | convention only; no physical discontinuity |
| max-q to design against | 35 kPa | Apollo 11 |
