import * as THREE from 'three';
import { RE, RM, PAD_UP, PAD_EAST, PAD_LAT, PAD_LON } from './constants.js';

/* The planets are painted, not photographed.

   The shipped blue-marble JPEG is 2 048 × 1 024 of real satellite data, which is about 20 km per
   pixel: stretched over a sphere and seen from orbit it is a soft mud-coloured smear, and under a
   three-band cel ramp it gets worse, because the ramp quantises mush into more mush. Repainting the
   photo's own pixels does not help — that only posterises the mud.

   So the photo is used as *data* and never as a picture. The specular sheet is the useful one: it is
   a binary map of the world, ocean white and land black with almost nothing in between, so a
   threshold gives a clean land mask, and a majority filter over it gives crisp coastlines. From that
   mask every pixel of the visible map is authored colour — deep ocean, a shallow shelf band hugging
   the coast, a coastline stroke, and land sorted into ice, desert, forest, grass and rock by the
   diffuse sheet's hue and brightness plus latitude. The geography is still the real geography; the
   palette is a cartographer's, which is what cel shading wants.

   The decoded sheets yield one more thing: a height field per body, built by the same pass so the
   relief never costs a second decode. Painted colour on perfect spheres reads as a flat disc from
   orbit — a dead horizon and nothing moving under the terminator — so the fields displace the mesh
   vertices (js/world.js) and are differenced into tangent-space normal maps; see the relief section
   below the painting code. */

const C = {
  deep: [26, 84, 150],
  ocean: [48, 120, 192],
  shelf: [102, 176, 220],
  coast: [14, 40, 66],
  forest: [58, 104, 60],
  grass: [120, 154, 84],
  desert: [212, 184, 120],
  dune: [176, 168, 104],        // dune grass behind the beach line — the seam between sand and field
  rock: [150, 138, 122],
  boreal: [52, 80, 66],
  tundra: [126, 132, 114],
  ice: [233, 241, 246],
  iceEdge: [196, 214, 228],
  concrete: [168, 166, 156],    // LC-39 apron (near level only)
};

const MOON = {
  maria: [128, 132, 141],
  mid: [168, 171, 178],
  high: [206, 208, 214],
  bright: [230, 232, 236],
};

const loaded = new Map();

/* Decode an asset once and hand the raw pixels back at full resolution. */
function pixels(path) {
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
function cleanMask(mask, w, h, passes = 3) {
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

/* Grow a mask by a sequence of radii with a separable scan: O(w*h) per pass instead of the O(w*h*r²)
   a disc stamp would cost. One radius gives a square, and a square coastline is the most obviously
   synthetic thing on the planet; applying descending radii (7, then 3, then 1) approximates the disc
   as a rounded octagon for the same work, which is what the shelf band and the coast stroke want. */
function dilate(mask, w, h, radii) {
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

/* The Earth's painted map: 2 048 × 1 024, one output pixel per source texel. The height field and
   the signed coastline hang off the same decode: one paint job, several products. */
export function paintEarth(diffusePath, maskPath) {
  const job = paintEarthJob(diffusePath, maskPath);
  if (!fields.has('earth')) {
    fields.set('earth', job.then((r) => r.field));
    coasts.set('earth', job.then((r) => r.coast));
  }
  registerCanvas('earth', job);
  return job.then((r) => r.canvas);
}

async function paintEarthJob(diffusePath, maskPath) {
  const [dif, spec] = await Promise.all([pixels(diffusePath), pixels(maskPath)]);
  const w = dif.w, h = dif.h, d = dif.data, s = spec.data;
  const sea = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) sea[i] = s[i * 4] > 110 ? 1 : 0;         // specular white is water
  const land = new Uint8Array(w * h);
  for (let i = 0; i < land.length; i++) land[i] = sea[i] ? 0 : 1;
  const cleaned = cleanMask(land, w, h, 5);
  const shore = dilate(cleaned, w, h, [5, 2]);      // land + a few km of shallow water
  const outer = dilate(cleaned, w, h, [9, 4, 2]);
  /* The stroke goes in the water, just outside the coast — dilate gives land *plus* the ring, so the
     ring alone is what is wet but near dry. Painting the dilated mask itself inks every land pixel
     and the continents come out navy. */
  const grown = dilate(cleaned, w, h, [1]);
  const coast = new Uint8Array(w * h);
  for (let i = 0; i < coast.length; i++) coast[i] = cleaned[i] ? 0 : grown[i];

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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const col = lab[i] ? PAL[lab[i]] : (coast[i] ? C.coast : outer[i] ? (shore[i] ? C.shelf : C.ocean) : C.deep);
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
    }
  }
  bakePadCoast(out, w, h);
  /* The ground's own copy of the paint, blurred — built AFTER the launch-site bake so the blurred map
     carries the authored tones too. Blurring first put the global forest tone under and around the pad
     while the mesh itself wore authored grassland, and the blend between them read as a straight tonal
     line crossing the plain. See canvasDataSoft. */
  let lr = 0, lg = 0, lb = 0, lc = 0;
  for (let i = 0; i < w * h; i++) if (cleaned[i]) { const o = i * 4; lr += out[o]; lg += out[o + 1]; lb += out[o + 2]; lc++; }
  const soft = new Uint8ClampedArray(out.length);
  blurForGround(out, soft, w, h, cleaned, lc ? [lr / lc, lg / lc, lb / lc] : null);
  softOf.set('earth', soft);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return { canvas: cv, ...buildEarthField(cleaned, w, h) };
}

