import * as THREE from 'three';
import { RM } from './constants.js';
import { MOON } from './palette.js';
import {
  FW, FH, pixels, openClose, boxSignal, shareBelow, quantile, hash2, noise, period, fbm, smoothS,
} from './paintkit.js';

/* The Moon's paint job and its crater populations. */

const MOON_CIRC = 2 * Math.PI * RM;

export async function paintMoonJob(path) {
  const src = await pixels(path);
  /* Paint at 4× the shipped sheet (4096 × 2048, 2.7 km/texel). At the native 1024 the albedo
     stamps of the 4–18 km pockmark tier land on ONE texel each, and a 1–2 px dash stamped on the
     same 10.7 km lattice that quantises the crater centres is exactly the grid-aligned "tone
     block ladder" review 6 measured from 140 km (frame 10) and 9 km (frame 11); at the round-7
     2048 the near patch magnified 5.3 km texels into visible 300 px plates (measured on the
     Nearest-mag skim, 2026-11-09 — the pixel grid itself became the complaint). 2.7 km/texel
     puts the smallest drawn bowl on ~3 texels and the 26 km ring on ~10. Bilinear here only
     resamples the photograph; every bowl the pipeline draws after this point is analytic and
     scales automatically in km. The relief grid stays FW × FH — buildMoonField re-samples blur
     by index, so physics and the far mesh are untouched. The kernels below doubled their radius
     with the canvas to hold their km; boxSignal's sliding windows hold the paint cost. */
  const w = src.w * 4, h = src.h * 4;
  const lum = new Float32Array(w * h);
  const luma = (x, y) => { const o = (y * src.w + x) * 4, d = src.data;
    return (d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11) / 255; };
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * src.h / h - 0.5;
    const y0 = Math.max(0, Math.min(src.h - 1, Math.floor(fy)));
    const y1 = Math.min(src.h - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * src.w / w - 0.5;
      const x0 = Math.floor(fx);
      const xa = ((x0 % src.w) + src.w) % src.w, xb = (x0 + 1) % src.w;   // longitude wraps
      const wx = fx - x0;
      lum[y * w + x] = (luma(xa, y0) * (1 - wx) + luma(xb, y0) * wx) * (1 - wy)
                     + (luma(xa, y1) * (1 - wx) + luma(xb, y1) * wx) * wy;
    }
  }
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) { sum += lum[yy * w + ((x + dx + w) % w)]; n++; }
      }
      blur[y * w + x] = sum / n;
    }
  }
  /* The mare/plain boundary is the one edge on this body that has to read as DRAWN, and a threshold
     on the 3×3-blurred field cannot do that: measured on the shipped sheet the dark plains amount to
     3.2 % of the canvas spread over 5 139 separate runs with 12 248 boundary texels, 57 of every 100
     of them 90° step corners — a JPEG staircase, which is what the review read as a soft border. The
     Earth coastline already solves this by cleaning the mask rather than the picture, but a majority
     filter is the wrong tool here: it eats area (one pass costs a quarter of every mare, two passes
     37 %) because a mare is a low-contrast region, not a binary coast. So smooth the FIELD first and
     take the cut back down to the same area: boxSignal at radius 3 (32 km) then the value below which
     the same share of texels lie. Measured at that equal area — boundary 12 248 → 5 609 texels,
     5139 runs → 1 976, corners per 100 boundary texels 56.7 → 48.7. The maria in the painting are
     then one flat tone inside one round outline, which is what a cartoon mare looks like. */
  const wide = blur.slice();
  boxSignal(wide, w, h, 28);
  boxSignal(wide, w, h, 20);          // round 6: r7+r5 ≈ a 340 km kernel at 1024; rounds 7/8 double
                                       // the radii with the canvas so the kernel stays 340 km. The r7-only cut
                                       // still cut maria into jigsaw arcs (review 5, frames 11/13)
  const mareCut = quantile(wide, shareBelow(blur, 0.36));
  const rawMare = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) rawMare[i] = wide[i] < mareCut ? 1 : 0;
  /* Field smoothing fixes WHERE the boundary sits; this fixes what it looks like. The cut still
     wears the 34 km staircase of the canvas lattice — measured on the painted sheet, 38.9 corner
     texels per 100 boundary texels, and from 9 km that staircase IS the polygon: flat maria with
     seven straight edges and hard lozenge corners (round-5 review frame, the mare at right). A
     binary open (erode, erode, dilate, dilate on the 4-neighbourhood) shaves convex corners and
     one-texel spikes; the following close fills concave notches. Both are area-preserving to
     first order — the painted mare share measured 3.65 % before and after on the shipped canvas
     — and 34 km is under a tenth of the smallest mare anyone views whole, so shapes survive.
     Edges clamp to self so polar maria are not shaved at the map border. */
  const mare = openClose(rawMare, w, h, 8);   // 8 rounds at 2.7 km = the same 34 km corner shave
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = blur[i];
    const col = mare[i] ? MOON.maria : v < 0.47 ? MOON.mid : v < 0.62 ? MOON.high : MOON.bright;
    const o = i * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
  }
  mareCollar(out, mare, w, h);
  stampCraterAlbedo(out, blur, w, h);
  stampMidAlbedo(out, w, h);
  /* Gentle large-scale albedo mottling: ~376 km wavelength, second octave 188 km, quantised to
     steps of 1.5 % (levels −3…+3, so peak ±4.5 %; 37 % of texels sit on 0). A 9 km approach looks
     through a 440 km window, and inside one the painted ground was before this one flat class tone
     plus bowls — the reviewer's "sheet". The
     mottle is quantised, not smooth (flat factors are cel tones, and a smooth field would be
     re-stepped by the ramp anyway), it lands IDENTICALLY on both sides of a mare border, so the
     round-4 quantile-preserving cut keeps its step and its corner statistics, and 376 km is
     over a hundred times the cap's widest vertex spacing (3 km at the rim), so the near bake can
     never staircase on it. Two octaves over 524 k texels: 14 ms on the paint pass (measured,
     best of 5). */
  const mottleP = period(MOON_CIRC, 376);
  for (let y = 0; y < h; y++) {
    const v = 1 - (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const lvl = Math.round((fbm((x + 0.5) / w, v * 2, mottleP, 2, 211) - 0.5) * 6);
      if (!lvl) continue;
      const k = 1 + lvl * 0.015, o = (y * w + x) * 4;
      out[o] *= k; out[o + 1] *= k; out[o + 2] *= k;
    }
  }
  /* Contrast curve (round 8, measured on the skim frames): the painted plate separation —
     mare 100 / mid 135 / high 157 / bright 176 — survives the toon ramp only as a whisper once
     it is lit, and review 7's "defocused cowhide" was partly just this: drawn edges with a 15 %
     luma budget. Push every drawn edge ×1.5 about the mid tone (mare 100 → 79, high 157 → 166,
     young rays ride toward white); the mare/mid gate in moonPatchDetail keys at 0.42–0.47,
     which stays inside the WIDENED gap, and the mottle scales to ±6.8 % — still slower than
     anything on the mesh. The far mesh gains the same curve: the disc stops reading as one grey
     plate from orbit, which was review 6's frame-10 complaint. */
  for (let i = 0; i < out.length; i += 4) {
    out[i] = (out[i] - 140) * 1.5 + 140;
    out[i + 1] = (out[i + 1] - 140) * 1.5 + 140;
    out[i + 2] = (out[i + 2] - 140) * 1.5 + 140;
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return { canvas: cv, ...buildMoonField(blur, w, h, mare) };
}

