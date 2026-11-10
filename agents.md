# Working notes for agents in this repo

LUNAR LIFT: a real-scale orbital game — vanilla ES modules, Three.js 0.187.0 from a CDN importmap,
hand-written gravity in `js/physics.js`, no build step, no runtime npm dependencies.

Read this before changing physics, the vehicle, or any number that appears in a doc.

## Run it

```sh
node server.js 8078      # serves ES modules with no-store + SSE hot reload at /__reload
```

Open `http://localhost:8078/index.html`. `window.game` is the debug handle:
`state() ignite stage jettisonLES setSas(on, retro) warp(n) camera(n) ff(seconds) setThrottle(v) nudge(ω)
teleport(pos, vel, simTime) reset()`, plus `_cam`, `_pred`, `setCam(d)`. `state().aero` is
`{ q, mach, aoa, load, margin }` — Pa, –, rad, lateral g, static margin in m.

## Verify with these, and only these

```sh
npm i --no-save three@0.187.0             # tool only; the game has no dependencies
node tools/mission-sim.mjs                 # solves the launch window then flies it: ~50 s
node tools/mission-sim.mjs game --phase=4.9198031   # the shipped window: ~2 s
python3 tools/mission-math.py              # must exit 0; recomputes the derived numbers in docs/
node tools/shader-lint.mjs                 # must print ok; every ShaderMaterial must compile
```

Shipped flight right now: `RESULT WON`, periselene 205 km, LOI 865 m/s at 218 km, touchdown
**4.2 m/s** (`LAND_SAFE` is 32 m/s), 7.4 t spare, 16,245 m/s spent, 3.461 days. `retro` (the previous
stack) is LOST at 1,264 m/s with a dry tank. The window is a cliff on one side: −1e-3 rad of phase
(periselene 334 km) lands at 3.4 m/s with 7.2 t, −3e-3 rad (597 km) still lands at 2.6 m/s, but
+0.75e-3 rad (110 km) and +1e-3 rad (79 km) are **LOST** at 81 and 72 m/s with the tank run down.
Nominal ascent under SAS: max-Q 25.4 kPa at T+65 s, peak side load 0.024 g at T+85 s (limit 0.5 g),
static margin +4.4 m on the pad. If you change physics, specs, constants or the launch
window, re-run and fix every number that moved **in the same commit** — `README.md` and
`docs/reference/*.md` quote measured output, and a doc that no run backs is a bug.

`three` must resolve for the tool: `npm i --no-save three@0.187.0`, or the root `node_modules`
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
periselene by ~790 km (204 km becomes an impact 590 km under the surface, measured from the shipped
coast-start state), nearly twice the width of the whole 140–600 km corridor. `tools/mission-sim.mjs` now
steps at `H` always and says so in its source; anything that certifies a mission must use the same
step. Related: the mission is sensitive to ~130 km of periselene per 1e-3 rad of launch phase, and
`MOON_PHASE0 = 4.9198031` is solved for the current `TURN` table **and the current forces** — change
the pitch program, the step, the drag model or `gravityAt` and the window constant is wrong. The
flight-model commit moved it by 0.036 rad (it was 4.9561012), more than 70 times the 0.5e-3 rad
between the window and the last late flight that lands.

A corollary for anything that *predicts* the game: reproduce its discretisation. `simTime += dt`,
gravity at the advanced time, `v += a·dt`, `p += v·dt`. `js/targeting.js` does exactly that: from the
shipped coast-start state it and a real `physStep` coast both arrive at 204.43 km (run headless), and
it is within ~1 km of the tool's whole-km periselene on all three certified flights. A converged
velocity-Verlet integration of the same state says 299.9 km — 95 km from the ship's real trajectory,
which would make the readout lie.

## Rule: one aerodynamic evaluation feeds both the trajectory and the attitude

`accelAt(p, v, mass, thrustAcc, t, axis)` calls `aeroForce()` in `js/aero.js` once per step. The
force goes into the acceleration; the same call leaves its dynamic pressure, Mach number, angle of
attack and normal-force split in `aeroState`, and `physStep` builds the torque, the pitch damping
and the side-load check from that record. Do not compute a second "aero for rotation" from
`surfaceVel()` or a normalised q — that is what the old weathervane constants were, and a torque
that disagrees with the force it came from flies a vehicle whose nose and path answer to different
air. Corollaries, each read off the code or measured:

