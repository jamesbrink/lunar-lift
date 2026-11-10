import * as THREE from 'three';
import { RE, PAD_UP, PAD_EAST } from './constants.js';
import { C } from './palette.js';
import { noise, period, EARTH_CIRC, sampleGrid, smoothS, hash2 } from './paintkit.js';

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

/* ---- authored geography at the launch site ----

   28.6° N, 80.6° W is Merritt Island. The 20 km-texel land mask straddles this coast and puts the
   whole complex in open ocean, so the Cape is described here instead — not invented, de-quantised:
   the Atlantic beach under a kilometre east of the pad and running NNW past it, the Cape's point
   16 km to the south-east, Mosquito Lagoon behind the barrier beach to the north, the Banana River
   behind the Cape to the south, the Indian River between the island and the mainland 14 km west,
   the turn basin beside the assembly building with its barge canal, and the impoundment ponds in
   the marsh round the pad.

   Everything is km in the tangent frame at PAD_UP: x east along PAD_EAST, y north. One function,
   capeSd(x, y), is the signed distance to the nearest shore (positive = water). It is sampled into
   two textures for the ground shader (js/surface.js): ±72 km at 0.28 km for the far view and
   ±SITE_HALF km at 39 m for the site itself; padShoreSd answers from the same function, and the
   painted map bakes its colours from it, so every level of detail draws one coast. The description
   fades into the global field by 0.6° of arc. */
const PAD_E = PAD_EAST;
const PAD_N = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
const PAD_ZONE_R = 45 / RE;                    // full authored geography inside ~45 km
const PAD_BLEND_R = 67 / RE;                   // 0.6°: hand the coast back to the global mask out here