/* Every mare texel that touches open plain drops to MOON.collar: a one-texel stroke drawn on the
   INSIDE of the border, which is how a cartoon closes a shape — the eye reads the edge of the dark
   plain from the stroke, not from the tone difference between two grey plates that a bare threshold
   leaves there. Measured across the 3 976 straddling texel pairs of the shipped sheet, the painted
   tone changes by 13.8 levels of 255 at a mare border today; with the stroke it changes by 64.7,
   over a band 2.3 texels (25 km) wide walking inward. Re-measured 2026-11-09 after the daylight
   palette (9 064 straddling samples, both edge directions): 64.1 → 54.1 levels, area 3.32 % and
   corner-pair share 50.7 % identical — the mask never moved; the step narrowed with the palette,
   not with the stroke. Drawn before the crater passes so a bowl
   sitting on the rim of a mare still paints over its own stroke. */
function mareCollar(out, mare, w, h) {
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : y, yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mare[i]) continue;
      const xm = (x + w - 1) % w, xp = (x + 1) % w;
      if (mare[yu * w + xm] && mare[yu * w + x] && mare[yu * w + xp] &&
          mare[y * w + xm] && mare[y * w + xp] &&
          mare[yd * w + xm] && mare[yd * w + x] && mare[yd * w + xp]) continue;
      const o = i * 4;
      /* Round 6: the stroke used to be an absolute value — a single 10.7 km texel of rgb(79,83,93)
         whose mip chain turned every mare border into a string of stamp-like dark dashes at orbit
         range (review 5, frame 10). Blending 80 % keeps 0.8·54.1 = 43 levels of step at native
         resolution (still the cartoon edge the pass exists for) and takes the minified dash to
         grey-in-grey instead of black-on-white. */
      out[o] += (MOON.collar[0] - out[o]) * 0.8; out[o + 1] += (MOON.collar[1] - out[o + 1]) * 0.8;
      out[o + 2] += (MOON.collar[2] - out[o + 2]) * 0.8;
    }
  }
}

/* ---- the Moon: maria flat, highlands rolling, craters hashed not scattered ---- */

function buildMoonField(blur, sw, sh, mare) {
  const w = FW, h = FH;
  const km = new Float32Array(w * h), hi = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const srow = (((y * sh / h) | 0)) * sw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = blur[srow + ((x * sw / w) | 0)];
      /* The painting's own maria boundary, feathered over its tone band: the dark texels are flat
         basalt plains and stay at exactly 0; the highlands stand ABOVE them by a real elevation
         difference as well as a brighter tone, so descending to a mare reads as descending into
         terrain — a step the 512-segment mesh carries without any near level. The flat part is keyed
         on the painted mare mask rather than on this feather so that a texel is never drawn as dark
         plain while standing at half highland height: the paint and the ground agree on where the
         mare is (the feather still shapes the climb out of it). */
      const m = mare && mare[srow + ((x * sw / w) | 0)] ? 0 : smoothS(0.36, 0.47, b);
      hi[i] = m;
      if (!m) continue;
      const u = (x + 0.5) / w;
      /* Amplitudes sized so the ±2 km cap is a landing-honesty limit, not a shaping tool: an
         earlier build summed these terms to ~3.6 km and 19 % of the Moon pinned at the clamp —
         a fifth of the surface rendered as a plateau with no craters in it. Now the composite
         tops out at ~1.98 before craters, and rims are scaled to stay under the cap too, so
         nothing depends on clipping to look right. */
      const roll = (fbm(u, v * 2, 12, 3, 61) - 0.5) * 1.7;               // ±~0.85 km highland swell
      const rn = noise(u, v * 2, 32, 77);
      const ridge = (1 - Math.abs(rn * 2 - 1));
      const massif = ridge * ridge * 0.65;                                // spines up to ~0.65 km
      const fine = (noise(u, v * 2, 192, 123) - 0.5) * 0.25;              // ±0.125 km roughness
      km[i] = m * (0.35 + roll + massif + fine);                          // 0.35 km mare-highland step
    }
  }
  stampCraters(km, hi, w, h);
  stampMidRims(km, w, h);
  /* Soft knee above 1.7 km instead of letting the clamp do the shaping: a hard ±2 cap clipped
     ~3 % of texels (mostly crater rims on massif flanks) into flat plateaus. Compressing the
     headroom preserves ordering and relief everywhere and leaves the cap untouched in practice. */
  for (let i = 0; i < km.length; i++) {
    let k = km[i];
    if (k > 1.7) k = 1.7 + (k - 1.7) * 0.3;
    km[i] = THREE.MathUtils.clamp(k, -2.0, 2.0);
  }
  return { field: { w, h, km } };
}

