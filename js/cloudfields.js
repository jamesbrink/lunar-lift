import * as THREE from 'three';

/* The weather's data: three generated sheets and the numbers measured from them. No shader here —
   js/clouds.js draws these; this file only decides where cloud is and what shape its edge has.

   A cloud is the region where ONE scalar field exceeds ONE threshold, at every distance:

       F = WM * macro + W1 * oct1 + W2 * oct2 + W3 * oct3          cloud where F > THR + RISE * h

   macro is a planet sheet (weather systems), oct1..3 are three looks at the same 512-texel tile at
   1000, 160 and 32 km per tile. The planet sheet holds TWO weathers, one for an eye near the ground
   and one for an eye in orbit (its red and blue channels; see the synoptic sheet below), and
   js/clouds.js goes from one to the other as the eye climbs. Far away the fine octaves average to their means in the sampler's
   mips and drop out, so the outline simplifies but stays an outline — there is no distance at
   which the field has to be swapped for a fog. The octaves are built from DOMES (one minus the
   squared distance to the nearest feature point): the level set of a sum of domes is a union of
   arcs meeting in cusps, which is how a cloud is drawn with a pen. */

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (x, y, seed) => {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
};

/* Deterministic value noise for the planet sheets. The lattice wraps in longitude and clamps at
   the poles: no seam at the dateline, and the same run always produces the same weather. */
function sphereNoise(u, v, p, seed) {
  const lattice = (x, y) => hash(((x % p) + p) % p, y < 0 ? 0 : y >= p ? p - 1 : y, seed);
  const x = u * p, y = v * p, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return (lattice(xi, yi) * (1 - sx) + lattice(xi + 1, yi) * sx) * (1 - sy)
    + (lattice(xi, yi + 1) * (1 - sx) + lattice(xi + 1, yi + 1) * sx) * sy;
}

/* ------------------------------------------------------------------------------------------------
   The tile. 512 x 512, wraps both ways, four channels:
     R, B  smooth value-noise fbm, 4/8/16/32 cells per tile, stored as RANK (uniform on 0..1);
     G     domes, 6 and 12 feature points per tile side;
     A     domes, 14 and 28 per tile side.
   ------------------------------------------------------------------------------------------------ */
export const TILE = 512;

function smoothChannel(seed) {
  const N = TILE, f = new Float32Array(N * N);
  const lat = (ix, iy, per, s) => {
    const fx = ix * per / N, fy = iy * per / N, x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0, ax = tx * tx * (3 - 2 * tx), ay = ty * ty * (3 - 2 * ty);
    const x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
    return hash(x0, y0, s) * (1 - ax) * (1 - ay) + hash(x1, y0, s) * ax * (1 - ay)
      + hash(x0, y1, s) * (1 - ax) * ay + hash(x1, y1, s) * ax * ay;
  };
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    let v = 0, amp = 1;
    for (let k = 0; k < 4; k++, amp *= 0.55) v += amp * lat(ix, iy, 4 << k, seed + k * 7);
    f[iy * N + ix] = v;
  }
  const order = new Uint32Array(N * N);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => f[a] - f[b]);
  for (let r = 0; r < order.length; r++) f[order[r]] = r / (order.length - 1);
  return f;
}