- Pass `axis` only for the vehicle. Debris and anything else without an attitude passes `null` and
  gets plain `CD_AREA` drag; it must not overwrite `aeroState`, and with `axis = null` it does not.
- `GEOM` in `js/physics.js` is the single table for mass distribution *and* aerodynamic shape, in
  build units (1 u = 1.4 m) at the stations `js/saturn.js` draws. Move a drawn stage and the centre
  of mass, the planform centroid and the fin arm all move with it; `stability()` returns the result
  as a static margin in metres. Measured: +4.4 m on the pad, +17.9 m at T+100 s as the S-1 drains,
  −7.2 m just after staging (no fins; q is 2.2 kPa by then and the side load stays under 0.004 g).
- The breakup limits (`LOAD_LIMIT_STACK = 0.5` g, `LOAD_LIMIT_CSM = 6` g) are set against the
  measured SAS ascent, whose peak is 0.024 g, **and against what the vehicle can generate at all**.
  The stack limit was 1.2 g for one commit and almost nothing reached it: full pitch held with SAS
  off through max-Q peaked at 0.93 g and flew on, because broadside at 25 kPa this airframe makes
  about 1 g and no more. At 0.5 g the same input from any time between T+40 s and T+90 s breaks up
  5–8 s later (38–57° off the airflow); from T+100 s it peaks at 0.41 g and survives. A limit is
  only a rule if a measured manoeuvre crosses it — change `CD_CROSS`, `GEOM` or the stage masses and
  re-measure both ends.
- The flat rate damping is a control system now (`rcsAssist`, key T, reset to on by `resetSim()`).
  A test that wants free rotation in vacuum must call `toggleRcsAssist()`; a test that assumes rates
  die on their own is testing the assist.

## Harness gotchas (`tools/mission-sim.mjs`)

- It imports the real `js/*.js`. Phases: `ascent → tliwait → tli → mcc → approach → loi →
  orbitCheck → deorbit → toPeri → descend`; the launch phase is found by bisecting the first
  periselene (`probePeri` runs the mission with `capture: false, stopAtPeri: true`).
- `stages[i].dry` is copied at import time by `js/saturn.js`, and `resetSim()` re-syncs only
  `fuel`. If you override `SPECS`, you MUST write `stages[i].dry` too, or you fly the old airframe.
- `P.setSas(on, retro)` — the second argument is **retrograde**, not "prograde".
- The solid first stage cannot be throttled or shut down (`physStep` forces `targetThrottle = 1`
  while stage 0 is attached and lit), so `engineOn` stays true after a `toggleIgnite()` on the pad.
  To reach a genuine no-thrust state for a test, call `separateStage()`: it clears `engineOn`,
  `targetThrottle` and `throttle`.
- Mid-course correction burns are gated on `fuel > 60 t`. The shipped CSM holds 44.7 t after TLI, so
  for this vehicle the encounter is decided at injection and cannot be repaired afterwards.
- The descent guidance law (`a_cmd = (v_des − v)/τ + dv_des/dt − g_abs + g_moon`, τ = 2.5 s, with the
  altitude-bounded velocity envelope) was tuned by measurement. Simplify it and you get 41 m/s, 62
  m/s or 220 m/s impacts, all of which have been observed. Attitude must be commanded through the
  body-rate in the game's SAS convention; writing `S.q` directly gives `align −0.93` and a crater.
- Contact is `surfaceAlt() <= 0`: the lowest attached point (the active stage's bell, or the nose if
  inverted) over the terrain. Headless there is no terrain — `initPhysics` gets no `relief`, so the
  tool lands on the datum sphere, and its touchdown speed says nothing about a hillside. The descent
  guidance reads the same `P.surfaceAlt(true)`; when it read the altitude of `S.pos` instead it met
  the ground believing it had 52 m left, and the shipped touchdown was 20.4 m/s where it is now 4.2.
