# Working notes for agents in this repo

LUNAR LIFT: a real-scale orbital game — vanilla ES modules, Three.js 0.160.1 from a CDN importmap,
hand-written gravity in `js/physics.js`, no build step, no runtime npm dependencies.

Read this before changing physics, the vehicle, or any number that appears in a doc.

## Run it

```sh
node server.js 8078      # serves ES modules with no-store + SSE hot reload at /__reload
```

Open `http://localhost:8078/index.html`. `window.game` is the debug handle:
`state() ignite stage setSas(on, retro) warp(n) camera(n) ff(seconds) setThrottle(v) nudge(ω)
teleport(pos, vel, simTime) reset()`, plus `_cam`, `_pred`, `setCam(d)`.

## Verify with these, and only these

```sh
npm i --no-save three@0.160.1             # tool only; the game has no dependencies
node tools/mission-sim.mjs                 # solves the launch window then flies it: ~50 s
node tools/mission-sim.mjs game --phase=4.9561012   # the shipped window: ~2 s
python3 tools/mission-math.py              # must exit 0; recomputes the derived numbers in docs/
```

Shipped flight right now: `RESULT WON`, periselene 169 km, LOI 875 m/s at 183 km, touchdown
**20.1 m/s** (`LAND_SAFE` is 32 m/s), 7.6 t spare, 16,226 m/s spent, 3.404 days. `retro` (the previous
stack) is LOST at 5,577 m/s with a dry tank. If you change physics, specs, constants or the launch
window, re-run and fix every number that moved **in the same commit** — `README.md` and
`docs/reference/*.md` quote measured output, and a doc that no run backs is a bug.

`three` must resolve for the tool: `npm i --no-save three@0.160.1`, or the root `node_modules`
symlink to `/tmp/lltest/node_modules`. Ignore the `MODULE_TYPELESS_PACKAGE_JSON` warning; do not add
`"type": "module"` to `package.json` without checking `server.js`. `.gitignore` says `node_modules`
with no trailing slash because that entry is a symlink, and `node_modules/` does not match symlinks.

## Units

km, s, tonnes, kN, everywhere. `thrust / mass` with kN over tonnes is exactly m/s². `GM / r²` with
`GM` in km³/s² and r in km gives km/s². State vectors are km/s; the HUD prints m/s. `simTime` is
real mission seconds — there is no time-scale fudge, and there must never be one.

## Rule: never steer or score with the raw state vector

The Moon moves ~1,023 m/s through the game frame and the Earth's surface moves ~409 m/s under the
pad. Three helpers in `js/physics.js` exist because of this, and every bug in this file's history
came from ignoring them:

- `navVel(out)` — inertial near Earth, Moon-relative inside `SOI_M`. What SAS and the navball steer
  by, and what the orbit plot's arrow and the HUD's Ap/Pe use.
- `groundVel(out)` — velocity relative to the surface of whichever body is underneath. What
  `impact()` compares against `LAND_SAFE`, and what the HUD speed readout shows.
- `bodyUp(out)` — the attitude to hold when the velocity vector has no direction worth steering by.

Concrete failures that actually shipped, each found by measurement rather than reading: touchdown
was scored on inertial `S.v` while the ground moved at 1,023 m/s, so a soft landing was unreadable
and a landed mission looked like a 1,233 m/s win; the HUD's vertical speed was `pos − pos`, always
zero; Ap/Pe mixed a Moon-centred position with inertial velocity and printed `ESCAPE` for a bound
200 km orbit. If a formula combines a position and a velocity, check which frame each is in.

## Rule: the step is part of the trajectory

`js/main.js` splits `frame time × warp` into substeps capped at `DTPHYS = 0.1 s` (at least one, at
most 600). Warp multiplies the **number** of substeps, never the step size, so the trajectory is
identical at ×1 and ×1000. That makes 0.1 s the only step the game can produce, and the translunar
encounter is sensitive enough to notice: stepping the coast at 1 s instead of 0.1 s moves the
periselene by ~870 km, six times the whole launch-window tolerance. `tools/mission-sim.mjs` now
steps at `H` always and says so in its source; anything that certifies a mission must use the same
step. Related: the mission is sensitive to ~135 km of periselene per 1e-3 rad of launch phase, and
`MOON_PHASE0 = 4.9561012` is solved for the current `TURN` table — change the pitch program or the
step and the window constant is wrong.

