# Painted planets — how the surfaces are made

The bodies are drawn, not photographed. The blue-marble and lunar sheets in `assets/` are satellite
data at 2–20 km per pixel: stretched over a sphere and viewed from orbit it is a soft, mud-coloured
smear, and a cel ramp only quantises the smear into bands of mud. Repainting the photo's own pixels
does not help — that posterises the mud rather than replacing it.

So the imagery is read as **data** and no photographic pixel reaches the screen. `js/toonmap.js`
decodes it, classifies it, and uploads authored colour; `js/textures.js` generates the weather's macro
sheets and the glow sprite from seeded noise. The geography stays real because it comes from the real mask.

## The land mask

`earth_specular_2048.jpg` is the useful sheet: it is a binary map of the world, ocean white and land
black. Measured over all 2 097 152 texels, **64.9 %** are brighter than 224 and **29.8 %** are darker
than 32, with only ~5 % in between — so a single threshold at 110 gives a clean coast, and no
thresholding judgement is involved. Inverting it gives **32.6 % land**, which is what the Earth is.

That mask then goes through:

- a **majority filter**, five passes. A texel keeps its value unless more than half of its eight
  neighbours disagree. JPEG ringing leaves a halo of one-pixel lies around every coast, and the
  filter doubles as a morphological smoother: each pass shaves a corner off a staircase, so the
  blocky source mask rounds into the coastline a map would draw. It costs no strait narrower than
  ~8 texels, which at 20 km per texel is anything a person would notice.
- **sea bands painted from the smoothed signed distance, not from dilated rings** (round 5). The
  octagonal dilation stack (`[9,4,2]` outer, `[5,2]` shallow, a stroke ring) that used to supply the
  shelf/ocean/deep palette staircased at one 20 km texel per tread — and at the 40–150 km-per-pixel
  oblique slants a 160 km orbit review uses, the canvas *is* what the eye gets: every shader-side
  derivative-faded band switches itself off there. So the mask stops at the land classification; the
  sea colour is `smoothstep`-blended iso-lines of `earthCoast()` (deep → ocean at 175 km, shelf at
  95, coast stroke at 25, ±14 km AA) and the relief feather rides the same field, widened 40 →
  180 km so the 384-segment globe mesh (≈104 km per vertex) cannot sample a step. The field itself
  gets a 5×5 binomial tent (~80 km): a chamfer of a staircased mask is only as round as the mask.
  Measured band shares: land 32.8 %, stroke 3.2 %, shelf 8.6 %, ocean 6.3 %, deep 49.2 %.

## Biomes: hue does not work here

`earth_atmos_2048.jpg` is dark and blue-shifted over land. Sampled at the Amazon: rgb(35, 38, 57),
hue 0.644 — **the same hue band as the ocean** — with luminance 0.18. Congo, Europe, Siberia,
Scandinavia and the eastern United States all sit at hue 0.61–0.65. Any rule of the form "greenish
texel means forest" classifies the entire landmass as rock, which is what the first version did.

What does carry the information is the sign of red minus blue, plus brightness and latitude. Over
land: **32.8 %** of texels have blue more than 6 above red (vegetation), **25.7 %** have red above
blue (dry ground: Sahara, Arabia, Australia, Tibet, Patagonia), and 41.5 % are near-neutral — dark
crushed forest and tundra where the JPEG left no chroma at all.

The shipped rule, in `paintEarth`:

| condition | tone |
| --- | --- |
| abs(lat) > 70, or luminance > 0.78 with saturation < 0.15 | ice / ice edge |
| red − blue > 6, luminance > 0.35 | desert |
| red − blue > 6, darker | rock |
| abs(lat) > 55 | tundra, or boreal when dark |
| blue − red > 6, or luminance < 0.34 | forest, or grass when brighter |
| otherwise | rock |

Checked against named places on the painted canvas — Sahara `desert`, Amazon `forest`, Congo
`forest`, Greenland `ice`, Antarctica `ice`, central Australia `desert`, Tibet `desert`, Europe
`forest`, Florida `grass`, Siberia `boreal`, Canada `boreal`, India `desert`, Mid-Atlantic `deep`,
Gulf of Mexico `ocean`, Antarctic coast `shelf`. Tibet reading as desert rather than bare plateau is
the one known lie, and at cartographic scale it is the correct colour.

