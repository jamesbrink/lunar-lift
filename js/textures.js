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

// Sizes are the source assets' own (earth_atmos_2048.jpg, moon_1024.jpg) — see paintedTexture.
export const earthTex = () => paintedTexture(
  paintEarth('assets/earth_atmos_2048.jpg', 'assets/earth_specular_2048.jpg'), 'earth', 2048, 1024);
export const moonTex = () => paintedTexture(paintMoon('assets/moon_1024.jpg'), 'moon', 1024, 512);

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

/* cumulusTex: the weather deck, 2 km up. Density is a five-octave fbm shaped by the real zonal
   pattern — the intertropical convergence zone, the dry subtropical belts around ±25° where almost
   nothing forms, and the storm tracks near ±52° — then pushed through a tight smoothstep so each
   cloud has a defined edge instead of a photographic fade. RGB is white and only alpha carries the
   weather, which is what lets the material read its own alpha. */
let _cumulus = null;
export function cumulusTex() {
  if (_cumulus) return _cumulus;
  const W = 1024, H = 512, data = new Uint8Array(W * H * 4);
  const noise = noiseKit();
  for (let iy = 0; iy < H; iy++) {
    /* South-first rows: a DataTexture samples row 0 at v=0 (flipY is false), and SphereGeometry's
       v=0 is the SOUTH pole — north-first rows render the whole weather belt upside down. cirrusTex
       and js/clouds.js's near tile follow the same convention. */
    const lat = ((iy + 0.5) / H - 0.5) * 180;
    const a = Math.abs(lat);
    const itcz = 1.15 * Math.exp(-Math.pow((a - 4) / 9, 2));
    const midlat = 0.85 * Math.exp(-Math.pow((a - 52) / 14, 2));
    const dry = -0.55 * Math.exp(-Math.pow((a - 25) / 9, 2));
    const polar = 0.30 * Math.exp(-Math.pow((a - 78) / 12, 2));
    const belt = 0.34 + itcz + midlat + dry + polar;
    for (let ix = 0; ix < W; ix++) {
      const u = ix / W, v = iy / H;
      let sum = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 5; k++) {                        // 12 .. 192 cells around the globe
        sum += amp * noise(u, v * 0.55, 12 << k, 40 + k);
        tot += amp; amp *= 0.5;
      }
      const dens = smoothstep(0.60, 0.82, sum / tot + belt * 0.24);
      const i = (iy * W + ix) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = (dens * 255) | 0;
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
  _cumulus.generateMipmaps = true;          // 1024×512 is power-of-two
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
