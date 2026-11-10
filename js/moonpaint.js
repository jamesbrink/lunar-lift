import * as THREE from 'three';
import { RM } from './constants.js';
import { MOON } from './palette.js';
import {
  FW, FH, pixels, openClose, boxSignal, shareBelow, quantile, hash2, noise, fbm, smoothS,
} from './paintkit.js';

/* The Moon's paint job: the map canvas, the shader's fields, and the relief grid with its 560 craters. */

const MOON_CIRC = 2 * Math.PI * RM;

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
  const mareCut = quantile(wide, shareBelow(blur, 0.36));
  const rawMare = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) rawMare[i] = wide[i] < mareCut ? 1 : 0;
  const mare = openClose(rawMare, w, h, 2);   // 2 rounds at 10.7 km: the corner shave the relief's mare step wants
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = blur[i];
    const col = mare[i] ? MOON.maria : v < 0.47 ? MOON.mid : v < 0.62 ? MOON.high : MOON.bright;
    const o = i * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
  }
  mareCollar(out, mare, w, h);
  stampCraterAlbedo(out, blur, w, h);
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
     shapes rather than JPEG blocks), G the wide field the mare cut lives on, B the relief craters'
     tone around 0.5 — the same stamp the canvas gets, into a neutral plate. */
  const alb = blur.slice();
  boxSignal(alb, w, h, 1);
  const plate = new Uint8ClampedArray(w * h * 4).fill(128);
  stampCraterAlbedo(plate, blur, w, h);
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const orow = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = (orow + x) * 4;
      bytes[o] = Math.round(255 * Math.min(1, alb[i]));
      bytes[o + 1] = Math.round(255 * Math.min(1, wide[i]));
      bytes[o + 2] = plate[i * 4];
      bytes[o + 3] = 255;
    }
  }
  return { canvas: cv, data: { w, h, bytes, mareCut }, ...buildMoonField(blur, w, h, mare) };
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
