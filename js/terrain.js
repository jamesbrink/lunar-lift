import * as THREE from 'three';
import { toon, RAMP_EARTH, RAMP_MOON } from './toon.js';
import { RE, RM } from './constants.js';
import {
  sampleGrid, fineEarth, shoreDistance, padWeight, padShoreWeight, padAuthored,
  reliefField, coastField, canvasData, canvasDataSoft, moonPatchDetail,
} from './toonmap.js';

/* The near level — Earth only; the Moon has none.

   KSP-style streaming ground: ONE mesh, 161×161 vertices, that re-centres on the vehicle and
   warps radially — ~25 m spacing under the craft, a rim at ±220 km. The horizon from altitude h
   is √(2·RE·h), so the rim sits beyond it until h ≈ 3.8 km; above that the rim's difference from
   the far mesh is sub-pixel and the swap is invisible. Between rebuilds it costs one altitude
   test and one dot product; a rebuild runs in place, into preallocated buffers.

   The surface follows docs/reference/cartoon-art-direction.md: flat colour shapes that match
   the painted biome, the coastline read as a hard edge through the distance field, and NOTHING
   per-vertex else — no mottle, no ripples, no speckle. Depth comes from the silhouette of the
   relief itself against the sky, and from the coast, not from surface texture.

   Every value written to an attribute must be finite. A single NaN in a vertex colour becomes a
   NaN fragment — a black triangle that ignores materials, shadows and visibility alike, and it
   took a day of live-elimination to find one (the old inland-walk could push its uv sample off
   the end of the canvas; `undefined` bytes → NaN). The walk below is bounded, pxColor wraps and
   clamps every index, and the stores guard with Number.isFinite as the last line of defence. */

const HALF = 220;                     // km to the rim: horizon is covered to alt = HALF²/2RE ≈ 3.8 km, and beyond that the rim is sub-pixel
const SEG = 160;                      // 161×161 vertices, radial warp: ~25 m centre, ~3 km rim
const COLS = SEG + 1;
const FINE_FROM = 8, FINE_TO = 30;    // km: fine octaves exist inside this radius
const LIFT = 0.008;                   // km above the globe mesh, constant — never negative, polygonOffset wins the ties
const RECENTER = 12;                  // km of ground travel before a rebuild: ~1.2 ms steady, and at 12 km even the outlier rebuild lands outside any window a player is watching
const SHOW_ALT = 30;                  // km: above this the far mesh is the whole story
const SHORE_E = 0.06;                 // km of anti-alias on the distance-field coastline

const WARP_A = 0.0093;                // centre slope: 2·HALF·WARP_A/SEG ≈ 25 m per vertex under the vehicle

const _c1 = { r: 0, g: 0, b: 0 }, _c2 = { r: 0, g: 0, b: 0 };
const _g = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pd = new THREE.Vector3();

/* Signed fifth-power warp: linear (fine) through the middle sixth, then racing to the rim.
   A cubic cannot give both 25 m centre and 220 km rim from one 161-grid; the t⁵ term can. */
const warp = (t) => WARP_A * t + (1 - WARP_A) * t * t * t * t * t;

/* Builds the patch mesh as a child of the Earth mesh (so it rides the spin) in an inert state;
   attachEarthPatch wires the height/coast/pixel grids in when the paint job lands. */