/* ~560 craters per run, placed uniform-on-sphere by hash (asin of the v sample — equirectangular
   latitude sampling would otherwise pile every small crater near the poles). The size floor sits
   where the 512-segment mesh can still resolve a bowl — ~45 km radius, 4 vertices across — because
   the Moon has no near level anymore: what the mesh cannot show, nothing shows. Depths and rims
   scale with size and are capped to leave headroom under the ±2 km honesty limit — saturation at
   the clamp flattens whole regions into plateaus.

   The list is generated ONCE and consumed twice: the height pass (stampCraters) displaces the
   mesh, and paintMoonJob paints the same bowls' albedo — bright rim, shadowed floor, ray systems
   on the young ones. Displacement alone went away at noon sun, when the whole face sits in one
   ramp band and a cratered highland looked as blank as a ping-pong ball; the bright ring is what
   makes the geology legible from every sun angle, and it is exactly how the cartoons do it. */
let _craters = null;
export function moonCraters() {
  if (_craters) return _craters;
  _craters = [];
  for (let c = 0; c < 560; c++) {
    const hu = hash2(c, 0, 11);
    const hv = hash2(c, 1, 23);
    const hr = hash2(c, 2, 37);
    const hy = hash2(c, 3, 53);
    const lat = Math.asin(2 * hv - 1);
    const r = 45 + 300 * hr * hr * hr;
    const depth = Math.min(0.98, 0.10 + r * 0.0040);
    const rim = Math.min(0.69, 0.15 + depth * 0.55);
    _craters.push({
      cx: (hu * FW) | 0,
      cy: (((90 - lat * 180 / Math.PI) / 180) * FH) | 0,
      r, depth, rim,
      young: hy > 0.90,                       // ~10 % ray systems: Tycho-class fresh impactors
      spokes: 7 + ((hash2(c, 4, 71) * 6) | 0),
      phase: hy * 6.283,
    });
  }
  return _craters;
}

/* ---- the pockmark tier: 6 000 bowls of 4–18 km, one population, three consumers ----

   The 560 big craters are the only bowls the painted map and the relief grid have ever carried, and
   the review measured what that leaves on screen: a 440 km window holding one or two of them and a
   surface luminance that wanders 4 %. Real mare and highland ground at this scale wears tens of
   thousands of 10–40 km bowls, so this is the missing population.

   Positions are generated on the map's own INTEGER grid first, and the lon/lat the near level uses is
   then derived from the grid index by the exact inverse of sampleGrid's mapping (u = cx/FW,
   v = 1 − cy/FH, checked against the texel-centre convention in the relief header above). The painted
   bowl, the relief crest and the analytic patch bowl therefore sit on one point to the metre instead
   of drifting by up to half a texel (5.3 km): three consumers, one position, no decorrelation.

   Sizes: 4 km down-cuts where a 25 m-spaced vertex can still resolve a bowl, and 18 km up-cuts below
   the 45 km floor of the walled plains the tier above draws. `rim` is the crest height, capped at
   0.15 km: visible in silhouette at grazing sun, harmless to a lander, and the ONLY thing this tier
   ever adds to the ground — the floor is albedo, never a dig (contact rule, agents.md). ~8 % are
   young and throw short ray spokes at a fifth less amplitude than the big ray craters, so the largest
   and youngest bowls stay the brightest features on the disc. */
const MID_N = 6000;
const MID_RIM = 0.15;                   // km crest cap: everything this tier may add to the ground
const MID_DRAW = 4;                     // km: the smallest radius a 2.7 km/texel map can draw (round 8 quadrupled the canvas; was 8 at 5.3 km/texel)
const MID_BAND = 1.6;                   // crater radii out to which the painted crest still bites
let _midCraters = null;
export function moonMidCraters() {
  if (_midCraters) return _midCraters;
  _midCraters = [];
  for (let c = 0; c < MID_N; c++) {
    const hu = hash2(c, 16, 19), hv = hash2(c, 17, 47), hr = hash2(c, 18, 83), hy = hash2(c, 19, 29);
    const cx = (hu * FW) | 0;                                       // uniform in longitude
    const cy = ((0.5 - Math.asin(2 * hv - 1) / Math.PI) * FH) | 0;  // uniform ON the sphere
    const rKm = 4 + 14 * Math.pow(hr, 1.7);
    const cr = {
      cx, cy,
      lon: (cx / FW - 0.5) * 2 * Math.PI,
      lat: (0.5 - cy / FH) * Math.PI,
      rKm,
      rim: Math.min(MID_RIM, 0.05 + rKm * 0.006),                   // 74–150 m, positive-only
      young: hy > 0.92,                                             // ~8 % ray systems
      spokes: 5 + ((hash2(c, 20, 61) * 4) | 0),
      phase: hy * 6.283,
      fdark: 0.7 + hash2(c, 21, 37) * 0.45,                         // per-bowl floor albedo: one flat
      rayIn: 0.8, rayOut: 2.2, rayAmp: 0.18, rayCut: 0.45,          // floor everywhere was the tell
    };
    craterFrame(cr);
    _midCraters.push(cr);
  }
  return _midCraters;
}

