import * as THREE from 'three';
import { RE } from './constants.js';

/* The near cloud layer — the deck you can actually see from the ground.

   A cloud texture wrapped on a planet-scale sphere cannot put a cumulus overhead: at 1024×512 over
   40 000 km one texel is 39 km, and the horizon-to-30°-elevation sky above the pad spans 0.18 of
   one texel. Measured, not estimated — the whole visible sky from the pad samples a single texel,
   which is why the global decks read as a uniform film (or nothing) from the surface and why no
   amount of blending, uv or row-convention work could change it.

   So the sky is served at two scales. The global decks in js/world.js keep the orbit view; this
   plate is a spherical cap that re-centres on the ground under the vehicle, at 7 km, with a
   64 km tile repeated across it — 125 m per texel, so puffs are kilometres wide and legible from
   the pad. It is a child of the Earth mesh, so its uv offsets ride the spin with the planet, and it
   is anchored to the *body* rather than to the camera: recentring shifts the uv by the same arc it
   shifts the geometry, so the weather stays put while the grid slides underneath it.

   The shade plate is the same cap, offset anti-sunward by the deck height over tan(elevation) and
   draped over the actual terrain through fineGroundHeight. Because it samples the same tile at the
   same uv (shifted by the same arc), the darkness on the ground is the shape of the cloud that
   casts it, and the offset grows as the sun drops — the penumbra rule from the art direction,
   at near scale, for free.

   Nothing here is alpha-tested: the tile carries a soft rim, the vertex colour carries the radial
   fade, and both blend. Mipmapped, so a grazing plate does not shimmer. */

const SEG = 44;                       // deck cap: 45×45 vertices over 440 km, 10 km per cell
const SEG_SHADE = 28;                 // shade cap: 29×29 over 140 km, 5 km per cell
const RADIUS = 220;                   // km deck radius — matches the terrain patch
const RADIUS_SHADE = 70;              // km shade radius — see the uv-budget note below
const RECENTRE = 6;                   // km of ground travel before a rebuild
const ALT = 7;                        // km above the reference sphere — a fair weather cumulus base
const TILE = 200;                     // km per tile: 390 m per texel, BOTH caps, same field

/* The uv budget, learned the hard way. Mip derivatives are computed per triangle, so a 10 km
   triangle that spans several tile repeats picks a different mip level from its neighbour and the
   ground fills with straight-edged wedges of the tile's mip average — the exact "horrific terrain"
   look, on top of what the ramp step was already doing. 390 m per texel keeps the derivative near
   level 0 while still putting a legible puff over the pad (the sky overhead spans ~15 km of tile).
   The shade cap has to sample the SAME uv field as the deck or a shadow lands under clear sky, so it
   keeps TILE and shrinks instead: 70 km of shadow is more ground than the pad can resolve anyway. */
const FADE0 = 0.52;                   // radial fade starts here (fraction of the cap's radius)
const SHOW_ALT = 45;                  // km: above this the plate is sub-pixel and the decks take over
const SHADE_LIFT = 0.06;              // km above the ground for the shade cap
const SHADE_ALPHA = 0.70;             // how dark a puff's shadow gets, before the tile's own alpha

const _g = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
const _d = new THREE.Vector3();

/* Tileable value noise: the lattice wraps, so the plate has no seam where the uv runs past 1. */
function hash2(x, y, seed) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function lattice(px, py, period, seed) {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const p = (x) => ((x % period) + period) % period;
  const a = hash2(p(x0), p(y0), seed), b = hash2(p(x0 + 1), p(y0), seed);
  const c = hash2(p(x0), p(y0 + 1), seed), e = hash2(p(x0 + 1), p(y0 + 1), seed);
  return (a + (b - a) * u) * (1 - v) + (c + (e - c) * u) * v;
}

/* One tileable puff field. Three octaves at 8/16/32 cells, then a narrow ramp: a hard rim with a
   soft shoulder, which is what makes it read as painted rather than as fog. */