/* The painted map takes the authored launch-site geography too: inside the blend radius the texels
   adopt the authored colours — marsh and grassland, a sand band on the beaches, shallow shelf tones
   in the lagoons, plain ocean beyond the cape — mixed toward the global paint by the same weight
   everything else uses, so the correction has no seam. A 20 km texel cannot resolve an 8 km
   island; the bake is the far-LOD hint of it, while the signed distance and js/terrain.js carry
   the true shape at every zoom. Without this the launch complex reads as a plate on open sea. */
/* One plurality pass over a wrapping/equirect label grid: each land texel takes the biome that most
   of its neighbours chose, ties going to whatever it already had (so a genuinely mixed band settles
   instead of oscillating). Ocean texels neither vote nor receive votes, which keeps the coast exactly
   where the cleaned mask puts it. */
function voteLabels(lab, land, w, h, rad) {
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

/* Separable box mean over a wrapping longitude and a clamped latitude. */
function boxSignal(a, w, h, rad) {
  const tmp = new Float32Array(a.length);
  const n = 2 * rad + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += a[row + ((x + k) % w + w) % w];
      tmp[row + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += tmp[(Math.min(h - 1, Math.max(0, y + k))) * w + x];
      a[y * w + x] = s / n;
    }
  }
}

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
      const wt = padShoreWeight(u, v);
      if (wt <= 0.02) continue;
      const col = padAuthored(u, v);
      if (!col) continue;
      const o = (y * w + x) * 4;
      out[o] += (col[0] - out[o]) * wt;
      out[o + 1] += (col[1] - out[o + 1]) * wt;
      out[o + 2] += (col[2] - out[o + 2]) * wt;
    }
  }
}

/* The Moon is regolith with no hue worth keeping, so the painting is about contrast: box-blur away
   the JPEG's ringing, then snap to four flat tones. The dark patches become the maria and the bright
   spots the highlands and ray systems, which is exactly how a cartoon Moon is drawn. */
export function paintMoon(path) {
  const job = paintMoonJob(path);
  if (!fields.has('moon')) fields.set('moon', job.then((r) => r.field));
  registerCanvas('moon', job);
  return job.then((r) => r.canvas);
}

async function paintMoonJob(path) {
  const src = await pixels(path);
  const w = src.w, h = src.h, d = src.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
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
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = blur[i];
    const col = v < 0.36 ? MOON.maria : v < 0.47 ? MOON.mid : v < 0.62 ? MOON.high : MOON.bright;
    const o = i * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
  }
  stampCraterAlbedo(out, blur, w, h);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return { canvas: cv, ...buildMoonField(blur, w, h) };
}

