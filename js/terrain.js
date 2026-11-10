import * as THREE from 'three';
import { toon, RAMP_EARTH, RAMP_MOON } from './toon.js';
import { RE, RM } from './constants.js';
import { sampleGrid, reliefField, coastField } from './toonmap.js';
import { fineRelief } from './padsite.js';
import { surfaceInject, anchorPatch, setHole } from './surface.js';

/* The near level: one streamed mesh per body.

   KSP-style ground: ONE mesh that re-centres on the vehicle and warps radially — metres of spacing
   under the craft, a rim at ±220 km. The horizon from altitude h is √(2·R·h), so the rim sits
   beyond it until the swap to the far globe is sub-pixel. Between rebuilds it costs one altitude
   test and one dot product; a rebuild runs in place, into preallocated buffers.

   The mesh carries SHAPE only — position, normal and the body's equirectangular uv. Colour is not
   baked here any more: js/surface.js draws the ground per fragment, with the same function on this
   mesh and on the globe, so what used to be a per-vertex colour bake (and the wedges, staircases
   and NaN bands that came with sampling a painted canvas at a warped lattice) no longer exists.

   Two contracts:

   - The height written here is what physics lands on. Under the vehicle the Earth patch is exactly
     reliefGrid + fineRelief (js/world.js fineGroundHeight) and the lunar patch is exactly the relief
     grid (moonGroundHeight). There is no display lift under the vehicle: the globe's fragments
     inside HOLE km of the patch centre are discarded (surface.js setHole), so the patch has nothing
     to win a depth fight against. Only the outer ring, past the hole, is lifted clear of the globe's
     chords.
   - Every value written to an attribute is finite; nonFinite() counts them and the harness asserts
     zero (agents.md: one NaN in a vertex attribute is a black band no material can remove). */

const HALF = 220;                     // km to the rim
const SEG = 320;                      // Earth: 321×321 vertices, ~12 m centre, ~1.4 km rim
const SEG_M = 512;                    // Moon: 513×513 vertices, ~8 m centre
const HOLE = 205;                     // km of ground distance the globe leaves to the patch
const FINE_FROM = 14, FINE_TO = 30;   // km: Earth's fine relief is whole inside this radius (RECENTER < FINE_FROM)
const RECENTER = 12;                  // km of ground travel before a rebuild
const SHOW_ALT = 30;                  // km: above this the far mesh is the whole story
const WARP_A = 0.0093;                // centre slope of the warp

const _g = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _pd = new THREE.Vector3();

/* Signed fifth-power warp: linear (fine) through the middle, then racing to the rim. */
const warp = (t) => WARP_A * t + (1 - WARP_A) * t * t * t * t * t;
const sstep = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/* Display lift, km: zero under the hole, a bump across the ring where the globe still draws. */
const ringLift = (r, amp) => amp * sstep(150, 195, r) * (1 - sstep(206, 220, r));

function build(body, key, seg, ramp, extra) {
  const cols = seg + 1, n = cols * cols;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
  geo.setAttribute('sfUv', uv);
  geo.setAttribute('aUv', uv);          // the cloud-shade injection's name for the same buffer
  const idx = new Uint32Array(seg * seg * 6);
  let t = 0;
  for (let y = 0; y < seg; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, toon({
    gradientMap: ramp,
    // past the hole the patch coincides with the globe; polygonOffset wins those ties
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    ...extra,
  }));
  mesh.material.fog = false;          // aerial perspective is js/haze.js's, on the Earth; the Moon has no air
  mesh.material.onBeforeCompile = (sh) => surfaceInject(sh, key, 'patch');
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.visible = false;
  body.add(mesh);
  return {
    mesh, key, R: key === 'moon' ? RM : RE, ready: false, dirty: false, seg, cols,
    cosT: Math.cos(RECENTER / (key === 'moon' ? RM : RE)),
    gx: 0, gy: 1, gz: 0, has: false, rel: null, coast: null,
  };
}

/* The Earth's patch wears the globe's navy emissive floor (js/world.js): without it the patch sat
   17/255 low in blue across its whole footprint and read as a plate lying on the ocean. */
