# Painted planets — how the surfaces are made

## The surface is drawn per fragment (current)

Everything below this section describes how the *data* is derived from the shipped sheets, and that
is still how it works. What changed is the last step. The painted canvases are no longer the
planets' textures: they are only what the orbital map and the navball blit. The ground itself is
drawn in the fragment shader (`js/surface.js`, `js/surface-earth.js`, `js/surface-moon.js`) from
smooth data fields, because a canvas has one resolution — 20 km per texel on the Earth, and from the
pad, from 15 km and from 110 km of lunar orbit that one resolution was the picture.

**The idea.** A flat tone with a sharp edge is a threshold on a smooth field. Bilinear sampling of a
smooth field gives a smooth contour at any zoom, and adding band-limited noise to the threshold
makes the contour a fractal line. So each body carries a few fields and the shader thresholds them:

| body | texture | channels |
| --- | --- | --- |
| Earth | `sfField` 2048×1024 RGBA8, mipmapped | aridity, tree cover, cold, ruggedness |
| Earth | `sfCoast` 2048×1024 R16F | signed km to the coast (the same field as before) |
| Earth | `sfPadSdf` 512² R16F over ±72 km | the authored launch-site shore, 0.28 km per texel |
| Moon | `sfField` 1024×512 RGBA8, mipmapped | albedo, the 340 km-smoothed albedo the mare cut is taken on, relief-crater tone |

The Earth's three biome axes are the voted labels turned back into memberships (each label votes a
value per axis; land-weighted box mean, r 2), so the table in "Biomes" below still decides what
grows where. Ruggedness is new data: the tilt of `earth_normal_2048.jpg`, read as numbers. Measured
5×5 mean tilt in 8-bit units — Himalaya 72.6, Alps 71.1, Andes 36.7, Rockies 30.9, Tibet 29.6;
Sahara 7.0, Amazon 4.1, Florida 2.0, open ocean 2.0. It also replaces the seeded ridges in the
Earth's relief grid, so the far mesh's mountains stand where the drawn ones are.

**The noise** is a uint hash on integer lattice cells, eight octaves four apart: 512 km … 31 m on
the Earth, 256 km … 16 m on the Moon. An octave fades out as its cell drops under roughly 30 pixels
and is not evaluated under 9, so there is no speckle at any range. Two variants: `sfN` (gradient +
value, used where a slope is shaded) and `sfNv` (value only, a third of the cost, used where only a
contour is drawn).

**What is drawn.** Earth: biome borders with groves and clearings at every scale; farmland plots (a
cubic lattice cut by the ground is a patchwork of polygons); rivers as the 0.5 contour of a slow
field, at their own width or 1.4 px; rock and snow where ruggedness and ridges say so, and two flat
shading bands from the slope of a ridged height toward the sun; five sea bands, surf, pack ice; a
beach and dune band and a 1.6 px ink line on every shore. Moon: mare / plain / highland / bright
with a collar stroke inside each mare border; the 560 relief craters from the field; and a crater
population per octave (one candidate per lattice cell, radius 0.07–0.30 of the cell, so 5 m to
19 km) each drawn as two offset discs — a shadow crescent inside the sunward rim and a lit one on
the far wall, the offset growing as the sun drops — plus a rim ring that survives noon.

**One function, two meshes.** The globe and the near patch run the same shader on the same
body-fixed point. Where the patch is up, the globe's fragments within 205 km of its centre are
discarded at the top of the shader: with a logarithmic depth buffer there is no early-z, and the
discard is also why the patch needs no display lift under the vehicle (see below).

**Precision.** A float32 body-fixed position has a 0.5 m grid at the Earth's radius. The patch's
vertices are differenced against an anchor in the vertex stage, and each lattice is addressed as
(local offset + fraction of a cell) plus (integer cell of the anchor), both computed in doubles in
`anchorPatch`. On the patch the coarse octaves are evaluated per vertex and interpolated; relief
slope there is differenced per vertex too, because a screen derivative of an interpolated value is
constant per triangle (seen as sawtooth shading over the Alps from 12 km).

**The patch is shape only, and it is the contact surface.** `js/terrain.js` writes position, normal
and uv; no colour. Under the vehicle the Earth patch is `reliefGrid + fineRelief` and the lunar
patch is the relief grid — the same numbers `fineGroundHeight` and `moonGroundHeight` return.
Measured at the 625 vertices nearest the vehicle: 0.27 m worst disagreement at the pad, 0.07 m at
two lunar sites (float32 vertex rounding). The lunar patch used to carry a 300 m display lift plus
analytic rim relief, so a camera or a ship placed on `moonGroundHeight` sat underneath the drawn
ground and saw stars; both are gone. Non-finite floats in position / normal / uv: 0 at the pad and
at both lunar sites. Worst normal tilt off vertical: 1.17° at the pad.

