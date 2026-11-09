# Painted planets — how the surfaces are made

The bodies are drawn, not photographed. The blue-marble and lunar sheets in `assets/` are satellite
data at 2–20 km per pixel: stretched over a sphere and viewed from orbit it is a soft, mud-coloured
smear, and a cel ramp only quantises the smear into bands of mud. Repainting the photo's own pixels
does not help — that posterises the mud rather than replacing it.

So the imagery is read as **data** and no photographic pixel reaches the screen. `js/toonmap.js`
decodes it, classifies it, and uploads authored colour; `js/textures.js` generates both cloud decks
and the glow sprite from seeded noise. The geography stays real because it comes from the real mask.

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
- **octagonal dilation.** One radius dilated separably gives a square, and a square coastline is the
  most obviously synthetic thing on the planet. Applying descending radii — `[9, 4, 2]` for the outer
  shelf, `[5, 2]` for the shallow band, `[1]` for the stroke — approximates the disc as a rounded
  octagon for the same work.
- a **coast stroke in the water**. `dilate` returns land *plus* the ring, so the ring alone is
  `dilate & ~land`. Painting the dilated mask inks every land pixel instead and the continents come
  out navy. That mistake cost one full screenshot round.

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

Resulting cover: deep ocean 46.7 %, ice 10.5 %, ocean 9.1 %, shelf 8.4 %, desert 6.4 %, forest 5.4 %,
boreal 4.0 %, grass 3.0 %, coast stroke 3.0 %, rock 1.6 %, ice edge 0.9 %.

## The Moon

Regolith has no hue worth keeping, so the painting is contrast: box-blur the albedo to kill the
JPEG's ringing, then snap to four flat tones (maria < 0.36, mid < 0.47, high < 0.62, bright). The dark
patches become the maria and the bright ones the highlands and ray systems, which is how a cartoon
Moon is drawn anyway. The Moon material carries **no colour multiplier**: the tones are the palette,
and a multiplier scales all of them away.

## Weather, and the two alphaMap traps

Both cloud decks are generated. Density lives in the **alpha** channel of a white texture and the
material reads it through `map`.

Three.js samples `alphaMap` from the **green** channel. That trap cost the planet twice: the shipped
`earth_clouds_1024.png` carries its weather in alpha while painting RGB a flat grey 168, so binding it
as `alphaMap` read density 0.66 everywhere and the Earth wore an opaque white tablecloth — which was
also why it threw a shadow across the whole launch pad. Then, after generating a replacement, the
cirrus deck was bound as `alphaMap` with white RGB and went opaque over the entire planet the same
way. Anything whose density is alpha must be sampled as `map`.

Cumulus density is a five-octave fbm shaped by the real zonal pattern — the intertropical convergence
zone, the dry subtropics near ±25°, the storm tracks near ±52° — pushed through `smoothstep(0.60,
0.82)` so each cloud has a defined edge. Measured cover is **38.6 %** (mean density 0.372), by
latitude: 0° 0.67, ±20° 0.01 and 0.00, 40° 0.25, 60° 0.45, 80° 0.44. Cirrus is stretched hard along
longitude: mean 0.13, 26.9 % above its low threshold, a veil rather than a deck.

Both decks **blend; neither alpha-tests**, and both are mipmapped — an alpha-tested mipmapped field
carves the puffs away wherever the minification takes a texel sample out of a puff. Row 0 is south in
all three generated sheets: a `DataTexture` samples row 0 at `v = 0`, and `SphereGeometry`'s `v = 0` is
the south pole, so a north-first sheet renders mirrored and its weather ends up in the wrong
hemisphere. That convention mismatch was live for a long time and is why the ITCZ's shade and the
ITCZ itself were on opposite sides of the equator.

These decks are an *orbit* feature. At 1024 × 512 over 40 000 km one texel is 39 km, and the sky from
the horizon to 30° elevation spans 0.00017 in `u` — **a fifth of one texel** — so from the ground this
field can only ever be a uniform film or nothing at all. The sky you can actually read is
`js/clouds.js`.

Cover started at 67.5 %, which read as a dirty shell: with three ramp bands a deck spanning the sphere
spends most of its area in the middle band, a flat mid grey. It now gets its own two-band ramp
(`RAMP_CLOUD`, floor 0.55) so sunlit cloud is white and the underside is pale, not slate blue.

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
after 4 km of ground travel; otherwise the per-frame cost is one altitude test and a dot product, with
zero allocation.

The rim is not cosmetic. The horizon from a camera 0.184 km up is `sqrt(2 · RE · alt)` = **48.4 km**,
and from 1 km it is 113 km, so a near patch that stops a few kilometres out shows its own edge — and
if that edge is below the sphere, you see straight through it. Heights are therefore never below the
far mesh by construction (positive-only fine octaves plus an 8 m lift), and the pad's coplanar ties are
won with `polygonOffset` rather than hope. The vertex decoration that used to sit on this mesh — a detail
mottle fading out beyond 25 km — is gone; what is left is flat colour matching the painted biome at that
spot (see the relief section above, and `cartoon-art-direction.md`).

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
feathered to 250 km) because a launch mount is not allowed to sit on a slope, and the pad's texel bakes
to grass, `rgb(58, 104, 60)`.

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

Neither cloud deck. They sit 2 and 9 km up, so a low sun drags their silhouettes hundreds of
kilometres across the surface, and the shadow box — ±136 km around the vehicle, because the vehicle is
what needs the towers to resolve — clips those streaks into hard grey slabs that read as architecture.

Cloud shade is a **projected deck-alpha texture** instead: `js/clouds.js` drapes a second cap on the
actual terrain, sampling the same puff tile at the same uv, offset anti-sunward by deck height over
tan(elevation) so the penumbra widens as the sun drops. It was previously a blurred composite of the
planet-scale decks sampled by the ground shaders, and at 78 km per texel all it could produce was
straight-edged slabs across the pad. The cel terminator does the rest of the mood work on its own.