export function makePatch(body) { return build(body, 'earth', SEG, RAMP_EARTH, { emissive: 0x07182c }); }
export function makeMoonPatch(body) { return build(body, 'moon', SEG_M, RAMP_MOON, {}); }

/* The grids are byproducts of the paint pass; when they land, the next update rebuilds. */
export function attachEarthPatch(p) {
  Promise.all([reliefField('earth'), coastField()]).then((a) => {
    if (!a[0] || !a[1]) return;
    p.rel = a[0]; p.coast = a[1]; p.ready = true; p.dirty = true;
  });
}
export function attachMoonPatch(p) {
  reliefField('moon').then((f) => { if (f) { p.rel = f; p.ready = true; p.dirty = true; } });
}

export function hidePatch(p) {
  if (!p || !p.mesh.visible) return;
  p.mesh.visible = false;
  setHole(p.key, 0, 1, 0, 0);
}

/* Per-frame, called from js/world.js with the ground point as a unit vector in the body-local
   frame (the caller undoes the spin) and the altitude in km above the reference sphere. */
export function updatePatch(p, dx, dy, dz, alt) {
  if (!p) return;
  if (!p.ready || alt > SHOW_ALT) { hidePatch(p); return; }
  if (p.has && p.mesh.visible && dx * p.gx + dy * p.gy + dz * p.gz > p.cosT && !p.dirty) return;
  if (!p.has || p.dirty || dx * p.gx + dy * p.gy + dz * p.gz <= p.cosT) {
    p.gx = dx; p.gy = dy; p.gz = dz; p.has = true; p.dirty = false;
    rebuild(p);
  }
  p.mesh.visible = true;
  setHole(p.key, p.gx, p.gy, p.gz, HOLE);
}
export const updateMoonPatch = updatePatch;

function rebuild(p) {
  const R = p.R, S = p.seg, C1 = p.cols, earth = p.key === 'earth';
  // deterministic tangent frame: east-ish from the pole, north from their cross
  _g.set(p.gx, p.gy, p.gz).normalize();
  if (Math.abs(_g.y) < 0.9) _e1.set(0, 1, 0).cross(_g).normalize();
  else _e1.set(1, 0, 0).cross(_g).normalize();
  _e2.copy(_g).cross(_e1).normalize();
  // the cap's centre uv, so uv is written UNWRAPPED: no triangle may span the dateline
  let cu = Math.atan2(_g.z, -_g.x) / (2 * Math.PI);
  if (cu < 0) cu += 1;
  anchorPatch(p.key, _g.x * R, _g.y * R, _g.z * R);
  /* Vertices are written from the patch's own centre, and the mesh stands at that centre. Written
     from the planet's centre they were 6,371 km numbers in float32 — a 0.49 m grid — multiplied by
     a model-view matrix with a 6,371 km translation: the cancellation error moved the whole ground
     up and down by half a metre from frame to frame as the planet turned, and the grass came through
     the launch site's slabs (0.63 m proud) a panel at a time. From the centre the same vertex is a
     number of metres and exact. */
  const cx = _g.x * R, cy = _g.y * R, cz = _g.z * R;
  p.cx = cx; p.cy = cy; p.cz = cz;
  p.mesh.position.set(cx, cy, cz);

  const pos = p.mesh.geometry.attributes.position.array;
  const uvA = p.mesh.geometry.attributes.sfUv.array;
  let k = 0, m = 0;
  for (let iy = 0; iy < C1; iy++) {
    const oy = HALF * warp(1 - iy / S * 2);            // +HALF at the northern rim
    for (let ix = 0; ix < C1; ix++, k += 3, m += 2) {
      const ox = HALF * warp(ix / S * 2 - 1);
      // dir = normalise(ĝ + tangent/R): a spherical cap, not a plate
      let vx = _g.x + (_e1.x * ox + _e2.x * oy) / R;
      let vy = _g.y + (_e1.y * ox + _e2.y * oy) / R;
      let vz = _g.z + (_e1.z * ox + _e2.z * oy) / R;
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl; vy *= vl; vz *= vl;
      const v = 0.5 + Math.asin(vy < -1 ? -1 : vy > 1 ? 1 : vy) / Math.PI;
      let u = Math.atan2(vz, -vx) / (2 * Math.PI);
      if (u < 0) u += 1;
      let du = u - cu; if (du > 0.5) du -= 1; else if (du < -0.5) du += 1;
      uvA[m] = cu + du; uvA[m + 1] = v;

      const r = Math.hypot(ox, oy);
      let h = sampleGrid(p.rel, u, v);
      if (earth) h += fineRelief(p.coast, u, v) * (1 - sstep(FINE_FROM, FINE_TO, r)) + ringLift(r, 0.02);
      else h += ringLift(r, 0.3);                      // the lunar globe chords its relief by up to ~240 m
      if (!Number.isFinite(h)) h = 0;
      pos[k] = vx * (R + h) - cx; pos[k + 1] = vy * (R + h) - cy; pos[k + 2] = vz * (R + h) - cz;
    }
  }
  gridNormals(p);
  const at = p.mesh.geometry.attributes;
  at.position.needsUpdate = true; at.normal.needsUpdate = true; at.sfUv.needsUpdate = true;
  p.mesh.geometry.computeBoundingSphere();
}