- The launch-phase solve only looks at the first periselene, so it is blind to anything that happens
  after it. A change to contact, descent guidance or `LAND_SAFE` does not move `MOON_PHASE0`, but it
  can move the corridor's edge onto the window: re-fly the neighbours (`--phase=` ±0.25e-3 … ±3e-3),
  not just the shipped phase.
- `airDensity(alt)` (now in `js/aero.js`, re-exported by `physics.js`) returns exactly 0 above
  `ATMO_TOP = 420` km, so coast trajectories are drag-free.

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
  computed per triangle, so a cell carrying a coarse tiling picks a different mip level per cell and
  the surface fills with straight-edged wedges of the tile's mip average. The weather shell is safe
  because its uv is rebuilt per fragment from the fragment's own position (12.5 km triangles against a
  160 km tile); anything new that tiles across a large mesh has to pass the same test.
- **Weather is one marched shell, and a coverage field must move coverage, not opacity.**
  `js/clouds.js` is a sphere at RE + 11 km whose fragment shader integrates optical depth through a
  4–11 km band; the planet-scale decks and the vehicle-following caps are gone. The macro sheet sets the
  *fraction of sky covered* (a threshold on a rank-uniform lattice); scaling density by it instead gave
  a planet-wide white fog with no edges. Past ~5 lattice texels per pixel the mips average the rank to
  0.5 and the threshold is meaningless, so density falls back to the coverage fraction itself. The shell
  keeps `castShadow = false` — a low sun drags its silhouette hundreds of kilometres through the ±48 km
  shadow box — and ground shade is the same march aimed up the sun ray, injected into the globe and the
  patch. See `docs/reference/painted-planets.md`.
- **The near patch and the globe are one surface and must be shaded as one.** The "giant flat square
  plate around the ship" at full zoom-out was the ±220 km ground patch, not weather, and it showed for
  two reasons, each found by toggling `drawRange` on that one mesh and diffing frames: it took scene
  fog while the globe takes none (90–100 % sky tone at a 400–600 km sight line), and it lacked the
  globe's `emissive: 0x07182c` (17/255 low in blue across its whole footprint). After `js/haze.js`
  on both and the same emissive, the frame difference fell from 23.6 % of pixels to 2.9 %. Any new
  material property on one of the two belongs on the other.
- **A shader bug can take down the GPU process, and the dev server ships it to every open tab.**
  `for (int i = 0; i < N; i)` — no increment — hung the harness browser so hard the tab could not be
  closed, and because every save hot-reloads, the user's own Chrome loaded the same shader and lost
  WebGL for the session (`GL_VENDOR = Disabled`; only a browser restart clears it). Two neighbours of
  that bug render *nothing* with no error at all: `atan2` (not GLSL; fails the link) and an array
  function parameter written through (parameters are `in`; the caller keeps its zeros).
  `tools/shader-lint.mjs` now rejects all three and reads shaders composed from named constants —
  it used to match only an inline template after `vertexShader:` and passed these unread. Run it
  before the page sees a new shader, and recover a hung harness with
  `browser.close({ all: true, kill: true })`.
- **A comment inside a GLSL template literal must not contain a backtick.** It ends the JS string and
  the module stops parsing; the hot-reloaded page then has no `window.game`.
- **A texel-sized caster cannot be filtered by the die.** `BasicShadowMap` compares one depth sample,
  so a 2 m lightning tower inside a ±6 km box at 2048² (5.9 m/texel) rendered its shadow as a black
  staircase. `js/main.js` now uses `PCFShadowMap` with a 4096² map: p90 17.1 ms against 17.9 for
  `PCFSoftShadowMap` over 90 rAF deltas at the pad, and the softer kernel sanded off the edge the drawn
  look wants. Filtering the depth map cannot hurt the cloud shade, because that shade is not a shadow-map
  caster (js/clouds.js marches its own optical depth into the ground materials) — the old comment claiming Basic "gives the cloud shadows
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
- **A dead ShaderMaterial announces itself once, through a channel the harness cannot see.** A failed
  program logs exactly one `console.error` at program build; `tab.errors()` does NOT capture
  `console.error`, so every A/B after the failure measures a world where the object simply is not
  there. When one object draws nothing, install a console hook on a fresh load before touching
  anything else.
