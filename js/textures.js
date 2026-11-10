import * as THREE from 'three';
import { paintEarth, paintMoon, paintedTexture } from './toonmap.js';

/* Everything the planets wear is drawn, not photographed.

   The blue-marble and lunar sheets in assets/ are 2 km-to-20 km-per-pixel satellite data: correct
   geography, but soft, muddy and far too low-resolution to stretch over a sphere and still look
   intentional — and a cel ramp only quantises the mud. So they are read as *data*: the specular
   sheet yields a land mask, the diffuse sheet yields biome hue, and the lunar sheet yields albedo
   contrast. What gets uploaded is authored colour — flat ocean, a shallow shelf hugging every
   coastline, a coastline stroke, sorted biomes, and a four-tone Moon. js/toonmap.js does the painting.
   The weather was never a photograph either: its sheets are generated from seeded noise in
   js/cloudfields.js. */

// Sizes are the paint output's own (earth: the 2048 source; moon: painted at 4× the 1024 source —
// see paintMoonJob). paintedTexture's placeholder MUST match these or WebGL pins the small size.
export const earthTex = () => paintedTexture(
  paintEarth('assets/earth_atmos_2048.jpg', 'assets/earth_specular_2048.jpg'), 'earth', 2048, 1024);
export const moonTex = () => paintedTexture(paintMoon('assets/moon_1024.jpg'), 'moon', 4096, 2048);

const smoothstep = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

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