**A bug this found.** `boxSignal`'s latitude window added each entering row twice: a constant field
of 1 came back as 11 at r 1 and 5.0 at r 3. Every smoothed signal — the biome classifier's three,
the Moon's mare field — had been running on it. Fixed; max error against a brute-force sum is float
rounding at r 1, 2, 3 and 9. The biome shares and named-place checks quoted under "Biomes" were
taken with the broken filter and have NOT been re-measured; Florida, for one, now votes forest
rather than grass, and the launch site's grass and scrub are authored in the shader instead.

**Cost.** Boot, navigation to first painted frame, same machine and harness (headless Chromium,
Apple M4 Max): 5.6 s before, 2.1 s after — the Moon is painted at its native 1024×512 instead of
4096×2048, the blurred ground copy is gone, and the coast transform runs once instead of twice.
GPU time (`EXT_disjoint_timer_query_webgl2`, 2160×1250, weather hidden so only the ground is
timed) was measured while other jobs shared the GPU and is noisy: medians of 1.0–1.5 ms before
against 1.5–3.5 ms after at the pad and over the Cape, 0.8 against ~2.2 from 400 km, 0.3–0.6
against 0.9–2.6 at the Moon. It needs re-measuring on a quiet machine before anyone quotes it.

**Stale below.** "Cost" (the 540 ms / 27 ms paint times), "The near level" (vertex colour, the
blurred `canvasDataSoft` copy, the 8 m lift), the Moon's 4096 canvas and its analytic near-level
craters, and the relief caps' description of seeded Earth ridges describe the previous renderer.

The bodies are drawn, not photographed. The blue-marble and lunar sheets in `assets/` are satellite
data at 2–20 km per pixel: stretched over a sphere and viewed from orbit it is a soft, mud-coloured
smear, and a cel ramp only quantises the smear into bands of mud. Repainting the photo's own pixels
does not help — that posterises the mud rather than replacing it.

So the imagery is read as **data** and no photographic pixel reaches the screen. `js/toonmap.js`
decodes it, classifies it, and uploads authored colour; `js/cloudfields.js` generates the weather's
sheets and `js/textures.js` the glow sprite, from seeded noise. The geography stays real because it comes from the real mask.

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

## Weather: one field, drawn as shapes

Weather is one mesh, `js/clouds.js`: a sphere at `RE + 11 km`. A cloud is an opaque **drawn shape** —
an edge, three flat tones — not a density. There are no cloud decks, no caps and no optical-depth
integral any more.

### The field (`js/cloudfields.js`)

There is cloud wherever one scalar field exceeds one threshold:

    F = WM·macro + WV·(variety − ½) + W1·oct1 + W2·oct2 + W3·(1 + TURRET·h)·oct3
    cloud where F > THR + RISE·h²        h = height in the cumulus layer, 0 at 4 km .. 1 at 7 km

So every cloud is a height field on a flat base: a steep wall at its foot, rounding over at the top,
with the billows counting for more the higher up they are.

- **macro** — a 2048 × 1024 planet sheet, 20 km per texel, stored smooth: six-octave domain-warped
  fbm pushed by the zonal pattern (ITCZ, dry belts near ±25°, storm tracks near ±52°) with 26
  mid-latitude cyclones stamped in (a logarithmic-spiral arm, a core, a dry slot behind the arm).
- **variety** — the same sheet's green channel: plain fbm that moves the threshold from region to
  region, so the repeating tile never draws the same field twice.
- **oct1..3** — three reads of one 512² tile at 1000, 160 and 32 km per tile (the third with its axes
  swapped). Two of the tile's channels are rank-uniform fbm; the other two are **domes** — one minus
  the squared distance to the nearest feature point. The level set of a sum of domes is a union of
  arcs meeting in cusps, which is how a cloud is drawn with a pen. A third of the dome cells are
  empty and the points sit anywhere in their cells: held near the centres, the lattice showed from
  500 km as rows and columns of cloud.

`THR` and `WM` are not tuned, they are solved: `cellField()` draws 400 000 samples of the cell sum
from the bytes it uploaded and takes quantiles, so the cover is `COVER_CLEAR` (8 %) where the macro
sheet reads 0 and `COVER_STORM` (72 %) where it reads 1. The macro term moves *coverage*; it never
scales opacity (the first marched shell did, and the planet wore an edgeless white fog).