/* ---- near-level detail: craters the canvas can never hold ----

   The painted canvas is 1024×512: 10.6 km/texel. A 12 km crater stamped there is a one-byte
   smudge, and the last kilometres of a descent were flying over nothing (measured: a 9 km pass
   showed zero surface features). The near patch asks for its ground ANALYTICALLY instead: the
   3–45 km population below, the micro tier, and the whole pockmark tier — the map's own bowls —
   evaluated per vertex at rebuild time. Height is rim-only — the patch stands on the mesh and never
   cuts into it, the same rule the Earth patch follows, so contact on the RM sphere stays honest and
   no crater can sink the vehicle below the ground it landed on — and the bowl itself is drawn in
   tone: dark floor, bright rim, ray fans where a young one throws them. */

/* Bake a crater's local east/north basis once (p(lon,lat) = (−cosλcosφ, sinλ, cosλsinφ) in the
   mesh-local frame → east = (sinλ, 0, cosλ), north = (−sinλcosφ, cosφ, −sinλsinφ)). The directional
   rim bake projects the sun onto this basis per vertex it touches; doing the four trig calls here
   keeps the per-vertex loop to multiplies. Shared with the pockmark tier, which is consumed here too. */
function craterFrame(cr) {
  cr.sl = Math.sin(cr.lon); cr.cl = Math.cos(cr.lon);
  cr.sla = Math.sin(cr.lat); cr.cla = Math.cos(cr.lat);
}

/* "Standing on mare", in the units the caller actually has: the painted canvas luminance of
   MOON.maria is sRGB 0.384 and of MOON.mid 0.522 (measured off the round-5 palette bytes), and
   MOON.collar 0.325, so a cut at 0.46 separates the dark plains — and the bowl floors stamped
   into them — from everything brighter. */
const RAY_MARE_LUM = 0.46;

let _smallCraters = null;
function moonSmallCraters() {
  if (_smallCraters) return _smallCraters;
  _smallCraters = [];
  for (let c = 0; c < 2400; c++) {
    const hu = hash2(c, 5, 91), hv = hash2(c, 6, 57), hr = hash2(c, 7, 31), hy = hash2(c, 8, 17);
    const rKm = 3 + Math.pow(hr, 2.2) * 42;                    // many small, few big
    const cr = {
      lon: hu * Math.PI * 2 - Math.PI, lat: Math.asin(2 * hv - 1), rKm,
      rim: 0.08 + Math.min(0.22, rKm * 0.006),                 // ≤ 300 m: a rim you can see in silhouette
      young: hy > 0.93, spokes: 6, phase: hy * 6.283,
      fdark: 0.72 + hash2(c, 9, 43) * 0.4,                     // per-bowl floor albedo 0.72–1.12: a
      rayIn: 1.8, rayOut: 4.2, rayAmp: 0.30, rayCut: 0,        // flat floor across every bowl was the
    };                                                         // tiling tell
    craterFrame(cr);
    _smallCraters.push(cr);
  }
  /* Micro tier: 4 000 more at 0.3–2.5 km. The 2 km view measured nearly empty (one mare blob, one
     small crater on smooth grey) because mid-tier spacing leaves a 440 km cap holding ~9 bowls;
     this tier adds ~11 more within the lookup, 25 m-spaced vertices resolve a 0.6 km bowl, and at
     4 km they read as the pockmarked highland texture real mare/highland terrain wears. Rims cap
     at 80 m — visible in silhouette at grazing sun, harmless to contact — and NO ray systems: a
     ray fan at 0.4 r would smear over four neighbours. They ride the same 6° buckets below; the
     reach maths is unchanged (1.8 r = 4.5 km ≪ 187 km). */
  for (let c = 0; c < 4000; c++) {
    const hu = hash2(c, 12, 29), hv = hash2(c, 13, 79), hr = hash2(c, 14, 67);
    const rKm = 0.3 + hr * hr * 2.2;                           // 0.3–2.5 km, many small, few big
    const cr = {
      lon: hu * Math.PI * 2 - Math.PI, lat: Math.asin(2 * hv - 1), rKm,
      rim: 0.02 + Math.min(0.06, rKm * 0.025),                 // ≤ 80 m, positive-only as every rim is
      young: false, spokes: 0, phase: 0,                       // no rays, and hash2 keys disjoint from
      fdark: 0.7 + hash2(c, 15, 59) * 0.45,                    // the mid tier's, so the lists decorrelate
    };
    craterFrame(cr);
    _smallCraters.push(cr);
  }
  /* The pockmark tier rides THIS list and THESE buckets: it is not a near-level population that
     happens to resemble the map's, it is the map's population pushed in as the very same objects —
     cx/cy on the 1024×512 grid, the lon/lat derived from those indices, the same rKm and rim the two
     stamps use. Measured over 400 random sites: a 440 × 440 km window (the size of the near patch)
     holds 32.0 bowls from the two populations that existed before and 62.6 with this tier in it, and
     15.2 % of the surface is some bowl's floor (mid tier 14.5 %, pockmark tier 5.75 %, micro 0.25 %). */
  for (const cr of moonMidCraters()) _smallCraters.push(cr);
  // 6° buckets (181.9 km, past the 1.8 r = 81 km bowl reach of every tier here): a rebuild asks
  // 26k vertices, and without this every vertex would walk all 12 400 craters. A colliding bucket
  // key only costs a wasted distance test — every consumer below filters by true distance. Only the
  // mid tier's ray fans (4.2 r = 189 km at r = 45 km) reach beyond one bucket width, and what that
  // clips at the far bucket edge is the outermost 6 % of a fan's amplitude.
  const B = 6 * Math.PI / 180, buckets = new Map();
  for (const cr of _smallCraters) {
    const bi = Math.floor((cr.lon + Math.PI) / B), bj = Math.floor((cr.lat + Math.PI / 2) / B);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const k = (bi + di) * 977 + (bj + dj);
      let b = buckets.get(k); if (!b) buckets.set(k, b = []);
      b.push(cr);
    }
  }
  _smallCraters.buckets = buckets; _smallCraters.B = B;
  return _smallCraters;
}