/* ---------------- relief ----------------

   A painted sphere with no shape reads as a flat disc from orbit: a dead horizon and nothing moving
   under the terminator. Every paint pass therefore yields a height field too, consumed at two levels
   of detail: the far level displaces the body's mesh vertices (applyRelief, used by js/world.js),
   and the near level is a dense patch js/terrain.js lays over the ground under the vehicle. Both
   levels call the SAME functions below — the patch is the global field with extra octaves on top,
   faded out at its border — so they cannot disagree, which is the seam requirement.

   Everything is seeded lattice noise, hashed distance transforms and authored geometry: no
   Math.random anywhere, so the geology is identical every run and the mesh, the normal map, the
   patch and js/camera.js's colliders are all views of one field.

   Amplitudes are bounded for landing honesty: physics touches down on the exact spheres RE / RM, so
   the Moon's upward displacement is capped near 1.5 km and drama beyond that comes from the normal
   map, not from geometry the lander would sink into. The launch-pad neighbourhood is flattened to
   exactly zero (padWeight) because the pad mesh is welded to the Earth mesh at PAD_UP.

   Grids are plain { w, h, km: Float32Array } sampled through the sphere's analytic uv. Note the u,v
   convention, verified against three's SphereGeometry rather than the comment in constants.js
   (which is stale the other way): u = (lon+180)/360 wraps longitude, v = (lat+90)/180 with v=1 at
   the NORTH pole, texel centres at (ix+0.5)/w, and the painted grids' row 0 is north — so the row
   under a uv is (1 - v)·h - 0.5. */

const FW = 1024, FH = 512;                 // global height grid for both bodies (~10.7 / 39 km per texel)
const fields = new Map();                  // key → Promise<{w,h,km}>      heights in km
const coasts = new Map();                  // key → Promise<{w,h,km}>      signed shore distance in km
const canvases = new Map();                // key → Promise<HTMLCanvasElement>
const softOf = new Map();                  // key → Uint8ClampedArray, blurred at paint time
const softPx = new Map();                  // key → Promise<ImageData> of the blurred copy
const painted = new Map();                 // key → canvas, once landed (paintedCanvas)
const pixelsOf = new Map();                // key → Promise<ImageData>     raw authored pixels

const smoothS = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function registerCanvas(key, job) {
  if (canvases.has(key)) return;
  canvases.set(key, job.then((r) => r.canvas));
  job.then((r) => painted.set(key, r.canvas));
}

/* The painted canvas itself, for anything that must author from the same pixels as the texture —
   the orbital map reads it through js/world.js:planetCanvas rather than kicking off a second paint. */
export function paintedCanvas(key) { return painted.get(key) || null; }

export function reliefField(key) { return fields.get(key) || null; }
export function coastField() { return coasts.get('earth') || null; }

/* Raw ImageData of the painted map, extracted once per body: the near patch colours itself from
   exactly these bytes so a biome on the ground is the biome the orbit showed. getImageData is the
   one unavoidable readback; it costs ~10 ms and happens once per body off the paint promise. */
/* A blurred copy of the paint, for the GROUND to sample instead of the crisp map. The map is
   classified on a ~20 km grid: perfect when it is wrapped around a 40 000 km sphere, wrong under a
   vehicle, where a hundred kilometres of grass meeting a hundred kilometres of forest at a hard edge
   reads as cut-out rectangles rather than landscape. Averaging seven texels keeps every biome where it
   is and turns each border into the soft transition a real landscape has. Averaging is done over LAND
   ONLY: an ordinary blur would drag the navy of the sea 140 km inland and tint the coastal plain blue.
   The orbit keeps the crisp canvas; only js/terrain.js reads this. */
export function canvasDataSoft(key) {
  if (!softPx.has(key)) {
    softPx.set(key, Promise.all([canvasData(key), softOf.has(key) ? softOf.get(key) : null])
      .then(([src, pre]) => {
        const out = new ImageData(src.width, src.height);
        if (pre) out.data.set(pre);
        else boxBlurRGBA(src.data, out.data, src.width, src.height, 3);
        return out;
      }));
  }
  return softPx.get(key);
}