**A per-texel decision is not enough, because a texel is 19.5 km.** The signals are box-blurred seven
texels before they reach the table above, and the resulting *label* then gets a plurality vote — 5×5, then
3×3, land texels only, ties keeping whatever the texel already was. Without the vote, wherever a value
sits on a threshold adjacent texels flip between grass and forest, and 19.5 km flips with hard edges are
what the ground under the vehicle is made of: the same landscape, rendered as a checkerboard. Voting on
the label rather than the signal is what gives a biome spatial extent, which is the difference between a
map and noise. Water is outside the vote; since round 5 its boundary is the smoothed signed distance
instead of the raw mask, and the crispness of the coast is carried by the shader ink stroke, which
survives where a 20 km texel cannot.

Resulting cover. Sea bands counted on the smoothed signed distance (their measured texel shares,
round 5): land 32.8 %, coast stroke 3.2 %, shelf 8.6 %, ocean 6.3 %, deep 49.2 %. The land splits,
counted on the classification before the beach blend: ice 10.5 %, desert 6.5 %, forest 5.2 %, boreal
4.1 %, grass 3.3 %, rock 1.3 %, tundra 1.0 %, ice edge 0.9 % — and the land numbers sum to the 32.8 %
land band exactly, which is the cross-check that the two measurements see the same planet.

## The Moon

Regolith has no hue worth keeping, so the painting is contrast: box-blur the albedo to kill the
JPEG's ringing, then snap to four flat tones (maria < 0.36, mid < 0.47, high < 0.62, bright). The dark
patches become the maria and the bright ones the highlands and ray systems, which is how a cartoon
Moon is drawn anyway. The Moon material carries **no colour multiplier**: the tones are the palette,
and a multiplier scales all of them away.

## Weather: one marched shell

Weather is one mesh, `js/clouds.js`: a sphere at `RE + 11 km` whose fragment shader marches the view
ray through a band from 4 km to 11 km and returns `1 − exp(−τ)`. There are no cloud decks and no
cloud caps any more.

Three fields feed the march, all generated:

- **Where** — the macro sheet from `js/textures.js` (`cumulusTex`, 2048 × 1024, 20 km per texel): a
  six-octave fbm shaped by the real zonal pattern (ITCZ, dry subtropics near ±25°, storm tracks near
  ±52°). Its alpha moves *coverage* between 7 % (fair weather) and 82 % (inside a system). It does
  not scale opacity: the first version did, and the planet wore an edgeless white fog.
- **What shape** — a 512² tileable lattice at 160 km per tile (0.3125 km per texel, 250 repeats
  round the globe), two independent fields in R and G, stored as **rank** so it is uniform on 0..1.
  The mean of two uniform fields is triangular, so a coverage `c` becomes the exact threshold
  `1 − √(c/2)` (or `√((1−c)/2)` above one half) rather than a tuned guess. The two fields drift at
  17.6 and 56 m/s on top of the planet's spin, so cells grow and dissolve as they slide past each
  other. The same lattice read at 800 km per tile bunches the cover into fields and gaps.
- **Cirrus** — `cirrusTex`, a thin veil in the top quarter of the band.

The threshold climbs with height, so every cloud is a dome on a flat base and only the strongest cores
reach 11 km. The march composites front to back and reports the mean height the ray actually *sees*:
tops from above, bases from the pad. That one number drives a three-band cel tone, which is the whole
lighting model.

Measured, from the macro sheet through the shipped coverage law: **26.7 %** global cumulus cover; by
latitude 0° 0.47, ±20° 0.22 and 0.13, ±40° 0.30 and 0.22, ±60° 0.32 and 0.23, ±80° 0.16 and 0.19.

Where the lattice is unresolved (more than ~5 of its texels under one pixel) the sampler's mips have
averaged the rank field to 0.5 and a threshold on it is a coin that always lands the same way —
measured from 4 000 km as storm belts gone solid white and everything else bare. There the density
becomes the coverage fraction itself, which is the exact mean of what the threshold would have drawn.

Each pixel starts its eight samples at a different phase (interleaved gradient noise). With a fixed
phase a slanted view cut every cloud at the same eight heights and drew it as a stack of plates.

Row 0 is south in every generated sheet: a `DataTexture` samples row 0 at `v = 0`, and
`SphereGeometry`'s `v = 0` is the south pole.