/* A smooth curve x(y) through knots [y, x] (ascending y): cubic Hermite with central tangents. */
function curve(knots) {
  const n = knots.length, m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = knots[Math.max(0, i - 1)], b = knots[Math.min(n - 1, i + 1)];
    m[i] = (b[1] - a[1]) / (b[0] - a[0]);
  }
  return (y) => {
    if (y <= knots[0][0]) return knots[0][1] + m[0] * (y - knots[0][0]);
    if (y >= knots[n - 1][0]) return knots[n - 1][1] + m[n - 1] * (y - knots[n - 1][0]);
    let i = 0; while (y > knots[i + 1][0]) i++;
    const h = knots[i + 1][0] - knots[i][0], t = (y - knots[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * knots[i][1] + (t3 - 2 * t2 + t) * h * m[i]
         + (-2 * t3 + 3 * t2) * knots[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}
/* The Atlantic shore. North of the pad the coast runs NNW (Playalinda, New Smyrna); south-east it
   runs out to the Cape's point and turns back south-west toward Cocoa Beach. */
const ATLANTIC = curve([[-72, 4.5], [-50, 1.8], [-32, 0.4], [-24, 2.6], [-19.5, 6.1], [-16.4, 7.7], [-13, 6.6], [-9, 4.7],
  [-4, 2.55], [-1.5, 1.5], [0, 0.95], [1.5, 0.45], [3, -0.25], [8, -3.1], [20, -10.4], [36, -20], [60, -32], [72, -38]]);
/* The Indian River's island bank; the mainland bank is `riverWidth` west of it. */
const INDIAN = curve([[-72, -9.2], [-40, -9.8], [-20, -11.6], [-6, -13.2], [0, -13.7], [10, -15.2], [18, -17.6], [26, -21.5]]);
const riverWidth = (y) => 3.4 * (1 - smoothS(8, 26, y));
/* Cape Canaveral itself: how wide the land is between the ocean and the Banana River. */
const capeWidth = curve([[-40, 1.1], [-30, 1.2], [-22, 2.0], [-16.4, 5.4], [-10, 3.2], [-4.6, 1.7], [0, 1.7]]);
const bananaWidth = (y) => 3.0 * (1 - smoothS(-9, -4.6, y)) + 1.5 * (1 - smoothS(-20, -9, y));
const lagoonWidth = (y) => 3.2 * smoothS(5.2, 12, y) + 0.5 * smoothS(12, 40, y);
const BARRIER = 0.7;                           // km of dune between the ocean and Mosquito Lagoon

/* The site plan, shared with js/cape.js (which builds it) and js/colliders.js's numbers. km. */
export const SITE = {
  vab: { x: -5.58, y: 0, w: 0.158, d: 0.218, h: 0.160 },         // 158 m east-west, 218 m north-south, 160 m tall
  lcc: { x: -5.40, y: -0.215, w: 0.055, d: 0.115, h: 0.023 },
  padB: { x: -1.35, y: 2.35 },                                   // LC-39B, 2.7 km NNW
  basin: [-5.35, -0.85, -4.75, -0.85, 0.2],
};
/* Open water narrower than the far grid can hold: [ax, ay, bx, by, half-width]. */
const CANALS = [SITE.basin, [-4.75, -0.85, -2.6, -2.6, 0.07], [-2.6, -2.6, 0.2, -4.2, 0.07], [0.2, -4.2, 1.25, -5.5, 0.08]];
/* Impoundment ponds: [cx, cy, rx, ry, rotation]. */
const PONDS = [[0.15, -1.45, 0.40, 0.19, 0.5], [-1.5, 1.3, 0.50, 0.22, -0.3], [-1.05, 2.05, 0.30, 0.18, 0.9], [-2.4, -1.6, 0.30, 0.18, 1.0],
  [-3.3, 1.9, 0.60, 0.25, 0.4], [-0.9, -2.4, 0.45, 0.20, -0.6], [0.75, -3.3, 0.30, 0.16, -0.5], [-4.1, 3.4, 0.7, 0.3, 0.1], [-2.9, -4.3, 0.55, 0.3, 0.7],
  [-0.85, -0.95, 0.24, 0.12, 0.2], [-0.2, 1.05, 0.26, 0.11, -0.5]];

for (const p of PONDS) p.push(Math.cos(p[4]), Math.sin(p[4]), Math.min(p[2], p[3]));

/* Roads, for the ground shader to ink: [ax, ay, bx, by, half-width km, kind]. kind 0 = asphalt,
   1 = the crawlerway (two gravel tracks and a median, 49 m over all). */
const RW = 0.0055;
export const ROADS = [
  [-5.50, 0, -0.15, 0, 0.0245, 1],                               // crawlerway, assembly building to pad A
  [-3.0, 0, -2.2, 1.55, 0.0245, 1], [-2.2, 1.55, -1.52, 2.30, 0.0245, 1],   // and its branch to pad B
  [-6.6, -9.6, -6.6, -3.0, RW, 0], [-6.6, -3.0, -6.45, 2.0, RW, 0], [-6.45, 2.0, -7.4, 9.6, RW, 0],   // Kennedy Parkway
  [-6.6, -6.2, -13.6, -6.5, RW, 0], [-13.6, -6.5, -17.4, -6.4, RW, 0], [-17.4, -6.4, -20.5, -6.6, RW, 0],   // NASA Causeway over the Indian River
  [-6.55, -0.38, -5.75, -0.38, RW, 0], [-5.75, -0.38, -0.45, -0.38, RW, 0], [-0.45, -0.38, -0.31, -0.08, RW, 0],   // Saturn Causeway
  [-5.75, -0.38, -5.75, 0.30, RW, 0], [-5.75, 0.30, -6.5, 0.30, RW, 0],                           // round the assembly building
  [0.33, 0.16, 0.66, 0.22, RW, 0],                                // pad A to the beach road
  [2.3, -4.4, 1.25, -1.9, RW, 0], [1.25, -1.9, 0.66, 0.22, RW, 0], [0.66, 0.22, -0.05, 2.1, RW, 0], [-0.05, 2.1, -1.0, 3.6, RW, 0],   // Beach Road
  [-1.0, 3.6, -6.5, 3.9, RW, 0], [-1.05, 2.42, -0.72, 2.62, RW, 0], [-0.72, 2.62, -0.62, 2.95, RW, 0],   // north road and pad B's spur
  [2.3, -4.4, 4.4, -9.0, RW, 0], [4.4, -9.0, 5.8, -15.2, RW, 0],   // down the Cape to the old pads
  [-19.2, -40, -18.4, -6.6, RW, 0], [-18.4, -6.6, -19.0, 9, RW, 0], [-19.0, 9, -24.5, 30, RW, 0],     // US 1 on the mainland bank
];

function segDist(x, y, s) {
  const bx = s[2] - s[0], by = s[3] - s[1], px = x - s[0], py = y - s[1];
  let t = (px * bx + py * by) / (bx * bx + by * by);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - bx * t, ey = py - by * t;
  return Math.sqrt(ex * ex + ey * ey);
}

/* What depends on y alone, so a grid row pays for the curves once. */
function rowOf(y, o = {}) {
  const a = ATLANTIC(y), sl = (ATLANTIC(y + 0.05) - ATLANTIC(y - 0.05)) * 10;
  o.atl = a; o.k = 1 / Math.sqrt(1 + sl * sl);
  const lw = y > 5.2 ? lagoonWidth(y) : 0;
  o.lagE = a - BARRIER; o.lagW = o.lagE - lw; o.lag = lw > 0;
  const bw = y < -4.6 ? bananaWidth(y) : 0;
  o.banE = a - capeWidth(y); o.banW = o.banE - bw; o.ban = bw > 0;
  const rw = riverWidth(y);
  o.indE = INDIAN(y); o.indW = o.indE - rw; o.ind = rw > 0;
  return o;
}
/* Signed km to the Atlantic shore alone (positive = at sea): where the beach and the surf are. */
function atlanticSd(x, row) { return (x - row.atl) * row.k; }
function sdIn(x, y, row) {
  let d = (x - row.atl) * row.k;
  if (row.lag) d = Math.max(d, Math.min(x - row.lagW, row.lagE - x) * row.k);
  if (row.ban) d = Math.max(d, Math.min(x - row.banW, row.banE - x) * row.k);
  if (row.ind) d = Math.max(d, Math.min(x - row.indW, row.indE - x));
  if (x > -7 && x < 3.5 && y > -6.5 && y < 4.5) {
    for (const c of CANALS) d = Math.max(d, c[4] - segDist(x, y, c));
    for (const p of PONDS) {
      const dx = x - p[0], dy = y - p[1];
      if (dx > 1 || dx < -1 || dy > 1 || dy < -1) continue;
      const ex = (dx * p[5] + dy * p[6]) / p[2], ey = (dy * p[5] - dx * p[6]) / p[3];
      d = Math.max(d, (1 - Math.sqrt(ex * ex + ey * ey)) * p[7]);
    }
  }
  return d;
}
const _row = {};
/* Signed km to the nearest authored shore at tangent-frame (x, y): positive = water. */
export function capeSd(x, y) { return sdIn(x, y, rowOf(y, _row)); }

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

/* Signed distance to the nearest authored shore (negative = land), NaN-free everywhere;
   1e9 outside the pad neighbourhood so min()s ignore it. */
export function padShoreSd(u, v) {
  padTangent(u, v, _tp);
  if (_tp.a <= 0) return 1e9;
  return capeSd(_tp.x, _tp.y);
}

export function padShoreZone(u, v) {
  padTangent(u, v, _tp);
  if (_tp.a <= 0) return '';
  rowOf(_tp.y, _row);
  if (sdIn(_tp.x, _tp.y, _row) <= 0) return 'island';
  return atlanticSd(_tp.x, _row) > 0 ? 'ocean' : 'lagoon';
}

/* Zone → colour for the painted MAP canvas (js/earthpaint.js bakes it; the ground itself is drawn
   by js/surface-earth.js from the distance fields below): shelf tone in the lagoons, sand on the
   ocean beach, dune grass behind it, grass inland, plain ocean beyond the Cape. */
export function padAuthored(u, v) {
  const zone = padShoreZone(u, v);           // fills _tp and _row
  if (!zone) return null;
  if (zone === 'lagoon') return C.shelf;
  if (zone === 'ocean') return C.ocean;
  const sa = atlanticSd(_tp.x, _row);
  if (sa > -0.55) return C.desert;
  if (sa > -1.7) return C.dune;
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

/* ---- the site's ground cover ----
   Value noise in the tangent frame, for the wood lots: a smooth field the shader thresholds into
   dark flat shapes and js/cape.js plants its tree clumps inside, so a wood is drawn on the ground
   exactly where its trees stand. */
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
/* Distance to the nearest road or crawlerway edge, km (segments whose box is further than `reach` are skipped). */
const ROAD_BOX = ROADS.map((s) => [Math.min(s[0], s[2]), Math.max(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[1], s[3])]);
function roadDist(x, y, reach) {
  let best = reach;
  for (let k = 0; k < ROADS.length; k++) {
    const b = ROAD_BOX[k];
    if (x < b[0] - best || x > b[1] + best || y < b[2] - best || y > b[3] + best) continue;
    const s = ROADS[k], d = segDist(x, y, s) - s[4];
    if (d < best) best = d;
  }
  return best;
}
/* > 0 on ground a tree may stand on: clear of water, the beach, roads, both pads and the
   industrial area round the assembly building. */
export function siteClear(x, y, sd = capeSd(x, y), sa = atlanticSd(x, rowOf(y, _row))) {
  const v = SITE.vab;
  return Math.min((-sd - 0.05) * 5, (-sa - 0.42) * 3, (Math.hypot(x, y) - 0.52) * 2.5,
    (Math.hypot(x - SITE.padB.x, y - SITE.padB.y) - 0.5) * 2.5, (roadDist(x, y, 0.2) - 0.045) * 6,
    (Math.max(Math.abs(x - v.x + 0.15) - 0.75, Math.abs(y - v.y + 0.1) - 0.6)) * 4);
}
/* > 0 inside a wood lot. */
export function groveAt(x, y, sd, sa) {
  const g = vnoise(x / 0.8 + 40, y / 0.8 + 40, 91) * 0.62 + vnoise(x / 0.3 + 90, y / 0.3 + 90, 92) * 0.38 - 0.57;
  if (g < -0.08) return g;                                        // open ground: a clearing can only lower it
  return Math.min(g, siteClear(x, y, sd, sa));
}

/* The site at full detail, for the ground shader: RGBA float rows (south first) over ±SITE_HALF km.
   R signed km to the nearest shore (positive = water), G the wood-lot field, B signed km to the
   ATLANTIC shore alone (beach and surf belong to the ocean; a lagoon's bank is marsh), A km to the
   nearest road's edge (capped at 0.5): the shader walks the road segments only where A says one
   can reach the pixel. */
export const SITE_HALF = 10;
export function siteGrid(n) {
  const out = new Float32Array(n * n * 4), row = {};
  for (let j = 0; j < n; j++) {
    const y = ((j + 0.5) / n * 2 - 1) * SITE_HALF;
    rowOf(y, row);
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n * 2 - 1) * SITE_HALF, o = (j * n + i) * 4;
      const sd = sdIn(x, y, row), sa = atlanticSd(x, row);
      out[o] = Math.max(-40, Math.min(40, sd));
      out[o + 1] = sd > 0.1 ? -1 : Math.max(-1, Math.min(1, groveAt(x, y, sd, sa)));
      out[o + 2] = Math.max(-40, Math.min(40, sa));
      out[o + 3] = roadDist(x, y, 0.5);
    }
  }
  return out;
}

/* ---- near-level extras: the same height function the patch uses, shared with camera getters.
   Earth only — the Moon deliberately has no near level. */

export function fineEarth(u, v) {
  const f1 = noise(u, v * 2, period(EARTH_CIRC, 0.9), 201);
  const f2 = noise(u, v * 2, period(EARTH_CIRC, 0.19), 211);
  return (f1 - 0.5) * 0.034 + (f2 - 0.5) * 0.013;                  // ±~24 m of ground the 20 km grid cannot show
}

/* The fine ground, as ONE function: km above the relief grid at a point, given the land fraction's
   coast field. The near patch's vertices (js/terrain.js) and fineGroundHeight (js/world.js, which
   physics lands on) both call this, so the drawn ground and the contact surface are the same number.
   Positive only, zero at sea, zero in the launch site's flat zone. */
export function fineRelief(coast, u, v) {
  const pw = padWeight(u, v);
  if (pw <= 0) return 0;
  const fine = fineEarth(u, v);
  if (fine <= 0) return 0;
  const t = THREE.MathUtils.clamp((shoreDistance(coast, u, v) + 0.06) / 0.12, 0, 1);
  return fine * (1 - t * t * (3 - 2 * t)) * pw;
}

/* The authored shore as a grid for the ground shader's far view: signed km (positive = water) over a
   square of ±PAD_SDF_HALF km in the pad's tangent frame, x east, y north, row 0 south, with the
   distance to the nearest road beside it. The same
   function padShoreSd answers from, sampled at 0.28 km so the shader's bilinear zero line is the
   drawn curve; siteGrid above is the same thing at 39 m for the ±10 km round the pad. */
export const PAD_SDF_HALF = 72;
export function padSdfGrid(n) {
  const km = new Float32Array(n * n * 2), row = {};
  for (let j = 0; j < n; j++) {
    const y = ((j + 0.5) / n * 2 - 1) * PAD_SDF_HALF;
    rowOf(y, row);
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n * 2 - 1) * PAD_SDF_HALF, o = (j * n + i) * 2;
      km[o] = sdIn(x, y, row);
      km[o + 1] = roadDist(x, y, 2);                  // km to the nearest road, capped: the shader's cue to look for one
    }
  }
  return km;
}