function domeChannel(cellsA, cellsB, seed) {
  const N = TILE, f = new Float32Array(N * N);
  const octave = (per, s, weight) => {
    const px = new Float32Array(per * per), py = new Float32Array(per * per), pr = new Float32Array(per * per);
    for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
      /* Anywhere in its cell, and a third of the cells empty: with the points held near their
         cell centres the lattice showed through from orbit as rows and columns of cloud. */
      px[j * per + i] = i + hash(i, j, s);
      py[j * per + i] = j + hash(i, j, s + 1);
      pr[j * per + i] = hash(i, j, s + 3) < 0.33 ? 0 : 0.5 + 0.5 * hash(i, j, s + 2);     // every dome its own radius
    }
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      const x = (ix + 0.5) * per / N, y = (iy + 0.5) * per / N, cx = Math.floor(x), cy = Math.floor(y);
      let best = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = (cx + di + per) % per, j = (cy + dj + per) % per, k = j * per + i;
        const dx = px[k] - i + cx + di - x, dy = py[k] - j + cy + dj - y;
        if (pr[k] === 0) continue;
        const h = pr[k] * (1 - (dx * dx + dy * dy) / (pr[k] * pr[k]));     // a paraboloid: round top, sharp foot
        if (h > best) best = h;
      }
      f[iy * N + ix] += weight * best;
    }
  };
  octave(cellsA, seed, 0.62); octave(cellsB, seed + 11, 0.38);
  let lo = Infinity, hi = -Infinity;
  for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / (hi - lo);
  return f;
}

/* How each octave reads the tile. js/clouds.js writes the same three dot products in GLSL from
   these numbers; change them here and the shader and the calibration below both follow. */
export const MIX1 = [0.6, 0.4, 0, 0];          // r g b a: systems are smooth masses with big lobes
export const MIX2 = [0, 0.5, 0.25, 0.25];      // cells: lobes on lobes, a little smooth drift
export const MIX3 = [0, 0.6, 0, 0.4];          // billows
export const W1 = 0.38, W2 = 0.46, W3 = 0.16;
/* The tile repeats; the planet must not look as if it does. A second planet sheet — plain fbm, no
   threshold — moves the threshold by up to +-WV/2 from region to region, so the same tile draws a
   field of cloud here and three scraps there. */
export const WV = 0.12;

/* Fraction of sky covered where the macro sheet says fair weather, and where it says system. The
   macro term moves COVERAGE between the two; it never scales opacity. */
export const COVER_CLEAR = 0.08, COVER_STORM = 0.72;

let _cells = null;
export function cellField() {
  if (_cells) return _cells;
  const N = TILE, n2 = N * N;
  const ch = [smoothChannel(17), domeChannel(6, 12, 101), smoothChannel(57), domeChannel(14, 28, 151)];
  const data = new Uint8Array(n2 * 4);
  for (let i = 0; i < n2; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(ch[c][i] * 255);
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;      // an unresolved octave averages to its mean and leaves the sum
  tex.generateMipmaps = true;
  tex.needsUpdate = true;

  /* Measured from the bytes that were uploaded, not from the recipe. */
  const oct = (mix) => { const f = new Float32Array(n2); for (let i = 0; i < n2; i++) f[i] = (mix[0] * data[i * 4] + mix[1] * data[i * 4 + 1] + mix[2] * data[i * 4 + 2] + mix[3] * data[i * 4 + 3]) / 255; return f; };
  const o = [oct(MIX1), oct(MIX2), oct(MIX3)], w = [W1, W2, W3];
  const mean = o.map(f => f.reduce((s, v) => s + v, 0) / n2);
  const max = o.map(f => f.reduce((s, v) => Math.max(s, v), 0));
  /* the value 99.8 % of each octave lies under: what "as high as it gets" means to the shader */
  const top = o.map(f => Float32Array.from(f).sort()[Math.floor(0.998 * n2)]);
  const sigma = o.map((f, i) => Math.sqrt(f.reduce((s, v) => s + (v - mean[i]) * (v - mean[i]), 0) / n2));
  /* How an octave's contrast dies in its own mips: sigma(k) = sigma / sqrt(1 + (k / k0)^2) with k
     the texels under the footprint, k0 fitted to the measured sigma of the 64-texel box average. */
  const k0 = o.map((f, i) => {
    const B = 64, n = N / B; let s = 0;
    for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) {
      let a = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) a += f[(by * B + y) * N + bx * B + x];
      a = a / (B * B) - mean[i]; s += a * a;
    }
    const r = Math.sqrt(s / (n * n)) / sigma[i];
    return B / Math.sqrt(1 / (r * r) - 1);
  });
  /* rms slope of each octave, in field units per TEXEL: the shader turns it into field units per
     pixel to know how wide an edge one pixel is. */
  const slope = o.map(f => {
    let s = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const a = f[y * N + x], dx = f[y * N + (x + 1) % N] - a, dy = f[((y + 1) % N) * N + x] - a;
      s += dx * dx + dy * dy;
    }
    return Math.sqrt(s / n2);
  });
  /* The three octaves are read at incommensurate scales and drifts, so the sum is distributed as
     the sum of three independent draws. Thresholds are quantiles of that. */
  const M = 400000, sum = new Float32Array(M);
  let seed = 1;
  const rnd = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) % n2; };
  const variety = macroField().data, nm = variety.length / 4;
  for (let i = 0; i < M; i++) sum[i] = W1 * o[0][rnd()] + W2 * o[1][rnd()] + W3 * o[2][rnd()] + WV * (variety[(rnd() * 7919 % nm) * 4 + 1] / 255 - 0.5);
  sum.sort();
  const q = (p) => sum[Math.min(M - 1, Math.floor(p * M))];
  const thr = q(1 - COVER_CLEAR);
  _cells = {
    tex, mean, slope, sigma, k0, top,
    thr,                                    // cloud where the cell sum exceeds this, in fair weather
    q50: q(0.5),                            // the cell sum's median: half the sky is over it
    wm: thr - q(1 - COVER_STORM),           // what a full macro value adds: coverage becomes COVER_STORM
    fmax: W1 * max[0] + W2 * max[1] + W3 * max[2],
    meanSum: W1 * mean[0] + W2 * mean[1] + W3 * mean[2],
    /* coverage(m): fraction of the cell sum above thr - wm*m. Exported for the docs' numbers. */
    cover: (m) => { const t = thr - (thr - q(1 - COVER_STORM)) * m; let lo = 0, hi = M; while (lo < hi) { const mid = (lo + hi) >> 1; if (sum[mid] > t) hi = mid; else lo = mid + 1; } return 1 - lo / M; },
  };
  return _cells;
}

