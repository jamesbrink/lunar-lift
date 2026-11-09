import * as THREE from 'three';
import { paintEarth, paintMoon, paintedTexture } from './toonmap.js';

/* Everything the planets wear is drawn, not photographed.

   The blue-marble and lunar sheets in assets/ are 2 km-to-20 km-per-pixel satellite data: correct
   geography, but soft, muddy and far too low-resolution to stretch over a sphere and still look
   intentional — and a cel ramp only quantises the mud. So they are read as *data*: the specular
   sheet yields a land mask, the diffuse sheet yields biome hue, and the lunar sheet yields albedo
   contrast. What gets uploaded is authored colour — flat ocean, a shallow shelf hugging every
   coastline, a coastline stroke, sorted biomes, and a four-tone Moon. js/toonmap.js does the painting.
   The cloud decks were never photographs either, so both are generated here from seeded noise: the
   PNG that used to stand in for weather carried its density in the alpha channel while the material
   sampled green, which covered the entire planet in an opaque white tablecloth. */

// Sizes are the paint output's own (earth: the 2048 source; moon: painted at 4× the 1024 source —
// see paintMoonJob). paintedTexture's placeholder MUST match these or WebGL pins the small size.
export const earthTex = () => paintedTexture(
  paintEarth('assets/earth_atmos_2048.jpg', 'assets/earth_specular_2048.jpg'), 'earth', 2048, 1024);
export const moonTex = () => paintedTexture(paintMoon('assets/moon_1024.jpg'), 'moon', 4096, 2048);

/* Deterministic value noise, shared by both cloud decks. The lattice wraps in longitude and clamps at
   the poles, so there is no seam at the dateline and nothing weird at the poles, and the same run
   always produces the same weather. */