/* Bilinear value noise on a world-km lattice, hash2 at the corners: C0, deterministic, and fixed
   to the Moon (uv-derived), so a patch rebuild re-samples the same field and the pitting never
   swims as the vehicle moves. */
function pitNoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), e = hash2(xi + 1, yi + 1, s);
  const lo = a + (b - a) * ux, hi = c + (e - c) * ux;
  return lo + (hi - lo) * uy;
}

/* globe uv → { h: rim km (≥ 0), tone: albedo multiplier }. baseLum is the painted canvas here
   (0..1); the dark maria catch the young craters' ray fans brighter, as they do on the map pass.
   sun is the sun direction as a unit vector in the caller's mesh-local frame (the frame the uv is
   in), or null before the scene light exists — then every cs below sits at 0 and the bake falls
   back to the old omnidirectional look, never NaN. With it each bowl is a crescent: the sunward
   rim crest keeps the full bright line, the anti-sun crest throws a shadow, the floor washes out
   sunward and deepens anti-sunward. The crest keeps a 45 % base ring because displacement-only
   craters vanished at high sun on the far mesh (AGENTS.md) — the ring must read at every angle;
   flat shading only where the sun is truly at zenith, which is the honest answer there.

   The tone COMPOSES by the dominant crater, not by multiplication: a 220 km patch sits over ~70 of
   these bowls, and a naive product of every floor factor compounds to black (measured: the whole
   near field rendered 0.004 linear — 0.58 to the fifth). The deepest floor and the brightest rim at
   a point win; rim HEIGHTS take the max too, so two rims that touch never stack into a spike the
   lander could perch on. Both profiles stay C0 — a stepped floor would print a ring in vertex colour. */
