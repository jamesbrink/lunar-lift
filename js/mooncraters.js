import { RM } from './constants.js';

/* The Moon's craters, as numbers. Display-free: the terrain mesh, the contact surface and the
   camera's collider all read it, and js/surface-moon.js DRAWS the same population.

   A crater is not stored anywhere. Space is cut into cubic lattices (cells of 1024, 256, 64, 16,
   4 and 1 km here; the shader carries on down to 16 m) and each cell that the surface passes
   through holds at most one crater: its centre jittered inside the cell, its radius 5–27 % of the
   cell, its age, its rim's breaks and whether it has a central peak, all from one integer hash of
   the cell's coordinates. So the ladder covers 50 m to 276 km with one rule, every crater exists at
   every zoom, and this file and the fragment shader agree on each one because they run the same
   hash (sfH in js/surface.js; Math.imul is GLSL's uint multiply).

   craterHeight() is the relief of that population: a bowl, a rim, a peak in the larger fresh
   ones, the rim knocked down where the drawing breaks it. It is what makes a lunar horizon a
   silhouette instead of a ruled line, and it is part of moonGroundHeight — the lander stands in
   the bowl that is drawn.

   `spacing` is the mesh's vertex spacing at the point asked for, km. A mesh cannot hold a crater
   narrower than a few of its own triangles — it aliases into spikes — so a crater fades out
   between five spacings of radius and two. Contact asks with spacing 0 and gets everything. */

export const CRATER_CELLS = [1024, 256, 64, 16, 4, 1];          // km; relief octaves, coarse to fine
export const CRATER_SEEDS = [48, 40, 41, 42, 43, 44];           // the shader's seed for the same lattice
const BIG = 2;                                                  // the first two are scaled by the highland weight
/* Cells. A crater's centre is jittered ±JIT/2 from its cell's, lies within OWN1 of the surface, and
   its relief ends REACH radii out, radius at most RMAX: so no point of it is further from the
   cell's centre, on any axis, than sqrt(OWN1² + (REACH·RMAX)²) + JIT/2 = 0.644. REJECT is that
   bound, and it has to be: one notch tighter and a crater is cut off along a lattice plane — an
   85° cliff in the patch (measured, with 0.60 against a true bound of 0.83 at the time), and a
   crater drawn with a ruled edge. The shader's constants are these. */
const JIT = 0.34, OWN0 = 0.25, OWN1 = 0.33, RMAX = 0.27, REACH = 1.25, REJECT = 0.645, RAY_REACH = 0.47;

const mix32 = (n) => { n = Math.imul(n ^ (n >>> 15), 2246822519); return (n ^ (n >>> 13)) >>> 0; };
const hash3 = (x, y, z, s) => mix32(Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(s, 2654435761));
const sstep = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };

/* Everything about one crater that its hash decides. Mirrors sfCraters in js/surface-moon.js. */
const C = { jx: 0, jy: 0, jz: 0, r: 0, size: 0, age: 0, ax: 0, ay: 0, az: 0, gapN: 1, gapP: 0, h3: 0 };
function crater(h) {
  C.jx = (h & 1023) / 1023; C.jy = ((h >>> 10) & 1023) / 1023; C.jz = ((h >>> 20) & 1023) / 1023;
  const h2 = (Math.imul(h, 747796405) + 2891336453) >>> 0;
  C.size = ((h2 >>> 8) & 1023) / 1023;
  C.r = 0.05 + (RMAX - 0.05) * C.size * C.size * Math.sqrt(C.size);
  C.age = ((h2 >>> 20) & 255) / 255;
  const h3 = (Math.imul(h2, 747796405) + 2891336453) >>> 0;
  C.ax = (h3 & 255) / 127.5 - 1; C.ay = ((h3 >>> 8) & 255) / 127.5 - 1; C.az = ((h3 >>> 16) & 255) / 127.5 - 1;
  C.gapN = 1 + ((h3 >>> 24) & 1); C.gapP = (h3 >>> 25) * 0.05; C.h3 = h3;
  return C;
}
/* Depth is the real ratio for a simple bowl (a fifth of the radius… of the diameter, 0.2 D, is
   0.4 r; drawn at half that) capped at 3.5 km, which is Copernicus. The rim is twice life-size on
   purpose: a real 1 km rim 186 km away — the horizon from 10 km up — is 5 pixels, and the review
   this answers was of a horizon that was a ruled line. */
export const craterDepth = (rKm) => Math.min(0.20 * rKm, 3.5);          // km, floor below the plain
export const craterRim = (rKm) => Math.min(0.07 * rKm, 1.8);            // km, crest above it

