import * as THREE from 'three';
import { RE, PAD_LAT, PAD_LON } from './constants.js';
import { C } from './palette.js';
import {
  FW, FH, pixels, cleanMask, openClose, dilate, voteLabels, boxSignal, noise, fbm, sampleGrid, chamfer,
} from './paintkit.js';
import { padWeight, padShoreWeight, padAuthored } from './padsite.js';

/* The Earth's paint job: land mask, biome classification, the painted canvas, the height field and
   the signed coast distance — one decode, several products. js/toonmap.js owns the registry that
   hands them out. */

export async function paintEarthJob(diffusePath, maskPath, normalPath) {
  const [dif, spec, nrm] = await Promise.all([pixels(diffusePath), pixels(maskPath), pixels(normalPath)]);
  const w = dif.w, h = dif.h, d = dif.data, s = spec.data;
  const sea = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) sea[i] = s[i * 4] > 110 ? 1 : 0;         // specular white is water
  const land = new Uint8Array(w * h);
  for (let i = 0; i < land.length; i++) land[i] = sea[i] ? 0 : 1;
  const cleaned = openClose(cleanMask(land, w, h, 5), w, h, 1);
  /* (round 5: the shore/outer/stroke dilate masks are gone — the sea bands below are painted from
     the smoothed signed distance instead, which is why no boundary here staircases any more.) */

  /* Classify the BIOME from smoothed signals, not from one texel's own pixel. A 2048-wide diffuse is
     19.5 km per texel and the JPEG is noise at that scale, so a per-texel decision turned every
     continent into a checkerboard of grass and forest — and because the near ground samples this same
     map, that checkerboard is exactly the field of dark rectangles the user called horrific. A 7-texel
     (~140 km) separable box gives the classifier the spatial coherence a biome has. Nothing about the
     edges softens: the coastline comes from the signed distance field and the launch site from
     `bakePadCoast`, both untouched below. */
  const luS = new Float32Array(w * h), aridS = new Float32Array(w * h), satS = new Float32Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    luS[i] = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
    aridS[i] = r - b;
    satS[i] = mx ? (mx - mn) / mx : 0;
  }
  boxSignal(luS, w, h, 3); boxSignal(aridS, w, h, 3); boxSignal(satS, w, h, 3);

  /* Land is classified into a LABEL, and the labels are then voted over. Smoothing the signals is not
     enough on its own: wherever a value sits on a threshold, adjacent texels flip between two biomes,
     and at 19.5 km per texel that flip is the field of small dark rectangles the near ground wore. A
     plurality vote on the label is what gives a biome the spatial extent the eye reads as "the forest
     over there". Water is deliberately outside the vote — its edge comes from the cleaned mask and the
     coastline is the one boundary the art direction wants hard. */
  const PAL = [null, C.ice, C.iceEdge, C.desert, C.rock, C.tundra, C.boreal, C.forest, C.grass];
  const lab = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = 90 - (y + 0.5) * (180 / h);
    const aLat = Math.abs(lat);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cleaned[i]) continue;
      const lu = luS[i], sat = satS[i];
      /* The shipped diffuse is dark and blue-shifted over land — the Amazon is rgb(35,38,57), the
         same hue band as the sea — so hue carries no biome information here. What does carry it is
         the sign of red minus blue and the brightness: dry ground scatters red above blue, vegetation
         sits blue-above-red, and everything else dark is forest that the JPEG has crushed. */
      const arid = aridS[i], cold = aLat > 55;
      if (aLat > 70 || (lu > 0.78 && sat < 0.15)) lab[i] = aLat > 74 || lu > 0.86 ? 1 : 2;
      else if (arid > 6) lab[i] = lu > 0.35 ? 3 : 4;
      else if (cold) lab[i] = lu > 0.24 ? 5 : 6;
      else if (-arid > 6 || lu < 0.34) lab[i] = lu < 0.22 ? 7 : 8;
      else lab[i] = 4;
    }
  }
  voteLabels(lab, cleaned, w, h, 2);
  voteLabels(lab, cleaned, w, h, 1);

  const out = new Uint8ClampedArray(w * h * 4);
  /* The sea-side colour comes from the smoothed signed distance, not from the dilate masks.
     The masks (dilate [9,4,2]) staircased at one 20 km texel per tread and review 4 measured the
     result at 160 km as "stepped ocean-depth terraces" and a "100-200 km-wide dark zone" around
     every coast: at those slants the MAP texture is what the eye has, so smoothing the SDF the
     shader reads fixed nothing the canvas drew. Blending each band edge over ~1 texel of SDF
     turns every boundary into a graded iso-line; bilinear sampling carries it to a curve. */
  const coast = earthCoast(cleaned, w, h);
  const sdf = coast.km;
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  /* Round 6b: H 14 -> 60 km. With a 28 km blend the shelf-break iso-line (sd ≈ 175) read at
     160 km as a dark curve running parallel to the limb — the "floating tear" again. A 120 km
     graded band keeps the near/far sea two tones (review 4's monotone complaint) but no longer
     draws a line where there is no coast. */
  const H = 60;                                   // km blend half-width ≈ 3 texels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      if (lab[i]) {
        const c = PAL[lab[i]];
        // a beach band inside the land, blended on the same smooth SDF: without it the binary
        // biome-mask edge met the graded sea bands directly and kept a 20 km staircase of its own
        const sdl = sdf[i];
        const wsand = ss(-40, -6, sdl) * 0.8;
        out[o] = c[0] + (206 - c[0]) * wsand;
        out[o + 1] = c[1] + (186 - c[1]) * wsand;
        out[o + 2] = c[2] + (132 - c[2]) * wsand;
        /* Round 6b (user: "the whole Earth should be ONE continuous beautiful planet" — a 50 km
           straight-edged slab at the launch site, 20 km checkerboards on every coast): the land
           side of the mask was BINARY — one texel biome, the next texel sea, bilinear or not,
           because the blend lived only in the sea's SDF bands. A texel adjacent to water now
           finishes the blend itself: its biome fades to the coastal water tone over the last
           ~16 km of SDF, so across the boundary the two sides arrive at the same colour and the
           boundary stops being a staircase. The coast still reads hard from orbit (16 km at
           400 km is a few pixels); it only stops being a lottery. */
        const wsea = ss(-18, -2, sdl) * 0.9;
        out[o] += (C.coast[0] - out[o]) * wsea;
        out[o + 1] += (C.coast[1] - out[o + 1]) * wsea;
        out[o + 2] += (C.coast[2] - out[o + 2]) * wsea;
      } else {
        const sd = sdf[i];
        const wo = 1 - ss(115, 235, sd), ws = 1 - ss(95 - H, 95 + H, sd), wc = 1 - ss(25 - H, 25 + H, sd);
        // open ocean was one value everywhere (review 4: "the low-orbit oceans of 09/15 are
        // monotone flats"): three slow tones, ~900-1500 km wavelength, far slower than any mesh
        const u = (x + 0.5) / w, v2 = (y + 0.5) / h;
        const TAU = 6.2831853;
        const dw = 0.5 + 0.5 * Math.sin(TAU * 24 * u) * Math.sin(TAU * 14 * v2 + 1.7)
                 + 0.35 * Math.sin(TAU * 11 * u + 0.6) * Math.sin(TAU * 8 * v2);
        /* Round 6b: the three open-ocean tones are a GRADED field now. The binary thresholds
           (dw > 0.42, dw > 0.62, hard at sd = 175) printed iso-contours of the sine product as
           black ribbons across the sea — measured at 695 km as a ~200 km-wide lens stepping
           12 % darker with a hard edge, the "seam tear" of review 5 and of the first 06 shot.
           Two smoothsteps: the modulation itself ramps with dw, and it fades in with distance
           from the coast instead of switching on at the 175 km iso-line. */
        const tf = 1 + ss(140, 210, sd) * (-0.06 + 0.12 * ss(0.35, 0.72, dw));
        for (let ch = 0; ch < 3; ch++) {
          let v = C.deep[ch];
          v += (C.ocean[ch] - v) * wo;
          v += (C.shelf[ch] - v) * ws;
          v += (C.coast[ch] - v) * wc;
          out[o + ch] = v * tf;
        }
      }
      out[o + 3] = 255;
    }
  }
  bakePadCoast(out, w, h);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  const rug = ruggedness(nrm, cleaned, w, h);
  return { canvas: cv, data: { w, h, bytes: surfaceFields(lab, cleaned, rug, w, h) }, ...buildEarthField(cleaned, rug, coast, w, h) };
}