/* ------------------------------------------------------------------------------------------------
   The macro sheet: WHERE weather is. 2048 x 1024 equirectangular, 20 km per texel, row 0 south (a
   DataTexture samples row 0 at v = 0 and SphereGeometry's v = 0 is the south pole).

   A six-octave fbm, domain-warped so its contours are lobed, pushed around by the real zonal
   pattern — the ITCZ, the dry belts near +-25 degrees, the storm tracks near +-52 — plus drawn
   mid-latitude cyclones: a comma of cloud wound round a low, with a dry slot behind the arm. The
   value stored is SMOOTH (0 fair .. 1 deep in a system); the shader thresholds the sum it feeds,
   so a hard mask here would only alias at 20 km per texel.
   ------------------------------------------------------------------------------------------------ */
export const MACRO_W = 2048, MACRO_H = 1024;
const CYCLONES = 26;

/* ------------------------------------------------------------------------------------------------
   The synoptic sheet (the macro texture's BLUE channel): the weather as it is drawn from orbit.

   The red channel above moves the cover between 8 % and 72 %, which is right from the pad — there is
   always a cumulus somewhere — and wrong from 500 km, where 8 % of fair-weather cloud everywhere is
   an even sprinkle of dots over the whole planet. From orbit js/clouds.js reads this sheet instead:
   s = value - 0.5 moves the threshold on the cell sum by 2 s SYN_Z of its standard deviations. So
   s <= -0.3 is clear sky with nothing in it, s >= 0.3 is solid, and only the band between — the
   EDGE of a system, and the fields drawn at s ~ -0.1 on purpose — is where the cells show, as the
   texture of something larger.

   What is drawn into it, over a lobed fbm that follows the zonal pattern:
     - the ITCZ: a wavy line of clusters a few degrees north of the equator;
     - extratropical cyclones, a wave train of them along each storm track: a comma — the head
       wound round the low, the cold front trailing away equatorward and west as a band that
       thins — with the dry slot cut in behind the front, and behind that the cold air's field of
       open cells, combed into streets along the wind;
     - a few tropical cyclones: a dense disc, two arms, an eye.
   The streets themselves are NOT in the sheet. At 20 km a texel a diagonal stripe comes back from
   the bilinear filter as a string of beads one texel long — rows of identical dashes, a grid of
   dots at the limb. The sheet's ALPHA channel only says where the air is combed (the trade fields,
   the cold sectors); js/clouds.js draws the comb itself, analytically, STREET_KM from crest to
   crest, and lets it go where a pixel is too wide to hold it.
   Features are composed by MAX (see AGENTS.md): a product of overlapping systems goes to mud.
   ------------------------------------------------------------------------------------------------ */