/* km of crater relief at the unit direction (x, y, z) in the Moon's own axes. `hi` is the highland
   weight there, 0..1 (the two largest octaves are flooded out of the maria). */
export function craterHeight(x, y, z, hi, spacing = 0) {
  let sum = 0;
  for (let k = 0; k < CRATER_CELLS.length; k++) {
    const cell = CRATER_CELLS[k];
    if (RMAX * cell <= 2 * spacing) break;                       // nothing in this octave, or below it, is resolved
    const wk = k < BIG ? 0.15 + 0.85 * hi : 1;
    const qx = x * RM / cell, qy = y * RM / cell, qz = z * RM / cell;
    const bx = Math.floor(qx - 0.5), by = Math.floor(qy - 0.5), bz = Math.floor(qz - 0.5);
    const fx = qx - bx, fy = qy - by, fz = qz - bz;
    for (let c = 0; c < 8; c++) {
      const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
      if (Math.abs(fx - ox - 0.5) > REJECT || Math.abs(fy - oy - 0.5) > REJECT || Math.abs(fz - oz - 0.5) > REJECT) continue;
      const cr = crater(hash3(bx + ox, by + oy, bz + oz, CRATER_SEEDS[k]));
      const dx = fx - (ox + 0.5 + (cr.jx - 0.5) * JIT), dy = fy - (oy + 0.5 + (cr.jy - 0.5) * JIT), dz = fz - (oz + 0.5 + (cr.jz - 0.5) * JIT);
      const up = dx * x + dy * y + dz * z;
      const own = 1 - sstep(OWN0, OWN1, Math.abs(up));
      if (own <= 0) continue;
      const tx = (dx - x * up) / cr.r, ty = (dy - y * up) / cr.r, tz = (dz - z * up) / cr.r;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > REACH) continue;
      const rKm = cr.r * cell;
      const lod = spacing > 0 ? sstep(2 * spacing, 5 * spacing, rKm) : 1;
      if (lod <= 0) continue;
      const worn = 1 - sstep(0.25, 0.55, cr.age);
      /* the angle round the crater in its own frame: where a worn rim is broken */
      let wall = 1;
      if (worn > 0) {
        const ad = cr.ax * x + cr.ay * y + cr.az * z;
        let e1x = cr.ax - x * ad + 1e-4, e1y = cr.ay - y * ad + 1e-4, e1z = cr.az - z * ad + 1e-4;
        const el = 1 / Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z); e1x *= el; e1y *= el; e1z *= el;
        const e2x = y * e1z - z * e1y, e2y = z * e1x - x * e1z, e2z = x * e1y - y * e1x;
        const th = Math.atan2(tx * e2x + ty * e2y + tz * e2z, tx * e1x + ty * e1y + tz * e1z);
        wall = 1 - worn * sstep(0.55, 0.75, Math.cos(th * cr.gapN + cr.gapP));
      }
      const depth = craterDepth(rKm) * (1 - 0.6 * worn), rim = craterRim(rKm) * (1 - 0.7 * worn) * wall;
      const b = tl / 0.92;
      let h = b < 1 ? -depth * (1 - b * b) : 0;
      const g = (tl - 1) / 0.16;
      h += rim * Math.exp(-g * g) * (1 - sstep(1.12, REACH, tl));
      if (cr.size > 0.62 && worn < 0.5 && tl < 0.4) { const p = tl / 0.11; h += 0.28 * depth * Math.exp(-p * p); }
      sum += h * own * lod * wk;
    }
  }
  return sum;
}

/* Every crater of one relief octave, for the painted map: unit direction, radius in km, how
   strongly the lattice owns it, age. */
export function listCraters(k) {
  const cell = CRATER_CELLS[k], n = Math.ceil(RM / cell) + 1, out = [];
  for (let iz = -n; iz < n; iz++) for (let iy = -n; iy < n; iy++) for (let ix = -n; ix < n; ix++) {
    const cr = crater(hash3(ix, iy, iz, CRATER_SEEDS[k]));
    const cx = ix + 0.5 + (cr.jx - 0.5) * JIT, cy = iy + 0.5 + (cr.jy - 0.5) * JIT, cz = iz + 0.5 + (cr.jz - 0.5) * JIT;
    const l = Math.sqrt(cx * cx + cy * cy + cz * cz), own = 1 - sstep(OWN0, OWN1, Math.abs(l - RM / cell));
    if (own <= 0) continue;
    const rays = k < BIG && cr.age > (k === 0 ? 0.55 : 0.80) && cr.r < 0.16;
    out.push({ x: cx / l, y: cy / l, z: cz / l, r: cr.r * cell, own, age: cr.age, reach: rays ? RAY_REACH / cr.r : REACH, rays, h3: cr.h3 });
  }
  return out;
}