A corollary for anything that *predicts* the game: reproduce its discretisation. `simTime += dt`,
gravity at the advanced time, `v += a·dt`, `p += v·dt`. `js/targeting.js` does exactly that and
matches the certified flights to under 0.5 km; a converged velocity-Verlet integration of the same
state differs from the ship's real trajectory by ~100 km, which would make the readout lie.

## Harness gotchas (`tools/mission-sim.mjs`)

- It imports the real `js/*.js`. Phases: `ascent → tliwait → tli → mcc → approach → loi →
  orbitCheck → deorbit → toPeri → descend`; the launch phase is found by bisecting the first
  periselene (`probePeri` runs the mission with `capture: false, stopAtPeri: true`).
- `stages[i].dry` is copied at import time by `js/vehicle.js`, and `resetSim()` re-syncs only
  `fuel`. If you override `SPECS`, you MUST write `stages[i].dry` too, or you fly the old airframe.
- `P.setSas(on, retro)` — the second argument is **retrograde**, not "prograde".
- The solid first stage cannot be throttled or shut down (`physStep` forces `targetThrottle = 1`
  while stage 0 is attached and lit), so `engineOn` stays true after a `toggleIgnite()` on the pad.
  To reach a genuine no-thrust state for a test, call `separateStage()`: it clears `engineOn`,
  `targetThrottle` and `throttle`.
- Mid-course correction burns are gated on `fuel > 60 t`. The shipped CSM holds 44.5 t after TLI, so
  for this vehicle the encounter is decided at injection and cannot be repaired afterwards.
- The descent guidance law (`a_cmd = (v_des − v)/τ + dv_des/dt − g_abs + g_moon`, τ = 2.5 s, with the
  altitude-bounded velocity envelope) was tuned by measurement. Simplify it and you get 41 m/s, 62
  m/s or 220 m/s impacts, all of which have been observed. Attitude must be commanded through the
  body-rate in the game's SAS convention; writing `S.q` directly gives `align −0.93` and a crater.
- `airDensity(alt)` returns exactly 0 above 420 km, so coast trajectories are drag-free.

## Browser recipe

The dev server must be running (`node server.js 8000`). With the harness browser:

```js
const tab = browser.open({ name: 'lift', url: 'http://127.0.0.1:8000/index.html' });
await tab.reload({ wait_until: 'networkidle2' });
await tab.evaluate(`(async () => {
  const g = window.game;
  g.ignite(); g.ff(20); g.stage();                      // stage() cuts the engine: throttle really 0
  g.teleport(pos, vel, simTime);                        // time included: the Moon is a function of it
  const T = await import('/js/targeting.js');           // same module instance the game uses
  while (T.aim.status !== 'done') T.updateAim();
})()`);
```

- Read HUD text only after `await new Promise(r => setTimeout(r, 700))`. A hidden tab throttles
  `requestAnimationFrame`, so counting frames or awaiting rAF gives stale text like `0 m/s ground`,
  and long `ff()`-free propagations finish ~10× slower than the 649 frames they take when you drive
  `updateAim()` directly.
- `ff(seconds)` steps the shipped `physStep` at 0.1 s without rendering; it is how a multi-day coast
  is crossed in a test.
- Turn the engine off before teleporting if you are checking an impact speed, or thrust adds to it.
- Cross-check the readout against the tool: `node tools/mission-sim.mjs game --phase=…` records the
  coast-start state (`ev.tliDone`, with millisecond time — rounding it to seconds shifts the Moon by
  ~1 km and the encounter by hundreds), which is exactly what `teleport` wants.

## Structure

One concern per file; no god files. Current sizes: `physics.js` 487, `world.js` 302, `navball.js`
286, `vehicle.js` 234, `hud.js` 215, `main.js` 143, `constants.js` 119, `targeting.js` 108,
`textures.js` 99, `camera.js` 107, `audio.js` 53. If a change would push `physics.js` much past
500, split it the way `targeting.js` was split off — a module that owns one question, exporting one
small state object plus the function that updates it.

`js/constants.js` holds every physical constant and the vehicle `SPECS`, each with the measurement
that justifies it in a comment. `docs/reference/` holds the source-cited external data and the
mission derivation; `docs/reference/README.md` is the index.

## Discipline

- Never commit a number you did not produce by running something, and never commit a spec, plan or
  comment that describes behaviour you have not observed. If a constant changes, re-run the tool and
  correct the prose in the same commit.
- Distinguish what is measured from what is inferred, in code comments and docs alike. Apollo's
  numbers stay labelled as Apollo's.
- Commit in focused steps with messages that state the evidence, not the intent.