The tile is read in **Mercator**, not equirectangularly. Mercator is conformal, so a cell is as tall
as it is wide at every latitude and only shrinks toward the poles; read equirectangularly the cells
kept their height while their width fell with cos(latitude), and everything north of 45° was drawn
as north–south streaks. Every length the cell field deals in is therefore in equatorial km.

### Detail follows the eye

Every read of the tile is `textureLod` at the mip whose texel is the pixel's footprint at that
distance. An octave too fine to resolve averages to its mean and leaves the sum, so from the pad the
field carries 1 km billows, from 500 km cells and fields, and from the system view only the macro
sheet's systems. Two corrections make that work:

- a blurred field has less contrast, so a threshold on it covers less sky and far cloud would thin
  out and vanish. The departure from the mean is scaled back up by what the mips took (`gain`,
  from each octave's measured sigma and a fitted mip-contrast law), so the fraction covered holds
  and only the outline simplifies;
- nothing is ever swapped for a fog. The old shell fell back to "density = coverage" where the
  lattice was unresolved, which is the grey smear the orbit view had.

### Finding the surface

The half-resolution pass walks each view ray through the 3 km cumulus layer in even strides along
its *ground* track (3 for an overhead ray, at most 20), then bisects. Three things were learned by
looking at wrong pictures:

- **The field must be read no finer than twice the stride.** A lobe narrower than the stride is
  caught by some rays and jumped by their neighbours, and the cloud is drawn as the slices the
  samples happened to cut: a stack of plates from the pad, a comb on every flank. So a slanted ray
  draws broad shapes and an overhead one keeps every billow.
- **Sphere tracing does not pay here.** In clear sky the field sits close under its threshold
  compared with its slope, so safe steps are short and a grazing ray ran out of its sixteen
  iterations before it reached the cloud whose shadow was on the sea.
- **Three samples with the middle one highest mean the field peaked between samples.** A parabola
  through them says where; without it silhouettes are serrated at the sample spacing.

The slow part of the field (macro sheets, first octave) is read at three points of the ray and
interpolated; if it is so low all along the ray that the other octaves at their 99.8th percentile
could not lift it over the threshold, the walk is skipped.

### Ink

The march does not write a colour. It writes four numbers per pixel — light, haze, veil, and
coverage as a *ramp* through 0.5 at the silhouette — and the shell's own geometry in the main pass
turns them into ink at full resolution: coverage is cut at 0.5, light into three tones (lit, mid,
shade). A bilinear-upsampled ramp thresholded per pixel is a clean edge at the screen's resolution,
the way distance-field type is; an upsampled colour is a blur. That is how a quarter-pixel march
has a line.

- **Tops and flanks**: the cloud is a height field, so its normal is its slope. One more pair of
  reads a short way toward the sun gives the slope along the only direction that matters, in units
  of the field's own rms slope at that footprint — the same drawing at every range.
- **Bases** seen from below are dark where the cloud above is deep and pale to a lit rim where it
  thins.
- The lit tone turns warm toward the terminator; the night side is one dark blue.
- Distant cloud goes to the colour of the air and thins, so the horizon is not a white wall.
- **The veil** is one thin sheet at 10 km: the cirrus sheet times a streak read of the tile
  stretched 16:1 along longitude, cut into two translucent steps.

The band has two surfaces. The outer sphere serves an eye above it (front faces) or below it (back
faces). An eye *inside* looks down through rays that end on the ground and never reach the outer
sphere, so a second sphere at the cloud base carries the same march for those.

### Cost

Not yet measured on an idle machine. `tools/cloud-views.mjs` times the three passes that belong to
the weather (`sky` the march, `ink` the composite, `ground` the planet with its cloud shade) with
`EXT_disjoint_timer_query_webgl2` at a 2160 × 1250 drawing buffer, drawing each sixteen times
inside one query because a single light frame reads anywhere from 0.7 to 2.5 ms on this GPU. The
runs made while this was written shared the GPU with other work and disagreed with each other by
more than the difference between old and new; no figure from them belongs here.

Row 0 is south in every generated sheet: a `DataTexture` samples row 0 at `v = 0`, and
`SphereGeometry`'s `v = 0` is the south pole.

### What the old system was, and the plate

Before the marched shell the weather was two planet-scale decks (cumulus at 2 km, cirrus at 9 km) plus two
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

Cloud shade is **looked up** instead: `js/clouds.js` injects the same field into the globe and the
near patch. From each ground fragment it follows the sun ray to where it crosses the cloud base (the
cloud's own outline) and to 45 % of the layer's height (where a low sun's ray meets a tower's flank),
and darkens by one flat tone if either is inside cloud. No shade mesh, no rim, no integral.
The cel terminator does the rest of the mood work on its own.