export const SYN_Z = 4.5;
export const STREET_KM = 42, STREET_AMP = 0.09, STREET_DEG = 20;     // spacing; depth, in the sheet's units; bearing off the parallel
const LOWS = 7;                        // per hemisphere
const DEG = Math.PI / 180;

/* Visit every texel within `reach` degrees of ( lat0, lon0 ), in local degrees: ex east, ey POLEWARD
   (so a southern system is the mirror image of a northern one, and winds the other way, unasked). */
function stamp(W, H, lat0, lon0, reach, fn) {
  const pole = lat0 < 0 ? -1 : 1, cosl = Math.cos(lat0 * DEG);
  const y0 = Math.max(0, Math.floor((lat0 - reach + 90) / 180 * H)), y1 = Math.min(H - 1, Math.ceil((lat0 + reach + 90) / 180 * H));
  const half = Math.min(W >> 1, Math.ceil(reach / Math.max(cosl, 0.2) / 360 * W)), xc = Math.round((lon0 / 360 + 0.5) * W);
  for (let iy = y0; iy <= y1; iy++) {
    const lat = ((iy + 0.5) / H - 0.5) * 180, c = Math.cos(0.5 * (lat + lat0) * DEG);
    for (let dx = -half; dx < half; dx++) {
      const i = iy * W + ((xc + dx) % W + W) % W;
      fn(i, dx / W * 360 * c, (lat - lat0) * pole);
    }
  }
}

const wrapPi = (t) => t - 2 * Math.PI * Math.round(t / (2 * Math.PI));