/* The painted map takes the authored launch-site geography too: inside the blend radius the texels
   adopt the authored colours — marsh and grassland, a sand band on the beaches, shallow shelf tones
   in the lagoons, plain ocean beyond the cape — mixed toward the global paint by the same weight
   everything else uses, so the correction has no seam. A 20 km texel cannot resolve an 8 km
   island; the bake is the far-LOD hint of it, while the signed distance and js/terrain.js carry
   the true shape at every zoom. Without this the launch complex reads as a plate on open sea. */
function bakePadCoast(out, w, h) {
  const R = 0.8;                                             // degrees around the site, past the 0.6° blend
  const j0 = Math.max(0, Math.floor((90 - PAD_LAT - R) * h / 180));
  const j1 = Math.min(h - 1, Math.ceil((90 - PAD_LAT + R) * h / 180));
  for (let y = j0; y <= j1; y++) {
    const lat = 90 - (y + 0.5) * 180 / h;
    for (let x = 0; x < w; x++) {
      const lon = ((x + 0.5) / w) * 360 - 180;
      if (Math.abs(lon - PAD_LON) > R) continue;
      const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;   // rows count south, uv.v counts north
      /* Round 6b: 3×3 coverage per texel. The authored geography is 5–13 km wide (barrier
         island, lagoons) and the canvas texel is 20 km: sampled once, every texel drew ONE
         zone's full colour, and the Merritt Island coast became a per-texel lottery — the
         "big square" of alternating lagoon-blue and island-green the user pointed at. Nine
         sub-samples average the coverage, so a texel the island crosses a third of the way
         through goes a third of the way to island green: continuous at orbit scale, and the
         near level draws the true shape analytically anyway (js/terrain.js colour()). */
      let ar = 0, ag = 0, ab = 0, aw = 0;
      for (let sy = -1; sy <= 1; sy++) {
        for (let sx = -1; sx <= 1; sx++) {
          const uu = u + sx / (3 * w), vv = v - sy / (3 * h);
          const wts = padShoreWeight(uu, vv);
          if (wts <= 0.02) continue;
          const c2 = padAuthored(uu, vv);
          if (!c2) continue;
          ar += c2[0] * wts; ag += c2[1] * wts; ab += c2[2] * wts; aw += wts;
        }
      }
      if (aw <= 0) continue;
      const col = [ar / aw, ag / aw, ab / aw];
      const wt = aw / 9;
      const o = (y * w + x) * 4;
      out[o] += (col[0] - out[o]) * wt;
      out[o + 1] += (col[1] - out[o + 1]) * wt;
      out[o + 2] += (col[2] - out[o + 2]) * wt;
    }
  }
}