export function moonPatchDetail(u, v, baseLum, sun, pitAmp = 1, pitAmp2) {
  const L = moonSmallCraters();
  const lon = (u - 0.5) * Math.PI * 2, lat = (v - 0.5) * Math.PI;
  const list = L.buckets.get(Math.floor((lon + Math.PI) / L.B) * 977 + Math.floor((lat + Math.PI / 2) / L.B));
  let h = 0, dark = 0, lit = 0, ray = 0;
  if (list) {
    /* Lat and lon are RADIANS, so the kilometres per step is RM per radian. This line used to read
       π/180·RM — kilometres per DEGREE — and so shrank every distance by 57.3×: a brute-force scan of
       the population under the old units put 632 craters within 1.8 r of a random point, where
       uniform placement gives 0.4, so every vertex sat inside its whole bucket at once and the
       max-composition rule below locked the result to a constant (measured on the shipped build:
       tone confined to [0.7185, 0.8968] and never reaching 1, a crest above 5 m under 97.6 % of the
       cap, crest height pinned between 0.07 and 0.116 km). That saturation, not the population count,
       is the "luminance varies 0.37 → 0.41" the review measured. With true units a point sits inside
       0.4 bowls, 37 % of points sit on a crest at all, and the tone spans 0.709 … 1.298. */
    const kmr = RM, clat = Math.max(0.05, Math.cos(lat));
    for (const cr of list) {
      let dlon = lon - cr.lon;
      if (dlon > Math.PI) dlon -= 2 * Math.PI; else if (dlon < -Math.PI) dlon += 2 * Math.PI;
      const ey = (lat - cr.lat) * kmr, ex = dlon * clat * kmr;
      const dd = Math.hypot(ex, ey) / cr.rKm;
      if (dd < 1.8) {
        /* cs = dot(unit radial from the crater centre, unit sun-tangent) in the crater's east/north
           frame — ex/ey are km in exactly that frame, sun is projected on its prebaked basis, so
           the whole weighting is ~10 multiplies per vertex-crater pair. den carries both norms;
           den ≈ 0 means the sun stands at zenith here or the vertex IS the centre: cs = 0. */
        let cs = 0;
        if (sun) {
          /* The prebaked basis here used to be (sinλ, 0, cosλ) plus a vector that is neither
             north nor −north — east came in negated against the ex/ey offsets above, which run
             in the mesh's true +θ/+φ directions (terrain places this crater at θ = π + lon).
             Measured 2026-11-09 on the baked cap at 22° local sun elevation: the ANTI-sun rim
             arc rendered 0.999 against the sunward rim's 0.855 — the crescent was painted on
             the night side. Derived from the mesh: east = (−sinλ, 0, −cosλ),
             north = (−sinφ·cosλ, cosφ, sinφ·sinλ). */
          const sE = -(sun.x * cr.sl + sun.z * cr.cl);
          const sN = sun.y * cr.cla - (sun.x * cr.cl - sun.z * cr.sl) * cr.sla;
          const den = Math.hypot(sE, sN) * dd * cr.rKm;
          if (den > 1e-6) cs = (ex * sE + ey * sN) / den;
        }
        if (dd < 1.45) {
          /* Plate with an ABSOLUTE-km feather (round 8): the r-relative falloffs — (1−t²)² over
             1.3 r, then the first plateau attempt's 0.43 r — are 2–8 km gradients on a mesh whose
             mid-field cells run 0.5–2 km, so every bowl rendered as a soft-edged fog blob at a
             skim (measured: tone off → the mesh is flat grey, all the visible mush was this law).
             A fixed 0.4 km feather is 2–10 cells wide everywhere it can be seen: a hard plate. */
          const FE = 0.4;
          let w;
          if (dd * cr.rKm <= cr.rKm - FE) w = 1;
          else { const s = (dd * cr.rKm - (cr.rKm - FE)) / FE; w = s >= 1 ? 0 : 1 - s * s * (3 - 2 * s); }
          const dk = w * cr.fdark * (0.62 - 0.38 * cs);
          if (dk > dark) dark = dk;
        }
        /* Rim crest: a FLAT band of absolute width ~0.9 km (r ± 0.45 km, feathered at both edges),
           not r-relative and not a gaussian — a LINE on screen at every mesh spacing down to ~1 km
           cells, which is what a cartoon crater rim is. */
        const rKm2 = cr.rKm, band = 0.45, fe2 = 0.15;
        const dEdge = Math.abs(dd * rKm2 - rKm2);
        let hw;
        if (dEdge >= band) hw = 0;
        else if (dEdge > band - fe2) { const s = (band - dEdge) / fe2; hw = s * s * (3 - 2 * s); }
        else hw = 1;
        if (cr.rim * hw > h) h = cr.rim * hw;
        const lc = 0.30 * hw * (0.45 + 0.55 * (cs > 0 ? cs : 0));
        if (lc > lit) lit = lc;
        const sh = 0.55 * hw * (cs < 0 ? -cs : 0);
        if (sh > dark) dark = sh;
      }
      /* Rays are their own band, not an else-branch of the bowl: the pockmark tier throws them from
         0.8 r, which is inside the bowl, while the mid tier still waits until 1.8 r — both read off
         the crater, so the two tiers cannot drift apart from how the map draws them. The amplitude
         mapping mirrors the map pass exactly (full over bright ground, 0.55 of it over mare, where a
         bright spoke matters most) and the gate is the PAINTED luminance scale — MOON.maria measures
         sRGB 0.384 and MOON.mid 0.522 — where the old `baseLum < 0.4` was below every tone this
         canvas contains: measured, the patch threw zero ray fans over 36 000 sample sites. */
      if (cr.young && dd >= cr.rayIn && dd < cr.rayOut) {
        const sp = Math.cos(cr.spokes * Math.atan2(ey, ex) + cr.phase);
        if (sp > cr.rayCut) {
          const r = cr.rayAmp * (baseLum < RAY_MARE_LUM ? 0.55 : 1) * Math.pow(sp, 10)
            * (1 - (dd - cr.rayIn) / (cr.rayOut - cr.rayIn));
          if (r > ray) ray = r;
        }
      }
    }
  }
  /* Round 8, second attempt — the sun-facing slope term measured, and REJECTED. cs (directional
     derivative along the sun's horizontal, half-lattice step: median |cs| 0.19, p90 0.45 over
     20 000 samples per octave, identical across octaves — hash noise is scale-free) at ±25/42 %
     rendered the whole skim as 1.6 km fog blobs: at a 14° sun every smooth swell's sunward face
     goes bright and its far face dark, which is physically true and visually the exact mush the
     review called out. Shading the smooth field cannot produce crispness — only the craters have
     edges sharp enough to shade into bands. The read moved to GEOMETRY instead (pitH below).
     Round 6b's albedo law is restored verbatim; keeping cs in any form here is a documented
     dead end, so it is gone, not tuned. */
  const pit = 0.80 + (0.55 / 0.70) * (0.45 * pitNoise(lon * RM * 4, lat * RM * 4, 913)      // 250 m pitted regolith
                                    + 0.25 * pitNoise(lon * RM * 1.43, lat * RM * 1.43, 57)); // 700 m mare churn
  /* Round 6: a third, COARSE octave (1.6 km lattice). Review 5 measured the skim frame's
     foreground as "a featureless smooth gradient" — at 2.6 km the fine octaves only cover the
     ~1.1 km radius where the warp mesh is under 140 m, and everything past that is ramped off
     against a lattice it cannot resolve. The coarse field keeps readable hollows where the mesh
     runs 0.3-1.6 km (its own pitAmp2 ramp, js/terrain.js), and dies at its alias limit — the
     starburst stays fixed. Round 6b: amplify around the median — a linear octave reads as smoke,
     an amplified one clips to flat plains and flat pit floors with steep sides between, which is
     what hollows look like on a vacuum body. n′ = clamp((n−0.5)·3+0.5); the softer (×2.4, ±12 %)
     variant measured leopard-print soft, not hollowed — hence the harder knee and 0.84…1.20. */
  const n2 = pitNoise(lon * RM * 0.625, lat * RM * 0.625, 1121);
  const p2 = Math.max(0, Math.min(1, (n2 - 0.5) * 3 + 0.5));
  const pit2 = 0.84 + 0.36 * p2;
  /* Round 8: the hollows' READ is geometry, not albedo. ±25 m of relief on a 1.6 km lattice is
     a 1.8° facet — inside one band of the 8-texel RAMP_MOON at every sun angle, which is why
     this octave never registered however its tone was shaped. At ±95 m (0.19 km floor-to-peak
     before the ×1.4 exaggeration) the cell-to-cell facet spans ~13° at the 14° test sun and
     straddles the ramp's 0.23/0.47 steps: hollows with lit and shaded walls, no fog, because
     the tone stays the round-6b ±18 % (a smooth albedo swing IS fog at this scale — the
     slope-tone experiment above). The patch is display-only (physics lands on RM), so this
     amplitude costs nothing but normals. */
  const pitH = (pit2 - 1) * 0.19 * (pitAmp2 === undefined ? 1 : pitAmp2);
  return { h: h + pitH, tone: (1 - 0.42 * dark + lit + ray) *
    (1 + (pit - 1) * pitAmp) * (1 + (pit2 - 1) * (pitAmp2 === undefined ? 1 : pitAmp2)) };
}