function drawSystems(syn, comb, W, H) {
  const put = (i, f, peak) => { const v = -0.5 + (peak + 0.5) * f; if (v > syn[i]) syn[i] = v; };

  /* Extratropical cyclones. A logarithmic spiral r = R0 exp( PITCH * phi ): leaving the low the band
     starts on its west side, wraps over the pole side and down the east, and trails away
     equatorward and west — phi is the angle swept, clockwise in these mirrored coordinates. */
  const R0 = 0.15;
  for (let c = -1; c < 2 * LOWS; c++) {
    const south = c & 1, n = c >> 1;
    let lat0 = (south ? -1 : 1) * (41 + 19 * hash(c, 1, 910));
    let lon0 = -180 + 360 * ((n + 0.9 * hash(c, 2, 910)) / LOWS + (south ? 0.37 : 0.08));
    let R = 6.5 + 7.5 * hash(c, 3, 910);                       // degrees: the head is ~0.8 R across, the front runs out to 2.4 R
    let rot = (hash(c, 4, 910) - 0.5) * 1.6;                   // each low at its own stage of winding up
    let pitch = 0.40 + 0.22 * hash(c, 6, 910);
    let age = 0.7 + 0.3 * hash(c, 5, 910), reach = 1.5 + 0.9 * hash(c, 7, 910);
    /* One low is placed by hand: south of Newfoundland, its cold front trailing along 28 N across
       the water east of the Cape — the first weather a flight out of the pad passes over. */
    if (c < 0) { lat0 = 45; lon0 = -57; R = 11; rot = -0.2; pitch = 0.5; age = 1; reach = 2.4; }
    const cosa = pitch / Math.hypot(1, pitch);
    stamp(W, H, lat0, lon0, (reach + 0.3) * R, (i, ex0, ey0) => {
      /* nothing in the sky is drawn with a compass: the plane the comma is drawn in is itself bent */
      if (ex0 * ex0 + ey0 * ey0 > (reach + 0.75) * (reach + 0.75) * R * R) return;      // the bend moves a point 0.33 R at most
      const iu = (i % W) / W, iv = ((i / W) | 0) / H;
      const ex = ex0 + R * (0.34 * (sphereNoise(iu, iv * 0.55, 24, 921 + c) - 0.5) + 0.12 * (sphereNoise(iu, iv * 0.55, 70, 931 + c) - 0.5));
      const ey = ey0 + R * (0.34 * (sphereNoise(iu, iv * 0.55, 24, 951 + c) - 0.5) + 0.12 * (sphereNoise(iu, iv * 0.55, 70, 961 + c) - 0.5));
      const x = ex / R, y = ey / R, r = Math.hypot(x, y);
      if (r > reach + 0.3) return;
      const rr = Math.max(r, 0.02);
      /* angle from the band at this radius: negative is behind the front (toward the low) */
      const th = wrapPi(Math.atan2(y, x) - (Math.PI + rot - Math.log(rr / R0) / pitch));
      const d = rr * th * cosa;                                // distance from the band's centre line, in R
      const fadeOut = 1 - smoothstep(reach - 0.6, reach, r), fadeIn = smoothstep(0.06, 0.2, r);
      const w = (0.06 + 0.17 * Math.exp(-r / 0.9)) * (0.75 + 0.5 * sphereNoise(iu, iv * 0.55, 40, 981 + c));
      /* the slot first: it cuts what the fbm put there, and the band is then laid over it */
      const slot = Math.exp(-Math.pow((d + 2.4 * w + 0.05) / (1.5 * w + 0.05), 2)) * fadeIn * (1 - smoothstep(0.9, 1.9, r));
      syn[i] -= 0.75 * slot;
      /* behind the slot, the cold air: a field of open cells, in streets that follow the band */
      const cold = smoothstep(-0.25, -0.55, d + 2.4 * w) * smoothstep(-1.35, -0.8, d) * smoothstep(0.55, 0.9, r) * fadeOut;
      if (cold > 0.01) { put(i, cold, -0.10); if (cold > comb[i]) comb[i] = cold; }
      put(i, Math.exp(-d * d / (w * w)) * fadeIn * fadeOut * (0.72 + 0.28 * smoothstep(0.3, 0.55, sphereNoise(iu, iv * 0.55, 56, 991 + c))), 0.5 * age);
      const hx = x + 0.10 * Math.cos(rot), hy = y - 0.24;
      put(i, Math.exp(-(hx * hx + hy * hy) / 0.11), 0.5 * age);
    });
  }

  /* Tropical cyclones: small, round, unmistakable. */
  const TC = [[17, -57, 4.2], [-15, 78, 3.8], [19, 138, 4.6], [-17, -118, 3.4]];
  for (const [lat0, lon0, R] of TC) stamp(W, H, lat0, lon0, 1.5 * R, (i, ex, ey) => {
    const r = Math.hypot(ex, ey) / R;
    if (r > 1.5) return;
    const th = Math.atan2(ey, ex) + Math.log(Math.max(r, 0.03)) / 0.35;
    const arms = Math.pow(0.5 + 0.5 * Math.cos(2 * th), 3) * smoothstep(1.4, 0.75, r) * smoothstep(0.2, 0.45, r);
    const disc = Math.exp(-r * r / 0.14);
    const eye = smoothstep(0.035, 0.09, r);
    syn[i] -= 0.5 * smoothstep(1.5, 0.9, r) * (1 - Math.max(arms, disc));     // the clear moat round it
    put(i, Math.max(arms * 0.9, disc) * eye, 0.5);
    if (r < 0.09) syn[i] = Math.min(syn[i], -0.5 + eye);
  });
}