/* ---- Earth: land only, oceans and shelf exactly 0, pad neighbourhood exactly 0 ---- */

function buildEarthField(land, rug, coast, sw, sh) {
  const w = FW, h = FH;
  const km = new Float32Array(w * h);
  /* Downsample the cleaned mask, then dilate the sea side of it on the SMALL grid: land touching
     the sea band gets a 0.12 amplitude, land within ~80 km 0.45, interior full. Without that ramp
     a half-kilometre continent edge meeting zero-height ocean is a painted cliff at every coast. */
  const sea = new Uint8Array(w * h);
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const srow = ((y * sh / h) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const l = land[srow + ((x * sw / w) | 0)] ? 1 : 0;
      on[y * w + x] = l;
      sea[y * w + x] = l ? 0 : 1;
    }
  }
  const srowOf = (y) => ((y * sh / h) | 0) * sw;
  const near1 = dilate(sea, w, h, [1]);
  const near2 = dilate(sea, w, h, [2]);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const aLat = Math.abs(90 - (y + 0.5) * 180 / h);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!on[i]) continue;                      // ocean and the shelf stay at exactly 0: splashdown lands on the sphere
      const u = (x + 0.5) / w;
      const wgt = near1[i] ? 0.12 : near2[i] ? 0.45 : 1;
      /* Where the mountains are is DATA now: `rug` is the slope magnitude of the shipped normal
         sheet (see ruggedness), so the Himalaya, the Andes, the Alps and the Rockies stand where
         they stand and the plains are plains. The seeded swell that used to be the whole field is
         kept at a third of its amplitude so a continent's interior is not a billiard table. */
      const broad = fbm(u, v * 2, 16, 2, 5);     // ~1300–2600 km continental swells
      const r = rug[srowOf(y) + ((x * sw / w) | 0)];
      km[i] = wgt * (0.14 * broad + 1.25 * r + 0.04 * noise(u, v * 2, 160, 17))
            + (aLat > 72 ? 0.5 : 0);             // the ice sheets really are plateaus; Greenland, Antarctica
    }
  }
  /* Shore feather: land eases to exactly 0 over the last 180 km toward the sea, using the same
     1-Lipschitz SDF the colours read. Without it a half-km continent meets zero-height ocean on a
     one-cell step and the far mesh draws that step as a staircase cliff — measured as the w25 dark
     band, (44,68,68)→(31,49,71) over 75 px. Round 4's 40 km feather still staircased (review 4,
     frames 08/09: "stepped ocean-depth terraces") because the FAR MESH is 384×192 — one vertex per
     ~104 km — so a ramp under one cell wide is sampled as a step no matter how smooth the field is.
     180 km ≈ 2 cells: the staircase is gone when the field that feeds the mesh varies slower than
     the mesh, which is the same rule the colour bakes already obey. */
  for (let i = 0; i < km.length; i++) {
    // uv, not grid coords: v counts north while rows count south — mixing them flattens the antipode
    const u = (i % w + 0.5) / w, v = 1 - (Math.floor(i / w) + 0.5) / h;
    let k = km[i];
    if (k > 0) {
      const sd = sampleGrid(coast, u, v);              // km, negative inland
      if (sd > -180) {
        const s = THREE.MathUtils.clamp(-sd / 180, 0, 1);
        k *= s * s * (3 - 2 * s);
      }
    }
    km[i] = THREE.MathUtils.clamp(k * padWeight(u, v), 0, 1.4);
  }
  /* One tent pass over the finished grid (footprint ~60 km on the 20 km field): kills the ridged
     octave's fastest spines, which sat at the same ~100 km wavelength as the far mesh row and drew
     terraces inland too. Mountains keep their mass (the broad+ridge envelope is 300 km+); the mesh
     can no longer alias the field into steps. */
  {
    const sm = Float32Array.from(km);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, wsum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const wgt = (dx ? 1 : 2) * (dy ? 1 : 2);
          const yy = (y + dy + h) % h, xx = (x + dx + w) % w;
          s += km[yy * w + xx] * wgt; wsum += wgt;
        }
        sm[y * w + x] = s / wsum;
      }
    }
    km.set(sm);
  }
  return { field: { w, h, km }, coast };
}

