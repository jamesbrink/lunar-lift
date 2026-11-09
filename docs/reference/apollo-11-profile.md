# Apollo 11 flight profile — the acceptance target

Every row is NASA SP-4029 *Apollo by the Numbers* (Apollo 11 phase tables), converted with
`1 ft = 0.3048 m`, `1 nmi = 1.852 km`, `1 psf = 47.88026 Pa`. Velocities in those tables are
**space-fixed** (inertial), not ground-relative. GET = ground elapsed time.

This is the yardstick the game is built against: a completed LUNAR LIFT mission should look
like these numbers, phase by phase.

## Ascent (`Apollo_11d_Ascent_Phase.htm`)

| Event | GET | Altitude | Space-fixed speed | Flight-path angle | Heading (°E of N) |
| --- | --- | --- | --- | --- | --- |
| Liftoff | 00:00:00.63 | 0.06 km | **408.6 m/s** | 0.06° | 90.00 |
| Mach 1 | 00:01:06.3 | 7.84 km | — see note | — | — |
| Max-q 735.17 psf = **35.20 kPa** | 00:01:23.0 | 13.57 km | — see note | 29.23° | 82.41 |
| S-IC CECO | 00:02:15.2 | 44.01 km | 1,979.0 m/s | 22.957° | 76.315 |
| S-IC OECO (burn 168.03 s) | 00:02:41.63 | **66.10 km** | **2,764.1 m/s** | 19.114° | 75.439 |
| S-IC/S-II separation | 00:02:42.30 | 66.71 km | 2,773.9 m/s | 19.020° | — |
| S-II CECO | 00:07:40.62 | 180.14 km | 5,707.5 m/s | 0.897° | — |
| S-II OECO (burn 384.22 s) | 00:09:08.22 | 187.28 km | 6,916.2 m/s | 0.619° | — |
| S-II/S-IVB separation | 00:09:09.00 | 187.34 km | 6,919.0 m/s | 0.611° | — |
| S-IVB first cutoff (burn 147.13 s) | 00:11:39.33 | 191.13 km | 7,791.4 m/s | 0.011° | 88.414 |
| **Earth orbit insertion** | 00:11:49.33 | 191.08 km | **7,793.4 m/s** | 0.012° | 88.848 |

Liftoff position: geocentric 28.4470° N, 80.6041° W. EOI position: 32.5027° N, 52.6491° W.

**Note on the two low-altitude rows.** The velocities published for Mach 1 and for max-q
cannot be reconciled with either the tabulated altitudes or the tabulated dynamic pressure
(`q = 35.20 kPa` at `ρ(13.57 km) = 0.243 kg/m³` implies 539 m/s, not the printed value). The
state rows that orbital mechanics independently confirms — S-IC OECO, S-II OECO, EOI — are
used throughout these docs; the low-altitude rows are quoted only for `q`, altitude, and the
flight-path angle. See `tools/mission-math.py` §8.

Cross-checks that *do* close:

- 7,793.4 m/s at 191.08 km vs circular speed there **7,793.8 m/s** — insertion was to 0.005 %.
- 100.4 × 98.9 nmi parking ellipse → period **88.04 min** computed, **88.18 min** tabulated.
- Liftoff speed 408.6 m/s = the Earth-rotation credit at that latitude exactly.

## Earth orbit and trans-lunar injection (`Apollo_11e_Earth_Orbit_Phase.htm`)

| Event | GET | Value |
| --- | --- | --- |
| Earth orbit insertion | 00:11:49.33 | apoapsis 100.4 nmi (185.9 km), periapsis 98.9 nmi (183.2 km) |
| Orbit | — | period **88.18 min**, inclination **32.521°** |
| S-IVB second burn ignition | 02:44:16.20 | 25,560.2 ft/s (7,790.7 m/s) |
| S-IVB second burn cutoff (346.83 s) | 02:50:03.03 | 35,568.3 ft/s (**10,841.2 m/s**), **Δv 10,008.1 ft/s = 3,050.5 m/s** |
| State 10 s after TLI | 02:50:13 | 180.58 nmi (334.4 km), 35,545.6 ft/s, FPA **7.367°**, heading 60.073°E of N, inclination 31.386° |

