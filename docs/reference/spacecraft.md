# Spacecraft — Saturn V, CSM, LM, and the game's vehicle

All masses from NASA SP-4029 *Apollo by the Numbers*, Apollo 11 **ground ignition weights**
table (pounds mass, converted at 0.45359237 kg/lbm). "Ground ignition" is the state at
T−6.4 s, engines running but held down — the vehicle is already consuming propellant when
the range clock reads zero, so stage masses at liftoff are marginally lower than tabulated.

## Apollo 11 ignition weights

| Item | Dry (t) | Oxidiser (t) | Fuel (t) | Total (t) |
| --- | --- | --- | --- | --- |
| S-IC first stage | 130.43 | 1,499.58 | 646.32 | **2,278.73** |
| S-IC/S-II interstage | 5.21 | — | — | 5.21 |
| S-II second stage | 36.16 | 371.51 | 71.72 | **479.97** |
| S-II/S-IVB interstage | 3.66 | — | — | 3.66 |
| S-IVB third stage | 11.27 | 87.32 | 19.78 | **119.12** |
| Instrument unit | 1.94 | — | — | 1.94 |
| Lunar Module + launch adapter | 15.09 (LM) | — | — | 1.79 (LA) |
| Command/Service Module | 28.80 | — | — | 28.80 |
| Launch escape system | — | — | — | 4.04 |
| Boilerplates, ballast, crew, ordnance etc. | — | — | — | ~3.3 |
| **Launch vehicle total** | | | | **2,938.26** |

Propellant by stage: S-IC 2,145.8 t, S-II 443.2 t, S-IVB 107.1 t — 2,696.1 t of the 2,938.3 t
at ignition, **91.8 %** of the vehicle. The payload to lunar orbit (CSM + LM) was 43.9 t,
1.5 % of liftoff mass.

Apollo 15–17 (J-class) differences: LM 36,238 lb (16.43 t), CSM 66,925–66,949 lb
(30.4 t), vehicle total ≈ 6,529,784 lb (2,961.8 t).

## Engines

| | **F-1** (S-IC, ×5) | **J-2** (S-II ×5, S-IVB ×1) | **DPS** (LM descent) | **SPS** (SM, LOI/TEI) |
| --- | --- | --- | --- | --- |
| propellants | RP-1 / LOX | LH2 / LOX | Aerozine-50 / NTO | Aerozine-50 / NTO |
| thrust, sea level | 6,770 kN | 486 kN | — (vacuum only) | — |
| thrust, vacuum | 7,774 kN | 1,023 kN (1,033 kN per Wikipedia) | 45.04 kN | ~99 kN |
| Isp, sea level | 265.4 s | — | — | — |
| Isp, vacuum | 304.1 s | up to 425 s (**421 s used here**) | 311 s (published) | 314 s (published) |
| chamber | 1,125 psia (7.76 MPa) | 787 psia (5.43 MPa) | 125 psia | 100 psia |
| mixture ratio O/F | 2.27 | 4.5–5.5 | 1.6 | 1.59 |
| propellant flow | 2,624 kg/s (5,785 lb/s) | 247 kg/s | 14.8 kg/s at full (derived: F/Isp) | 31.6 kg/s (derived: 11.3 t in the 357 s LOI burn) |
| burn time | 165 s (Apollo 11: 168.03 s) | up to 500 s (A11 S-II: 384.22 s) | 756 s Apollo 11 descent | 357 s LOI |
| engine mass | 8,391 kg | 1,578 kg | 179 kg | ~116 kg |
| nozzle expansion ε | 16 | 27.5 | — | — |
| restartable | no | yes (S-IVB fired twice: orbit then TLI) | no (once) | yes (4 flights) |
| throttle | fixed | 50–100 % | **1,050–10,125 lbf (10–100 %)**, 65–92.5 % avoided for nozzle erosion | on/off |

Cross-check by `F = ṁ·ve`, which is the identity the game's engine model uses:

| Stage | ṁ from masses | ve at Isp | F computed | F tabulated |
| --- | --- | --- | --- | --- |
| S-IC (5× F-1) | 12.77 t/s | 257.7 m/s @263 s | 32.96 MN | 33.85 MN SL |
| S-II (5× J-2) | 1.153 t/s | 4,129 m/s @421 s | 4.76 MN | 5.12 MN vac |
| S-IVB (1× J-2) | 0.217 t/s | 4,129 m/s | 0.90 MN | 1.023 MN vac |

