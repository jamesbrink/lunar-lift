import * as THREE from 'three';
import { RE, RM } from './constants.js';

/* The painters' tool kit: asset decode, mask morphology, box filters, the seeded lattice noise and
   the grid sampler. Everything here is deterministic — no Math.random anywhere — so the geology is
   identical every run and the mesh, the shaders and js/camera.js's colliders are views of one field.

   Grids are plain { w, h, km: Float32Array } sampled through the sphere's analytic uv:
   u = (lon+180)/360 wraps longitude, v = (lat+90)/180 with v=1 at the NORTH pole, texel centres at
   (ix+0.5)/w, and the painted grids' row 0 is north — so the row under a uv is (1 - v)·h - 0.5. */

export const FW = 1024, FH = 512;          // global height grid for both bodies (~10.7 / 39 km per texel)

export const smoothS = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* Decode an asset once and hand the raw pixels back at full resolution. */
export function pixels(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      resolve({ w, h, data: cx.getImageData(0, 0, w, h).data });
    };
    img.onerror = () => reject(new Error('could not read ' + path));
    img.src = path;
  });
}

/* Three-pass majority filter on a boolean mask: a texel keeps its value unless more than half of its
   eight neighbours disagree. JPEG ringing around a coastline produces a halo of one-pixel lies, and
   the filter is also a morphological smoother — each pass shaves a corner off a staircase, so running
   it several times turns the blocky mask into the rounded coastline a map would draw, without eating
   a strait narrower than ~8 px, which at 20 km per pixel is anything a human would notice. */
export function cleanMask(mask, w, h, passes = 3) {
  let a = mask, b = new Uint8Array(mask.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let ones = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = (x + dx + w) % w;              // wrap in longitude: the dateline is not an edge
            ones += a[yy * w + xx] ? 1 : 0;
          }
        }
        b[i] = ones > 4 || (ones === 4 && a[i]) ? 1 : 0;
      }
    }
    const t = a; a = b; b = t;
  }
  return a;
}

/* Binary open→close on the 4-neighbourhood, `rounds` erode/dilate steps each. Majority voting
   shaves single-texel noise but leaves a full staircase intact wherever the true boundary runs
   diagonally for several texels — the treads survive, which is exactly the coast defect a review
   measured (13 steps ≥ 20 px per 10-row scan on the NE-facing shore at 160 km) and the same rule
   that rounds the Moon's mare outlines. Opening (erode, erode, dilate, dilate) shaves convex
   corners and one-texel spurs; the closing fills concave nicks and single-texel straits of
   disagreement. Longitude WRAPS — the dateline is not an edge; latitude clamps to itself so polar
   coasts are not shaved at the map border. Area moves only at corners: measured on the shipped
   Earth canvas, land share 36.9 % before and after (moon mare 3.27 % before → 3.27 %).

   Bit-packed (measured): the per-texel closure version spent most of the 5.8 s the 4×
   moon repaint took — 32 passes × 8.4 M texels × 5 clamped neighbour lookups through closures. A
   row of the mask is a bit vector now: the 4-neighbourhood is two shifts on the word array
   (longitude wraps through the circular word order, latitude clamps via duplicated border rows)
   and erode/dilate are one AND/OR chain per word. Same rule, same rounds; requires w divisible
   by 32, which both shipped canvases are (moon 4096, earth 2048). */