Three.js samples `alphaMap` from the **green** channel, which is why nothing here uses it: that trap
put an opaque white tablecloth on the planet twice. Density that lives in alpha is read as alpha.

### What the old system was, and the plate

Until this change the weather was two planet-scale decks (cumulus at 2 km, cirrus at 9 km) plus two
tangent-plane caps that re-centred under the vehicle: a 440 km cloud cap and a 64 km shade cap. A
planet-wide texture at 20–39 km per texel cannot put a cumulus over the pad, so the caps did that —
and a cap is a square with an edge.

The "giant flat square plate around the ship" reported at maximum zoom-out was **not** the cloud cap,
though. With the caps deleted the quadrilateral was still there, and toggling one mesh's draw range
proved it was the near ground patch (`js/terrain.js`, ±220 km). Two mismatches against the globe it
sits on made it read as a plate; each was measured:

- **Haze.** The patch took three's `FogExp2`; the globe is exempt (camera-distance fog would erase
  the planet from the system view). At a 400–600 km sight line the patch washed to 90–100 % sky
  tone beside saturated ocean. Both surfaces now carry one law, `js/haze.js`: exp² in true
  distance, on a density clock keyed to the *camera's* altitude.
- **Emissive.** The globe has a navy emissive floor (`0x07182c`); the patch had none. Diffing two
  frames with only the patch toggled: mean RGB where the patch drew (69, 91, 64) against the globe
  in the same pixels (70, 94, 81), and 23.6 % of the frame changed by more than 24/765. With the
  same floor on the patch: (77, 89, 78) against (63, 87, 80), and **2.9 %** — coastline detail.

## Cost

One pass on the main thread at boot, before the first painted frame: **~540 ms for the Earth**,
**~27 ms for the Moon**, after which nothing runs per frame. Until the canvas is ready the material
uses a 2 × 2 block of ocean blue — not `new THREE.Texture()`, whose `Source` never sees a later
assigned image, and not a `CanvasTexture` over an empty canvas, whose first upload sticks. Both
failures were reproduced; the placeholder means nothing photographic and nothing wrong is ever shown,
not even for a frame.

## Relief, and the normals that had to go

The simulation treats both bodies as exact spheres — `impact()`, the landing site and the certified
mission all depend on that — so displacement always had to stay small, and for a while the **normal map
carried the visual drama** instead: geometry displaced radially, plus a generated normal map at
`normalScale` **26 (Earth) / 16 (Moon)**.

Those normal maps are now **removed**, along with the near-level vertex decoration (mottle, ripples,
speckle, cracks) that sat on top of them. The reason is arithmetic, not taste: at 10-40 km per texel the
real slope is about 1 %, so any honest normal scale shows nothing, and the 25x exaggeration that made it
"read" produced a stippled, corrugated surface at exactly the grazing angles a launch-pad camera lives
at. It was also describing a surface that is measurably smooth — under the pad, `groundHeight` over ±3°
peaks at **0.71 km** with a largest step of **0.10 km per 11 km**, which is under 4° of slope. The shading
was lying about geometry that was never there. See `cartoon-art-direction.md`: if a look needs a normal
map or per-pixel noise, it is out.

Relief survives only where it is free — horizon silhouette, and the large steps at mare boundaries — and
no part of the look may depend on it.

Height-field caps are still deliberate, and they are caps in the code rather than in prose:

- **Earth:** land only, ocean and shelf **exactly 0**, cap **[0, 1.4] km**, ice sheets +0.5 km.
- **Moon:** maria exactly 0, highlands stepping +0.35 km over them, plus roll, ridged massifs and
  ±0.25 km roughness, 560 hashed craters of 45-345 km radius (depth ≤ 1.15 km, rim ≤ 1.25 km), whole
  field clamped **[−2, +2] km**.

One measured flaw in the lunar field is worth keeping on the record because the old assertion could not
see it: sampling 2000 uniform directions gave min −1.45, max +2.00, mean 1.09 km, with **19.1 % of samples
pinned at the +2.00 cap** — a fifth of the Moon flattened into one plateau. Asserting "values stay inside
the bounds" passes that trivially. The assertion has to be on *headroom*: less than N % of samples within
ε of either bound.

Meshes: Earth 384×192 = **74 305 vertices / 147 072 triangles**, Moon 512×256 = **131 841 / 262 144**,
with the dateline seam's normals welded so the seam does not catch the light.

## The near level: one mesh, warped radially

