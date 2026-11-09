# Working notes for agents in this repo

LUNAR LIFT: a real-scale orbital game — vanilla ES modules, Three.js 0.160.1 from a CDN importmap,
hand-written gravity in `js/physics.js`, no build step, no runtime npm dependencies.

Read this before changing physics, the vehicle, or any number that appears in a doc.

## Run it

```sh
node server.js 8078      # serves ES modules with no-store + SSE hot reload at /__reload
```

Open `http://localhost:8078/index.html`. `window.game` is the debug handle:
`state() ignite stage jettisonLES setSas(on, retro) warp(n) camera(n) ff(seconds) setThrottle(v) nudge(ω)
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

## Renderer rules — each of these was found by measurement, not by reading

- **A custom `ShaderMaterial` must declare `#include <common>` as the first line of its vertex
  shader.** The renderer runs with `logarithmicDepthBuffer: true`, and r160's `logdepthbuf_vertex`
  chunk calls `isPerspectiveMatrix`, which lives in `<common>` and is *not* in `ShaderMaterial`'s
  auto-prefix. So every custom shader also needs `#include <logdepthbuf_pars_vertex>` /
  `<logdepthbuf_vertex>` in the vertex stage and `<logdepthbuf_pars_fragment>` / `<logdepthbuf_fragment>`
  in the fragment stage, or it fails to compile and the object silently disappears.
- **`alphaMap` is sampled from the GREEN channel**, not the alpha channel. Binding a texture whose
  information lives in alpha (the shipped `earth_clouds_1024.png` is one; a hand-generated white
  cloud sheet is another) reads a flat density and lays an opaque tablecloth over the planet. Anything
  whose density is alpha must be bound as `map`.
- **A canvas texture's placeholder must already be the size the paint will be.** `paintedTexture` used
  to allocate a 2×2 canvas and swap in the painted 2048×1024 one with `needsUpdate = true`. WebGL2 gives
  a canvas texture *immutable* storage at its first upload (`texStorage2D`, and r160 only allocates when
  `sourceProperties.__version === undefined`), so every later `texSubImage2D` of the big canvas is a
  silent GL error: the planet sampled one ocean-blue texel forever while `planetCanvas()` — the CPU
  canvas behind it — was perfect, the orbital map drawn from it was perfect, and `needsUpdate` "fixed"
  nothing. Copy into the existing surface (`drawImage`) instead of replacing `texture.image`.
- **Read a cel ramp in the scale three actually samples it.** `gradientmap_pars_fragment` computes
  `coord = dotNL · 0.5 + 0.5`, so an N-texel nearest ramp steps at **N·L = 2k/N − 1**, not at k/N. The
  old three-texel `[0.24, 0.62, 1.0]` stepped at ±1/3, and with the MET-0 sun 38.7° up a flat field sits
  at sin(38.7°) = 0.625 — already in the top band, so the ramp was never what made the field around the
  pad read as a fan of dark wedges. It was `padAuthored` thresholding a 2.2 km noise lattice, sampled by
  a mesh whose vertex spacing grows from 25 m under the vehicle to 3 km at its rim: a per-sample hard
  decision faster than the mesh aliases into straight-edged wedges. `RAMP_EARTH` is four texels with the
  top two equal (steps at −0.5, 0, +0.5 — every step out by the terminator), and a colour source for the
  ground must vary slower than the coarsest vertex on the cap. Check the sun table in
  `docs/reference/launch-site.md` against the boundaries before changing either.
- **A big transparent sheet may not have triangles that span several uv repeats.** Mip derivatives are
  computed per triangle, so a cap cell carrying a coarse tiling picks a different mip level per cell and
  the surface fills with straight-edged wedges of the tile's mip average. The deck avoids it at 390 m per
  texel; the ground shade cannot (a 64 km cap seen from 5 km away minifies hard no matter the texel size),
  so `js/clouds.js` gives the shade its own 64×64 box-filtered copy of the same field with
  `generateMipmaps = false` and keeps its radius to ground that resolves.