- **Whole-frame pixel sandwiches lie here.** Temporal drift — clouds, water glint, living parcels —
  measures 0.016–0.06 RMSE between two idle seconds, larger than some real state diffs. Trust
  spatial compare-masks and the eyes, not frame-mean error.
- **A lunar burn cannot be photographed from inside its own ejecta.** The lunar spray regime
  (`keep 0.45`, `out 0.75`, ×3 advection and life) lofts parcels on ballistic arcs hundreds of
  metres high and wide; measured at a 400 kN pulse at 70 m: 120+ spray/moon-hot parcels alive
  within 500 m of the engine. Any camera closer than ~2 km sits inside the translucent dome and
  every pixel behind it goes flat grey — a dozen "featureless grey" frames cost a full review round
  before `parcelAudit()` proved the spray was there and only the camera was wrong. Shoot lunar
  surface blasts from ≥ 2.8 km, or from behind the spray at horizon distance.

- **Camera collision is applied twice per frame** — to `desired` and again to the interpolated
  `camPos`. A lerp between two points outside a sphere is a chord, and chords are inside, so before
  this the camera cut 6 019 km through the Earth whenever `reset()`, `teleport()` or `ff()` moved the
  vehicle to the far side. Measured after the fix: the closest the camera gets to the centre during a
  full crossing is `RE + 0.02`, exactly the skin.
- **Frame time is not GPU time; the display hides the difference.** Ninety `requestAnimationFrame`
  deltas read 16.7 ms whether the GPU worked for 4 ms or 14, and then jump to 33. Every "frame cost"
  quoted before this note was vsync. Measure with `EXT_disjoint_timer_query_webgl2` around the rAF
  callback (wrap `requestAnimationFrame` from an init script; `gl.getParameter(query, QUERY_RESULT)`
  a few frames later) and at a retina-sized drawing buffer — `tab.emulate({ viewport: { …,
  deviceScaleFactor: 2 } })`. That is how the weather shell (6.7 ms of 13.4 idle) and the exhaust
  sprites (16 ms of 31.6 at full throttle) were found.
- **Soft, fill-bound layers go in the half-resolution pass, and how each is hidden decides how it
  comes back.** `js/halfres.js` draws the weather march and the exhaust points into quarter-pixel
  targets. Same views before and after: 13.4 → 5.9 ms idle, 31.6 → 6.4 ms at full throttle on the pad.
  The weather is marched with no depth at all and put on screen by the shell's own geometry in the
  main pass (a lookup by screen position), so hardware cuts it at full resolution; testing it against
  a low-resolution depth prepass left a one-texel fringe of cloud on every silhouette. The exhaust
  keeps the prepass (smoke is in front of the ship as often as behind) and is skipped when no parcel
  is alive. Remember: a shader in these passes sees pixels twice the size (footprints and point sizes
  scale by `RES_SCALE`); a new opaque mesh must go through `occlude()` or smoke draws over it;
  ordered dither survives the tent as a weave, white noise does not; and the shell's mesh density
  buys nothing — 512 × 256 cost ~1 ms over 192 × 96 for the same picture.
- **A ground colour cannot hold a road; geometry can.** The pad stood on 360 m of terrain painted
  concrete-grey because the patch's vertices are 25 m apart at best. The site is now slabs in
  `js/pad.js` half a metre proud of terrain measured flat to ±0.22 u within 700 u, and the terrain
  under them is grass.
- **Exhaust parcels are only a plume where air holds them together.** Above ~40 km nothing does, they
  separate at km/s, and a 1600-slot pool draws them as coloured dots a hundred metres apart. They
  fade out between 28 and 50 km and are not simulated above 52; the drawn flames, spread by the same
  thin air, are the exhaust up there. Lunar parcels are exempt.
- **Two surfaces on one plane flicker, and a vehicle standing in a slab is two.** The pad deck was a
  solid box with a dark box inset, both tops at z 3.0, and the stack (skirt at z 1.4, bells to −1)
  stood sunk through them: crawling stripes at the foot of the rocket. `js/pad.js` now has a real
  opening with the bells hanging in it and the header lists the heights nothing may share.