/* Signed distance to the coastline in km, negative inland, so a smooth boundary falls out of
   smoothstep instead of inheriting the mask's 20 km staircase: two chamfer sweeps from each side
   (approximate euclidean — the shore must be curve-true, not metrological), and the result is a
   1-Lipschitz field, which is exactly what makes its bilinear zero-crossing free of the wedge and
   stripe artefacts thresholded noise fields produce. Wrap in longitude, clamp at the poles. */
function earthCoast(land, w, h) {
  const INF = 1e8;
  const toOcean = new Float32Array(w * h);
  const toLand = new Float32Array(w * h);
  for (let i = 0; i < toOcean.length; i++) { toOcean[i] = land[i] ? INF : 0; toLand[i] = land[i] ? 0 : INF; }
  chamfer(toOcean, w, h);
  chamfer(toLand, w, h);
  const km = new Float32Array(w * h);
  const kmr = Math.PI * RE / h;
  for (let y = 0; y < h; y++) {
    const e = kmr * Math.max(0.05, Math.cos((90 - (y + 0.5) * 180 / h) * Math.PI / 180));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      km[i] = (land[i] ? -toOcean[i] : toLand[i]) * e;
    }
  }
  /* 5×5 binomial tent (footprint ~80 km). The raw chamfer field is only as round as the MASK that
     fed it, and the mask staircases at one 20 km texel — every isoline of the raw field, including
     the zero line the ink band draws, is a staircase. Review 4 measured the result at 160 km:
     "coastline as a 100-200 km-wide dark zone with ~40-60 px treads". Blurring the DISTANCE, not
     the mask, rounds every isoline at once; the zero-crossing moves by less than a texel, and the
     SDF stays 1-Lipschitz to within the kernel. Strains narrower than ~80 km merge — at 20 km per
     texel they were never really drawn anyway. */
  {
    const sm = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, wsum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const wgt = [1, 4, 6, 4, 1][dx + 2] * [1, 4, 6, 4, 1][dy + 2] / 256;
          const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = (x + dx + w) % w;
          s += km[yy * w + xx] * wgt; wsum += wgt;
        }
        sm[y * w + x] = s / wsum;
      }
    }
    km.set(sm);
  }
  return { w, h, km };
}