export function makePatch(body) {
  const n = COLS * COLS;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  // aUv carries each vertex's globe equirect uv so world.js's cloud-shade injection can project
  // this mesh's ground points exactly like the globe's own uv; the globe shares its uv attribute.
  geo.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const idx = new Uint32Array(SEG * SEG * 6);
  let t = 0;
  for (let y = 0; y < SEG; y++) {
    for (let x = 0; x < SEG; x++) {
      const a = y * COLS + x, b = a + 1, c = a + COLS, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, toon({
    vertexColors: true,
    gradientMap: RAMP_EARTH,
    // The patch coincides with the globe's surface in the flattened pad zone and over calm
    // ocean; polygonOffset wins those ties instead of leaving it to a depth die.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  /* The patch IS fogged, unlike the planet. It is not a planet-scale body: it is the ground within
     220 km, and without aerial perspective a flat cartoon plain runs to a hard line at the horizon
     and reads as a painted card. FogExp2 squares its term, so at the pad (density ~0.0038) the rim
     220 km out takes about half the sky tone while the crawler 1 km away is untouched. js/world.js
     thins the same clock as the sky, so from orbit the haze is gone with the sky. */
  mesh.material.fog = true;
  mesh.receiveShadow = true;          // and with world.js's pad discs gone, this is the pad's shadow catcher
  mesh.castShadow = false;
  mesh.visible = false;
  body.add(mesh);
  return {
    mesh, ready: false, dirty: false,
    cosT: Math.cos(RECENTER / RE),
    gx: 0, gy: 1, gz: 0, has: false,
    rel: null, coast: null, px: null, soft: null,
  };
}

/* The grids are byproducts of the paint pass; when they land, the next update rebuilds. */
export function attachEarthPatch(p) {
  Promise.all([reliefField('earth'), coastField(), canvasData('earth'), canvasDataSoft('earth')]).then((a) => {
    if (!a[0] || !a[2] || !a[3]) return;
    p.rel = a[0]; p.coast = a[1]; p.px = a[2]; p.soft = a[3]; p.ready = true; p.dirty = true;
  });
}

/* ---- the lunar near level ----

   The Moon wore no near patch and the last kilometres were the reviewer's "uniform grey fog with
   no terrain features": the painted albedo is 10.6 km/texel, so every 3–45 km crater — most of
   what a lander actually sees — is a sub-texel smudge. Same radial-warped mesh as Earth, but the
   ground is asked analytically: height is the relief field plus the rim-only detail from
   toonmap.moonPatchDetail (never negative, so contact on the RM sphere stays honest), colour is
   the painted pixel multiplied by that detail's tone (crescent bowls — bright sunward rim, shadowed
   anti-sun rim and floor — plus ray fans). Two analytic tiers: 2 400 bowls of 3–45 km and 4 000
   micro-bowls of 0.3–2.5 km, the tier the 2 km view was missing (measured: one mare blob and a
   single crater on smooth grey). No coastline, no fine Earth octaves, no fog — there is no air on
   the Moon, so its limb must stay as crisp as the sky it cuts. RAMP_MOON so it matches the far mesh
   under the same sun. */
export function makeMoonPatch(moonBody) {
  const n = COLS * COLS;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const idx = new Uint32Array(SEG * SEG * 6);
  let t = 0;
  for (let y = 0; y < SEG; y++) {
    for (let x = 0; x < SEG; x++) {
      const a = y * COLS + x, b = a + 1, c = a + COLS, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, toon({
    vertexColors: true, gradientMap: RAMP_MOON,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  mesh.material.fog = false;              // no atmosphere: the near ground cannot haze into the sky
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.visible = false;
  moonBody.add(mesh);
  // body keeps the spin (for the sun's mesh-local frame); light is resolved lazily by bakeSun
  return { mesh, ready: false, dirty: false, cosT: Math.cos(RECENTER / RM), gx: 0, gy: 1, gz: 0, has: false, rel: null, px: null, body: moonBody, light: undefined };
}

export function attachMoonPatch(p) {
  Promise.all([reliefField('moon'), canvasData('moon')]).then((a) => {
    if (!a[0] || !a[1]) return;
    p.rel = a[0]; p.px = a[1]; p.ready = true; p.dirty = true;
  });
}

export function updateMoonPatch(p, dx, dy, dz, alt) {
  if (!p) return;
  if (!p.ready || alt > SHOW_ALT) { hidePatch(p); return; }
  if (p.has && dx * p.gx + dy * p.gy + dz * p.gz > p.cosT && !p.dirty) { p.mesh.visible = true; return; }
  p.gx = dx; p.gy = dy; p.gz = dz; p.has = true; p.dirty = false;
  p.mesh.visible = true;
  rebuildMoon(p);
}

/* The sun in the Moon's mesh-local frame, which is the frame the crater uv — and therefore the
   directional rim bake — lives in. js/world.js imports terrain.js, so importing SUN_DIR back would
   close a cycle; instead read the renderer's own sun: world.js parks its single DirectionalLight at
   (vehicle + SUN_DIR·SUN_RANGE) with its target at the vehicle every frame, so light→target is
   SUN_DIR itself — no constant duplicated, and the shading follows the light if the sun table ever
   moves. The inverse spin is world.js spinLocal's rotY(−rotation.y) arithmetic — the Moon only ever
   turns about Y. Resolved once, allocation-free after, and null before the world or the light exist;
   a null sun keeps moonPatchDetail omnidirectional (its documented fallback), never NaN. */
const _msun = new THREE.Vector3();
function bakeSun(p) {
  if (!p.light) {
    const scene = p.body ? p.body.parent : null;
    if (!scene) return null;
    for (const o of scene.children) if (o.isDirectionalLight) { p.light = o; break; }
    if (!p.light) return null;
  }
  const L = p.light.position, T = p.light.target.position;
  if (!Number.isFinite(L.x - T.x) || !Number.isFinite(L.y - T.y) || !Number.isFinite(L.z - T.z)) return null;
  let x = L.x - T.x, y = L.y - T.y, z = L.z - T.z;
  const l = Math.hypot(x, y, z);
  if (!(l > 1e-9)) return null;
  x /= l; y /= l; z /= l;
  const a = p.body.rotation.y, c = Math.cos(a), s = Math.sin(a);
  return _msun.set(c * x - s * z, y, s * x + c * z);
}

function rebuildMoon(p) {
  _g.set(p.gx, p.gy, p.gz).normalize();
  if (Math.abs(_g.y) < 0.9) _e1.set(0, 1, 0).cross(_g).normalize();
  else _e1.set(1, 0, 0).cross(_g).normalize();
  _e2.copy(_g).cross(_e1).normalize();
  const sun = bakeSun(p);                 // once per rebuild, not per vertex

  const pos = p.mesh.geometry.attributes.position.array;
  const col = p.mesh.geometry.attributes.color.array;
  let k = 0;
  for (let iy = 0; iy < COLS; iy++) {
    const oy = HALF * warp(1 - iy / SEG * 2);
    for (let ix = 0; ix < COLS; ix++, k += 3) {
      const ox = HALF * warp(ix / SEG * 2 - 1);
      let vx = _g.x + (_e1.x * ox + _e2.x * oy) / RM;
      let vy = _g.y + (_e1.y * ox + _e2.y * oy) / RM;
      let vz = _g.z + (_e1.z * ox + _e2.z * oy) / RM;
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl; vy *= vl; vz *= vl;
      const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, vy))) / Math.PI;
      let u = Math.atan2(vz, -vx) / (2 * Math.PI); if (u < 0) u += 1;

      const g = p.rel ? sampleGrid(p.rel, u, v) : 0;
      pxColor(p.px, u, v, _c1);
      const lum = 0.2126 * _c1.r + 0.7152 * _c1.g + 0.0722 * _c1.b;
      const d = moonPatchDetail(u, v, lum, sun);
      const h = g + d.h + 0.004;                 // a hair above the far mesh; polygonOffset wins ties
      pos[k] = vx * (RM + h); pos[k + 1] = vy * (RM + h); pos[k + 2] = vz * (RM + h);
      const tone = Math.min(1.6, d.tone);
      col[k] = Number.isFinite(_c1.r) ? s2l(Math.min(1, _c1.r * tone)) : 0.3;
      col[k + 1] = Number.isFinite(_c1.g) ? s2l(Math.min(1, _c1.g * tone)) : 0.3;
      col[k + 2] = Number.isFinite(_c1.b) ? s2l(Math.min(1, _c1.b * tone)) : 0.3;
    }
  }
  gridNormals(p);
  p.mesh.geometry.attributes.position.needsUpdate = true;
  p.mesh.geometry.attributes.color.needsUpdate = true;
  p.mesh.geometry.attributes.normal.needsUpdate = true;
  p.mesh.geometry.computeBoundingSphere();
}

export function hidePatch(p) { if (p && p.mesh.visible) p.mesh.visible = false; }

/* Per-frame, called from js/world.js with the ground point as a unit vector in the body-local
   frame (the caller undoes the spin) and the altitude in km above the reference sphere. */
export function updatePatch(p, dx, dy, dz, alt) {
  if (!p) return;
  if (!p.ready || alt > SHOW_ALT) { hidePatch(p); return; }
  if (p.has && dx * p.gx + dy * p.gy + dz * p.gz > p.cosT && !p.dirty) {
    p.mesh.visible = true;
    return;
  }
  p.gx = dx; p.gy = dy; p.gz = dz; p.has = true; p.dirty = false;
  p.mesh.visible = true;
  rebuild(p);
}

function rebuild(p) {
  // deterministic tangent frame: east-ish from the world pole, north from their cross
  _g.set(p.gx, p.gy, p.gz).normalize();
  if (Math.abs(_g.y) < 0.9) _e1.set(0, 1, 0).cross(_g).normalize();
  else _e1.set(1, 0, 0).cross(_g).normalize();
  _e2.copy(_g).cross(_e1).normalize();
  // centre uv of the cap, so aUv can be written UNWRAPPED: a triangle straddling the dateline
  // would otherwise interpolate 0.999→0.000 and smear the projected cloud shade across it
  let cu = Math.atan2(_g.z, -_g.x) / (2 * Math.PI);
  if (cu < 0) cu += 1;

  const pos = p.mesh.geometry.attributes.position.array;
  const col = p.mesh.geometry.attributes.color.array;
  const auv = p.mesh.geometry.attributes.aUv.array;
  let k = 0;
  for (let iy = 0; iy < COLS; iy++) {
    const ty = 1 - iy / SEG * 2;                     // +1 at the northern rim
    const oy = HALF * warp(ty);
    for (let ix = 0; ix < COLS; ix++, k += 3) {
      const tx = ix / SEG * 2 - 1;
      const ox = HALF * warp(tx);
      // dir = normalise(ĝ + tangent/R): the patch is a spherical cap, not a plate
      let vx = _g.x + (_e1.x * ox + _e2.x * oy) / RE;
      let vy = _g.y + (_e1.y * ox + _e2.y * oy) / RE;
      let vz = _g.z + (_e1.z * ox + _e2.z * oy) / RE;
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl; vy *= vl; vz *= vl;
      const v = 0.5 + Math.asin(vy < -1 ? -1 : vy > 1 ? 1 : vy) / Math.PI;
      let u = Math.atan2(vz, -vx) / (2 * Math.PI);
      if (u < 0) u += 1;

      const r = Math.abs(ox) > Math.abs(oy) ? Math.abs(ox) : Math.abs(oy);
      const fineFade = 1 - sstep(FINE_FROM, FINE_TO, r);

      const sd = shoreDistance(p.coast, u, v);
      const f = 1 - sstep(-SHORE_E, SHORE_E, sd);
      const g = p.rel ? sampleGrid(p.rel, u, v) : 0;   // already pad-flattened by the field builder
      const fine = fineEarth(u, v);
      // only positive fine relief is applied: the patch stands on the globe, it never cuts
      // into it, so the mesh under it can never poke through as a torn edge. The pad weight
      // gates the ADDITIVE terms only — g already carries it, and multiplying twice would
      // sink the patch below the mesh through the feather band around the pad.
      const h = g + (fine > 0 ? fine : 0) * f * fineFade * padWeight(u, v) + LIFT * padWeight(u, v);
      pos[k] = vx * (RE + h); pos[k + 1] = vy * (RE + h); pos[k + 2] = vz * (RE + h);
      let du = u - cu; if (du > 0.5) du -= 1; else if (du < -0.5) du += 1;
      auv[k / 3 * 2] = cu + du; auv[k / 3 * 2 + 1] = v;
      colour(p, u, v, sd, f, k, col);
    }
  }
  gridNormals(p);
  p.mesh.geometry.attributes.position.needsUpdate = true;
  p.mesh.geometry.attributes.color.needsUpdate = true;
  p.mesh.geometry.attributes.normal.needsUpdate = true;
  p.mesh.geometry.attributes.aUv.needsUpdate = true;
  p.mesh.geometry.computeBoundingSphere();
}

/* Central-difference normals on the regular grid — computeVertexNormals() would area-average the
   index buffer instead, and this loop reads the position array straight: no allocation, and the
   result is exactly the surface the vertices describe. On a tame cap every normal sits within a
   few degrees of the local radial direction; if this ever disagrees, the field is not tame. */
function gridNormals(p) {
  const pos = p.mesh.geometry.attributes.position.array;
  const nrm = p.mesh.geometry.attributes.normal.array;
  for (let iy = 0; iy < COLS; iy++) {
    const yu = iy > 0 ? iy - 1 : 0, yd = iy < SEG ? iy + 1 : SEG;
    for (let ix = 0; ix < COLS; ix++) {
      const xl = ix > 0 ? ix - 1 : 0, xr = ix < SEG ? ix + 1 : SEG;
      const i0 = (iy * COLS + ix) * 3;
      _pa.fromArray(pos, (yu * COLS + ix) * 3);       // up-row
      _pb.fromArray(pos, (yd * COLS + ix) * 3);       // down-row
      _pc.fromArray(pos, (iy * COLS + xr) * 3);       // right
      _pd.fromArray(pos, (iy * COLS + xl) * 3);       // left
      const tx = _pc.x - _pd.x, ty = _pc.y - _pd.y, tz = _pc.z - _pd.z;
      const bx = _pb.x - _pa.x, by = _pb.y - _pa.y, bz = _pb.z - _pa.z;
      let nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= l; ny *= l; nz *= l;
      // orient outward (the cross of south×east flips with the frame; the position IS a direction)
      if (nx * pos[i0] + ny * pos[i0 + 1] + nz * pos[i0 + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      nrm[i0] = nx; nrm[i0 + 1] = ny; nrm[i0 + 2] = nz;
    }
  }
}

/* ---- colour ---- */

/* Flat cartoon ground: the painted biome colour the orbit wears, sampled a few km inland so the
   navy coastline stroke and pale shelf band can never stain dry land, blended to the water tone
   through the distance field in a 60 m ramp — the hard edge the art direction asks for, and the
   same sd that carves the far map. No decoration: the user looked at the mottled version and
   said "horrific"; docs/reference/cartoon-art-direction.md retired per-vertex detail entirely. */
function colour(p, u, v, sd, f, k, col) {
  pxColor(p.px, u, v, _c1);                          // the painted map right here (ocean tone at sea)
  if (f > 0) {
    // inland walk in KILOMETRES with the spherical metric, hard-bounded: the gradient comes from
    // probes 3 km out, is normalised, and moves at most 24 km — never past the waterline. An
    // unnormalised uv push is what once flung this sample thousands of uv units away, read off
    // the end of the pixel buffer, and stored NaN (NaN vertex colour = black band on the horizon
    // that no material or visibility toggle can remove).
    const cl = Math.max(0.2, Math.sqrt(1 - (2 * v - 1) * (2 * v - 1)));   // cos(lat) straight from v
    const eU = 3 / (E_CIRC * cl), eV = 3 / (Math.PI * RE);
    const gx = shoreDistance(p.coast, wrapU(u + eU), v) - shoreDistance(p.coast, wrapU(u - eU), v);
    const gy = shoreDistance(p.coast, u, Math.min(1, v + eV)) - shoreDistance(p.coast, u, Math.max(0, v - eV));
    const dU = gx / (2 * eU), dV = gy / (2 * eV);    // d(sd)/d(km), east and north
    const m = Math.sqrt(dU * dU + dV * dV);
    let uu = u, vv = v;
    const push = Math.min(Math.abs(sd) - 0.5, 24);   // km inland; ≤0 right at the waterline
    if (m > 1e-6 && push > 0) {
      uu = wrapU(u - dU / m * push / (E_CIRC * cl));
      vv = THREE.MathUtils.clamp(v - dV / m * push / (Math.PI * RE), 0, 1);
    }
    pxColor(p.soft, uu, vv, _c2);                      // the BIOME colour, from the blurred copy
    const wt = padShoreWeight(u, v);
    if (wt > 0.02) {
      const a = padAuthored(u, v, 1);               // authored Merritt Island tones at the pad, incl. apron & crawlerway
      if (a) { _c2.r += (a[0] / 255 - _c2.r) * wt; _c2.g += (a[1] / 255 - _c2.g) * wt; _c2.b += (a[2] / 255 - _c2.b) * wt; }
    }
    // the smoothstep land fraction IS the anti-aliased shoreline: wet tone → biome tone
    _c1.r += (_c2.r - _c1.r) * f; _c1.g += (_c2.g - _c1.g) * f; _c1.b += (_c2.b - _c1.b) * f;
  }
  // last line of defence — see the header: a non-finite vertex colour is a black triangle forever
  col[k] = Number.isFinite(_c1.r) ? s2l(_c1.r) : 0.3;
  col[k + 1] = Number.isFinite(_c1.g) ? s2l(_c1.g) : 0.4;
  col[k + 2] = Number.isFinite(_c1.b) ? s2l(_c1.b) : 0.2;
}

const wrapU = (x) => { const w1 = x - Math.floor(x); return w1 < 0 ? w1 + 1 : w1; };
const E_CIRC = 2 * Math.PI * RE;
const sstep = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/* Vertex colours enter the shader as working-space values — unlike a texture, nothing converts
   them — so the sRGB canvas bytes get linearised here or the ground would glow next to the
   mapped planet. */
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/* Bilinear on the painted canvas, same texel-centre convention as sampleGrid. Every index is
   wrapped or clamped: off-buffer reads return `undefined`, and undefined through the blend
   becomes NaN — see the colour() note. */
function pxColor(px, u, v, o) {
  if (!px) { o.r = 0.2; o.g = 0.2; o.b = 0.25; return; }
  const w = px.width, h = px.height, d = px.data;
  const gx = u * w - 0.5, gy = (1 - v) * h - 0.5;
  const x0 = Math.floor(gx), fx = gx - x0;
  const y0 = Math.floor(gy), fy = gy - y0;
  const xa = ((x0 % w) + w) % w, xb = (((x0 + 1) % w) + w) % w;
  const ya = y0 < 0 ? 0 : y0 > h - 1 ? h - 1 : y0;
  const yb = y0 + 1 < 0 ? 0 : y0 + 1 > h - 1 ? h - 1 : y0 + 1;
  const r0 = ya * w * 4, r1 = yb * w * 4, ia = xa * 4, ib = xb * 4;
  const t0 = d[r0 + ia] + (d[r0 + ib] - d[r0 + ia]) * fx;
  const t1 = d[r1 + ia] + (d[r1 + ib] - d[r1 + ia]) * fx;
  const b0 = d[r0 + ia + 1] + (d[r0 + ib + 1] - d[r0 + ia + 1]) * fx;
  const b1 = d[r1 + ia + 1] + (d[r1 + ib + 1] - d[r1 + ia + 1]) * fx;
  const h0 = d[r0 + ia + 2] + (d[r0 + ib + 2] - d[r0 + ia + 2]) * fx;
  const h1 = d[r1 + ia + 2] + (d[r1 + ib + 2] - d[r1 + ia + 2]) * fx;
  o.r = (t0 + (t1 - t0) * fy) / 255;
  o.g = (b0 + (b1 - b0) * fy) / 255;
  o.b = (h0 + (h1 - h0) * fy) / 255;
}
