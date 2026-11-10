import * as THREE from 'three';
import { RM } from './constants.js';
import { MOON } from './palette.js';
import {
  FW, FH, pixels, openClose, boxSignal, shareBelow, quantile, noise, fbm, smoothS, sampleGrid,
} from './paintkit.js';
import { craterHeight, listCraters, craterDepth, craterRim } from './mooncraters.js';

/* The Moon's paint job: the map canvas, the shader's fields, and the relief grid. The craters are
   not in the grid: they are js/mooncraters.js's ladder, added on top by field.crater(). */

const MOON_CIRC = 2 * Math.PI * RM;

const MARE_AT = 0.43;

export async function paintMoonJob(path) {
  const src = await pixels(path);
  /* Painted at the sheet's own 1024 × 512 (10.7 km per texel). For a while this ran at 4× so the
     canvas could hold a 4 km bowl on three texels; that cost 8.4 M texels of morphology at boot
     (measured: the Moon was most of a 5.6 s paint) and still showed its texel grid from 110 km.
     The canvas is now only what the orbital map and the navball blit. The surface itself is drawn
     per fragment by js/surface-moon.js from the smooth fields returned as `data` below, so its
     edges are sharp at every range and nothing here has to be big. */
  const w = src.w, h = src.h, d = src.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) lum[i] = (d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11) / 255;
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
     on the 3×3-blurred field cannot do that: the dark plains are 3.2 % of the sheet spread over
     thousands of separate runs — a JPEG staircase. So the FIELD is smoothed first (r 7 then r 5,
     a ~340 km kernel) and the cut is taken back down to the same area: the value below which the
     same share of texels lie. The shader thresholds this same field at the same cut. */
  const wide = blur.slice();
  boxSignal(wide, w, h, 7);
  boxSignal(wide, w, h, 5);
  /* The sheet's maria are not as dark as 0.36: only 3.2 % of it is, and the Moon drawn from that
     had a few small ink blots where Imbrium and Procellarum should be. MARE_AT is the tone the
     sheet's dark plains actually end at (see docs/reference/painted-planets.md for the shares). */
  const mareCut = quantile(wide, shareBelow(blur, MARE_AT));
  const rawMare = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) rawMare[i] = wide[i] < mareCut ? 1 : 0;
  const mare = openClose(rawMare, w, h, 2);   // 2 rounds at 10.7 km: the corner shave the relief's mare step wants
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = blur[i];
    const col = mare[i] ? MOON.maria : v < 0.50 ? MOON.mid : v < 0.62 ? MOON.high : MOON.bright;
    const o = i * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
  }
  mareCollar(out, mare, w, h);
  const built = buildMoonField(blur, w, h, mare);
  stampCraterAlbedo(out, built.field.hi, w, h);
  /* Contrast curve ×1.5 about the mid tone, as the drawn surface's palette has it (js/surface.js). */
  for (let i = 0; i < out.length; i += 4) {
    out[i] = (out[i] - 140) * 1.5 + 140;
    out[i + 1] = (out[i + 1] - 140) * 1.5 + 140;
    out[i + 2] = (out[i + 2] - 140) * 1.5 + 140;
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);

  /* The shader's fields, rows SOUTH first: R albedo (one more r-1 pass, so a threshold on it draws
     shapes rather than JPEG blocks), G the wide field the mare cut lives on, B the highland weight
     the two largest crater octaves are scaled by — the relief's own number, so a flooded crater
     is flooded in the drawing and in the ground alike — and A where those two octaves can reach
     at all (craterReach), so the shader does not go looking for a 300 km crater in every pixel. */
  const alb = blur.slice();
  boxSignal(alb, w, h, 1);
  const hi = built.field.hi;
  const reachMask = craterReach(w, h);
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const orow = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = (orow + x) * 4;
      bytes[o] = Math.round(255 * Math.min(1, alb[i]));
      bytes[o + 1] = Math.round(255 * Math.min(1, wide[i]));
      bytes[o + 2] = Math.round(255 * hi[((y * FH / h) | 0) * FW + ((x * FW / w) | 0)]);
      bytes[o + 3] = reachMask[i];
    }
  }
  return { canvas: cv, data: { w, h, bytes, mareCut }, ...built };
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
      /* The stroke used to be an absolute value — a single 10.7 km texel of rgb(79,83,93)
         whose mip chain turned every mare border into a string of stamp-like dark dashes at orbit
         range. Blending 80 % keeps 0.8·54.1 = 43 levels of step at native
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
      const m = mare && mare[srow + ((x * sw / w) | 0)] ? 0 : smoothS(MARE_AT - 0.04, MARE_AT + 0.09, b);
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
  /* Soft knee above 1.7 km instead of letting the clamp do the shaping: a hard ±2 cap clipped
     ~3 % of texels (mostly crater rims on massif flanks) into flat plateaus. Compressing the
     headroom preserves ordering and relief everywhere and leaves the cap untouched in practice. */
  for (let i = 0; i < km.length; i++) {
    let k = km[i];
    if (k > 1.7) k = 1.7 + (k - 1.7) * 0.3;
    km[i] = THREE.MathUtils.clamp(k, -2.0, 2.0);
  }
  /* The craters ride on top of the grid, analytically (js/mooncraters.js): `spacing` is the vertex
     spacing of the mesh asking, 0 for the contact surface. hi is the grid the two largest octaves
     are weighted by. */
  const hiGrid = { w, h, km: hi };
  const crater = (x, y, z, u, v, spacing = 0) => craterHeight(x, y, z, sampleGrid(hiGrid, u, v), spacing);
  return { field: { w, h, km, hi, crater, farSpacing: 16 } };
}