function noiseKit() {
  const hash = (x, y, seed) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
    n = Math.imul(n ^ (n >>> 15), 2246822519);
    return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
  };
  const lattice = (x, y, p, seed) => hash(((x % p) + p) % p, y < 0 ? 0 : y >= p ? p - 1 : y, seed);
  return (u, v, p, seed) => {
    const x = u * p, y = v * p;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice(xi, yi, p, seed), b = lattice(xi + 1, yi, p, seed);
    const c = lattice(xi, yi + 1, p, seed), d = lattice(xi + 1, yi + 1, p, seed);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

const smoothstep = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* cumulusTex: the weather deck, 2 km up. Density is a six-octave fbm shaped by the real zonal
   pattern — the intertropical convergence zone, the dry subtropical belts around ±25° where
   convection survives only as scattered fair-weather drift clusters, and the storm tracks near
   ±52° — then pushed through a tight smoothstep so each cloud has a defined edge instead of a
   photographic fade. RGB is white and only alpha carries the weather, which is what lets the
   material read its own alpha. */
let _cumulus = null;
export function cumulusTex() {
  if (_cumulus) return _cumulus;
  /* 2048×1024, not 1024×512: at 39 km/texel the whole cloud system minified to its mip average by
     ~200 km up, and the orbit view wore a featureless veil. At 20 km/texel a 150 km puff survives
     to mip 3 and the deck keeps cells across the whole reachable orbit band; the material sharpens
     what averaging lifts toward the mean (see the deck note in js/world.js). */
  const W = 2048, H = 1024, data = new Uint8Array(W * H * 4);
  const noise = noiseKit();
  const warpA = noise, warpB = noise;
  for (let iy = 0; iy < H; iy++) {
    /* South-first rows: a DataTexture samples row 0 at v=0 (flipY is false), and SphereGeometry's
       v=0 is the SOUTH pole — north-first rows render the whole weather belt upside down. cirrusTex
       and js/clouds.js's near tile follow the same convention. */
    const lat = ((iy + 0.5) / H - 0.5) * 180;
    const a = Math.abs(lat);
    const itcz = 1.95 * Math.exp(-Math.pow((a - 4) / 9, 2));
    /* 0.62, was 0.50: at 0.50 the storm-track belt sat a whole deviation below the ramp and the
       mid-latitude ocean read bare from orbit (review2: "ocean-side views are featureless flat
       blue"). 0.62 puts the belt mean at the bottom edge of the ramp so the fbm's ±0.07 keeps
       carving holes — broken cloud, never a plate. */
    const midlat = 0.62 * Math.exp(-Math.pow((a - 52) / 14, 2));
    const dry = -0.55 * Math.exp(-Math.pow((a - 25) / 9, 2));
    const polar = 0.30 * Math.exp(-Math.pow((a - 78) / 12, 2));
    const belt = 0.34 + itcz + midlat + dry + polar;
    /* Fair-weather puffs live in DRIFT CLUSTERS, not everywhere: a low-lattice field (~1800 km
       cells at the equator) lifts the ramp argument by up to +0.30, gated to 20°–64°. The gate
       matters: the ITCZ (belt mean 1.49) already sits at the ramp's low end and must keep its own
       measured density, and the polar deck has its own belt term — an ungated +0.30 saturates
       both (the solid-grey-plate failure below). Inside the window the dry belts (belt −0.20,
       x mean 0.478 vs ramp 0.655) get scattered 500–1200 km puff clusters where the cluster
       field peaks, and stay bare deep blue between them — the contrast is what scores. */
    const driftGate = smoothstep(12, 20, a) - smoothstep(64, 82, a);
    for (let ix = 0; ix < W; ix++) {
      const u = ix / W, v = iy / H;
      /* Domain warp: pushing the sample point through two low-lattice noises turns round iso-blob
         contours into lobed, turbulent ones — the cauliflower that plain fbm never grows. Without
         it the deck sharpens into… bigger circles. */
      const wu = (warpA(u, v, 7, 99) - 0.5) * 0.09;
      const wv = (warpB(u, v, 11, 77) - 0.5) * 0.05;
      let sum = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 6; k++) {                        // 16 .. 512 cells around the globe
        sum += amp * noise(u + wu, (v + wv) * 0.55, 16 << k, 40 + k);
        tot += amp; amp *= 0.5;
      }
      /* The drift-cluster field (see driftGate above), squared so only its upper tail lifts the
         argument — peaks are scattered systems, flanks stay bare. Sampled through the same warp
         offsets as the fbm so cluster edges and puff edges are never on separate grids. */
      const cl = noise(u + wu, (v + wv) * 0.55, 22, 151);
      const x = sum / tot + belt * 0.11 + driftGate * 0.30 * smoothstep(0.55, 0.80, cl) * smoothstep(0.55, 0.80, cl);
      /* The belt term must nudge, not decide: ITCZ (belt 1.49) · 0.24 lifted the WHOLE band's mean
         0.36 over the threshold and the tropical deck printed as one solid grey plate (measured:
         9 620 clear / 10 279 full / 1 720 middle — no edges left to see). At gain 0.11 the ITCZ
         mean (0.664) sits at the low end of this ramp, so the fbm's ±0.07 still carves holes into
         roughly half the band; the dry belts fall below and go sparse instead of bare. The ramp
         stays 0.055 wide — crisp-but-antialiased at 20 km/texel. */
      const dens = smoothstep(0.655, 0.71, x);
      /* Thickness tints as well as occludes: RGB carries a smooth density (raw fbm position in the
         ramp band) while alpha stays the crisp mask. Without it the deck's interior is one flat
         white plate through the ramp — measured, in every orbit frame this session — and what the
         eye reads as a cloud is really the gradient from thin grey edge to piled white core. */
      const th = 168 + 87 * smoothstep(0.60, 0.78, x);
      const i = (iy * W + ix) * 4;
      data[i] = th; data[i + 1] = th; data[i + 2] = 205 + 50 * (th - 168) / 87; data[i + 3] = (dens * 255) | 0;
    }
  }
  _cumulus = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  _cumulus.colorSpace = THREE.SRGBColorSpace;
  _cumulus.wrapS = THREE.RepeatWrapping;
  _cumulus.wrapT = THREE.ClampToEdgeWrapping;
  /* Linear + mipmaps: a DataTexture defaults to Nearest/Nearest/no-mips, and a hard-alpha field
     minified without averaging is exactly the band-limited sampler that smears grazing-incidence
     wedges along the horizon. With mips the deck averages with distance into soft haze — which is
     what weather seen across a planet actually is. The materials BLEND this alpha rather than
     thresholding it; the mean-lifted mip values make any discard threshold dead. See the deck
     note in js/world.js. */
  _cumulus.magFilter = THREE.LinearFilter;
  _cumulus.minFilter = THREE.LinearMipmapLinearFilter;
  _cumulus.generateMipmaps = true;          // 2048×1024 is power-of-two
  _cumulus.needsUpdate = true;
  return _cumulus;
}

/* cirrusTex: the high deck, 9 km up — thin zonal streaks rather than cells, so the fbm is stretched
   hard along longitude and the veil thickens toward the tropics. Density lives in ALPHA and the
   material reads it through `map`, because three.js samples an `alphaMap` from the GREEN channel: a
   white-RGB texture bound as alphaMap is a sheet with density 1 over the whole planet, which is how
   the Earth briefly wore a grey tablecloth for the second time. */