let _macro = null;
export function macroField() {
  if (_macro) return _macro;
  const W = MACRO_W, H = MACRO_H, x = new Float32Array(W * H), vary = new Float32Array(W * H), syn = new Float32Array(W * H), comb = new Float32Array(W * H);
  for (let iy = 0; iy < H; iy++) {
    const lat = ((iy + 0.5) / H - 0.5) * 180, a = Math.abs(lat);
    const itcz = 1.95 * Math.exp(-Math.pow((a - 4) / 9, 2));
    const midlat = 0.50 * Math.exp(-Math.pow((a - 52) / 14, 2));
    const dry = -0.55 * Math.exp(-Math.pow((a - 25) / 9, 2));
    const polar = 0.30 * Math.exp(-Math.pow((a - 78) / 12, 2));
    const belt = 0.34 + itcz + midlat + dry + polar;
    const driftGate = smoothstep(12, 20, a) - smoothstep(64, 82, a);
    const dryer = 0.10 * Math.exp(-Math.pow((a - 25) / 10, 2));
    const tradeGate = smoothstep(7, 12, a) * smoothstep(36, 27, a);
    for (let ix = 0; ix < W; ix++) {
      const u = ix / W, v = iy / H;
      const wu = (sphereNoise(u, v, 7, 99) - 0.5) * 0.09, wv = (sphereNoise(u, v, 11, 77) - 0.5) * 0.05;
      let sum = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 6; k++) { sum += amp * sphereNoise(u + wu, (v + wv) * 0.55, 16 << k, 40 + k); tot += amp; amp *= 0.5; }
      const cl = smoothstep(0.55, 0.80, sphereNoise(u + wu, (v + wv) * 0.55, 22, 151));
      x[iy * W + ix] = sum / tot + belt * 0.11 + driftGate * 0.30 * cl * cl;
      let vs = 0; amp = 0.5; tot = 0;
      for (let k = 0; k < 4; k++) { vs += amp * sphereNoise(u + wv, v * 0.5 + wu, 14 << k, 300 + k); tot += amp; amp *= 0.6; }
      vary[iy * W + ix] = vs / tot;
      /* The synoptic sheet's ground is the SAME argument, so a system seen from the pad is still
         there from orbit: where red reads 1 (72 % cover) this reads +0.12 (86 %), and where red
         reads 0 — 8 % of fair-weather cumulus — this reads -0.30 (0.2 %). Then what the tropics
         are made of besides the ITCZ: fields of trade cumulus combed into streets along the wind,
         and decks of stratocumulus. */
      const xs = x[iy * W + ix] - 0.30 * driftGate * cl * cl;
      let sv = Math.min(0.36, -0.30 + (xs - 0.585) * 2.35) - dryer + 0.10 * (sphereNoise(u + wv, v * 0.55 + wu, 90, 530) - 0.5);
      if (tradeGate > 0.01) {
        /* the belt's edge is in the noise's argument, not multiplied on afterwards: a mask times a
           gate has the gate's straight edge */
        const su = u + 2 * wu, sw = (v + 2 * wv) * 0.55, gate = 0.3 * (tradeGate - 1);
        const field = smoothstep(0.53, 0.62, 0.6 * sphereNoise(su, sw, 20, 541) + 0.4 * sphereNoise(su, sw, 53, 543) + gate);
        const deck = smoothstep(0.66, 0.73, 0.6 * sphereNoise(su, sw, 15, 547) + 0.4 * sphereNoise(su, sw, 41, 549) + gate);
        sv = Math.max(sv, -0.5 + 0.33 * field, -0.5 + 0.62 * deck);
        comb[iy * W + ix] = field;
      }
      syn[iy * W + ix] = sv;
    }
  }
  drawSystems(syn, comb, W, H);
  /* Cyclones, stamped into the same argument. Northern lows wind anticlockwise, southern clockwise. */
  for (let c = 0; c < CYCLONES; c++) {
    const south = c & 1, lat0 = (south ? -1 : 1) * (36 + 26 * hash(c, 1, 900)), lon0 = 360 * hash(c, 2, 900);
    const R = 7 + 6 * hash(c, 3, 900);                      // degrees of latitude: 780 .. 1450 km
    const phase = 6.283 * hash(c, 4, 900), turn = south ? -1 : 1;
    const cosl = Math.cos(lat0 * Math.PI / 180);
    const y0 = Math.max(0, Math.floor((lat0 - R + 90) / 180 * H)), y1 = Math.min(H - 1, Math.ceil((lat0 + R + 90) / 180 * H));
    const half = Math.ceil(R / cosl / 360 * W), xc = Math.round(lon0 / 360 * W);
    for (let iy = y0; iy <= y1; iy++) for (let dx = -half; dx <= half; dx++) {
      const ix = ((xc + dx) % W + W) % W;
      const ey = (((iy + 0.5) / H - 0.5) * 180 - lat0) / R, ex = dx / W * 360 * cosl / R;
      const r = Math.hypot(ex, ey);
      if (r >= 1) continue;
      /* a logarithmic spiral: the arm's bearing advances as it winds in */
      let th = Math.atan2(ey, ex) * turn - phase - 2.6 * Math.log(r + 0.12);
      th -= 6.283185 * Math.round(th / 6.283185);
      const win = smoothstep(1, 0.72, r);
      const arm = Math.exp(-th * th / 0.50) * smoothstep(0.03, 0.22, r);
      const slot = Math.exp(-(th + 1.25) * (th + 1.25) / 0.45) * smoothstep(0.08, 0.3, r);
      const core = Math.exp(-r * r / 0.035);
      x[iy * W + ix] += win * (0.17 * arm + 0.10 * core - 0.12 * slot);
    }
  }
  const data = new Uint8Array(W * H * 4);
  /* r: the systems. g: the variety sheet, stretched to fill 0..1 around 0.5. */
  let vlo = Infinity, vhi = -Infinity;
  for (const v of vary) { if (v < vlo) vlo = v; if (v > vhi) vhi = v; }
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = Math.round(255 * smoothstep(0.585, 0.765, x[i]));
    data[i * 4 + 1] = Math.round(255 * (vary[i] - vlo) / (vhi - vlo));
    data[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + syn[i])));
    data[i * 4 + 3] = Math.round(255 * Math.min(1, comb[i]));
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true;
  _macro = { tex, data };
  return _macro;
}