function blurForGround(src, dst, w, h, land, mean) {
  const tmp = new Float32Array(w * h * 3);
  const rad = 8;                                       // ≈160 km of longitude
  for (let y = 0; y < h; y++) {                       // longitude: wrapping, land-weighted
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let k = -rad; k <= rad; k++) {
        const j = row + ((x + k) % w + w) % w;
        if (!land[j]) continue;
        const o = j * 4;
        r += src[o]; g += src[o + 1]; b += src[o + 2]; c++;
      }
      const t = (row + x) * 3;
      if (c) { tmp[t] = r / c; tmp[t + 1] = g / c; tmp[t + 2] = b / c; }
      else {                                          // no land in this row: keep the paint itself
        const o = (row + x) * 4;
        tmp[t] = src[o]; tmp[t + 1] = src[o + 1]; tmp[t + 2] = src[o + 2];
      }
    }
  }
  for (let y = 0; y < h; y++) {                       // latitude: clamped
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let k = -rad; k <= rad; k++) {
        const yy = y + k < 0 ? 0 : y + k > h - 1 ? h - 1 : y + k;
        const j = (yy * w + x) * 3;
        if (!land[yy * w + x]) continue;
        r += tmp[j]; g += tmp[j + 1]; b += tmp[j + 2]; c++;
      }
      const o = (y * w + x) * 4;
      let R = r, G = g, B = b;
      if (!c) { R = src[o]; G = src[o + 1]; B = src[o + 2]; c = 1; }     // offshore: keep the paint
      R /= c; G /= c; B /= c;
      if (mean && land[y * w + x]) {                  // ease the mosaic toward one land tone
        R += (mean[0] - R) * 0.15; G += (mean[1] - G) * 0.15; B += (mean[2] - B) * 0.15;
      }
      dst[o] = R; dst[o + 1] = G; dst[o + 2] = B;
      dst[o + 3] = 255;
    }
  }
}

/* Plain separable box mean over RGBA; used where there is no coastline to protect (the Moon). */
function boxBlurRGBA(src, dst, w, h, rad) {
  const tmp = new Float32Array(w * h * 3);
  const n = 2 * rad + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -rad; k <= rad; k++) {
        const o = (row + ((x + k) % w + w) % w) * 4;
        r += src[o]; g += src[o + 1]; b += src[o + 2];
      }
      const t = (row + x) * 3;
      tmp[t] = r / n; tmp[t + 1] = g / n; tmp[t + 2] = b / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -rad; k <= rad; k++) {
        const yy = y + k < 0 ? 0 : y + k > h - 1 ? h - 1 : y + k;
        const j = (yy * w + x) * 3;
        r += tmp[j]; g += tmp[j + 1]; b += tmp[j + 2];
      }
      const o = (y * w + x) * 4;
      dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = 255;
    }
  }
}

export function canvasData(key) {
  if (!pixelsOf.has(key)) {
    pixelsOf.set(key, canvases.get(key).then((cv) =>
      cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height)));
  }
  return pixelsOf.get(key);
}

/* Deterministic lattice hash and the value noise built on it: longitude wraps — the dateline is not
   an edge — latitude clamps at the poles. Same recipe as the cloud decks, kept local so this module
   owns its randomness outright. */
function hash2(x, y, seed) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
}

const noise = latticeNoise();
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
const period = (circKm, lambdaKm) => Math.max(8, Math.round(circKm / lambdaKm));
const EARTH_CIRC = 2 * Math.PI * RE, MOON_CIRC = 2 * Math.PI * RM;

function fbm(u, v, p, oct, seed) {
  let sum = 0, amp = 0.5, tot = 0;
  for (let k = 0; k < oct; k++) { sum += amp * noise(u, v, p << k, seed + k); tot += amp; amp *= 0.5; }
  return sum / tot;
}

/* Bilinear grid sample by uv: longitude wraps, latitude clamps (the pole row covers the cap). */
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

/* ---- the Moon: maria flat, highlands rolling, craters hashed not scattered ---- */