Close to the ground the far grid's 10-40 km texels are useless, so the Earth has a second surface that
follows the vehicle: **one mesh, 161 × 161 vertices, fifth-power radial warp** — roughly 25 m spacing
under the vehicle stretching out to a rim at ±220 km. Hidden above 30 km altitude; re-centred in place
after 12 km of ground travel; otherwise the per-frame cost is one altitude test and a dot product, with
zero allocation.

The rim is not cosmetic. The horizon from a camera 0.184 km up is `sqrt(2 · RE · alt)` = **48.4 km**,
and from 1 km it is 113 km, so a near patch that stops a few kilometres out shows its own edge — and
if that edge is below the sphere, you see straight through it. Heights are therefore never below the
far mesh by construction (positive-only fine octaves plus an 8 m lift), and the pad's coplanar ties are
won with `polygonOffset` rather than hope. The vertex decoration that used to sit on this mesh — a detail
mottle fading out beyond 25 km — is gone; what is left is flat colour matching the painted biome at that
spot (see the relief section above, and `cartoon-art-direction.md`).

**Ground colour must vary slower than the mesh that samples it.** This cap goes from 25 m under the
vehicle to 3 km at the rim, so any colour source with a hard per-sample decision at a few kilometres —
a thresholded lattice, most commonly — aliases into a fan of straight-edged wedges radiating from the
pad, and a *soft* decision on a value-noise lattice is worse in a subtler way: bilinear interpolation
with a clamped threshold draws a literal straight line across the plain. Both were tried here and both
were the "horrific" verdict. The near level therefore samples a blurred copy of the paint
(`canvasDataSoft`: land-weighted box mean, ~160 km, built after the launch-site bake so the pad's own
tones are inside it), and the authored site is one flat brush of grass with its zones carrying the shape.

Shorelines in the near level come from a two-sided chamfer signed-distance transform on the 2048 × 1024
mask, taken through a 60 m `smoothstep`: curve-true, and band-limited so it cannot ring.

## The launch site is authored, because 20 km per texel has no Florida in it

Merritt Island is 5-8 km wide. At the painted map's resolution the whole launch complex, its lagoon and
the Atlantic fall inside one texel, which is why the site originally read as open sea, and why the pad
was given a circular plate as a substitute coastline.

The plate is gone. Five authored shore lines run NNE-SSW through the site — mainland bank, Indian
River, Merritt Island, Banana River, cape, Atlantic — blended into the global signed-distance field over
0.6° and **baked into the painted canvas at the same weight**, so the near level and the globe from orbit
show the same shapes in the same tones. The pad's own neighbourhood is held exactly flat (inside 90 km,
feathered to 250 km) because a launch mount is not allowed to sit on a slope, and the pad's texel bakes to
grassland `rgb(120, 154, 84)` with a beach band of `rgb(212, 184, 120)` and shelf tones in the lagoons —
measured on the canvas at 28.45° N, 80.60° W.

What did *not* happen is moving the pad. `PAD_POS` is physics ground truth and
`docs/reference/mission-design.md` quotes runs taken with it, so the coastline was corrected to the
truth at 28.45° N, 80.60° W rather than the site being relocated to wherever the coarse mask happened to
say there was land.

## Reading the painted canvas from above

`planetCanvas('earth' | 'moon')` hands the same canvas to the map chart, which draws the body as a
**polar azimuthal disc** — north pole at the centre, screen angle as longitude, radius as cos(latitude).
That projection is forced rather than chosen: the chart plots surface points at radius `R · cos(lat)`
because it maps only the two equatorial coordinates, and cos(lat) *is* the orthographic polar foreshortening.
Blitting an equirect strip across that disc puts latitude on the chart's vertical axis, where world z
belongs, and the vehicle marker slides across the wrong coast. The mesh's spin has to be folded in as
well, since the canvas is welded to the mesh.

## What does not cast shadows

Not the weather shell. It spans 4–11 km, so a low sun drags its silhouette hundreds of kilometres
across the surface, and the vehicle-tracking shadow box clips those streaks into hard grey slabs that
read as architecture.

Cloud shade is **marched** instead: `js/clouds.js` injects the same optical-depth integral into the
globe and the near patch, aimed up the sun ray from each ground fragment (four samples), so the dark
shape on the ground is the column of cloud above it at every distance, with no shade mesh and no rim.
The cel terminator does the rest of the mood work on its own.