let _cirrus = null;
export function cirrusTex() {
  if (_cirrus) return _cirrus;
  const W = 1024, H = 512, data = new Uint8Array(W * H * 4);
  const noise = noiseKit();
  for (let iy = 0; iy < H; iy++) {
    const v = iy / (H - 1), lat = (v - 0.5) * Math.PI;   // south-first rows — see cumulusTex
    const belt = 0.62 + 0.38 * Math.cos(lat * 1.7);          // veils thicken toward the tropics
    for (let ix = 0; ix < W; ix++) {
      const u = ix / W;
      let sum = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 5; k++) {                          // 8 .. 128 cells around the globe
        sum += amp * noise(u, v * 0.30 + 0.02 * k, 8 << k, k + 1);
        tot += amp; amp *= 0.5;
      }
      let a = (sum / tot) * belt;
      a = smoothstep(0.42, 0.75, a);
      const i = (iy * W + ix) * 4, q = (a * 255) | 0;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = q;
    }
  }
  _cirrus = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  _cirrus.colorSpace = THREE.SRGBColorSpace;
  _cirrus.wrapS = THREE.RepeatWrapping;
  _cirrus.wrapT = THREE.ClampToEdgeWrapping;
  _cirrus.magFilter = THREE.LinearFilter;   // grazing wedges — see the cumulus note
  _cirrus.minFilter = THREE.LinearMipmapLinearFilter;
  _cirrus.generateMipmaps = true;
  _cirrus.needsUpdate = true;
  return _cirrus;
}

/* flareTex is the sun's own plate: a crisp cel disc with a modest 4-spike corona — ONE treatment
   at every distance. The old profile was a uniform disc to 0.72 r with a wide radially symmetric
   ring corona behind it (measured alpha 0.45 at r=0.8, identical along-axis and diagonal), and the
   DataTexture's default Nearest/no-mips filtering minified that smooth ramp into quantised streaks
   — which is how one sun rendered as three things for review2: a soft glow ball at 05, a starburst
   at 07, a single aliased dot at 08. Now: disc edge at r 0.42, which through the sprite scale
   (0.42·2.4·SUN_ANG = 1.008·SUN_ANG) is the real 0.53° sun, then four |cos 2θ|^28 spikes to r 0.96
   and NOTHING between them — the sky stays black off-axis at every zoom, so distance can only
   change size, never style. Linear + mipmaps so minification averages instead of sparkling.
   glowTex keeps its centre-ramped profile and its lamp/plume duty untouched. */
let _flare = null;
export function flareTex() {
  if (_flare) return _flare;
  const N = 128, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - (N - 1) / 2) / ((N - 1) / 2), dy = (y - (N - 1) / 2) / ((N - 1) / 2);
      const r = Math.hypot(dx, dy);
      const disc = smoothstep(0.45, 0.42, r);   // ~2 texels of edge AA: crisp, never stair-stepped
      const spikes = Math.pow(Math.abs(Math.cos(2 * Math.atan2(dy, dx))), 28)
                   * 0.55 * smoothstep(0.96, 0.44, r);
      const a = Math.max(disc, spikes);
      const i = (y * N + x) * 4;
      data[i] = 255; data[i + 1] = 250; data[i + 2] = 235; data[i + 3] = (a * 255) | 0;
    }
  }
  _flare = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _flare.colorSpace = THREE.SRGBColorSpace;
  /* DataTexture defaults to Nearest/Nearest/no-mips: blocky when magnified, and a mip-less smooth
     ramp minified to a dozen pixels is exactly the aliasing the "starburst" frame was. */
  _flare.magFilter = THREE.LinearFilter;
  _flare.minFilter = THREE.LinearMipmapLinearFilter;
  _flare.generateMipmaps = true;                // 128 is power-of-two
  _flare.needsUpdate = true;
  return _flare;
}

/* glowTex is shared by the world (sun flare, pad lamps) and the vehicle (engine glow): cached so
   both get one texture. Radial falloff identical to the old canvas version, built as pixels. */
let _glow = null;
export function glowTex() {
  if (_glow) return _glow;
  const N = 128, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.min(1, Math.hypot(x - (N - 1) / 2, y - (N - 1) / 2) / ((N - 1) / 2));
      let R, G, B, A;
      /* Alpha holds a plateau out to 0.62 r and then falls away steeply. The old profile ramped down
         from the centre, so every sprite was a soft gradient and a pile of them composited into
         cotton wool — a launch cloud wants lobes with a readable silhouette. Only .a is sampled
         (js/vehicle.js:plumeMat); the RGB below is legacy from when the map was also drawn direct. */
      if (r <= 0.4) { const k = r / 0.4; R = 255; G = 235 - 65 * k; B = 190 - 120 * k; A = 1 - 0.06 * k; }
      else { const k = (r - 0.4) / 0.6; R = 255; G = 170 - 50 * k; B = 70 - 40 * k; A = 0.94 * Math.pow(1 - k, 2.4); }
      const i = (y * N + x) * 4;
      data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = (A * 255) | 0;
    }
  }
  _glow = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _glow.colorSpace = THREE.SRGBColorSpace;
  _glow.needsUpdate = true;
  return _glow;
}