function tileTexture() {
  const N = 512, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = x / N, fy = y / N;
      let d = 0.5 * lattice(fx * 8, fy * 8, 8, 11)
            + 0.3 * lattice(fx * 16, fy * 16, 16, 29)
            + 0.2 * lattice(fx * 32, fy * 32, 32, 47);
      d = (d - 0.34) / 0.66;                       // the fbm centres near 0.5; stretch to 0..1
      const a = THREE.MathUtils.clamp((d - 0.24) / 0.20, 0, 1);   // ~35% cover, crisp rim
      const s = a * a * (3 - 2 * a);
      const i = (y * N + x) * 4;
      // the tile carries density only; the material's colour sets the tone
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = (s * 255) | 0;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function makePlate(material, order, seg) {
  const cols = seg + 1;
  const n = cols * cols;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  // itemSize 4 so the alpha channel multiplies the tile's own alpha (USE_COLOR_ALPHA)
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  const idx = new Uint16Array(seg * seg * 6);
  let t = 0;
  for (let y = 0; y < seg; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, material);
  mesh.userData.seg = seg;
  mesh.frustumCulled = false;      // it is re-centred under the camera, so its bounds lie
  mesh.visible = false;
  mesh.renderOrder = order;
  return mesh;
}

export function makeCloudLayer(body, groundKm) {
  const tex = tileTexture();
  const cloudMat = new THREE.MeshBasicMaterial({
    map: tex, color: 0xffffff, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, vertexColors: true, fog: false,
  });
  const shadeMat = new THREE.MeshBasicMaterial({
    map: tex, color: 0x172033, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, vertexColors: true, fog: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const cloud = makePlate(cloudMat, 4, SEG);            // after the decks and the terrain
  const shadow = makePlate(shadeMat, 2, SEG_SHADE);     // over the ground, under the clouds
  body.add(cloud);
  body.add(shadow);
  return {
    body, groundKm, cloud, shadow,
    ready: false, has: false, dirty: true,
    gx: 0, gy: 0, gz: 1,
    uKm: 0, vKm: 0,
    sx: 0, sy: 0, sz: 1,
  };
}

/* Deterministic tangent frame, the same construction js/terrain.js uses. */
function basis(gx, gy, gz) {
  _g.set(gx, gy, gz).normalize();
  if (Math.abs(_g.y) < 0.9) _e1.set(0, 1, 0).cross(_g).normalize();
  else _e1.set(1, 0, 0).cross(_g).normalize();
  _e2.copy(_g).cross(_e1).normalize();
}

/* Writes one cap: geometry anchored to (cx,cy,cz) in body-local space, uv anchored to (offU,offV)
   so that every texel keeps the same ground position as the centre moves. */
function fill(mesh, cx, cy, cz, offU, offV, isShade, radius, sunX, sunY, sunZ, groundKm) {
  const seg = mesh.userData.seg, cols = seg + 1;
  basis(cx, cy, cz);
  const g = _g, e1 = _e1, e2 = _e2;
  const pos = mesh.geometry.attributes.position.array;
  const uv = mesh.geometry.attributes.uv.array;
  const col = mesh.geometry.attributes.color.array;
  let k = 0, m = 0, c = 0;
  for (let iy = 0; iy < cols; iy++) {
    const oy = radius * (1 - iy / seg * 2);
    for (let ix = 0; ix < cols; ix++, k += 3, m += 2, c += 4) {
      const ox = radius * (ix / seg * 2 - 1);
      let vx = g.x + (e1.x * ox + e2.x * oy) / RE;
      let vy = g.y + (e1.y * ox + e2.y * oy) / RE;
      let vz = g.z + (e1.z * ox + e2.z * oy) / RE;
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl; vy *= vl; vz *= vl;
      const rr = Math.min(1, Math.hypot(ox, oy) / radius);
      let f = THREE.MathUtils.clamp((1 - rr) / (1 - FADE0), 0, 1);
      f = f * f * (3 - 2 * f);
      let alt = ALT;
      if (isShade) {
        _d.set(vx, vy, vz);
        alt = groundKm(_d) + SHADE_LIFT;
      }
      const r = RE + alt;
      pos[k] = vx * r; pos[k + 1] = vy * r; pos[k + 2] = vz * r;
      uv[m] = offU + ox / TILE; uv[m + 1] = offV + oy / TILE;
      if (isShade) {
        col[c] = 1; col[c + 1] = 1; col[c + 2] = 1; col[c + 3] = f * SHADE_ALPHA;
      } else {
        // a soft cel on the sun: bright side flat white, night side kept visible rather than black
        const dl = vx * sunX + vy * sunY + vz * sunZ;
        const b = 0.40 + 0.60 * THREE.MathUtils.clamp(dl * 1.7 + 0.52, 0, 1);
        col[c] = b; col[c + 1] = b; col[c + 2] = b; col[c + 3] = f;
      }
    }
  }
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.geometry.attributes.uv.needsUpdate = true;
  mesh.geometry.attributes.color.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}

/* Per frame, from js/world.js: ground point and sun in BODY-LOCAL space, altitude in km. */
export function updateCloudLayer(L, gx, gy, gz, sunLocal, altKm) {
  if (!L) return;
  const on = altKm < SHOW_ALT && Number.isFinite(gx + gy + gz);
  L.cloud.visible = on;
  if (!on) { L.shadow.visible = false; return; }

  /* Arc travelled since the last build, and the uv shift that keeps the weather still. */
  let moved = RECENTRE;
  if (L.has) {
    const dot = THREE.MathUtils.clamp(gx * L.gx + gy * L.gy + gz * L.gz, -1, 1);
    moved = Math.acos(dot) * RE;
    if (moved < RECENTRE && !L.dirty) {
      L.cloud.visible = true;
      return;
    }
    basis(gx, gy, gz);
    L.uKm += ((gx - L.gx) * _e1.x + (gy - L.gy) * _e1.y + (gz - L.gz) * _e1.z) * RE;
    L.vKm += ((gx - L.gx) * _e2.x + (gy - L.gy) * _e2.y + (gz - L.gz) * _e2.z) * RE;
  }
  L.gx = gx; L.gy = gy; L.gz = gz; L.has = true; L.dirty = false; L.ready = true;

  const sx = sunLocal.x, sy = sunLocal.y, sz = sunLocal.z;
  fill(L.cloud, gx, gy, gz, L.uKm / TILE, L.vKm / TILE, false, RADIUS, sx, sy, sz, null);
  L.cloud.visible = true;

  /* The shade: the same cap, anti-sunward by deck height over tan(elevation), draped on the ground. */
  const elev = Math.asin(THREE.MathUtils.clamp(sy, -1, 1));
  const hsLen = Math.hypot(sx, sz);
  if (elev > 0.03 && hsLen > 1e-6) {
    const off = Math.min(RADIUS_SHADE * 0.7, ALT / Math.tan(Math.max(elev, 0.03)));
    const hx = sx / hsLen, hz = sz / hsLen;
    let cx = gx - hx * off / RE, cy = gy, cz = gz - hz * off / RE;
    const cl = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz);
    cx *= cl; cy *= cl; cz *= cl;
    L.sx = cx; L.sy = cy; L.sz = cz;
    fill(L.shadow, cx, cy, cz, (L.uKm - hx * off) / TILE, (L.vKm - hz * off) / TILE,
         true, RADIUS_SHADE, sx, sy, sz, L.groundKm);
    L.shadow.visible = true;
  } else {
    L.shadow.visible = false;
  }
}

export function hideCloudLayer(L) {
  if (!L) return;
  L.cloud.visible = false;
  L.shadow.visible = false;
}
