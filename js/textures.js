import * as THREE from 'three';

/* All body surfaces are real data now: the blue-marble diffuse/normal/specular set, the NOAA
   cloud sheet and the lunar map ship in assets/ and are loaded relative to index.html. Only the
   high cirrus deck and the glow sprite are generated here. */

const loader = new THREE.TextureLoader();
const cache = new Map();

function asset(path, { srgb = true } = {}) {
  let t = cache.get(path);
  if (!t) {
    t = loader.load(path);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;        // equirectangular: the map must wrap at the dateline
    t.wrapT = THREE.ClampToEdgeWrapping;   // poles clamp rather than repeat
    cache.set(path, t);
  }
  return t;
}

/* earth: colour, tangent-space normal, and the specular map (oceans bright, land dark) which the
   standard material reads as metalness — the shiny sea is what makes the limb read as water. */
export const earthTex = () => asset('assets/earth_atmos_2048.jpg');
export const earthNormalTex = () => asset('assets/earth_normal_2048.jpg', { srgb: false });
export const earthSpecTex = () => asset('assets/earth_specular_2048.jpg', { srgb: false });
export const cloudTex = () => asset('assets/earth_clouds_1024.png');
export const moonTex = () => asset('assets/moon_1024.jpg');

/* cirrusTex: procedural fbm value noise, stretched along the longitude axis so the wisps read as
   high zonal streaks. Deterministic (no Math.random) so every run draws the same weather. The
   luminance IS the density: RGBA all-equal, so one texture drives both map and alphaMap. */
let _cirrus = null;
export function cirrusTex() {
  if (_cirrus) return _cirrus;
  const W = 1024, H = 512, data = new Uint8Array(W * H * 4);

  const hash = (x, y, seed) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
    n = Math.imul(n ^ (n >>> 15), 2246822519);
    return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
  };
  // lattice wraps in x (seamless at the dateline), clamps at the poles
  const lattice = (x, y, p, seed) => hash(((x % p) + p) % p, y < 0 ? 0 : y >= p ? p - 1 : y, seed);
  const noise = (u, v, p, seed) => {
    const x = u * p, y = v * p;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice(xi, yi, p, seed), b = lattice(xi + 1, yi, p, seed);
    const c = lattice(xi, yi + 1, p, seed), d = lattice(xi + 1, yi + 1, p, seed);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };

  for (let iy = 0; iy < H; iy++) {
    const v = iy / (H - 1), lat = (v - 0.5) * Math.PI;
    const belt = 0.62 + 0.38 * Math.cos(lat * 1.7);          // veils thicken toward the tropics
    for (let ix = 0; ix < W; ix++) {
      const u = ix / W;
      let sum = 0, amp = 0.5, tot = 0;
      for (let k = 0; k < 5; k++) {                          // 8 .. 128 cells around the globe
        sum += amp * noise(u, v * 0.30 + 0.02 * k, 8 << k, k + 1);
        tot += amp; amp *= 0.5;
      }
      let a = (sum / tot) * belt;
      a = THREE.MathUtils.clamp((a - 0.42) / 0.33, 0, 1);
      a = a * a * (3 - 2 * a);                               // smoothstep: soft feathered edges
      const i = (iy * W + ix) * 4, q = (a * 255) | 0;
      data[i] = q; data[i + 1] = q; data[i + 2] = q; data[i + 3] = q;
    }
  }
  _cirrus = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  _cirrus.wrapS = THREE.RepeatWrapping;
  _cirrus.wrapT = THREE.ClampToEdgeWrapping;
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
      if (r <= 0.4) { const k = r / 0.4; R = 255; G = 235 - 65 * k; B = 190 - 120 * k; A = 1 - 0.35 * k; }
      else { const k = (r - 0.4) / 0.6; R = 255; G = 170 - 50 * k; B = 70 - 40 * k; A = 0.65 * (1 - k); }
      const i = (y * N + x) * 4;
      data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = (A * 255) | 0;
    }
  }
  _glow = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _glow.colorSpace = THREE.SRGBColorSpace;
  _glow.needsUpdate = true;
  return _glow;
}
