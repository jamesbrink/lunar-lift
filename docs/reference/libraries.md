# Libraries: what was surveyed, what gets used

Two separate questions came up while building the physics:

1. Should a JavaScript **orbital-mechanics / astrodynamics** library replace
   `js/physics.js`? **No.**
2. Should an **ephemeris** library drive the real Moon and Sun? **Not so far.**
   `astronomy-engine` was evaluated and would fit, but it is **not used**: nothing in
   `index.html`'s importmap or `js/` imports it, the Moon is the parametric circular orbit in
   `js/constants.js` (`moonPos` / `moonVel`), and the sun is a fixed inertial bearing in
   `js/world.js`.

## 1. Orbital-mechanics libraries: none worth adopting

Surveyed 2026-11-08 (npm search on `orbital mechanics`, `astrodynamics`, `propagator`,
`two-body`, `kepler`):

| Package | State | Verdict |
| --- | --- | --- |
| `orbjs` | last published ~11 years ago; two-body Kepler only, no perturbation, no propagation with thrust | unusable for a powered trajectory |
| `orbital-mechanics-kit`, `orbital-engine` | small/unmaintained, thin wrappers over vis-viva and element conversion | reinvents the eight formulas in [orbital-mechanics.md](orbital-mechanics.md) |
| `openunits` and similar unit packages | trivial | the repo's unit convention is one comment in `constants.js` |
| serious astrodynamics software | Python (`poliastro`, `skyfield`, NASA's GMAT/MONTE), Java (`Orekit`), C (`SPICE` toolkits) | not embeddable in a zero-dependency browser game; SPICE kernels alone are hundreds of MB |

The structural reason a propagator library does not help: this is not a two-body problem. The
vehicle thrusts, sheds stages, feels drag from a co-rotating atmosphere, and must be advanced
in 0.1 s steps in lockstep with the render loop and the player's throttle input. Library
propagators solve *unpowered* conics (universal-variable or Kalman-style state transitions)
between two points — precisely the case the game spends most of its time *not* in. The
numerical integrator already in `js/physics.js` is 20 lines, symplectic, and validated
against the Apollo 11 profile; the formulas it depends on are documented in
[orbital-mechanics.md](orbital-mechanics.md), which is the thing a library would otherwise
have supplied.

What was taken from the survey instead: the vocabulary and the checks. Specifics adopted —
element-from-state conversion for the HUD (`a`, `e`, `i`, ap/pe), the patched-conic framing
for the transfer and capture budgets, and the SOI criterion `r = a(m/M)^0.4`, which
reproduces the game's hand-set `SOI_M = 66 200` km as **66 184 km**.

## 2. `astronomy-engine`: evaluated, not adopted

`astronomy-engine` (MIT, v2.1.19, no dependencies, Don Cross) covers exactly the piece the
game cannot compute for itself: where the Moon and Sun actually are, and how the Earth has
turned. What follows is the evaluation and a plan. None of it is in the game.

| Fact | Value |
| --- | --- |
| licence | MIT |
| dependencies | none |
| CJS entry | `./astronomy.js` |
| ESM entry | `./esm/astronomy.js` (412 KB uncompressed) |
| browser build | `astronomy.browser.min.js` |
| typings | `astronomy.d.ts` |
| delivery | would come from a CDN through the existing `importmap`, as three.js does; no npm install, keeping the game's zero-build-run setup |

API verified on 2026-11-08 with a one-off script, `/tmp/lltest/ephem.mjs`, which is not in the repo:

| Call | What it gives | Verified against |
| --- | --- | --- |
| `GeoVector(Body.Moon, date, true)` | geocentric Moon position, AU, J2000 mean equator/equinox | 30-day min/max **359,300 / 405,600 km** vs fact sheet perigee/apogee 363,300 / 405,500 km ✓ |
| `GeoVector(Body.Sun, date, true)` | geocentric Sun direction (lighting, terminator) | apparent diameter and season consistency ✓ |
| `SiderealTime(date)` | Greenwich **apparent** sidereal time, hours | 2026-11-08T14:00Z → 17.18494 h; 2026-03-20T12:00Z → 23.86905 h (consistent with the March equinox hours later plus equation of time) ✓ |
| `Observer`, `Horizon` | topocentric rise/set, azimuth/altitude | not used yet; useful for a launch-window HUD |
| `MoonPhase(date)` | phase angle | naming trap: there is **no** `Phase` export — the first attempt failed on it |

Derived from the same samples: best-fit lunar plane normal over 30 days
`(0.0512, 0.4612, −0.8858)` in J2000 = **27.6° from the equatorial pole**, inside the real
18.28–28.58° envelope and within 1° of the game's fixed 28.5°; out-of-plane scatter 656 km
over a month. Details in [moon.md](moon.md).

### Integration plan (not carried out)

1. `import { GeoVector, Body, SiderealTime } from 'astronomy-engine'` via the importmap in
   `index.html`.
2. Mission start becomes a real date (`startDate`), defaulting to today.
3. `moonPos(t)` and the Sun direction call `GeoVector` at `startDate + t·s`, converted AU → km
   and J2000 → game frame with

   ```
   game (x, y, z) = (Jx, Jz, −Jy)      det = +1, so Three.js keeps its right-handed system
   ```

   (compose with a rotation about Y by `SiderealTime(startDate)·15°` if the game's X axis is
   pinned to the launch-site meridian rather than to the equinox).
4. `MOON_PHASE0` and `MOON_RATE` stay as the "classic window" mode: the physics harness
   scripts and the existing test expectations depend on the parametric Moon, and a fixed
   window is what makes the mission *teachable*. A toggle in `js/constants.js`
   (`EPHEMERIS = true|false`) is the clean cut-over, not a rewrite.

### The risk it would introduce

The real Moon is eccentric (356,400–406,700 km) and its inclination to the equator is on a
27.6° cycle here, so **some start dates are Δv-infeasible**: a launch into a 28.45° orbit can
meet the Moon only when the Moon is near the equator's plane and at the right phase. That is
real, and it is the interesting part of the design — but a game must not dead-end the player.
Mitigations, in order of preference: pick the start date from the ephemeris (choose the next
favourable window at mission setup), keep Δv margin in the vehicle (the NOVA candidate carries
1.36× the requirement), or offer both modes and let the "real Moon" be the challenge setting.
The parametric Moon stays in the repo either way, because it is what the verification scripts
in `tools/` are calibrated against.

## 3. Everything else

| Need | Choice |
| --- | --- |
| rendering | Three.js `0.187.0` from a CDN importmap — the only runtime dependency of the game |
| textures | vendored in `assets/`, no network fetches at runtime |
| build step | none: `node server.js` serves ES modules with `no-store` headers plus an SSE reload channel |
| verification scripts | plain Node (`/tmp/lltest` harness during development, `tools/` for the committed ones), importing the game's own `js/*.js` — the same code the browser runs |