/* Ruggedness, 0..1 per texel of the 2048 grid: the tangent-plane tilt of the shipped normal sheet,
   read as DATA (no pixel of it is ever drawn). Measured on the sheet, 5×5 mean tilt in 8-bit units:
   Himalaya 72.6, Alps 71.1, Andes 36.7, Rockies 30.9, Tibet 29.6 against Sahara 7.0, Amazon 4.1,
   Florida 2.0 and open ocean 2.0 — so a floor of 6 and a ceiling of 66 puts every range on the map
   and leaves the plains at exactly zero. One r-1 box pass takes the JPEG ringing out. */
function ruggedness(nrm, land, w, h) {
  const r = new Float32Array(w * h), d = nrm.data;
  if (nrm.w !== w || nrm.h !== h) return r;
  for (let i = 0, o = 0; i < w * h; i++, o += 4) r[i] = land[i] ? Math.hypot(d[o] - 128, d[o + 1] - 128) : 0;
  boxSignal(r, w, h, 2);
  for (let i = 0; i < w * h; i++) r[i] = land[i] ? Math.min(1, Math.max(0, (r[i] - 6) / 60)) : 0;
  boxSignal(r, w, h, 1);
  return r;
}

/* The fields js/surface.js draws from, RGBA8 on the 2048 grid, rows SOUTH first (a DataTexture's
   row 0 is v = 0): R aridity, G tree cover, B cold, A ruggedness.

   They are the voted biome labels turned back into smooth memberships: each label votes a value on
   three axes, and a land-weighted box mean (r 2, ~100 km) makes the result a field the shader can
   threshold — at any zoom, with its own noise on the threshold — instead of a 20 km lattice of
   decisions. Sea texels inherit the nearest land's values so a coast the shader moves a few
   kilometres still finds a biome under it. */
const AXES = [    // label → [arid, tree, cold]
  [0, 0, 0], [0, 0, 1], [0, 0, 0.8], [1, 0, 0], [0.6, 0, 0], [0.2, 0, 0.55], [0, 1, 0.3], [0, 1, 0], [0.15, 0, 0],
];
function surfaceFields(lab, land, rug, w, h) {
  const out = new Uint8Array(w * h * 4);
  const wt = new Float32Array(w * h), wide = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) wt[i] = wide[i] = land[i] ? 1 : 0;
  boxSignal(wt, w, h, 2); boxSignal(wide, w, h, 9);
  const f = new Float32Array(w * h), fw = new Float32Array(w * h);
  for (let ax = 0; ax < 3; ax++) {
    for (let i = 0; i < w * h; i++) f[i] = fw[i] = land[i] ? AXES[lab[i]][ax] : 0;
    boxSignal(f, w, h, 2); boxSignal(fw, w, h, 9);
    for (let y = 0; y < h; y++) {
      const orow = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = wt[i] > 0.04 ? f[i] / wt[i] : wide[i] > 1e-4 ? fw[i] / wide[i] : 0;
        out[(orow + x) * 4 + ax] = Math.round(255 * Math.min(1, Math.max(0, v)));
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const orow = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) out[(orow + x) * 4 + 3] = Math.round(255 * rug[y * w + x]);
  }
  return out;
}