export function openClose(mask, w, h, rounds = 2) {
  if (w % 32 !== 0) throw new Error('openClose needs width divisible by 32');
  const K = w >> 5;
  const pack = (m) => {
    const a = new Uint32Array(K * h);
    for (let y = 0; y < h; y++) {
      const row = y * w, wr = y * K;
      for (let x = 0; x < w; x++) if (m[row + x]) a[wr + (x >> 5)] |= 1 << (x & 31);
    }
    return a;
  };
  const ero = (a) => {
    const o = new Uint32Array(a.length);
    for (let y = 0; y < h; y++) {
      const r = y * K, up = (y > 0 ? y - 1 : 0) * K, dn = (y < h - 1 ? y + 1 : h - 1) * K;
      for (let j = 0; j < K; j++) {
        const jm = (j - 1 + K) % K, jp = (j + 1) % K;
        const l = (a[r + j] << 1) | (a[r + jm] >>> 31);
        const rr = (a[r + j] >>> 1) | (a[r + jp] << 31);
        o[r + j] = a[r + j] & l & rr & a[up + j] & a[dn + j];
      }
    }
    return o;
  };
  const dil = (a) => {
    const o = new Uint32Array(a.length);
    for (let y = 0; y < h; y++) {
      const r = y * K, up = (y > 0 ? y - 1 : 0) * K, dn = (y < h - 1 ? y + 1 : h - 1) * K;
      for (let j = 0; j < K; j++) {
        const jm = (j - 1 + K) % K, jp = (j + 1) % K;
        const l = (a[r + j] << 1) | (a[r + jm] >>> 31);
        const rr = (a[r + j] >>> 1) | (a[r + jp] << 31);
        o[r + j] = a[r + j] | l | rr | a[up + j] | a[dn + j];
      }
    }
    return o;
  };
  let s = pack(mask);
  for (let p = 0; p < rounds; p++) s = ero(s);
  for (let p = 0; p < rounds; p++) s = dil(s);
  for (let p = 0; p < rounds; p++) s = dil(s);
  for (let p = 0; p < rounds; p++) s = ero(s);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w, wr = y * K;
    for (let j = 0; j < K; j++) {
      let word = s[wr + j];
      if (!word) continue;
      let x = j << 5;
      while (word) { if (word & 1) out[row + x] = 1; word >>>= 1; x++; }
    }
  }
  return out;
}

/* Grow a mask by a sequence of radii with a separable scan: O(w*h) per pass instead of the O(w*h*r²)
   a disc stamp would cost. One radius gives a square, and a square coastline is the most obviously
   synthetic thing on the planet; applying descending radii (7, then 3, then 1) approximates the disc
   as a rounded octagon for the same work, which is what the shelf band and the coast stroke want. */
export function dilate(mask, w, h, radii) {
  let a = mask;
  for (const r of radii) {
    const grown = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let hit = 0;
        const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
        for (let xx = lo; xx <= hi; xx++) if (a[row + xx]) { hit = 1; break; }
        grown[row + x] = hit;
      }
    }
    const out = new Uint8Array(a.length);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let hit = 0;
        const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
        for (let yy = lo; yy <= hi; yy++) if (grown[yy * w + x]) { hit = 1; break; }
        out[y * w + x] = hit;
      }
    }
    a = out;
  }
  return a;
}

/* One plurality pass over a wrapping/equirect label grid: each land texel takes the biome that most
   of its neighbours chose, ties going to whatever it already had (so a genuinely mixed band settles
   instead of oscillating). Ocean texels neither vote nor receive votes, which keeps the coast exactly
   where the cleaned mask puts it. */
export function voteLabels(lab, land, w, h, rad) {
  const src = lab.slice();
  const tally = new Int32Array(16);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h - 1, y + rad);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!land[i]) continue;
      tally.fill(0);
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x - rad; xx <= x + rad; xx++) {
          const j = row + ((xx % w) + w) % w;
          if (land[j] && src[j]) tally[src[j]]++;
        }
      }
      let best = src[i], bestN = tally[src[i]];          // ties keep what the texel already was
      for (let l = 1; l < tally.length; l++) if (tally[l] > bestN) { bestN = tally[l]; best = l; }
      lab[i] = best;
    }
  }
}

/* Separable box mean over a wrapping longitude and a clamped latitude, O(n) by sliding windows.
   The latitude window used to keep a per-row multiplicity count and added each entering row twice:
   a constant field of 1 came back as high as 11 at r 1 and 5.0 at r 3 (measured against a brute-force
   sum, max error 5.18 and 2.04). Every smoothed signal the classifiers read — biome, mare cut — had
   been running on that. The window is now the plain one: add the clamped row entering, subtract the
   clamped row leaving; max error against brute force 0 to float rounding at r 1, 2, 3 and 9. */
export function boxSignal(a, w, h, rad) {
  const tmp = new Float32Array(a.length);
  const n = 2 * rad + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -rad; k <= rad; k++) s += a[row + ((k % w) + w) % w];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += a[row + (x + rad + 1) % w] - a[row + ((x - rad) % w + w) % w];
    }
  }
  const cl = (y) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -rad; k <= rad; k++) s += tmp[cl(k) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = s / n;
      s += tmp[cl(y + rad + 1) * w + x] - tmp[cl(y - rad) * w + x];
    }
  }
}