Both come out a few percent under the published thrust because the Isp values used
(263 s, 421 s) are deliberately the conservative ends of the published ranges.

## Propellants, and a volume cross-check

Reference bulk densities (bolometric/boiling values in common use): LOX 1,141 kg/m³,
RP-1 ≈ 810 kg/m³, LH2 70.85 kg/m³, NTO ≈ 1,450 kg/m³, Aerozine-50 ≈ 870 kg/m³.
Hydrogen is 16× less dense than RP-1 per unit mass while its Isp is 1.6× better: that is
the entire reason the upper stages are hydrogen and the first is kerosene.

Filling the SP-4029 masses into those densities reproduces the stages' actual sizes, which
is a strong independent check on both:

| Stage | ox (t) | fuel (t) | O/F | volume (m³) | stage envelope |
| --- | --- | --- | --- | --- | --- |
| S-IC | 1,499.6 | 646.3 | 2.32 | 1,314 + 798 = **2,112** | Ø10.0 m × 24.8 m |
| S-II | 371.5 | 71.7 | 5.18 | 326 + 1,012 = **1,338** | Ø10.0 m × 15.6 m (1,225 m³ shell) |
| S-IVB | 87.3 | 19.8 | 4.41 | 76 + 279 = **356** | Ø6.6 m × 17.8 m |

S-IC and S-IVB land inside their envelopes with room for the common bulkheads; the S-II
comes out ~9 % over its geometric shell, which is expected because its hydrogen tank
extends into the interstage skirt. Ratios O/F match the engine specs (2.27 / 4.5–5.5).

## Command and Service Module, Lunar Module

| Item | Mass | Notes |
| --- | --- | --- |
| CSM (Apollo 11) | 28.80 t at ignition | command module ~6.0 t (published figure), remainder service module |
| LM (Apollo 11) | 15.09 t | descent/ascent split not given in the fetched table |
| LM (extended, Apollo 15–17) | 16.43 t gross | ascent stage 4,700 lb empty + 5,200 lb propellant + 600 lb RCS; descent stage 6,100 lb empty + 19,500 lb propellant (sums to 36,100 lb) — enginehistory ALS-09 |
| Launch escape system | 4.04 t | jettisoned ~3 min 25 s after liftoff (published) |
| LM descent-stage Δv capability | **3,202 m/s** | `ve(311 s)·ln((19,500 + 10,500)/10,500)` — the descent engine lifting the fully loaded ascent stage; the ~2,300 m/s descent fits inside it |
| LOI propellant | ~11.3 t | derived: 889 m/s at Isp 314 s on the ~45 t CSM+LM stack, over the tabulated 357 s burn |

## The game's vehicle

`js/constants.js` models one stack of three stages plus a capsule; `SPECS` entries are
`{dry, fuel}` in tonnes, `thrust` in kN, `isp` in seconds.

| | dry / fuel (t) | thrust (kN) | Isp (s) | real counterpart |
| --- | --- | --- | --- | --- |
| `S-1 SATURN I` | 130 / 1,800 | 46,000 | 304 | S-IC: 130.4 / 2,145.8, 33,850 kN SL, 265–304 s |
| `S-2 SATURN II` | 90 / 1,200 | 16,000 | 415 | S-II: 36.2 / 443.2, 5,115 kN vac, 421 s |
| `CSM ENGINE` | 18 / 185 | 400 | 420 | neither: SPS 99 kN/314 s and DPS 45 kN/311 s in one, doing TLI, LOI, deorbit and descent |
| `CAPSULE_MASS` | 10 | — | — | CM 5.97 t + LM 15.1 t = 21 t in reality |

`tools/mission-math.py` §6 turns those numbers into the mission budget, and
`tools/mission-sim.mjs` flies each of them through the game's own physics:

| stack | ignition mass | stage Δv (m/s) | TWR | burn times | ideal total | vs 15,142 m/s requirement | flown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **shipped `SPECS`** | 3,433 t | 2,215 / 6,518 / 8,357 | 1.37 / 1.09 / 0.19 | 117 / 305 / 1,905 s | **17,090 m/s** | 1.13× | **WON**, 3.3 m/s, 7.2 t spare |
| previous (`retro`) | 3,780 t | 2,599 / 2,737 / 10,967 | 1.24 / 0.98 / 0.71 | 135 / 194 / 549 s | 16,303 m/s | 1.08× | LOST — 1,264 m/s impact, tank dry |
| NOVA candidate | 5,475 t | 2,569 / 4,304 / 13,734 | 1.30 / 0.96 / 0.83 | 139 / 288 / 526 s | 20,608 m/s | 1.36× | not flown |

NOVA candidate = `S-1 130/3000/70000/330`, `S-2 110/1500/22000/430`, `CSM 25/700/6000/460`.

Honest caveats about this mapping, to keep the docs from overselling realism:

- **Stage 1 Isp is the F-1 *vacuum* value (304 s) applied from sea level.** Real F-1 climbs
  265 → 304 s as ambient pressure falls, so the game *overstates* stage-1 Δv by up to 528 m/s
  (the §3 bracket: 3,380 m/s at sea-level Isp against 3,908 m/s at vacuum Isp) and the shipped
  1.13× margin partly rests on that generosity. Altitude-dependent Isp
  (`Isp = Isp_sea + (pe/pa − 1)·Ae/ṁ·g0`) would be the physically honest fix, and needs only an
  exit-pressure constant.
- **The old stage-1 number was 263 s**, close to the real sea-level value — and the old stack still
  made orbit. The change to 304 s is not what rescued the mission; the propellant loads and stage 2
  (12,000 → 16,000 kN, 340 → 415 s) were.
- **Upper-stage TWR is not a failure condition in vacuum**, but stage 3 now spans both regimes:
  0.19 g on Earth, 4.2 g_moon at the 59 t LOI mass, 7.0 g_moon at the 35 t landing mass, and
  1,905 s of full-throttle burn available. Hovering the lander takes 15% throttle. See
  [mission-design.md](mission-design.md) for why that is survivable.
- **Stage 2's `dry: 90` t is 2.5× the real S-II** and `fuel: 1,200` t is 2.7× — the game's stack is
  heavier and thirstier than Apollo's, which is what the 3,433 t ignition mass buys. Real hardware
  gets to orbit with 2,938 t; the game needs its extra mass because the descent has to be paid for
  out of the same three stages, and because the autopilot is not as good at steering as the Apollo
  guidance computer.
- `CD_AREA = 28 m²` is the stack's nose-on drag area below Mach 0.8 — an axial coefficient of 0.357
  on the 10 m body. The rest of the airframe's behaviour in air (drag rise, lift, fins, static margin,
  the 0.5 g side-load limit and its strain rule) is in [atmosphere.md](atmosphere.md). The model is statically stable with
  its fins; **the real Saturn V was not**, and flew on engine gimbal.
- The mass and aerodynamic geometry (`GEOM` in `js/stations.js`) is the drawn vehicle's: S-1 42 m long
  and 10 m across, S-2 26 m, CSM body and adapter 22 m at 6.2 m across, command module 8.4 m — 99 m
  from tail to apex, in build units of 1.4 m. These are the game's proportions, not Apollo's.

## Sources

- SP-4029 ground ignition weights:
  `https://www.history.navy.mil/content/dam/museums/Seafaring/OPECD/Ed%20Web%20Site/Apollo/Apollo%20by%20the%20Numbers/Apollo_18-19_Ground_Ignition_Weights.htm`
- F-1: `http://enginehistory.org/Rockets/RPE08.11/RPE08.11.shtml`
- J-2: `http://enginehistory.org/Rockets/RPE08.22/RPE08.22.shtml`
- LM particulars: `https://www.enginehistory.org/Rockets/RPE09.40/RPE09.40.shtml`
- DPS throttle range and engine mass: `https://en.wikipedia.org/wiki/Descent_Propulsion_System`
- LM descent/ascent Isp, SPS thrust and Isp: published values (311 s / 314 s, 99 kN) —
  **not** re-verified against a fetched table here; treat as reference-quality, not quoted.
- All accessed 2026-11-08.