- **The pad's collider must let the camera onto the apron.** One 640 × 210 m dome kept the view out
  of the towers by keeping it out of the launch site, and the only angle from which a Saturn V looks
  110 m tall — low, close, looking up — could not be reached. Three ellipsoids in the pad's own frame
  now (deck, tower, tank farm), via `padMatrix()`, which also follows the planet's spin.
- **Start a damped quantity at its target.** The camera's up vector, heading and lens eased in from
  module defaults, so each mission opened with the horizon rolling level; and "ease back behind the
  nose" ran on the pad, where the nose's heading is a fallback axis. Measured after: 0.000° of camera
  rotation across the first 4 s.
- **"Home" for the chase camera is a function of altitude.** The pad shot on the ground, behind the
  nose by 30 km, a slow arc between: easing straight to "behind the nose" after liftoff was a 130°
  swing in two seconds (now ≤ 3.4°/s, measured over the first 10 s of flight).
- **Damp the camera's offset, never its position.** A lerp of the absolute position toward a moving
  target trails it by speed × time-constant: in a 300 km orbit at ×1 with 0.12 km asked for, the camera
  sat 0.572 km back with the ship 32 % up the frame, and under warp it was simply left behind. The
  camera now keeps a damped offset from its target, which is the middle of the hardware still attached
  (`S.pos` is the middle of the FULL stack — after two stagings the command module is 38 m ahead of
  it); the focus glides at staging. Measured after: ship at NDC (0, 0), distance 0.118 km, re-centred
  to within 1 % of the frame 1.4 s after a stage leaves.
- **Integrate the trajectory on one clock, draw it on another.** `js/predictor.js` re-integrates the
  path five times a second (0.72 ms each, measured) and stores it as data — body-relative positions
  with their mission times. `updatePredictor` draws it every frame from where the ship is: flown
  points dropped, a gap of 9 % of the camera distance, a five-vertex fade-in. Drawing the
  integration's own points until the next tick put the ribbon's start 2.7 km behind an orbiting ship
  and through its hull; measured after, the first vertex sits 0.120 km ahead on twelve consecutive
  frames. Three more rules live there: a closed orbit stops after one lap and fades out before it
  meets its start; lunar paths are stored Moon-relative (inertial, an orbit round a body moving
  1 km/s is a coil); and the ribbon's vertices are offsets from a group sitting on the ship, because
  absolute Float32 at lunar distance is a 31 m grid.
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
  and long `ff()`-free propagations finish ~10× slower than the 865 calls they take (counted
  headless, from the shipped coast start) when you drive `updateAim()` directly.
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
  (`(await import('/js/predictor.js')).predLine.parent`) and index the spheres by
  `Math.round(o.geometry.parameters.radius)`: Earth 6371, weather shell 6382,
  atmosphere shell 6435, Moon 1737. Hiding one at a time and screenshotting is how the grey-wedge
  artefact turned out to be cloud alpha rather than a shadow.
- **`mesh.visible = false` is not a toggle for anything that re-centres.** `updatePatch` and
  `updateMoonPatch` set `visible = true` on every frame they run (including their early-return path),
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

One concern per file; no god files. Current sizes: `toonmap.js` 1778, `vehicle.js` 1374, `world.js` 687, `terrain.js` 549, `navball.js` 498, `physics.js` 569, `clouds.js` 443, `hud.js` 437, `camera.js` 300, `predictor.js` 275, `textures.js` 232, `saturn.js` 231, `ribbon.js` 213, `pad.js` 202, `main.js` 175, `toon.js` 138, `constants.js` 120, `targeting.js` 108, `halfres.js` 103, `aero.js` 81, `audio.js` 62, `haze.js` 62.
`vehicle.js` is now the exhaust and debris alone — the hardware it used
to build is `saturn.js`, the launch complex left `world.js` for `pad.js`. It is still the largest
behavioural module; if the particle field grows, split its renderer from its integrator.
`physics.js` and `aero.js` stay display-free: `tools/mission-sim.mjs` imports them headless, and
`saturn.js` with them for the stage records (so anything there that needs a canvas must tolerate having none).

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