/* Central-difference normals on the regular grid — computeVertexNormals() would area-average the
   index buffer instead, and this loop reads the position array straight: no allocation, and the
   result is exactly the surface the vertices describe. */
function gridNormals(p) {
  const S = p.seg, C1 = p.cols;
  const pos = p.mesh.geometry.attributes.position.array;
  const nrm = p.mesh.geometry.attributes.normal.array;
  for (let iy = 0; iy < C1; iy++) {
    const yu = iy > 0 ? iy - 1 : 0, yd = iy < S ? iy + 1 : S;
    for (let ix = 0; ix < C1; ix++) {
      const xl = ix > 0 ? ix - 1 : 0, xr = ix < S ? ix + 1 : S;
      const i0 = (iy * C1 + ix) * 3;
      _pa.fromArray(pos, (yu * C1 + ix) * 3);
      _pb.fromArray(pos, (yd * C1 + ix) * 3);
      _pc.fromArray(pos, (iy * C1 + xr) * 3);
      _pd.fromArray(pos, (iy * C1 + xl) * 3);
      const tx = _pc.x - _pd.x, ty = _pc.y - _pd.y, tz = _pc.z - _pd.z;
      const bx = _pb.x - _pa.x, by = _pb.y - _pa.y, bz = _pb.z - _pa.z;
      let nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= l; ny *= l; nz *= l;
      // orient outward: the vertex from the planet's centre is the direction
      const ox = pos[i0] + p.cx, oy = pos[i0 + 1] + p.cy, oz = pos[i0 + 2] + p.cz;
      if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      if (!(nx === nx)) { const pl = 1 / Math.hypot(ox, oy, oz); nx = ox * pl; ny = oy * pl; nz = oz * pl; }
      nrm[i0] = nx; nrm[i0 + 1] = ny; nrm[i0 + 2] = nz;
    }
  }
}

/* For the harness: non-finite floats per attribute, and the worst angle (degrees) between a normal
   and the local vertical — a plain's normals must cluster at the vertical (agents.md). */
export function patchAudit(p) {
  const at = p.mesh.geometry.attributes, out = { nonFinite: {}, maxTiltDeg: 0 };
  for (const name of ['position', 'normal', 'sfUv']) {
    let n = 0; const a = at[name].array;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) n++;
    out.nonFinite[name] = n;
  }
  const P = at.position.array, N = at.normal.array;
  let worst = 1;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i] + (p.cx || 0), y = P[i + 1] + (p.cy || 0), z = P[i + 2] + (p.cz || 0), l = Math.hypot(x, y, z);
    const d = (x * N[i] + y * N[i + 1] + z * N[i + 2]) / l;
    if (d < worst) worst = d;
  }
  out.maxTiltDeg = +(Math.acos(Math.min(1, worst)) * 180 / Math.PI).toFixed(2);
  return out;
}