That post-TLI state is an Earth orbit of `a = 264,549 km`, `e = 0.9751`, perigee 6,594 km,
apogee **522,505 km** — far beyond the Moon, which is what makes the coast 73 h instead of
the minimum-energy 120 h. Computed in `tools/mission-math.py` §4.

## Translunar coast (`Apollo_11f_Translunar_Phase.htm`)

| Event | GET | Value |
| --- | --- | --- |
| Midcourse correction | 26:44:58 | at 109,475 nmi (202,748 km), 5,025 ft/s (1,532 m/s), FPA 77.05° |
| Lunar orbit ignition | 75:49:50 | coast duration ~73 h from TLI |

## Lunar orbit (`Apollo_11g_Lunar_Orbit_Phase.htm`)

| Event | GET | Value |
| --- | --- | --- |
| **LOI burn** | 75:49:50 → 75:55:47 (357.53 s) | 8,250 → 5,479.0 ft/s, **Δv 2,917.5 ft/s = 889.3 m/s**, altitude 160.6 → 111.3 km |
| Resulting orbit | — | **169.7 × 60.0 nmi** (314.2 × 111.1 km) |
| Circularisation | 80:11:36 → 80:11:53 | 5,477.3 → 5,338.3 ft/s, **Δv 158.8 ft/s = 48.4 m/s**, at 114.4 km |
| Descent orbit insertion (LM) | 101:36:14 → 101:36:44 | **Δv 136.2 ft/s = 41.5 m/s** at 104.4 km |
| **Powered descent initiation** | 102:33:05 | 11.9 km altitude, **1,696.2 m/s** |
| LM engine cutoff (descent) | +756.39 s | touchdown; SP-4029 leaves this Δv cell blank — the derived figure is **~2,300 m/s**, see [mission-design.md](mission-design.md) |
| **LM lunar ascent** | 124:22:00 → 124:29:15 (434.88 s) | **Δv 6,070.1 ft/s = 1,850.3 m/s**, to 10 × 48 nmi (18.5 × 88.9 km) |
| Rendezvous and docking | 127:04 | with the CSM in ~120 nmi orbit |

Still un-fetched from SP-4029 (marked as gaps rather than guesses): the transearth phase
(`Apollo_11h_Transearth_Phase.htm`) — TEI Δv and re-entry velocity. The round-trip budget in
[mission-design.md](mission-design.md) uses an estimated TEI of ~1,100 m/s for that reason.

## What the game must reproduce

| Phase | Apollo 11 | Game target (`js/physics.js`, `LAND_SAFE`) |
| --- | --- | --- |
| Parking orbit | 186–191 km, 7.79 km/s | reach periapsis ≥ 130 km (game's atmosphere-free ceiling) with 7.5–7.9 km/s |
| TLI | Δv 3,050 m/s, 73 h coast | Hohmann-class 3,140 m/s, ~120 h coast (warp provided up to ×1000) |
| Arrival | v_inf ≈ 0.83 km/s | same order; capture burn must be planned, not reflexive |
| LOI | Δv 889 m/s to 111 × 314 km | 800–900 m/s at 111 km periselene |
| Descent | PDI at 11.9 km / 1,696 m/s, ~757 s to touchdown, ≤ 32 m/s vertical | `LAND_SAFE = 0.032 km/s` at contact |
| Ascent off the Moon | 1,850 m/s to 18.5 × 89 km | available if the vehicle keeps 1,900 m/s of propellant after landing |

The whole one-way sequence needs **15,142 m/s** of ideal Δv; where that number comes from
and what the game's stacks actually carry is
[mission-design.md](mission-design.md).