function stampCraters(km, hi, w, h) {
  const kme = MOON_CIRC / w, kmr = Math.PI * RM / h;
  for (const cr of moonCraters()) {
    const { cx, cy, r, depth, rim } = cr;
    const clAt = (yy) => Math.max(0.05, Math.cos((90 - (yy + 0.5) * 180 / h) * Math.PI / 180));
    const rx = Math.ceil(r * 1.6 / (kme * clAt(cy))), ry = Math.ceil(r * 1.6 / kmr);
    for (let dy = -ry; dy <= ry; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      const kx = kme * clAt(y);
      for (let dx = -rx; dx <= rx; dx++) {
        const x = ((cx + dx) % w + w) % w;
        const i = y * w + x;
        if (!hi[i]) continue;
        let ex = (x + 0.5 - cx) * kx;
        if (ex > MOON_CIRC / 2) ex -= MOON_CIRC; else if (ex < -MOON_CIRC / 2) ex += MOON_CIRC;
        const ey = (y + 0.5 - cy) * kmr;
        const dd = Math.sqrt(ex * ex + ey * ey) / r;
        if (dd >= 1.7) continue;
        let add = 0;
        if (dd < 0.82) { const t = dd / 0.82; add -= depth * (1 - t * t); }
        if (dd > 0.55) { const g = (dd - 1.03) / 0.17; add += rim * Math.exp(-g * g); }
        km[i] += add * hi[i];
      }
    }
  }
}

/* The albedo pass over the same craters. Bowls shade darker, rims catch the sun brighter — and the
   young ones throw ray systems, bright spokes that run four crater radii and cross even the maria,
   because Tycho's do. Applied to the classified paint after tone assignment, so a 200 km walled
   plain still gets a drawn circle under noon sun, which displacement + a three-band ramp can never
   show. Stamps land where the height pass stamps: one list, two consumers, no drift by
   construction. */
function stampCraterAlbedo(out, blur, w, h) {
  const sx = w / FW, sy = h / FH;
  const kmr = Math.PI * RM / h;
  const hiAt = (i) => smoothS(0.36, 0.47, blur[i]);
  for (const cr of moonCraters()) {
    const cx = cr.cx * sx, cy = cr.cy * sy;
    const rPx = cr.r / (kmr);                       // rows are the isotropic axis; columns widen by cos
    const ry = Math.ceil(rPx * (cr.young ? 4.8 : 1.7));
    for (let dy = -ry; dy <= ry; dy++) {
      const y = (cy + dy) | 0;
      if (y < 0 || y >= h) continue;
      const clat = Math.max(0.05, Math.cos((90 - (y + 0.5) * 180 / h) * Math.PI / 180));
      const rx = Math.ceil(rPx * (cr.young ? 4.8 : 1.7) / clat);
      for (let dx = -rx; dx <= rx; dx++) {
        const x = ((cx + dx) % w + w) % w;
        const i = (y * w + x) * 4;
        let ex = dx * kmr / clat;
        if (ex > MOON_CIRC / 2) ex -= MOON_CIRC; else if (ex < -MOON_CIRC / 2) ex += MOON_CIRC;
        const ey = dy * kmr;
        const dd = Math.hypot(ex, ey) / cr.r;
        let tone = 0;
        const hiM = hiAt(y * w + x);
        if (dd < 1.7) {
          if (!hiM) continue;                        // maria stay flat and blank, both in height and in tone
          if (dd < 0.82) { const t = dd / 0.82; tone -= (16 + 26 * cr.depth) * (1 - t * t); }
          const g = (dd - 1.06) / 0.20;
          tone += (22 + 26 * cr.rim) * Math.exp(-g * g);
        } else if (cr.young && dd < 4.8) {
          const th = Math.atan2(ey, ex);
          let sp = Math.cos(cr.spokes * th + cr.phase);
          sp = sp > 0 ? Math.pow(sp, 10) : 0;
          const fall = (1 - (dd - 1.05) / 3.75);
          tone += 34 * sp * fall * fall * (hiM ? 1 : 0.55);   // rays cross maria, dimmer there
        }
        if (!tone) continue;
        out[i] = out[i] + tone; out[i + 1] = out[i + 1] + tone; out[i + 2] = out[i + 2] + tone;
      }
    }
  }
}

/* Crests only from the pockmark tier, on the relief grid — maria included. A bowl's floor is albedo
   (stampMidAlbedo here, the patch's tone there); this pass may only ever ADD, capped at MID_RIM,
   because this field is what a lander touches down on and a detail stamp that digs is a hole the
   vehicle falls into (contact rule, agents.md). At 10.7 km per grid texel a 4–18 km crest lands on
   one to four texels: below what the 512-segment mesh can displace, but exactly what the near patch
   reads, and it is why the mare plains stop being a dead 0.000-km sheet — measured on the shipped
   grid, the mare texels standing above zero go from 0 % to 5.3 %. The field's extremes are untouched
   by it: max 2.000 and min −2.000 before and after, 1 758 → 1 801 texels on the +2 km cap and
   68 → 67 on the −2 km one, because the soft knee and the honesty clamp both run after this pass. */
