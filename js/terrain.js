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
     grid + the crater ladder (moonGroundHeight). There is no display lift under the vehicle: the
     globe's fragments inside HOLE km of the patch centre are discarded (surface.js setHole), so the
     patch has nothing to win a depth fight against. Only the outer ring, past the hole, is lifted
     clear of the globe's chords.
   - "Under the vehicle" has to stay true while the vehicle moves. The mesh is 8 m fine only within
     ~300 m of its centre, and a 100 m crater sampled by 400 m triangles is not that crater. So the
     Moon's patch re-centres by HEIGHT: when the ground point is further from the centre than a
     third of the height above the ground (never less than 60 m, never more than 12 km). A lander
     comes down onto 8 m triangles wherever it comes down.
   - A rebuild never blocks a frame. It is done a few rows at a time, into back buffers, inside a
     time budget, and swapped in whole: positions, normals, uv, the mesh's place, the shader's
     anchor and the globe's hole in one frame. (It used to be 15–25 ms in one piece; the Moon's,
     with craters in it, would be several hundred.) Only the very first Earth build, at boot, runs
     through in one go.
   - Every value written to an attribute is finite; nonFinite() counts them and the harness asserts
     zero (AGENTS.md: one NaN in a vertex attribute is a black band no material can remove). */

const HALF = 220;                     // km to the rim
const SEG = 320;                      // Earth: 321×321 vertices, ~12 m centre, ~1.4 km rim
const SEG_M = 512;                    // Moon: 513×513 vertices, ~8 m centre
const HOLE = 205;                     // km of ground distance the globe leaves to the patch
const FINE_FROM = 14, FINE_TO = 30;   // km: Earth's fine relief is whole inside this radius (RECENTER < FINE_FROM)
const RECENTER = 12;                  // km of ground travel before a rebuild (the Moon's shrinks with height: see below)
const NEAR_K = 0.35, NEAR_MIN = 0.06; // the Moon: re-centre past this fraction of the height above ground, km floor
const BUDGET = 3.5;                   // ms of rebuild a frame
const SHOW_ALT = 30;                  // km: above this the far mesh is the whole story
const WARP_A = 0.0093;                // centre slope of the warp

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
  /* the warp, tabulated: where each column sits and how far apart its neighbours are */
  const off = new Float64Array(cols), gap = new Float64Array(cols);
  for (let i = 0; i < cols; i++) {
    const t = i / seg * 2 - 1;
    off[i] = HALF * warp(t);
    gap[i] = HALF * (WARP_A + 5 * (1 - WARP_A) * t * t * t * t) * 2 / seg;
  }
  return {
    mesh, key, R: key === 'moon' ? RM : RE, ready: false, dirty: false, seg, cols, off, gap,
    cosT: Math.cos(RECENTER / (key === 'moon' ? RM : RE)),
    gx: 0, gy: 1, gz: 0, has: false, rel: null, coast: null, job: null,
    back: { pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), uv: new Float32Array(n * 2) },
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

const _uv = { u: 0, v: 0 };
function uvOf(x, y, z) {
  let u = Math.atan2(z, -x) / (2 * Math.PI);
  if (u < 0) u += 1;
  _uv.u = u; _uv.v = 0.5 + Math.asin(y < -1 ? -1 : y > 1 ? 1 : y) / Math.PI;
  return _uv;
}

/* Per-frame, called from js/world.js with the ground point as a unit vector in the body-local
   frame (the caller undoes the spin) and the altitude in km above the reference sphere. */
export function updatePatch(p, dx, dy, dz, alt) {
  if (!p) return;
  if (!p.ready || alt > SHOW_ALT) { hidePatch(p); p.job = null; return; }
  let cosT = p.cosT;
  if (p.key === 'moon') {
    const q = uvOf(dx, dy, dz), ground = sampleGrid(p.rel, q.u, q.v) + p.rel.crater(dx, dy, dz, q.u, q.v, 0);
    cosT = Math.cos(THREE.MathUtils.clamp(NEAR_K * (alt - ground), NEAR_MIN, RECENTER) / p.R);
  }
  if (!p.job && (!p.has || p.dirty || dx * p.gx + dy * p.gy + dz * p.gz <= cosT)) {
    p.dirty = false;
    p.job = begin(p, dx, dy, dz);
  }
  if (p.job) {
    /* the Earth's first build is at boot, where 20 ms is not a hitch: everything else is sliced */
    const t0 = performance.now(), until = !p.has && p.key === 'earth' ? Infinity : t0 + BUDGET;
    const done = step(p, p.job, until), dt = performance.now() - t0;
    p.job.ms += dt; p.job.frames++; p.job.worst = Math.max(p.job.worst, dt);
    if (done) { p.built = { ms: +p.job.ms.toFixed(1), frames: p.job.frames, worstSlice: +p.job.worst.toFixed(2) }; commit(p, p.job); p.job = null; }
  }
  if (!p.has) { hidePatch(p); return; }
  p.mesh.visible = true;
  setHole(p.key, p.gx, p.gy, p.gz, HOLE);
}
export const updateMoonPatch = updatePatch;