- **Weather needs two scales, and they must share a uv field.** A cloud texture wrapped on the planet is
  39 km per texel at 1024×512; the sky from horizon to 30° elevation above the pad spans 0.00017 in u,
  i.e. **0.18 of one texel** — measured, not estimated, and it is why no blend mode, uv fix or row-order
  fix ever put a cumulus overhead. `js/clouds.js` streams a 440 km cap at 7 km altitude with the tile
  repeated across it, and the ground shade is the *same field at the same uv*, offset anti-sunward by deck
  height over tan(elevation): a different scale would put shadows under clear sky. The shade cap gives up
  at 32 km — ground beyond that is a grazing sliver — and samples a box-filtered, mip-free copy of the
  field, because shrinking the radius is what keeps it honest where changing scale would not. Both
  planet-scale decks keep `castShadow = false` — at 2 and 9 km a
  low sun drags their silhouettes hundreds of kilometres, and the ±48 km vehicle-tracking shadow box
  cuts them into slabs that read as architecture. See `docs/reference/painted-planets.md`.
- **A texel-sized caster cannot be filtered by the die.** `BasicShadowMap` compares one depth sample,
  so a 2 m lightning tower inside a ±6 km box at 2048² (5.9 m/texel) rendered its shadow as a black
  staircase. `js/main.js` now uses `PCFShadowMap` with a 4096² map: p90 17.1 ms against 17.9 for
  `PCFSoftShadowMap` over 90 rAF deltas at the pad, and the softer kernel sanded off the edge the drawn
  look wants. Filtering the depth map cannot hurt the cloud shade, because that shade is not a shadow-map
  caster (js/clouds.js projects its own alpha) — the old comment claiming Basic "gives the cloud shadows
  the soft filter blurs away" was never true, which is worth knowing before anyone reverts this to protect
  them. `logarithmicDepthBuffer` is unrelated: the compare uses `vShadowCoord` from the light's projection.
- **A factor written on one component of three is a bug wearing a tuning knob.** `groundHit` bled the
  tangential velocity of deflectate with `keep = 0.12` on `rx` while `ry`/`rz` kept `(1 + out·k)`, so two
  thirds of the deflected flow left the trench at near exhaust speed and every attempt to tune the blast
  cloud's spread "did nothing". When a parameter appears to have no effect, read the arithmetic that
  consumes it before changing its value.
- **A late-bound `onBeforeCompile` uniform never reaches an already-cached program.** Three r160 keys
  the program cache on `onBeforeCompile.toString()`; assigning a texture a second after boot and setting
  `material.needsUpdate` re-fetches the SAME cached program (the function's source didn't change), so
  the injection silently never compiles. Measured with a magenta probe: the whole coast-shelf band
  forced to `0xff00ff` produced not one magenta pixel at 160 km, while `onBeforeCompile.toString()` in
  the page showed the new source. Fix: `material.customProgramCacheKey = () => (bound ? 'on' : 'off')`
  next to the late assignment (js/world.js does this for the coast ink).
- **`logdepthbuf_fragment` is a statement — it belongs inside `void main()`.** With
  `logarithmicDepthBuffer: true` the chunk expands to a live `gl_FragDepthEXT = …;` line, and sitting
  it between the pars include and `main` (as the sky dome did for its whole life) is a fragment-syntax
  error at compile: the boot console read `Shader Error 0 … 'gl_FragDepth' : syntax error` while every
  screenshot kept rendering a world missing exactly one object. After moving it inside main and giving
  the limb shell its missing chunks, a clean boot reports ZERO shader errors (measured over reload).
  Count the console after any custom-shader change; a failed program fails silently in the image.
- **A frame's particles did not all leave at the same instant.** Charging `emitAcc` and spawning the whole
  budget at the current vehicle position put a fresh clump every 16 ms while the vehicle moved 1.9 m on,
  and the ascent trail came out as a ringed fir tree spaced by the frame rate. `spawnPlume` now
  back-projects parcel *c* along the velocity by the slice of `simDt` it represents and starts its age,
  remaining life and heat there.

