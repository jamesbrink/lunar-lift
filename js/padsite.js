import * as THREE from 'three';
import { RE, PAD_UP, PAD_EAST } from './constants.js';
import { C } from './palette.js';
import { noise, period, EARTH_CIRC, sampleGrid, smoothS } from './paintkit.js';

/* ---- the launch pad ----

   The pad mesh is welded to the Earth mesh at PAD_UP and physics anchors on the exact sphere RE,
   so relief is exactly 0 within ~90 km of PAD_UP (the crawler deck spans a tenth of a kilometre)
   and feathers back to full by ~250 km. Both the far grid and the near level multiply by this — the
   pad can never float on a near octave, and the launch view sits on a flawless sphere. */
const PAD_A0 = Math.cos(90 / RE), PAD_A1 = Math.cos(250 / RE);

export function padWeight(u, v) {
  const lat = (v - 0.5) * Math.PI, lon = (u - 0.5) * 2 * Math.PI;
  const cl = Math.cos(lat);
  const dot = cl * Math.cos(lon) * PAD_UP.x + Math.sin(lat) * PAD_UP.y - cl * Math.sin(lon) * PAD_UP.z;
  if (dot >= PAD_A0) return 0;
  if (dot <= PAD_A1) return 1;
  const t = (PAD_A0 - dot) / (PAD_A0 - PAD_A1);
  return t * t * (3 - 2 * t);
}

/* ---- authored coastline at the launch site ----

   28.6° N, 80.6° W is Merritt Island: a barrier island 5–8 km wide with LC-39 on it, the Banana
   River lagoon to the east, the cape's own barrier beyond that, the Atlantic past the cape, and
   the Indian River lagoon plus mainland marsh to the west. The 20 km-texel mask straddles that
   coast and puts the whole complex in open ocean — which is why js/world.js used to fake an island
   out of three discs. This is NOT invented geography, it is de-quantising a coastline that is
   known, described here as five NNE-trending shore lines with a little authored wobble; the signed
   distance below is what every LOD then draws — the same shapes from orbit, at 500 m and at the
   pad — and the mask baked into the painted map is derived from it, so there is one truth.

   Distances are km in the tangent frame at PAD_UP (x east along PAD_EAST, y north); all five
   boundaries drift east as they go north (the coast runs NNE–SSW), and the authored description
   fades out into the global field by 0.6° of arc. */
const PAD_E = PAD_EAST;
const PAD_N = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
const SHORE_LINES = [
  -8.6,   // Indian River, mainland bank
  -3.6,   // Indian River, island bank
  5.6,    // Banana River, island bank
  9.2,    // Banana River, cape bank
  13.4,   // Atlantic shore of the cape
];
// zone tags by how many shore lines the point sits east of
const SHORE_ZONES = ['mainland', 'lagoon', 'island', 'river', 'barrier', 'ocean'];
const PAD_ZONE_R = 45 / RE;                    // full authored geography inside ~45 km
const PAD_BLEND_R = 67 / RE;                   // 0.6°: hand the coast back to the global mask out here

function padTangent(u, v, out) {
  const lat = (v - 0.5) * Math.PI, lon = (u - 0.5) * 2 * Math.PI, cl = Math.cos(lat);
  // three's sphere direction (coslat·coslon, sinlat, -coslat·sinlon), projected on the pad's east/north
  const px = cl * Math.cos(lon), py = Math.sin(lat), pz = -cl * Math.sin(lon);
  const up = px * PAD_UP.x + py * PAD_UP.y + pz * PAD_UP.z;
  if (up < 0.8) { out.x = 1e9; out.y = 1e9; out.a = 0; return; }      // far from the pad; no authored coast
  out.x = RE * (px * PAD_E.x + py * PAD_E.y + pz * PAD_E.z);
  out.y = RE * (px * PAD_N.x + py * PAD_N.y + pz * PAD_N.z);
  const ang = Math.acos(Math.min(1, up));
  out.a = 1 - smoothS(PAD_ZONE_R, PAD_BLEND_R, ang);
}

const _tp = { x: 0, y: 0, a: 0 };
function lineX(k, yKm) {
  // authored NNE trend (tan 20° drift) plus a 150 km-scale wobble so the shore CURVES: the old
  // 3.2 km/90 km wobble was too small to bend a coast seen across the whole island, and five
  // ruler-straight parallel bands 5 km apart is exactly the painted-stripe look round 5 rejected
  return SHORE_LINES[k] + 0.34 * yKm
    + (noise((yKm + 50 * k) / 150, 0.5, 4, 400 + k) - 0.5) * 7.5;
}

/* Signed distance to the nearest authored shore line (negative = land), NaN-free everywhere;
   1e9 outside the pad neighbourhood so min()s ignore it. */
export function padShoreSd(u, v) {
  padTangent(u, v, _tp);
  if (_tp.a <= 0) return 1e9;
  let best = 1e9;
  for (let k = 0; k < 5; k++) best = Math.min(best, Math.abs(_tp.x - lineX(k, _tp.y)));
  const zone = padShoreZone(u, v);
  const land = zone === 'mainland' || zone === 'island' || zone === 'barrier';
  return (land ? -best : best);
}

export function padShoreZone(u, v) {
  padTangent(u, v, _tp);
  if (_tp.a <= 0) return '';
  let z = 0;
  for (let k = 0; k < 5; k++) if (_tp.x > lineX(k, _tp.y)) z++;
  return SHORE_ZONES[z];
}