/* A rebuild in progress: the frame it is being built in, and how far it has got. */
function begin(p, gx, gy, gz) {
  const R = p.R, g = new THREE.Vector3(gx, gy, gz).normalize(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  // deterministic tangent frame: east-ish from the pole, north from their cross
  if (Math.abs(g.y) < 0.9) e1.set(0, 1, 0).cross(g).normalize();
  else e1.set(1, 0, 0).cross(g).normalize();
  e2.copy(g).cross(e1).normalize();
  // the cap's centre uv, so uv is written UNWRAPPED: no triangle may span the dateline
  let cu = Math.atan2(g.z, -g.x) / (2 * Math.PI);
  if (cu < 0) cu += 1;
  return { g, e1, e2, cu, cx: g.x * R, cy: g.y * R, cz: g.z * R, row: 0, nrow: 0, ms: 0, frames: 0, worst: 0 };
}

/* Advance a rebuild until `until` (performance.now() ms). True when it is finished. Rows of
   positions first, then rows of normals — a row is ~0.1 ms on the Earth, ~1 ms on the Moon near
   the centre, where five crater octaves are resolved. */
function step(p, J, until) {
  const R = p.R, S = p.seg, C1 = p.cols, earth = p.key === 'earth', crater = p.rel.crater;
  const pos = p.back.pos, uvA = p.back.uv, g = J.g, e1 = J.e1, e2 = J.e2, cx = J.cx, cy = J.cy, cz = J.cz;
  /* Vertices are written from the patch's own centre, and the mesh stands at that centre. Written
     from the planet's centre they were 6,371 km numbers in float32 — a 0.49 m grid — multiplied by
     a model-view matrix with a 6,371 km translation: the cancellation error moved the whole ground
     up and down by half a metre from frame to frame as the planet turned, and the grass came through
     the launch site's slabs (0.63 m proud) a panel at a time. From the centre the same vertex is a
     number of metres and exact. */
  for (; J.row < C1; J.row++) {
    if (performance.now() >= until) return false;
    const iy = J.row, oy = -p.off[iy];                 // +HALF at the northern rim
    let k = iy * C1 * 3, m = iy * C1 * 2;
    for (let ix = 0; ix < C1; ix++, k += 3, m += 2) {
      const ox = p.off[ix];
      // dir = normalise(ĝ + tangent/R): a spherical cap, not a plate
      let vx = g.x + (e1.x * ox + e2.x * oy) / R;
      let vy = g.y + (e1.y * ox + e2.y * oy) / R;
      let vz = g.z + (e1.z * ox + e2.z * oy) / R;
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl; vy *= vl; vz *= vl;
      const v = 0.5 + Math.asin(vy < -1 ? -1 : vy > 1 ? 1 : vy) / Math.PI;
      let u = Math.atan2(vz, -vx) / (2 * Math.PI);
      if (u < 0) u += 1;
      let du = u - J.cu; if (du > 0.5) du -= 1; else if (du < -0.5) du += 1;
      uvA[m] = J.cu + du; uvA[m + 1] = v;

      const r = Math.hypot(ox, oy);
      let h = sampleGrid(p.rel, u, v);
      if (earth) h += fineRelief(p.coast, u, v) * (1 - sstep(FINE_FROM, FINE_TO, r)) + ringLift(r, 0.02);
      else {
        /* the craters this vertex's neighbourhood can hold; toward the rim, only the ones the
           globe's own mesh holds, so the two meet. The lunar globe chords its relief by up to
           ~240 m: the ring is lifted clear of it. */
        const far = p.rel.farSpacing * sstep(185, 204, r);
        h += crater(vx, vy, vz, u, v, Math.max(p.gap[ix], p.gap[iy], far)) + ringLift(r, 0.3);
      }
      if (!Number.isFinite(h)) h = 0;
      pos[k] = vx * (R + h) - cx; pos[k + 1] = vy * (R + h) - cy; pos[k + 2] = vz * (R + h) - cz;
    }
  }
  for (; J.nrow < C1; J.nrow += 16) {
    if (performance.now() >= until) return false;
    gridNormals(p, J, J.nrow, Math.min(C1, J.nrow + 16));
  }
  return true;
}

/* Swap a finished rebuild in: geometry, the mesh's place, the shader's anchor, in one frame. */
function commit(p, J) {
  const at = p.mesh.geometry.attributes;
  at.position.array.set(p.back.pos); at.normal.array.set(p.back.nrm); at.sfUv.array.set(p.back.uv);
  at.position.needsUpdate = true; at.normal.needsUpdate = true; at.sfUv.needsUpdate = true;
  p.gx = J.g.x; p.gy = J.g.y; p.gz = J.g.z; p.has = true;
  p.cx = J.cx; p.cy = J.cy; p.cz = J.cz;
  p.mesh.position.set(J.cx, J.cy, J.cz);
  anchorPatch(p.key, J.cx, J.cy, J.cz);
  p.mesh.geometry.computeBoundingSphere();
}

/* Central-difference normals on the regular grid — computeVertexNormals() would area-average the
   index buffer instead, and this loop reads the position array straight: no allocation, and the
   result is exactly the surface the vertices describe. */
function gridNormals(p, J, y0, y1) {
  const S = p.seg, C1 = p.cols;
  const pos = p.back.pos, nrm = p.back.nrm;
  for (let iy = y0; iy < y1; iy++) {
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
      const ox = pos[i0] + J.cx, oy = pos[i0 + 1] + J.cy, oz = pos[i0 + 2] + J.cz;
      if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      if (!(nx === nx)) { const pl = 1 / Math.hypot(ox, oy, oz); nx = ox * pl; ny = oy * pl; nz = oz * pl; }
      nrm[i0] = nx; nrm[i0 + 1] = ny; nrm[i0 + 2] = nz;
    }
  }
}

/* For the harness: non-finite floats per attribute, and the worst angle (degrees) between a normal
   and the local vertical — a plain's normals must cluster at the vertical (AGENTS.md). */
export function patchAudit(p) {
  const at = p.mesh.geometry.attributes, out = { nonFinite: {}, maxTiltDeg: 0, built: p.built || null };
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