/* The high veil: thin zonal streaks rather than cells, so the fbm is stretched hard along
   longitude and thickens toward the tropics. 1024 x 512, value in every channel. */
let _veil = null;
export function veilField() {
  if (_veil) return _veil;
  const W = 1024, H = 512, data = new Uint8Array(W * H * 4);
  for (let iy = 0; iy < H; iy++) {
    const v = iy / (H - 1), lat = (v - 0.5) * Math.PI;
    const belt = 0.62 + 0.38 * Math.cos(lat * 1.7);
    for (let ix = 0; ix < W; ix++) {
      const u = ix / W;
      let sum = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 5; k++) { sum += amp * sphereNoise(u, v * 0.30 + 0.02 * k, 8 << k, k + 1); tot += amp; amp *= 0.5; }
      const q = Math.round(255 * smoothstep(0.42, 0.75, (sum / tot) * belt)), i = (iy * W + ix) * 4;
      data[i] = data[i + 1] = data[i + 2] = q; data[i + 3] = 255;
    }
  }
  _veil = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  _veil.wrapS = THREE.RepeatWrapping; _veil.wrapT = THREE.ClampToEdgeWrapping;
  _veil.magFilter = THREE.LinearFilter; _veil.minFilter = THREE.LinearMipmapLinearFilter;
  _veil.generateMipmaps = true; _veil.needsUpdate = true;
  return _veil;
}