function stampMidRims(km, w, h) {
  const kme = MOON_CIRC / w, kmr = Math.PI * RM / h;
  for (const cr of moonMidCraters()) {
    const cx = cr.cx, cy = cr.cy, rKm = cr.rKm;
    const clAt = (yy) => Math.max(0.05, Math.cos((90 - (yy + 0.5) * 180 / h) * Math.PI / 180));
    const rx = Math.ceil(rKm * 1.45 / (kme * clAt(cy))), ry = Math.ceil(rKm * 1.45 / kmr);
    for (let dy = -ry; dy <= ry; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      const kx = kme * clAt(y);
      for (let dx = -rx; dx <= rx; dx++) {
        const x = ((cx + dx) % w + w) % w;
        let ex = (x + 0.5 - cx) * kx;
        if (ex > MOON_CIRC / 2) ex -= MOON_CIRC; else if (ex < -MOON_CIRC / 2) ex += MOON_CIRC;
        const dd = Math.hypot(ex, (y + 0.5 - cy) * kmr) / rKm;
        if (dd < 0.95 || dd >= 1.45) continue;                    // the crest band, never the floor
        km[y * w + x] += cr.rim * (1 - Math.abs(dd - 1.2) / 0.25);   // → 0 at both edges: stays C0
      }
    }
  }
}

/* The same 6 000 bowls, painted: one hard step down for the floor, one hard step up for the crest,
   and on the young ~8 % a short spoke fan (0.8–2.2 radii) that is THRESHOLDED rather than blurred —
   flat tones, no gaussian tail anywhere, because a bowl smeared over two texels is a grey smudge and
   the whole point of this pass is the edge. Amplitudes sit deliberately under the big craters' (floor
   −(28+16·fdark) = −39…−30 against their −42…−23; crest 22+44·rim = +25…+29 against their +30…+40;
   rays +28 against their +34), so the walled plains and the largest young ray systems stay the
   loudest features on the disc while the ground between them stops being blank.
   Unlike the big pass, these land on maria too: a 200 km walled plain would shatter the flat basalt
   look, but a mare with nothing in it is exactly the empty sheet the review measured, and the Moon's
   maria are themselves heavily bombarded.
   MID_DRAW/MID_BAND are the pen: even at 2.7 km per texel a 4 km bowl is barely two texels, so a
   sub-texel crater is drawn at the smallest legible radius (a 2·MID_BAND·MID_DRAW = 12.8 km ring
   rather than an 8 km one) rather than dropped — same centre as the relief and the analytic patch,
   only the brush floored, which is what a cartoon does and what stops a thousand 4 km bowls
   becoming a thousand coin flips over which single texel gets darkened. */
function stampMidAlbedo(out, w, h) {
  const sx = w / FW, sy = h / FH;
  const kmr = Math.PI * RM / h;                       // km per row; columns widen by 1/cos(lat)
  for (const cr of moonMidCraters()) {
    const cx = cr.cx * sx, cy = cr.cy * sy;
    const rD = Math.max(MID_DRAW, cr.rKm);
    const reach = cr.young ? cr.rayOut : 1.5;
    const ry = Math.ceil(rD * reach / kmr);
    for (let dy = -ry; dy <= ry; dy++) {
      const y = (cy + dy) | 0;
      if (y < 0 || y >= h) continue;
      const clat = Math.max(0.05, Math.cos((90 - (y + 0.5) * 180 / h) * Math.PI / 180));
      const rx = Math.ceil(rD * reach / (kmr * clat));
      for (let dx = -rx; dx <= rx; dx++) {
        const x = ((cx + dx) % w + w) % w;
        let ex = dx * kmr / clat;
        if (ex > MOON_CIRC / 2) ex -= MOON_CIRC; else if (ex < -MOON_CIRC / 2) ex += MOON_CIRC;
        const ey = dy * kmr;
        const dd = Math.hypot(ex, ey) / rD;
        let tone;
        if (dd < 0.8) tone = -(22 + 14 * cr.fdark);             // floor: one hard step, −38…−32
        else if (dd < MID_BAND) tone = 22 + 44 * cr.rim;        // crest: the next one, +25…+29
        else {
          /* Round 6: the spokes used to be a binary `cos > rayCut → +28` — flat straight wedges
             whose jagged edges survived minification as flat pastel polygons at 9 km (review 5,
             frame 11 "flat unlit polygon patches") and as stamp-like dashes along the terminator
             at 600 km (frame 10). The analytic patch already draws its fans with a cos¹⁰ taper;
             the canvas now does the same thing in its own units: angular ramp over the outer
             third of the spoke, linear radial falloff to the spoke tip. Floor and crest keep
             their hard cel steps — those are the bowls, and they are wide enough to survive. */
          const ang = Math.cos(cr.spokes * Math.atan2(ey, ex) + cr.phase);
          const sp = (ang - cr.rayCut) / (1 - cr.rayCut);
          if (sp <= 0) continue;                                 // between the spokes: untouched
          const fall = 1 - (dd - MID_BAND) / (reach - MID_BAND);
          if (fall <= 0) continue;
          tone = 28 * Math.min(1, sp * 3) * Math.min(1, fall * 1.6);
        }
        const i = (y * w + x) * 4;
        out[i] += tone; out[i + 1] += tone; out[i + 2] += tone;
      }
    }
  }
}
