# Art direction — a cartoon Earth, not a small realistic one

Written after the user looked at the rendered result and said, in order: *"terrain up close is horrific"*,
*"sky does not look like a sky"*, *"more like KSP with procedural loading"*, and then the rule that
decides everything else — **"it must look and feel like a real cartoon earth … no complex
shading/textures"** and **"it should be immersive"**.

This is not a refinement of the previous direction. It retires part of it. When a change here conflicts
with a decision recorded in `painted-planets.md`, this file wins.

## The test for every pixel

A still frame should be recognisable as the same drawing whether it is seen from the launch pad or from
200 km. If a feature only survives at one of those two distances, it is the wrong feature.

Second test: **could a person paint this frame with four flat brushes?** If the answer needs a texture
map, a normal map, or a noise function per pixel, it is out.

## In

- **Flat colour shapes with hard edges.** The painted biome map is the Earth: ocean, shelf, coast line,
  grass, forest, desert, ice. Bold, saturated, few tones, coastline as a deliberate line.
- **Two or three tonal steps per surface**, chosen by the cel ramp, and the step boundary allowed to be
  visible. That is the look, not an artefact of it.
- **Depth from silhouette and layering**, not from surface detail: a coastline, a shelf band, a hill range
  drawn as a shape against the sky, clouds as shapes with their own edge.
- **One dark outline** on hard-edged hardware (`toon.js` `outline()`), which is what makes the rocket read
  as drawn rather than photographed.
- **An immersive sky**: a smooth vertical gradient from a deep blue at the zenith to pale at the horizon,
  sun glow around the sun's bearing, and the same sky fading into black space with stars as the sky thins.
  Sky is a *place*, not a background: it should be the thing that tells you where you are on the planet.

## Out

- **Normal maps on planetary surfaces.** The exaggeration needed to make 10-40 km-per-texel slope visible
  (`normalScale` 26 on Earth, 16 on the Moon) produces a stippled, corrugated surface at grazing angles,
  which is exactly what made the terrain "horrific" from the pad. The physics treats both bodies as
  spheres anyway, so the bump detail was always a lie told at the wrong resolution.
- **Vertex "decoration"**: mottle, ripples, speckle, cracks on the near terrain. Close up this reads as
  dirt on the lens; from orbit it is invisible. Both tests fail.
- **Displaced terrain meshes as a source of beauty.** Relief may stay where it is *free* — a silhouette
  on the horizon, a 2 km step at a mare boundary — but no part of the look may depend on it, and nothing
  may depend on a normal map to sell it.
- **Photographic debris**: JPEG-derived detail, albedo noise, gritty greys.

## Immersion without detail

The user asked for immersive and no complex textures in the same breath, which sounds contradictory and
is not. What carries immersion here is **motion and coherence**, not resolution:

- the planet turning under you, with the terminator moving;
- weather that drifts and shadows the ground under it, with cloud shapes that read from both ends of the
  altitude range;
- a sky that changes character as you climb and goes to black;
- exhaust that obeys the air (short and violent on the pad, a long thin needle at 60 km, a ballistic fan
  in vacuum, a flat sheet on the Moon);
- the pad, the vehicle and the horizon agreeing with each other at every altitude — no seams, no chasms,
  no pop-in.

## What the exhaust and the air taught

These are the rules the frames enforced, in the order they were learned.

- **The ground takes aerial perspective, and all of the ground takes the same one.** A flat cartoon
  plain that runs to a hard line reads as a painted card laid on the world, so distant ground fades
  to the horizon tone. The near patch used to get that from the scene's `FogExp2` while the globe got
  nothing, and the patch's rim became a colour cliff — the plate the zoom-out view showed. Both now
  share `js/haze.js`, keyed to the camera's altitude, so the haze is gone by orbit. The Moon, the
  stars, the dome and the weather shell stay unhazed.
- **One sprite cannot be both fire and cloud.** Alpha holds a plateau to 0.62 of the radius and falls
  steeply after it: a sprite that ramps down from its centre composites into cotton wool, and a blast
  cloud needs lobes with a silhouette. Cloud discs then draw at 5.75× parcel radius against the flame's
  2.5× — parcels are metres across and hundreds of metres apart, and at 2.5× nothing ever merged.
- **Screen size gets two caps.** 220 px for coverage-dominant parcels, 80 px where additive glow
  dominates. At one shared 512 px cap a single glowing puff a metre from the lens bloomed into a lantern
  a tenth of the frame, and the flame trench read as a dozen separate lamps.
- **Ejecta must be lighter than the ground it lifts.** The lunar dust band was specified "brighter than
  regolith" and sampled at the same 8-bit value as the rendered surface, so the whole sheet vanished
  into the ground. Out there there is no shadow and no atmosphere to separate them with; the tone does
  it alone (now `0xdce1e6`). In vacuum the *gas* is faint and the dust is the visible event, so lunar
  parcels also lose their incandescence faster than Earth parcels lose theirs to air.


## Consequences for what already shipped

| Shipped | Verdict |
| --- | --- |
| Painted biome map from the specular land mask | Keep. This *is* the cartoon Earth. |
| Coastline stroke, shelf band, ice caps | Keep, and make them read harder. |
| Generated weather (`js/clouds.js`) | Keep; shapes not photographic detail. |
| Cel ramps, hard outlines on hardware | Keep. |
| Normal maps on Earth and Moon surfaces | Remove. |
| Vertex mottle/ripples/speckle/cracks on near terrain | Remove. |
| Displaced far meshes | Keep only as horizon silhouette; no detail dependence. |
| Near terrain patch | Keep the *streaming* idea (KSP-style), throw away the decoration; a coarse ground that matches the painted biome colour, cleanly, at every distance. |