function buildMoonField(blur, sw, sh) {
  const w = FW, h = FH;
  const km = new Float32Array(w * h), hi = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const srow = (((y * sh / h) | 0)) * sw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = blur[srow + ((x * sw / w) | 0)];
      /* The painting's own maria threshold, feathered over its tone band: the dark texels are flat
         basalt plains and stay at exactly 0; the highlands stand ABOVE them by a real elevation
         difference as well as a brighter tone, so descending to a mare reads as descending into
         terrain — a step the 512-segment mesh carries without any near level. */
      const m = smoothS(0.36, 0.47, b);
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

/* ---- near-level detail: craters the canvas can never hold ----

   The painted canvas is 1024×512: 10.6 km/texel. A 12 km crater stamped there is a one-byte
   smudge, and the last kilometres of a descent were flying over nothing (measured: a 9 km pass
   showed zero surface features). The near patch asks for its ground ANALYTICALLY instead: a
   second seeded population of 3–45 km craters evaluated per vertex at rebuild time. Height is
   rim-only — the patch stands on the mesh and never cuts into it, the same rule the Earth patch
   follows, so contact on the RM sphere stays honest and no crater can sink the vehicle below
   the ground it landed on — and the bowl itself is drawn in tone: dark floor, bright rim, ray
   fans where a young one lands near mare. */
let _smallCraters = null;
function moonSmallCraters() {
  if (_smallCraters) return _smallCraters;
  _smallCraters = [];
  for (let c = 0; c < 2400; c++) {
    const hu = hash2(c, 5, 91), hv = hash2(c, 6, 57), hr = hash2(c, 7, 31), hy = hash2(c, 8, 17);
    const rKm = 3 + Math.pow(hr, 2.2) * 42;                    // many small, few big
    _smallCraters.push({
      lon: hu * Math.PI * 2 - Math.PI, lat: Math.asin(2 * hv - 1), rKm,
      rim: 0.08 + Math.min(0.22, rKm * 0.006),                 // ≤ 300 m: a rim you can see in silhouette
      young: hy > 0.93, spokes: 6, phase: hy * 6.283,
    });
  }
  // 6° buckets (~187 km, beyond the 4.2 r = 190 km reach of the biggest crater): a rebuild asks
  // 26k vertices, and without this every vertex would walk all 2 400 craters. A colliding bucket
  // key only costs a wasted distance test — every consumer below filters by true distance.
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

/* globe uv → { h: rim km (≥ 0), tone: albedo multiplier }. baseLum is the painted canvas here
   (0..1); the dark maria catch the young craters' ray fans brighter, as they do on the map pass.

   The tone COMPOSES by the dominant crater, not by multiplication: a 220 km patch sits over ~70 of
   these bowls, and a naive product of every floor factor compounds to black (measured: the whole
   near field rendered 0.004 linear — 0.58 to the fifth). The deepest floor and the brightest rim at
   a point win; rim HEIGHTS take the max too, so two rims that touch never stack into a spike the
   lander could perch on. Both profiles stay C0 — a stepped floor would print a ring in vertex colour. */
export function moonPatchDetail(u, v, baseLum) {
  const L = moonSmallCraters();
  const lon = (u - 0.5) * Math.PI * 2, lat = (v - 0.5) * Math.PI;
  const list = L.buckets.get(Math.floor((lon + Math.PI) / L.B) * 977 + Math.floor((lat + Math.PI / 2) / L.B));
  let h = 0, dark = 0, lit = 0, ray = 0;
  if (list) {
    const kmr = Math.PI / 180 * RM, clat = Math.max(0.05, Math.cos(lat));
    for (const cr of list) {
      let dlon = lon - cr.lon;
      if (dlon > Math.PI) dlon -= 2 * Math.PI; else if (dlon < -Math.PI) dlon += 2 * Math.PI;
      const ey = (lat - cr.lat) * kmr, ex = dlon * clat * kmr;
      const dd = Math.hypot(ex, ey) / cr.rKm;
      if (dd < 1.3) { const t = dd / 1.3, w = (1 - t * t) * (1 - t * t); if (w > dark) dark = w; }
      if (dd < 1.8) {
        const g = (dd - 1.12) / 0.17, hw = Math.exp(-g * g);
        if (cr.rim * hw > h) h = cr.rim * hw;
        if (0.30 * hw > lit) lit = 0.30 * hw;
      } else if (cr.young && dd < 4.2 && baseLum < 0.4) {
        const sp = Math.cos(cr.spokes * Math.atan2(ey, ex) + cr.phase);
        if (sp > 0) { const r = 0.30 * Math.pow(sp, 10) * (1 - (dd - 1.8) / 2.4); if (r > ray) ray = r; }
      }
    }
  }
  const tone = 1 - 0.42 * dark + lit + ray;
  return { h, tone };
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

/* ---- Earth: land only, oceans and shelf exactly 0, pad neighbourhood exactly 0 ---- */

function buildEarthField(land, sw, sh) {
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
      const broad = fbm(u, v * 2, 16, 2, 5);     // ~1300–2600 km continental swells
      const rn = noise(u, v * 2, 48, 9);
      const ridge = 1 - Math.abs(rn * 2 - 1);    // ridged octave: spines, not noise mush
      km[i] = wgt * (0.42 * broad + 0.6 * ridge * ridge + 0.12 * noise(u, v * 2, 160, 17))
            + (aLat > 72 ? 0.5 : 0);             // the ice sheets really are plateaus; Greenland, Antarctica
    }
  }
  for (let i = 0; i < km.length; i++) {
    // uv, not grid coords: v counts north while rows count south — mixing them flattens the antipode
    const u = (i % w + 0.5) / w, v = 1 - (Math.floor(i / w) + 0.5) / h;
    km[i] = THREE.MathUtils.clamp(km[i] * padWeight(u, v), 0, 1.4);
  }
  return { field: { w, h, km }, coast: earthCoast(land, sw, sh) };
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
  return { w, h, km };
}

function chamfer(d, w, h) {
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
  // authored NNE trend (tan 20° drift) plus a 40 km wobble so the shore is not ruled-straight
  return SHORE_LINES[k] + 0.34 * yKm
    + (noise((yKm + 50 * k) / 90, 0.5, 4, 400 + k) - 0.5) * 3.2;
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
    const r = Math.hypot(_tp.x, _tp.y);
    if (r < 0.85) {
      const t = THREE.MathUtils.clamp((0.85 - r) / 0.3, 0, 1);       // soft edge into the grass
      const g = C.grass, k = C.concrete;
      return [g[0] + (k[0] - g[0]) * t, g[1] + (k[1] - g[1]) * t, g[2] + (k[2] - g[2]) * t];
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

/* ---- far level: displace the mesh itself ---- */

export function applyRelief(geometry, key) {
  const f = reliefField(key);
  if (!f) return Promise.reject(new Error('applyRelief: paint ' + key + ' first'));
  return f.then((g) => {
    const pos = geometry.attributes.position, uvs = geometry.attributes.uv;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const h = sampleGrid(g, uvs.getX(i), uvs.getY(i));
      if (h === 0) continue;
      n.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      pos.setXYZ(i, pos.getX(i) + n.x * h, pos.getY(i) + n.y * h, pos.getZ(i) + n.z * h);
    }
    geometry.computeVertexNormals();
    weldSeamNormals(geometry);
    pos.needsUpdate = true;
    geometry.computeBoundingSphere();
  });
}

/* computeVertexNormals leaves a crease at the dateline: three's sphere duplicates the u=0/u=1
   column and each copy only ever averages faces on one side, so the two copies of the same vertex
   shade differently and the seam shows against the sky. Average them into agreement. */
function weldSeamNormals(geometry) {
  const p = geometry.parameters;
  if (!p) return;
  const cols = p.widthSegments + 1, rows = p.heightSegments + 1;
  const nrm = geometry.attributes.normal;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let y = 0; y < rows; y++) {
    const i0 = y * cols, i1 = i0 + cols - 1;
    a.fromBufferAttribute(nrm, i0);
    b.fromBufferAttribute(nrm, i1);
    a.add(b).normalize();
    nrm.setXYZ(i0, a.x, a.y, a.z);
    nrm.setXYZ(i1, a.x, a.y, a.z);
  }
}

/* A texture now, the real paint later. The placeholder canvas MUST already be the size the paint
   will be, because WebGL2 gives a canvas texture immutable storage (texStorage2D) at its first
   upload size: a 2×2 placeholder makes every later texSubImage2D of the 2048×1024 canvas a silent
   GL error, and the body then samples one ocean-blue texel forever — flat continents-looking-blue
   from orbit while the painted canvas itself is perfect. Copy into the existing surface instead of
   swapping the image. */
export function paintedTexture(promise, key, w, h) {
  let t = loaded.get(key);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#1c4a8c';
  cx.fillRect(0, 0, w, h);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  loaded.set(key, t);
  promise.then((painted) => {
    cx.clearRect(0, 0, w, h);
    cx.drawImage(painted, 0, 0, w, h);   // scaled only if an asset arrives at an unexpected size
    t.needsUpdate = true;
  });
  return t;
}