/* Fraction of a 0..1 field below a cut. */
export function shareBelow(a, cut) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] < cut) n++;
  return n / a.length;
}

/* The value below which `share` of a 0..1 field lies, from a 4096-bin histogram: the mare cut is set
   by AREA so that smoothing the field can only change how the edge is drawn, never how much of the
   Moon is mare. Exact for the bin, ±1/4096 of the field's range in value — 0.25 of one 8-bit level. */
export function quantile(a, share) {
  const N = 4096, hist = new Int32Array(N);
  for (let i = 0; i < a.length; i++) hist[Math.max(0, Math.min(N - 1, (a[i] * N) | 0))]++;
  const want = share * a.length;
  let acc = 0;
  for (let k = 0; k < N; k++) { acc += hist[k]; if (acc >= want) return (k + 1) / N; }
  return 1;
}

/* Deterministic lattice hash and the value noise built on it: longitude wraps — the dateline is not
   an edge — latitude clamps at the poles. Same recipe as the cloud decks, kept local so this module
   owns its randomness outright. */
export function hash2(x, y, seed) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
}

export const noise = latticeNoise();
function latticeNoise() {
  return (u, v, p, seed) => {
    const x = u * p, y = v * p;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const lx = ((xi % p) + p) % p, lxn = (lx + 1) % p;
    const ly = yi < 0 ? 0 : yi, ly1 = yi + 1 >= p ? p - 1 : yi + 1;
    const a = hash2(lx, ly, seed), b = hash2(lxn, ly, seed);
    const c = hash2(lx, ly1, seed), d = hash2(lxn, ly1, seed);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

/* lattice period for a wavelength in km around the globe. uv noise stretches with cos(lat), left
   alone on purpose: it vanishes in fine detail and is invisible under a three-band ramp. */
export const period = (circKm, lambdaKm) => Math.max(8, Math.round(circKm / lambdaKm));
export const EARTH_CIRC = 2 * Math.PI * RE, MOON_CIRC = 2 * Math.PI * RM;

export function fbm(u, v, p, oct, seed) {
  let sum = 0, amp = 0.5, tot = 0;
  for (let k = 0; k < oct; k++) { sum += amp * noise(u, v, p << k, seed + k); tot += amp; amp *= 0.5; }
  return sum / tot;
}

export function sampleGrid(g, u, v) {
  const w = g.w, h = g.h, a = g.km;
  const gx = u * w - 0.5, gy = (1 - v) * h - 0.5;
  const x0 = Math.floor(gx), fx = gx - x0;
  const y0 = Math.floor(gy), fy = gy - y0;
  const xa = ((x0 % w) + w) % w, xb = (x0 + 1) % w;
  const ya = y0 < 0 ? 0 : y0 > h - 1 ? h - 1 : y0;
  const yb = y0 + 1 < 0 ? 0 : y0 + 1 > h - 1 ? h - 1 : y0 + 1;
  const r0 = ya * w, r1 = yb * w;
  const p = a[r0 + xa], q = a[r0 + xb], s = a[r1 + xa], t = a[r1 + xb];
  const top = p + (q - p) * fx, bot = s + (t - s) * fx;
  return top + (bot - top) * fy;
}

export function chamfer(d, w, h) {
  const SQ = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let m = d[i];
      if (y > 0) {
        const up = (y - 1) * w;
        m = Math.min(m, d[up + ((x - 1 + w) % w)] + SQ, d[up + x] + 1, d[up + ((x + 1) % w)] + SQ);
      }
      m = Math.min(m, d[y * w + ((x - 1 + w) % w)] + 1);
      d[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let m = d[i];
      m = Math.min(m, d[y * w + ((x + 1) % w)] + 1);
      if (y < h - 1) {
        const dn = (y + 1) * w;
        m = Math.min(m, d[dn + ((x + 1) % w)] + SQ, d[dn + x] + 1, d[dn + ((x - 1 + w) % w)] + SQ);
      }
      d[i] = m;
    }
  }
}