/* Zone → authored colour, shared by the far bake and the near patch so the same shapes and the
   same tones appear at every LOD: shallow shelf in the two lagoons, sand where the land meets the
   water (a real barrier island is dunes), grassland and marsh inland with 2 km forest patches,
   plain ocean beyond the cape. The concrete footprint stays concrete because the pad's own meshes
   sit on top of all of it. */
export function padAuthored(u, v, near = 0) {
  const zone = padShoreZone(u, v);           // fills _tp
  if (!zone) return null;
  if (near && _tp.a > 0) {
    /* The built world, in the ground colour: the LC-39 concrete apron. The reviewer's "flat green
       sheet" — nothing on the map said a launch complex stood here. It sits at the finest vertex
       spacing (25 m under the vehicle) so its edge survives sampling. A crawlerway was tried and
       deleted: 560 m wide against a cap whose spacing widens to >1 km, it aliased into dashes —
       the exact "faster than the mesh" failure this file's rules already name. */
    /* Round 6b (user: "the whole planet should be ONE continuous beautiful planet"): the 1.5 km
       chamfered plate with its 0.11 km dark stroke was a grey slab that dominated every pad view
       — from 1 km back the perspective turned it into a parallelogram bigger than the horizon.
       The real LC-39 pad area is a circle a few hundred metres across, and there is NO dark
       stroke any more. */
    const rr = Math.hypot(_tp.x, _tp.y);
    /* Round 6b, second pass — the first version of this ramp (smoothS over 0.30–1.25 km at 0.9)
       was measured in a fresh pad-wide frame and it was STILL a slab: smoothS(0.30,1.25,0.6) = 0.24
       leaves the mix 68 % concrete at 600 m, so the grey field ran nearly a kilometre and the
       rounded-square silhouette read as a plate from 1.1 km back. Concrete core 360 m, ramp to
       zero by 920 m, peak 0.85: 500 m sits at ~half tone, 700 m at ~a tenth. The chamfered-square
       core from review3 is gone — square corners at 440–560 m were what made the silhouette read
       as geometry; with a real gradient there is no iso-contour left to alias into octagon teeth. */
    /* The complex itself is geometry now (js/pad.js: hardstand, crawlerway, perimeter road), which
       can hold an edge the patch's vertices cannot. What is left for the ground colour is the wear
       around it: grass thinning toward the hardstand, a third of the way to concrete at most. */
    if (rr < 0.7) {
      const t = (1 - smoothS(0.2, 0.7, rr)) * 0.35;
      const k = C.concrete, o = C.grass;
      return [k[0] + (o[0] - k[0]) * (1 - t), k[1] + (o[1] - k[1]) * (1 - t), k[2] + (o[2] - k[2]) * (1 - t)];
    }
  }
  if (zone === 'lagoon' || zone === 'river') return C.shelf;
  if (zone === 'ocean') return C.ocean;
  /* Beach → dune grass → field in three graduated bands. The old single 1.4 km C.desert board
     is the brown plank that ringed the pad horizon: from 6 km back the two shores of the
     island stack into one saturated sand stripe. Half the width, and the landward half is
     dune grass, so the transition is a gradient the eye reads as coast, not a painted stripe.
     Gradation by signed distance only — no noise lattice: colour that varies faster than the
     coarsest vertex on the cap aliases into wedges (see the ground-shade rule in AGENTS.md). */
  const sd = padShoreSd(u, v);
  if (sd > -0.55) return C.desert;
  if (sd > -1.7) return C.dune;
  /* Flat grassland. This line used to threshold a 2.2 km lattice, then to ease a 60 km one; both were
     wrong in the same way. The ground mesh samples it at 25 m under the vehicle and 3 km at its rim, so
     a hard decision aliased into a fan of wedges, and a smooth decision on a value-noise lattice is a
     bilinear surface whose clamped threshold is a straight line — the seam that replaced them. Colour
     that varies faster than the mesh, or along the lattice rather than the landscape, is the "horrific"
     verdict. Zones carry the shape here (lagoon, marsh, beach, sea) and the blurred global paint carries
     everything beyond them; in between the ground is one brush of grass. */
  return C.grass;
}

/* Authored dominance 0..1: 1 = trust padShoreSd/zone, 0 = pure global mask. Colour mixes on this. */
export function padShoreWeight(u, v) {
  padTangent(u, v, _tp);
  return _tp.a;
}

/* The blended shore the near level draws: authored distance near the pad, global elsewhere. */
export function shoreDistance(coast, u, v) {
  const g = coast ? sampleGrid(coast, u, v) : 1e9;
  const a = padShoreSd(u, v);
  const w = padShoreWeight(u, v);
  return w * a + (1 - w) * g;
}

/* ---- near-level extras: the same height function the patch uses, shared with camera getters.
   Earth only — the Moon deliberately has no near level. */

export function fineEarth(u, v) {
  const f1 = noise(u, v * 2, period(EARTH_CIRC, 0.9), 201);
  const f2 = noise(u, v * 2, period(EARTH_CIRC, 0.19), 211);
  return (f1 - 0.5) * 0.034 + (f2 - 0.5) * 0.013;                  // ±~24 m of ground the 20 km grid cannot show
}