/* Where the two largest crater octaves can touch the ground, rows NORTH first, one byte a texel:
   170 inside the reach of a 1024 km-lattice crater (its apron, or its rays), 85 inside a 256 km
   one's, 255 inside both — each grown by 40 km, so the bilinear edge of the mask stays outside
   the thing it guards. The shader reads it as two thresholds (js/surface-moon.js). */
function craterReach(w, h) {
  const m = new Uint8Array(w * h), kmr = Math.PI * RM / h;
  for (const k of [0, 1]) for (const cr of listCraters(k)) {
    const lat = Math.asin(cr.y);
    let u = Math.atan2(cr.z, -cr.x) / (2 * Math.PI); if (u < 0) u += 1;
    const cx = u * w, cy = (0.5 - lat / Math.PI) * h, reach = cr.reach * cr.r + 40, cosR = Math.cos(reach / RM);
    const ry = Math.ceil(reach / kmr) + 1, bit = k === 0 ? 170 : 85;
    for (let dy = -ry; dy <= ry; dy++) {
      const y = (cy + dy) | 0;
      if (y < 0 || y >= h) continue;
      const la = (0.5 - (y + 0.5) / h) * Math.PI, cl = Math.cos(la), sl = Math.sin(la);
      const rx = Math.min(w >> 1, Math.ceil(reach / (kmr * Math.max(0.02, cl))) + 1);
      for (let dx = -rx; dx <= rx; dx++) {
        const x = ((((cx + dx) | 0) % w) + w) % w, lo = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
        // three's sphere direction for this texel, against the crater's
        if (cl * Math.cos(lo) * cr.x + sl * cr.y - cl * Math.sin(lo) * cr.z < cosR) continue;
        const i = y * w + x;
        if (m[i] !== bit && m[i] !== 255) m[i] += bit;
      }
    }
  }
  return m;
}

/* The albedo pass for the painted MAP (the orbital chart and the navball blit this canvas; the
   ground itself is drawn per fragment). The same craters as the relief and the shader — the two
   largest octaves of js/mooncraters.js's ladder, which is everything a 10.7 km texel can hold:
   bowls shade darker, rims brighter, and the rayed ones throw their spokes. */
function stampCraterAlbedo(out, hi, w, h) {
  const kmr = Math.PI * RM / h;
  for (const k of [0, 1]) for (const cr of listCraters(k)) {
    const lat = Math.asin(cr.y);
    let u = Math.atan2(cr.z, -cr.x) / (2 * Math.PI); if (u < 0) u += 1;
    const cx = u * w, cy = (0.5 - lat / Math.PI) * h;
    const reach = cr.reach, rPx = cr.r / kmr;
    const depth = craterDepth(cr.r) / 3.5, rim = craterRim(cr.r) / 1.8, n = 6 + ((cr.h3 >>> 8) & 3) + ((cr.h3 >>> 10) & 1) * 2;
    const ry = Math.ceil(rPx * reach);
    for (let dy = -ry; dy <= ry; dy++) {
      const y = (cy + dy) | 0;
      if (y < 0 || y >= h) continue;
      const clat = Math.max(0.05, Math.cos((90 - (y + 0.5) * 180 / h) * Math.PI / 180));
      const rx = Math.min(w >> 1, Math.ceil(rPx * reach / clat));
      for (let dx = -rx; dx <= rx; dx++) {
        const x = ((((cx + dx) | 0) % w) + w) % w;
        const ex = dx * kmr * clat, ey = dy * kmr;
        const dd = Math.hypot(ex, ey) / cr.r;
        if (dd > reach) continue;
        const hk = (0.15 + 0.85 * hi[((y * FH / h) | 0) * FW + ((x * FW / w) | 0)]) * cr.own;
        let tone = 0;
        if (dd < 1.25) {
          if (dd < 0.92) { const t = dd / 0.92; tone -= (10 + 22 * depth) * (1 - t * t); }
          const g = (dd - 1.0) / 0.2;
          tone += (14 + 22 * rim) * Math.exp(-g * g);
          tone *= hk;
        } else {
          const th = Math.atan2(ey, ex);
          const sp = Math.cos(th * n + (cr.h3 & 63)) * (0.72 + 0.28 * Math.cos(th * 3 + ((cr.h3 >>> 6) & 63)));
          if (sp > 0.30 + 0.66 * (dd - 1) / (reach - 1)) tone += 30 * hk;
        }
        if (!tone) continue;
        const i = (y * w + x) * 4;
        out[i] += tone; out[i + 1] += tone; out[i + 2] += tone;
      }
    }
  }
}