- **Camera collision is applied twice per frame** — to `desired` and again to the interpolated
  `camPos`. A lerp between two points outside a sphere is a chord, and chords are inside, so before
  this the camera cut 6 019 km through the Earth whenever `reset()`, `teleport()` or `ff()` moved the
  vehicle to the far side. Measured after the fix: the closest the camera gets to the centre during a
  full crossing is `RE + 0.02`, exactly the skin.
- **Pad exhaust is a shape problem before it is a physics problem.** Parcels leave the F-1s at
  ~2.9 km/s, and if the tangential component of the trench hit survives whole, the deflectate paints a
  200 m field of discrete glowing domes around the pad — measured at 264 live parcels with sprites up to
  72 m, which is what "rocket exhaust needs tons of work" was about. Three things fixed it, and none of
  them is the shader: bleed the tangential to 0.12 on Earth (0.8 on the Moon, where nothing bleeds it and
  Apollo's ejecta really did run far), floor a deflected parcel to the smoke band after 0.04 s so the
  young sheet climbing out of the trench keeps its fire while the far field goes grey, and buy density
  from parcel count (900/s on the S-IC, entrainment ceiling 16 m) instead of from sprite size. Frame cost
  after the change, full throttle on the pad with 1 498 live parcels over 120 rAF deltas: median 16.7 ms,
  p90 17.7, p99 18.3.
- **A non-finite value in a vertex colour attribute renders as a black band, and nothing else you do
  will remove it.** A NaN in `attributes.color` propagates through the toon lighting into a NaN fragment,
  so the pixel goes black and ignores material swaps, `castShadow`/`receiveShadow`, `normalScale`,
  visibility and background changes. This cost an hour of elimination before anyone counted NaNs:
  `attributes.color` on the near patch had **10,905 non-finite floats (3,635 vertices)** and the band
  rang the launch complex. Any bake that writes a vertex attribute must reject non-finite output and the
  harness must count non-finite channels and fail on a non-zero count.
- **Sanity-check a normal buffer's distribution, not just its length.** The same patch had
  `normal.y ∈ [0.103, 0.888]` — worst case 84° off vertical — on a coastal plain whose real relief is
  under 4° of slope, because a finite difference mixed units (the patch's positions are in metres while
  the scene is in km). A plain's normals should cluster near the local up vector; assert that.
- **Surfaces are painted from data, not from imagery.** `js/toonmap.js` reads the specular sheet as a
  land mask and the diffuse sheet as a biome signal; no photographic pixel reaches the screen. The
  biome rule keys on red−minus−blue, *not* hue — the shipped diffuse is blue-shifted over land, so the
  Amazon and the Atlantic have the same hue. Details and measurements:
  `docs/reference/painted-planets.md`.
- **One part in eight of pale sky mixed in LINEAR space is a grey poster.** `lerp(black, 0xb2cfe2, 0.125)`
  is sRGB 30 %-grey: the old linear sky-mix clock left the 163 km sky measured flat (69,82,90) with the
  stars faded out — "the sky is grey and muddy" was this one line, not the dome, not the shell. The dome
  and background therefore fall on the QUARTIC of `exp(−alt/80)` (zenith optical depth dies far faster
  than horizon glow, which the shell draws from grazing rays on its own), the fog keeps the un-squared
  clock, and star visibility thresholds on **sRGB lightness**, not the linear buffer. Measured: 68 km
  went (77,91,100) → (33,36,40) with the quartic.
- **Entrainment is air; a growth constant without a density in it is confetti.** The staging burst grew
  its smoke parcels at a flat 14 m/s and bloomed 26 puffs into kilometre-soft bokeh discs against black
  space at 67 km — the reviewer's worst frame. Smoke-parcel growth now multiplies `airDensity(alt)`,
  and the debris trail is gated at ρ > 0.004: the high event is a flash and tumbling metal, the pad
  event keeps its billow, and nothing in vacuum grows at all.
- **Compose tone by MAX, not by product, when many features claim the same vertex.** `moonPatchDetail`
  darkened each vertex by the floor factor of every crater whose rim or spokes reached it — across ~70
  craters the product compounded to black (mean linear 0.004; the surface looked scorched). Taking the
  strongest darkening, lightening and ray per vertex (`1 − 0.42·darkMax + litMax + rayMax`) restored
  mean 0.235. Multiplicative overlays only survive when a vertex meets two or three of them.

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
- `tab.screenshot({silent: true})` returns a **path**; you have to read the file to see the image.
- `(await tab.errors()).entries` is **cumulative across reloads**. Filter on `Date.now() - e.ts < N`
  or you will chase an error the page has already left behind.
- `gl.readPixels` on the game canvas returns all zeros (`preserveDrawingBuffer: false`). It is never
  evidence of anything; take a screenshot instead.
- To isolate one object in the scene, get the scene through the prediction line
  (`(await import('/js/physics.js')).predLine.parent`) and index the spheres by
  `Math.round(o.geometry.parameters.radius)`: Earth 6371, cumulus deck 6373, cirrus deck 6380,
  atmosphere shell 6435, Moon 1737. Hiding one at a time and screenshotting is how the grey-wedge
  artefact turned out to be cloud alpha rather than a shadow.
- **`mesh.visible = false` is not a toggle for anything that re-centres.** `updatePatch` and
  `updateCloudLayer` set `visible = true` on every frame they run (including their early-return path),
  so an A/B that hides a mesh silently un-hides it a frame later. Isolate with
  `mesh.geometry.setDrawRange(0, 0)`, which no update touches, and reload between cases — module state
  like `receiveShadow` survives `reset()` and contaminates the next measurement.
- **The chase camera looks along the vehicle, not at the ground.** Pointing the vehicle at the planet
  centre gives a *limb* view where the surface is a few pixels of mip-blurred mean colour — that is how
  a perfectly painted Earth looked "featureless from orbit" for a whole session. For a nadir view set
  `S.q.setFromUnitVectors(Z, up)` so +Z is local up, and aim at a continent rather than trusting the
  pose to be over land.
- Take the teleport velocity from the sim, not from `EARTH_SPIN × r`: capture `S.v` right after
  `g.reset()` and reuse it, otherwise the vehicle arrives with the wrong ground speed and the frame
  ends in `RE-ENTRY DISASTER` before you can screenshot.
- If the tab answers `Tab "lift" is frozen`, recover with `browser.tab('lift').close()` and reopen it;
  evaluating against it will not wake it.
- Frame cost: sample 90 `requestAnimationFrame` deltas and report median and p90. A hidden tab
  throttles rAF, so keep the tab visible.
- **You can test the camera without the game booting.** `js/camera.js` only needs `S`, so set
  `S.pos`/`S.v` yourself and call `updateCamera(1/60)` in a loop, then assert on `camera.position`.
  Drag input is real pointer events on `#gl` (`movementX/Y` go in the `PointerEvent` constructor; stub
  `HTMLCanvasElement.prototype.setPointerCapture` first or the synthetic `pointerdown` throws). Note
  that the collider reads the Moon at `getSimTime()`, so compare against `moonPos(getSimTime(), …)` —
  comparing against a Moon you advance yourself measures the Moon's motion, not the collision.
- The dev server hot-reloads on every save, so an agent's half-written file reliably breaks the page
  mid-verification. If `window.game` is missing, that is why: the module graph (`SyntaxError` or a
  missing export) is the failure, not the thing you were testing.

## Structure

One concern per file; no god files. Current sizes: `toonmap.js` 1401, `vehicle.js` 1350,
`world.js` 822, `physics.js` 546, `navball.js` 435, `terrain.js` 404, `hud.js` 380,
`clouds.js` 300, `camera.js` 216, `ribbon.js` 198, `textures.js` 231, `main.js` 160,
`toon.js` 139, `constants.js` 119, `targeting.js` 108, `audio.js` 53. `vehicle.js` has grown past
a comfortable size and now clearly holds two concerns — the vehicle meshes and the exhaust/blast
particle field; if the next change to either pushes it higher, split the particle system out the
way `targeting.js` was: a module that owns one question. If a change would push
`physics.js` much past 500, apply the same rule there.

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
